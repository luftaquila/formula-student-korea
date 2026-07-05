"""Stereo depth + obstacle detection for the FSK rover perception node (Phase 3).

Given a LEFT and RIGHT eye frame, we rectify each with a one-time checkerboard
calibration (see stereo_calibrate.py), run block matching to a disparity map,
convert to metric depth, and flag an obstacle when enough rectified pixels in
the *driving corridor* (a rectangle ahead of the rover) are closer than a
threshold band.

This module is layout-agnostic: it takes the two eyes already separated. The
node supplies them per the camera's layout — most USB "stereo" webcams (incl.
the rover's "Stereo Vision" unit) expose the two eyes as SEPARATE /dev/video
nodes (dual-node); a few emit one side-by-side (SBS) frame, for which
split_sbs() below cuts it in half. The depth math is identical either way.

Cost discipline (this runs on the Pi 5 alongside the ROS pilot nodes):
  - cv2.setNumThreads() is capped so block matching can't grab every core and
    starve the navigator's control tick.
  - The detector works at the calibration's resolution; calibrate at a modest
    size (e.g. 640x480 per eye, or smaller) to trade depth detail for speed.
  - The node gates detection to mission-driving and runs it at a low rate, so
    this code is idle most of the time.

Separation for testability: the expensive rectify + block matching lives in
StereoDepth (needs cv2); the *decision* — given a depth map + validity mask +
ROI + threshold band, is there an obstacle? — is the pure-numpy
obstacle_in_roi(), unit-testable without a camera or OpenCV.

Safety default: without a usable calibration file, metric depth is meaningless,
so the detector stays DISABLED (reports no obstacle) rather than guessing. A
missing/corrupt calibration must never auto-pause a mission on disparity noise.
"""

import os
from dataclasses import dataclass

import numpy as np

try:
    import cv2
except ImportError:  # pure obstacle_in_roi() stays importable without OpenCV
    cv2 = None


def split_sbs(frame):
    """Split a side-by-side stereo frame into (left, right) halves (SBS layout)."""
    w = frame.shape[1]
    half = w // 2
    return frame[:, :half], frame[:, half:half * 2]


def read_stereo_pair(left_cap, right_cap):
    """Read one near-simultaneous frame from each of two free-running USB eyes.

    grab() only latches each device's current frame (no decode), so issuing both
    grabs back-to-back BEFORE either retrieve() pins the two capture instants
    within a grab-to-grab gap (sub-millisecond) — instead of the tens of ms a
    read()+read() leaves, where the left frame is fully decoded before the right
    is even grabbed. That gap is what a moving scene turns into stereo disparity
    error: the pair stays self-consistent per eye but violates the single rigid
    geometry, so per-eye RMS stays low while the stereo RMS blows up. Returns
    (left, right) BGR frames, or None on any grab/retrieve miss. Works on any
    object exposing grab()/retrieve() (no cv2 module call), so it is unit-testable
    with a fake capture."""
    if not left_cap.grab() or not right_cap.grab():
        return None
    okl, left = left_cap.retrieve()
    okr, right = right_cap.retrieve()
    if not okl or not okr or left is None or right is None:
        return None
    return left, right


# ── pure decision (no cv2) ──────────────────────────────────────────────────
def obstacle_in_roi(depth_z, valid, roi_frac, near_m, far_m, min_fill,
                    min_valid_px):
    """Decide whether the driving corridor holds a close obstacle. Pure numpy.

    depth_z:   HxW float array of Z in metres (garbage where ~valid).
    valid:     HxW bool array — True where disparity matched reliably.
    roi_frac:  (x0, y0, x1, y1) fractions in [0, 1] of the corridor rectangle.
    near_m:    near clip — closer matches are rejected as lens-edge noise / the
               rover's own nose, never the depth of a real obstacle ahead.
    far_m:     far clip — matches beyond this are background, not on the path.
    min_fill:  obstacle if the fraction of VALID corridor pixels whose depth is
               in [near_m, far_m] reaches this.
    min_valid_px: floor on valid corridor pixels; below it the corridor is too
               textureless/dark to trust, so report no obstacle (fill = 0)
               rather than tripping on a handful of speckles.

    Returns (obstacle: bool, fill: float, near_count: int, valid_count: int).
    """
    h, w = depth_z.shape[:2]
    x0f, y0f, x1f, y1f = roi_frac
    # Clamp + order the fractions so a mis-set ROI degrades to an empty slice
    # instead of indexing backwards.
    x0, x1 = sorted((x0f, x1f))
    y0, y1 = sorted((y0f, y1f))
    xa = int(round(np.clip(x0, 0.0, 1.0) * w))
    xb = int(round(np.clip(x1, 0.0, 1.0) * w))
    ya = int(round(np.clip(y0, 0.0, 1.0) * h))
    yb = int(round(np.clip(y1, 0.0, 1.0) * h))

    valid_roi = valid[ya:yb, xa:xb]
    z_roi = depth_z[ya:yb, xa:xb]
    valid_count = int(np.count_nonzero(valid_roi))
    # max(1, ...) guarantees valid_count >= 1 before the division below — guards
    # the fill = near_count / valid_count divide when min_valid_px is set to 0.
    if valid_count < max(1, min_valid_px):
        return False, 0.0, 0, valid_count

    near = valid_roi & (z_roi >= near_m) & (z_roi <= far_m)
    near_count = int(np.count_nonzero(near))
    fill = near_count / valid_count
    return (fill >= min_fill), fill, near_count, valid_count


