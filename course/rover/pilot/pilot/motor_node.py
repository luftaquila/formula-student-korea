"""Motor Node: MDD10A driver + S20F steering servo with Ackermann kinematics.

Controls the Cytron MDD10A dual motor driver (GPIO PWM+DIR) for rear-wheel
drive and the S20F servo for front Ackermann steering.

Subscribed topics:
    /rover/cmd/velocity (geometry_msgs/Twist) - Autonomous velocity commands
    /rover/cmd/manual_control (geometry_msgs/Twist) - Manual joystick commands
    /rover/cmd/emergency_stop (std_msgs/Empty) - Emergency stop

Published topics:
    /rover/motor/status (std_msgs/String) - Motor status JSON
"""

import json
import time
import lgpio
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from geometry_msgs.msg import Twist
from std_msgs.msg import Empty, String
from math import radians

from pilot.lib.ackermann import ackermann_convert, manual_to_ackermann
from pilot.lib.mdd10a import MDD10A

SERVO_FREQUENCY = 50  # 50Hz for standard RC servos


class MotorNode(Node):

    def __init__(self):
        super().__init__('motor_node')

        # Parameters
        self.declare_parameter('dir1_pin', 23)
        self.declare_parameter('pwm1_pin', 24)
        self.declare_parameter('dir2_pin', 27)
        self.declare_parameter('pwm2_pin', 22)
        self.declare_parameter('steering_pin', 12)
        self.declare_parameter('servo_center_us', 1500)
        self.declare_parameter('servo_range_us', 500)
        self.declare_parameter('max_steering_angle', 25.0)
        self.declare_parameter('wheelbase', 0.38)
        self.declare_parameter('track_width', 0.30)
        self.declare_parameter('max_speed', 1.5)
        self.declare_parameter('watchdog_timeout', 0.5)
        self.declare_parameter('accel_limit', 0.5)
        self.declare_parameter('gpio_chip', 4)

        self._validate_params()

        # Initialize MDD10A motor driver
        self._mdd10a = MDD10A(
            dir1_pin=self.get_parameter('dir1_pin').value,
            pwm1_pin=self.get_parameter('pwm1_pin').value,
            dir2_pin=self.get_parameter('dir2_pin').value,
            pwm2_pin=self.get_parameter('pwm2_pin').value,
            chip=self.get_parameter('gpio_chip').value,
        )

        # Initialize steering servo via lgpio
        self._gpio_handle = lgpio.gpiochip_open(self.get_parameter('gpio_chip').value)
        self._steering_pin = self.get_parameter('steering_pin').value
        self._set_servo_us(self.get_parameter('servo_center_us').value)

        # State
        self._mode = 'stopped'  # 'autonomous', 'manual', 'stopped'
        self._last_cmd_time = 0.0
        self._last_manual_time = 0.0
        self._current_left_duty = 0.0
        self._current_right_duty = 0.0

        # Subscribers
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)

        self.create_subscription(Twist, '/rover/cmd/velocity', self._on_velocity, 10)
        self.create_subscription(Twist, '/rover/cmd/manual_control', self._on_manual, 10)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_emergency_stop, reliable_qos)

        # Publisher
        self._pub_status = self.create_publisher(String, '/rover/motor/status', 10)

        # Watchdog timer (check at 20Hz)
        self._watchdog_timer = self.create_timer(0.05, self._watchdog_check)

        self.get_logger().info('Motor node started')

    def _validate_params(self):
        """Sanity-check critical parameters; fail loudly if misconfigured."""
        max_speed = self.get_parameter('max_speed').value
        accel = self.get_parameter('accel_limit').value
        center = self.get_parameter('servo_center_us').value
        rng = self.get_parameter('servo_range_us').value

        if max_speed < 0.1:
            self.get_logger().fatal(f'max_speed must be >= 0.1 m/s (got {max_speed})')
            raise SystemExit(1)
        if not (0.0 < accel <= max_speed * 4.0):
            self.get_logger().fatal(
                f'accel_limit must be in (0, max_speed*4]; got {accel} (max_speed={max_speed})'
            )
            raise SystemExit(1)
        if not (500 <= center <= 2500):
            self.get_logger().fatal(f'servo_center_us must be in [500, 2500]; got {center}')
            raise SystemExit(1)
        if not (0 <= rng <= 1000):
            self.get_logger().fatal(f'servo_range_us must be in [0, 1000]; got {rng}')
            raise SystemExit(1)

    def _set_servo_us(self, pulse_us):
        """Set steering servo pulse width in microseconds."""
        # Convert pulse width to duty cycle percentage for 50Hz
        # Period = 20000us at 50Hz, duty = pulse_us / 20000 * 100
        duty_pct = (pulse_us / 20000.0) * 100.0
        lgpio.tx_pwm(self._gpio_handle, self._steering_pin, SERVO_FREQUENCY, duty_pct)

    def _apply_accel_limit(self, target, current, dt):
        """Apply acceleration limiting to duty cycle."""
        accel = self.get_parameter('accel_limit').value
        max_speed = self.get_parameter('max_speed').value
        if max_speed <= 0:
            return target

        # Convert accel (m/s^2) to duty%/s, clamp to 100 duty%/s hard ceiling
        # so a misconfigured accel_limit can't jerk the motors in a single tick.
        max_delta = min((accel / max_speed * 100.0) * dt, 100.0)
        diff = target - current
        if abs(diff) > max_delta:
            return current + max_delta * (1.0 if diff > 0 else -1.0)
        return target

    def _on_velocity(self, msg):
        """Handle autonomous velocity command (Twist: linear.x=speed, angular.z=curvature)."""
        now = time.monotonic()

        # Manual control takes priority (within 1 second)
        if self._mode == 'manual' and (now - self._last_manual_time) < 1.0:
            return

        if self._mode == 'stopped':
            self._mode = 'autonomous'

        self._last_cmd_time = now
        self._mode = 'autonomous'

        params = self._get_ackermann_params()
        left, right, servo_us = ackermann_convert(
            speed=msg.linear.x,
            curvature=msg.angular.z,
            **params,
        )

        self._drive(left, right, servo_us)

    def _on_manual(self, msg):
        """Handle manual joystick command (Twist: linear.x=throttle%, angular.z=steering%)."""
        now = time.monotonic()
        self._last_cmd_time = now
        self._last_manual_time = now
        self._mode = 'manual'

        center_us = self.get_parameter('servo_center_us').value
        range_us = self.get_parameter('servo_range_us').value

        left, right, servo_us = manual_to_ackermann(
            throttle_pct=msg.linear.x,
            steering_pct=msg.angular.z,
            servo_center_us=center_us,
            servo_range_us=range_us,
        )

        self._drive(left, right, servo_us)

    def _on_emergency_stop(self, _msg):
        """Emergency stop: immediately zero everything."""
        self._mode = 'stopped'
        self._mdd10a.stop()
        self._set_servo_us(self.get_parameter('servo_center_us').value)
        self._current_left_duty = 0.0
        self._current_right_duty = 0.0
        self.get_logger().warn('EMERGENCY STOP')

    def _drive(self, left_duty, right_duty, servo_us):
        """Apply motor duties and steering with acceleration limiting."""
        dt = 0.05  # approximate control period

        left_duty = self._apply_accel_limit(left_duty, self._current_left_duty, dt)
        right_duty = self._apply_accel_limit(right_duty, self._current_right_duty, dt)

        self._mdd10a.set_motor(1, left_duty)
        self._mdd10a.set_motor(2, right_duty)
        self._set_servo_us(servo_us)

        self._current_left_duty = left_duty
        self._current_right_duty = right_duty

        # Publish status
        status = String()
        status.data = json.dumps({
            'left_duty': round(left_duty, 1),
            'right_duty': round(right_duty, 1),
            'servo_us': round(servo_us),
            'mode': self._mode,
        })
        self._pub_status.publish(status)

    def _watchdog_check(self):
        """Stop motors if no command received within timeout."""
        if self._mode == 'stopped':
            return

        timeout = self.get_parameter('watchdog_timeout').value
        elapsed = time.monotonic() - self._last_cmd_time

        if elapsed > timeout:
            self._mdd10a.stop()
            self._set_servo_us(self.get_parameter('servo_center_us').value)
            self._current_left_duty = 0.0
            self._current_right_duty = 0.0
            self.get_logger().warn(f'Watchdog: no command for {elapsed:.1f}s, motors stopped')
            self._mode = 'stopped'

    def _get_ackermann_params(self):
        """Get Ackermann parameters from ROS parameters."""
        return {
            'wheelbase': self.get_parameter('wheelbase').value,
            'track_width': self.get_parameter('track_width').value,
            'max_speed': self.get_parameter('max_speed').value,
            'max_steering_angle_rad': radians(self.get_parameter('max_steering_angle').value),
            'servo_center_us': self.get_parameter('servo_center_us').value,
            'servo_range_us': self.get_parameter('servo_range_us').value,
        }

    def destroy_node(self):
        self._mdd10a.cleanup()
        lgpio.gpiochip_close(self._gpio_handle)
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = MotorNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
