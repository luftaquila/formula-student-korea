"""Tests for the pure (cv2-free) parts of stereo.py: the obstacle decision and
the edge debouncer. The cv2-heavy rectify/disparity path is exercised on the
rover at hardware bring-up, not in CI."""

import numpy as np
import pytest

import stereo  # perception dir is on sys.path when pytest runs from there


# ── obstacle_in_roi ─────────────────────────────────────────────────────────

def _full_roi():
    return (0.0, 0.0, 1.0, 1.0)


def test_no_obstacle_when_corridor_is_far():
    depth = np.full((100, 100), 10.0, np.float32)   # all 10 m (far background)
    valid = np.ones((100, 100), bool)
    obstacle, fill, near, vc = stereo.obstacle_in_roi(
        depth, valid, _full_roi(), near_m=0.4, far_m=2.5,
        min_fill=0.12, min_valid_px=400)
    assert obstacle is False
    assert near == 0
    assert vc == 10000


def test_obstacle_when_enough_corridor_pixels_in_band():
    depth = np.full((100, 100), 10.0, np.float32)
    depth[50:90, 30:70] = 1.0                        # 1600 px at 1.0 m (in band)
    valid = np.ones((100, 100), bool)
    obstacle, fill, near, vc = stereo.obstacle_in_roi(
        depth, valid, _full_roi(), near_m=0.4, far_m=2.5,
        min_fill=0.12, min_valid_px=400)
    assert obstacle is True
    assert near == 1600
    assert fill == pytest.approx(0.16, abs=1e-6)


def test_below_min_fill_is_not_obstacle():
    depth = np.full((100, 100), 10.0, np.float32)
    depth[0:10, 0:50] = 1.0                          # 500 px in band → fill 0.05
    valid = np.ones((100, 100), bool)
    obstacle, fill, near, vc = stereo.obstacle_in_roi(
        depth, valid, _full_roi(), near_m=0.4, far_m=2.5,
        min_fill=0.12, min_valid_px=400)
    assert obstacle is False
    assert fill == pytest.approx(0.05, abs=1e-6)


def test_min_valid_px_floor_rejects_sparse_corridor():
    # Everything in-band, but only 100 valid pixels — too textureless/dark to
    # trust, so report no obstacle rather than trip on speckle.
    depth = np.full((100, 100), 1.0, np.float32)
    valid = np.zeros((100, 100), bool)
    valid[0:10, 0:10] = True                         # 100 valid px
    obstacle, fill, near, vc = stereo.obstacle_in_roi(
        depth, valid, _full_roi(), near_m=0.4, far_m=2.5,
        min_fill=0.12, min_valid_px=400)
    assert obstacle is False
    assert vc == 100


def test_min_valid_px_zero_empty_corridor_no_divide_by_zero():
    # min_valid_px=0 + a corridor with zero valid pixels must NOT raise
    # ZeroDivisionError on fill = near_count / valid_count.
    depth = np.full((100, 100), 1.0, np.float32)
    valid = np.zeros((100, 100), bool)            # nothing matched
    obstacle, fill, near, vc = stereo.obstacle_in_roi(
        depth, valid, _full_roi(), near_m=0.4, far_m=2.5,
        min_fill=0.12, min_valid_px=0)
    assert obstacle is False
    assert vc == 0
    assert fill == 0.0


def test_near_clip_excludes_too_close():
    # Pixels closer than near_m are lens-edge noise / the rover's own nose, not
    # an obstacle ahead — they must not count.
    depth = np.full((100, 100), 0.2, np.float32)     # all 0.2 m < near 0.4
    valid = np.ones((100, 100), bool)
    obstacle, fill, near, vc = stereo.obstacle_in_roi(
        depth, valid, _full_roi(), near_m=0.4, far_m=2.5,
        min_fill=0.12, min_valid_px=400)
    assert obstacle is False
    assert near == 0


def test_roi_restricts_region():
    # A close blob OUTSIDE the corridor ROI must not trip detection.
    depth = np.full((100, 100), 10.0, np.float32)
    depth[0:40, 0:40] = 1.0                          # top-left, outside corridor
    valid = np.ones((100, 100), bool)
    roi = (0.3, 0.55, 0.7, 0.98)                      # lower-centre corridor
    obstacle, fill, near, vc = stereo.obstacle_in_roi(
        depth, valid, roi, near_m=0.4, far_m=2.5,
        min_fill=0.12, min_valid_px=400)
    assert obstacle is False
    assert near == 0


