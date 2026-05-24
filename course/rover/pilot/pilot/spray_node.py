"""Dispenser Node: chalk-powder pocket-wheel actuator at waypoints.

Drives an MG995 positional servo whose PWM is owned by the rover MCU
(RP2040-Zero, GPIO 7, slice 3 ch B). This node converts the per-shot
target angle to a pulse width in microseconds and publishes it on
/rover/cmd/dispenser_us; mcu_bridge_node forwards verbatim to the MCU
as 'D <us>' over USB CDC. The MCU clamps + slews the pulse on the
servo control tick. No GPIO is touched here.

Each waypoint trigger toggles the wheel between two dispense angles
(A and B); one toggle = one ~5 g shot of powder. The wheel has only
two valid rest positions (A and B) — there is no return-to-rest. The
pocket fills under the hopper at one angle and drops over the drop
port at the other. State alternates per trigger; toggle_state survives
across waypoints.

Topic names are retained as /rover/spray/* for compatibility with the
navigator and bridge nodes.

Subscribed topics:
    /rover/nav/waypoint_reached (std_msgs/Int32) - Waypoint index reached
    /rover/cmd/emergency_stop (std_msgs/Empty) - Cancel dispense in progress
    /rover/spray/cancel (std_msgs/Int32) - Abort dispense on a specific
                                           waypoint without entering
                                           EMERGENCY_STOP state (used by
                                           navigator on dispense timeout
                                           to suppress a late _signal_done).

Published topics:
    /rover/cmd/dispenser_us (std_msgs/Int32) - Servo pulse width in µs,
                                               consumed by mcu_bridge_node
                                               and forwarded to the MCU.
    /rover/spray/done (std_msgs/Empty) - Dispense cycle complete
    /rover/spray/result (std_msgs/String) - JSON {waypoint, outcome}
"""

import json

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from std_msgs.msg import Int32, Empty, String


def _angle_to_pulse_us(angle_deg):
    """Convert servo angle (0-180°) to pulse width in µs.

    0° = 500 µs, 90° = 1500 µs, 180° = 2500 µs (MG995 full travel).
    The MCU re-clamps per-servo to SERVO_DISPENSER_{MIN,MAX}_US so
    out-of-range values cannot drive past the mechanical stops.
    """
    return int(round(500 + (angle_deg / 180.0) * 2000))


