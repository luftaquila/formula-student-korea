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
                     "ntrip_connected": False, "mode": "capture"}
        assert "ntrip" not in t and "gps" not in t and "base" not in t

    def test_includes_mode_and_base_when_given(self):
        base = {"state": "active", "rtcm_bytes": 4096}
        t = gr.build_telemetry("time_only", True, None, None, "base", base)
        assert t["mode"] == "base"
        assert t["base"] == base

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
            assert agent._posts[0][0] == "/api/rover/position?device=gps"

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


class TestSplitHp:
    def test_roundtrip_positive_lat(self):
        deg = 37.1234567891
        main, hp = gr.split_hp(round(deg * 1e9))
        assert 0 <= hp <= 99
        assert abs((main * 1e-7 + hp * 1e-9) - deg) < 1e-9

    def test_roundtrip_negative(self):
        deg = -122.9876543219
        main, hp = gr.split_hp(round(deg * 1e9))
        assert 0 <= hp <= 99
        assert abs((main * 1e-7 + hp * 1e-9) - deg) < 1e-9

    def test_height_units(self):
        # height coarse = cm, fine = 0.1 mm
        alt_m = 41.2345
        main, hp = gr.split_hp(round(alt_m * 1e4))
        assert 0 <= hp <= 99
        assert abs((main * 0.01 + hp * 0.0001) - alt_m) < 1e-4


class TestAverageSurveySamples:
    def test_none_on_empty(self):
        assert gr.average_survey_samples([]) is None

    def test_mean_of_samples(self):
        samples = [(10.0, 20.0, 30.0, 0.02), (10.2, 20.2, 32.0, 0.04)]
        lat, lon, alt, h_acc, n = gr.average_survey_samples(samples)
        assert n == 2
        assert abs(lat - 10.1) < 1e-9 and abs(lon - 20.1) < 1e-9
        assert abs(alt - 31.0) < 1e-9 and abs(h_acc - 0.03) < 1e-9

    def test_alt_hacc_optional(self):
        samples = [(1.0, 2.0, None, None), (1.0, 2.0, None, None)]
        lat, lon, alt, h_acc, n = gr.average_survey_samples(samples)
        assert alt is None and h_acc is None and n == 2


class TestConfigureBase:
    """_configure_base must emit a UBX-CFG-VALSET setting TMODE FIXED (LLH) and
    enabling the RTCM3 output messages."""

    _SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8}

    @classmethod
    def _decode_valset(cls, msg):
        assert msg[0] == 0xB5 and msg[1] == 0x62  # UBX sync
        length = msg[4] | (msg[5] << 8)
        payload = msg[6:6 + length]
        i = 4  # skip version(1) + layer(1) + reserved(2)
        out = {}
        while i + 4 <= len(payload):
            key = int.from_bytes(payload[i:i + 4], "little"); i += 4
            size = cls._SIZE[(key >> 28) & 0x07]
            out[key] = int.from_bytes(payload[i:i + size], "little"); i += size
        return out

    def test_emits_tmode_fixed_and_rtcm(self):
        class _FakeSerial:
            def __init__(self): self.written = b""
            def write(self, data): self.written += bytes(data)

        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._serial = _FakeSerial()
        agent._configure_base(37.5, 127.0, 40.0, 0.01)

        cfg = self._decode_valset(agent._serial.written)
        assert cfg[gr.CFG_TMODE_MODE] == 2       # FIXED
        assert cfg[gr.CFG_TMODE_POS_TYPE] == 1   # LLH
        assert cfg[gr.CFG_TMODE_FIXED_POS_ACC] == 100  # 0.01 m -> 100 * 0.1mm
        for key in gr._RTCM_MSGOUT_KEYS:
            assert cfg[key] == 1                 # each RTCM message enabled @1Hz

    def test_stop_disables_tmode_and_rtcm(self):
        class _FakeSerial:
            def __init__(self): self.written = b""
            def write(self, data): self.written += bytes(data)

        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._serial = _FakeSerial()
        agent._configure_base_stop()
        cfg = self._decode_valset(agent._serial.written)
        assert cfg[gr.CFG_TMODE_MODE] == 0
        for key in gr._RTCM_MSGOUT_KEYS:
            assert cfg[key] == 0

    def test_capture_config_clears_persisted_base(self):
        # Capture-mode config runs on every serial open and must clear any
        # persisted TMODE FIXED + RTCM output (BBR survives restarts), so a
        # restart after a base session can't silently report the base coordinate.
        class _FakeSerial:
            def __init__(self): self.written = b""
            def write(self, data): self.written += bytes(data)

        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._serial = _FakeSerial()
        agent._meas_rate_ms = 1000
        agent._configure_receiver()
        cfg = self._decode_valset(agent._serial.written)
        assert cfg[gr.CFG_TMODE_MODE] == 0                  # TMODE disabled
        for key in gr._RTCM_MSGOUT_KEYS:
            assert cfg[key] == 0                            # RTCM output off
        assert cfg[gr.CFG_MSGOUT_UBX_NAV_PVT_USB] == 1      # NAV output still on