def nearest_point(depth_z, valid, near_m, far_m=None, tol_m=0.15):
    """Nearest valid region over the WHOLE frame — the live-view marker. Pure numpy.

    Returns (z_m, x, y): z is the closest in-band depth, and (x, y) is the CENTROID
    of the pixels within tol_m of that closest depth — NOT the raw argmin. Depth is
    quantised (integer disparity steps), so a whole equidepth near region ties at
    the minimum, and argmin would return its top-left-most pixel — which pins the
    marker to the TOP of the near blob rather than a representative nearest point.
    The centroid puts it in the middle of the nearest region. (nan, -1, -1) if none
    qualify. The near clip rejects lens-edge / speckle depth. This is deliberately
    NOT the corridor decision (obstacle_in_roi) — the auto-pause owns that.
    """
    m = valid & np.isfinite(depth_z) & (depth_z >= near_m)
    if far_m is not None:
        m = m & (depth_z <= far_m)
    if not np.any(m):
        return float("nan"), -1, -1
    zmin = float(depth_z[m].min())
    band = m & (depth_z <= zmin + tol_m)          # the nearest equidepth region
    ys, xs = np.nonzero(band)
    return zmin, int(round(float(xs.mean()))), int(round(float(ys.mean())))


# ── debounce (no cv2) ───────────────────────────────────────────────────────
class EdgeDebouncer:
    """Hysteresis on a noisy per-frame boolean.

    Assert only after `on_frames` consecutive present readings; release only
    after `off_frames` consecutive clear readings. update() returns the rising
    edge so the caller fires the (one-shot) pause exactly once per obstacle.
    """

    def __init__(self, on_frames=3, off_frames=5):
        self.on_frames = max(1, int(on_frames))
        self.off_frames = max(1, int(off_frames))
        self._state = False
        self._present_run = 0
        self._clear_run = 0

    def reset(self):
        """Fully reset to the unasserted state — runs AND asserted state.

        Called when detection pauses (mission left NAVIGATING — e.g. we just
        auto-paused). The asserted state MUST be cleared too: otherwise, on the
        next driving stretch, a still-asserted debouncer would report present
        even when the corridor is clear, re-publishing an obstacle and spuriously
        re-pausing the just-resumed mission.
        """
        self._state = False
        self._present_run = 0
        self._clear_run = 0

    def update(self, present):
        """Feed one reading. Returns (state, rising_edge)."""
        if present:
            self._present_run += 1
            self._clear_run = 0
            if not self._state and self._present_run >= self.on_frames:
                self._state = True
                return True, True
        else:
            self._clear_run += 1
            self._present_run = 0
            if self._state and self._clear_run >= self.off_frames:
                self._state = False
        return self._state, False


# ── calibration ─────────────────────────────────────────────────────────────
# Keys stereo_calibrate.py writes into the .npz, kept in one place so the
# producer and consumer can't drift.
CALIB_KEYS = ("map1x", "map1y", "map2x", "map2y", "Q", "image_size")


def load_calibration(path):
    """Load rectification maps + reprojection Q from an .npz, or None.

    Returns None (detector stays disabled) on any problem — missing file,
    unreadable archive, or missing keys — so the caller never has to guess
    whether depth is trustworthy.
    """
    if not path or not os.path.exists(path):
        return None
    try:
        data = np.load(path, allow_pickle=False)
    except (OSError, ValueError):
        return None
    if not all(k in data for k in CALIB_KEYS):
        return None
    return {
        "map1x": data["map1x"], "map1y": data["map1y"],
        "map2x": data["map2x"], "map2y": data["map2y"],
        "Q": data["Q"],
        # Stored (width, height) of one rectified eye.
        "image_size": tuple(int(v) for v in data["image_size"]),
    }


