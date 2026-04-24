"""Tests for spray_node timer safety and done-signal guarantees."""

import json

import pytest
from pilot.spray_node import SprayNode


@pytest.fixture
def spray():
    return SprayNode()


def test_safe_destroy_timer_none_ok(spray):
    assert spray._safe_destroy_timer(None) is None


def test_safe_destroy_timer_double_cancel_ignored(spray):
    timer = spray.create_timer(0.1, lambda: None)
    assert spray._safe_destroy_timer(timer) is None
    # Second call on the same (already-cancelled) timer must not raise.
    assert spray._safe_destroy_timer(timer) is None


def test_signal_done_always_publishes(spray):
    """Verify done event is published even if retract_timer cleanup fails."""
    published = []
    spray._pub_done.publish = lambda msg: published.append(msg)

    # Simulate a retract_timer that throws on cancel → _safe_destroy_timer must
    # swallow and we still publish done.
    class ExplodingTimer:
        def cancel(self):
            raise RuntimeError("boom")
    spray._retract_timer = ExplodingTimer()
    spray._spraying = True
    spray._signal_done()
    assert spray._spraying is False
    assert len(published) == 1
    # Timer cleared
    assert spray._retract_timer is None


def test_emergency_stop_is_idempotent(spray):
    """EMERGENCY_STOP must be safe to call when no timers exist."""
    spray._spray_timer = None
    spray._retract_timer = None
    spray._on_emergency_stop(None)
    assert spray._spraying is False


def test_emergency_stop_clears_active_timers(spray):
    t1 = spray.create_timer(0.1, lambda: None)
    t2 = spray.create_timer(0.1, lambda: None)
    spray._spray_timer = t1
    spray._retract_timer = t2
    spray._spraying = True
    spray._on_emergency_stop(None)
    assert spray._spray_timer is None
    assert spray._retract_timer is None
    assert spray._spraying is False


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
    """ESTOP during a spray must publish cancelled result."""
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
    """Cancel on the wp currently spraying aborts without publishing a result."""
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._spraying = True
    spray._current_wp_idx = 4

    cancel_msg = type('M', (), {'data': 4})()
    spray._on_spray_cancel(cancel_msg)

    assert spray._spraying is False
    assert results == [], "cancel path must not publish a result — navigator already did"


def test_spray_cancel_for_stale_wp_noop(spray):
    """Cancel targeting a different wp than the one currently spraying is ignored."""
    results = []
    spray._pub_result.publish = lambda msg: results.append(msg)
    spray._spraying = True
    spray._current_wp_idx = 4

    cancel_msg = type('M', (), {'data': 2})()
    spray._on_spray_cancel(cancel_msg)

    # Active spray on wp 4 is untouched; late cancel for wp 2 is ignored.
    assert spray._spraying is True
    assert spray._current_wp_idx == 4
    assert results == []
