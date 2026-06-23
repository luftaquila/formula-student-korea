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
from dataclasses import dataclass, field

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


def compute_stereo_calibration(objpoints, imgL, imgR, eye_size):
    """Per-eye intrinsics, then stereo extrinsics + rectification maps + Q.

    eye_size is (width, height). Returns a dict with the rectify maps, Q,
    image_size, recovered baseline (m), and RMS errors (px).
    """
    rms_l, K1, D1, _, _ = cv2.calibrateCamera(objpoints, imgL, eye_size, None, None)
    rms_r, K2, D2, _, _ = cv2.calibrateCamera(objpoints, imgR, eye_size, None, None)
    stereo_rms, K1, D1, K2, D2, R, T, _, _ = cv2.stereoCalibrate(
        objpoints, imgL, imgR, K1, D1, K2, D2, eye_size,
        criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 1e-5),
        flags=cv2.CALIB_FIX_INTRINSIC,
    )
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
        bs = int(cfg.block_size) | 1  # force odd
        # P1/P2 are the SGBM smoothness penalties; OpenCV's documented defaults
        # scale with block area for a single-channel (grayscale) match.
        self._matcher = cv2.StereoSGBM_create(
            minDisparity=0,
            numDisparities=nd,
            blockSize=bs,
            P1=8 * bs * bs,
            P2=32 * bs * bs,
            disp12MaxDiff=1,
            uniquenessRatio=int(cfg.uniqueness),
            speckleWindowSize=int(cfg.speckle_window),
            speckleRange=int(cfg.speckle_range),
            mode=cv2.STEREO_SGBM_MODE_SGBM,
        )
        self.enabled = True

    def _prep_eye(self, eye, map_x, map_y, size):
        """Resize an eye to the calibrated size, rectify, return grayscale."""
        if (eye.shape[1], eye.shape[0]) != size:
            eye = cv2.resize(eye, size, interpolation=cv2.INTER_AREA)
        rect = cv2.remap(eye, map_x, map_y, cv2.INTER_LINEAR)
        if rect.ndim == 3:
            rect = cv2.cvtColor(rect, cv2.COLOR_BGR2GRAY)
        return rect

    def compute_depth(self, left, right):
        """Left + right eye frames → (depth_z metres, valid mask). None if disabled."""
        if not self.enabled:
            return None
        c = self._calib
        size = c["image_size"]
        gl = self._prep_eye(left, c["map1x"], c["map1y"], size)
        gr = self._prep_eye(right, c["map2x"], c["map2y"], size)
        # StereoSGBM returns fixed-point disparity (×16) as int16.
        disp = self._matcher.compute(gl, gr).astype(np.float32) / 16.0
        # Disparities at/below 0 never matched (or fell in the left margin where
        # the right image has no overlap) — exclude them from depth.
        valid = disp > 0.0
        points = cv2.reprojectImageTo3D(disp, c["Q"])
        depth_z = points[:, :, 2]
        # reprojectImageTo3D emits huge/!finite Z where disparity ~0; mask those
        # out so they can't masquerade as far background.
        valid &= np.isfinite(depth_z)
        return depth_z, valid

    def detect(self, left, right):
        """Left + right eye frames → (obstacle: bool, info: dict).

        info always carries 'enabled'; when enabled it adds fill / counts /
        nearest-corridor-depth for logging + the operator alert payload.
        """
        if not self.enabled:
            return False, {"enabled": False}
        depth_z, valid = self.compute_depth(left, right)
        cfg = self.cfg
        obstacle, fill, near_count, valid_count = obstacle_in_roi(
            depth_z, valid, cfg.roi, cfg.near_m, cfg.far_m,
            cfg.min_fill, cfg.min_valid_px,
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
    )