# Calibration compute/IO — shared by stereo_calibrate.py (CLI) and the node's
# UI-triggered calibration, so the math + the .npz layout live in one place.
# These need cv2 (called only on the rover, where it's installed).
def find_chessboard(gray, pattern):
    """Sub-pixel chessboard inner corners in a grayscale image, or None."""
    flags = cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE
    found, corners = cv2.findChessboardCorners(gray, pattern, flags)
    if not found:
        return None
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    return cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)


def board_object_points(cols, rows, square_m):
    """Checkerboard corner coordinates in its own frame, scaled to metres so the
    recovered translation (and therefore depth) comes out in metres."""
    objp = np.zeros((rows * cols, 3), np.float32)
    objp[:, :2] = np.mgrid[0:cols, 0:rows].T.reshape(-1, 2)
    objp *= float(square_m)
    return objp


def select_inlier_pairs(errors, keep_min=8, abs_max_px=1.0, rel_factor=2.0):
    """Indices of calibration pairs to KEEP for a stereo re-solve, dropping the
    temporal-desync outliers.

    A pair is culled only when its per-pair RMS reprojection error is an outlier
    on BOTH counts: above an absolute ceiling (abs_max_px) AND more than
    rel_factor× the set median (clearly worse than the pack). Requiring both
    keeps a uniformly-good set intact (nothing exceeds abs_max_px) and a
    uniformly-mediocre set intact (nothing stands out from the median) — culling
    fires only when a few pairs are genuinely bad. Never returns fewer than
    min(keep_min, n) pairs; if the threshold would drop below that, the keep_min
    lowest-error pairs are kept instead. Pure numpy (no cv2)."""
    errors = np.asarray(errors, dtype=np.float64)
    n = int(errors.size)
    if n == 0:
        return []
    med = float(np.median(errors))
    thresh = max(float(abs_max_px), rel_factor * med)
    keep = [i for i in range(n) if errors[i] <= thresh]
    floor = min(keep_min, n)
    if len(keep) < floor:
        keep = sorted(int(i) for i in np.argsort(errors, kind="stable")[:floor])
    return keep


def _pair_stereo_errors(objpoints, imgL, imgR, K1, D1, K2, D2, R, T):
    """Per-pair RMS reprojection error (px) over BOTH eyes, using each pair's own
    left-eye board pose (solvePnP) composed through the shared stereo (R, T) to
    place the right eye. A pair whose two eyes were captured at different instants
    (the board moved between them) fits each eye alone but NOT one rigid R, T — so
    its right-eye reprojection blows up, which is exactly the signal that marks it
    a desync outlier. Needs cv2."""
    errs = []
    for op, pl, pr in zip(objpoints, imgL, imgR):
        ok, rvec, tvec = cv2.solvePnP(op, pl, K1, D1)
        if not ok:
            errs.append(float("inf"))
            continue
        proj_l, _ = cv2.projectPoints(op, rvec, tvec, K1, D1)
        rot_l, _ = cv2.Rodrigues(rvec)
        rvec_r, _ = cv2.Rodrigues(R @ rot_l)
        tvec_r = R @ tvec + T
        proj_r, _ = cv2.projectPoints(op, rvec_r, tvec_r, K2, D2)
        d_l = proj_l.reshape(-1, 2) - pl.reshape(-1, 2)
        d_r = proj_r.reshape(-1, 2) - pr.reshape(-1, 2)
        m = d_l.shape[0] + d_r.shape[0]
        errs.append(float(np.sqrt((np.sum(d_l ** 2) + np.sum(d_r ** 2)) / m)))
    return np.asarray(errs, dtype=np.float64)


