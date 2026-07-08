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
    assert cfg.roi == (0.30, 0.44, 0.70, 0.98)   # y0 raised to catch obstacles further ahead
    assert cfg.sgbm_mode == "sgbm"          # full SGBM (clean); affordable at 512, shared by detection + composite
    assert cfg.viz_near_m == 0.3
    assert cfg.viz_far_m == 5.0
    assert cfg.viz_depth_scale == 0.4       # depth at 0.4× base (512×288 from 720p)
    assert cfg.speckle_filter_size == 200
    assert cfg.viz_edge_margin == 0.05
    assert cfg.wls_lambda == 8000.0
    assert cfg.wls_sigma == 1.5
    assert cfg.conf_min == 128
    assert cfg.detect_mode == "aboveground"
    assert cfg.max_detect_range_m == 3.0
    assert cfg.min_obstacle_w_m == 0.08 and cfg.min_obstacle_h_m == 0.10


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


def test_nearest_point_marks_region_centroid_not_top():
    # A large equidepth near region ties at the minimum; the marker must land on
    # the region's CENTROID, not (as argmin would) its top-left-most pixel.
    depth = np.full((20, 20), 5.0, np.float32)
    depth[8:14, 6:12] = 1.0                  # 6×6 near block, all equal depth
    valid = np.ones((20, 20), bool)
    z, x, y = stereo.nearest_point(depth, valid, near_m=0.3)
    assert z == pytest.approx(1.0)
    assert 9 <= y <= 12                      # centroid (~10.5), not the top row (8)
    assert 7 <= x <= 10                      # centroid (~8.5)


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

    # Shared-pass decomposition: one downscaled depth (+ optional WLS confidence)
    # feeds BOTH detection (decide) and the composite (render_composite) — no
    # second SGBM. conf is a map when ximgproc/WLS is present, else None.
    depth_z, valid, conf = det.compute_depth(left, right, scale=0.4)
    assert depth_z.shape == (H * 2 // 5, W * 2 // 5)  # 0.4× calib (512×288 from 720p)
    assert conf is None or conf.shape == depth_z.shape
    obstacle, dinfo = det.decide(depth_z, valid, conf)
    assert dinfo["enabled"] is True and isinstance(obstacle, bool)
    rout, rinfo = det.render_composite(left, depth_z, valid, conf)
    assert rout.shape == (H, W, 3) and rinfo["enabled"] is True


def test_compute_composite_disabled_without_calibration():
    # No calibration → returns no image and enabled=False, so the caller falls
    # back to the plain single-eye stream instead of rendering garbage.
    det = stereo.StereoDepth(stereo.StereoConfig(calib_path="/no/such.npz"))
    out, info = det.compute_composite(None, None)
    assert out is None
    assert info == {"enabled": False}


# ── ground profile helpers (cv2-free) ───────────────────────────────────────

def test_default_ground_path():
    assert stereo.default_ground_path("/a/b/stereo_calib.npz") == "/a/b/stereo_calib_ground.npz"
    assert stereo.default_ground_path("/a/b/calib") == "/a/b/calib_ground.npz"
    assert stereo.default_ground_path("") == ""


def test_fit_ground_profile_sorts_and_drops_invalid():
    rf = [0.9, 0.1, 0.5, 0.3]
    dm = [1.0, 3.0, np.nan, 2.0]              # the 0.5 sample (NaN depth) is dropped
    orf, odm = stereo.fit_ground_profile(rf, dm)
    assert list(orf) == [0.1, 0.3, 0.9]        # ascending, NaN removed
    assert list(odm) == [3.0, 2.0, 1.0]        # already non-increasing


def test_fit_ground_profile_enforces_non_increasing():
    # Anchored from the reliable near (bottom) end: a mid/far bin that violates the
    # non-increasing trend is clamped toward the FAR side, never letting the curve
    # claim the ground gets nearer than a lower row.
    orf, odm = stereo.fit_ground_profile([0.1, 0.2, 0.3], [2.0, 2.5, 1.0])
    assert list(odm) == [2.5, 2.5, 1.0]
    assert all(a >= b for a, b in zip(odm, odm[1:]))   # non-increasing


def test_fit_ground_profile_near_outlier_at_far_bin_does_not_collapse_curve():
    # SAFETY regression: a single spuriously-near reading at a top (far, least-reliable)
    # bin must NOT drag the whole curve down — that collapse silently blinds the
    # above-ground detector (thresh becomes ~near-clip → real obstacles never flagged).
    # Bottom-anchored fit clamps the bad far bin UP and preserves the reliable near rows.
    rf = np.linspace(0.05, 0.95, 10)
    dm = np.array([0.5, 3.6, 3.2, 2.8, 2.4, 2.0, 1.6, 1.4, 1.2, 1.0])   # only bin0 is bad
    _orf, odm = stereo.fit_ground_profile(rf, dm)
    assert odm[0] == 3.6                       # bad far bin clamped up to the trend
    assert odm[-1] == 1.0                      # near rows preserved
    assert float(odm.min()) == 1.0             # NOT collapsed to 0.5
    assert all(a >= b for a, b in zip(odm, odm[1:]))


def test_ground_depth_for_rows_interpolates_and_nans_outside():
    profile = {"row_frac": np.array([0.2, 0.8]), "depth_m": np.array([3.0, 1.0])}
    out = stereo.ground_depth_for_rows(profile, 10)
    assert np.isnan(out[0])                    # ys=0.05 is below the calibrated range
    assert np.isnan(out[-1])                   # ys=0.95 is above it
    assert out[4] == pytest.approx(2.17, abs=0.05)  # ys≈0.45 → interp of 3 m and 1 m


def test_ground_profile_save_load_roundtrip(tmp_path):
    p = str(tmp_path / "g.npz")
    stereo.save_ground_profile(p, [0.1, 0.5, 0.9], [3.0, 2.0, 1.0])
    prof = stereo.load_ground_profile(p)
    assert prof is not None
    assert np.allclose(prof["row_frac"], [0.1, 0.5, 0.9])
    assert np.allclose(prof["depth_m"], [3.0, 2.0, 1.0])


def test_ground_row_medians_bins_by_row():
    depth = np.zeros((40, 40), np.float32)
    depth[:20, :] = 3.0                          # top half far
    depth[20:, :] = 1.0                          # bottom half near
    valid = np.ones((40, 40), bool)
    rf, dm = stereo.ground_row_medians(depth, valid, 0.0, 1.0, 4)
    assert list(rf) == [0.125, 0.375, 0.625, 0.875]
    assert list(dm) == [3.0, 3.0, 1.0, 1.0]      # bins recede top→bottom


def test_ground_row_medians_nan_without_valid_pixels():
    depth = np.ones((20, 20), np.float32)
    rf, dm = stereo.ground_row_medians(depth, np.zeros((20, 20), bool), 0.0, 1.0, 5)
    assert np.all(np.isnan(dm))


def test_ground_row_medians_respects_x_band():
    depth = np.full((20, 20), 5.0, np.float32)
    depth[:, :6] = 1.0                           # only the left edge is near
    valid = np.ones((20, 20), bool)
    _rf, dm = stereo.ground_row_medians(depth, valid, 0.5, 1.0, 2)   # sample right half only
    assert list(dm) == [5.0, 5.0]                # the near left edge is outside the band


def test_load_ground_profile_missing_returns_none():
    assert stereo.load_ground_profile("/no/such_ground.npz") is None


def test_load_ground_profile_empty_or_corrupt_returns_none(tmp_path):
    # A 0-byte or garbage file must NOT crash the detector (np.load raises
    # EOFError/other) — it returns None so detection falls back to band mode.
    empty = tmp_path / "empty_ground.npz"
    empty.write_bytes(b"")
    assert stereo.load_ground_profile(str(empty)) is None
    junk = tmp_path / "junk_ground.npz"
    junk.write_bytes(b"not an npz archive")
    assert stereo.load_ground_profile(str(junk)) is None


# ── above-ground detector (needs cv2 for connected components) ───────────────

def _aboveground_detector(f_calib, calib_w, calib_h, cfg=None, profile=None):
    """A StereoDepth with just the state _decide_aboveground needs, bypassing the
    calibration-loading __init__. Above-ground uses the calibrated curve's SHAPE, so
    a profile is required (the per-frame part is only a pitch offset)."""
    det = object.__new__(stereo.StereoDepth)
    det.cfg = cfg or stereo.StereoConfig()
    det._calib = {"image_size": (calib_w, calib_h)}
    det._f_calib = float(f_calib)
    det._ground = profile
    det._ground_rows_cache = {}
    det.detect_mode = "aboveground"
    det.enabled = True
    return det


def _curve_and_plane(H, W, z_far, z_near, ya_frac=0.44, yb_frac=0.98):
    """A calibrated ground curve (profile) + a matching flat-ground depth image, built
    so the ground is z_far at the ROI top and z_near at the ROI bottom — inverse-depth
    linear in row, as a real ground plane is."""
    ya, yb = ya_frac * (H - 1), yb_frac * (H - 1)
    inv_far, inv_near = 1.0 / z_far, 1.0 / z_near
    rows = np.arange(H, dtype=np.float64)
    inv = np.clip(inv_far + (inv_near - inv_far) * (rows - ya) / (yb - ya), 1e-3, None)
    z = 1.0 / inv
    profile = {"row_frac": ((np.arange(H) + 0.5) / H).astype(np.float64),
               "depth_m": z.astype(np.float64)}
    depth = np.tile(z[:, None], (1, W)).astype(np.float32)
    return profile, depth


def test_aboveground_ignores_flat_ground():
    pytest.importorskip("cv2")
    H, W = 120, 120
    profile, depth = _curve_and_plane(H, W, z_far=8.0, z_near=1.0)
    det = _aboveground_detector(100.0, W, H, profile=profile)
    obstacle, info = det._decide_aboveground(depth, np.ones((H, W), bool), None)
    assert obstacle is False                    # flat ground is NEVER an obstacle…
    assert info["mode"] == "aboveground" and info["ground_src"] == "hybrid"
    assert info["above_px"] == 0                # …the curve (offset ~0) matches it


def test_aboveground_detects_small_obstacle():
    pytest.importorskip("cv2")
    H, W = 120, 120
    profile, depth = _curve_and_plane(H, W, z_far=8.0, z_near=1.0)
    depth[70:92, 52:74] = 0.6                   # 22×22 px, 0.6 m — well above the ground
    det = _aboveground_detector(100.0, W, H, profile=profile)
    obstacle, info = det._decide_aboveground(depth, np.ones((H, W), bool), None)
    assert obstacle is True                     # a SMALL object the band detector would miss
    assert info["nearest_m"] == pytest.approx(0.6, abs=0.05)
    assert info["obstacle_w_m"] >= 0.08 and info["obstacle_h_m"] >= 0.10


def test_aboveground_detects_obstacle_filling_corridor():
    # THE KEY FIX: an obstacle (person/wall) filling the mid/upper corridor at a near,
    # roughly-constant depth. The calibrated SHAPE says those rows are FAR, so the near
    # obstacle reads as protruding and is flagged — whereas a fully-adaptive per-frame
    # fit would lock onto the obstacle as "ground" and miss it (the field symptom).
    pytest.importorskip("cv2")
    H, W = 120, 120
    profile, depth = _curve_and_plane(H, W, z_far=8.0, z_near=1.0)
    depth[30:85, 40:82] = 1.25                  # person filling the corridor at 1.25 m
    det = _aboveground_detector(100.0, W, H, profile=profile)
    obstacle, info = det._decide_aboveground(depth, np.ones((H, W), bool), None)
    assert obstacle is True
    assert info["ground_src"] == "hybrid"
    assert info["nearest_m"] == pytest.approx(1.25, abs=0.15)


def test_aboveground_ignores_speckle_below_physical_size():
    pytest.importorskip("cv2")
    H, W = 120, 120
    profile, depth = _curve_and_plane(H, W, z_far=8.0, z_near=1.0)
    depth[70:73, 60:63] = 0.5                    # 3×3 px speck — too small to be real
    det = _aboveground_detector(100.0, W, H, profile=profile)
    assert det._decide_aboveground(depth, np.ones((H, W), bool), None)[0] is False


def test_aboveground_adapts_to_rover_pitch():
    # THE OTHER FIX: flat ground uniformly NEARER than the calibrated curve (rover
    # nosed down / a different surface). The per-frame pitch offset from the near strip
    # shifts the whole curve to match, so flat ground never false-trips.
    pytest.importorskip("cv2")
    H, W = 120, 120
    profile, _flat = _curve_and_plane(H, W, z_far=8.0, z_near=1.0)
    exp = stereo.ground_depth_for_rows(profile, H)
    depth = np.tile((1.0 / (1.0 / exp + 0.25))[:, None], (1, W)).astype(np.float32)  # all nearer
    det = _aboveground_detector(100.0, W, H, profile=profile)
    obstacle, info = det._decide_aboveground(depth, np.ones((H, W), bool), None)
    assert obstacle is False                    # offset absorbs the pitch shift
    assert info["ground_src"] == "hybrid" and info["above_px"] == 0


def test_aboveground_farther_ground_does_not_false_trip():
    # FIELD REGRESSION: ground uniformly FARTHER than the calibrated curve (near strip
    # reads farther → the raw pitch offset would be NEGATIVE and push the reference
    # beyond the real ground, flagging ordinary ground → the driving false positives).
    # Clamping the offset to >= 0 keeps the (nearer) curve as reference, so farther
    # ground is never "above" it.
    pytest.importorskip("cv2")
    H, W = 120, 120
    profile, _flat = _curve_and_plane(H, W, z_far=8.0, z_near=1.0)
    exp = stereo.ground_depth_for_rows(profile, H)
    depth = np.tile((1.0 / (1.0 / exp - 0.1))[:, None], (1, W)).astype(np.float32)  # all farther
    det = _aboveground_detector(100.0, W, H, profile=profile)
    ob, info = det._decide_aboveground(depth, np.ones((H, W), bool), None)
    assert ob is False and info["offset"] == 0.0   # negative offset clamped → curve → clean


def test_aboveground_respects_max_range():
    pytest.importorskip("cv2")
    H, W = 120, 120
    profile, depth = _curve_and_plane(H, W, z_far=8.0, z_near=1.5)
    valid = np.ones((H, W), bool)
    cfg = stereo.StereoConfig(max_detect_range_m=3.0)
    det = _aboveground_detector(100.0, W, H, cfg=cfg, profile=profile)
    beyond = depth.copy(); beyond[55:72, 45:78] = 3.5         # above ground but > 3 m range
    assert det._decide_aboveground(beyond, valid, None)[0] is False
    within = depth.copy(); within[72:92, 45:78] = 1.0         # within range, above ground
    assert det._decide_aboveground(within, valid, None)[0] is True


def test_aboveground_uses_curve_when_offset_strip_empty():
    # No valid pixels in the near strip → no pitch offset formed → the curve is used
    # unshifted (still per-frame 'hybrid'); matching flat ground stays clean.
    pytest.importorskip("cv2")
    H, W = 120, 120
    profile, depth = _curve_and_plane(H, W, z_far=8.0, z_near=1.0)
    valid = np.ones((H, W), bool)
    valid[int(0.82 * H):, :] = False            # near strip has nothing to fit an offset
    det = _aboveground_detector(100.0, W, H, profile=profile)
    ob, info = det._decide_aboveground(depth, valid, None)
    assert info["ground_src"] == "hybrid" and ob is False
