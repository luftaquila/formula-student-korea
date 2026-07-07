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
NTRIP client, geo utils, RTCM framer) rather than duplicating them — see the
sys.path shim below. No ROS, no podman: just python3 + pyserial + requests
under a systemd unit.

It connects with ?device=gps and holds its OWN slot on the course server, so
the rover (?device=rover) and this unit can be connected at the same time —
the receiver is the preferred cone-capture source, the rover the fallback.

Beyond cone capture it can act as an RTK BASE STATION: on `base-survey-start`
it averages NGII rtk_fixed positions into a survey point; on `base-activate`
it switches the ZED-F9P to TMODE FIXED at that point, emits RTCM3, and relays
it to the server (→ rover) via POST /api/rover/base/rtcm. Cone-capture and
base-station roles are mutually exclusive (`_mode`).

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

import base64
import collections
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
# rover/gps/, pilot package one dir over at ../pilot/pilot) and the
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
from pilot.lib.rtcm_utils import RTCM3Framer  # noqa: E402

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

# UBX-CFG keys for base-station (TMODE FIXED) + RTCM3 output on USB. Key IDs +
# types verified against the u-blox F9 configuration database (pyubx2
# ubxtypes_configdb). TMODE lets a receiver at a known point emit RTCM3
# corrections; MSM7 (1077/1087/1097/1127) + 1005 (station ARP) + 1230 (GLONASS
# code-phase biases) is the standard high-precision base message set.
CFG_TMODE_MODE = 0x20030001            # E1: 0=disabled 1=survey-in 2=fixed
CFG_TMODE_POS_TYPE = 0x20030002        # E1: 0=ECEF 1=LLH
CFG_TMODE_LAT = 0x40030009             # I4, 1e-7 deg
CFG_TMODE_LON = 0x4003000A             # I4, 1e-7 deg
CFG_TMODE_HEIGHT = 0x4003000B          # I4, cm
CFG_TMODE_LAT_HP = 0x2003000C          # I1, 1e-9 deg
CFG_TMODE_LON_HP = 0x2003000D          # I1, 1e-9 deg
CFG_TMODE_HEIGHT_HP = 0x2003000E       # I1, 0.1 mm
CFG_TMODE_FIXED_POS_ACC = 0x4003000F   # U4, 0.1 mm
CFG_MSGOUT_RTCM_1005_USB = 0x209102C0
CFG_MSGOUT_RTCM_1077_USB = 0x209102CF
CFG_MSGOUT_RTCM_1087_USB = 0x209102D4
CFG_MSGOUT_RTCM_1097_USB = 0x2091031B
CFG_MSGOUT_RTCM_1127_USB = 0x209102D9
CFG_MSGOUT_RTCM_1230_USB = 0x20910306
_RTCM_MSGOUT_KEYS = (
    CFG_MSGOUT_RTCM_1005_USB, CFG_MSGOUT_RTCM_1077_USB, CFG_MSGOUT_RTCM_1087_USB,
    CFG_MSGOUT_RTCM_1097_USB, CFG_MSGOUT_RTCM_1127_USB, CFG_MSGOUT_RTCM_1230_USB,
)

# Flush relayed RTCM to the server about once per RTCM epoch, or sooner if a lot
# has piled up. Keeps each POST small (well under the 100 KB JSON limit).
_RTCM_FLUSH_INTERVAL_S = 1.0
_RTCM_FLUSH_MAX_BYTES = 2048

_SERIAL_OPEN_RETRIES = 6
_SERIAL_OPEN_BACKOFF_S = 2.0


def split_hp(scaled_fine):
    """Split an integer in *fine* units (coarse/100) into (coarse_main, hp) for
    the u-blox HP config pair. Works for lat/lon (coarse 1e-7 deg, fine 1e-9 deg)
    and height (coarse cm, fine 0.1 mm): value = main*coarse + hp*fine.

    Floor division makes hp always land in 0..99 — within u-blox's I1 HP range
    [-99, 99] — so the reconstruction main*coarse + hp*fine is EXACT in every
    hemisphere: the F9P sums the two fields linearly, with no same-sign
    requirement between main and hp. (In practice only exercised on +lat/+lon
    in Korea, but correct for negative coordinates too.)"""
    main = scaled_fine // 100
    hp = scaled_fine - main * 100
    return main, hp


