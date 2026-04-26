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

import json
import time

import serial
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import NavSatFix, NavSatStatus
from std_msgs.msg import Float64, String, Empty

from pilot.lib.ubx_parser import (
    UBXParser, NavPVT, NavHPPOSLLH,
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
# travels in as the `ntrip-username` snap key. Update these constants if
# NGII ever changes the caster endpoint.
_NTRIP_HOST = 'www.gnssdata.or.kr'
_NTRIP_PORT = 2101
_NTRIP_PASSWORD = 'gnss'

# Retry NTRIP auto-setup at most this often when source-table fetch or
# mount selection fails. Long enough that a down caster doesn't busy-loop;
# short enough that a transient network blip clears within a minute.
_NTRIP_SETUP_COOLDOWN_S = 30.0

# Retry opening /dev/ttyACM0 this many times at startup before giving up.
# The ZED-F9P can take a few seconds to enumerate after power-on, so a
# retry loop lets the snap daemon restart-condition do less heavy lifting.
_SERIAL_OPEN_RETRIES = 6
_SERIAL_OPEN_BACKOFF_S = 2.0


def _fix_status_string(pvt):
    """Convert NavPVT to human-readable fix status."""
    if pvt.fix_type == FixType.NO_FIX:
        return 'no_fix'
    if pvt.carrier_solution == CarrierSolution.FIXED:
        return 'rtk_fixed'
    if pvt.carrier_solution == CarrierSolution.FLOAT:
        return 'rtk_float'
    if pvt.fix_type >= FixType.FIX_3D:
        return '3d_fix'
    return 'no_fix'


# UBX CFG key IDs for configuring output messages
CFG_MSGOUT_UBX_NAV_PVT_USB = 0x20910009
CFG_MSGOUT_UBX_NAV_HPPOSLLH_USB = 0x20910036
CFG_MSGOUT_NMEA_GGA_USB = 0x209100BD
CFG_MSGOUT_NMEA_RMC_USB = 0x209100AE
CFG_MSGOUT_NMEA_GSV_USB = 0x209100C4
CFG_MSGOUT_NMEA_GSA_USB = 0x209100C1
CFG_MSGOUT_NMEA_GLL_USB = 0x209100CA
CFG_MSGOUT_NMEA_VTG_USB = 0x209100B3


class GpsNode(Node):

    def __init__(self):
        super().__init__('gps_node')

        # Parameters
        self.declare_parameter('serial_port', '/dev/ttyGPS')
        self.declare_parameter('baud_rate', 115200)
        self.declare_parameter('publish_rate', 10.0)
        self.declare_parameter('heading_speed_threshold', 0.3)
        self.declare_parameter('ntrip.username', '')
        self.declare_parameter('ntrip.gga_interval_s', 10.0)

        # Publishers
        self._pub_position = self.create_publisher(NavSatFix, '/rover/gps/position', 10)
        self._pub_heading = self.create_publisher(Float64, '/rover/gps/heading', 10)
        self._pub_fix_status = self.create_publisher(String, '/rover/gps/fix_status', 10)
        self._pub_ntrip_status = self.create_publisher(String, '/rover/ntrip/status', 1)

        # Subscriber for position request
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self.create_subscription(Empty, '/rover/cmd/request_position', self._on_request_position, reliable_qos)

        # State
        self._parser = UBXParser()
        self._last_pvt = None
        self._last_hpposllh = None
        self._serial = None
        self._ntrip = None
        # NTRIP auto-setup is deferred until we have a real 3D fix so we
        # can pick the nearest base station. These track retry timing.
        self._ntrip_last_attempt = 0.0

        # Open serial port and configure ZED-F9P
        self._open_serial()
        self._configure_receiver()
        # NTRIP is started lazily from _read_serial once a 3D fix arrives —
        # the mountpoint is chosen by nearest distance to the caster's
        # published base stations, so we need a position first.

        # Timer for reading serial data
        rate = self.get_parameter('publish_rate').value
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
        # All retries exhausted — re-raise so the snap daemon restart logic
        # kicks in with a clear trail of attempts in the log.
        raise last_exc

    def _configure_receiver(self):
        """Configure ZED-F9P to output UBX NAV-PVT and NAV-HPPOSLLH, disable NMEA."""
        cfg = build_cfg_valset([
            (CFG_MSGOUT_UBX_NAV_PVT_USB, 1, 'B'),       # Enable NAV-PVT on USB
            (CFG_MSGOUT_UBX_NAV_HPPOSLLH_USB, 1, 'B'),   # Enable NAV-HPPOSLLH on USB
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
        self._ntrip_last_attempt = now

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

        mount = select_nearest_mountpoint(pvt.lat, pvt.lon, entries)
        if not mount:
            self.get_logger().warn(
                f'NTRIP: no RTCM 3.2 mountpoint in source table of {len(entries)} entries '
                f'— retry in {_NTRIP_SETUP_COOLDOWN_S:.0f}s'
            )
            return

        self.get_logger().info(
            f'NTRIP: auto-selected "{mount}" for position '
            f'({pvt.lat:.5f}, {pvt.lon:.5f})'
        )
        self._ntrip = NTRIPClient(
            host=_NTRIP_HOST,
            port=_NTRIP_PORT,
            mountpoint=mount,
            username=username,
            password=_NTRIP_PASSWORD,
            serial_port=self._serial,
            lat=pvt.lat,
            lon=pvt.lon,
            logger=self.get_logger(),
        )
        self._ntrip._gga_interval = self.get_parameter('ntrip.gga_interval_s').value
        self._ntrip.start()

    def _read_serial(self):
        """Read and parse UBX data from serial port."""
        try:
            data = self._serial.read(self._serial.in_waiting or 1)
        except serial.SerialException as e:
            self.get_logger().error(f'Serial read error: {e}')
            return

        if not data:
            return

        messages = self._parser.feed(data)
        for msg in messages:
            if isinstance(msg, NavPVT):
                self._last_pvt = msg
                self._publish_heading(msg)
                self._publish_fix_status(msg)

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