def test_reversed_roi_fractions_are_ordered():
    # A mis-ordered ROI (x1<x0) must not index backwards into an empty slice; it
    # should behave like the same rectangle written the right way round.
    depth = np.full((100, 100), 1.0, np.float32)
    valid = np.ones((100, 100), bool)
    forward = stereo.obstacle_in_roi(
        depth, valid, (0.2, 0.2, 0.8, 0.8), 0.4, 2.5, 0.12, 100)
    reversed_ = stereo.obstacle_in_roi(
        depth, valid, (0.8, 0.8, 0.2, 0.2), 0.4, 2.5, 0.12, 100)
    assert forward == reversed_
    assert forward[0] is True


# ── EdgeDebouncer ───────────────────────────────────────────────────────────

def test_debouncer_asserts_after_on_frames():
    d = stereo.EdgeDebouncer(on_frames=3, off_frames=2)
    assert d.update(True) == (False, False)
    assert d.update(True) == (False, False)
    assert d.update(True) == (True, True)            # 3rd consecutive → rising
    assert d.update(True) == (True, False)           # stays asserted, no edge


def test_debouncer_present_run_resets_on_clear():
    d = stereo.EdgeDebouncer(on_frames=3, off_frames=2)
    d.update(True)
    d.update(True)
    d.update(False)                                  # interrupts the run
    assert d.update(True) == (False, False)          # run restarts from 1
    assert d.update(True) == (False, False)
    assert d.update(True) == (True, True)


def test_debouncer_releases_after_off_frames():
    d = stereo.EdgeDebouncer(on_frames=1, off_frames=2)
    assert d.update(True) == (True, True)
    assert d.update(False) == (True, False)          # 1 clear — still held
    assert d.update(False) == (False, False)         # 2nd clear → released


def test_detector_disabled_without_calibration():
    # No calibration file (or no cv2) → detector disabled, and detect() returns
    # "no obstacle" for any left/right pair without touching the frames, so a
    # missing calibration can never auto-pause a mission.
    d = stereo.StereoDepth(stereo.StereoConfig(calib_path="/no/such/calib.npz"))
    assert d.enabled is False
    assert d.detect(None, None) == (False, {"enabled": False})


def test_debouncer_reset_fully_clears_state_and_runs():
    # reset() must drop the asserted state too, so a debouncer that was asserted
    # when detection paused does not re-fire on reactivation with a clear view.
    d = stereo.EdgeDebouncer(on_frames=1, off_frames=5)
    assert d.update(True) == (True, True)            # asserted
    d.reset()
    # After reset: asserted state gone, runs gone. A clear reading stays clear
    # (no spurious re-assert), and re-asserting takes a fresh rising edge.
    assert d.update(False) == (False, False)
    assert d.update(True) == (True, True)


# ── split_sbs (sbs layout) ──────────────────────────────────────────────────

def test_split_sbs_halves():
    frame = np.zeros((10, 20, 3), np.uint8)
    frame[:, 10:, :] = 255                      # right half white, left black
    left, right = stereo.split_sbs(frame)
    assert left.shape == (10, 10, 3)
    assert right.shape == (10, 10, 3)
    assert int(left.max()) == 0
    assert int(right.min()) == 255


def test_split_sbs_odd_width_drops_last_column():
    # half*2 bound: an odd-width frame yields two equal halves, last column dropped.
    frame = np.zeros((4, 21, 3), np.uint8)
    left, right = stereo.split_sbs(frame)
    assert left.shape[1] == 10 and right.shape[1] == 10


# ── config_from_env ─────────────────────────────────────────────────────────

def test_config_from_env_parses_overrides():
    cfg = stereo.config_from_env({
        "STEREO_NUM_DISPARITIES": "128",
        "OBSTACLE_NEAR_M": "0.5",
        "OBSTACLE_ROI_X0": "0.1", "OBSTACLE_ROI_Y0": "0.2",
        "OBSTACLE_ROI_X1": "0.9", "OBSTACLE_ROI_Y1": "0.95",
        "OBSTACLE_MIN_VALID_PX": "bad",         # invalid → falls back to default
    })
    assert cfg.num_disparities == 128
    assert cfg.near_m == 0.5
    assert cfg.roi == (0.1, 0.2, 0.9, 0.95)
    assert cfg.min_valid_px == 400              # invalid value → default


