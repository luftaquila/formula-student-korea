"""Unit tests for the pure logic of the GPS-registration agent."""

import collections
import threading
from types import SimpleNamespace

from pilot.lib.ubx_parser import CarrierSolution, FixType

import gps_register as gr


def _pvt(fix_type, carrier=CarrierSolution.NONE):
    return SimpleNamespace(fix_type=fix_type, carrier_solution=carrier)


class TestFixStatusString:
    def test_rtk_fixed_wins_over_fix_type(self):
        assert gr.fix_status_string(
            _pvt(FixType.FIX_3D, CarrierSolution.FIXED)) == "rtk_fixed"

    def test_rtk_float(self):
        assert gr.fix_status_string(
            _pvt(FixType.FIX_3D, CarrierSolution.FLOAT)) == "rtk_float"

    def test_plain_3d_fix(self):
        assert gr.fix_status_string(_pvt(FixType.FIX_3D)) == "3d_fix"

    def test_2d_fix(self):
        assert gr.fix_status_string(_pvt(FixType.FIX_2D)) == "2d_fix"

    def test_no_fix(self):
        assert gr.fix_status_string(_pvt(FixType.NO_FIX)) == "no_fix"

    def test_dead_reckoning_maps_to_no_fix(self):
        # No IMU on this unit — DR transitions are spurious.
        assert gr.fix_status_string(_pvt(FixType.DEAD_RECKONING)) == "no_fix"


class TestBuildTelemetry:
    def test_minimal_omits_optional_keys(self):
        t = gr.build_telemetry("3d_fix", False, None, None)
        assert t == {"nav_state": "IDLE", "fix_status": "3d_fix",
                     "ntrip_connected": False}
        assert "ntrip" not in t and "gps" not in t

    def test_nav_state_always_idle(self):
        assert gr.build_telemetry("rtk_fixed", True, None, None)["nav_state"] == "IDLE"

    def test_includes_detail_when_present(self):
        ntrip = {"mountpoint": "SEoul", "fail_count": 0}
        gps = {"h_acc": 0.014, "num_sv": 21}
        t = gr.build_telemetry("rtk_fixed", True, ntrip, gps)
        assert t["ntrip"] == ntrip
        assert t["gps"] == gps
        assert t["ntrip_connected"] is True

    def test_ntrip_connected_coerced_to_bool(self):
        assert gr.build_telemetry("no_fix", 1, None, None)["ntrip_connected"] is True


class TestIterSseEvents:
    def test_parses_single_event(self):
        lines = ["event: request-position", 'data: {"request_id":"abc"}', ""]
        events = list(gr.iter_sse_events(iter(lines)))
        assert events == [("request-position", '{"request_id":"abc"}')]

    def test_skips_heartbeat_comments(self):
        lines = [": heartbeat", "event: connected", "data: {}", ""]
        events = list(gr.iter_sse_events(iter(lines)))
        assert events == [("connected", "{}")]

    def test_multiline_data_joined_with_newline(self):
        lines = ["event: x", "data: line1", "data: line2", ""]
        events = list(gr.iter_sse_events(iter(lines)))
        assert events == [("x", "line1\nline2")]

    def test_event_without_terminator_not_yielded(self):
        # No trailing blank line — event is still buffered, not emitted.
        lines = ["event: request-position", "data: {}"]
        assert list(gr.iter_sse_events(iter(lines))) == []

    def test_back_to_back_events(self):
        lines = ["event: a", "data: 1", "", "event: b", "data: 2", ""]
        assert list(gr.iter_sse_events(iter(lines))) == [("a", "1"), ("b", "2")]


class TestReportPositionFixGate:
    """_report_position must not forward a no-fix (0, 0) position — that jumps
    the operator map to Null Island (blank grey — no basemap tiles)."""

    @staticmethod
    def _agent(fix_status, last_position=None):
        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)  # skip __init__ (serial/threads)
        agent._lock = threading.Lock()
        agent._fix_status = fix_status
        agent._last_position = last_position if last_position is not None else {"lat": 35.29, "lng": 126.57, "alt": 40.0}
        agent._pending_request_ids = collections.deque(maxlen=32)
        agent._posts = []
        agent._enqueue_post = lambda path, payload, label: agent._posts.append((path, payload, label))
        return agent

    def test_no_fix_is_not_reported(self):
        for fix in (None, "no_fix", "time_only"):
            agent = self._agent(fix)
            agent._report_position()
            assert agent._posts == []

    def test_valid_fix_is_reported(self):
        for fix in ("2d_fix", "3d_fix", "rtk_float", "rtk_fixed"):
            agent = self._agent(fix)
            agent._report_position()
            assert len(agent._posts) == 1
            assert agent._posts[0][0] == "/api/rover/position"

    def test_pending_request_held_until_fix(self):
        agent = self._agent("no_fix")
        agent._pending_request_ids.append("req-1")
        agent._report_position()
        assert agent._posts == []
        assert list(agent._pending_request_ids) == ["req-1"]  # not drained — retried on recovery

        agent._fix_status = "rtk_fixed"
        agent._report_position()
        assert len(agent._posts) == 1
        assert agent._posts[0][1]["request_id"] == "req-1"
        assert list(agent._pending_request_ids) == []
