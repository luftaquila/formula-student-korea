"""Navigator Node: Mission state machine with Pure Pursuit path following.

Central intelligence node managing heading calibration, waypoint navigation
with cm-level precision, spray coordination, and return-to-start.

State Machine:
    IDLE → CALIBRATING → NAVIGATING → SETTLING → SPRAYING → RETURNING → IDLE
    (any) → EMERGENCY_STOP → (new execute_path) → CALIBRATING
    (any) → ERROR (GPS lost) → (GPS restored) → resume

Subscribed topics:
    /rover/gps/position (sensor_msgs/NavSatFix) - RTK GPS position
    /rover/gps/heading (std_msgs/Float64) - GPS-derived heading
    /rover/cmd/execute_path (std_msgs/String) - JSON waypoints
    /rover/cmd/emergency_stop (std_msgs/Empty) - Abort mission
    /rover/spray/done (std_msgs/Empty) - Spray complete

Published topics:
    /rover/cmd/velocity (geometry_msgs/Twist) - Velocity commands
    /rover/nav/state (std_msgs/String) - Current state
    /rover/nav/waypoint_reached (std_msgs/Int32) - Waypoint index for spray
"""

import json
import time
from enum import Enum
from math import radians, degrees, sin, cos, atan2, sqrt, pi

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import NavSatFix
from geometry_msgs.msg import Twist
from std_msgs.msg import Float64, String, Int32, Empty

from pilot.lib.geo_utils import (
    haversine, bearing, enu_from_gps, normalize_angle,
)
from pilot.lib.protocol_utils import has_required_fix_status


class State(Enum):
    IDLE = 'IDLE'
    CALIBRATING = 'CALIBRATING'
    NAVIGATING = 'NAVIGATING'
    SETTLING = 'SETTLING'
    SPRAYING = 'SPRAYING'
    RETURNING = 'RETURNING'
    EMERGENCY_STOP = 'EMERGENCY_STOP'
    ERROR = 'ERROR'