def compute_stereo_calibration(objpoints, imgL, imgR, eye_size):
    """Per-eye intrinsics, then stereo extrinsics + rectification maps + Q.

    Runs the stereo extrinsic solve twice: once on all pairs, then again after
    culling temporal-desync outliers (see below). eye_size is (width, height).
    Returns a dict with the rectify maps, Q, image_size, recovered baseline (m),
    RMS errors (px), and how many pairs the final solve used.
    """
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 1e-5)
    rms_l, K1, D1, _, _ = cv2.calibrateCamera(objpoints, imgL, eye_size, None, None)
    rms_r, K2, D2, _, _ = cv2.calibrateCamera(objpoints, imgR, eye_size, None, None)
    stereo_rms, K1, D1, K2, D2, R, T, _, _ = cv2.stereoCalibrate(
        objpoints, imgL, imgR, K1, D1, K2, D2, eye_size,
        criteria=crit, flags=cv2.CALIB_FIX_INTRINSIC,
    )
    # Cull temporal-desync outlier pairs and re-solve the extrinsics. The two
    # eyes are captured a few ms apart (unsynchronised USB), so a pair grabbed
    # while the board moved stays self-consistent per eye (intrinsics / per-eye
    # RMS are unaffected) but violates the single rigid R, T shared by all pairs,
    # inflating the stereo RMS. Dropping those pairs — flagged by a high per-pair
    # reprojection error through R, T — sharpens R, T without touching the
    # (fixed) intrinsics. Skipped when there are too few pairs to spare any.
    pairs_total = len(objpoints)
    pairs_used = pairs_total
    if pairs_total > 8:
        errs = _pair_stereo_errors(objpoints, imgL, imgR, K1, D1, K2, D2, R, T)
        keep = select_inlier_pairs(errs)
        if 0 < len(keep) < pairs_total:
            k_obj = [objpoints[i] for i in keep]
            k_l = [imgL[i] for i in keep]
            k_r = [imgR[i] for i in keep]
            stereo_rms, K1, D1, K2, D2, R, T, _, _ = cv2.stereoCalibrate(
                k_obj, k_l, k_r, K1, D1, K2, D2, eye_size,
                criteria=crit, flags=cv2.CALIB_FIX_INTRINSIC,
            )
            pairs_used = len(keep)
    R1, R2, P1, P2, Q, _, _ = cv2.stereoRectify(
        K1, D1, K2, D2, eye_size, R, T,
        flags=cv2.CALIB_ZERO_DISPARITY, alpha=0,
    )
    m1x, m1y = cv2.initUndistortRectifyMap(K1, D1, R1, P1, eye_size, cv2.CV_32FC1)
    m2x, m2y = cv2.initUndistortRectifyMap(K2, D2, R2, P2, eye_size, cv2.CV_32FC1)
    return {
        "map1x": m1x, "map1y": m1y, "map2x": m2x, "map2y": m2y, "Q": Q,
        "image_size": (int(eye_size[0]), int(eye_size[1])),
        "baseline_m": float(np.linalg.norm(T)),
        "stereo_rms": float(stereo_rms),
        "rms_l": float(rms_l), "rms_r": float(rms_r),
        "pairs_used": int(pairs_used), "pairs_total": int(pairs_total),
    }


