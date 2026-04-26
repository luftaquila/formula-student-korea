"""MCU Bridge Node: USB CDC link to the RP2040 coprocessor.

The MCU owns drive I/O — encoder, motor PWM, steering servo, battery
ADC, E-Stop, watchdog. The mission-specific spray servo stays on Pi
GPIO (see `spray_node`).

Subscribed topics:
    /rover/cmd/velocity        (geometry_msgs/Twist)  speed/curvature
    /rover/cmd/manual_control  (geometry_msgs/Twist)  throttle/steering %
    /rover/cmd/emergency_stop  (std_msgs/Empty)

Published topics:
    /rover/motor/status        (std_msgs/String) JSON
    /rover/battery             (std_msgs/String) JSON
    /rover/odom                (std_msgs/String) JSON {x, y, yaw, v_left, v_right}

Wire protocol: see course/rover/README.md (§ MCU coprocessor).
"""

import json
import math
import threading
import time

import rclpy
import serial
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from geometry_msgs.msg import Twist
from std_msgs.msg import Empty, String

from pilot.lib.ackermann import ackermann_convert, manual_to_ackermann


# 8S LiFePO4 voltage range used for battery percent mapping.
V_FULL_8S = 29.2
V_EMPTY_8S = 20.0


def voltage_to_percent_8s(voltage):
    if voltage is None:
        return None
    if voltage >= V_FULL_8S:
        return 100
    if voltage <= V_EMPTY_8S:
        return 0
    return int(100 * (voltage - V_EMPTY_8S) / (V_FULL_8S - V_EMPTY_8S))


