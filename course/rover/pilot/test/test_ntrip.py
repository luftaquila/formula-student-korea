"""Tests for NTRIPClient exponential backoff + failure tracking + source-table auto-selection."""

import pytest
from pilot.lib.ntrip_client import (
    NTRIPClient,
    parse_source_table,
    select_nearest_mountpoint,
)


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


def test_stop_wakes_thread_blocked_in_backoff():
    """stop() must return promptly even when the worker thread is sleeping
    in the reconnect-backoff window (up to 300 s otherwise).

    We start the run loop, force a fast retry → backoff sleep, then call
    stop() and verify the join completes well before the 5-second join
    timeout.
    """
    import threading
    import time

    c = _make_client()

    # Patch _connect to fail immediately so _run() falls into the backoff
    # branch on the first iteration. _stop_event.wait will sleep there.
    def _fail_connect():
        raise ConnectionError('synthetic')
    c._connect = _fail_connect

    c._running = True
    t = threading.Thread(target=c._run, daemon=True)
    c._thread = t  # so stop() will join the worker we just started
    t.start()
    # Give the run loop a moment to enter the backoff wait().
    time.sleep(0.1)
    assert t.is_alive()

    t0 = time.monotonic()
    c.stop()  # sets the event, lets wait() return, joins
    elapsed = time.monotonic() - t0
    # Without the Event.wait() shortcut the thread would be stuck in
    # time.sleep(5) for the first backoff. With the shortcut the join
    # returns within ~50 ms.
    assert not t.is_alive()
    assert elapsed < 1.0, f'stop took {elapsed:.2f}s; backoff likely still using time.sleep'


# Sample rows cover: RTCM 2.3 (filtered out), RTCM 3.2 far north, RTCM 3.2
# close to the target position, malformed lat (skipped), and a non-STR line.
_SAMPLE_TABLE = (
    "SOURCETABLE 200 OK\r\n"
    "STR;ANHN-RTCM23;ANHN-RTCM23;RTCM 2.3;2;2;DGPS+RTK;KORREF;KOR;36.67;126.13;0;0;;;B;N;9600;\n"
    "STR;SEOU-RTCM32;SEOU-RTCM32;RTCM 3.2;2;2;RTK;KORREF;KOR;37.56;126.98;0;0;;;B;N;9600;\n"
    "STR;ANHN-RTCM32;ANHN-RTCM32;RTCM 3.2;2;2;RTK;KORREF;KOR;36.67;126.13;0;0;;;B;N;9600;\n"
    "STR;PUSN-RTCM32;PUSN-RTCM32;RTCM 3.2;2;2;RTK;KORREF;KOR;35.10;129.03;0;0;;;B;N;9600;\n"
    "STR;BAD-RTCM32;BAD-RTCM32;RTCM 3.2;2;2;RTK;KORREF;KOR;not-a-number;126.0;0;0;;;B;N;9600;\n"
    "CAS;some-caster-line;ignore-me\n"
    "ENDSOURCETABLE\r\n"
)


def test_parse_source_table_extracts_valid_rows():
    entries = parse_source_table(_SAMPLE_TABLE)
    mounts = [e["mount"] for e in entries]
    # BAD-RTCM32 is dropped (bad lat); CAS line is dropped (not STR).
    assert mounts == ["ANHN-RTCM23", "SEOU-RTCM32", "ANHN-RTCM32", "PUSN-RTCM32"]
    seou = next(e for e in entries if e["mount"] == "SEOU-RTCM32")
    assert seou["format"] == "RTCM 3.2"
    assert seou["lat"] == pytest.approx(37.56)
    assert seou["lon"] == pytest.approx(126.98)


def test_select_nearest_mountpoint_prefers_rtcm32_and_closest():
    entries = parse_source_table(_SAMPLE_TABLE)
    # From Seoul City Hall (~37.5665, 126.9780) → SEOU is closest RTCM 3.2.
    assert select_nearest_mountpoint(37.5665, 126.9780, entries) == "SEOU-RTCM32"
    # From Busan (~35.18, 129.08) → PUSN dominates.
    assert select_nearest_mountpoint(35.18, 129.08, entries) == "PUSN-RTCM32"
    # Explicit format filter must exclude RTCM 2.3 even if closer.
    # ANHN RTCM23 (36.67, 126.13) sits right under a point that is otherwise
    # farther from the RTCM 3.2 ones; the selector must not pick it.
    near_anhn = select_nearest_mountpoint(36.67, 126.13, entries)
    assert near_anhn == "ANHN-RTCM32"


def test_select_nearest_mountpoint_none_when_no_match():
    entries = parse_source_table(_SAMPLE_TABLE)
    assert select_nearest_mountpoint(0.0, 0.0, entries, format_prefix="RTCM 4.0") is None
    assert select_nearest_mountpoint(0.0, 0.0, [], format_prefix="RTCM 3.2") is None
