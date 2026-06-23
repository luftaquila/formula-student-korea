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