def test_config_from_env_defaults_on_empty():
    cfg = stereo.config_from_env({})
    assert cfg.num_disparities == 96
    assert cfg.near_m == 0.4
    assert cfg.far_m == 2.5
    assert cfg.roi == (0.30, 0.55, 0.70, 0.98)
    assert cfg.sgbm_mode == "sgbm"          # full SGBM (clean); affordable at 512, shared by detection + composite
    assert cfg.viz_near_m == 0.3
    assert cfg.viz_far_m == 5.0
    assert cfg.viz_depth_scale == 0.4       # depth at 0.4× base (512×288 from 720p)
    assert cfg.speckle_filter_size == 200
    assert cfg.viz_edge_margin == 0.05


def test_config_from_env_parses_sgbm_mode_and_viz():
    cfg = stereo.config_from_env({
        "STEREO_SGBM_MODE": "SGBM", "VIZ_NEAR_M": "0.5", "VIZ_FAR_M": "8"})
    assert cfg.sgbm_mode == "sgbm"          # normalised to lower-case
    assert cfg.viz_near_m == 0.5
    assert cfg.viz_far_m == 8.0


# ── nearest_point (whole-frame live-view marker) ─────────────────────────────

def test_nearest_point_finds_global_min():
    depth = np.full((20, 30), 5.0, np.float32)
    depth[7, 12] = 1.5                       # the single closest valid pixel
    valid = np.ones((20, 30), bool)
    z, x, y = stereo.nearest_point(depth, valid, near_m=0.3)
    assert (x, y) == (12, 7)
    assert z == pytest.approx(1.5)


def test_nearest_point_near_clip_excludes_speckle():
    # A sub-decimetre lens-edge speckle must not be reported as the nearest.
    depth = np.full((10, 10), 2.0, np.float32)
    depth[0, 0] = 0.05                        # below the near clip
    valid = np.ones((10, 10), bool)
    z, x, y = stereo.nearest_point(depth, valid, near_m=0.3)
    assert z == pytest.approx(2.0)
    assert (x, y) != (0, 0)


def test_nearest_point_far_clip_excludes_background():
    depth = np.full((10, 10), 50.0, np.float32)
    depth[5, 5] = 3.0
    valid = np.ones((10, 10), bool)
    z, _, _ = stereo.nearest_point(depth, valid, near_m=0.3, far_m=5.0)
    assert z == pytest.approx(3.0)


def test_nearest_point_none_when_nothing_valid():
    depth = np.full((10, 10), 2.0, np.float32)
    valid = np.zeros((10, 10), bool)
    z, x, y = stereo.nearest_point(depth, valid, near_m=0.3)
    assert z != z                            # NaN
    assert (x, y) == (-1, -1)


def test_nearest_point_ignores_invalid_closer_pixel():
    depth = np.full((10, 10), 2.0, np.float32)
    depth[1, 1] = 0.5                        # closer, but its match is invalid
    valid = np.ones((10, 10), bool)
    valid[1, 1] = False
    z, x, y = stereo.nearest_point(depth, valid, near_m=0.3)
    assert z == pytest.approx(2.0)
    assert (x, y) != (1, 1)


# ── read_stereo_pair (grab/grab → retrieve/retrieve sync) ────────────────────

class _FakeCap:
    """Minimal cv2.VideoCapture stand-in that records grab()/retrieve() order."""
    def __init__(self, name, calls, frame=None, grab_ok=True, retrieve_ok=True):
        self.name = name
        self.calls = calls
        self.frame = frame
        self.grab_ok = grab_ok
        self.retrieve_ok = retrieve_ok

    def grab(self):
        self.calls.append(f"{self.name}.grab")
        return self.grab_ok

    def retrieve(self):
        self.calls.append(f"{self.name}.retrieve")
        return (self.retrieve_ok and self.frame is not None), self.frame


def test_read_stereo_pair_grabs_both_before_either_retrieve():
    # The whole point of grab×2 → retrieve×2 is to pin the two eyes' capture
    # instants together: BOTH grabs must fire before EITHER decode.
    calls = []
    lf = np.zeros((4, 4, 3), np.uint8)
    rf = np.ones((4, 4, 3), np.uint8)
    left, right = stereo.read_stereo_pair(
        _FakeCap("L", calls, frame=lf), _FakeCap("R", calls, frame=rf))
    assert left is lf and right is rf
    assert calls == ["L.grab", "R.grab", "L.retrieve", "R.retrieve"]


def test_read_stereo_pair_none_on_grab_miss():
    calls = []
    assert stereo.read_stereo_pair(
        _FakeCap("L", calls, frame=np.zeros((4, 4, 3), np.uint8), grab_ok=False),
        _FakeCap("R", calls, frame=np.zeros((4, 4, 3), np.uint8))) is None


