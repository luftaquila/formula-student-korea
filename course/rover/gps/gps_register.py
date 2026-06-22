#!/usr/bin/env python3
"""FSK GPS-registration agent — ROS-free rover stand-in for cone surveying.

A lightweight single-process alternative to the full ROS 2 pilot, built
for a Raspberry Pi Zero 2 W carried around the track to register cone
coordinates. It does exactly the slice of the rover the course server
needs for coordinate capture:

  * read the u-blox ZED-F9P over USB (UBX NAV-PVT / NAV-HPPOSLLH / NAV-DOP),
  * stream NGII NTRIP RTCM3 corrections back to the receiver for RTK,
  * hold an SSE connection to the course server (`/api/rover/stream`) and
    answer `request-position` events with the current fix,
  * periodically POST position + telemetry so the operator UI shows the
    live marker and RTK fix quality.

It deliberately reuses the pilot's pure, ROS-free modules (UBX parser,
NTRIP client, geo utils) rather than duplicating them — see the sys.path
shim below. No ROS, no podman: just python3 + pyserial + requests under a
systemd unit.

The course server keeps a SINGLE rover slot, so run EITHER the full rover
OR this GPS unit against a given server at a time — both authenticate with
the same INTERNAL_SECRET and would otherwise kick each other off.

Config (all via environment, see systemd/gps-register.service):
    SERVER_URL              required, e.g. https://host/course
    INTERNAL_SECRET         required, X-Internal-Service header
    NTRIP_USERNAME          optional NGII login; absent ⇒ run without RTK
    GPS_SERIAL_PORT         default /dev/ttyGPS
    GPS_BAUD                default 115200
    GPS_MEAS_RATE_MS        receiver fix period, default 1000 (1 Hz)
    POSITION_REPORT_INTERVAL  seconds between periodic position POSTs (1.0)
    SERVER_URL_ALLOW_HTTP   "true" to permit http:// (trusted Tailscale only)
"""

import json
import logging
import os
import queue
import sys
import threading
import time

import serial
import requests

# Import the pilot's pure (ROS-free) helpers without duplicating them.
# Two layouts are supported: the in-repo tree (this file at
# course/rover/gps/, pilot package one dir over at ../pilot/pilot) and the
# on-rover deploy (/opt/gps-register/ with the lib files copied to
# /opt/gps-register/pilot/lib by provision-gps.sh). In both, the package
# *root* that makes `import pilot.lib.*` resolve is what we add to sys.path.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _cand in (_HERE, os.path.join(_HERE, os.pardir, "pilot")):
    if os.path.isdir(os.path.join(_cand, "pilot", "lib")):
        sys.path.insert(0, os.path.abspath(_cand))
        break

from pilot.lib.ubx_parser import (  # noqa: E402
    UBXParser, NavPVT, NavHPPOSLLH, NavDOP,
    CarrierSolution, FixType, build_cfg_valset,
)
from pilot.lib.ntrip_client import (  # noqa: E402
    NTRIPClient, fetch_source_table, parse_source_table, select_nearest_mountpoint,
)
from pilot.lib.protocol_utils import assemble_sse_data  # noqa: E402

log = logging.getLogger("gps-register")

# NGII (국토지리정보원) caster — protocol-level constants, mirror gps_node.py.
NTRIP_HOST = "www.gnssdata.or.kr"
NTRIP_PORT = 2101
NTRIP_PASSWORD = "gnss"
NTRIP_SETUP_COOLDOWN_S = 30.0

# UBX-CFG-VALSET key IDs (USB message-output toggles + measurement rate),
# mirror gps_node.py so this unit and the rover configure the F9P identically.
CFG_RATE_MEAS = 0x30210001
CFG_MSGOUT_UBX_NAV_PVT_USB = 0x20910009
CFG_MSGOUT_UBX_NAV_HPPOSLLH_USB = 0x20910036
CFG_MSGOUT_UBX_NAV_DOP_USB = 0x20910041
CFG_MSGOUT_NMEA_GGA_USB = 0x209100BD
CFG_MSGOUT_NMEA_RMC_USB = 0x209100AE
CFG_MSGOUT_NMEA_GSV_USB = 0x209100C4
CFG_MSGOUT_NMEA_GSA_USB = 0x209100C1
CFG_MSGOUT_NMEA_GLL_USB = 0x209100CA
CFG_MSGOUT_NMEA_VTG_USB = 0x209100B3

