"""GPS Node: ZED-F9P UBX driver with NTRIP RTK corrections.

Reads the ZED-F9P via USB serial, parses UBX binary protocol for
high-precision position, and manages NTRIP client for RTK corrections.

Published topics:
    /rover/gps/position (sensor_msgs/NavSatFix) - Current RTK position at 10Hz
    /rover/gps/heading (std_msgs/Float64) - Heading in degrees (only when moving)
    /rover/gps/fix_status (std_msgs/String) - Fix status string

Subscribed topics:
    /rover/cmd/request_position (std_msgs/Empty) - Trigger immediate position publish
"""

import base64
import json
import threading
import time

import serial
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import NavSatFix, NavSatStatus
from std_msgs.msg import Float64, String, Empty

from pilot.lib.ubx_parser import (
    UBXParser, NavPVT, NavHPPOSLLH, NavDOP,
    CarrierSolution, FixType,
    build_cfg_valset,
)
from pilot.lib.ntrip_client import (
    NTRIPClient,
    fetch_source_table,
    parse_source_table,
    select_nearest_mountpoint,
)

# NGII (국토지리정보원) is the only NTRIP caster we use. Host, port, and
# password are protocol-level constants published on the gnssdata.or.kr
# portal — the only per-rover value is the operator's NGII login, which
# arrives via the NTRIP_USERNAME env var (sourced from the
# ntrip-username podman secret). Update these constants if NGII ever
# changes the caster endpoint.
_NTRIP_HOST = 'www.gnssdata.or.kr'
_NTRIP_PORT = 2101
_NTRIP_PASSWORD = 'gnss'

# Retry NTRIP auto-setup at most this often when source-table fetch or
# mount selection fails. Long enough that a down caster doesn't busy-loop;
# short enough that a transient network blip clears within a minute.
_NTRIP_SETUP_COOLDOWN_S = 30.0

# Retry opening /dev/ttyACM0 this many times at startup before giving up.
# The ZED-F9P can take a few seconds to enumerate after power-on, so a
# retry loop lets pilot.service's Restart=on-failure do less heavy lifting.
_SERIAL_OPEN_RETRIES = 6
_SERIAL_OPEN_BACKOFF_S = 2.0


def _fix_status_string(pvt):
    """Convert NavPVT to human-readable fix status. RTK carrier solution
    wins over a plain 3D fix when present. Dead-reckoning variants are
    reported as `no_fix` because ZED-F9P has no IMU input — DR transitions
    are spurious here, and treating them as no_fix avoids confusing UI."""
    if pvt.carrier_solution == CarrierSolution.FIXED:
        return 'rtk_fixed'
    if pvt.carrier_solution == CarrierSolution.FLOAT:
        return 'rtk_float'
    return {
        FixType.NO_FIX: 'no_fix',
        FixType.DEAD_RECKONING: 'no_fix',
        FixType.FIX_2D: '2d_fix',
        FixType.FIX_3D: '3d_fix',
        FixType.GNSS_DR: 'no_fix',
        FixType.TIME_ONLY: 'time_only',
    }.get(pvt.fix_type, 'no_fix')


# UBX CFG key IDs for configuring output messages
CFG_MSGOUT_UBX_NAV_PVT_USB = 0x20910009
CFG_MSGOUT_UBX_NAV_HPPOSLLH_USB = 0x20910036
CFG_MSGOUT_UBX_NAV_DOP_USB = 0x20910041
CFG_MSGOUT_NMEA_GGA_USB = 0x209100BD
CFG_MSGOUT_NMEA_RMC_USB = 0x209100AE
CFG_MSGOUT_NMEA_GSV_USB = 0x209100C4
CFG_MSGOUT_NMEA_GSA_USB = 0x209100C1
CFG_MSGOUT_NMEA_GLL_USB = 0x209100CA
CFG_MSGOUT_NMEA_VTG_USB = 0x209100B3
# Measurement period in ms (U2). F9P boots at 1000 (1 Hz); we need 100 ms (10 Hz)
# so antenna-offset auto-cal collects enough samples during its short S-curve.
CFG_RATE_MEAS = 0x30210001


