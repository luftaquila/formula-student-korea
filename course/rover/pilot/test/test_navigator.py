"""Tests for navigator_node state machine, fix hysteresis, Pure Pursuit, calibration."""

import math
import time
import pytest

# conftest.py stubs rclpy, lgpio, etc. before this import runs.
from pilot.navigator_node import NavigatorNode, State


@pytest.fixture
def nav(monkeypatch):
    """Fresh NavigatorNode with synthetic monotonic clock."""
    node = NavigatorNode()
    # Pre-seed fresh GPS so the control loop does not trip GPS timeout.
    node._current_lat = 35.0
    node._current_lon = 126.0
    node._current_heading = 0.0
    node._last_gps_time = time.monotonic()
    node._gps_fix_status = 'rtk_fixed'
    # Seed waypoints so NAVIGATING does not immediately exit to IDLE
    node._waypoints = [{'lat': 35.0001, 'lng': 126.0001}]
    node._current_wp_idx = 0
    return node


# ── 1.1 Fix hysteresis ────────────────────────────────────────────────────

def test_fix_hysteresis_short_dropout_does_not_error(nav, monkeypatch):
    nav._state = State.NAVIGATING
    # Simulate fix dropping but for less than hysteresis
    t = [time.monotonic()]
    monkeypatch.setattr(time, 'monotonic', lambda: t[0])
    nav._last_gps_time = t[0]
    nav._gps_fix_status = 'rtk_float'  # below required
    nav._control_loop()
    assert nav._state == State.NAVIGATING
    # Advance by only 0.2s (below default 0.8s hysteresis)
    t[0] += 0.2
    nav._last_gps_time = t[0]
    nav._control_loop()
    assert nav._state == State.NAVIGATING


def test_fix_hysteresis_trips_after_threshold(nav, monkeypatch):
    nav._state = State.NAVIGATING
    t = [time.monotonic()]
    monkeypatch.setattr(time, 'monotonic', lambda: t[0])
    nav._last_gps_time = t[0]
    nav._gps_fix_status = 'rtk_float'
    nav._control_loop()  # first degraded reading starts timer
    t[0] += 1.0  # past 0.8s default
    nav._last_gps_time = t[0]
    nav._control_loop()
    assert nav._state == State.ERROR


def test_fix_hysteresis_resets_on_recovery(nav, monkeypatch):
    nav._state = State.NAVIGATING
    t = [time.monotonic()]
    monkeypatch.setattr(time, 'monotonic', lambda: t[0])
    nav._last_gps_time = t[0]
    nav._gps_fix_status = 'rtk_float'
    nav._control_loop()
    assert nav._fix_degraded_since is not None
    nav._gps_fix_status = 'rtk_fixed'
    nav._last_gps_time = t[0]
    nav._control_loop()
    assert nav._fix_degraded_since is None
    assert nav._state == State.NAVIGATING


# ── 2.3 Pure Pursuit: curvature clamping ──────────────────────────────────

def test_pure_pursuit_clamps_curvature_near_target(nav):
    nav._current_lat = 35.0
    nav._current_lon = 126.0
    nav._current_heading = 0.0
    # Very close target slightly off-heading — would blow up without clamp
    target_lat = 35.0000001
    target_lon = 126.00001
    speed, curvature = nav._pure_pursuit(target_lat, target_lon, 0.1)
    max_curv = nav.get_parameter('max_curvature').value
    assert abs(curvature) <= max_curv + 1e-6


def test_pure_pursuit_rotate_in_place_uses_max_curvature(nav):
    # Large heading error → rotate in place
    nav._current_heading = 0.0  # pointing north
    target_lat = 34.99  # target is south (180deg off)
    target_lon = 126.0
    speed, curvature = nav._pure_pursuit(target_lat, target_lon, 5.0)
    max_curv = nav.get_parameter('max_curvature').value
    assert speed == pytest.approx(0.05, abs=1e-9)
    assert abs(curvature) == pytest.approx(max_curv, abs=1e-6)


# ── 2.4 Calibration quality gating ────────────────────────────────────────

def test_calibration_aborts_after_max_distance_with_high_variance(nav, monkeypatch):
    nav._state = State.CALIBRATING
    nav._cal_start_lat = 35.0
    nav._cal_start_lon = 126.0
    # Simulate noisy heading samples
    import random
    random.seed(0)
    nav._cal_headings = [random.uniform(-math.pi, math.pi) for _ in range(20)]
    # Place rover beyond calibration_max_distance (default 5m)
    nav._current_lat = 35.0001  # ~11m north
    nav._current_lon = 126.0
    nav._current_heading = 0.0
    nav._handle_calibrating()
    assert nav._state == State.ERROR


def test_calibration_extends_once_on_high_variance(nav):
    nav._state = State.CALIBRATING
    nav._cal_start_lat = 35.0
    nav._cal_start_lon = 126.0
    # High variance samples
    nav._cal_headings = [0.0, math.pi / 2, -math.pi / 2, math.pi, -math.pi]
    nav._current_heading = 0.0
    # Just past calibration_distance (default 2.5m), well below max (5m)
    nav._current_lat = 35.00002300  # ~2.6m north
    nav._current_lon = 126.0
    nav._handle_calibrating()
    # Should have extended calibration, not errored or advanced
    assert nav._state == State.CALIBRATING
    assert nav._cal_extended is True


def test_new_mission_resets_calibration_extended_flag(nav):
    """Regression: a previous mission's cal_extended must not leak into a new run."""
    import json
    nav._cal_extended = True
    nav._fix_degraded_since = 12345.0
    nav._current_lat = 35.0
    nav._current_lon = 126.0
    nav._gps_fix_status = 'rtk_fixed'

    # Trigger a new mission
    msg = type('M', (), {'data': json.dumps([{'lat': 35.0001, 'lng': 126.0001}])})()
    nav._on_execute_path(msg)

    assert nav._cal_extended is False
    assert nav._fix_degraded_since is None
    assert nav._state == State.CALIBRATING


# ── 3.13 publish_state dedup ──────────────────────────────────────────────

def test_publish_state_dedup(nav):
    calls = []
    nav._pub_state.publish = lambda msg: calls.append(msg.data)
    nav._publish_state()
    nav._publish_state()
    nav._publish_state()
    # Only the first call should actually publish because the state didn't change.
    assert len(calls) <= 1


# ── 3.14 _safe_destroy_timer ──────────────────────────────────────────────

def test_safe_destroy_timer_idempotent(nav):
    t = nav.create_timer(1.0, lambda: None)
    assert nav._safe_destroy_timer(t) is None
    # Calling again should not raise even though the timer is already dead
    assert nav._safe_destroy_timer(t) is None


def test_safe_destroy_timer_none_ok(nav):
    assert nav._safe_destroy_timer(None) is None
