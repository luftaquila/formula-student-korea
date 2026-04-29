"""Tests for navigator_node — state machine, fix hysteresis, calibration gating."""

import json
import math
import time

import pytest

# conftest.py stubs rclpy / hardware before this import runs.
from pilot.navigator_node import NavigatorNode, State


@pytest.fixture
def nav(monkeypatch):
    """Fresh NavigatorNode with synthetic monotonic clock & GPS."""
    node = NavigatorNode()
    node._gps_lat = 35.0
    node._gps_lon = 126.0
    node._gps_heading_compass = 0.0
    node._gps_fix_status = 'rtk_fixed'
    node._gps_speed = 0.6
    node._last_gps_time = time.monotonic()
    return node


# ── Fix hysteresis ────────────────────────────────────────────────────────

def test_fix_hysteresis_short_dropout_does_not_error(nav, monkeypatch):
    nav._state = State.NAVIGATING
    t = [time.monotonic()]
    monkeypatch.setattr(time, 'monotonic', lambda: t[0])
    nav._last_gps_time = t[0]
    nav._gps_fix_status = 'rtk_float'
    nav._control_loop()
    assert nav._state == State.NAVIGATING
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
    nav._control_loop()
    t[0] += 1.0
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


# ── Mission start ─────────────────────────────────────────────────────────

def test_execute_path_without_fix_enters_error(nav):
    nav._gps_fix_status = 'no_fix'
    msg = type('M', (), {'data': json.dumps([{'lat': 35.001, 'lng': 126.001}])})()
    nav._on_execute_path(msg)
    assert nav._state == State.ERROR
    assert nav._last_error_reason is not None


def test_execute_path_with_fix_starts_calibrating(nav):
    msg = type('M', (), {'data': json.dumps([{'lat': 35.0001, 'lng': 126.0001}])})()
    nav._on_execute_path(msg)
    assert nav._state == State.CALIBRATING
    assert nav._waypoints == [{'lat': 35.0001, 'lng': 126.0001}]
    assert nav._cal_start_lat == 35.0
    # Per-mission state must be reset, never leaked from a prior run.
    assert nav._cal_extended is False
    assert nav._cal_samples == []
    assert nav._stuck_retries == 0


def test_new_mission_resets_internal_state(nav):
    """Regression: prior mission's flags must not leak into a fresh run."""
    nav._cal_extended = True
    nav._cal_samples = [(1.0, 2.0)]
    nav._fix_degraded_since = 12345.0
    nav._stuck_retries = 3
    nav._pre_error_state = State.NAVIGATING

    msg = type('M', (), {'data': json.dumps([{'lat': 35.0001, 'lng': 126.0001}])})()
    nav._on_execute_path(msg)

    assert nav._cal_extended is False
    assert nav._cal_samples == []
    assert nav._fix_degraded_since is None
    assert nav._stuck_retries == 0
    assert nav._pre_error_state is None
    assert nav._state == State.CALIBRATING


# ── Calibration ───────────────────────────────────────────────────────────

def test_calibration_aborts_after_max_distance_with_high_residual(nav):
    nav._state = State.CALIBRATING
    nav._cal_start_lat = 35.0
    nav._cal_start_lon = 126.0
    nav._ref_lat = 35.0
    nav._ref_lon = 126.0
    # Place rover well past calibration_max_distance with garbage samples.
    import random
    random.seed(0)
    nav._cal_samples = [
        (i * 0.5, random.uniform(-2.0, 2.0)) for i in range(40)
    ]
    nav._gps_lat = 35.00006  # ~6.6 m north of ref → past 5 m cap
    nav._gps_lon = 126.0
    nav._handle_calibrating()
    assert nav._state == State.ERROR


def test_calibration_extends_once_on_weak_fit(nav):
    nav._state = State.CALIBRATING
    nav._cal_start_lat = 35.0
    nav._cal_start_lon = 126.0
    nav._ref_lat = 35.0
    nav._ref_lon = 126.0
    # Antenna positions with too-short chord (<1.5 m) so the fit is weak
    # and the planner should request an extension rather than ERRORing.
    nav._cal_samples = [(i * 0.05, 0.0) for i in range(25)]  # 1.2 m chord
    nav._gps_lat = 35.000023  # ~2.55 m past start, just past calibration_distance
    nav._gps_lon = 126.0
    nav._handle_calibrating()
    assert nav._state == State.CALIBRATING
    assert nav._cal_extended is True


def test_calibration_completes_with_clean_chord(nav, monkeypatch):
    nav._state = State.CALIBRATING
    nav._cal_start_lat = 35.0
    nav._cal_start_lon = 126.0
    nav._ref_lat = 35.0
    nav._ref_lon = 126.0
    # Clean straight chord, ≥ 2.5 m, ≥ min samples → calibration must
    # advance to NAVIGATING and build trackers.
    nav._cal_samples = [(0.0, i * 0.10) for i in range(30)]  # 3 m due North
    nav._gps_lat = 35.000028  # ~3.1 m north (past calibration_distance 2.5)
    nav._gps_lon = 126.0
    nav._waypoints = [{'lat': 35.0001, 'lng': 126.0001}]
    nav._handle_calibrating()
    assert nav._state == State.NAVIGATING
    assert nav._estimator is not None
    assert nav._cruise_tracker is not None
    assert nav._dock_tracker is not None
    # Chassis psi should be close to North = math π/2.
    _, _, psi = nav._estimator.chassis_pose()
    assert abs(psi - math.pi / 2) < 0.05


# ── State plumbing ────────────────────────────────────────────────────────

def test_publish_state_dedup(nav):
    calls = []
    nav._pub_state.publish = lambda msg: calls.append(msg.data)
    nav._publish_state()
    nav._publish_state()
    nav._publish_state()
    assert len(calls) <= 1


def test_safe_destroy_timer_idempotent(nav):
    t = nav.create_timer(1.0, lambda: None)
    assert nav._safe_destroy_timer(t) is None
    assert nav._safe_destroy_timer(t) is None


def test_safe_destroy_timer_none_ok(nav):
    assert nav._safe_destroy_timer(None) is None


def test_emergency_stop_goes_to_estop(nav):
    nav._state = State.NAVIGATING
    nav._on_emergency_stop(None)
    assert nav._state == State.EMERGENCY_STOP


def test_clear_emergency_only_clears_from_estop(nav):
    nav._state = State.NAVIGATING
    nav._on_clear_emergency(None)
    assert nav._state == State.NAVIGATING  # unchanged
    nav._state = State.EMERGENCY_STOP
    nav._on_clear_emergency(None)
    assert nav._state == State.IDLE


def test_set_error_publishes_reason(nav):
    published = []
    nav._pub_error_reason.publish = lambda msg: published.append(msg.data)
    nav._set_error('test reason')
    assert nav._state == State.ERROR
    assert nav._last_error_reason == 'test reason'
    assert published == ['test reason']