class GpsNode(Node):

    def __init__(self):
        super().__init__('gps_node')

        # Parameters
        self.declare_parameter('serial_port', '/dev/ttyGPS')
        self.declare_parameter('baud_rate', 115200)
        self.declare_parameter('publish_rate', 10.0)
        self.declare_parameter('heading_speed_threshold', 1.5)
        self.declare_parameter('ntrip.username', '')
        self.declare_parameter('ntrip.gga_interval_s', 10.0)

        # Publishers
        self._pub_position = self.create_publisher(NavSatFix, '/rover/gps/position', 10)
        self._pub_heading = self.create_publisher(Float64, '/rover/gps/heading', 10)
        self._pub_fix_status = self.create_publisher(String, '/rover/gps/fix_status', 10)
        self._pub_metrics = self.create_publisher(String, '/rover/gps/metrics', 10)
        self._pub_ntrip_status = self.create_publisher(String, '/rover/ntrip/status', 1)

        # Subscriber for position request
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self.create_subscription(Empty, '/rover/cmd/request_position', self._on_request_position, reliable_qos)
        # Base-station corrections relayed by the server from the GPS receiver
        # acting as a base (RTCM3, base64), plus the correction-source selector.
        self.create_subscription(String, '/rover/gps/rtcm_inject', self._on_rtcm_inject, reliable_qos)
        self.create_subscription(String, '/rover/cmd/ntrip_source', self._on_ntrip_source, reliable_qos)

        # State
        self._parser = UBXParser()
        self._last_pvt = None
        self._last_hpposllh = None
        self._last_dop = None
        self._serial = None
        self._ntrip = None
        # Correction source: 'ngii' pulls the public NTRIP caster (default);
        # 'base' consumes RTCM relayed from the receiver base via _on_rtcm_inject
        # and suppresses NGII auto-setup.
        self._ntrip_source = 'ngii'
        self._ntrip_setup_lock = threading.Lock()
        self._ntrip_setup_in_flight = False
        # NTRIP auto-setup is deferred until we have a real 3D fix so we
        # can pick the nearest base station. These track retry timing.
        self._ntrip_last_attempt = 0.0
        # Reconnect timing: when _read_serial sees a SerialException we
        # close the port and retry with backoff. Without this, a single
        # USB-CDC drop mid-mission silently halts position publishing.
        self._serial_last_open_attempt = 0.0
        self._serial_reopen_backoff_s = 2.0

        # Open serial port and configure ZED-F9P
        self._open_serial()
        self._configure_receiver()
        # NTRIP is started lazily from _read_serial once a 3D fix arrives —
        # the mountpoint is chosen by nearest distance to the caster's
        # published base stations, so we need a position first.

        # Timer for reading serial data
        rate = float(self.get_parameter('publish_rate').value)
        if rate <= 0.0:
            self.get_logger().fatal(f'publish_rate must be > 0 (got {rate})')
            raise SystemExit(1)
        self._timer = self.create_timer(1.0 / rate, self._read_serial)

        # Periodic NTRIP status publisher (1Hz)
        self._ntrip_status_timer = self.create_timer(1.0, self._publish_ntrip_status)

        self.get_logger().info('GPS node started')

    def _publish_ntrip_status(self):
        """Publish NTRIP client status as JSON for bridge_node telemetry."""
        if not self._ntrip:
            return
        status = {
            'connected': self._ntrip.connected,
            'fail_count': self._ntrip.fail_count,
            'last_error': self._ntrip.last_error,
            'bytes_received': self._ntrip.bytes_received,
            'host': self._ntrip.host,
            'port': self._ntrip.port,
            'mountpoint': self._ntrip.mountpoint,
            'last_correction_at': self._ntrip.last_correction_at,
        }
        msg = String()
        msg.data = json.dumps(status)
        self._pub_ntrip_status.publish(msg)

    def _on_rtcm_inject(self, msg):
        """Write server-relayed base-station RTCM3 (base64) to the receiver.

        When the operator selects the receiver as the base station, the server
        relays its RTCM over the rover's command SSE; bridge_node republishes it
        here. We just feed the bytes to the F9P serial port — exactly what the
        NGII NTRIP client would have done, minus the network."""
        if not msg.data or self._serial is None:
            return
        # Only inject while the base station is the selected source. In ngii mode
        # the NTRIP client thread writes the same serial fd; injecting here too
        # would interleave two writers mid-frame (a stray/out-of-order rtcm event
        # during the switch boundary). One writer at a time.
        if self._ntrip_source != 'base':
            return
        try:
            raw = base64.b64decode(msg.data, validate=True)
        except (ValueError, TypeError) as exc:
            self.get_logger().warn(f'bad RTCM inject payload: {exc}')
            return
        try:
            self._serial.write(raw)
        except (serial.SerialException, OSError) as exc:
            self.get_logger().warn(f'RTCM inject serial write failed: {exc}')

    def _on_ntrip_source(self, msg):
        """Switch correction source: 'base' (relayed RTCM) vs 'ngii' (own NTRIP)."""
        source = (msg.data or 'ngii').strip()
        if source not in ('ngii', 'base'):
            self.get_logger().warn(f'ntrip-source: unknown source {source!r}')
            return
        if source == self._ntrip_source:
            return
        # Set the source and detach any live NGII client UNDER _ntrip_setup_lock so
        # this is ordered against _ntrip_setup_worker's lock-held critical section —
        # otherwise a 'base' flip landing between the worker's source re-check and
        # its `self._ntrip = client` assignment would leak a live NGII client into
        # base mode (double-feeding the F9P). Stop the client OUTSIDE the lock so a
        # multi-second thread join doesn't block the worker.
        client_to_stop = None
        with self._ntrip_setup_lock:
            self._ntrip_source = source
            if source == 'base':
                client_to_stop = self._ntrip
                self._ntrip = None
            else:
                # Back to NGII — allow immediate re-setup on the next 3D fix.
                self._ntrip_last_attempt = 0.0
        if client_to_stop is not None:
            try:
                client_to_stop.stop()
            except Exception:
                pass
        self.get_logger().info(f'NTRIP correction source -> {source}')

    def _teardown_serial(self):
        """Close NTRIP and the serial port for a clean reopen.

        NTRIP holds a reference to the same Serial object; if we leave it
        running it will write RTCM to a dead fd and never recover. Stop +
        null it; _maybe_setup_ntrip will rebuild on the next 3D fix after
        the port is back.
        """
        if self._ntrip is not None:
            try:
                self._ntrip.stop()
            except Exception:
                pass
            self._ntrip = None
            self._ntrip_last_attempt = 0.0
            with self._ntrip_setup_lock:
                self._ntrip_setup_in_flight = False
        try:
            if self._serial is not None:
                self._serial.close()
        except Exception:
            pass
        self._serial = None

    def _open_serial(self):
        port = self.get_parameter('serial_port').value
        baud = self.get_parameter('baud_rate').value
        last_exc = None
        for attempt in range(1, _SERIAL_OPEN_RETRIES + 1):
            try:
                self._serial = serial.Serial(port, baud, timeout=0.1)
                self.get_logger().info(f'Opened GPS serial: {port} @ {baud}')
                return
            except serial.SerialException as exc:
                last_exc = exc
                self.get_logger().warn(
                    f'GPS serial open failed ({port}, attempt {attempt}/{_SERIAL_OPEN_RETRIES}): {exc}'
                )
                if attempt < _SERIAL_OPEN_RETRIES:
                    time.sleep(_SERIAL_OPEN_BACKOFF_S)
        # All retries exhausted — re-raise. gps_node is a core node, so the
        # launch file registers an OnProcessExit→Shutdown handler for it
        # (launch/pilot.launch.py): this exception kills the node process,
        # which shuts the whole launch down, exits the container, and lets
        # pilot.service's Restart=on-failure recreate the stack — with a clear
        # trail of open attempts left in the log.
        raise last_exc

    def _configure_receiver(self):
        """Configure ZED-F9P to output UBX NAV-PVT and NAV-HPPOSLLH, disable NMEA."""
        cfg = build_cfg_valset([
            (CFG_RATE_MEAS, 100, 'H'),                   # 100 ms = 10 Hz fixes
            (CFG_MSGOUT_UBX_NAV_PVT_USB, 1, 'B'),        # Enable NAV-PVT on USB
            (CFG_MSGOUT_UBX_NAV_HPPOSLLH_USB, 1, 'B'),   # Enable NAV-HPPOSLLH on USB
            (CFG_MSGOUT_UBX_NAV_DOP_USB, 1, 'B'),        # Enable NAV-DOP on USB
            (CFG_MSGOUT_NMEA_GGA_USB, 0, 'B'),           # Disable NMEA GGA
            (CFG_MSGOUT_NMEA_RMC_USB, 0, 'B'),           # Disable NMEA RMC
            (CFG_MSGOUT_NMEA_GSV_USB, 0, 'B'),           # Disable NMEA GSV
            (CFG_MSGOUT_NMEA_GSA_USB, 0, 'B'),           # Disable NMEA GSA
            (CFG_MSGOUT_NMEA_GLL_USB, 0, 'B'),           # Disable NMEA GLL
            (CFG_MSGOUT_NMEA_VTG_USB, 0, 'B'),           # Disable NMEA VTG
        ])
        self._serial.write(cfg)
        self.get_logger().info('ZED-F9P configured for UBX output')

    def _maybe_setup_ntrip(self, pvt):
        """Lazily start the NTRIP client once a real fix is available.

        Mountpoint is auto-selected from the caster's source table as the
        nearest RTCM 3.2 base station to the current position. On failure
        (network, empty table, no RTCM 3.2 mount in range) we log and retry
        after _NTRIP_SETUP_COOLDOWN_S — GPS continues publishing single-
        precision fixes in the meantime.
        """
        if self._ntrip_source == 'base':
            return  # corrections arrive via _on_rtcm_inject from the receiver base
        if self._ntrip is not None:
            return
        if pvt.fix_type < FixType.FIX_3D:
            return
        username = self.get_parameter('ntrip.username').value
        if not username:
            return  # NTRIP disabled — no operator login, run without RTK.
        now = time.monotonic()
        if now - self._ntrip_last_attempt < _NTRIP_SETUP_COOLDOWN_S:
            return
        with self._ntrip_setup_lock:
            if self._ntrip_setup_in_flight:
                return
            self._ntrip_setup_in_flight = True
            self._ntrip_last_attempt = now

        serial_ref = self._serial
        gga_interval = self.get_parameter('ntrip.gga_interval_s').value
        threading.Thread(
            target=self._ntrip_setup_worker,
            args=(pvt.lat, pvt.lon, username, gga_interval, serial_ref),
            daemon=True,
        ).start()

    def _ntrip_setup_worker(self, lat, lon, username, gga_interval, serial_ref):
        """Fetch source table off the ROS timer thread and start NTRIP."""
        try:
            # The operator may switch to the receiver base station while this
            # slow fetch is in flight; bail early so we don't pull NGII at all.
            if self._ntrip_source == 'base':
                return
            try:
                table_text = fetch_source_table(_NTRIP_HOST, _NTRIP_PORT)
            except Exception as exc:
                self.get_logger().warn(
                    f'NTRIP source table fetch failed ({_NTRIP_HOST}:{_NTRIP_PORT}): {exc} '
                    f'— retry in {_NTRIP_SETUP_COOLDOWN_S:.0f}s'
                )
                return

            entries = parse_source_table(table_text)
            if not entries:
                self.get_logger().warn(
                    f'NTRIP source table from {_NTRIP_HOST}:{_NTRIP_PORT} had no parseable STR entries '
                    f'— retry in {_NTRIP_SETUP_COOLDOWN_S:.0f}s'
                )
                return

            mount = select_nearest_mountpoint(lat, lon, entries)
            if not mount:
                self.get_logger().warn(
                    f'NTRIP: no RTCM 3.2 mountpoint in source table of {len(entries)} entries '
                    f'— retry in {_NTRIP_SETUP_COOLDOWN_S:.0f}s'
                )
                return

            with self._ntrip_setup_lock:
                # Re-check the source UNDER the lock: if we switched to base after
                # the early check but during the fetch, _on_ntrip_source('base')
                # couldn't stop a client that didn't exist yet — abort here so we
                # never start NGII in base mode (which would double-feed the F9P).
                if (self._ntrip is not None or self._serial is not serial_ref
                        or self._ntrip_source == 'base'):
                    return
                self.get_logger().info(
                    f'NTRIP: auto-selected "{mount}" for position '
                    f'({lat:.5f}, {lon:.5f})'
                )
                client = NTRIPClient(
                    host=_NTRIP_HOST,
                    port=_NTRIP_PORT,
                    mountpoint=mount,
                    username=username,
                    password=_NTRIP_PASSWORD,
                    serial_port=serial_ref,
                    lat=lat,
                    lon=lon,
                    logger=self.get_logger(),
                )
                client._gga_interval = gga_interval
                self._ntrip = client
                client.start()
        finally:
            with self._ntrip_setup_lock:
                self._ntrip_setup_in_flight = False

    def _read_serial(self):
        """Read and parse UBX data from serial port.

        On SerialException (USB-CDC drop, permission flap, kernel hiccup) we
        close the port, null `_serial`, and re-attempt `_open_serial` on
        subsequent ticks with `_serial_reopen_backoff_s` delay. NTRIP shares
        the serial handle so it must be torn down too — restarting NTRIP is
        cheap (lazy reconnect via _maybe_setup_ntrip) and avoids writing
        RTCM into a dead fd.
        """
        if self._serial is None:
            now = time.monotonic()
            if now - self._serial_last_open_attempt < self._serial_reopen_backoff_s:
                return
            self._serial_last_open_attempt = now
            try:
                self._open_serial()
                self._configure_receiver()
                self.get_logger().info('GPS serial reopened')
            except (serial.SerialException, OSError) as exc:
                self.get_logger().warn(f'GPS serial reopen failed: {exc}')
                self._serial = None
                return
        try:
            data = self._serial.read(self._serial.in_waiting or 1)
        except (serial.SerialException, OSError) as e:
            self.get_logger().error(f'Serial read error: {e} — closing for reopen')
            self._teardown_serial()
            return

        if not data:
            return

        messages = self._parser.feed(data)
        for msg in messages:
            if isinstance(msg, NavPVT):
                self._last_pvt = msg
                self._publish_heading(msg)
                self._publish_fix_status(msg)
                self._publish_metrics(msg)

                # Kick off NTRIP now that we might have a position; no-op
                # if already running, no fix yet, or in cooldown.
                self._maybe_setup_ntrip(msg)

                if self._ntrip:
                    self._ntrip.update_position(msg.lat, msg.lon)

                # Fallback position only until first HPPOSLLH arrives
                if self._last_hpposllh is None:
                    self._publish_position(msg)

            elif isinstance(msg, NavHPPOSLLH):
                self._last_hpposllh = msg
                self._publish_hp_position(msg)

            elif isinstance(msg, NavDOP):
                self._last_dop = msg

    def _publish_position(self, pvt):
        """Publish NavSatFix from NAV-PVT."""
        msg = NavSatFix()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'gps'
        msg.latitude = pvt.lat
        msg.longitude = pvt.lon
        msg.altitude = pvt.h_msl

        # Set status based on fix type
        msg.status.service = NavSatStatus.SERVICE_GPS
        if pvt.carrier_solution == CarrierSolution.FIXED:
            msg.status.status = NavSatStatus.STATUS_GBAS_FIX
        elif pvt.fix_type >= FixType.FIX_3D:
            msg.status.status = NavSatStatus.STATUS_FIX
        else:
            msg.status.status = NavSatStatus.STATUS_NO_FIX

        # Covariance from accuracy estimates (diagonal)
        msg.position_covariance_type = NavSatFix.COVARIANCE_TYPE_DIAGONAL_KNOWN
        h_var = pvt.h_acc ** 2
        v_var = pvt.v_acc ** 2
        msg.position_covariance = [h_var, 0.0, 0.0, 0.0, h_var, 0.0, 0.0, 0.0, v_var]

        self._pub_position.publish(msg)

    def _publish_hp_position(self, hp):
        """Publish NavSatFix from NAV-HPPOSLLH (higher precision)."""
        msg = NavSatFix()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'gps'
        msg.latitude = hp.lat
        msg.longitude = hp.lon
        msg.altitude = hp.h_msl
        msg.status.service = NavSatStatus.SERVICE_GPS

        # Use fix status from latest NAV-PVT (HPPOSLLH has no fix type field)
        if self._last_pvt and self._last_pvt.carrier_solution == CarrierSolution.FIXED:
            msg.status.status = NavSatStatus.STATUS_GBAS_FIX
        elif self._last_pvt and self._last_pvt.fix_type >= FixType.FIX_3D:
            msg.status.status = NavSatStatus.STATUS_FIX
        else:
            msg.status.status = NavSatStatus.STATUS_NO_FIX

        h_var = hp.h_acc ** 2
        v_var = hp.v_acc ** 2
        msg.position_covariance_type = NavSatFix.COVARIANCE_TYPE_DIAGONAL_KNOWN
        msg.position_covariance = [h_var, 0.0, 0.0, 0.0, h_var, 0.0, 0.0, 0.0, v_var]

        self._pub_position.publish(msg)

    def _publish_heading(self, pvt):
        """Publish heading only when moving above threshold speed."""
        threshold = self.get_parameter('heading_speed_threshold').value
        if pvt.ground_speed >= threshold:
            msg = Float64()
            msg.data = pvt.heading
            self._pub_heading.publish(msg)

    def _publish_fix_status(self, pvt):
        """Publish fix status string."""
        msg = String()
        msg.data = _fix_status_string(pvt)
        self._pub_fix_status.publish(msg)

    def _publish_metrics(self, pvt):
        """Publish accuracy/speed/heading/altitude/DOP JSON for telemetry."""
        threshold = self.get_parameter('heading_speed_threshold').value
        # Prefer HPPOSLLH for position fields when available — finer than
        # NAV-PVT estimates.
        if self._last_hpposllh is not None:
            h_acc = self._last_hpposllh.h_acc
            v_acc = self._last_hpposllh.v_acc
            altitude = self._last_hpposllh.h_msl
        else:
            h_acc = pvt.h_acc
            v_acc = pvt.v_acc
            altitude = pvt.h_msl
        # Prefer NAV-DOP's PDOP when available (NAV-PVT also carries pDOP
        # but it's the same scalar at coarser resolution; NAV-DOP gives
        # us TDOP for free).
        if self._last_dop is not None:
            p_dop = self._last_dop.p_dop
            t_dop = self._last_dop.t_dop
        else:
            p_dop = pvt.p_dop
            t_dop = None
        metrics = {
            'h_acc': h_acc,
            'v_acc': v_acc,
            'altitude': altitude,
            'speed': pvt.ground_speed,
            'heading': pvt.heading if pvt.ground_speed >= threshold else None,
            'num_sv': pvt.num_sv,
            'pdop': p_dop,
            'tdop': t_dop,
        }
        msg = String()
        msg.data = json.dumps(metrics)
        self._pub_metrics.publish(msg)

    def _on_request_position(self, _msg):
        """Immediately publish cached position on request."""
        if self._last_hpposllh:
            self._publish_hp_position(self._last_hpposllh)
        elif self._last_pvt:
            self._publish_position(self._last_pvt)

    def destroy_node(self):
        if self._ntrip:
            self._ntrip.stop()
        if self._serial:
            self._serial.close()
            self._serial = None
        with self._ntrip_setup_lock:
            self._ntrip_setup_in_flight = False
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = GpsNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
