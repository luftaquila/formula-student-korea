"""Tests for spray_node timer safety and done-signal guarantees."""

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