class TestSurveySampleHeight:
    """Survey must record ELLIPSOIDAL height (feeds TMODE LLH), not MSL."""

    def test_on_hpposllh_collects_ellipsoidal_height(self):
        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._lock = threading.Lock()
        agent._survey = {"point_id": 1, "samples": []}
        agent._capture = None
        agent._fix_status = "rtk_fixed"
        agent._last_hpposllh = None
        agent._last_position = None
        hp = SimpleNamespace(lat=37.5, lon=127.0, height=65.0, h_msl=40.0, h_acc=0.01)
        agent._on_hpposllh(hp)
        # The sampled altitude must be the ellipsoidal height (65.0), never MSL (40.0).
        assert agent._survey["samples"] == [(37.5, 127.0, 65.0, 0.01)]

    def test_no_sample_unless_rtk_fixed(self):
        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._lock = threading.Lock()
        agent._survey = {"point_id": 1, "samples": []}
        agent._capture = None
        agent._fix_status = "rtk_float"
        agent._last_hpposllh = None
        agent._last_position = None
        agent._on_hpposllh(SimpleNamespace(lat=37.5, lon=127.0, height=65.0, h_msl=40.0, h_acc=0.5))
        assert agent._survey["samples"] == []


class TestBaseReconfigHandoff:
    """_activate_base/_deactivate_base latch _pending_reconfig (under the lock)."""

    @staticmethod
    def _agent():
        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._lock = threading.Lock()
        agent._pending_reconfig = None
        agent._base_params = None
        agent._mode = "capture"
        return agent

    def test_activate_then_deactivate(self):
        agent = self._agent()
        agent._activate_base({"lat": 37.5, "lng": 127.0, "alt": 40.0, "acc": 0.01})
        assert agent._mode == "base-output"
        assert agent._pending_reconfig == ("base", agent._base_params)
        agent._deactivate_base()
        assert agent._mode == "capture"
        assert agent._pending_reconfig == ("capture", None)
        assert agent._base_params is None

    def test_activate_ignored_without_coords(self):
        agent = self._agent()
        agent._activate_base({"lat": None, "lng": None})
        assert agent._mode == "capture"
        assert agent._pending_reconfig is None


class TestNtripWorkerBaseGuard:
    """The NGII setup worker must not start a client once we are a base station
    (mirrors gps_node._ntrip_setup_worker) — else it leaks a live NGII client."""

    def test_worker_aborts_in_base_output(self, monkeypatch):
        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._lock = threading.Lock()
        agent._mode = "base-output"
        agent._ntrip = None
        agent._serial = object()
        agent._ntrip_username = "user"
        called = {"fetch": False}

        def _boom(*_a, **_kw):
            called["fetch"] = True
            raise AssertionError("must not fetch the source table in base mode")

        monkeypatch.setattr(gr, "fetch_source_table", _boom)
        agent._ntrip_setup_worker(37.5, 127.0, agent._serial)
        assert agent._ntrip is None
        assert called["fetch"] is False


class TestEvaluateCapture:
    """Cone capture only resolves on enough STABLE rtk_fixed samples."""

    def test_none_when_too_few(self):
        assert gr.evaluate_capture([(37.0, 127.0, 30.0, 0.01)], min_samples=15) is None

    def test_averages_when_stable(self):
        # 20 samples within ~1cm of each other -> stable, returns the mean.
        samples = [(37.5 + i * 1e-8, 127.0 + i * 1e-8, 30.0, 0.01) for i in range(20)]
        res = gr.evaluate_capture(samples, min_samples=15, max_dev_m=0.03)
        assert res is not None
        lat, lng, alt = res
        assert abs(lat - 37.5) < 1e-6 and abs(lng - 127.0) < 1e-6

    def test_none_when_moving(self):
        # 20 samples but one is ~10 m away -> not stable -> None.
        samples = [(37.5, 127.0, 30.0, 0.01) for _ in range(19)]
        samples.append((37.5001, 127.0, 30.0, 0.01))  # ~11 m north
        assert gr.evaluate_capture(samples, min_samples=15, max_dev_m=0.03) is None