def test_read_stereo_pair_none_on_retrieve_miss():
    calls = []
    assert stereo.read_stereo_pair(
        _FakeCap("L", calls, frame=np.zeros((4, 4, 3), np.uint8)),
        _FakeCap("R", calls, frame=None)) is None   # right eye yields no frame


# ── select_inlier_pairs (temporal-desync outlier culling) ────────────────────

def test_select_inlier_pairs_keeps_all_when_uniformly_good():
    errs = [0.30, 0.40, 0.35, 0.50, 0.42, 0.38, 0.31, 0.29, 0.40, 0.33]
    assert stereo.select_inlier_pairs(errs) == list(range(len(errs)))


def test_select_inlier_pairs_drops_clear_outlier():
    # idx 8 is a lone desync pair — large in absolute terms AND vs the pack.
    errs = [0.30, 0.40, 0.35, 0.50, 0.42, 0.38, 0.31, 0.29, 3.20, 0.33]
    assert stereo.select_inlier_pairs(errs) == [0, 1, 2, 3, 4, 5, 6, 7, 9]


def test_select_inlier_pairs_keeps_uniformly_mediocre():
    # Every pair is above abs_max_px but none stands out from the median, so
    # there is no outlier to cull (needs BOTH absolute and relative badness).
    errs = [2.0, 2.1, 1.9, 2.2, 2.0, 1.8, 2.05, 2.1, 1.95, 2.0]
    assert stereo.select_inlier_pairs(errs) == list(range(len(errs)))


def test_select_inlier_pairs_respects_keep_min_floor():
    # A slim good majority (6) keeps the median low, so the 4 clear outliers
    # would cull down to 6 — below keep_min(8). The floor keeps the 8
    # lowest-error pairs instead of dropping below a solvable count.
    errs = [0.30, 0.32, 0.34, 0.36, 0.38, 0.40, 5.0, 6.0, 7.0, 8.0]
    assert stereo.select_inlier_pairs(errs, keep_min=8) == [0, 1, 2, 3, 4, 5, 6, 7]


def test_select_inlier_pairs_empty():
    assert stereo.select_inlier_pairs([]) == []


# ── compute_stereo_calibration two-pass solve (needs cv2) ────────────────────

def _project(cv2, objp, rvec, tvec, K):
    pts, _ = cv2.projectPoints(np.asarray(objp, np.float64),
                               np.asarray(rvec, np.float64),
                               np.asarray(tvec, np.float64), K, None)
    return pts.reshape(-1, 1, 2).astype(np.float32)


def _synth_board_views(cv2):
    """Synthetic dual-eye checkerboard views: 12 diverse board poses projected
    into two ideal cameras 60 mm apart (zero distortion). Returns
    (objpoints, imgL, imgR, poses, K, R_true, T_true, size)."""
    W, H = 1280, 720
    K = np.array([[900., 0, W / 2], [0, 900., H / 2], [0, 0, 1.]])
    objp = stereo.board_object_points(9, 6, 0.025)   # planar (Z=0), 54 corners
    R_true = np.eye(3)
    T_true = np.array([[-0.06], [0.], [0.]])          # 60 mm horizontal baseline
    tilts = [
        (0.00, 0.00, 0.35), (0.20, -0.10, 0.40), (-0.15, 0.20, 0.45),
        (0.10, 0.25, 0.50), (-0.20, -0.20, 0.42), (0.25, 0.10, 0.38),
        (-0.10, -0.15, 0.55), (0.18, 0.22, 0.48), (-0.22, 0.12, 0.36),
        (0.05, -0.25, 0.52), (0.15, 0.05, 0.44), (-0.12, -0.08, 0.39),
    ]
    objpoints, imgL, imgR, poses = [], [], [], []
    for rx, ry, z in tilts:
        rvec = np.array([rx, ry, 0.0]).reshape(3, 1)       # board→left rotation vector
        tvec = np.array([-0.10, -0.06, z]).reshape(3, 1)   # centre the board
        rot_l = cv2.Rodrigues(rvec)[0]                     # 3x3
        rvec_r = cv2.Rodrigues(R_true @ rot_l)[0]          # board→right rotation vector
        tvec_r = R_true @ tvec + T_true
        objpoints.append(objp.copy())
        imgL.append(_project(cv2, objp, rvec, tvec, K))
        imgR.append(_project(cv2, objp, rvec_r, tvec_r, K))
        poses.append((rvec, tvec))
    return objpoints, imgL, imgR, poses, K, R_true, T_true, (W, H)


