"""Unit tests for the pure logic of the GPS-registration agent."""

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
