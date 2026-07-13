"""Tests for bridge_node — GPS fix gating on position reporting.

Without a fix the ZED-F9P reports lat/lng = 0, which would drag the operator
map to Null Island (blank grey — no basemap tiles). _on_gps_position must drop
positions below a 2D fix and hold the last good one (and any pending explicit
request) until the receiver recovers.
"""

import collections
import json
import time
import types

import pytest

from pilot.bridge_node import BridgeNode, _POSITION_FIX_STATUSES


class _Msg:
    """Minimal NavSatFix stand-in (only the fields _on_gps_position reads)."""

    def __init__(self, lat, lng, alt=0.0):
        self.latitude = lat
        self.longitude = lng
        self.altitude = alt


def _make_bridge(fix_status):
    # Bypass __init__ so we need neither rclpy nor a network — set only the
    # state _on_gps_position touches, and record reports instead of POSTing.
    node = BridgeNode.__new__(BridgeNode)
    node._fix_status = fix_status
    node._last_position = None
    node._position_requested = False
    node._last_report_time = 0.0
    node._reports = []
    node._report_position = lambda explicit_request=False: node._reports.append(explicit_request)
    node.get_parameter = lambda _name: types.SimpleNamespace(value=0.0)  # interval 0 → periodic always due
    return node


BAD_STATUSES = [None, "no_fix", "time_only"]
GOOD_STATUSES = ["2d_fix", "3d_fix", "rtk_float", "rtk_fixed"]


@pytest.mark.parametrize("fix", BAD_STATUSES)
def test_no_fix_position_is_dropped(fix):
    node = _make_bridge(fix)
    node._on_gps_position(_Msg(0.0, 0.0))
    assert node._last_position is None   # not cached
    assert node._reports == []           # not reported upstream


@pytest.mark.parametrize("fix", GOOD_STATUSES)
def test_valid_fix_position_is_reported(fix):
    node = _make_bridge(fix)
    node._on_gps_position(_Msg(35.292012, 126.574415, 42.0))
    assert node._last_position == {"lat": 35.292012, "lng": 126.574415, "alt": 42.0}
    assert node._reports == [False]      # periodic report fired


def test_explicit_request_waits_for_fix():
    # A pending explicit request must not be answered with a no-fix (0, 0): it
    # stays pending until a valid fix arrives (the server request has its own
    # 5s timeout), then reports immediately with explicit_request=True.
    node = _make_bridge("no_fix")
    node._position_requested = True
    node._on_gps_position(_Msg(0.0, 0.0))
    assert node._position_requested is True
    assert node._reports == []

    node._fix_status = "rtk_fixed"
    node._on_gps_position(_Msg(35.292012, 126.574415))
    assert node._position_requested is False
    assert node._reports == [True]


def test_position_fix_statuses_are_2d_and_better():
    # Guards against a typo silently letting no_fix / time_only through.
    assert _POSITION_FIX_STATUSES == frozenset(GOOD_STATUSES)
    assert "no_fix" not in _POSITION_FIX_STATUSES
    assert "time_only" not in _POSITION_FIX_STATUSES


# ── Event-driven telemetry ───────────────────────────────────────────────────
# nav_state / fix_status / ntrip-connected transitions must POST telemetry
# IMMEDIATELY (not wait up to 3s for the periodic loop), so the operator UI
# reflects RTK loss / pause / resume without the visible lag. Unchanged repeats
# must NOT re-push — that's what keeps the immediate path from flooding.

class _StrMsg:
    """Minimal std_msgs/String stand-in."""

    def __init__(self, data):
        self.data = data


def _make_telemetry_bridge():
    # Bypass __init__ (no rclpy/network); set only telemetry state and record
    # _post_async calls instead of enqueuing a real HTTP POST.
    node = BridgeNode.__new__(BridgeNode)
    node._nav_state = "IDLE"
    node._fix_status = None
    node._last_fix_push = 0.0
    node._ntrip_connected = False
    node._ntrip_detail = None
    node._battery = None
    node._gps_metrics = None
    node._post_calls = []
    node._post_async = lambda path, payload, label: node._post_calls.append((path, payload, label))
    return node


def test_nav_state_change_pushes_telemetry_immediately():
    node = _make_telemetry_bridge()
    node._on_nav_state(_StrMsg("PAUSED"))
    assert len(node._post_calls) == 1
    path, payload, label = node._post_calls[0]
    assert path == "/api/rover/telemetry"
    assert label == "telemetry"
    assert payload["nav_state"] == "PAUSED"
    # An unchanged repeat must NOT re-push (the 3s loop still carries it).
    node._on_nav_state(_StrMsg("PAUSED"))
    assert len(node._post_calls) == 1


def test_fix_status_change_pushes_immediately_then_rate_limits():
    node = _make_telemetry_bridge()
    # Cold (last push far in the past) → an isolated change pushes at once.
    node._on_fix_status(_StrMsg("rtk_fixed"))
    assert len(node._post_calls) == 1
    assert node._post_calls[0][1]["fix_status"] == "rtk_fixed"
    # A rapid flap within the interval is throttled — value cached for the 3s loop.
    node._on_fix_status(_StrMsg("rtk_float"))
    assert len(node._post_calls) == 1
    assert node._fix_status == "rtk_float"
    # An unchanged repeat never pushes, regardless of timing.
    node._last_fix_push = 0.0
    node._on_fix_status(_StrMsg("rtk_float"))
    assert len(node._post_calls) == 1
    # After the interval elapses, the next change pushes again.
    node._last_fix_push = time.monotonic() - (2 * 60)  # well past the interval
    node._on_fix_status(_StrMsg("rtk_fixed"))
    assert len(node._post_calls) == 2
    assert node._post_calls[1][1]["fix_status"] == "rtk_fixed"


