"""Dispenser Node: peristaltic-pump actuator at waypoints.

Drives a peristaltic pump whose power is switched by the rover MCU
(RP2040-Zero, GPIO 6) through an IRLZ44N logic-level MOSFET (1N4007
flyback). This node publishes the desired pump state (0 = off, 1 = on)
on /rover/cmd/pump; mcu_bridge_node forwards it verbatim to the MCU as
'D <0|1>' over USB CDC. No GPIO is touched here.

Dispense model: at each waypoint the pump runs for a fixed duration to
dispense one shot of marking fluid:

    arrive
      → wait arrive_to_pump_delay   (rover has stopped; let it settle)
      → pump ON
      → wait pump_run_duration      (one shot dispensed)
      → pump OFF
      → publish done → navigator departs

The pump is off whenever it is not mid-cycle. There is no per-waypoint
toggle; every waypoint runs the identical off→on→off cycle.

Topic names are retained as /rover/spray/* for compatibility with the
navigator and bridge nodes.

Subscribed topics:
    /rover/nav/waypoint_reached (std_msgs/Int32) - Waypoint index reached
    /rover/cmd/emergency_stop (std_msgs/Empty) - Cancel dispense in progress
                                                 and force the pump OFF.
    /rover/spray/cancel (std_msgs/Int32) - Abort dispense on a specific
                                           waypoint without entering
                                           EMERGENCY_STOP state (used by
                                           navigator on dispense timeout
                                           to suppress a late _signal_done);
                                           also forces the pump OFF.
    /rover/cmd/pump_set (std_msgs/Int32) - Operator manual override from
                                           the manual-control panel. 1 → pump
                                           on, 0 → pump off. Ignored mid-cycle.

Published topics:
    /rover/cmd/pump (std_msgs/Int32) - Pump state (0/1), consumed by
                                       mcu_bridge_node and forwarded to
                                       the MCU as 'D <0|1>'.
    /rover/spray/done (std_msgs/Empty) - Dispense cycle complete
    /rover/spray/result (std_msgs/String) - JSON {waypoint, outcome}
"""

import json

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from std_msgs.msg import Int32, Empty, String, Float32


