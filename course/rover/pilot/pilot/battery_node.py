"""Battery Node: Publishes battery voltage/percent from an I2C monitor.

Current status: software-only. The hardware monitor (e.g. INA219 at I2C 0x40)
is not wired yet, so by default the node publishes a simulated value from
the `simulated_voltage` parameter. When hardware is installed, replace the
body of `_read_voltage` with an INA219 read.

Published topics:
    /rover/battery (std_msgs/String) - JSON {voltage, percent, source}
"""

import json

import rclpy
from rclpy.node import Node
from std_msgs.msg import String

# Simple linear voltage→percent mapping for a 3S LiPo (12.6 V full, 9.9 V empty).
V_FULL = 12.6
V_EMPTY = 9.9


def voltage_to_percent(voltage):
    if voltage is None:
        return None
    if voltage >= V_FULL:
        return 100
    if voltage <= V_EMPTY:
        return 0
    return int(100 * (voltage - V_EMPTY) / (V_FULL - V_EMPTY))


class BatteryNode(Node):

    def __init__(self):
        super().__init__('battery_node')

        # Parameters
        self.declare_parameter('publish_rate', 1.0)      # Hz
        self.declare_parameter('source', 'simulated')    # 'simulated' | 'ina219'
        self.declare_parameter('simulated_voltage', 12.3)  # V — overridden at runtime
        self.declare_parameter('warn_percent', 30)
        self.declare_parameter('i2c_bus', 1)
        self.declare_parameter('i2c_address', 0x40)

        self._pub = self.create_publisher(String, '/rover/battery', 10)

        rate = self.get_parameter('publish_rate').value
        if rate <= 0:
            rate = 1.0
        self._timer = self.create_timer(1.0 / rate, self._publish_battery)

        self.get_logger().info(
            f'Battery node started (source={self.get_parameter("source").value})'
        )

    def _read_voltage(self):
        source = self.get_parameter('source').value
        if source == 'ina219':
            return self._read_ina219()
        return float(self.get_parameter('simulated_voltage').value)

    def _read_ina219(self):
        """Placeholder for the real INA219 I2C read. Returns None if unavailable."""
        try:
            import smbus2  # type: ignore
        except ImportError:
            self.get_logger().warn('smbus2 not available; battery source ina219 disabled')
            return None
        try:
            bus = smbus2.SMBus(int(self.get_parameter('i2c_bus').value))
            addr = int(self.get_parameter('i2c_address').value)
            # INA219 bus voltage register (0x02), 13-bit, 4 mV/LSB
            raw = bus.read_word_data(addr, 0x02)
            # Swap bytes (INA219 returns big-endian)
            raw = ((raw & 0xFF) << 8) | (raw >> 8)
            voltage = ((raw >> 3) * 4) / 1000.0  # mV → V
            bus.close()
            return voltage
        except Exception as e:
            self.get_logger().warn(f'INA219 read failed: {e}')
            return None

    def _publish_battery(self):
        voltage = self._read_voltage()
        percent = voltage_to_percent(voltage)
        payload = {
            'voltage': None if voltage is None else round(float(voltage), 3),
            'percent': percent,
            'source': self.get_parameter('source').value,
        }
        msg = String()
        msg.data = json.dumps(payload)
        self._pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = BatteryNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
