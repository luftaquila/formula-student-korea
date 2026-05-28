"""Dispenser Node: chalk-powder drum actuator at waypoints.

Drives an MG995 positional servo whose PWM is owned by the rover MCU
(RP2040-Zero, GPIO 7, slice 3 ch B). This node converts the target
angle to a pulse width in microseconds and publishes it on
/rover/cmd/dispenser_us; mcu_bridge_node forwards verbatim to the MCU
as 'D <us>' over USB CDC. The MCU clamps + slews the pulse on the
servo control tick. No GPIO is touched here.

Dispense model: the drum has ONE rest position — LOAD (angle_a, pocket
up). While the rover drives, the drum sits at LOAD so chassis vibration
packs powder into it. A shot is fired by a short dump-and-return cycle
at the waypoint:

    arrive (drum already at LOAD)
      → wait arrive_to_dump_delay   (rover has stopped; let it settle)
      → rotate to DUMP (angle_b, pocket down — gravity drops the shot)
      → wait dump_hold_duration     (powder fully clears the drop port)
      → rotate back to LOAD
      → wait load_settle_duration   (drum finishes slewing to LOAD)
      → publish done → navigator departs

The drum therefore ends every cycle back at LOAD, so the next driving
leg refills it. There is no per-waypoint A/B toggle; every waypoint
runs the identical load→dump→load cycle.

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
    /rover/cmd/dispenser_set_position (std_msgs/String) - Operator override
                                           from the manual-control panel.
                                           Payload "load" → angle_a (pocket
                                           up, drum fills); "dump" →
                                           angle_b (pocket down, gravity
                                           dumps). Ignored mid-cycle.

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
        # angle_a is the LOAD / rest pose (pocket up, drum fills under the
        # hopper). angle_b is the DUMP pose (pocket down, gravity drops the
        # shot). The drum sits at angle_a whenever it is not mid-cycle.
        self.declare_parameter('dispense_angle_a', 0)
        self.declare_parameter('dispense_angle_b', 90)
        # Cycle timing.
        # arrive_to_dump_delay: dwell at LOAD after the rover stops at the
        #   waypoint, before rotating to DUMP.
        # dump_hold_duration: dwell at DUMP so the shot fully clears the
        #   drop port before returning to LOAD.
        # load_settle_duration: after publishing the LOAD pulse, wait this
        #   long before signalling done so the drum has actually finished
        #   rotating to LOAD before the navigator starts driving to the
        #   next waypoint. Without it, chassis acceleration overlapped the
        #   final ~0.4 s of slew and could fling residual pocket powder
        #   sideways. MCU slew limit is 100 µs/tick at 50 Hz = 5000 µs/s,
        #   so a DUMP→LOAD swing of 2000 µs takes 0.40 s; 0.5 s = 0.4 s
        #   slew + 0.1 s margin for CDC latency.
        # All three timers are timed from when the command is issued.
        self.declare_parameter('arrive_to_dump_delay', 1.0)
        self.declare_parameter('dump_hold_duration', 2.0)
        self.declare_parameter('load_settle_duration', 0.5)

        self._validate_params()

        # Publisher: pulse_us to MCU bridge (forwarded as 'D <us>').
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_dispenser = self.create_publisher(
            Int32, '/rover/cmd/dispenser_us', reliable_qos)

        # Drive to angle_a (LOAD) on boot so the drum is in its rest pose and
        # the first driving leg packs powder into it. Best-effort: the MCU
        # bridge may not yet be ready / connected; later commands re-sync the
        # servo regardless.
        angle_a = self.get_parameter('dispense_angle_a').value
        self._publish_pulse_us(_angle_to_pulse_us(angle_a))

        # State
        self._spraying = False
        self._dispense_timer = None
        self._current_wp_idx = -1
        # Index of the most recent waypoint cancelled by navigator timeout.
        # Guards _signal_done from publishing a stale 'success' result for
        # a waypoint navigator already published 'timeout' for.
        self._cancelled_wp_idx = -1

        # Subscribers
        self.create_subscription(Int32, '/rover/nav/waypoint_reached', self._on_waypoint_reached, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_emergency_stop, reliable_qos)
        self.create_subscription(Int32, '/rover/spray/cancel', self._on_spray_cancel, reliable_qos)
        self.create_subscription(String, '/rover/cmd/dispenser_set_position', self._on_set_position, reliable_qos)

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
        pre = self.get_parameter('arrive_to_dump_delay').value
        hold = self.get_parameter('dump_hold_duration').value

        if not (0 <= angle_a <= 180):
            self.get_logger().fatal(f'dispense_angle_a must be in [0, 180]; got {angle_a}')
            raise SystemExit(1)
        if not (0 <= angle_b <= 180):
            self.get_logger().fatal(f'dispense_angle_b must be in [0, 180]; got {angle_b}')
            raise SystemExit(1)
        if angle_a == angle_b:
            self.get_logger().fatal(f'dispense_angle_a and _b must differ; both = {angle_a}')
            raise SystemExit(1)
        if not (0.0 < pre <= 10.0):
            self.get_logger().fatal(f'arrive_to_dump_delay must be in (0, 10]s; got {pre}')
            raise SystemExit(1)
        if not (0.0 < hold <= 10.0):
            self.get_logger().fatal(f'dump_hold_duration must be in (0, 10]s; got {hold}')
            raise SystemExit(1)
        load_settle = self.get_parameter('load_settle_duration').value
        if not (0.0 < load_settle <= 5.0):
            self.get_logger().fatal(
                f'load_settle_duration must be in (0, 5]s; got {load_settle}')
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
        """Run the dump-and-return cycle: LOAD → wait → DUMP → wait → LOAD.

        The drum is assumed to be at LOAD on entry (its rest pose). We do
        not command it again here; we just wait arrive_to_dump_delay for the
        chassis to settle before rotating to DUMP in _do_dump.
        """
        if self._spraying:
            return

        self._spraying = True
        self._current_wp_idx = msg.data

        pre = self.get_parameter('arrive_to_dump_delay').value
        hold = self.get_parameter('dump_hold_duration').value
        self.get_logger().info(
            f'Waypoint {self._current_wp_idx} reached; dispense cycle '
            f'(load → {pre}s → dump → {hold}s → load)'
        )
        # Step 1: dwell at LOAD, then rotate to DUMP.
        self._dispense_timer = self.create_timer(pre, self._do_dump)

    def _do_dump(self):
        """Pre-dump dwell elapsed: rotate the drum to DUMP and hold."""
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        # Cancelled / E-stopped during the pre-dump dwell.
        if not self._spraying:
            return
        angle_b = self.get_parameter('dispense_angle_b').value
        self.get_logger().info(
            f'Dump at waypoint {self._current_wp_idx} ({angle_b}° = {_angle_to_pulse_us(angle_b)} µs)'
        )
        self._publish_pulse_us(_angle_to_pulse_us(angle_b))
        # Step 2: hold at DUMP, then return to LOAD (which itself
        # schedules the load_settle timer before signalling done).
        hold = self.get_parameter('dump_hold_duration').value
        self._dispense_timer = self.create_timer(hold, self._do_load)

    def _do_load(self):
        """Dump hold elapsed: rotate back to LOAD (rest), then schedule
        the done-signal for after the slew has actually completed. The
        previous design signalled done in the same call that published
        the LOAD pulse, so the drum's ~0.4 s DUMP→LOAD slew overlapped
        the navigator's chassis-accel ramp toward the next waypoint —
        any residual chalk in the pocket could be flung sideways by the
        combined pocket-tilt + chassis-accel vector. By holding done
        until load_settle_duration has elapsed, the drum reaches LOAD
        first and only then does the chassis move.
        """
        # Cancelled / E-stopped during the dump hold — leave the drum where
        # it is (the cancel path already cleared state) and drop the timer.
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        if not self._spraying:
            return
        angle_a = self.get_parameter('dispense_angle_a').value
        self.get_logger().info(
            f'Return to load at waypoint {self._current_wp_idx} '
            f'({angle_a}° = {_angle_to_pulse_us(angle_a)} µs)'
        )
        self._publish_pulse_us(_angle_to_pulse_us(angle_a))
        settle = self.get_parameter('load_settle_duration').value
        self._dispense_timer = self.create_timer(
            settle, self._done_after_load_settle)

    def _done_after_load_settle(self):
        """LOAD-slew has had time to complete — signal done so the
        navigator can release the SPRAYING lock and drive on."""
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        # Cancelled / E-stopped between LOAD publish and slew settle: the
        # drum is en route to LOAD (or already there) but the cycle has
        # been cancelled by another path which suppressed _spraying. Skip
        # _signal_done so we don't emit a stale 'success' result.
        if not self._spraying:
            return
        self._signal_done()

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
        """Emergency stop: cancel the pending cycle; do NOT move the servo.

        We abort whichever step timer is pending and leave the drum at
        whatever pose it last rotated to (LOAD if E-stop hit during the
        pre-dump dwell, DUMP if it hit during the hold). We deliberately
        do not command a new pose during an emergency — the operator can
        use the manual Load button to return the drum to its rest pose.
        """
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        was_spraying = self._spraying
        wp_idx = self._current_wp_idx
        self._spraying = False
        if was_spraying and wp_idx >= 0:
            self._publish_result('cancelled', wp_idx)

    def _on_set_position(self, msg):
        """Operator manual override: drive the dispenser directly.

        Accepts the string "load" (angle_a, pocket up — rest pose) or
        "dump" (angle_b, pocket down). Ignored mid-cycle so it can't race
        the dump-and-return path.
        """
        if self._spraying:
            self.get_logger().info(
                f'dispenser_set_position ignored while spraying (req={msg.data})'
            )
            return
        position = (msg.data or '').strip().lower()
        if position == 'load':
            angle = self.get_parameter('dispense_angle_a').value
        elif position == 'dump':
            angle = self.get_parameter('dispense_angle_b').value
        else:
            self.get_logger().warn(
                f'dispenser_set_position: unknown payload {msg.data!r}'
            )
            return
        target_us = _angle_to_pulse_us(angle)
        self.get_logger().info(
            f'Manual dispenser → {position} ({angle}° = {target_us} µs)'
        )
        self._publish_pulse_us(target_us)

    def _on_spray_cancel(self, msg):
        """Abort the current cycle without leaving SPRAYING for EMERGENCY_STOP.

        Used when the navigator times out waiting for spray/done.
        The drum is left where it is (the next leg / manual Load resets it).
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
        # Park the drum at angle_b (DUMP) on shutdown so any loaded powder
        # drops out rather than sitting in the drum during storage. Boot
        # independently re-commands LOAD, so this does not affect the rest
        # pose. Best-effort: the MCU bridge may have shut down too.
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
