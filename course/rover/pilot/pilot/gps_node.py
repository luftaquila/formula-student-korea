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
from pilot.lib.ntrip_client import NTRIPClient


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
        self.declare_parameter('serial_port', '/dev/ttyACM0')
        self.declare_parameter('baud_rate', 115200)
        self.declare_parameter('publish_rate', 10.0)
        self.declare_parameter('heading_speed_threshold', 0.3)
        self.declare_parameter('ntrip.host', '')
        self.declare_parameter('ntrip.port', 2101)
        self.declare_parameter('ntrip.mountpoint', '')
        self.declare_parameter('ntrip.username', '')
        self.declare_parameter('ntrip.password', '')
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

        # Open serial port and configure ZED-F9P
        self._open_serial()
        self._configure_receiver()
        self._start_ntrip()

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
        self._serial = serial.Serial(port, baud, timeout=0.1)
        self.get_logger().info(f'Opened GPS serial: {port} @ {baud}')

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

    def _start_ntrip(self):
        """Start NTRIP client if configured."""
        host = self.get_parameter('ntrip.host').value
        if not host:
            self.get_logger().info('NTRIP not configured, running without RTK corrections')
            return

        self._ntrip = NTRIPClient(
            host=host,
            port=self.get_parameter('ntrip.port').value,
            mountpoint=self.get_parameter('ntrip.mountpoint').value,
            username=self.get_parameter('ntrip.username').value,
            password=self.get_parameter('ntrip.password').value,
            serial_port=self._serial,
            logger=self.get_logger(),
        )
        # Apply GGA interval from config (exposed as attribute so tests/ops can tweak)
        self._ntrip._gga_interval = self.get_parameter('ntrip.gga_interval_s').value
        self._ntrip.start()
        self.get_logger().info(f'NTRIP client started: {host}')

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