def test_compute_stereo_calibration_clean_set_uses_all_pairs():
    cv2 = pytest.importorskip("cv2")
    objpoints, imgL, imgR, _, _, _, _, size = _synth_board_views(cv2)
    r = stereo.compute_stereo_calibration(objpoints, imgL, imgR, size)
    assert r["pairs_used"] == r["pairs_total"] == len(objpoints)   # nothing culled
    assert r["stereo_rms"] < 1.0
    assert r["baseline_m"] == pytest.approx(0.06, abs=3e-3)


def test_compute_stereo_calibration_culls_desync_pair():
    cv2 = pytest.importorskip("cv2")
    objpoints, imgL, imgR, poses, K, R_true, T_true, size = _synth_board_views(cv2)
    # Inject a desynced pair: LEFT from pose 0, but RIGHT from a board that has
    # rotated + shifted (as if it moved between the two eyes' captures). Each
    # eye alone is a valid board view, so intrinsics/per-eye RMS are fine, but
    # the pair violates the shared rigid geometry — it must be culled.
    rvec0, tvec0 = poses[0]
    extra = cv2.Rodrigues(np.array([0.15, 0.15, 0.0]).reshape(3, 1))[0]
    rot_moved = cv2.Rodrigues(rvec0)[0] @ extra
    moved_t = tvec0 + np.array([0.03, 0.02, 0.0]).reshape(3, 1)
    objpoints.append(objpoints[0].copy())
    imgL.append(_project(cv2, objpoints[0], rvec0, tvec0, K))         # left = original pose
    imgR.append(_project(cv2, objpoints[0], cv2.Rodrigues(R_true @ rot_moved)[0],
                         R_true @ moved_t + T_true, K))               # right = moved pose
    r = stereo.compute_stereo_calibration(objpoints, imgL, imgR, size)
    assert r["pairs_total"] == len(objpoints)
    assert r["pairs_used"] < r["pairs_total"]        # the desync pair was dropped
    assert r["stereo_rms"] < 1.0                     # re-solve stays sharp
    assert r["baseline_m"] == pytest.approx(0.06, abs=5e-3)


# ── compute_composite (live-view render; needs cv2 + a loaded calibration) ────

def test_compute_composite_renders_and_reports(tmp_path):
    cv2 = pytest.importorskip("cv2")
    objpoints, imgL, imgR, _, _, _, _, size = _synth_board_views(cv2)
    result = stereo.compute_stereo_calibration(objpoints, imgL, imgR, size)
    calib_path = str(tmp_path / "calib.npz")
    stereo.save_calibration(calib_path, result, 0.025)
    det = stereo.StereoDepth(stereo.StereoConfig(calib_path=calib_path))
    assert det.enabled is True
    assert det._mode == cv2.STEREO_SGBM_MODE_SGBM        # full SGBM (clean) at 512

    W, H = size
    rng = np.random.default_rng(0)
    left = rng.integers(0, 255, (H, W, 3), dtype=np.uint8)
    right = rng.integers(0, 255, (H, W, 3), dtype=np.uint8)

    # depth_scale<1 renders the sharp base at the full calib size while running
    # SGBM on a downscaled copy — output is still the full base resolution.
    out, info = det.compute_composite(left, right, depth_scale=0.4)
    assert out.shape == (H, W, 3)            # base = rectified left at calib size
    assert out.dtype == np.uint8
    assert info["enabled"] is True
    assert "nearest_m" in info               # float or None, both acceptable

    # full-resolution depth (scale 1.0) also returns the base-sized composite
    out2, _ = det.compute_composite(left, right, depth_scale=1.0)
    assert out2.shape == (H, W, 3)
    # a matcher sized for the downscaled resolution is cached for reuse
    assert det._viz_matchers                 # populated by the 0.4-scale call

    # Shared-pass decomposition: one downscaled depth feeds BOTH detection (decide)
    # and the composite (render_composite) — no second SGBM.
    depth_z, valid = det.compute_depth(left, right, scale=0.4)
    assert depth_z.shape == (H * 2 // 5, W * 2 // 5)  # 0.4× calib (512×288 from 720p)
    obstacle, dinfo = det.decide(depth_z, valid)
    assert dinfo["enabled"] is True and isinstance(obstacle, bool)
    rout, rinfo = det.render_composite(left, depth_z, valid)
    assert rout.shape == (H, W, 3) and rinfo["enabled"] is True


def test_compute_composite_disabled_without_calibration():
    # No calibration → returns no image and enabled=False, so the caller falls
    # back to the plain single-eye stream instead of rendering garbage.
    det = stereo.StereoDepth(stereo.StereoConfig(calib_path="/no/such.npz"))
    out, info = det.compute_composite(None, None)
    assert out is None
    assert info == {"enabled": False}
