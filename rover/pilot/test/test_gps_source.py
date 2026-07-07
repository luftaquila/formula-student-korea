"""Tests for gps_node correction-source switching + RTCM injection.

Relies on the ROS/hardware stubs installed by conftest.py.
"""

import base64
from types import SimpleNamespace

from std_msgs.msg import String
from pilot.gps_node import GpsNode
from pilot.lib.ubx_parser import FixType


class _CapturingSerial:
    def __init__(self):
        self.written = b""
        self.in_waiting = 0

    def write(self, data):
        self.written += bytes(data)
        return len(data)

    def read(self, *_a, **_kw):
        return b""

    def close(self):
        pass


def _node():
    node = GpsNode()
    node._serial = _CapturingSerial()
    return node


def _msg(data):
    m = String()
    m.data = data
    return m


def test_default_source_is_ngii():
    assert _node()._ntrip_source == "ngii"


def test_switch_to_base_suppresses_ngii_setup():
    node = _node()
    node._on_ntrip_source(_msg("base"))
    assert node._ntrip_source == "base"
    # With base selected, NTRIP auto-setup must NOT start even at a 3D fix.
    node._ntrip = None
    node._maybe_setup_ntrip(SimpleNamespace(fix_type=FixType.FIX_3D, lat=37.5, lon=127.0))
    assert node._ntrip is None


def test_switch_back_to_ngii_resets_retry():
    node = _node()
    node._on_ntrip_source(_msg("base"))
    node._ntrip_last_attempt = 12345.0
    node._on_ntrip_source(_msg("ngii"))
    assert node._ntrip_source == "ngii"
    assert node._ntrip_last_attempt == 0.0


def test_unknown_source_ignored():
    node = _node()
    node._on_ntrip_source(_msg("garbage"))
    assert node._ntrip_source == "ngii"


def test_rtcm_inject_writes_decoded_bytes_to_serial():
    node = _node()
    raw = bytes([0xD3, 0x00, 0x04, 0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22])
    node._on_rtcm_inject(_msg(base64.b64encode(raw).decode("ascii")))
    assert node._serial.written == raw


def test_rtcm_inject_bad_base64_is_ignored():
    node = _node()
    node._on_rtcm_inject(_msg("!!!not base64!!!"))
    assert node._serial.written == b""


def test_rtcm_inject_empty_is_noop():
    node = _node()
    node._on_rtcm_inject(_msg(""))
    assert node._serial.written == b""


def test_ntrip_setup_worker_aborts_in_base_mode(monkeypatch):
    # If the operator switched to base, the NGII setup worker must not start a
    # client (and must early-return before any network fetch).
    node = _node()
    node._ntrip_source = "base"
    node._ntrip = None
    called = {"fetch": False}

    def _boom(*_a, **_kw):
        called["fetch"] = True
        raise AssertionError("must not fetch the source table in base mode")

    monkeypatch.setattr("pilot.gps_node.fetch_source_table", _boom)
    node._ntrip_setup_worker(37.5, 127.0, "user", 10.0, node._serial)
    assert node._ntrip is None
    assert called["fetch"] is False
