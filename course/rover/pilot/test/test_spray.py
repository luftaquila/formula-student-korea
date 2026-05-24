"""Tests for the chalk dispenser (SprayNode) toggle logic and timer safety.

The dispenser servo is driven by the MCU; SprayNode publishes the target
pulse width on /rover/cmd/dispenser_us. These tests intercept the
publisher to assert command intent without touching real hardware.
"""

import json

import pytest
from pilot.spray_node import SprayNode, _angle_to_pulse_us


@pytest.fixture
def spray():
    return SprayNode()


@pytest.fixture
def captured_pulses(spray):
    """Capture all Int32 pulse_us values published to the MCU bridge."""
    pulses = []
    spray._pub_dispenser.publish = lambda msg: pulses.append(int(msg.data))
    return pulses


def test_angle_to_pulse_us_endpoints():
    assert _angle_to_pulse_us(0) == 500
    assert _angle_to_pulse_us(90) == 1500
    assert _angle_to_pulse_us(180) == 2500


def test_safe_destroy_timer_none_ok(spray):
    assert spray._safe_destroy_timer(None) is None


def test_safe_destroy_timer_double_cancel_ignored(spray):
    timer = spray.create_timer(0.1, lambda: None)
    assert spray._safe_destroy_timer(timer) is None
    # Second call on the same (already-cancelled) timer must not raise.
    assert spray._safe_destroy_timer(timer) is None


def test_signal_done_always_publishes(spray):
    """Verify done event is published even if dispense_timer cleanup fails."""
    published = []
    spray._pub_done.publish = lambda msg: published.append(msg)

    # Simulate a dispense_timer that throws on cancel → _safe_destroy_timer
    # must swallow and we still publish done.
    class ExplodingTimer:
        def cancel(self):
            raise RuntimeError("boom")
    spray._dispense_timer = ExplodingTimer()
    spray._spraying = True
    spray._signal_done()
    assert spray._spraying is False
    assert len(published) == 1
    # Timer cleared
    assert spray._dispense_timer is None


def test_emergency_stop_is_idempotent(spray):
    """EMERGENCY_STOP must be safe to call when no timer exists."""
    spray._dispense_timer = None
    spray._on_emergency_stop(None)
    assert spray._spraying is False


def test_emergency_stop_clears_active_timer(spray):
    t = spray.create_timer(0.1, lambda: None)
    spray._dispense_timer = t
    spray._spraying = True
    spray._on_emergency_stop(None)
    assert spray._dispense_timer is None
    assert spray._spraying is False


def test_emergency_stop_does_not_command_servo(spray, captured_pulses):
    """E-stop must NOT emit a new dispenser pulse — both dispense angles
    are valid stops. The earlier liquid-spray design retracted to a rest
    angle on E-stop; the pocket-wheel has no such rest position and
    re-commanding would spill the loaded pocket or hammer the wheel.
    """
    # Clear any pulses queued by __init__ (boot publishes angle_b).
    captured_pulses.clear()
    spray._spraying = True
    spray._current_wp_idx = 7
    spray._on_emergency_stop(None)
    assert captured_pulses == []


def test_signal_done_publishes_success_result(spray):
    """Successful completion emits a structured result with outcome=success."""
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._pub_done.publish = lambda msg: None
    spray._current_wp_idx = 3
    spray._spraying = True
    spray._signal_done()
    assert len(results) == 1
    payload = json.loads(results[0].data)
    assert payload == {"waypoint": 3, "outcome": "success"}


def test_emergency_stop_publishes_cancelled_when_spraying(spray):
    """ESTOP during a dispense must publish cancelled result."""
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._current_wp_idx = 1
    spray._spraying = True
    spray._on_emergency_stop(None)
    assert len(results) == 1
    payload = json.loads(results[0].data)
    assert payload == {"waypoint": 1, "outcome": "cancelled"}


def test_emergency_stop_silent_when_idle(spray):
    """ESTOP while not spraying must not emit a spurious cancelled result."""
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._spraying = False
    spray._current_wp_idx = -1
    spray._on_emergency_stop(None)
    assert results == []


