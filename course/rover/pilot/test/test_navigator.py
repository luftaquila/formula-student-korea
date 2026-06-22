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


def test_execute_path_rejects_malformed_waypoint_before_state_change(nav):
    msg = type('M', (), {'data': json.dumps([{'lat': 35.0001}, {'lat': 35.0, 'lng': 126.0}])})()
    nav._on_execute_path(msg)
    assert nav._state == State.IDLE
    assert nav._waypoints == []


def test_execute_path_rejected_during_active_state(nav):
    """Mid-NAVIGATING execute_path must be rejected. Otherwise the chassis
    keeps cruising under the prior tracker for one tick, and the new
    mission's CALIBRATING anchors ENU at a moving rover."""
    nav._state = State.NAVIGATING
    msg = type('M', (), {'data': json.dumps([{'lat': 35.0001, 'lng': 126.0001}])})()
    nav._on_execute_path(msg)
    assert nav._state == State.NAVIGATING  # unchanged
    # Same for SETTLING / SPRAYING / CAL_ANTENNA / CAL_WHEELS.
    for s in (State.SETTLING, State.SPRAYING, State.CAL_ANTENNA, State.CAL_WHEELS):
        nav._state = s
        nav._on_execute_path(msg)
        assert nav._state == s


def test_execute_path_accepted_from_error_state(nav):
    """Operator should be able to start a new mission from ERROR (after
    GPS recovery hasn't auto-resumed yet, e.g. cleared via clear_emergency
    landing in IDLE first — but ERROR direct entry is also reasonable
    when the operator wants to forcibly retry from a known position)."""
    nav._state = State.ERROR
    msg = type('M', (), {'data': json.dumps([{'lat': 35.0001, 'lng': 126.0001}])})()
    nav._on_execute_path(msg)
    assert nav._state == State.CALIBRATING


def test_error_resume_resets_settle_and_progress_timers(nav, monkeypatch):
    """30-s GPS outage during SETTLING must not fire settle_timeout
    immediately on resume. fix_recovery_hold_s also gates the resume —
    fix must hold for the configured duration before NAVIGATING/SETTLING
    re-enters."""
    t = [time.monotonic()]
    monkeypatch.setattr(time, 'monotonic', lambda: t[0])
    # Simulate: rover entered SETTLING, then GPS dropped, ERROR fired.
    nav._settle_enter_time = t[0] - 30.0  # 30 s ago
    nav._last_progress_time = t[0] - 30.0
    nav._last_progress_dist = 1.5
    nav._pre_error_state = State.SETTLING
    nav._state = State.ERROR
    nav._last_gps_time = t[0]  # GPS just recovered
    nav._gps_fix_status = 'rtk_fixed'

    # First tick after recovery: fix is back but hold hasn't elapsed.
    nav._handle_error()
    assert nav._state == State.ERROR
    assert nav._fix_recovered_at == t[0]

    # Advance past fix_recovery_hold_s and call again — now resume.
    hold = nav.get_parameter('fix_recovery_hold_s').value
    t[0] = t[0] + hold + 0.01
    nav._last_gps_time = t[0]  # GPS still fresh
    nav._handle_error()
    assert nav._state == State.SETTLING
    # Wall-clock timers must reset to NOW so the next handler tick
    # doesn't see "30 s elapsed" and trip its timeouts.
    assert nav._settle_enter_time == t[0]
    assert nav._last_progress_time == t[0]
    assert nav._last_progress_dist == float('inf')


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
    assert nav._l1_tracker is not None
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


