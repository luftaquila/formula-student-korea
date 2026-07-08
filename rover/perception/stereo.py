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
    except Exception:  # noqa: BLE001 — unreadable/corrupt/empty archive → stay disabled
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


# ── ground profile (above-ground detection) ─────────────────────────────────
# The expected depth of the CLEAR ground plane as a function of image row is
# fixed by the camera's (unchanging) height + pitch. We calibrate it once on flat
# empty ground — per row-fraction, the median valid depth — and store the curve.
# Detection then flags anything CLOSER than this curve (i.e. protruding above the
# ground). Stored resolution-independent as (row_frac, depth_m); NaN marks rows
# with no reliable ground reading (open sky / beyond range) — never flagged.
GROUND_KEYS = ("row_frac", "depth_m")


def default_ground_path(calib_path):
    """Derive the ground-profile path next to the stereo calibration."""
    if not calib_path:
        return ""
    base = calib_path[:-4] if calib_path.endswith(".npz") else calib_path
    return base + "_ground.npz"


def load_ground_profile(path):
    """Load a ground curve .npz → {'row_frac','depth_m'} (ascending row_frac), or
    None on any problem so the detector can fall back cleanly."""
    if not path or not os.path.exists(path):
        return None
    try:
        data = np.load(path, allow_pickle=False)
    except Exception:  # noqa: BLE001 — unreadable/corrupt/empty file → None (band fallback)
        return None
    if not all(k in data for k in GROUND_KEYS):
        return None
    rf = np.asarray(data["row_frac"], dtype=np.float64)
    dm = np.asarray(data["depth_m"], dtype=np.float64)
    if rf.ndim != 1 or rf.shape != dm.shape or rf.size < 2:
        return None
    order = np.argsort(rf)
    return {"row_frac": rf[order], "depth_m": dm[order]}


def save_ground_profile(path, row_frac, depth_m):
    """Persist a ground curve. NaN depths (unknown rows) are preserved."""
    np.savez(path, row_frac=np.asarray(row_frac, dtype=np.float64),
             depth_m=np.asarray(depth_m, dtype=np.float64))


def fit_ground_profile(row_fracs, depths, min_depth_m=0.3):
    """Turn per-row (row_frac, median depth) samples into a clean stored curve:
    drop non-finite / too-near samples, sort, and enforce that ground depth is
    non-increasing as the row grows (the ground gets nearer toward the bottom of
    the frame). Returns (row_frac, depth_m) arrays ready for save_ground_profile."""
    rf = np.asarray(row_fracs, dtype=np.float64)
    dm = np.asarray(depths, dtype=np.float64)
    ok = np.isfinite(rf) & np.isfinite(dm) & (dm >= min_depth_m)
    rf, dm = rf[ok], dm[ok]
    order = np.argsort(rf)
    rf, dm = rf[order], dm[order]
    # Enforce non-increasing depth with row (ground gets nearer toward the bottom),
    # anchored from the RELIABLE near end. Bottom rows have the largest disparity, so
    # a running max walking bottom→top clamps a spuriously-near reading at a far
    # (top, least-reliable) bin UP to the established trend — instead of a top→bottom
    # running-min letting one bad far sample drag the whole curve, including the
    # reliable near rows, down to it (which would silently blind the above-ground
    # detector). This keeps calibration errors in the SAFE direction (ground read
    # farther → over-flag / false positive) rather than the dangerous one (ground
    # read nearer → obstacles missed).
    dm = np.maximum.accumulate(dm[::-1])[::-1]
    return rf, dm


def ground_depth_for_rows(profile, height):
    """Interpolate a stored ground curve onto `height` image rows → array of the
    expected ground depth per row (NaN outside the calibrated row range, so those
    rows are never treated as having a known ground)."""
    rf = profile["row_frac"]
    dm = profile["depth_m"]
    ys = (np.arange(height) + 0.5) / float(height)
    out = np.interp(ys, rf, dm, left=np.nan, right=np.nan)
    # np.interp clamps to edge values by default; the left/right=nan above marks
    # rows outside [rf.min, rf.max] as unknown instead of extrapolating flat.
    out[(ys < rf[0]) | (ys > rf[-1])] = np.nan
    return out


