"""Tests for the chalk dispenser (SprayNode) cycle logic and timer safety.

The dispenser servo is driven by the MCU; SprayNode publishes the target
pulse width on /rover/cmd/dispenser_us. These tests intercept the
publisher to assert command intent without touching real hardware.

The dispense model is a load→dump→load cycle: the drum rests at LOAD
(angle_a) while driving, rotates to DUMP (angle_b) to drop a shot at the
waypoint, then returns to LOAD. The cycle is driven by two chained
timers (arrive_to_dump_delay → DUMP, dump_hold_duration → LOAD). The
fake Node in conftest does NOT auto-fire timers, so tests advance the
cycle by calling the step callbacks (_do_dump, _do_load_and_done)
directly.
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


def test_boot_commands_load(monkeypatch):
    """On boot the drum is driven to LOAD (angle_a) — its rest pose — so
    the first driving leg packs powder into it.
    """
    calls = []
    monkeypatch.setattr(SprayNode, '_publish_pulse_us', lambda self, us: calls.append(int(us)))
    node = SprayNode()
    angle_a = node.get_parameter('dispense_angle_a').value
    assert calls == [_angle_to_pulse_us(angle_a)]


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
    """E-stop must NOT emit a new dispenser pulse — we abort the pending
    cycle and leave the drum at whatever pose it last rotated to. The
    operator returns it to rest via the manual Load button.
    """
    # Clear any pulses queued by __init__ (boot publishes LOAD).
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


def test_waypoint_reached_no_immediate_pulse_and_arms_timer(spray, captured_pulses):
    """Reaching a waypoint must NOT command the servo immediately — the
    drum is already at LOAD. It only marks spraying and arms the pre-dump
    timer; the DUMP command waits for that timer to fire.
    """
    captured_pulses.clear()
    wp = type('M', (), {'data': 12})()
    spray._on_waypoint_reached(wp)
    assert captured_pulses == [], "no servo command on arrival — drum is already at load"
    assert spray._spraying is True
    assert spray._current_wp_idx == 12
    assert spray._dispense_timer is not None


def test_full_cycle_dumps_then_loads(spray, captured_pulses):
    """The full cycle commands DUMP (angle_b) then LOAD (angle_a), and
    finishes back at LOAD with a success result.
    """
    captured_pulses.clear()
    angle_a = spray.get_parameter('dispense_angle_a').value
    angle_b = spray.get_parameter('dispense_angle_b').value

    done = []
    results = []
    spray._pub_done.publish = lambda msg: done.append(msg)
    spray._pub_result.publish = lambda msg: results.append(msg)

    wp = type('M', (), {'data': 9})()
    spray._on_waypoint_reached(wp)
    # Pre-dump timer fires → rotate to DUMP.
    spray._do_dump()
    # Dump-hold timer fires → rotate back to LOAD + signal done.
    spray._do_load_and_done()

    assert captured_pulses == [_angle_to_pulse_us(angle_b), _angle_to_pulse_us(angle_a)], \
        "cycle must command dump then load"
    assert spray._spraying is False
    assert len(done) == 1
    assert json.loads(results[0].data) == {"waypoint": 9, "outcome": "success"}


def test_do_dump_noop_when_not_spraying(spray, captured_pulses):
    """If the cycle was cancelled during the pre-dump dwell, the queued
    _do_dump callback must not command the servo.
    """
    captured_pulses.clear()
    spray._spraying = False
    spray._do_dump()
    assert captured_pulses == []


def test_do_load_and_done_noop_when_not_spraying(spray, captured_pulses):
    """If the cycle was cancelled during the dump hold, the queued
    _do_load_and_done callback must not command the servo or signal done.
    """
    captured_pulses.clear()
    done = []
    spray._pub_done.publish = lambda msg: done.append(msg)
    spray._spraying = False
    spray._do_load_and_done()
    assert captured_pulses == []
    assert done == []


def test_set_position_load_drives_angle_a(spray, captured_pulses):
    captured_pulses.clear()
    msg = type('M', (), {'data': 'load'})()
    spray._on_set_position(msg)
    angle_a = spray.get_parameter('dispense_angle_a').value
    assert captured_pulses == [_angle_to_pulse_us(angle_a)]


def test_set_position_dump_drives_angle_b(spray, captured_pulses):
    captured_pulses.clear()
    msg = type('M', (), {'data': 'dump'})()
    spray._on_set_position(msg)
    angle_b = spray.get_parameter('dispense_angle_b').value
    assert captured_pulses == [_angle_to_pulse_us(angle_b)]


def test_set_position_unknown_payload_noop(spray, captured_pulses):
    captured_pulses.clear()
    msg = type('M', (), {'data': 'banana'})()
    spray._on_set_position(msg)
    assert captured_pulses == []


def test_set_position_ignored_while_spraying(spray, captured_pulses):
    captured_pulses.clear()
    spray._spraying = True
    msg = type('M', (), {'data': 'load'})()
    spray._on_set_position(msg)
    assert captured_pulses == []


def test_waypoint_reached_blocked_while_spraying(spray, captured_pulses):
    """A second trigger arriving while a cycle is in progress is ignored."""
    captured_pulses.clear()
    spray._spraying = True
    wp = type('M', (), {'data': 5})()
    spray._on_waypoint_reached(wp)
    assert captured_pulses == [], "no servo command while busy"