class TestEvaluateSurvey:
    """Base survey accepts a coordinate only with enough tightly-clustered
    rtk_fixed samples; otherwise it returns a reason string."""

    def test_insufficient_when_too_few(self):
        samples = [(37.5, 127.0, 30.0, 0.01) for _ in range(5)]
        assert gr.evaluate_survey(samples, min_samples=60) == "insufficient_samples"

    def test_unstable_when_scattered(self):
        # 100 samples but spread over ~100 m → RMS far exceeds the threshold.
        samples = [(37.5 + i * 1e-5, 127.0, 30.0, 0.01) for i in range(100)]
        assert gr.evaluate_survey(samples, min_samples=60, max_std_m=0.10) == "unstable"

    def test_mean_when_enough_and_tight(self):
        samples = [(37.5 + i * 1e-9, 127.0 + i * 1e-9, 30.0, 0.01) for i in range(80)]
        res = gr.evaluate_survey(samples, min_samples=60, max_std_m=0.10)
        assert not isinstance(res, str)
        lat, lon, alt, h_acc, n, std = res
        assert n == 80 and std < 0.10
        assert abs(lat - 37.5) < 1e-6 and abs(lon - 127.0) < 1e-6


class TestSurveyWorkerReporting:
    """_survey_worker must POST an explicit result on completion — success with
    the averaged coordinate, or an ok:false failure when the quality gate fails."""

    @staticmethod
    def _agent():
        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._lock = threading.Lock()
        agent._running = True
        agent._mode = "base-survey"
        agent._posts = []
        agent._enqueue_post = lambda path, payload, label: agent._posts.append((path, payload, label))
        return agent

    def test_reports_failure_on_zero_samples(self):
        agent = self._agent()
        agent._survey = {"point_id": 7, "samples": []}
        agent._survey_worker(7, 0)  # duration 0 → finalize immediately
        assert len(agent._posts) == 1
        path, payload, _ = agent._posts[0]
        assert path == "/api/rover/base/survey-result"
        assert payload["point_id"] == 7 and payload["ok"] is False
        assert payload["error"] == "insufficient_samples"
        assert agent._mode == "capture"

    def test_reports_failure_on_too_few_samples(self):
        agent = self._agent()
        # Some rtk_fixed samples, but below the survey minimum → still a failure.
        agent._survey = {"point_id": 5, "samples": [
            (37.0, 127.0, 30.0, 0.01) for _ in range(10)
        ]}
        agent._survey_worker(5, 0)
        _, payload, _ = agent._posts[0]
        assert payload["ok"] is False and payload["error"] == "insufficient_samples"
        assert payload["samples"] == 10

    def test_reports_failure_on_unstable(self):
        agent = self._agent()
        # Enough samples, but scattered over metres → "unstable".
        samples = [(37.0, 127.0, 30.0, 0.01) for _ in range(80)]
        samples += [(37.0 + i * 1e-5, 127.0, 30.0, 0.01) for i in range(20)]
        agent._survey = {"point_id": 6, "samples": samples}
        agent._survey_worker(6, 0)
        _, payload, _ = agent._posts[0]
        assert payload["ok"] is False and payload["error"] == "unstable"

    def test_reports_success_with_average(self):
        agent = self._agent()
        # 80 tightly-clustered rtk_fixed samples → passes the quality gate.
        agent._survey = {"point_id": 3, "samples": [
            (37.1 + i * 1e-9, 127.1 + i * 1e-9, 30.0, 0.01) for i in range(80)
        ]}
        agent._survey_worker(3, 0)
        assert len(agent._posts) == 1
        _, payload, _ = agent._posts[0]
        assert payload["ok"] is True and payload["samples"] == 80
        assert abs(payload["lat"] - 37.1) < 1e-6 and abs(payload["lng"] - 127.1) < 1e-6
        assert payload["std_m"] < gr.SURVEY_MAX_STD_M