def test_spray_cancel_matches_current_wp_suppresses_result(spray):
    """Cancel on the wp currently dispensing aborts without publishing a result."""
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._spraying = True
    spray._current_wp_idx = 4

    cancel_msg = type('M', (), {'data': 4})()
    spray._on_spray_cancel(cancel_msg)

    assert spray._spraying is False
    assert results == [], "cancel path must not publish a result — navigator already did"


def test_spray_cancel_for_stale_wp_noop(spray):
    """Cancel targeting a different wp than the one currently dispensing is ignored."""
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._spraying = True
    spray._current_wp_idx = 4

    cancel_msg = type('M', (), {'data': 2})()
    spray._on_spray_cancel(cancel_msg)

    # Active dispense on wp 4 is untouched; late cancel for wp 2 is ignored.
    assert spray._spraying is True
    assert spray._current_wp_idx == 4
    assert results == []


def test_toggle_alternates_and_drives_targets(spray, captured_pulses):
    """Two waypoint triggers must drive angle_a then angle_b.

    Boot drives the servo to dispense_angle_b (set in __init__), so the
    first trigger should rotate TO angle_a (load the pocket). The
    toggle_state flips each time; the second trigger rotates back to
    angle_b (dump).
    """
    captured_pulses.clear()
    wp1 = type('M', (), {'data': 10})()
    wp2 = type('M', (), {'data': 11})()

    angle_a = spray.get_parameter('dispense_angle_a').value
    angle_b = spray.get_parameter('dispense_angle_b').value

    # First trigger: state is 1 → drive to angle_a
    spray._on_waypoint_reached(wp1)
    assert spray._toggle_state == 0, "state must flip after dispense"
    assert spray._spraying is True
    # Mark the dispense complete so the second trigger isn't blocked.
    spray._signal_done()
    assert spray._spraying is False

    # Second trigger: state is 0 → drive to angle_b
    spray._on_waypoint_reached(wp2)
    assert spray._toggle_state == 1, "state must flip back"

    expected = [_angle_to_pulse_us(angle_a), _angle_to_pulse_us(angle_b)]
    assert captured_pulses == expected, \
        f"expected pulses {expected}, got {captured_pulses}"


def test_set_position_load_drives_angle_a_and_sets_state_0(spray, captured_pulses):
    captured_pulses.clear()
    spray._toggle_state = 1
    msg = type('M', (), {'data': 'load'})()
    spray._on_set_position(msg)
    angle_a = spray.get_parameter('dispense_angle_a').value
    assert captured_pulses == [_angle_to_pulse_us(angle_a)]
    assert spray._toggle_state == 0, "next auto-dispense must rotate to dump"


def test_set_position_dump_drives_angle_b_and_sets_state_1(spray, captured_pulses):
    captured_pulses.clear()
    spray._toggle_state = 0
    msg = type('M', (), {'data': 'dump'})()
    spray._on_set_position(msg)
    angle_b = spray.get_parameter('dispense_angle_b').value
    assert captured_pulses == [_angle_to_pulse_us(angle_b)]
    assert spray._toggle_state == 1, "next auto-dispense must rotate to load"


def test_set_position_unknown_payload_noop(spray, captured_pulses):
    captured_pulses.clear()
    pre = spray._toggle_state
    msg = type('M', (), {'data': 'banana'})()
    spray._on_set_position(msg)
    assert captured_pulses == []
    assert spray._toggle_state == pre


def test_set_position_ignored_while_spraying(spray, captured_pulses):
    captured_pulses.clear()
    spray._spraying = True
    pre = spray._toggle_state
    msg = type('M', (), {'data': 'load'})()
    spray._on_set_position(msg)
    assert captured_pulses == []
    assert spray._toggle_state == pre


def test_waypoint_reached_blocked_while_spraying(spray, captured_pulses):
    """A second trigger arriving while a dispense is in progress is ignored."""
    captured_pulses.clear()
    spray._spraying = True
    pre_toggle = spray._toggle_state
    wp = type('M', (), {'data': 5})()
    spray._on_waypoint_reached(wp)
    assert captured_pulses == [], "no servo command while busy"
    assert spray._toggle_state == pre_toggle, "no toggle while busy"
