"""Tests for the peristaltic-pump dispenser (SprayNode) cycle logic.

The pump is switched by the MCU; SprayNode publishes the desired pump
state (0/1) on /rover/cmd/pump. These tests intercept the publisher to
assert command intent without touching real hardware.

The dispense model is a settle → pump-on → run → pump-off cycle, driven
by two chained timers (arrive_to_pump_delay → pump on, pump_run_duration
→ pump off + done). The fake Node in conftest does NOT auto-fire timers,
so tests advance the cycle by calling the step callbacks (_do_pump_on,
_do_pump_off) directly.
"""

import json

import pytest
from pilot.spray_node import SprayNode


@pytest.fixture
def spray():
    return SprayNode()


@pytest.fixture
def captured_pump(spray):
    """Capture all pump states (0/1) published to the MCU bridge."""
    states = []
    spray._pub_pump.publish = lambda msg: states.append(int(msg.data))
    return states


def test_boot_commands_pump_off(monkeypatch):
    """On boot the pump is driven OFF so nothing dispenses on power-on."""
    calls = []
    monkeypatch.setattr(SprayNode, '_publish_pump', lambda self, on: calls.append(bool(on)))
    SprayNode()
    assert calls == [False]


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


def test_emergency_stop_forces_pump_off(spray, captured_pump):
    """E-stop must force the pump OFF — a running pump can't be left on."""
    captured_pump.clear()
    spray._spraying = True
    spray._current_wp_idx = 7
    spray._on_emergency_stop(None)
    assert captured_pump == [0]


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


def test_spray_cancel_matches_current_wp_forces_off_no_result(spray, captured_pump):
    """Cancel on the wp currently dispensing aborts + forces pump off,
    without publishing a result (navigator already did)."""
    captured_pump.clear()
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._spraying = True
    spray._current_wp_idx = 4

    cancel_msg = type('M', (), {'data': 4})()
    spray._on_spray_cancel(cancel_msg)

    assert spray._spraying is False
    assert captured_pump == [0], "cancel must force the pump off"
    assert results == [], "cancel path must not publish a result — navigator already did"


def test_spray_cancel_for_stale_wp_noop(spray, captured_pump):
    """Cancel targeting a different wp than the one currently dispensing is ignored."""
    captured_pump.clear()
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._spraying = True
    spray._current_wp_idx = 4

    cancel_msg = type('M', (), {'data': 2})()
    spray._on_spray_cancel(cancel_msg)

    # Active dispense on wp 4 is untouched; late cancel for wp 2 is ignored.
    assert spray._spraying is True
    assert spray._current_wp_idx == 4
    assert captured_pump == []
    assert results == []


def test_waypoint_reached_no_immediate_pump_and_arms_timer(spray, captured_pump):
    """Reaching a waypoint must NOT run the pump immediately — it only marks
    spraying and arms the settle timer; the pump waits for that timer.
    """
    captured_pump.clear()
    wp = type('M', (), {'data': 12})()
    spray._on_waypoint_reached(wp)
    assert captured_pump == [], "no pump command on arrival — settle first"
    assert spray._spraying is True
    assert spray._current_wp_idx == 12
    assert spray._dispense_timer is not None


def test_full_cycle_pumps_then_off(spray, captured_pump):
    """The full cycle turns the pump ON then OFF, then signals done with a
    success result."""
    captured_pump.clear()
    done = []
    results = []
    spray._pub_done.publish = lambda msg: done.append(msg)
    spray._pub_result.publish = lambda msg: results.append(msg)

    wp = type('M', (), {'data': 9})()
    spray._on_waypoint_reached(wp)
    assert captured_pump == [], "no pump on arrival"
    # Settle timer fires → pump ON.
    spray._do_pump_on()
    assert spray._spraying is True
    assert done == [], "done must not fire until the pump run completes"
    # Pump-run timer fires → pump OFF + done.
    spray._do_pump_off()

    assert captured_pump == [1, 0], "cycle must turn the pump on then off"
    assert spray._spraying is False
    assert len(done) == 1
    assert json.loads(results[0].data) == {"waypoint": 9, "outcome": "success"}


def test_do_pump_on_noop_when_not_spraying(spray, captured_pump):
    """If the cycle was cancelled during the settle dwell, the queued
    _do_pump_on callback must not run the pump.
    """
    captured_pump.clear()
    spray._spraying = False
    spray._do_pump_on()
    assert captured_pump == []


def test_do_pump_off_noop_when_not_spraying(spray, captured_pump):
    """If the cycle was cancelled during the pump run, the queued
    _do_pump_off callback must not re-command the pump or signal done.
    """
    captured_pump.clear()
    done = []
    spray._pub_done.publish = lambda msg: done.append(msg)
    spray._spraying = False
    spray._do_pump_off()
    assert captured_pump == []
    assert done == []


def test_pump_set_on_drives_pump(spray, captured_pump):
    captured_pump.clear()
    msg = type('M', (), {'data': 1})()
    spray._on_pump_set(msg)
    assert captured_pump == [1]


def test_pump_set_off_drives_pump(spray, captured_pump):
    captured_pump.clear()
    msg = type('M', (), {'data': 0})()
    spray._on_pump_set(msg)
    assert captured_pump == [0]


def test_pump_set_ignored_while_spraying(spray, captured_pump):
    captured_pump.clear()
    spray._spraying = True
    msg = type('M', (), {'data': 1})()
    spray._on_pump_set(msg)
    assert captured_pump == []


def test_waypoint_reached_blocked_while_spraying(spray, captured_pump):
    """A second trigger arriving while a cycle is in progress is ignored."""
    captured_pump.clear()
    spray._spraying = True
    wp = type('M', (), {'data': 5})()
    spray._on_waypoint_reached(wp)
    assert captured_pump == [], "no pump command while busy"


def test_pump_duration_live_update(spray):
    """A valid /rover/cmd/pump_duration updates the live dispense time."""
    msg = type('M', (), {'data': 3.5})()
    spray._on_pump_duration(msg)
    assert spray._pump_run_duration == 3.5


def test_pump_duration_out_of_range_ignored(spray):
    """Out-of-range dispense times are ignored; the live value is unchanged."""
    spray._pump_run_duration = 2.0
    for bad in (0.0, -1.0, 11.0):
        msg = type('M', (), {'data': bad})()
        spray._on_pump_duration(msg)
        assert spray._pump_run_duration == 2.0


def test_pump_duration_used_by_cycle(spray, captured_pump):
    """A live dispense-time change is picked up by the next waypoint cycle."""
    captured_pump.clear()
    msg = type('M', (), {'data': 4.0})()
    spray._on_pump_duration(msg)
    # Run a cycle; the pump-run timer must be armed with the new duration.
    wp = type('M', (), {'data': 1})()
    spray._on_waypoint_reached(wp)
    spray._do_pump_on()
    assert spray._pump_run_duration == 4.0
