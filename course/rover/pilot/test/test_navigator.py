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


# ── Antenna offset auto-calibration ───────────────────────────────────────

def test_calibrate_antenna_rejected_when_not_idle(nav):
    nav._state = State.NAVIGATING
    results = []
    nav._pub_cal_antenna_result.publish = lambda msg: results.append(msg.data)
    nav._on_calibrate_antenna(None)
    assert nav._state == State.NAVIGATING
    assert len(results) == 1
    import json as _json
    payload = _json.loads(results[0])
    assert payload['ok'] is False
    assert 'IDLE' in payload['reason']


def test_calibrate_antenna_rejected_without_fix(nav):
    nav._state = State.IDLE
    nav._gps_fix_status = 'no_fix'
    results = []
    nav._pub_cal_antenna_result.publish = lambda msg: results.append(msg.data)
    nav._on_calibrate_antenna(None)
    assert nav._state == State.IDLE
    assert len(results) == 1


def test_calibrate_antenna_starts_from_idle(nav):
    nav._state = State.IDLE
    nav._on_calibrate_antenna(None)
    assert nav._state == State.CAL_ANTENNA
    # Per-cal scratch must be reset so a previous failed attempt can't bleed in.
    assert nav._cal_antenna_samples == []
    assert nav._cal_antenna_data == []
    assert nav._cal_antenna_extended is False
    assert nav._cal_antenna_psi_init is None
    assert nav._cal_antenna_start_lat == nav._gps_lat


def test_emergency_stop_during_cal_antenna(nav):
    nav._state = State.CAL_ANTENNA
    nav._on_emergency_stop(None)
    assert nav._state == State.EMERGENCY_STOP


def test_cal_antenna_scurve_step_does_not_crash(nav, monkeypatch):
    """Regression for the SCURVE NameError introduced in 66b75ab.

    The scurve sub-step uses bare cos()/sin() and would NameError on the
    second tick if math symbols aren't imported into navigator_node's
    namespace. This test takes the path that calls _cal_antenna_step_scurve
    twice (so the dt-gated integration body runs at least once) with valid
    odom + GPS state, and asserts no exception escapes.
    """
    from pilot.navigator_node import CalAntennaPhase
    nav._state = State.CAL_ANTENNA
    nav._cal_antenna_phase = CalAntennaPhase.SCURVE
    nav._cal_antenna_chassis = (0.0, 0.0, 0.0)
    nav._cal_antenna_psi_init = 0.0
    nav._cal_antenna_start_lat = 35.0
    nav._cal_antenna_start_lon = 126.0
    nav._cal_antenna_phase_start_t = time.monotonic()
    nav._odom_v_left = 0.5
    nav._odom_v_right = 0.5
    nav._cal_antenna_step_scurve()  # primes _cal_antenna_last_predict_t
    # Second tick exercises the integration body where cos/sin are called.
    nav._cal_antenna_step_scurve()


# ── Wheel scale auto-calibration ──────────────────────────────────────────

def test_calibrate_wheels_rejected_when_not_idle(nav):
    nav._state = State.NAVIGATING
    results = []
    nav._pub_cal_wheels_result.publish = lambda msg: results.append(msg.data)
    nav._on_calibrate_wheels(None)
    assert nav._state == State.NAVIGATING
    assert len(results) == 1
    payload = json.loads(results[0])
    assert payload['ok'] is False
    assert 'IDLE' in payload['reason']


def test_calibrate_wheels_rejected_without_fix(nav):
    nav._state = State.IDLE
    nav._gps_fix_status = 'no_fix'
    results = []
    nav._pub_cal_wheels_result.publish = lambda msg: results.append(msg.data)
    nav._on_calibrate_wheels(None)
    assert nav._state == State.IDLE
    assert len(results) == 1


def test_calibrate_wheels_starts_from_idle(nav):
    nav._state = State.IDLE
    nav._on_calibrate_wheels(None)
    assert nav._state == State.CAL_WHEELS
    assert nav._cal_wheels_enc_l_m == 0.0
    assert nav._cal_wheels_enc_r_m == 0.0
    assert nav._cal_wheels_samples == 0
    assert nav._cal_wheels_start_lat == nav._gps_lat


def test_handle_cal_wheels_publishes_apply_when_done(nav, monkeypatch):
    """Driving past wheel_cal_distance must publish apply_wheel_scales
    with both scales and persist via the navigator → mcu_bridge handoff."""
    nav._state = State.CAL_WHEELS
    nav._cal_wheels_start_lat = 35.0
    nav._cal_wheels_start_lon = 126.0
    nav._cal_wheels_enc_l_m = 9.95   # 0.5 % under
    nav._cal_wheels_enc_r_m = 10.10  # 1 % over
    nav._cal_wheels_samples = 200
    nav._cal_wheels_last_t = time.monotonic()
    # Position the rover ~10 m north of start (≈10 m chord on RTK).
    nav._gps_lat = 35.00009  # 10 m / R_EARTH × 180/π ≈ 0.0000898°
    nav._gps_lon = 126.0
    nav._odom_v_left_raw = 0.5
    nav._odom_v_right_raw = 0.5

    apply_msgs = []
    nav._pub_apply_wheel_scales.publish = lambda m: apply_msgs.append(m.data)
    result_msgs = []
    nav._pub_cal_wheels_result.publish = lambda m: result_msgs.append(m.data)

    nav._handle_cal_wheels()

    assert nav._state == State.IDLE
    assert len(apply_msgs) == 1
    apply_payload = json.loads(apply_msgs[0])
    assert 0.85 <= apply_payload['scale_l'] <= 1.15
    assert 0.85 <= apply_payload['scale_r'] <= 1.15
    # Sanity: encoder right reads larger than left ⇒ scale_r < scale_l.
    assert apply_payload['scale_r'] < apply_payload['scale_l']
    assert len(result_msgs) == 1
    result_payload = json.loads(result_msgs[0])
    assert result_payload['ok'] is True


def test_persisted_offset_loaded_into_instance(nav, tmp_path, monkeypatch):
    """Sanity: when a saved antenna_offset.json exists, navigator picks it
    up on construction so missions plan with the persisted value, not the
    YAML default."""
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    from pilot.lib.antenna_calibration import save_antenna_offset
    save_antenna_offset(0.42, 0.07, rms_residual_m=0.015,
                        samples=60, drive_distance_m=5.5)
    fresh = type(nav)()  # call __init__ again with the env var set
    assert fresh._antenna_offset_x == pytest.approx(0.42)
    assert fresh._antenna_offset_y == pytest.approx(0.07)
    assert fresh._antenna_offset_source == 'persisted'