_SERIAL_OPEN_RETRIES = 6
_SERIAL_OPEN_BACKOFF_S = 2.0


def fix_status_string(pvt):
    """NavPVT → human-readable fix status. RTK carrier solution wins over a
    plain 3D fix; DR variants map to no_fix (the F9P has no IMU here).
    Mirrors gps_node._fix_status_string so the UI sees identical strings."""
    if pvt.carrier_solution == CarrierSolution.FIXED:
        return "rtk_fixed"
    if pvt.carrier_solution == CarrierSolution.FLOAT:
        return "rtk_float"
    return {
        FixType.NO_FIX: "no_fix",
        FixType.DEAD_RECKONING: "no_fix",
        FixType.FIX_2D: "2d_fix",
        FixType.FIX_3D: "3d_fix",
        FixType.GNSS_DR: "no_fix",
        FixType.TIME_ONLY: "time_only",
    }.get(pvt.fix_type, "no_fix")


def build_telemetry(fix_status, ntrip_connected, ntrip_detail, gps_metrics):
    """Assemble the /api/rover/telemetry payload. nav_state is always IDLE —
    this unit never drives, and IDLE keeps the server's mission lifecycle a
    no-op. Omits keys the server treats as "not reported" (battery)."""
    payload = {
        "nav_state": "IDLE",
        "fix_status": fix_status,
        "ntrip_connected": bool(ntrip_connected),
    }
    if ntrip_detail is not None:
        payload["ntrip"] = ntrip_detail
    if gps_metrics is not None:
        payload["gps"] = gps_metrics
    return payload


def iter_sse_events(line_iter):
    """Yield (event, data) from an SSE line iterator (requests iter_lines).

    Implements the slice of the event-stream spec the course server uses:
    `event:` / `data:` lines terminated by a blank line; `:` comment lines
    (heartbeats) are skipped. Multi-line data is joined per assemble_sse_data.
    """
    event_name = None
    data_lines = []
    for line in line_iter:
        if line is None:
            continue
        if line.startswith("event: "):
            event_name = line[7:]
            data_lines = []
        elif line.startswith("data: "):
            data_lines.append(line[6:])
        elif line == "data:":
            data_lines.append("")
        elif line.startswith(":"):
            continue
        elif line == "":
            if event_name:
                yield event_name, assemble_sse_data(data_lines)
            event_name = None
            data_lines = []


