"""Tests for NTRIPClient exponential backoff + failure tracking."""

import pytest
from pilot.lib.ntrip_client import NTRIPClient


class _DummySerial:
    def write(self, data):  # pragma: no cover
        return len(data)


def _make_client(logger=None):
    return NTRIPClient(
        host='example.invalid',
        port=2101,
        mountpoint='TEST',
        username='u',
        password='p',
        serial_port=_DummySerial(),
        logger=logger,
    )


def test_initial_state():
    c = _make_client()
    assert c.connected is False
    assert c.fail_count == 0
    assert c.last_error is None


def test_custom_logger_warn_called(monkeypatch):
    calls = []

    class FakeLogger:
        def warn(self, msg):
            calls.append(('warn', msg))
        def info(self, msg):
            calls.append(('info', msg))

    c = _make_client(FakeLogger())
    c._log_warn('boom')
    c._log_info('hi')
    assert calls == [('warn', 'boom'), ('info', 'hi')]


def test_backoff_delay_progression():
    """Exponential backoff: 5, 10, 20, 40, 80, 160, 300 (cap)."""
    c = _make_client()
    delays = []
    for fail in range(1, 9):
        c._fail_count = fail
        base = 5.0
        delay = min(base * (2 ** max(0, min(c._fail_count - 1, 6))), 300.0)
        delays.append(delay)
    assert delays[:4] == [5.0, 10.0, 20.0, 40.0]
    assert delays[-1] == 300.0  # capped


def test_gga_interval_default():
    c = _make_client()
    assert c._gga_interval == 10.0