class McuBridgeNode(Node):

    def __init__(self):
        super().__init__('mcu_bridge_node')

        # Serial / link
        self.declare_parameter('serial_port', '/dev/ttyMCU')
        self.declare_parameter('baud_rate', 115200)
        self.declare_parameter('heartbeat_hz', 10.0)
        self.declare_parameter('reconnect_delay_s', 2.0)

        # Ackermann + steering servo
        self.declare_parameter('servo_center_us', 1500)
        self.declare_parameter('servo_range_us', 500)
        self.declare_parameter('max_steering_angle', 25.0)
        self.declare_parameter('wheelbase', 0.38)
        self.declare_parameter('track_width', 0.30)
        self.declare_parameter('max_speed', 1.5)
        self.declare_parameter('accel_limit', 0.5)
        self.declare_parameter('manual_priority_s', 1.0)
        self.declare_parameter('command_period_s', 0.05)  # 20 Hz (navigator)

        # PID closed loop (off by default; raw duty mode is the safe baseline)
        self.declare_parameter('use_pid', False)
        self.declare_parameter('pid_kp', 0.6)
        self.declare_parameter('pid_ki', 1.5)
        self.declare_parameter('pid_kd', 0.0)

        self._validate_params()

        # State
        self._mode = 'stopped'
        self._last_cmd_t = 0.0
        self._last_manual_t = 0.0
        self._cur_left = 0.0
        self._cur_right = 0.0
        self._cur_steer_us = self.get_parameter('servo_center_us').value

        # Odom
        self._odom_x = 0.0
        self._odom_y = 0.0
        self._odom_yaw = 0.0
        self._last_telemetry_t = None

        # Serial
        self._serial = None
        self._serial_lock = threading.Lock()
        self._reader_alive = threading.Event()
        self._reader_alive.set()
        self._line_buf = b''

        reliable = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)

        self.create_subscription(Twist, '/rover/cmd/velocity', self._on_velocity, 10)
        self.create_subscription(Twist, '/rover/cmd/manual_control', self._on_manual, 10)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_estop, reliable)
        self.create_subscription(Empty, '/rover/cmd/clear_emergency', self._on_clear_estop, reliable)

        self._pub_status = self.create_publisher(String, '/rover/motor/status', 10)
        self._pub_battery = self.create_publisher(String, '/rover/battery', 10)
        self._pub_odom = self.create_publisher(String, '/rover/odom', 10)

        self._open_serial()

        hb_period = 1.0 / max(0.1, float(self.get_parameter('heartbeat_hz').value))
        self._heartbeat_timer = self.create_timer(hb_period, self._heartbeat)

        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

        # Push PID gains + mode at startup so the MCU defaults match params.
        # 'C' clears any stale software E-Stop latch left over from a prior
        # session (the MCU only honours it when the hardware line is also
        # released, so a genuinely-pressed button stays tripped).
        self._send(f'P {self._p("pid_kp")} {self._p("pid_ki")} {self._p("pid_kd")}')
        self._send(f'L {1 if self._p("use_pid") else 0}')
        self._send('C')

        self.get_logger().info('MCU bridge started')

    # ------------------------- helpers

    def _p(self, name):
        return self.get_parameter(name).value

    def _validate_params(self):
        if self._p('max_speed') < 0.1:
            self.get_logger().fatal('max_speed must be >= 0.1 m/s')
            raise SystemExit(1)
        if not (0.0 < self._p('accel_limit') <= self._p('max_speed') * 4.0):
            self.get_logger().fatal('accel_limit out of range')
            raise SystemExit(1)
        if not (500 <= self._p('servo_center_us') <= 2500):
            self.get_logger().fatal('servo_center_us out of range')
            raise SystemExit(1)
        if not (0 <= self._p('servo_range_us') <= 1000):
            self.get_logger().fatal('servo_range_us out of range')
            raise SystemExit(1)
        if not (0.0 < self._p('command_period_s') <= 0.2):
            self.get_logger().fatal('command_period_s out of range')
            raise SystemExit(1)

    def _open_serial(self):
        port = self._p('serial_port')
        baud = int(self._p('baud_rate'))
        try:
            self._serial = serial.Serial(port, baud, timeout=0.05, write_timeout=0.1)
            self.get_logger().info(f'Serial open: {port} @ {baud}')
        except Exception as e:  # noqa: BLE001 - serial errors come in many shapes
            self.get_logger().warn(f'Serial open failed ({port}): {e}')
            self._serial = None

    def _send(self, line):
        if self._serial is None:
            return
        try:
            with self._serial_lock:
                self._serial.write((line + '\n').encode('ascii', errors='ignore'))
        except Exception as e:  # noqa: BLE001
            self.get_logger().warn(f'Serial write failed: {e}')
            self._close_serial()

    def _close_serial(self):
        try:
            if self._serial is not None:
                self._serial.close()
        except Exception:
            pass
        self._serial = None

    # ------------------------- accel limit + ackermann

    def _accel_limit(self, target, current, dt):
        accel = self._p('accel_limit')
        max_speed = self._p('max_speed')
        if max_speed <= 0:
            return target
        max_delta = min((accel / max_speed * 100.0) * dt, 100.0)
        diff = target - current
        if abs(diff) > max_delta:
            return current + max_delta * (1.0 if diff > 0 else -1.0)
        return target

    def _ackermann_kwargs(self):
        return dict(
            wheelbase=self._p('wheelbase'),
            track_width=self._p('track_width'),
            max_speed=self._p('max_speed'),
            max_steering_angle_rad=math.radians(self._p('max_steering_angle')),
            servo_center_us=self._p('servo_center_us'),
            servo_range_us=self._p('servo_range_us'),
        )

    # ------------------------- ROS callbacks

    def _on_velocity(self, msg):
        now = time.monotonic()
        if self._mode == 'manual' and (now - self._last_manual_t) < self._p('manual_priority_s'):
            return
        self._mode = 'autonomous'
        self._last_cmd_t = now

        left, right, servo_us = ackermann_convert(
            speed=msg.linear.x,
            curvature=msg.angular.z,
            **self._ackermann_kwargs(),
        )
        self._drive(left, right, servo_us)

    def _on_manual(self, msg):
        now = time.monotonic()
        self._last_cmd_t = now
        self._last_manual_t = now
        self._mode = 'manual'

        left, right, servo_us = manual_to_ackermann(
            throttle_pct=msg.linear.x,
            steering_pct=msg.angular.z,
            servo_center_us=self._p('servo_center_us'),
            servo_range_us=self._p('servo_range_us'),
        )
        self._drive(left, right, servo_us)

    def _on_estop(self, _msg):
        self._mode = 'stopped'
        self._cur_left = 0.0
        self._cur_right = 0.0
        self._cur_steer_us = self._p('servo_center_us')
        self._send('E')
        self.get_logger().warn('EMERGENCY STOP')

    def _on_clear_estop(self, _msg):
        # Operator-acknowledged release. The MCU still gates the clear
        # on its hardware E-Stop line being released, so a physically-
        # held button keeps the latch on.
        self._send('C')
        self.get_logger().info('Emergency-stop clear sent to MCU')

    # ------------------------- drive

    def _drive(self, left_pct, right_pct, servo_us):
        dt = self._p('command_period_s')
        left_pct = self._accel_limit(left_pct, self._cur_left, dt)
        right_pct = self._accel_limit(right_pct, self._cur_right, dt)

        self._cur_left = left_pct
        self._cur_right = right_pct
        self._cur_steer_us = int(round(servo_us))

        if self._p('use_pid'):
            max_speed = self._p('max_speed')
            l_mps = left_pct / 100.0 * max_speed
            r_mps = right_pct / 100.0 * max_speed
            self._send(f'V {l_mps:.3f} {r_mps:.3f} {self._cur_steer_us}')
        else:
            self._send(f'M {left_pct/100.0:.3f} {right_pct/100.0:.3f} {self._cur_steer_us}')

        self._pub_status.publish(self._json_msg({
            'left_duty': round(left_pct, 1),
            'right_duty': round(right_pct, 1),
            'servo_us': self._cur_steer_us,
            'mode': self._mode,
        }))

    # ------------------------- heartbeat

    def _heartbeat(self):
        # Reconnect is owned by the reader loop (rate-limited by
        # `reconnect_delay_s`). _send is a no-op when the port is closed,
        # so the heartbeat tick stays cheap and silent during MCU outages.
        self._send('H')

    # ------------------------- reader

    def _reader_loop(self):
        delay = float(self._p('reconnect_delay_s'))
        while self._reader_alive.is_set():
            if self._serial is None:
                time.sleep(delay)
                self._open_serial()
                continue
            try:
                chunk = self._serial.read(256)
            except Exception as e:  # noqa: BLE001
                self.get_logger().warn(f'Serial read failed: {e}')
                self._close_serial()
                time.sleep(delay)
                continue

            if not chunk:
                continue
            self._line_buf += chunk
            while b'\n' in self._line_buf:
                line, _, self._line_buf = self._line_buf.partition(b'\n')
                self._dispatch_line(line.strip().decode('ascii', errors='ignore'))

    def _dispatch_line(self, line):
        if not line:
            return
        if line[0] == 'T':
            self._handle_telemetry(line)
        elif line[0] == '!':
            self.get_logger().warn(f'MCU event: {line[1:].strip()}')

    def _handle_telemetry(self, line):
        # T <ms> <enc_l> <enc_r> <vel_l> <vel_r> <vbat> <flags>
        parts = line.split()
        if len(parts) != 8:
            return
        try:
            _ms = int(parts[1])
            _enc_l = int(parts[2])
            _enc_r = int(parts[3])
            vl = float(parts[4])
            vr = float(parts[5])
            vbat = float(parts[6])
            flags = int(parts[7], 0)
        except ValueError:
            return

        # Battery JSON: {voltage, percent, source, flags}.
        self._pub_battery.publish(self._json_msg({
            'voltage': round(vbat, 3),
            'percent': voltage_to_percent_8s(vbat),
            'source': 'mcu',
            'flags': flags,
        }))

        # Odometry — integrate (vl, vr) into a 2D pose.
        now_t = time.monotonic()
        if self._last_telemetry_t is None:
            dt = 0.0
        else:
            dt = now_t - self._last_telemetry_t
        self._last_telemetry_t = now_t

        if 0.0 < dt < 0.5:
            track = self._p('track_width')
            v = (vl + vr) * 0.5
            w = (vr - vl) / max(track, 1e-3)
            self._odom_yaw += w * dt
            self._odom_x += v * math.cos(self._odom_yaw) * dt
            self._odom_y += v * math.sin(self._odom_yaw) * dt

        self._pub_odom.publish(self._json_msg({
            'x': round(self._odom_x, 3),
            'y': round(self._odom_y, 3),
            'yaw': round(self._odom_yaw, 4),
            'v_left': round(vl, 3),
            'v_right': round(vr, 3),
        }))

    def _json_msg(self, payload):
        msg = String()
        msg.data = json.dumps(payload)
        return msg

    # ------------------------- shutdown

    def destroy_node(self):
        # Don't send 'E' on shutdown — that would latch g_tripped on the
        # MCU and outlive the snap restart. Heartbeats stopping naturally
        # trips the MCU's Pi-link WDT (500 ms) and motors stop on their
        # own; the latch isn't needed and is hard to clear.
        self._reader_alive.clear()
        self._close_serial()
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = McuBridgeNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