class NavigatorNode(Node):

    def __init__(self):
        super().__init__('navigator_node')

        # Parameters
        self.declare_parameter('waypoint_tolerance', 0.05)
        self.declare_parameter('approach_tolerance', 0.30)
        self.declare_parameter('calibration_distance', 2.5)
        self.declare_parameter('calibration_speed', 0.5)
        self.declare_parameter('cruise_speed', 1.2)
        self.declare_parameter('approach_speed', 0.2)
        self.declare_parameter('lookahead_min', 0.8)
        self.declare_parameter('lookahead_gain', 0.5)
        self.declare_parameter('heading_calibrated_threshold', 5.0)
        self.declare_parameter('gps_timeout', 3.0)
        self.declare_parameter('return_to_start', True)
        self.declare_parameter('stuck_timeout', 10.0)
        self.declare_parameter('stuck_max_retries', 2)
        self.declare_parameter('spray_timeout', 5.0)
        self.declare_parameter('creep_speed', 0.15)
        self.declare_parameter('decel_distance', 2.0)
        self.declare_parameter('settle_readings', 5)
        self.declare_parameter('settle_tolerance', 0.03)
        self.declare_parameter('settle_timeout', 10.0)
        self.declare_parameter('required_fix_status', 'rtk_fixed')
        self.declare_parameter('fix_hysteresis_s', 0.8)
        self.declare_parameter('max_curvature', 1.2)
        self.declare_parameter('calibration_max_distance', 5.0)

        # Publishers
        self._pub_velocity = self.create_publisher(Twist, '/rover/cmd/velocity', 10)
        self._pub_state = self.create_publisher(String, '/rover/nav/state', 10)

        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_waypoint_reached = self.create_publisher(Int32, '/rover/nav/waypoint_reached', reliable_qos)
        self._pub_spray_result = self.create_publisher(String, '/rover/spray/result', reliable_qos)
        self._pub_spray_cancel = self.create_publisher(Int32, '/rover/spray/cancel', reliable_qos)

        # Subscribers
        self.create_subscription(NavSatFix, '/rover/gps/position', self._on_gps, 10)
        self.create_subscription(Float64, '/rover/gps/heading', self._on_heading, 10)
        self.create_subscription(String, '/rover/gps/fix_status', self._on_fix_status, 10)
        self.create_subscription(String, '/rover/cmd/execute_path', self._on_execute_path, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_emergency_stop, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/clear_emergency', self._on_clear_emergency, reliable_qos)
        self.create_subscription(Empty, '/rover/spray/done', self._on_spray_done, reliable_qos)

        # State
        self._state = State.IDLE
        self._waypoints = []           # [{lat, lng}, ...]
        self._current_wp_idx = 0
        self._start_position = None    # (lat, lon) for return
        self._ref_position = None      # ENU reference point (lat, lon)

        # GPS state
        self._current_lat = None
        self._current_lon = None
        self._current_heading = None   # radians, 0=North CW
        self._last_gps_time = 0.0
        self._gps_fix_status = 'no_fix'

        # Calibration state
        self._cal_start_lat = None
        self._cal_start_lon = None
        self._cal_headings = []

        # Navigation state
        self._reached_count = 0        # consecutive readings within tolerance
        self._last_progress_time = 0.0
        self._last_progress_dist = float('inf')
        self._stuck_retries = 0

        # Spray state
        self._spray_enter_time = 0.0

        # Settling state
        self._settle_count = 0
        self._settle_enter_time = 0.0

        # Resumable state for ERROR recovery
        self._pre_error_state = None

        # Fix hysteresis tracking
        self._fix_degraded_since = None  # float monotonic time or None

        # Calibration extension state
        self._cal_extended = False

        # Published state dedup
        self._last_published_state = None

        # Control loop at 20Hz
        self._timer = self.create_timer(0.05, self._control_loop)

        self._publish_state()
        self.get_logger().info('Navigator node started')

    # ── Helpers ──────────────────────────────────────────

    def _safe_destroy_timer(self, timer):
        """Cancel and destroy a timer, ignoring any failure."""
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

    def _heading_variance(self):
        """Circular variance of the last 5 calibration headings (0=tight)."""
        if len(self._cal_headings) < 2:
            return 1.0
        recent = self._cal_headings[-5:]
        mean_sin = sum(sin(h) for h in recent) / len(recent)
        mean_cos = sum(cos(h) for h in recent) / len(recent)
        return 1.0 - sqrt(mean_sin ** 2 + mean_cos ** 2)

    # ── GPS callbacks ──────────────────────────────────

    def _on_gps(self, msg):
        self._current_lat = msg.latitude
        self._current_lon = msg.longitude
        self._last_gps_time = time.monotonic()

    def _on_heading(self, msg):
        """Heading in degrees from GPS (only published when moving)."""
        self._current_heading = radians(msg.data)

    def _on_fix_status(self, msg):
        self._gps_fix_status = msg.data

    # ── Command callbacks ──────────────────────────────

    def _on_execute_path(self, msg):
        """Receive waypoints and start mission."""
        try:
            waypoints = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().error('Invalid waypoint JSON')
            return

        if not waypoints:
            return

        self._waypoints = waypoints
        self._current_wp_idx = 0
        self._reached_count = 0
        self._stuck_retries = 0

        # Record start position for return
        if self._current_lat is not None and self._has_required_fix():
            self._start_position = (self._current_lat, self._current_lon)
            self._ref_position = (self._current_lat, self._current_lon)

            # Begin calibration — reset hysteresis + calibration-extend state so
            # previous mission history never leaks into this run's thresholds.
            self._cal_start_lat = self._current_lat
            self._cal_start_lon = self._current_lon
            self._cal_headings = []
            self._cal_extended = False
            self._fix_degraded_since = None
            self._pre_error_state = None
            self._set_state(State.CALIBRATING)
            self.get_logger().info(f'Mission started: {len(waypoints)} waypoints')
        else:
            self.get_logger().error(
                'Cannot start mission without current GPS position and required fix quality'
            )
            self._set_state(State.ERROR)

    def _on_emergency_stop(self, _msg):
        self._stop_motors()
        self._set_state(State.EMERGENCY_STOP)

    def _on_clear_emergency(self, _msg):
        # Operator-acknowledged release. Drop back to IDLE so the rover
        # is ready to accept the next execute_path; we deliberately don't
        # auto-resume mid-mission because the operator may have moved
        # the chassis or aborted intentionally.
        if self._state == State.EMERGENCY_STOP:
            self.get_logger().info('Emergency-stop cleared by operator')
            self._set_state(State.IDLE)

    def _on_spray_done(self, _msg):
        """Spray complete, advance to next waypoint or return."""
        if self._state != State.SPRAYING:
            return

        self._current_wp_idx += 1
        self._reached_count = 0
        self._stuck_retries = 0
        self._last_progress_dist = float('inf')
        self._last_progress_time = time.monotonic()

        if self._current_wp_idx >= len(self._waypoints):
            # All waypoints done
            if self.get_parameter('return_to_start').value and self._start_position:
                self.get_logger().info('All waypoints done, returning to start')
                self._set_state(State.RETURNING)
            else:
                self.get_logger().info('Mission complete')
                self._stop_motors()
                self._set_state(State.IDLE)
        else:
            self.get_logger().info(f'Next waypoint: {self._current_wp_idx + 1}/{len(self._waypoints)}')
            self._set_state(State.NAVIGATING)

    # ── Control loop ───────────────────────────────────

    def _control_loop(self):
        """Main 20Hz control loop dispatching by state."""
        # GPS timeout check
        if self._state in (State.CALIBRATING, State.NAVIGATING, State.SETTLING, State.RETURNING):
            now = time.monotonic()
            gps_timeout = self.get_parameter('gps_timeout').value
            if now - self._last_gps_time > gps_timeout:
                self.get_logger().warn('GPS timeout, entering ERROR state')
                self._pre_error_state = self._state
                self._stop_motors()
                self._set_state(State.ERROR)
                return
            # Fix hysteresis: tolerate short fix dropouts to avoid 50ms flicker
            hysteresis = self.get_parameter('fix_hysteresis_s').value
            if not self._has_required_fix():
                if self._fix_degraded_since is None:
                    self._fix_degraded_since = now
                elif now - self._fix_degraded_since >= hysteresis:
                    self.get_logger().warn(
                        f'GPS fix below required quality ({self._gps_fix_status}) '
                        f'for {now - self._fix_degraded_since:.2f}s, entering ERROR state'
                    )
                    self._pre_error_state = self._state
                    self._stop_motors()
                    self._set_state(State.ERROR)
                    return
            else:
                self._fix_degraded_since = None

        if self._state == State.ERROR:
            self._handle_error()
        elif self._state == State.CALIBRATING:
            self._handle_calibrating()
        elif self._state == State.NAVIGATING:
            self._handle_navigating()
        elif self._state == State.SETTLING:
            self._handle_settling()
        elif self._state == State.RETURNING:
            self._handle_returning()
        elif self._state == State.SPRAYING:
            self._handle_spraying()
        # IDLE, EMERGENCY_STOP: no motor commands

    def _handle_error(self):
        """Check if GPS has recovered."""
        gps_timeout = self.get_parameter('gps_timeout').value
        if (
            time.monotonic() - self._last_gps_time < gps_timeout
            and self._current_lat is not None
            and self._has_required_fix()
        ):
            self.get_logger().info('GPS recovered, resuming mission')
            if self._pre_error_state:
                self._set_state(self._pre_error_state)
                self._pre_error_state = None
            else:
                self._set_state(State.IDLE)

    def _handle_calibrating(self):
        """Drive straight to establish heading."""
        if self._current_lat is None:
            return

        # Drive straight forward (zero curvature)
        cal_speed = self.get_parameter('calibration_speed').value
        self._publish_velocity(cal_speed, 0.0)

        # Check distance traveled
        dist = haversine(self._cal_start_lat, self._cal_start_lon,
                         self._current_lat, self._current_lon)

        cal_distance = self.get_parameter('calibration_distance').value
        cal_max_distance = self.get_parameter('calibration_max_distance').value
        # If we've been extended once, push the threshold out by 2m.
        effective_cal_distance = cal_distance + (2.0 if self._cal_extended else 0.0)

        if self._current_heading is not None:
            self._cal_headings.append(self._current_heading)

        # Hard cap: if we've driven further than calibration_max_distance
        # and variance is still bad, abort with ERROR for operator review.
        if dist >= cal_max_distance:
            variance = self._heading_variance()
            self.get_logger().error(
                f'Calibration max distance reached ({dist:.2f}m) '
                f'without stable heading (variance={variance:.4f}), entering ERROR'
            )
            self._pre_error_state = None  # require manual restart
            self._stop_motors()
            self._set_state(State.ERROR)
            return

        # Check if calibration is complete
        if dist >= effective_cal_distance and len(self._cal_headings) >= 3:
            # Also compute heading from position delta as backup
            self._current_heading = bearing(
                self._cal_start_lat, self._cal_start_lon,
                self._current_lat, self._current_lon,
            )

            # Check heading stability
            if len(self._cal_headings) >= 5:
                variance = self._heading_variance()
                threshold = self.get_parameter('heading_calibrated_threshold').value

                if variance < (1.0 - cos(radians(threshold))):
                    self.get_logger().info(
                        f'Heading calibrated: {degrees(self._current_heading):.1f}° '
                        f'(variance: {variance:.4f}, dist: {dist:.2f}m)'
                    )
                    self._last_progress_time = time.monotonic()
                    self._last_progress_dist = float('inf')
                    self._cal_extended = False
                    self._set_state(State.NAVIGATING)
                    return

                # Variance still high — extend once before giving up.
                # Only extend if a 2m extension would stay under the hard cap.
                if not self._cal_extended and (dist + 2.0) < cal_max_distance:
                    self._cal_extended = True
                    self.get_logger().warn(
                        f'Heading variance high ({variance:.4f}), extending calibration by 2m'
                    )
                    return  # keep driving until new threshold hit

                # Already extended or no room to extend: fall through and let
                # the max-distance guard trip ERROR on the next loop.

    def _handle_navigating(self):
        """Pure Pursuit navigation to current waypoint."""
        if self._current_lat is None or self._current_heading is None:
            return

        if self._current_wp_idx >= len(self._waypoints):
            self._stop_motors()
            self._set_state(State.IDLE)
            return

        wp = self._waypoints[self._current_wp_idx]
        target_lat = wp['lat']
        target_lon = wp['lng']

        dist = haversine(self._current_lat, self._current_lon, target_lat, target_lon)

        # Check waypoint reached
        wp_tolerance = self.get_parameter('waypoint_tolerance').value
        if dist < wp_tolerance:
            self._reached_count += 1
            if self._reached_count >= 3:
                self._on_waypoint_arrived()
                return
        else:
            self._reached_count = 0

        # Stuck detection
        self._check_stuck(dist)

        # Pure Pursuit
        speed, curvature = self._pure_pursuit(target_lat, target_lon, dist)
        self._publish_velocity(speed, curvature)

    def _handle_returning(self):
        """Navigate back to start position."""
        if self._current_lat is None or self._current_heading is None or not self._start_position:
            return

        start_lat, start_lon = self._start_position
        dist = haversine(self._current_lat, self._current_lon, start_lat, start_lon)

        wp_tolerance = self.get_parameter('waypoint_tolerance').value
        if dist < wp_tolerance * 2:  # relaxed tolerance for return
            self._stop_motors()
            self.get_logger().info('Returned to start, mission complete')
            self._set_state(State.IDLE)
            return

        speed, curvature = self._pure_pursuit(start_lat, start_lon, dist)
        self._publish_velocity(speed, curvature)

    # ── Pure Pursuit ───────────────────────────────────

    def _pure_pursuit(self, target_lat, target_lon, dist):
        """Compute speed and curvature using Pure Pursuit controller.

        Returns (speed_m_s, curvature_1_m).
        """
        approach_tolerance = self.get_parameter('approach_tolerance').value
        cruise_speed = self.get_parameter('cruise_speed').value
        approach_speed = self.get_parameter('approach_speed').value
        lookahead_min = self.get_parameter('lookahead_min').value
        lookahead_gain = self.get_parameter('lookahead_gain').value

        # Deceleration speed profile
        decel_distance = self.get_parameter('decel_distance').value
        creep_speed = self.get_parameter('creep_speed').value

        if dist < approach_tolerance:
            # Final approach: linear ramp from approach_speed to creep_speed
            t = dist / approach_tolerance if approach_tolerance > 0 else 0.0
            speed = creep_speed + (approach_speed - creep_speed) * t
        elif dist < decel_distance:
            # Deceleration zone: linear ramp from cruise to approach
            t = (dist - approach_tolerance) / (decel_distance - approach_tolerance)
            speed = approach_speed + (cruise_speed - approach_speed) * t
        else:
            speed = cruise_speed

        # lookahead_min is set ≥ minimum turn radius (wheelbase/tan(max_steer))
        # so PP never demands a tighter arc than the vehicle can physically do.
        # When dist < lookahead, PP aims at a virtual point past the goal —
        # heading feedback self-corrects, no special-case needed.
        max_curv = self.get_parameter('max_curvature').value
        lookahead = max(lookahead_min, lookahead_gain * speed)

        # Target bearing
        target_bearing = bearing(
            self._current_lat, self._current_lon,
            target_lat, target_lon,
        )

        # Heading error
        alpha = normalize_angle(target_bearing - self._current_heading)

        # Pure Pursuit curvature. Ackermann can't pivot in place, so even at
        # |alpha| > pi/2 the right move is a forward arc at clamped curvature —
        # the vehicle swings around at the normal speed profile and GPS heading
        # updates close the loop.
        # Negate because geodetic bearing convention (CW positive) is opposite
        # to curvature convention (positive = left turn).
        curvature = -2.0 * sin(alpha) / lookahead

        # Clamp curvature to keep the vehicle dynamics within Ackermann limits.
        curvature = max(-max_curv, min(max_curv, curvature))
        return speed, curvature

    # ── Stuck detection ────────────────────────────────

    def _check_stuck(self, current_dist):
        """Detect if rover is stuck (no progress for stuck_timeout)."""
        stuck_timeout = self.get_parameter('stuck_timeout').value
        max_retries = self.get_parameter('stuck_max_retries').value
        now = time.monotonic()

        if current_dist < self._last_progress_dist - 0.02:
            # Making progress (moved at least 2cm closer)
            self._last_progress_dist = current_dist
            self._last_progress_time = now
            return

        if now - self._last_progress_time > stuck_timeout:
            self._stuck_retries += 1
            self.get_logger().warn(
                f'Stuck at waypoint {self._current_wp_idx + 1} '
                f'(retry {self._stuck_retries}/{max_retries})'
            )

            if self._stuck_retries > max_retries:
                # Skip this waypoint
                self.get_logger().warn(f'Skipping waypoint {self._current_wp_idx + 1}')
                self._current_wp_idx += 1
                self._stuck_retries = 0
                self._reached_count = 0
                self._last_progress_dist = float('inf')
                self._last_progress_time = now

                if self._current_wp_idx >= len(self._waypoints):
                    if self.get_parameter('return_to_start').value and self._start_position:
                        self._set_state(State.RETURNING)
                    else:
                        self._stop_motors()
                        self._set_state(State.IDLE)
            else:
                # Reset progress tracking for retry
                self._last_progress_dist = float('inf')
                self._last_progress_time = now

    # ── Settling (precision stop) ─────────────────────

    def _handle_settling(self):
        """Confirm precise position at waypoint, creep-correct if overshot."""
        if self._current_lat is None:
            return

        wp = self._waypoints[self._current_wp_idx]
        dist = haversine(self._current_lat, self._current_lon, wp['lat'], wp['lng'])

        settle_tolerance = self.get_parameter('settle_tolerance').value
        wp_tolerance = self.get_parameter('waypoint_tolerance').value
        settle_readings = self.get_parameter('settle_readings').value
        settle_timeout = self.get_parameter('settle_timeout').value

        # Timeout: proceed with spray at current position
        if time.monotonic() - self._settle_enter_time > settle_timeout:
            self.get_logger().warn(
                f'Settle timeout at waypoint {self._current_wp_idx + 1} '
                f'(dist={dist*100:.1f}cm), proceeding to spray'
            )
            self._trigger_spray()
            return

        if dist > wp_tolerance:
            # Overshot or drifted beyond tolerance: creep back
            self._settle_count = 0
            self._creep_toward_waypoint(wp['lat'], wp['lng'], dist)
        elif dist <= settle_tolerance:
            # Within tight tolerance: count toward confirmation
            self._stop_motors()
            self._settle_count += 1
            if self._settle_count >= settle_readings:
                self.get_logger().info(
                    f'Waypoint {self._current_wp_idx + 1}/{len(self._waypoints)} '
                    f'settled at {dist*100:.1f}cm'
                )
                self._trigger_spray()
        else:
            # Between settle_tolerance and wp_tolerance: stop and wait
            self._stop_motors()
            self._settle_count = 0

    def _creep_toward_waypoint(self, target_lat, target_lon, dist):
        """Very slow correction movement toward waypoint."""
        creep_speed = self.get_parameter('creep_speed').value
        max_curv = self.get_parameter('max_curvature').value

        if self._current_heading is None:
            self._stop_motors()
            return

        target_bearing = bearing(
            self._current_lat, self._current_lon,
            target_lat, target_lon,
        )
        alpha = normalize_angle(target_bearing - self._current_heading)

        if abs(alpha) > pi / 2:
            # Target is behind us (overshoot). Ackermann can't pivot in place,
            # so reverse straight back. Once we've backed up enough that the
            # target is in front again, the next tick's normal creep arc takes over.
            self._publish_velocity(-creep_speed, 0.0)
        else:
            curvature = -2.0 * sin(alpha) / max(0.1, dist)
            curvature = max(-max_curv, min(max_curv, curvature))
            self._publish_velocity(creep_speed, curvature)

    def _trigger_spray(self):
        """Trigger spray and enter SPRAYING state."""
        msg = Int32()
        msg.data = self._current_wp_idx
        self._pub_waypoint_reached.publish(msg)
        self._spray_enter_time = time.monotonic()
        self._set_state(State.SPRAYING)

    # ── Spray (with position hold) ────────────────────

    def _handle_spraying(self):
        """Handle spraying state: timeout check + position hold."""
        spray_timeout = self.get_parameter('spray_timeout').value
        if time.monotonic() - self._spray_enter_time > spray_timeout:
            self.get_logger().warn(
                f'Spray timeout at waypoint {self._current_wp_idx + 1}, skipping'
            )
            result = String()
            result.data = json.dumps({'waypoint': int(self._current_wp_idx), 'outcome': 'timeout'})
            self._pub_spray_result.publish(result)
            # Tell spray_node to kill any pending signal_done timer so a late
            # 'success' doesn't overwrite the 'timeout' we just published.
            cancel = Int32()
            cancel.data = int(self._current_wp_idx)
            self._pub_spray_cancel.publish(cancel)
            self._on_spray_done(None)
            return

        # Position hold during spray
        if self._current_lat is None:
            return

        wp = self._waypoints[self._current_wp_idx]
        dist = haversine(self._current_lat, self._current_lon, wp['lat'], wp['lng'])
        wp_tolerance = self.get_parameter('waypoint_tolerance').value

        if dist > wp_tolerance:
            self._creep_toward_waypoint(wp['lat'], wp['lng'], dist)
        else:
            self._stop_motors()

    # ── Waypoint arrival ──────────────────────────────

    def _on_waypoint_arrived(self):
        """Handle arrival at waypoint: enter settling phase for precision stop."""
        self._stop_motors()
        self._settle_count = 0
        self._settle_enter_time = time.monotonic()
        self.get_logger().info(
            f'Waypoint {self._current_wp_idx + 1}/{len(self._waypoints)} '
            f'in tolerance, settling...'
        )
        self._set_state(State.SETTLING)

    # ── Helpers ────────────────────────────────────────

    def _publish_velocity(self, speed, curvature):
        """Publish Twist velocity command."""
        msg = Twist()
        msg.linear.x = speed
        msg.angular.z = curvature
        self._pub_velocity.publish(msg)

    def _stop_motors(self):
        """Publish zero velocity."""
        self._publish_velocity(0.0, 0.0)

    def _set_state(self, new_state):
        """Transition to a new state and publish."""
        if self._state != new_state:
            self.get_logger().info(f'State: {self._state.value} → {new_state.value}')
            self._state = new_state
            self._publish_state()

    def _publish_state(self):
        """Publish current state string (dedup to reduce topic chatter)."""
        if self._last_published_state == self._state:
            return
        msg = String()
        msg.data = self._state.value
        self._pub_state.publish(msg)
        self._last_published_state = self._state

    def _has_required_fix(self):
        required = self.get_parameter('required_fix_status').value
        return has_required_fix_status(self._gps_fix_status, required)


def main(args=None):
    rclpy.init(args=args)
    node = NavigatorNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