class SprayNode(Node):

    def __init__(self):
        super().__init__('spray_node')

        # Parameters
        # Two dispense angles. The wheel alternates between these on
        # each waypoint trigger; one toggle = one shot. There is no
        # "rest" position — A and B are both valid stop positions.
        self.declare_parameter('dispense_angle_a', 0)
        self.declare_parameter('dispense_angle_b', 90)
        # Time to allow the servo to complete its travel and the pocket
        # to fully empty into the drop tube before publishing done.
        # MG995 60°/0.16s @ 6V → ~0.25s for 90°; add margin.
        self.declare_parameter('settle_duration', 0.4)

        self._validate_params()

        # Publisher: pulse_us to MCU bridge (forwarded as 'D <us>').
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_dispenser = self.create_publisher(
            Int32, '/rover/cmd/dispenser_us', reliable_qos)

        # Drive to angle_b (dump position) on boot so any chalk left in
        # the pocket from a previous run drops out before the rover
        # starts moving. Best-effort: the MCU bridge may not yet be
        # ready / connected; later commands will re-sync the servo
        # regardless.
        angle_b = self.get_parameter('dispense_angle_b').value
        self._publish_pulse_us(_angle_to_pulse_us(angle_b))

        # State
        self._spraying = False
        self._dispense_timer = None
        self._current_wp_idx = -1
        # Toggle state: 0 → next dispense rotates to angle_b; 1 → angle_a.
        # Starts at 1 because boot drove the servo to angle_b above, so
        # the first waypoint rotates back to angle_a (load the pocket).
        self._toggle_state = 1
        # Index of the most recent waypoint cancelled by navigator timeout.
        # Guards _signal_done from publishing a stale 'success' result for
        # a waypoint navigator already published 'timeout' for.
        self._cancelled_wp_idx = -1

        # Subscribers
        self.create_subscription(Int32, '/rover/nav/waypoint_reached', self._on_waypoint_reached, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_emergency_stop, reliable_qos)
        self.create_subscription(Int32, '/rover/spray/cancel', self._on_spray_cancel, reliable_qos)

        # Publishers
        self._pub_done = self.create_publisher(Empty, '/rover/spray/done', reliable_qos)
        self._pub_result = self.create_publisher(String, '/rover/spray/result', reliable_qos)

        self.get_logger().info('Dispenser node started (MCU-routed)')

    def _publish_pulse_us(self, pulse_us):
        msg = Int32()
        msg.data = int(pulse_us)
        self._pub_dispenser.publish(msg)

    def _publish_result(self, outcome, wp_idx):
        """Emit a dispense outcome for the course server / UI."""
        msg = String()
        msg.data = json.dumps({'waypoint': int(wp_idx), 'outcome': outcome})
        self._pub_result.publish(msg)

    def _validate_params(self):
        """Sanity-check dispense parameters."""
        angle_a = self.get_parameter('dispense_angle_a').value
        angle_b = self.get_parameter('dispense_angle_b').value
        settle = self.get_parameter('settle_duration').value

        if not (0 <= angle_a <= 180):
            self.get_logger().fatal(f'dispense_angle_a must be in [0, 180]; got {angle_a}')
            raise SystemExit(1)
        if not (0 <= angle_b <= 180):
            self.get_logger().fatal(f'dispense_angle_b must be in [0, 180]; got {angle_b}')
            raise SystemExit(1)
        if angle_a == angle_b:
            self.get_logger().fatal(f'dispense_angle_a and _b must differ; both = {angle_a}')
            raise SystemExit(1)
        if not (0.0 < settle <= 10.0):
            self.get_logger().fatal(f'settle_duration must be in (0, 10]s; got {settle}')
            raise SystemExit(1)

    def _safe_destroy_timer(self, timer):
        """Cancel and destroy a timer, ignoring any failure (double-destroy safe)."""
        if timer is None:
            return None
        try:
            timer.cancel()
        except Exception:
            pass
        try:
            self.destroy_timer(timer)
        except Exception:
            pass
        return None

    def _on_waypoint_reached(self, msg):
        """Toggle the dispenser servo and schedule done after settle."""
        if self._spraying:
            return

        self._spraying = True
        wp_idx = msg.data
        self._current_wp_idx = wp_idx

        angle_a = self.get_parameter('dispense_angle_a').value
        angle_b = self.get_parameter('dispense_angle_b').value
        # _toggle_state = 0 → physical state is angle_a → move to angle_b.
        target_angle = angle_b if self._toggle_state == 0 else angle_a
        target_us = _angle_to_pulse_us(target_angle)
        self.get_logger().info(
            f'Dispensing at waypoint {wp_idx} (target {target_angle}° = {target_us} µs)'
        )
        self._publish_pulse_us(target_us)
        self._toggle_state ^= 1

        # Schedule done after the servo settles and the pocket empties.
        settle = self.get_parameter('settle_duration').value
        self._dispense_timer = self.create_timer(settle, self._signal_done, callback_group=None)

    def _signal_done(self):
        """Signal dispense cycle complete. Always publishes done regardless of timer state."""
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        was_spraying = self._spraying
        wp_idx = self._current_wp_idx
        self._spraying = False
        # If this waypoint was cancelled (navigator timeout) between when
        # _signal_done was scheduled and when it actually ran, suppress
        # the 'success' result so we don't race the navigator's 'timeout'.
        cancelled = (self._cancelled_wp_idx == wp_idx)
        if cancelled:
            self._cancelled_wp_idx = -1
        # Always publish done so the navigator never blocks on a missed signal
        try:
            self._pub_done.publish(Empty())
            if was_spraying and wp_idx >= 0 and not cancelled:
                self._publish_result('success', wp_idx)
        finally:
            self.get_logger().info('Dispense done')

    def _on_emergency_stop(self, _msg):
        """Emergency stop: cancel any pending timer; do NOT move the servo.

        Both dispense angles are valid stop positions for the wheel —
        there is no "rest" to retract to. On E-stop we simply abort the
        pending settle timer and let the wheel sit at whichever angle
        it last rotated to. The logical _toggle_state remains coherent
        because we already flipped it when the dispense was issued.
        """
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        was_spraying = self._spraying
        wp_idx = self._current_wp_idx
        self._spraying = False
        if was_spraying and wp_idx >= 0:
            self._publish_result('cancelled', wp_idx)

    def _on_spray_cancel(self, msg):
        """Abort the current dispense cycle without leaving SPRAYING for EMERGENCY_STOP.

        Used when the navigator times out waiting for spray/done.
        The wheel position is left where it is (both angles are valid stops).
        """
        target_idx = int(msg.data)
        if not self._spraying or self._current_wp_idx != target_idx:
            return
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        # Mark this waypoint cancelled so a queued _signal_done callback
        # racing on the single-threaded executor can't publish a stale
        # 'success' for what navigator has already declared a 'timeout'.
        self._cancelled_wp_idx = target_idx
        self._spraying = False
        # Intentionally do NOT publish a result here — navigator already did.

    def destroy_node(self):
        # Park the servo at angle_b (dump) so subsequent boots align
        # logical and physical state, and any loaded pocket drops on
        # shutdown. Best-effort: MCU bridge may have shut down too.
        try:
            angle_b = self.get_parameter('dispense_angle_b').value
            self._publish_pulse_us(_angle_to_pulse_us(angle_b))
        except Exception:
            pass
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