def save_calibration(path, result, square_m):
    """Write a calibration dict (from compute_stereo_calibration) to an .npz."""
    out_dir = os.path.dirname(os.path.abspath(path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    np.savez(
        path,
        map1x=result["map1x"], map1y=result["map1y"],
        map2x=result["map2x"], map2y=result["map2y"], Q=result["Q"],
        image_size=np.array(result["image_size"], dtype=np.int32),
        baseline_m=np.float32(result["baseline_m"]),
        stereo_rms=np.float32(result["stereo_rms"]),
        square_m=np.float32(square_m),
    )


@dataclass
class StereoConfig:
    calib_path: str = ""
    # numDisparities MUST be a positive multiple of 16 (OpenCV constraint); it
    # sets the max disparity searched, i.e. the nearest detectable depth.
    num_disparities: int = 96
    block_size: int = 7                # odd, 3..11
    uniqueness: int = 10
    speckle_window: int = 100
    speckle_range: int = 2
    # Corridor rectangle as (x0, y0, x1, y1) fractions: a band ahead of the
    # rover, lower-centre of the frame (the ground it's about to drive over).
    roi: tuple = (0.30, 0.55, 0.70, 0.98)
    near_m: float = 0.4
    far_m: float = 2.5
    min_fill: float = 0.12
    min_valid_px: int = 400
    cv_threads: int = 1                # cap so SGBM can't starve the ROS loop
    # Block-matcher mode, shared by detection AND the live composite (one depth
    # pass serves both). Default "sgbm" — full 5-path SGBM: most accurate and far
    # less noisy than 3way (3way's fewer aggregation paths leave streaky
    # low-texture noise). 3way was only needed to make full SGBM affordable at 720p
    # (~1.8 fps); at the 512×288 detect/compute resolution full SGBM runs ~23 fps
    # (benchmarked), so it clears DETECT_FPS + the camera rate with room while
    # giving a clean depth map. Set "3way" only if you must trade quality for a bit
    # more rate. "hh"/"hh4" also available.
    sgbm_mode: str = "sgbm"
    # Live composite view (compute_composite) only: the depth range mapped onto
    # the heatmap colours, and the near clip for the WHOLE-FRAME nearest-point
    # marker (reject lens-edge / speckle closer than this, which would otherwise
    # report an absurd sub-decimetre 'nearest'). Independent of the obstacle band.
    viz_near_m: float = 0.3
    viz_far_m: float = 5.0
    # Post-SGBM speckle removal (cv2.filterSpeckles): connected disparity blobs
    # smaller than this many pixels are dropped as noise. 0 disables. Cleans the
    # shared depth for both detection and the composite. Sized for the ~512×288
    # compute resolution.
    speckle_filter_size: int = 200
    # Live composite only: ignore this fraction of each frame edge when picking the
    # WHOLE-FRAME nearest-point marker. The top of the FOV often holds the rover's
    # own structure / frame-edge disparity, which otherwise pins the marker to the
    # top border every frame; a margin keeps it on a real interior near point.
    viz_edge_margin: float = 0.05
    # Live composite depth resolution as a fraction of the calibration (base) size.
    # The base image is rendered SHARP at the full calib resolution, but the
    # expensive SGBM depth runs on a downscaled copy (cost ~ pixels × disparity):
    # 0.4 of a 1280×720 calib → depth at 512×288 (benchmarked ~8 fps end-to-end vs
    # ~2 fps at full 720p) while the displayed real image stays crisp. 1.0 = depth
    # at full base resolution (sharpest depth, slowest).
    viz_depth_scale: float = 0.4


class StereoDepth:
    """Owns the calibration + SGBM matcher; turns an SBS frame into a verdict.

    .enabled is False when no usable calibration loaded — detect() then always
    reports no obstacle, and the node never auto-pauses on noise.
    """

    def __init__(self, cfg: StereoConfig):
        self.cfg = cfg
        self.enabled = False
        self._calib = None
        self._matcher = None
        self._mode = None
        self._viz_matchers = {}   # numDisparities → SGBM matcher (composite path)
        if cv2 is None:
            return
        calib = load_calibration(cfg.calib_path)
        if calib is None:
            return
        # Bound OpenCV's internal thread pool BEFORE the first compute() so a
        # full-frame block match can't fan out across every core and stall the
        # navigator's timer callback on the shared Pi.
        try:
            cv2.setNumThreads(max(1, int(cfg.cv_threads)))
        except Exception:  # noqa: BLE001 - non-fatal tuning call
            pass
        self._calib = calib
        # numDisparities must be a positive multiple of 16.
        nd = max(16, (int(cfg.num_disparities) // 16) * 16)
        modes = {
            "sgbm": cv2.STEREO_SGBM_MODE_SGBM,
            "hh": cv2.STEREO_SGBM_MODE_HH,
            "hh4": getattr(cv2, "STEREO_SGBM_MODE_HH4", cv2.STEREO_SGBM_MODE_HH),
            "3way": cv2.STEREO_SGBM_MODE_SGBM_3WAY,
        }
        # One mode for both detection and the composite — they share a single depth
        # pass (see compute_depth), so there is nothing to diverge.
        self._mode = modes.get((cfg.sgbm_mode or "3way").lower(), cv2.STEREO_SGBM_MODE_SGBM_3WAY)
        self._matcher = self._make_matcher(nd, self._mode)
        self.enabled = True

    def _make_matcher(self, nd, mode):
        """StereoSGBM with this module's tuned params at a given disparity range +
        mode. Shared by the detection matcher and the composite's _viz_matcher so
        the two can't drift. P1/P2 are the smoothness penalties (OpenCV's
        block-area defaults for a single-channel match)."""
        nd = max(16, (int(nd) // 16) * 16)
        bs = int(self.cfg.block_size) | 1  # force odd
        return cv2.StereoSGBM_create(
            minDisparity=0, numDisparities=nd, blockSize=bs,
            P1=8 * bs * bs, P2=32 * bs * bs, disp12MaxDiff=1,
            uniquenessRatio=int(self.cfg.uniqueness),
            speckleWindowSize=int(self.cfg.speckle_window),
            speckleRange=int(self.cfg.speckle_range), mode=mode)

    def _rectify_eye(self, eye, map_x, map_y, size, to_gray):
        """Resize an eye to the calibrated size and rectify it; grayscale when
        to_gray (detection / block matching), colour otherwise (composite base)."""
        if (eye.shape[1], eye.shape[0]) != size:
            eye = cv2.resize(eye, size, interpolation=cv2.INTER_AREA)
        rect = cv2.remap(eye, map_x, map_y, cv2.INTER_LINEAR)
        if to_gray and rect.ndim == 3:
            rect = cv2.cvtColor(rect, cv2.COLOR_BGR2GRAY)
        return rect

    def _prep_eye(self, eye, map_x, map_y, size):
        """Resize an eye to the calibrated size, rectify, return grayscale."""
        return self._rectify_eye(eye, map_x, map_y, size, to_gray=True)

    def compute_depth(self, left, right, scale=1.0):
        """Left + right eye frames → (depth_z metres, valid mask) at `scale`× the
        calibration resolution. None if disabled.

        scale=1.0 is full calib res; scale<1 rectifies at calib res then downscales
        the grays before SGBM (cost ~ pixels × disparity) and scales the reprojection
        Q so metric depth stays correct (downscaled disparity d' = s·d, so
        Q' = Q·diag(1/s,1/s,1/s,1) reprojects the same 3D point). This ONE pass is
        shared by detection (decide) and the live composite (render_composite), so
        stereo is never computed twice for the same frame.
        """
        if not self.enabled:
            return None
        c = self._calib
        size = c["image_size"]
        gl = self._prep_eye(left, c["map1x"], c["map1y"], size)
        gr = self._prep_eye(right, c["map2x"], c["map2y"], size)
        s = min(1.0, max(0.05, float(scale)))
        if s < 1.0:
            dw, dh = max(16, int(round(size[0] * s))), max(16, int(round(size[1] * s)))
            gl = cv2.resize(gl, (dw, dh), interpolation=cv2.INTER_AREA)
            gr = cv2.resize(gr, (dw, dh), interpolation=cv2.INTER_AREA)
            Q = c["Q"] @ np.diag([1.0 / s, 1.0 / s, 1.0 / s, 1.0]).astype(c["Q"].dtype)
            nd = max(16, (int(round(self.cfg.num_disparities * s)) // 16) * 16)
            matcher = self._viz_matcher(nd)
        else:
            Q, matcher = c["Q"], self._matcher
        # StereoSGBM returns fixed-point disparity (×16) as int16.
        raw = matcher.compute(gl, gr)
        # Drop small speckle blobs (noise) beyond what SGBM's speckleWindowSize
        # catches — set to 0 so they read as invalid below. In-place on the int16
        # disparity; maxDiff is in ×16 units (32 ≈ 2 disparity levels).
        if self.cfg.speckle_filter_size and self.cfg.speckle_filter_size > 0:
            cv2.filterSpeckles(raw, 0, int(self.cfg.speckle_filter_size), 32)
        disp = raw.astype(np.float32) / 16.0
        # Disparities at/below 0 never matched (or fell in the left margin where
        # the right image has no overlap) — exclude them from depth.
        valid = disp > 0.0
        depth_z = cv2.reprojectImageTo3D(disp, Q)[:, :, 2]
        # reprojectImageTo3D emits huge/!finite Z where disparity ~0; mask those
        # out so they can't masquerade as far background.
        valid &= np.isfinite(depth_z)
        return depth_z, valid

    def decide(self, depth_z, valid):
        """Corridor obstacle decision + info from a PRECOMPUTED depth map (from
        compute_depth at any scale). Separated from depth so detection can share the
        composite's single depth pass.

        info always carries 'enabled'; when enabled it adds fill / counts /
        nearest-corridor-depth for logging + the operator alert payload.
        """
        if not self.enabled:
            return False, {"enabled": False}
        cfg = self.cfg
        # min_valid_px is authored for the full calib resolution; scale it to the
        # actual depth-map size so the floor means the same fraction of the corridor
        # regardless of the (possibly downscaled) detect resolution.
        full = self._calib["image_size"]
        px_ratio = (depth_z.shape[1] * depth_z.shape[0]) / float(full[0] * full[1])
        min_valid = max(1, int(round(cfg.min_valid_px * px_ratio)))
        obstacle, fill, near_count, valid_count = obstacle_in_roi(
            depth_z, valid, cfg.roi, cfg.near_m, cfg.far_m, cfg.min_fill, min_valid,
        )
        info = {
            "enabled": True,
            "fill": round(float(fill), 3),
            "near_count": near_count,
            "valid_count": valid_count,
        }
        if obstacle:
            # Nearest in-band depth in the corridor — handy for the operator
            # alert ("obstacle ~0.8 m ahead") and for tuning. Clamp the fractions
            # to [0,1] like obstacle_in_roi (a negative fraction would otherwise
            # index from the array end and corrupt the reported depth).
            h, w = depth_z.shape[:2]
            x0, y0, x1, y1 = cfg.roi
            xa = int(round(np.clip(min(x0, x1), 0.0, 1.0) * w))
            xb = int(round(np.clip(max(x0, x1), 0.0, 1.0) * w))
            ya = int(round(np.clip(min(y0, y1), 0.0, 1.0) * h))
            yb = int(round(np.clip(max(y0, y1), 0.0, 1.0) * h))
            zr = depth_z[ya:yb, xa:xb]
            vr = valid[ya:yb, xa:xb] & (zr >= cfg.near_m) & (zr <= cfg.far_m)
            if np.any(vr):
                info["nearest_m"] = round(float(np.min(zr[vr])), 2)
        return obstacle, info

    def detect(self, left, right, scale=1.0):
        """Convenience: compute_depth(scale) + decide, in one call. The node
        computes the shared depth itself and calls decide() directly; this stays
        for standalone / test use. Safe with disabled detector (no frame access)."""
        if not self.enabled:
            return False, {"enabled": False}
        depth_z, valid = self.compute_depth(left, right, scale=scale)
        return self.decide(depth_z, valid)

    def _viz_matcher(self, nd):
        """SGBM matcher for a downscaled depth resolution, cached by numDisparities.
        The full-res matcher's numDisparities is tuned for the calib resolution;
        a downscaled pass has a smaller disparity range, so it needs its own matcher.
        Same mode as detection (they share the depth pass)."""
        m = self._viz_matchers.get(nd)
        if m is None:
            m = self._make_matcher(nd, self._mode)
            self._viz_matchers[nd] = m
        return m

    def render_composite(self, left, depth_z, valid, alpha=0.45):
        """(left eye, PRECOMPUTED depth) → (BGR composite, info) for the live view.

        The BASE (real image) is the rectified left eye at the full calibration
        resolution — SHARP. `depth_z`/`valid` come from compute_depth (typically the
        downscaled pass shared with detection): its heatmap is colourised and
        upscaled onto the sharp base, with a marker at the whole-frame nearest point.
        Base and depth share the RECTIFIED frame (differing only by a uniform scale),
        so the marker maps back by the size ratio — no un-rectify warp. Taking the
        depth precomputed is what lets the composite reuse detection's single pass
        instead of running SGBM again. info carries 'enabled' + 'nearest_m'.
        """
        if not self.enabled:
            return None, {"enabled": False}
        c = self._calib
        size = c["image_size"]                     # calib / display (base) size, e.g. (1280, 720)
        w, h = size
        base = self._rectify_eye(left, c["map1x"], c["map1y"], size, to_gray=False)
        if base.ndim == 2:
            base = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)

        # Depth → colour with NEAR = warm. Textureless surfaces (floor, glass,
        # walls) leave many invalid holes that flicker frame-to-frame ("자글거림");
        # for the DISPLAY ONLY, fill them from neighbours and smooth so the overlay
        # is solid and stable. Detection is unaffected — decide() runs on the raw
        # depth/valid, so filled (invented) depth can never fabricate an obstacle.
        near = self.cfg.viz_near_m
        far = max(self.cfg.viz_far_m, near + 0.1)
        norm = np.clip((depth_z - near) / (far - near), 0.0, 1.0)
        du8 = ((1.0 - norm) * 255).astype(np.uint8)      # near = bright; garbage where invalid
        holes = (~valid).astype(np.uint8) * 255
        if np.any(holes):
            du8 = cv2.inpaint(du8, holes, 3, cv2.INPAINT_TELEA)   # fill holes from neighbours
        du8 = cv2.medianBlur(du8, 5)                     # de-shimmer
        heat = cv2.applyColorMap(du8, cv2.COLORMAP_JET)
        if (heat.shape[1], heat.shape[0]) != size:
            heat = cv2.resize(heat, size, interpolation=cv2.INTER_LINEAR)
        # Uniform translucent overlay over the whole (now hole-free) frame — the
        # sharp base still shows through the alpha.
        out = np.ascontiguousarray(cv2.addWeighted(base, 1.0 - alpha, heat, alpha, 0.0))

        # Whole-frame nearest (at the depth-map res) → scale marker coords up to the
        # base by the actual size ratio (handles any depth scale). Ignore an edge
        # margin so the marker isn't pinned to the top/border by the rover's own
        # structure or frame-edge disparity.
        dh, dw = depth_z.shape[:2]
        mgn = min(0.45, max(0.0, self.cfg.viz_edge_margin))
        my, mx = int(dh * mgn), int(dw * mgn)
        interior = np.zeros(depth_z.shape, dtype=bool)
        interior[my:dh - my, mx:dw - mx] = True
        z, x, y = nearest_point(depth_z, valid & interior, near, self.cfg.viz_far_m)
        info = {"enabled": True, "nearest_m": (round(z, 2) if z == z else None)}
        if x >= 0:
            bx = int(round(x * (w / depth_z.shape[1])))
            by = int(round(y * (h / depth_z.shape[0])))
            cv2.drawMarker(out, (bx, by), (255, 255, 255), cv2.MARKER_CROSS, 24, 2)
            cv2.circle(out, (bx, by), 12, (255, 255, 255), 2)
            label = f"{z:.2f} m"
            org = (min(max(0, bx - 24), w - 110), min(max(28, by - 20), h - 10))
            cv2.putText(out, label, org, cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 5, cv2.LINE_AA)
            cv2.putText(out, label, org, cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
        return out, info

    def compute_composite(self, left, right, depth_scale=None, alpha=0.45):
        """Convenience: compute_depth(depth_scale) + render_composite, in one call.
        The node computes the shared depth itself and calls render_composite directly
        (so detection reuses it); this stays for standalone / test use. depth_scale
        None uses cfg.viz_depth_scale."""
        if not self.enabled:
            return None, {"enabled": False}
        s = self.cfg.viz_depth_scale if depth_scale is None else float(depth_scale)
        depth_z, valid = self.compute_depth(left, right, scale=s)
        return self.render_composite(left, depth_z, valid, alpha=alpha)


def config_from_env(env=None):
    """Build a StereoConfig from environment variables (node-side helper)."""
    e = env if env is not None else os.environ

    def _f(name, default):
        try:
            v = e.get(name)
            return float(v) if v not in (None, "") else default
        except (TypeError, ValueError):
            return default

    def _i(name, default):
        try:
            v = e.get(name)
            return int(v) if v not in (None, "") else default
        except (TypeError, ValueError):
            return default

    roi = (
        _f("OBSTACLE_ROI_X0", 0.30), _f("OBSTACLE_ROI_Y0", 0.55),
        _f("OBSTACLE_ROI_X1", 0.70), _f("OBSTACLE_ROI_Y1", 0.98),
    )
    return StereoConfig(
        calib_path=e.get("STEREO_CALIB_PATH", "/var/lib/perception/stereo_calib.npz"),
        num_disparities=_i("STEREO_NUM_DISPARITIES", 96),
        block_size=_i("STEREO_BLOCK_SIZE", 7),
        uniqueness=_i("STEREO_UNIQUENESS", 10),
        speckle_window=_i("STEREO_SPECKLE_WINDOW", 100),
        speckle_range=_i("STEREO_SPECKLE_RANGE", 2),
        roi=roi,
        near_m=_f("OBSTACLE_NEAR_M", 0.4),
        far_m=_f("OBSTACLE_FAR_M", 2.5),
        min_fill=_f("OBSTACLE_MIN_FILL", 0.12),
        min_valid_px=_i("OBSTACLE_MIN_VALID_PX", 400),
        cv_threads=_i("STEREO_CV_THREADS", 1),
        sgbm_mode=(e.get("STEREO_SGBM_MODE") or "sgbm").lower(),
        viz_near_m=_f("VIZ_NEAR_M", 0.3),
        viz_far_m=_f("VIZ_FAR_M", 5.0),
        viz_depth_scale=_f("VIZ_DEPTH_SCALE", 0.4),
        speckle_filter_size=_i("STEREO_SPECKLE_FILTER_SIZE", 200),
        viz_edge_margin=_f("VIZ_EDGE_MARGIN", 0.05),
    )