def test_cal_antenna_circle_step_does_not_crash(nav, monkeypatch):
    """Regression: bare cos()/sin() must be in navigator_node's namespace.

    The circle sub-step integrates chassis pose with cos()/sin() — a
    missing import would NameError on the second tick (when the dt-gated
    integration body actually runs). Drives two ticks with valid odom and
    GPS state and asserts no exception escapes.
    """
    from pilot.navigator_node import CalAntennaPhase
    nav._state = State.CAL_ANTENNA
    nav._cal_antenna_phase = CalAntennaPhase.CIRCLE
    nav._cal_antenna_chassis = (0.0, 0.0, 0.0)
    nav._cal_antenna_psi_init = 0.0
    nav._cal_antenna_start_lat = 35.0
    nav._cal_antenna_start_lon = 126.0
    nav._cal_antenna_phase_start_t = time.monotonic()
    nav._cal_antenna_orbit_angle = 0.0
    nav._odom_v_left = 0.5
    nav._odom_v_right = 0.5
    nav._cal_antenna_step_circle()  # primes _cal_antenna_last_predict_t
    # Second tick exercises the integration body where cos/sin are called.
    nav._cal_antenna_step_circle()


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
    # Differential 0.04 m on a 10 m straight drive ⇒ per-wheel scales
    # 10/9.98 vs 10/10.02 (right wheel rolls slightly bigger than left).
    nav._cal_wheels_enc_l_m = 9.98
    nav._cal_wheels_enc_r_m = 10.02
    nav._cal_wheels_samples = 200
    nav._cal_wheels_last_t = time.monotonic()
    # Straight ENU chord aligned with +n: 50 collinear samples spanning
    # ~10 m. The arc-aware solver fits a degenerate (infinite-radius)
    # circle here and falls back to chord-based per-wheel reference.
    nav._cal_wheels_enu_samples = [(0.0, 10.0 * i / 49) for i in range(50)]
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


def _stub_cal_wheels_drive(nav):
    """Minimal navigator state to make _handle_cal_wheels run through to
    the end-of-drive solve (10 m GPS chord, healthy encoder displacement,
    enough samples). Wheel scales come out near 1.0; the test focuses on
    the steering-trim leg around them."""
    nav._state = State.CAL_WHEELS
    nav._cal_wheels_start_lat = 35.0
    nav._cal_wheels_start_lon = 126.0
    nav._cal_wheels_enc_l_m = 10.0
    nav._cal_wheels_enc_r_m = 10.0
    nav._cal_wheels_samples = 200
    nav._cal_wheels_last_t = time.monotonic()
    nav._gps_lat = 35.00009
    nav._gps_lon = 126.0
    nav._odom_v_left_raw = 0.5
    nav._odom_v_right_raw = 0.5
    nav._cal_wheels_enu_samples = [(i * 0.05, 0.0) for i in range(201)]


def test_handle_cal_wheels_accumulates_steering_trim(nav, monkeypatch, tmp_path):
    """Each cal drive runs WITH the previously persisted trim already
    applied by mcu_bridge, so the residual κ_bias the solver sees is a
    delta on top of the existing correction. The cal must add the delta
    to the persisted trim, not overwrite it. Without accumulation, two
    successive cals on a chassis with a real bias push trim toward zero
    instead of converging on the true correction.

    Mock solve_steering_trim to return a known delta so this test is
    insensitive to circle-fit numerics on synthetic data (the solver
    itself is exercised in test_steering_calibration.py)."""
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    from pilot.lib.steering_calibration import save_steering_trim
    from pilot import navigator_node as nn

    save_steering_trim(
        -10.0,
        radius_m=40.0,
        rms_residual_m=0.01,
        samples=200,
        drive_distance_m=10.0,
    )

    def fake_solve(**_kw):
        return {
            'trim_us': -8.0,             # delta only
            'radius_m': -50.0,
            'rms_residual_m': 0.005,
            'samples': 200,
            'reason': None,
        }
    monkeypatch.setattr(nn, 'solve_steering_trim', fake_solve)

    _stub_cal_wheels_drive(nav)

    apply_trim_msgs = []
    nav._pub_apply_steering_trim.publish = lambda m: apply_trim_msgs.append(m.data)
    nav._pub_apply_wheel_scales.publish = lambda m: None
    nav._pub_cal_wheels_result.publish = lambda m: None

    nav._handle_cal_wheels()

    assert len(apply_trim_msgs) == 1
    payload = json.loads(apply_trim_msgs[0])
    # Persisted -10 µs + delta -8 µs = -18 µs accumulated.
    # The pre-fix bug published just -8 µs, overwriting the prior trim.
    assert payload['trim_us'] == pytest.approx(-18.0, abs=1e-6)