class SprayNode(Node):

    def __init__(self):
        super().__init__('spray_node')

        # Cycle timing.
        # arrive_to_pump_delay: dwell after the rover stops at the waypoint,
        #   before running the pump — lets the chassis settle so the shot
        #   lands where the rover parked.
        # pump_run_duration: how long the pump runs to dispense one shot.
        self.declare_parameter('arrive_to_pump_delay', 1.0)
        self.declare_parameter('pump_run_duration', 2.0)

        self._validate_params()

        # Live pump dispense time. Seeded from the param (rover_params.yaml)
        # and re-tuned at runtime via /rover/cmd/pump_duration (operator
        # slider in the UI). Held as an instance value so a slider change
        # takes effect on the next waypoint without a node restart.
        self._pump_run_duration = float(self.get_parameter('pump_run_duration').value)

        # Publisher: pump state (0/1) to MCU bridge (forwarded as 'D <0|1>').
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_pump = self.create_publisher(
            Int32, '/rover/cmd/pump', reliable_qos)

        # Force the pump OFF on boot so nothing is dispensed on power-on.
        # Best-effort: the MCU bridge may not yet be ready / connected; the
        # MCU itself also boots the pump off, and later commands re-sync it.
        self._pump_on = False
        self._publish_pump(False)

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
        self.create_subscription(Int32, '/rover/cmd/pump_set', self._on_pump_set, reliable_qos)
        self.create_subscription(Float32, '/rover/cmd/pump_duration', self._on_pump_duration, reliable_qos)

        # Publishers
        self._pub_done = self.create_publisher(Empty, '/rover/spray/done', reliable_qos)
        self._pub_result = self.create_publisher(String, '/rover/spray/result', reliable_qos)

        self.get_logger().info('Dispenser node started (peristaltic pump, MCU-routed)')

    def _publish_pump(self, on):
        """Publish the desired pump state and track it locally."""
        self._pump_on = bool(on)
        msg = Int32()
        msg.data = 1 if on else 0
        self._pub_pump.publish(msg)

    def _publish_result(self, outcome, wp_idx):
        """Emit a dispense outcome for the course server / UI."""
        msg = String()
        msg.data = json.dumps({'waypoint': int(wp_idx), 'outcome': outcome})
        self._pub_result.publish(msg)

    def _validate_params(self):
        """Sanity-check dispense parameters."""
        pre = self.get_parameter('arrive_to_pump_delay').value
        run = self.get_parameter('pump_run_duration').value

        if not (0.0 < pre <= 10.0):
            self.get_logger().fatal(f'arrive_to_pump_delay must be in (0, 10]s; got {pre}')
            raise SystemExit(1)
        if not (0.0 < run <= 10.0):
            self.get_logger().fatal(f'pump_run_duration must be in (0, 10]s; got {run}')
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
        """Run the dispense cycle: settle → pump ON → run → pump OFF → done.

        The pump is off on entry (its rest state). We wait
        arrive_to_pump_delay for the chassis to settle before running the
        pump in _do_pump_on.
        """
        if self._spraying:
            return

        self._spraying = True
        self._current_wp_idx = msg.data

        pre = self.get_parameter('arrive_to_pump_delay').value
        run = self._pump_run_duration
        self.get_logger().info(
            f'Waypoint {self._current_wp_idx} reached; dispense cycle '
            f'(settle {pre}s → pump {run}s)'
        )
        # Step 1: dwell after stop, then run the pump.
        self._dispense_timer = self.create_timer(pre, self._do_pump_on)

    def _do_pump_on(self):
        """Settle dwell elapsed: run the pump for pump_run_duration."""
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        # Cancelled / E-stopped during the settle dwell.
        if not self._spraying:
            return
        run = self._pump_run_duration
        self.get_logger().info(
            f'Pump ON at waypoint {self._current_wp_idx} ({run}s)'
        )
        self._publish_pump(True)
        # Step 2: run for pump_run_duration, then stop the pump.
        self._dispense_timer = self.create_timer(run, self._do_pump_off)

    def _do_pump_off(self):
        """Pump run elapsed: stop the pump and signal the cycle done."""
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        # Cancelled / E-stopped during the pump run — the cancel path already
        # cleared state and forced the pump off; just drop the timer.
        if not self._spraying:
            return
        self.get_logger().info(f'Pump OFF at waypoint {self._current_wp_idx}')
        self._publish_pump(False)
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
        """Emergency stop: cancel the pending cycle and force the pump OFF.

        Unlike the old servo (left wherever it last rotated), a running
        pump must be stopped immediately on an emergency — we abort the
        pending step timer and drive the pump off unconditionally.
        """
        self._dispense_timer = self._safe_destroy_timer(self._dispense_timer)
        was_spraying = self._spraying
        wp_idx = self._current_wp_idx
        self._spraying = False
        self._publish_pump(False)
        if was_spraying and wp_idx >= 0:
            self._publish_result('cancelled', wp_idx)

    def _on_pump_set(self, msg):
        """Operator manual override: drive the pump on/off directly.

        Payload 1 → pump on, 0 → pump off. Ignored mid-cycle so it can't
        race the autonomous dispense path.
        """
        if self._spraying:
            self.get_logger().info(
                f'pump_set ignored while spraying (req={msg.data})'
            )
            return
        on = int(getattr(msg, 'data', 0)) != 0
        self.get_logger().info(f'Manual pump → {"on" if on else "off"}')
        self._publish_pump(on)

    def _on_pump_duration(self, msg):
        """Operator live-tune of the pump dispense time (seconds).

        Takes effect on the next waypoint cycle; an in-progress cycle keeps
        the duration it started with. Out-of-range values are ignored.
        """
        seconds = float(getattr(msg, 'data', 0.0))
        if not (0.0 < seconds <= 10.0):
            self.get_logger().warn(
                f'pump_duration out of (0, 10]s: {seconds} — ignored'
            )
            return
        self._pump_run_duration = seconds
        self.get_logger().info(f'Pump dispense time set to {seconds}s')

    def _on_spray_cancel(self, msg):
        """Abort the current cycle without leaving SPRAYING for EMERGENCY_STOP.

        Used when the navigator times out waiting for spray/done. Forces
        the pump OFF so a timed-out cycle can't leave it running.
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
        self._publish_pump(False)
        # Intentionally do NOT publish a result here — navigator already did.

    def destroy_node(self):
        # Force the pump off on shutdown so it can't be left running.
        # Best-effort: the MCU bridge may have shut down too (the MCU also
        # fails the pump off on heartbeat loss).
        try:
            self._publish_pump(False)
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
