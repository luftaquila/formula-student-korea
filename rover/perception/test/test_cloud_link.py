"""Tests for the pure control-dispatch parts of cloud_link.py (no network).

The detect-on/off control events drive the `detect_wanted` Event that the
perception node ANDs into its obstacle-detection gate, so the operator's live
proximity-detection toggle takes effect without a restart."""

import cloud_link  # perception dir is on sys.path when pytest runs from there


def _link():
    return cloud_link.CloudLink("http://server.invalid", "secret", log=lambda *_: None)


def test_detect_wanted_defaults_off():
    # Default cleared: detection is opt-in per mission, so a rover whose server
    # never signals stays off rather than auto-pausing unexpectedly. The server
    # re-syncs the stored state on every control (re)connect.
    assert _link().detect_wanted.is_set() is False


def test_detect_off_then_on_toggles_the_event():
    link = _link()
    link._dispatch("detect-off", "")
    assert link.detect_wanted.is_set() is False
    link._dispatch("detect-on", "")
    assert link.detect_wanted.is_set() is True


def test_detect_dispatch_does_not_touch_stream_or_depth_gates():
    # The detection toggle is orthogonal to the stream / depth-composite gates.
    link = _link()
    link._dispatch("detect-off", "")
    assert link.stream_wanted.is_set() is False   # default clear, untouched
    assert link.depth_wanted.is_set() is False