def test_handle_cal_wheels_rejects_accumulated_trim_over_bound(nav, monkeypatch, tmp_path):
    """If the persisted trim is already near the ±TRIM_BOUND_US sanity
    bound and the new delta would push it past, the cal must NOT
    overwrite the existing trim. mcu_bridge would reject the apply
    message anyway, but failing soft on the navigator side keeps the
    audit trail clean (the result payload reports the reason)."""
    monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
    from pilot.lib.steering_calibration import TRIM_BOUND_US, save_steering_trim
    from pilot import navigator_node as nn

    # Seed trim 5 µs under the bound; a 10 µs delta in the same
    # direction will push it 5 µs over.
    seeded = -(TRIM_BOUND_US - 5.0)
    save_steering_trim(
        seeded,
        radius_m=10.0,
        rms_residual_m=0.01,
        samples=200,
        drive_distance_m=10.0,
    )

    def fake_solve(**_kw):
        return {
            'trim_us': -10.0,
            'radius_m': -40.0,
            'rms_residual_m': 0.005,
            'samples': 200,
            'reason': None,
        }
    monkeypatch.setattr(nn, 'solve_steering_trim', fake_solve)

    _stub_cal_wheels_drive(nav)

    apply_trim_msgs = []
    nav._pub_apply_steering_trim.publish = lambda m: apply_trim_msgs.append(m.data)
    nav._pub_apply_wheel_scales.publish = lambda m: None
    result_msgs = []
    nav._pub_cal_wheels_result.publish = lambda m: result_msgs.append(m.data)

    nav._handle_cal_wheels()

    assert len(apply_trim_msgs) == 0
    result_payload = json.loads(result_msgs[0])
    assert 'steering_reason' in result_payload
    assert 'outside' in result_payload['steering_reason']
    # Wheel scales still applied — only the trim leg failed.
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


# ── Soft pause / resume ────────────────────────────────────────────────────

def test_pause_from_pausable_states_enters_paused(nav):
    for s in (State.NAVIGATING, State.SETTLING, State.SPRAYING):
        nav._state = s
        nav._cur_wp_idx = 0
        nav._on_pause(None)
        assert nav._state == State.PAUSED


def test_pause_ignored_outside_pausable_states(nav):
    # CALIBRATING has no tracker/segments yet (nothing to resume into), and the
    # idle/fault states have no mission to hold — pause must be a no-op there.
    for s in (State.IDLE, State.CALIBRATING, State.ERROR,
              State.EMERGENCY_STOP, State.CAL_ANTENNA, State.CAL_WHEELS):
        nav._state = s
        nav._on_pause(None)
        assert nav._state == s


def test_resume_from_paused_enters_navigating(nav):
    nav._state = State.PAUSED
    nav._on_resume(None)
    assert nav._state == State.NAVIGATING


def test_resume_ignored_when_not_paused(nav):
    for s in (State.NAVIGATING, State.IDLE, State.EMERGENCY_STOP):
        nav._state = s
        nav._on_resume(None)
        assert nav._state == s


def test_paused_holds_through_gps_loss(nav, monkeypatch):
    # Unlike an active driving state, PAUSED is an intentional hold: a stale GPS
    # clock must NOT trip ERROR (the operator may be manually clearing an
    # obstacle with the antenna momentarily occluded).
    nav._state = State.PAUSED
    t = [time.monotonic()]
    monkeypatch.setattr(time, 'monotonic', lambda: t[0])
    nav._last_gps_time = t[0] - 10.0  # well past gps_timeout
    nav._control_loop()
    assert nav._state == State.PAUSED


def test_execute_path_preempts_paused(nav):
    # A fresh path (also the re-send resume fallback) may preempt a soft pause.
    nav._state = State.PAUSED
    msg = type('M', (), {'data': json.dumps([{'lat': 35.0001, 'lng': 126.0001}])})()
    nav._on_execute_path(msg)
    assert nav._state == State.CALIBRATING