def test_ntrip_connected_transition_pushes_only_on_change():
    node = _make_telemetry_bridge()
    node._on_ntrip_status(_StrMsg(json.dumps({"connected": True, "host": "x"})))
    assert len(node._post_calls) == 1
    assert node._post_calls[0][1]["ntrip_connected"] is True
    # Same connected state (detail refresh only) → no push, detail still cached.
    node._on_ntrip_status(_StrMsg(json.dumps({"connected": True, "fail_count": 2})))
    assert len(node._post_calls) == 1
    assert node._ntrip_detail["fail_count"] == 2
    # Transition to disconnected → push.
    node._on_ntrip_status(_StrMsg(json.dumps({"connected": False, "last_error": "dns"})))
    assert len(node._post_calls) == 2
    assert node._post_calls[1][1]["ntrip_connected"] is False


def test_ntrip_status_ignores_malformed_payloads():
    node = _make_telemetry_bridge()
    node._on_ntrip_status(_StrMsg("not json"))       # invalid JSON
    node._on_ntrip_status(_StrMsg("[1, 2, 3]"))      # valid JSON but not a dict
    assert node._post_calls == []
    assert node._ntrip_connected is False


# ── SSE event dispatch: manual-control validation + handler isolation ────────
# The manual-control branch used to call bare float() on the payload; a
# non-numeric throttle/steering raised out of the SSE reader loop and tore down
# the whole command channel (E-Stop included). And a NaN/inf flowed straight
# into the drive Twist. Validation + a blanket per-event try/except fix both.

class _RecordingPub:
    def __init__(self):
        self.published = []

    def publish(self, msg):
        self.published.append(msg)


def _make_sse_bridge():
    node = BridgeNode.__new__(BridgeNode)

    class _Logger:
        def info(self, *_a, **_kw): pass
        def warn(self, *_a, **_kw): pass

    node.get_logger = lambda: _Logger()
    node._pub_manual = _RecordingPub()
    return node


def test_manual_control_clamps_and_publishes():
    node = _make_sse_bridge()
    node._handle_sse_event(
        "manual-control", json.dumps({"throttle": 150.0, "steering": -250.0}))
    assert len(node._pub_manual.published) == 1
    twist = node._pub_manual.published[0]
    assert twist.linear.x == 100.0       # clamped to +100 %
    assert twist.angular.z == -100.0     # clamped to -100 %


def test_manual_control_rejects_non_numeric_without_publishing():
    node = _make_sse_bridge()
    # String / null / list / object throttle used to raise out of the bare
    # float() and kill the SSE command channel. Each must now just be dropped.
    for bad in ("fast", None, [1, 2], {"x": 1}):
        node._handle_sse_event(
            "manual-control", json.dumps({"throttle": bad, "steering": 0}))
    assert node._pub_manual.published == []


def test_manual_control_rejects_non_finite():
    node = _make_sse_bridge()
    # NaN / inf are valid floats but must never reach the drive Twist.
    node._handle_sse_event(
        "manual-control", json.dumps({"throttle": float("nan"), "steering": 0}))
    node._handle_sse_event(
        "manual-control", json.dumps({"throttle": float("inf"), "steering": 0}))
    assert node._pub_manual.published == []


def test_sse_handler_isolates_publisher_exception():
    # A raising handler must be swallowed inside _handle_sse_event so it can't
    # propagate up through _connect_sse's iter_lines loop and tear down the
    # command channel (E-Stop / clear-emergency) with it.
    node = _make_sse_bridge()

    def _boom(_msg):
        raise RuntimeError("publisher blew up")

    node._pub_manual.publish = _boom
    # Must NOT raise.
    node._handle_sse_event(
        "manual-control", json.dumps({"throttle": 10.0, "steering": 0.0}))


# ── Position reporting is async (no blocking POST on the ROS executor) ───────
# _report_position runs on the single-threaded executor (GPS callback), so a
# synchronous requests.post stalled every other subscription for up to 5 s when
# the server was down. It must enqueue via _post_async and stamp
# _last_report_time on ENQUEUE (not success) to pace the 10 Hz GPS callback.

def _make_position_bridge():
    node = BridgeNode.__new__(BridgeNode)
    node._last_position = {"lat": 35.0, "lng": 126.0, "alt": 5.0}
    node._pending_position_request_ids = collections.deque(maxlen=32)
    node._last_report_time = 0.0
    node.get_parameter = lambda _n: types.SimpleNamespace(value="https://s.example")
    node._async_calls = []
    node._post_async = lambda path, payload, label: node._async_calls.append(
        (path, payload, label))
    return node


def test_report_position_enqueues_async_and_stamps_time():
    node = _make_position_bridge()
    node._report_position()
    assert len(node._async_calls) == 1
    path, payload, label = node._async_calls[0]
    assert path == "/api/rover/position"
    assert label == "position"
    assert payload == {"lat": 35.0, "lng": 126.0, "alt": 5.0}
    # Stamped on enqueue so the periodic gate paces even while the server is down.
    assert node._last_report_time > 0.0


def test_report_position_explicit_request_drains_ids():
    node = _make_position_bridge()
    node._pending_position_request_ids.extend(["rid-1", "rid-2"])
    node._report_position(explicit_request=True)
    assert len(node._async_calls) == 1
    _, payload, _ = node._async_calls[0]
    assert payload["request_id"] == "rid-1"
    assert payload["request_ids"] == ["rid-1", "rid-2"]
    assert len(node._pending_position_request_ids) == 0   # drained on send