def ground_row_medians(depth_z, valid, roi_x0, roi_x1, nbins):
    """Per horizontal row-bin, the median valid depth within the corridor x-band —
    one frame's raw material for a ground curve. Returns (row_fracs, depths) with
    NaN where a bin had no valid pixels. Shared by the UI-triggered node calibration
    and the ground_calibrate.py CLI so both bin identically. The caller collects
    these across frames, medians per bin, and feeds fit_ground_profile."""
    h, w = depth_z.shape[:2]
    xa = int(round(np.clip(min(roi_x0, roi_x1), 0.0, 1.0) * w))
    xb = int(round(np.clip(max(roi_x0, roi_x1), 0.0, 1.0) * w))
    row_fracs = np.empty(nbins, dtype=np.float64)
    depths = np.full(nbins, np.nan, dtype=np.float64)
    for b in range(nbins):
        ya = int(round(b / nbins * h))
        yb = int(round((b + 1) / nbins * h))
        row_fracs[b] = (b + 0.5) / nbins
        vm = valid[ya:yb, xa:xb]
        if np.any(vm):
            depths[b] = float(np.median(depth_z[ya:yb, xa:xb][vm]))
    return row_fracs, depths


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
    # y0 is 0.44 (not 0.55): a standing obstacle at a useful stopping distance
    # (~2-2.5 m) images around the vertical middle of the frame, so a corridor
    # that only started at 0.55 caught it late (~1 m). Raising the top edge trips
    # the pause ~1 m sooner. The extra upper band is safe: flat road there is
    # beyond far_m (out of band) or low-texture at night (dropped by conf_min).
    roi: tuple = (0.30, 0.44, 0.70, 0.98)
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
    # WLS disparity post-filter (cv2.ximgproc): edge-aware hole-fill + smoothing
    # guided by the left image, plus a confidence map. This is the reference fix
    # for stereo's textureless holes / noise. lambda ≈ regularisation strength,
    # sigma ≈ edge sensitivity (OpenCV's documented defaults). conf_min gates the
    # DETECTION + nearest-marker on the confidence map (0–255) so the auto-pause
    # never acts on WLS-interpolated (guessed) depth; the display keeps the full
    # filled map. Falls back to plain SGBM if ximgproc is unavailable.
    wls_lambda: float = 8000.0
    wls_sigma: float = 1.5
    conf_min: int = 128
    # ── obstacle decision mode ────────────────────────────────────────────────
    # "aboveground" (default): flag depth pixels CLOSER than the expected ground
    #   at their image row (a calibrated per-row ground curve), cluster them, and
    #   trip on any cluster of a minimum PHYSICAL size within range. Detects small
    #   obstacles + people, ignores the flat ground plane, and decouples range from
    #   ground false-positives. Requires a ground profile (ground_profile_path);
    #   falls back to "band" if none is loaded.
    # "band": legacy — fraction of the ROI whose depth is in [near_m, far_m] >=
    #   min_fill. A bulk/large-obstacle detector; kept as a fallback.
    detect_mode: str = "aboveground"
    ground_profile_path: str = ""       # "" → derived from calib_path (…_ground.npz)
    # A pixel is "above ground" when its depth is closer than the row's expected
    # ground depth by more than max(rel·ground, abs) — rel absorbs the depth's
    # proportional noise (it grows with range), abs floors it near the rover.
    ground_rel_margin: float = 0.18
    ground_abs_margin_m: float = 0.12
    # Minimum PHYSICAL cluster size to trip (metres, via focal length). Sized to
    # catch a low obstacle / a leg while rejecting speckle. Absolute, NOT a frame
    # fraction — that's the whole point vs the band detector.
    min_obstacle_w_m: float = 0.08
    min_obstacle_h_m: float = 0.10
    # Morphological close (px at compute res) to bridge sparse above-ground pixels
    # into one blob before connected components, and a pre-size speckle floor.
    aboveground_close_px: int = 5
    min_cluster_px: int = 30
    # Trip only within this range — now safe to be generous since the ground plane
    # itself is never flagged (unlike far_m in band mode).
    max_detect_range_m: float = 3.0
    # Ground reference = the calibrated curve's recession SHAPE, shifted per frame by
    # a PITCH offset measured on the very-near strip (the rover's immediate foreground,
    # reliably ground even with an obstacle ahead). Keeping the real recession means an
    # obstacle filling the mid/upper corridor reads far closer than the (correctly far)
    # expected ground and is flagged; the offset lets flat ground track the rover's
    # pitch so it never false-trips. A pure per-frame plane fit was tried and rejected:
    # a near-strip fit gives an unreliable slope and a corridor-filling obstacle hijacks
    # a full-ROI fit (both miss the obstacle). ground_offset_min_px near-strip pixels
    # are needed to trust the offset; otherwise the curve is used unshifted.
    ground_offset_strip_frac: float = 0.20
    ground_offset_min_px: int = 60


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
        self._right_matcher = None
        self._wls = None
        # Above-ground detection state — safe defaults so a DISABLED detector (no
        # calibration) still answers detect_mode / decide() without AttributeError.
        self.detect_mode = "band"
        self._ground = None
        self._ground_path = ""
        self._f_calib = 0.0
        self._ground_rows_cache = {}
        self._dbg_offset = 0.0
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
        # numDisparities sets the CLOSEST measurable depth (max disparity). It is
        # NOT scaled with viz_depth_scale — doing so floored the near range (e.g.
        # nd 96→32 at 0.4 pinned the nearest at ~1.08 m). Keep the full value at the
        # (downscaled) compute resolution: nd=96 measures to ~0.35 m at 512×288.
        nd = max(16, (int(cfg.num_disparities) // 16) * 16)
        modes = {
            "sgbm": cv2.STEREO_SGBM_MODE_SGBM,
            "hh": cv2.STEREO_SGBM_MODE_HH,
            "hh4": getattr(cv2, "STEREO_SGBM_MODE_HH4", cv2.STEREO_SGBM_MODE_HH),
            "3way": cv2.STEREO_SGBM_MODE_SGBM_3WAY,
        }
        self._mode = modes.get((cfg.sgbm_mode or "sgbm").lower(), cv2.STEREO_SGBM_MODE_SGBM)
        has_wls = hasattr(cv2, "ximgproc")
        if has_wls:
            # Reference WLS pipeline: a 3WAY left matcher tuned for WLS (low block,
            # preFilterCap, no internal speckle — the filter does the cleanup), a
            # right matcher, and the confidence-capable filter.
            bs = 3
            self._matcher = cv2.StereoSGBM_create(
                minDisparity=0, numDisparities=nd, blockSize=bs,
                P1=24 * bs * bs, P2=96 * bs * bs, disp12MaxDiff=1,
                uniquenessRatio=0, speckleWindowSize=0, speckleRange=0,
                preFilterCap=63, mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY)
            self._right_matcher = cv2.ximgproc.createRightMatcher(self._matcher)
            self._wls = cv2.ximgproc.createDisparityWLSFilter(self._matcher)
            self._wls.setLambda(float(cfg.wls_lambda))
            self._wls.setSigmaColor(float(cfg.wls_sigma))
        else:
            # Fallback (no ximgproc): plain single-matcher SGBM.
            self._matcher = self._make_matcher(nd, self._mode)
        self.enabled = True

        # Focal length (px) at the CALIBRATION resolution, from the reprojection Q
        # (Q[2,3] = f). Used to convert a cluster's pixel extent to metres; scaled
        # to the depth-map resolution per frame in decide_aboveground.
        try:
            self._f_calib = float(abs(calib["Q"][2, 3]))
        except Exception:  # noqa: BLE001
            self._f_calib = 0.0

        # Above-ground detection needs the calibrated ground curve (its recession
        # SHAPE — a per-frame pitch offset adapts it live) and a focal length (to size
        # clusters). Missing either → fall back to the band detector.
        gpath = cfg.ground_profile_path or default_ground_path(cfg.calib_path)
        self._ground = load_ground_profile(gpath)
        self._ground_path = gpath
        self.detect_mode = (cfg.detect_mode or "aboveground").lower()
        if self.detect_mode == "aboveground" and (self._ground is None or self._f_calib <= 0):
            why = "no ground profile at %s" % gpath if self._ground is None else "no focal length in calib"
            print(f"[stereo] aboveground detection unavailable ({why}); "
                  f"falling back to band mode", flush=True)
            self.detect_mode = "band"
        self._ground_rows_cache = {}   # height -> per-row calibrated ground depth (the shape)

    def _make_matcher(self, nd, mode):
        """Plain StereoSGBM (fallback path when ximgproc/WLS is unavailable)."""
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

    def rectify_sbs(self, left, right):
        """Rectified COLOUR left|right eyes packed side-by-side, for stereo VR
        streaming. Rectification row-aligns the two eyes (same stored calibration
        as depth) so they fuse comfortably in the headset. Returns an ndarray of
        width 2×eye or None if no calibration is loaded."""
        if not self.enabled or self._calib is None:
            return None
        c = self._calib
        size = c["image_size"]  # (w, h) of one rectified eye
        lr = self._rectify_eye(left, c["map1x"], c["map1y"], size, to_gray=False)
        rr = self._rectify_eye(right, c["map2x"], c["map2y"], size, to_gray=False)
        return np.hstack([lr, rr])

    def compute_depth(self, left, right, scale=1.0):
        """Left + right eye frames → (depth_z metres, valid mask, conf) at `scale`×
        the calibration resolution. None if disabled.

        Rectify at calib res, optionally downscale the grays (scale<1) and scale the
        reprojection Q so metric depth stays correct (downscaled disparity d' = s·d,
        so Q' = Q·diag(1/s,1/s,1/s,1)). numDisparities is fixed at the matcher, NOT
        scaled, so the near range is preserved at any scale. With ximgproc, runs the
        WLS pipeline (left+right matcher → edge-aware hole-fill + smoothing) and
        returns its confidence map (0–255); without it, plain SGBM and conf=None.
        This ONE pass is shared by detection (decide) and the composite
        (render_composite), so stereo is never computed twice for a frame.
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
        else:
            Q = c["Q"]
        conf = None
        if self._wls is not None:
            # WLS: filter the left disparity with the right disparity as a
            # consistency check; the filter fills + smooths edge-aware and exposes a
            # confidence map. StereoSGBM output is fixed-point (×16) int16.
            left_disp = self._matcher.compute(gl, gr)
            right_disp = self._right_matcher.compute(gr, gl)
            filtered = self._wls.filter(left_disp, gl, disparity_map_right=right_disp)
            conf = self._wls.getConfidenceMap()
            disp = filtered.astype(np.float32) / 16.0
        else:
            raw = self._matcher.compute(gl, gr)
            if self.cfg.speckle_filter_size and self.cfg.speckle_filter_size > 0:
                cv2.filterSpeckles(raw, 0, int(self.cfg.speckle_filter_size), 32)
            disp = raw.astype(np.float32) / 16.0
        # Disparities at/below 0 never matched (or fell in the left margin where the
        # right image has no overlap) — exclude them from depth.
        valid = disp > 0.0
        depth_z = cv2.reprojectImageTo3D(disp, Q)[:, :, 2]
        valid &= np.isfinite(depth_z)     # reproject emits !finite Z where disp ~0
        return depth_z, valid, conf

    def decide(self, depth_z, valid, conf=None):
        """Obstacle decision from a PRECOMPUTED depth map (compute_depth at any
        scale), shared with the composite's single depth pass. Dispatches by mode:
        'aboveground' (ground-relative clusters of a minimum physical size) or
        'band' (legacy corridor fill). Both gate on the WLS confidence map
        (>= cfg.conf_min) so the auto-pause never acts on interpolated/guessed
        depth. info always carries 'enabled' + 'mode'.
        """
        if not self.enabled:
            return False, {"enabled": False}
        if self.detect_mode == "aboveground" and self._ground is not None:
            return self._decide_aboveground(depth_z, valid, conf)
        return self._decide_band(depth_z, valid, conf)

    def _decide_band(self, depth_z, valid, conf=None):
        """Legacy detector: obstacle if the fraction of the ROI's valid pixels with
        depth in [near_m, far_m] reaches min_fill. A bulk/large-obstacle test that
        cannot separate the near ground plane from a real obstacle — kept as a
        fallback for when no ground profile is calibrated (see detect_mode)."""
        cfg = self.cfg
        if conf is not None:
            valid = valid & (conf >= cfg.conf_min)
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
            "mode": "band",
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

    def _ground_rows(self, height):
        """STATIC fallback: expected ground depth per row from the stored profile
        (cached per height). All-NaN when no profile is loaded — then a frame whose
        per-frame fit fails simply detects nothing rather than acting on a guess."""
        arr = self._ground_rows_cache.get(height)
        if arr is None:
            if self._ground is None:
                arr = np.full(height, np.nan, dtype=np.float64)
            else:
                arr = ground_depth_for_rows(self._ground, height)
            self._ground_rows_cache[height] = arr
        return arr

    def _ground_ref(self, depth_z, valid, xa, xb, ya, yb, h):
        """Per-frame ground reference: the calibrated curve's recession SHAPE shifted
        by a PITCH offset measured on the very-near strip. Returns per-row ground
        depth (h,), or None if no calibrated curve is loaded.

        The curve fixes the recession (so the mid/upper rows stay correctly FAR and an
        obstacle there — even one filling the corridor — reads far closer than the
        expected ground and is flagged). The offset, taken from the rover's immediate
        foreground (reliably ground even with an obstacle ahead, so it isn't hijacked),
        slides the whole curve in inverse-depth space to track the rover's pitch, so
        flat ground never false-trips. Offset is applied in 1/z: a plane stays a plane."""
        cfg = self.cfg
        curve = self._ground_rows(h)                     # calibrated shape (may hold NaNs)
        if not np.any(np.isfinite(curve)):
            return None
        with np.errstate(divide="ignore", invalid="ignore"):
            cinv = 1.0 / curve                           # inverse-depth curve
        # Pitch offset from the very-near strip (bottom of the ROI).
        strip = max(1, int(round(cfg.ground_offset_strip_frac * (yb - ya))))
        ys0 = max(ya, yb - strip)
        z = depth_z[ys0:yb, xa:xb]
        sv = valid[ys0:yb, xa:xb] & np.isfinite(z) & (z > 0)
        offset = 0.0
        if np.any(sv):
            rr, cc = np.nonzero(sv)
            cur_inv = cinv[ys0:yb][rr]                   # curve inverse-depth at those rows
            act_inv = 1.0 / z[rr, cc].astype(np.float64)
            g = np.isfinite(cur_inv) & np.isfinite(act_inv)
            if int(np.count_nonzero(g)) >= max(1, int(cfg.ground_offset_min_px)):
                offset = float(np.median(act_inv[g] - cur_inv[g]))
        # Clamp the offset to >= 0: only ever shift the reference NEARER (inverse
        # depth up), never farther. A negative offset (near ground reading farther
        # than the curve — pitch-up, or a curve calibrated nearer than this surface)
        # pushed the reference BEYOND the real ground, so ordinary ground read as
        # "above" it → false positives, and it drove the far rows' inverse depth
        # negative → NaN, disabling person detection there. Shifting only nearer is
        # the safe direction: real ground at or beyond the reference never trips,
        # while an obstacle closer than it still does. (Confirmed on-rover: driving
        # offsets ran -0.2..-0.67, over-correcting.)
        offset = max(0.0, offset)
        self._dbg_offset = offset                        # exposed for field diagnostics
        with np.errstate(divide="ignore", invalid="ignore"):
            corr = cinv + offset                         # shift the whole curve in 1/z
            return np.where(np.isfinite(corr) & (corr > 1e-6), 1.0 / corr, np.nan)

    def _decide_aboveground(self, depth_z, valid, conf=None):
        """Ground-relative detector. Flags valid pixels whose depth is closer than
        the PER-FRAME-estimated ground at their row (protruding ABOVE the ground),
        within the ROI and within max_detect_range_m; morphologically closes the
        (sparse) flags; and trips on any connected cluster whose PHYSICAL size —
        pixel extent × depth / focal length — meets min_obstacle_{w,h}_m. Estimating
        the ground each frame (see _fit_ground_rows) means ordinary ground never
        reads as an obstacle even as the rover pitches, while small obstacles / people
        the band detector's fraction threshold would miss are still caught."""
        cfg = self.cfg
        if conf is not None:
            valid = valid & (conf >= cfg.conf_min)
        h, w = depth_z.shape[:2]
        x0, y0, x1, y1 = cfg.roi
        xa = int(round(np.clip(min(x0, x1), 0.0, 1.0) * w))
        xb = int(round(np.clip(max(x0, x1), 0.0, 1.0) * w))
        ya = int(round(np.clip(min(y0, y1), 0.0, 1.0) * h))
        yb = int(round(np.clip(max(y0, y1), 0.0, 1.0) * h))
        # Ground reference: the calibrated curve SHAPE with a per-frame pitch offset
        # (see _ground_ref). Falls back to the raw curve only if the offset can't be
        # formed; None only when there's no curve at all (gated out upstream).
        gr = self._ground_ref(depth_z, valid, xa, xb, ya, yb, h)
        ground_src = "hybrid" if gr is not None else "static"
        exp = (gr if gr is not None else self._ground_rows(h))[:, None]   # (h,1)
        # A pixel is above-ground when it is closer than its row's ground by more
        # than the margin (grows with range to absorb depth's proportional noise,
        # floored near the rover). NaN rows (unfittable / uncalibrated) never flag.
        thresh = exp - np.maximum(cfg.ground_rel_margin * exp, cfg.ground_abs_margin_m)
        above = (valid & np.isfinite(depth_z) & (depth_z > 0)
                 & (depth_z <= cfg.max_detect_range_m)
                 & np.isfinite(exp) & (depth_z < thresh))
        roi = np.zeros((h, w), dtype=bool)
        roi[ya:yb, xa:xb] = True
        above &= roi
        info = {"enabled": True, "mode": "aboveground", "ground_src": ground_src,
                "above_px": int(np.count_nonzero(above)),
                "offset": round(float(self._dbg_offset), 4)}
        # Cheap driving-triage fields: expected ground vs actual depth at the TOP and
        # BOTTOM of the ROI. A corridor-filling obstacle collapses gnd_top toward
        # act_top (offset dragged near → miss); a pitch/offset error on empty ground
        # shows as gnd < act (reference farther than reality → false positive).
        band = max(1, (yb - ya) // 6)
        for tag, rs in (("top", slice(ya, ya + band)), ("bot", slice(yb - band, yb))):
            e = exp[rs]
            info["gnd_" + tag] = round(float(np.nanmedian(e)), 2) if np.any(np.isfinite(e)) else None
            zc = depth_z[rs, xa:xb]; vc = valid[rs, xa:xb] & np.isfinite(zc)
            info["act_" + tag] = round(float(np.median(zc[vc])), 2) if np.any(vc) else None
        if info["above_px"] < max(1, int(cfg.min_cluster_px)):
            return False, info
        mask = above.astype(np.uint8)
        kk = max(1, int(cfg.aboveground_close_px))
        if kk > 1:
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kk, kk))
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        n, labels, stats, _cent = cv2.connectedComponentsWithStats(mask, 8)
        f_dm = self._f_calib * (w / float(self._calib["image_size"][0]))  # focal @ this res
        best = None
        for i in range(1, n):
            if int(stats[i, cv2.CC_STAT_AREA]) < int(cfg.min_cluster_px):
                continue
            bw = int(stats[i, cv2.CC_STAT_WIDTH])
            bh = int(stats[i, cv2.CC_STAT_HEIGHT])
            comp = (labels == i) & above           # real above-ground pixels, not gap-fill
            zc = depth_z[comp]
            zc = zc[np.isfinite(zc)]
            if zc.size == 0 or f_dm <= 0:
                continue
            zmed = float(np.median(zc))
            real_w = bw * zmed / f_dm
            real_h = bh * zmed / f_dm
            if real_w >= cfg.min_obstacle_w_m and real_h >= cfg.min_obstacle_h_m:
                if best is None or zmed < best["nearest_m"]:
                    best = {"nearest_m": round(zmed, 2),
                            "obstacle_w_m": round(real_w, 2),
                            "obstacle_h_m": round(real_h, 2),
                            "cluster_px": int(zc.size)}
        if best is None:
            return False, info
        info.update(best)
        return True, info

    def detect(self, left, right, scale=1.0):
        """Convenience: compute_depth(scale) + decide, in one call. The node
        computes the shared depth itself and calls decide() directly; this stays
        for standalone / test use. Safe with disabled detector (no frame access)."""
        if not self.enabled:
            return False, {"enabled": False}
        depth_z, valid, conf = self.compute_depth(left, right, scale=scale)
        return self.decide(depth_z, valid, conf)

    def render_composite(self, left, depth_z, valid, conf=None, alpha=0.45):
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

        # Depth → colour with NEAR = warm. WLS has already filled + edge-smoothed
        # the depth (stable, no per-frame shimmer), so just colourise and overlay
        # where the (filled) depth is valid; the sharp base shows through the alpha
        # and through the residual holes (e.g. the left disparity margin).
        near = self.cfg.viz_near_m
        far = max(self.cfg.viz_far_m, near + 0.1)
        norm = np.clip((depth_z - near) / (far - near), 0.0, 1.0)
        heat = cv2.applyColorMap(((1.0 - norm) * 255).astype(np.uint8), cv2.COLORMAP_JET)
        mask = (valid.astype(np.uint8)) * 255
        if (heat.shape[1], heat.shape[0]) != size:
            heat = cv2.resize(heat, size, interpolation=cv2.INTER_LINEAR)
            mask = cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST)
        blended = cv2.addWeighted(base, 1.0 - alpha, heat, alpha, 0.0)
        out = np.ascontiguousarray(np.where((mask > 0)[:, :, None], blended, base))

        # Nearest marker: only HIGH-CONFIDENCE, interior pixels (not WLS-interpolated
        # regions, not the frame border) → the centroid of that nearest region.
        dh, dw = depth_z.shape[:2]
        mgn = min(0.45, max(0.0, self.cfg.viz_edge_margin))
        my, mx = int(dh * mgn), int(dw * mgn)
        nmask = np.zeros(depth_z.shape, dtype=bool)
        nmask[my:dh - my, mx:dw - mx] = True
        nmask &= valid
        if conf is not None:
            nmask &= (conf >= self.cfg.conf_min)
        z, x, y = nearest_point(depth_z, nmask, near, self.cfg.viz_far_m)
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
        depth_z, valid, conf = self.compute_depth(left, right, scale=s)
        return self.render_composite(left, depth_z, valid, conf, alpha=alpha)


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
        _f("OBSTACLE_ROI_X0", 0.30), _f("OBSTACLE_ROI_Y0", 0.44),
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
        wls_lambda=_f("STEREO_WLS_LAMBDA", 8000.0),
        wls_sigma=_f("STEREO_WLS_SIGMA", 1.5),
        conf_min=_i("STEREO_WLS_CONF_MIN", 128),
        detect_mode=(e.get("OBSTACLE_DETECT_MODE") or "aboveground").lower(),
        ground_profile_path=e.get("GROUND_PROFILE_PATH", ""),
        ground_rel_margin=_f("OBSTACLE_GROUND_REL_MARGIN", 0.18),
        ground_abs_margin_m=_f("OBSTACLE_GROUND_ABS_MARGIN_M", 0.12),
        min_obstacle_w_m=_f("OBSTACLE_MIN_W_M", 0.08),
        min_obstacle_h_m=_f("OBSTACLE_MIN_H_M", 0.10),
        aboveground_close_px=_i("OBSTACLE_CLOSE_PX", 5),
        min_cluster_px=_i("OBSTACLE_MIN_CLUSTER_PX", 30),
        max_detect_range_m=_f("OBSTACLE_MAX_RANGE_M", 3.0),
        ground_offset_strip_frac=_f("OBSTACLE_GROUND_OFFSET_STRIP_FRAC", 0.20),
        ground_offset_min_px=_i("OBSTACLE_GROUND_OFFSET_MIN_PX", 60),
    )