class GpsRegisterAgent:
    """Owns the receiver, NTRIP client, and the server SSE/REST bridge."""

    def __init__(self, server_url, internal_secret, ntrip_username,
                 serial_port="/dev/ttyGPS", baud=115200, meas_rate_ms=1000,
                 report_interval=1.0):
        self._url = server_url.rstrip("/")
        self._secret = internal_secret
        self._ntrip_username = ntrip_username or ""
        self._port = serial_port
        self._baud = baud
        self._meas_rate_ms = meas_rate_ms
        self._report_interval = report_interval

        self._parser = UBXParser()
        self._serial = None
        self._ntrip = None
        self._ntrip_last_attempt = 0.0

        self._lock = threading.Lock()
        self._last_position = None     # {'lat','lng'}
        self._last_pvt = None
        self._last_hpposllh = None
        self._last_dop = None
        self._fix_status = None
        self._gps_metrics = None
        # Default False (not None): the first telemetry POST tells the server
        # "no NTRIP this session" so it clears any stale cached mountpoint.
        self._ntrip_connected = False
        self._ntrip_detail = None
        self._pending_request_ids = []

        self._running = True
        self._last_report_time = 0.0
        self._post_queue = queue.Queue(maxsize=64)
        # Separate sessions per thread: the SSE reader holds one long-lived
        # streaming connection while the post worker fires short POSTs. Not
        # sharing one Session across the two threads keeps connection reuse
        # clean (mirrors bridge_node's split).
        self._post_session = requests.Session()
        self._sse_session = requests.Session()

    # ---- HTTP plumbing -------------------------------------------------

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self._secret:
            h["X-Internal-Service"] = self._secret
        return h

    def _enqueue_post(self, path, payload, label):
        try:
            self._post_queue.put_nowait((path, payload, label))
        except queue.Full:
            log.warning("%s: post queue full, dropping", label)

    def _post_loop(self):
        while self._running:
            try:
                item = self._post_queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if item is None:
                break
            path, payload, label = item
            try:
                resp = self._post_session.post(
                    f"{self._url}{path}", json=payload,
                    headers=self._headers(), timeout=5.0,
                )
                if resp.status_code != 200:
                    log.warning("%s POST -> %s", label, resp.status_code)
            except requests.RequestException as exc:
                log.warning("%s POST error: %s", label, exc)

    # ---- receiver ------------------------------------------------------

    def _open_serial(self):
        last_exc = None
        for attempt in range(1, _SERIAL_OPEN_RETRIES + 1):
            try:
                self._serial = serial.Serial(self._port, self._baud, timeout=0.1)
                log.info("opened GPS serial %s @ %d", self._port, self._baud)
                return
            except serial.SerialException as exc:
                last_exc = exc
                log.warning("GPS serial open failed (%s, %d/%d): %s",
                            self._port, attempt, _SERIAL_OPEN_RETRIES, exc)
                if attempt < _SERIAL_OPEN_RETRIES:
                    time.sleep(_SERIAL_OPEN_BACKOFF_S)
        raise last_exc

    def _configure_receiver(self):
        """Enable UBX NAV-PVT/HPPOSLLH/DOP on USB, disable NMEA, set fix rate."""
        cfg = build_cfg_valset([
            (CFG_RATE_MEAS, self._meas_rate_ms, "H"),
            (CFG_MSGOUT_UBX_NAV_PVT_USB, 1, "B"),
            (CFG_MSGOUT_UBX_NAV_HPPOSLLH_USB, 1, "B"),
            (CFG_MSGOUT_UBX_NAV_DOP_USB, 1, "B"),
            (CFG_MSGOUT_NMEA_GGA_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_RMC_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_GSV_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_GSA_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_GLL_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_VTG_USB, 0, "B"),
        ])
        self._serial.write(cfg)
        log.info("ZED-F9P configured for UBX output @ %d ms", self._meas_rate_ms)

    def _teardown_serial(self):
        if self._ntrip is not None:
            try:
                self._ntrip.stop()
            except Exception:
                pass
            self._ntrip = None
            self._ntrip_last_attempt = 0.0
        try:
            if self._serial is not None:
                self._serial.close()
        except Exception:
            pass
        self._serial = None

    def _maybe_setup_ntrip(self, lat, lon, fix_type):
        """Start NTRIP once a 3D fix lets us pick the nearest base station.
        No-op without an operator NGII login (runs without RTK then)."""
        if self._ntrip is not None or not self._ntrip_username:
            return
        if fix_type < FixType.FIX_3D:
            return
        now = time.monotonic()
        if now - self._ntrip_last_attempt < NTRIP_SETUP_COOLDOWN_S:
            return
        self._ntrip_last_attempt = now
        threading.Thread(target=self._ntrip_setup_worker,
                         args=(lat, lon, self._serial), daemon=True).start()

    def _ntrip_setup_worker(self, lat, lon, serial_ref):
        try:
            table = fetch_source_table(NTRIP_HOST, NTRIP_PORT)
        except Exception as exc:
            log.warning("NTRIP source table fetch failed: %s — retry in %.0fs",
                        exc, NTRIP_SETUP_COOLDOWN_S)
            return
        entries = parse_source_table(table)
        mount = select_nearest_mountpoint(lat, lon, entries) if entries else None
        if not mount:
            log.warning("NTRIP: no RTCM 3.2 mount near (%.5f, %.5f) — retry in %.0fs",
                        lat, lon, NTRIP_SETUP_COOLDOWN_S)
            return
        with self._lock:
            if self._ntrip is not None or self._serial is not serial_ref:
                return
            log.info('NTRIP: auto-selected "%s" for (%.5f, %.5f)', mount, lat, lon)
            client = NTRIPClient(
                host=NTRIP_HOST, port=NTRIP_PORT, mountpoint=mount,
                username=self._ntrip_username, password=NTRIP_PASSWORD,
                serial_port=serial_ref, lat=lat, lon=lon, logger=log,
            )
            self._ntrip = client
        client.start()

    def _on_nav_pvt(self, pvt):
        metrics = self._metrics_from(pvt)
        with self._lock:
            self._last_pvt = pvt
            self._fix_status = fix_status_string(pvt)
            self._gps_metrics = metrics
            # NAV-PVT position is the fallback until the first HPPOSLLH.
            if self._last_hpposllh is None:
                self._last_position = {"lat": pvt.lat, "lng": pvt.lon}
        self._maybe_setup_ntrip(pvt.lat, pvt.lon, pvt.fix_type)
        if self._ntrip:
            self._ntrip.update_position(pvt.lat, pvt.lon)

    def _on_hpposllh(self, hp):
        with self._lock:
            self._last_hpposllh = hp
            self._last_position = {"lat": hp.lat, "lng": hp.lon}

    def _metrics_from(self, pvt):
        """Build the telemetry `gps` block, preferring HPPOSLLH/DOP detail."""
        hp = self._last_hpposllh
        dop = self._last_dop
        h_acc = hp.h_acc if hp else pvt.h_acc
        v_acc = hp.v_acc if hp else pvt.v_acc
        altitude = hp.h_msl if hp else pvt.h_msl
        return {
            "h_acc": h_acc,
            "v_acc": v_acc,
            "altitude": altitude,
            "speed": pvt.ground_speed,
            "heading": pvt.heading if pvt.ground_speed >= 1.5 else None,
            "num_sv": pvt.num_sv,
            "pdop": dop.p_dop if dop else pvt.p_dop,
            "tdop": dop.t_dop if dop else None,
        }

    def _serial_loop(self):
        """Read + parse UBX; periodic position reporting. Reopens on drop."""
        while self._running:
            if self._serial is None:
                try:
                    self._open_serial()
                    self._configure_receiver()
                except (serial.SerialException, OSError) as exc:
                    log.warning("GPS serial (re)open failed: %s", exc)
                    time.sleep(_SERIAL_OPEN_BACKOFF_S)
                    continue
            try:
                data = self._serial.read(self._serial.in_waiting or 1)
            except (serial.SerialException, OSError) as exc:
                log.error("serial read error: %s — closing for reopen", exc)
                self._teardown_serial()
                continue
            if data:
                for msg in self._parser.feed(data):
                    if isinstance(msg, NavPVT):
                        self._on_nav_pvt(msg)
                    elif isinstance(msg, NavHPPOSLLH):
                        self._on_hpposllh(msg)
                    elif isinstance(msg, NavDOP):
                        with self._lock:
                            self._last_dop = msg
            now = time.monotonic()
            if now - self._last_report_time >= self._report_interval:
                self._report_position()
                self._last_report_time = now

    def _report_position(self, request_ids=None):
        with self._lock:
            if not self._last_position:
                return
            payload = dict(self._last_position)
            if request_ids is None and self._pending_request_ids:
                request_ids = self._pending_request_ids
                self._pending_request_ids = []
        if request_ids:
            payload["request_id"] = request_ids[0]
            payload["request_ids"] = request_ids
        self._enqueue_post("/api/rover/position", payload,
                           "position(req)" if request_ids else "position")

    # ---- server SSE/telemetry -----------------------------------------

    def _telemetry_loop(self):
        while self._running:
            time.sleep(3.0)
            with self._lock:
                ntrip_connected = self._ntrip.connected if self._ntrip else False
                ntrip_detail = self._ntrip_detail_locked()
                payload = build_telemetry(
                    self._fix_status, ntrip_connected, ntrip_detail, self._gps_metrics,
                )
            self._enqueue_post("/api/rover/telemetry", payload, "telemetry")

    def _ntrip_detail_locked(self):
        if not self._ntrip:
            return None
        n = self._ntrip
        return {
            "host": n.host, "port": n.port, "mountpoint": n.mountpoint,
            "fail_count": n.fail_count, "last_error": n.last_error,
            "last_correction_at": n.last_correction_at,
            "bytes_received": n.bytes_received,
        }

    def _sse_loop(self):
        delay = 3.0
        while self._running:
            try:
                if self._connect_sse():
                    delay = 3.0
            except requests.RequestException as exc:
                log.warning("SSE connection error: %s", exc)
            if self._running:
                log.info("SSE reconnecting in %.0fs", delay)
                time.sleep(delay)
                delay = min(delay * 2, 30.0)

    def _connect_sse(self):
        headers = self._headers()
        headers["Accept"] = "text/event-stream"
        headers["Cache-Control"] = "no-cache"
        resp = self._sse_session.get(
            f"{self._url}/api/rover/stream", headers=headers,
            # connect, read. Server heartbeat is 10s; 25s read timeout detects a
            # dead socket (Wi-Fi drop, no FIN/RST) in ~25s instead of ~90s.
            stream=True, timeout=(5.0, 25.0),
        )
        resp.raise_for_status()
        log.info("SSE connected to %s", self._url)
        try:
            for event, data in iter_sse_events(resp.iter_lines(decode_unicode=True)):
                if not self._running:
                    break
                self._handle_event(event, data)
        finally:
            resp.close()
        return True

    def _handle_event(self, event, data):
        if event == "request-position":
            try:
                payload = json.loads(data) if data else {}
            except json.JSONDecodeError:
                log.warning("bad request-position JSON: %s", data)
                return
            rid = payload.get("request_id")
            if isinstance(rid, str) and rid:
                with self._lock:
                    self._pending_request_ids.append(rid[:64])
            self._report_position()
        # All other rover commands (execute-path, manual-control, calibrate-*)
        # are no-ops for a survey unit: it has no motors/MCU to drive.

    # ---- lifecycle -----------------------------------------------------

    def run(self):
        workers = [
            threading.Thread(target=self._post_loop, daemon=True),
            threading.Thread(target=self._sse_loop, daemon=True),
            threading.Thread(target=self._telemetry_loop, daemon=True),
        ]
        for w in workers:
            w.start()
        try:
            self._serial_loop()
        finally:
            self.stop()

    def stop(self):
        self._running = False
        if self._ntrip:
            try:
                self._ntrip.stop()
            except Exception:
                pass
        if self._serial:
            try:
                self._serial.close()
            except Exception:
                pass


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    server_url = os.environ.get("SERVER_URL", "").strip()
    internal_secret = os.environ.get("INTERNAL_SECRET", "").strip()
    ntrip_username = os.environ.get("NTRIP_USERNAME", "").strip()
    allow_http = os.environ.get("SERVER_URL_ALLOW_HTTP", "").lower() == "true"

    if not server_url:
        log.error("SERVER_URL is required"); raise SystemExit(2)
    if not internal_secret:
        log.error("INTERNAL_SECRET is required"); raise SystemExit(2)
    if not server_url.startswith("https://") and not allow_http:
        log.error("SERVER_URL must be https:// (got %r); set "
                  "SERVER_URL_ALLOW_HTTP=true for trusted internal networks",
                  server_url)
        raise SystemExit(2)
    if not ntrip_username:
        log.warning("NTRIP_USERNAME unset — running WITHOUT RTK corrections")

    agent = GpsRegisterAgent(
        server_url=server_url,
        internal_secret=internal_secret,
        ntrip_username=ntrip_username,
        serial_port=os.environ.get("GPS_SERIAL_PORT", "/dev/ttyGPS"),
        baud=int(os.environ.get("GPS_BAUD", "115200")),
        meas_rate_ms=int(os.environ.get("GPS_MEAS_RATE_MS", "1000")),
        report_interval=float(os.environ.get("POSITION_REPORT_INTERVAL", "1.0")),
    )
    log.info("GPS-registration agent starting (server=%s, rtk=%s)",
             server_url, "on" if ntrip_username else "off")
    try:
        agent.run()
    except KeyboardInterrupt:
        agent.stop()


if __name__ == "__main__":
    main()
