"""Spray Node: Servo actuator for spray marking at waypoints.

Controls a standard RC servo via RPi5 GPIO PWM to actuate spray
at each reached waypoint.

Subscribed topics:
    /rover/nav/waypoint_reached (std_msgs/Int32) - Waypoint index reached
    /rover/cmd/emergency_stop (std_msgs/Empty) - Cancel spray in progress

Published topics:
    /rover/spray/done (std_msgs/Empty) - Spray cycle complete
"""

import lgpio
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from std_msgs.msg import Int32, Empty

SERVO_FREQUENCY = 50  # 50Hz for standard RC servos


def _angle_to_duty(angle_deg):
    """Convert servo angle (0-180) to duty cycle % for 50Hz PWM.

    0 deg = 500us = 2.5%, 90 deg = 1500us = 7.5%, 180 deg = 2500us = 12.5%
    """
    pulse_us = 500 + (angle_deg / 180.0) * 2000
    return (pulse_us / 20000.0) * 100.0


class SprayNode(Node):

    def __init__(self):
        super().__init__('spray_node')

        # Parameters
        self.declare_parameter('servo_pin', 13)
        self.declare_parameter('spray_angle', 90)
        self.declare_parameter('rest_angle', 0)
        self.declare_parameter('spray_duration', 0.5)
        self.declare_parameter('retract_delay', 0.3)
        self.declare_parameter('gpio_chip', 4)

        # Initialize GPIO
        chip = self.get_parameter('gpio_chip').value
        self._handle = lgpio.gpiochip_open(chip)
        self._pin = self.get_parameter('servo_pin').value

        # Start at rest position
        rest = self.get_parameter('rest_angle').value
        lgpio.tx_pwm(self._handle, self._pin, SERVO_FREQUENCY, _angle_to_duty(rest))

        # State
        self._spraying = False
        self._spray_timer = None
        self._retract_timer = None

        # Subscribers
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self.create_subscription(Int32, '/rover/nav/waypoint_reached', self._on_waypoint_reached, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_emergency_stop, reliable_qos)

        # Publisher
        self._pub_done = self.create_publisher(Empty, '/rover/spray/done', reliable_qos)

        self.get_logger().info('Spray node started')

    def _on_waypoint_reached(self, msg):
        """Actuate spray servo at reached waypoint."""
        if self._spraying:
            return

        self._spraying = True
        wp_idx = msg.data
        self.get_logger().info(f'Spraying at waypoint {wp_idx}')

        # Move to spray position
        spray_angle = self.get_parameter('spray_angle').value
        lgpio.tx_pwm(self._handle, self._pin, SERVO_FREQUENCY, _angle_to_duty(spray_angle))

        # Schedule retract after spray_duration
        duration = self.get_parameter('spray_duration').value
        self._spray_timer = self.create_timer(duration, self._retract, callback_group=None)

    def _retract(self):
        """Retract servo to rest position."""
        if self._spray_timer:
            self._spray_timer.cancel()
            self.destroy_timer(self._spray_timer)
            self._spray_timer = None

        rest_angle = self.get_parameter('rest_angle').value
        lgpio.tx_pwm(self._handle, self._pin, SERVO_FREQUENCY, _angle_to_duty(rest_angle))

        # Schedule done signal after retract_delay
        delay = self.get_parameter('retract_delay').value
        self._retract_timer = self.create_timer(delay, self._signal_done, callback_group=None)

    def _signal_done(self):
        """Signal spray cycle complete."""
        if self._retract_timer:
            self._retract_timer.cancel()
            self.destroy_timer(self._retract_timer)
            self._retract_timer = None

        self._spraying = False
        self._pub_done.publish(Empty())
        self.get_logger().info('Spray done')

    def _on_emergency_stop(self, _msg):
        """Emergency: retract immediately."""
        if self._spray_timer:
            self._spray_timer.cancel()
            self.destroy_timer(self._spray_timer)
            self._spray_timer = None
        if self._retract_timer:
            self._retract_timer.cancel()
            self.destroy_timer(self._retract_timer)
            self._retract_timer = None

        rest_angle = self.get_parameter('rest_angle').value
        lgpio.tx_pwm(self._handle, self._pin, SERVO_FREQUENCY, _angle_to_duty(rest_angle))
        self._spraying = False

    def destroy_node(self):
        rest_angle = self.get_parameter('rest_angle').value
        lgpio.tx_pwm(self._handle, self._pin, SERVO_FREQUENCY, _angle_to_duty(rest_angle))
        lgpio.gpiochip_close(self._handle)
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = SprayNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