def average_survey_samples(samples):
    """Mean of (lat, lng, alt, h_acc) survey samples. alt/h_acc are averaged over
    only the subset that reported them. Returns (lat, lng, alt|None, h_acc|None, n)
    or None when there are no samples."""
    n = len(samples)
    if n == 0:
        return None
    lat = sum(s[0] for s in samples) / n
    lon = sum(s[1] for s in samples) / n
    alts = [s[2] for s in samples if s[2] is not None]
    haccs = [s[3] for s in samples if s[3] is not None]
    alt = sum(alts) / len(alts) if alts else None
    h_acc = sum(haccs) / len(haccs) if haccs else None
    return lat, lon, alt, h_acc, n


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


# Fix statuses whose position is real. Below a 2D fix the receiver reports
# (0, 0); reporting that would drag the operator map to Null Island, where the
# satellite basemap has no tiles and the whole view renders blank grey.
_POSITION_FIX_STATUSES = frozenset({"2d_fix", "3d_fix", "rtk_float", "rtk_fixed"})


def build_telemetry(fix_status, ntrip_connected, ntrip_detail, gps_metrics,
                    mode="capture", base=None):
    """Assemble the /api/rover/telemetry payload. nav_state is always IDLE —
    this unit never drives, and IDLE keeps the server's mission lifecycle a
    no-op. `mode` is "capture" | "base"; `base` mirrors the base-session state
    (idle|surveying|active + relayed RTCM bytes) for the operator UI. Omits keys
    the server treats as "not reported" (battery)."""
    payload = {
        "nav_state": "IDLE",
        "fix_status": fix_status,
        "ntrip_connected": bool(ntrip_connected),
        "mode": mode,
    }
    if ntrip_detail is not None:
        payload["ntrip"] = ntrip_detail
    if gps_metrics is not None:
        payload["gps"] = gps_metrics
    if base is not None:
        payload["base"] = base
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
        self._last_position = None     # {'lat','lng','alt'} (alt = MSL height, m)
        self._last_pvt = None
        self._last_hpposllh = None
        self._last_dop = None
        self._fix_status = None
        self._gps_metrics = None
        # Default False (not None): the first telemetry POST tells the server
        # "no NTRIP this session" so it clears any stale cached mountpoint.
        self._ntrip_connected = False
        self._ntrip_detail = None
        # Bounded: with the 2D-fix gate, no-fix windows no longer drain requests
        # immediately, so cap accumulation (mirrors bridge_node's deque).
        self._pending_request_ids = collections.deque(maxlen=32)

        self._running = True
        self._last_report_time = 0.0
        # Base-station state. _mode: "capture" (live position source) |
        # "base-survey" (averaging NGII rtk_fixed position for a survey point) |
        # "base-output" (TMODE FIXED, emitting RTCM). _pending_reconfig hands
        # serial (re)configuration to the serial thread, which owns the port.
        # _survey accumulates rtk_fixed HPPOSLLH samples during a survey.
        self._mode = "capture"
        self._pending_reconfig = None   # None | ("base", payload) | ("capture", None)
        self._base_params = None        # {"lat","lng","alt","acc"} while acting as a base
        self._survey = None             # None | {"point_id", "samples": [(lat,lng,alt,h_acc)]}
        self._rtcm_framer = None
        self._rtcm_out = bytearray()
        self._rtcm_bytes = 0
        self._rtcm_last_flush = 0.0
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
        """Configure the F9P for capture (roving) mode: UBX NAV output on, NMEA
        off, fix rate set, and — critically — TMODE + RTCM output DISABLED.

        This runs unconditionally on every serial open, so it must be
        authoritative: build_cfg_valset persists to RAM+BBR, so a base session
        leaves CFG-TMODE-MODE=FIXED in battery-backed RAM. Without clearing it
        here, a restart in capture mode (power loss / systemd restart / a
        base-stop lost while offline) would leave the receiver in TMODE FIXED,
        silently reporting the stale base coordinate for every cone. Clearing it
        here makes capture always start clean; the base re-assert on open (see
        _serial_loop) re-enables TMODE right after when we really are a base."""
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
            # Clear any persisted base-station config (TMODE FIXED + RTCM output).
            (CFG_TMODE_MODE, 0, "B"),
        ] + [(k, 0, "B") for k in _RTCM_MSGOUT_KEYS])
        self._serial.write(cfg)
        log.info("ZED-F9P configured for UBX output @ %d ms (capture mode)", self._meas_rate_ms)

    def _configure_base(self, lat, lon, alt, acc):
        """Put the F9P into TMODE FIXED (LLH) at the surveyed point and enable
        RTCM3 (MSM7 + 1005 + 1230) on USB. From then the receiver generates its
        own corrections from its known position — no NGII needed."""
        lat_main, lat_hp = split_hp(int(round(lat * 1e9)))     # 1e-9 deg units
        lon_main, lon_hp = split_hp(int(round(lon * 1e9)))
        h = alt if alt is not None else 0.0
        h_main, h_hp = split_hp(int(round(h * 1e4)))           # 0.1 mm units
        acc_01mm = max(1, int(round((acc if acc else 0.1) * 1e4)))
        cfg = build_cfg_valset([
            (CFG_TMODE_MODE, 2, "B"),          # FIXED
            (CFG_TMODE_POS_TYPE, 1, "B"),      # LLH
            (CFG_TMODE_LAT, lat_main, "i"),
            (CFG_TMODE_LAT_HP, lat_hp, "b"),
            (CFG_TMODE_LON, lon_main, "i"),
            (CFG_TMODE_LON_HP, lon_hp, "b"),
            (CFG_TMODE_HEIGHT, h_main, "i"),
            (CFG_TMODE_HEIGHT_HP, h_hp, "b"),
            (CFG_TMODE_FIXED_POS_ACC, acc_01mm, "I"),
        ] + [(k, 1, "B") for k in _RTCM_MSGOUT_KEYS])
        self._serial.write(cfg)
        log.info("ZED-F9P TMODE FIXED @ (%.7f, %.7f, %.2fm) — RTCM3 out enabled", lat, lon, h)

    def _configure_base_stop(self):
        """Disable TMODE + RTCM3 output — returns the F9P to a moving-rover role."""
        cfg = build_cfg_valset(
            [(CFG_TMODE_MODE, 0, "B")] + [(k, 0, "B") for k in _RTCM_MSGOUT_KEYS]
        )
        self._serial.write(cfg)
        log.info("ZED-F9P TMODE disabled — RTCM3 out off")

    def _apply_base_output(self, payload):
        """Serial-thread: stop NGII and switch the F9P to base (RTCM) output."""
        if self._ntrip is not None:
            try:
                self._ntrip.stop()
            except Exception:
                pass
            self._ntrip = None
        self._ntrip_last_attempt = time.monotonic()  # block NGII auto-restart
        with self._lock:
            self._mode = "base-output"
            self._survey = None
            self._rtcm_framer = RTCM3Framer()
            self._rtcm_out = bytearray()
            self._rtcm_bytes = 0
            self._rtcm_last_flush = time.monotonic()
        self._configure_base(payload["lat"], payload["lng"], payload.get("alt"), payload.get("acc"))

    def _apply_capture(self):
        """Serial-thread: leave base mode, restore NAV output, resume NGII."""
        self._configure_base_stop()
        self._configure_receiver()
        with self._lock:
            self._mode = "capture"
            self._survey = None
            self._rtcm_framer = None
            self._rtcm_out = bytearray()
        self._ntrip_last_attempt = 0.0  # allow NGII to re-init on next 3D fix

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
        No-op without an operator NGII login (runs without RTK then). Also a
        no-op while acting as a base — a TMODE-FIXED base makes its own
        corrections and must not pull NGII (capture + base-survey still do)."""
        if self._mode == "base-output":
            return
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
        # We may have switched to base-output while this worker was queued or
        # during the slow fetch below (e.g. the server sends base-activate right
        # after the receiver reconnects). Bail early so we never pull NGII in base
        # mode; re-checked under the lock too (mirrors gps_node._ntrip_setup_worker).
        if self._mode == "base-output":
            return
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
            if (self._ntrip is not None or self._serial is not serial_ref
                    or self._mode == "base-output"):
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
                self._last_position = {"lat": pvt.lat, "lng": pvt.lon, "alt": pvt.h_msl}
        self._maybe_setup_ntrip(pvt.lat, pvt.lon, pvt.fix_type)
        if self._ntrip:
            self._ntrip.update_position(pvt.lat, pvt.lon)

    def _on_hpposllh(self, hp):
        with self._lock:
            self._last_hpposllh = hp
            self._last_position = {"lat": hp.lat, "lng": hp.lon, "alt": hp.h_msl}
            # During a base survey, average only RTK-fixed samples — this is the
            # whole point of surveying "while NTRIP is alive". Use ELLIPSOIDAL
            # height (hp.height), not MSL: this coordinate feeds CFG-TMODE-HEIGHT
            # with POS_TYPE=LLH, which u-blox defines as height above the WGS84
            # ellipsoid. Using h_msl would bias the base ARP by the geoid
            # separation (~24 m in Korea) and skew every rover absolute altitude.
            if self._survey is not None and self._fix_status == "rtk_fixed":
                self._survey["samples"].append((hp.lat, hp.lon, hp.height, hp.h_acc))

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
        """Read + parse UBX; extract/relay RTCM in base mode; periodic reporting.
        Reopens on drop. All serial (re)configuration happens on this thread."""
        while self._running:
            if self._serial is None:
                try:
                    self._open_serial()
                    self._configure_receiver()
                    # Re-assert base output after a reopen (BBR usually survives a
                    # USB re-enumerate, but re-applying is cheap and authoritative).
                    if self._mode == "base-output" and self._base_params:
                        with self._lock:
                            self._pending_reconfig = ("base", self._base_params)
                except (serial.SerialException, OSError) as exc:
                    log.warning("GPS serial (re)open failed: %s", exc)
                    time.sleep(_SERIAL_OPEN_BACKOFF_S)
                    continue

            # Apply any pending base/capture reconfiguration here so all serial +
            # NTRIP lifecycle stays on the single serial-owning thread. Read+clear
            # under the lock so a concurrent _activate_base/_deactivate_base write
            # can't be lost between the read and the clear. Apply OUTSIDE the lock
            # (_apply_* re-acquire it; the Lock is non-reentrant).
            with self._lock:
                pending = self._pending_reconfig
                self._pending_reconfig = None
            if pending is not None:
                kind, payload = pending
                try:
                    if kind == "base":
                        self._apply_base_output(payload)
                    else:
                        self._apply_capture()
                except (serial.SerialException, OSError) as exc:
                    log.warning("reconfigure(%s) failed: %s", kind, exc)

            try:
                data = self._serial.read(self._serial.in_waiting or 1)
            except (serial.SerialException, OSError) as exc:
                log.error("serial read error: %s — closing for reopen", exc)
                self._teardown_serial()
                continue
            if data:
                # In base mode the same stream carries RTCM3 (to relay) alongside
                # NAV-PVT (kept for health). Feed both extractors the raw bytes.
                if self._mode == "base-output" and self._rtcm_framer is not None:
                    frames = self._rtcm_framer.feed(data)
                    if frames:
                        with self._lock:
                            for f in frames:
                                self._rtcm_out.extend(f)
                for msg in self._parser.feed(data):
                    if isinstance(msg, NavPVT):
                        self._on_nav_pvt(msg)
                    elif isinstance(msg, NavHPPOSLLH):
                        self._on_hpposllh(msg)
                    elif isinstance(msg, NavDOP):
                        with self._lock:
                            self._last_dop = msg

            now = time.monotonic()
            if self._mode == "base-output":
                self._maybe_flush_rtcm(now)
            elif now - self._last_report_time >= self._report_interval:
                self._report_position()
                self._last_report_time = now

    def _maybe_flush_rtcm(self, now):
        """Relay buffered RTCM to the server ~1×/epoch (or sooner if it piles up),
        keeping each POST small. No-op when there is nothing to send."""
        with self._lock:
            buf = self._rtcm_out
            if not buf:
                return
            if len(buf) < _RTCM_FLUSH_MAX_BYTES and (now - self._rtcm_last_flush) < _RTCM_FLUSH_INTERVAL_S:
                return
            payload = bytes(buf)
            self._rtcm_out = bytearray()
            self._rtcm_last_flush = now
            self._rtcm_bytes += len(payload)
        self._enqueue_post("/api/rover/base/rtcm",
                           {"data": base64.b64encode(payload).decode("ascii")}, "rtcm")

    def _report_position(self, request_ids=None):
        with self._lock:
            if not self._last_position:
                return
            # Hold position (and any pending request) until at least a 2D fix:
            # a no-fix / time-only solution reports (0, 0), which would jump the
            # operator map to Null Island (blank grey — no basemap tiles).
            if self._fix_status not in _POSITION_FIX_STATUSES:
                return
            payload = dict(self._last_position)
            if request_ids is None and self._pending_request_ids:
                request_ids = list(self._pending_request_ids)
                self._pending_request_ids.clear()
        if request_ids:
            payload["request_id"] = request_ids[0]
            payload["request_ids"] = request_ids
        self._enqueue_post("/api/rover/position?device=gps", payload,
                           "position(req)" if request_ids else "position")

    # ---- server SSE/telemetry -----------------------------------------

    def _telemetry_loop(self):
        while self._running:
            time.sleep(3.0)
            with self._lock:
                ntrip_connected = self._ntrip.connected if self._ntrip else False
                ntrip_detail = self._ntrip_detail_locked()
                mode = "base" if self._mode == "base-output" else "capture"
                base = {
                    "state": ("active" if self._mode == "base-output"
                              else "surveying" if self._mode == "base-survey"
                              else "idle"),
                    "rtcm_bytes": self._rtcm_bytes,
                }
                payload = build_telemetry(
                    self._fix_status, ntrip_connected, ntrip_detail, self._gps_metrics,
                    mode, base,
                )
            self._enqueue_post("/api/rover/telemetry?device=gps", payload, "telemetry")

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
            # ?device=gps takes the receiver's own slot on the course server so the
            # rover and this unit no longer evict each other.
            f"{self._url}/api/rover/stream?device=gps", headers=headers,
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
        try:
            payload = json.loads(data) if data else {}
        except json.JSONDecodeError:
            log.warning("bad %s JSON: %s", event, data)
            return
        if event == "request-position":
            rid = payload.get("request_id")
            if isinstance(rid, str) and rid:
                with self._lock:
                    self._pending_request_ids.append(rid[:64])
            self._report_position()
        elif event == "base-survey-start":
            self._start_survey(payload.get("point_id"), payload.get("duration_s", 120))
        elif event == "base-survey-cancel":
            self._cancel_survey()
        elif event == "base-activate":
            self._activate_base(payload)
        elif event == "base-stop":
            self._deactivate_base()
        # All other rover commands (execute-path, manual-control, calibrate-*)
        # are no-ops for a survey unit: it has no motors/MCU to drive.

    # ---- base station ---------------------------------------------------

    def _start_survey(self, point_id, duration_s):
        """Average RTK-fixed HPPOSLLH for `duration_s` and report the mean as the
        surveyed base coordinate. NGII is already running in capture mode, so this
        needs no serial reconfig — it just gates sample collection on rtk_fixed."""
        if point_id is None:
            log.warning("base-survey-start without point_id"); return
        if self._mode == "base-output":
            log.warning("cannot survey while base output is active"); return
        duration = max(5, min(int(duration_s or 120), 1800))
        with self._lock:
            self._mode = "base-survey"
            self._survey = {"point_id": int(point_id), "samples": []}
        log.info("base survey started: point %s for %ds", point_id, duration)
        threading.Thread(target=self._survey_worker,
                         args=(int(point_id), duration), daemon=True).start()

    def _survey_worker(self, point_id, duration):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline and self._running:
            surv = self._survey
            if surv is None or surv.get("point_id") != point_id:
                log.info("base survey %s cancelled/superseded", point_id)
                return
            time.sleep(0.5)
        with self._lock:
            surv = self._survey
            self._survey = None
            if self._mode == "base-survey":
                self._mode = "capture"
            samples = list(surv["samples"]) if surv and surv.get("point_id") == point_id else []
        result = average_survey_samples(samples)
        if result is None:
            # Report the FAILURE (don't just log) so the server clears the
            # "surveying" state and the operator UI shows an error instead of
            # silently reverting to "미측량".
            log.warning("base survey %s: no RTK-fixed samples — reporting failure", point_id)
            self._enqueue_post("/api/rover/base/survey-result", {
                "point_id": point_id, "ok": False, "error": "no_rtk_fixed_samples",
            }, "survey-result")
            return
        lat, lon, alt, h_acc, n = result
        self._enqueue_post("/api/rover/base/survey-result", {
            "point_id": point_id, "ok": True, "lat": lat, "lng": lon,
            "alt": alt, "h_acc": h_acc, "samples": n,
        }, "survey-result")
        log.info("base survey %s done: %d samples -> (%.7f, %.7f)", point_id, n, lat, lon)

    def _cancel_survey(self):
        with self._lock:
            self._survey = None
            if self._mode == "base-survey":
                self._mode = "capture"
        log.info("base survey cancelled")

    def _activate_base(self, payload):
        """Latch base intent (so NGII stops auto-starting); the serial thread does
        the actual TMODE/RTCM reconfiguration via _pending_reconfig."""
        if payload.get("lat") is None or payload.get("lng") is None:
            log.warning("base-activate without coordinates"); return
        self._base_params = {
            "lat": payload["lat"], "lng": payload["lng"],
            "alt": payload.get("alt"), "acc": payload.get("acc"),
        }
        self._mode = "base-output"
        with self._lock:
            self._pending_reconfig = ("base", self._base_params)
        log.info("base activation requested at (%.7f, %.7f)", payload["lat"], payload["lng"])

    def _deactivate_base(self):
        self._base_params = None
        self._mode = "capture"
        with self._lock:
            self._pending_reconfig = ("capture", None)
        log.info("base deactivation requested")

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
