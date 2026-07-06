"""Tests for bridge_node — GPS fix gating on position reporting.

Without a fix the ZED-F9P reports lat/lng = 0, which would drag the operator
map to Null Island (blank grey — no basemap tiles). _on_gps_position must drop
positions below a 2D fix and hold the last good one (and any pending explicit
request) until the receiver recovers.
"""

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
