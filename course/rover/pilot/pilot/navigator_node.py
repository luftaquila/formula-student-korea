"""Navigator Node: antenna-precise mission state machine.

Drives the chassis so that the GPS antenna (the user's clicked target) lands
on each waypoint within `waypoint_tolerance`, even when the antenna is offset
from the rear axle.

Pipeline (per control tick, 20 Hz):
    odom + GPS  →  ChassisPoseEstimator  →  (x_chassis, y_chassis, ψ)
    waypoints   →  PathPlanner           →  [cruise, dock, cruise, dock, …]
    chassis pose + segment → CruiseTracker / DockTracker → (v, κ)
    (v, κ) → /rover/cmd/velocity → mcu_bridge_node → motors

State machine:
    IDLE → CALIBRATING → NAVIGATING → SETTLING → SPRAYING → … → IDLE
    (any) → EMERGENCY_STOP → (clear) → IDLE
    (any except IDLE) → ERROR (GPS lost / calib failed) → resume on recovery

Calibration is the cold-start bootstrap to discover chassis ψ: we drive
straight (κ=0) at calibration_speed, log antenna ENU samples, and fit a
chord. Trustworthy when the chord is at least calibration_chord_min_m and
the orthogonal residual RMS is below calibration_residual_max. After that
the estimator runs and fuses GPS heading-of-motion with encoder-derived ω,
so we never re-enter calibration unless the operator restarts the mission.

Subscribed:
    /rover/gps/position    (sensor_msgs/NavSatFix)  — antenna lat/lon
    /rover/gps/heading     (std_msgs/Float64)       — heading-of-motion deg, 0=N, CW+
    /rover/gps/fix_status  (std_msgs/String)        — fix quality
    /rover/gps/metrics     (std_msgs/String JSON)   — for ground_speed
    /rover/odom            (std_msgs/String JSON)   — chassis v_left, v_right
    /rover/cmd/execute_path (std_msgs/String)       — JSON waypoints
    /rover/cmd/emergency_stop  (std_msgs/Empty)
    /rover/cmd/clear_emergency (std_msgs/Empty)
    /rover/spray/done      (std_msgs/Empty)

Published:
    /rover/cmd/velocity         (geometry_msgs/Twist)  — linear.x = m/s, angular.z = κ (1/m)
    /rover/nav/state            (std_msgs/String)
    /rover/nav/waypoint_reached (std_msgs/Int32)
    /rover/nav/error_reason     (std_msgs/String)      — populated on every ERROR entry
    /rover/nav/skipped          (std_msgs/Int32)       — published on stuck-skip
    /rover/spray/result         (std_msgs/String JSON)
    /rover/spray/cancel         (std_msgs/Int32)
"""

import json
import math
import os
import tempfile
import time
from enum import Enum
from math import radians, degrees, hypot, cos, sin, tan, isfinite, pi

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import NavSatFix
from geometry_msgs.msg import Twist
from std_msgs.msg import Float64, String, Int32, Empty

from pilot.lib.geo_utils import (
    enu_from_gps, fit_chord_heading, normalize_angle,
    project_onto_line as _project_onto_line,
)
from pilot.lib.protocol_utils import has_required_fix_status
from pilot.lib.state_estimator import ChassisPoseEstimator
from pilot.lib.path_planner import plan as plan_path
from pilot.lib.path_tracker import CruiseTracker, DockTracker
from pilot.lib.antenna_calibration import (
    OFFSET_BOUND_M,
    load_antenna_offset, save_antenna_offset,
    solve_antenna_offset_circular,
)
from pilot.lib.wheel_calibration import solve_wheel_scales
from pilot.lib.steering_calibration import (
    TRIM_BOUND_US, load_steering_trim, solve_steering_trim,
)
from pilot.lib.geo_utils import haversine


class State(Enum):
    IDLE = 'IDLE'
    CALIBRATING = 'CALIBRATING'
    NAVIGATING = 'NAVIGATING'
    SETTLING = 'SETTLING'
    SPRAYING = 'SPRAYING'
    CAL_ANTENNA = 'CAL_ANTENNA'
    CAL_WHEELS = 'CAL_WHEELS'
    EMERGENCY_STOP = 'EMERGENCY_STOP'
    ERROR = 'ERROR'


class CalAntennaPhase(Enum):
    """Sub-phases of the antenna offset auto-calibration drive."""
    STRAIGHT = 'straight'   # κ = 0, chord-fit ψ_init from antenna ENU
    CIRCLE = 'circle'       # constant κ = 1/R for N revolutions, sample chassis vs antenna
    SOLVE = 'solve'         # stop, fit two circles + phase, persist, publish


class NavigatorNode(Node):

    def __init__(self):
        super().__init__('navigator_node')

        # ── parameters ───────────────────────────────────────────────────

        # Antenna geometry (the only physical-rig knob that matters for
        # antenna-precise docking — measure once with a tape, never tune).
        self.declare_parameter('antenna_offset_x', 0.30)
        self.declare_parameter('antenna_offset_y', 0.00)

        # Chassis geometry (kept here AND in mcu_bridge_node so the
        # navigator's kinematic model doesn't silently fall out of sync if
        # mcu_bridge is restarted with stale params; bridge owns the
        # authoritative copy for steering-angle conversion).
        self.declare_parameter('wheelbase', 0.38)
        self.declare_parameter('track_width', 0.30)
        self.declare_parameter('max_steering_angle_deg', 25.0)
        self.declare_parameter('max_curvature', 1.2)
        # Mirrors mcu_bridge_node.servo_range_us; the steering auto-trim
        # solve at the end of CAL_WHEELS converts κ_bias to a servo µs
        # offset which the bridge then persists. Declared here so the
        # solve doesn't have to round-trip through mcu_bridge just to
        # learn the platform's servo geometry.
        self.declare_parameter('servo_range_us', 500)

        # Speeds.
        self.declare_parameter('cruise_speed', 1.0)
        self.declare_parameter('approach_speed', 0.4)
        self.declare_parameter('creep_speed', 0.18)
        self.declare_parameter('calibration_speed', 0.5)

        # Path planner.
        self.declare_parameter('dock_approach_distance', 1.5)

        # Cruise tracker (Pure Pursuit).
        self.declare_parameter('pp_lookahead_min', 0.6)
        self.declare_parameter('pp_lookahead_gain', 0.6)
        self.declare_parameter('pp_damping', 0.18)
        self.declare_parameter('cruise_done_tolerance', 0.20)

        # Dock tracker (state feedback).
        self.declare_parameter('dock_k_y', 1.4)
        self.declare_parameter('dock_k_psi', 2.4)
        self.declare_parameter('dock_k_i', 0.4)
        self.declare_parameter('dock_integral_limit', 0.5)
        self.declare_parameter('approach_tolerance', 0.10)
        self.declare_parameter('creep_zone', 0.40)
        # Pure Pursuit tunables exposed for cone-spacing-specific tuning.
        self.declare_parameter('pp_min_speed_fraction', 0.25)
        self.declare_parameter('pp_handoff_blend_distance', 1.0)

        # Tolerances and timeouts.
        self.declare_parameter('waypoint_tolerance', 0.05)
        self.declare_parameter('settle_tolerance', 0.03)
        self.declare_parameter('settle_readings', 5)
        self.declare_parameter('settle_timeout', 10.0)
        self.declare_parameter('spray_timeout', 5.0)
        self.declare_parameter('stuck_timeout', 12.0)
        self.declare_parameter('stuck_max_retries', 2)

        # Calibration quality gates.
        self.declare_parameter('calibration_distance', 2.5)
        self.declare_parameter('calibration_max_distance', 5.0)
        self.declare_parameter('calibration_min_samples', 20)
        self.declare_parameter('calibration_chord_min_m', 1.5)
        self.declare_parameter('calibration_residual_max', 0.05)

        # Antenna offset auto-calibration drive shape.
        self.declare_parameter('antenna_cal_straight_distance', 2.0)
        # Constant-κ orbit drive: κ = sign / radius. The closed-form solver
        # extracts (a_x, a_y) from the orbit geometry alone — no instantaneous
        # ψ required, so GPS heading-of-motion lag and encoder ω drift over
        # short timescales don't bias the result. Pick R well inside the
        # chassis curvature limit (κ_max = 1.2) and big enough that the
        # encoder integration over the drive (~15-25 s at v=1) doesn't
        # accumulate >1° ψ error.
        self.declare_parameter('antenna_cal_radius_m', 1.0)
        self.declare_parameter('antenna_cal_revolutions', 2)
        # `antenna_cal_sign` controls rotation direction: +1 CCW, -1 CW.
        # CCW is the default because that's what we've used in the field;
        # the solver supports both, so flip if site geometry requires.
        self.declare_parameter('antenna_cal_sign', 1)
        self.declare_parameter('antenna_cal_speed', 0.8)

        # Wheel scale auto-calibration (CAL_WHEELS state). Drives a
        # straight chord and divides GPS distance by per-wheel encoder
        # integration to recover the rolling-radius mismatch.
        self.declare_parameter('wheel_cal_distance', 10.0)
        self.declare_parameter('wheel_cal_speed', 0.5)
        self.declare_parameter('wheel_cal_max_distance', 15.0)

        # Estimator gains.
        self.declare_parameter('estimator_pos_gain', 0.30)
        self.declare_parameter('estimator_psi_gain', 0.15)
        self.declare_parameter('estimator_psi_min_speed', 0.4)

        # Safety.
        self.declare_parameter('gps_timeout', 3.0)
        self.declare_parameter('fix_hysteresis_s', 0.8)
        self.declare_parameter('required_fix_status', 'rtk_fixed')
        self.declare_parameter('return_to_start', True)
        # Battery thresholds. The MCU has its own hard cutoff at
        # BATTERY_UNDERVOLT_V (20 V); these gate the navigator earlier so
        # we don't start a mission with a marginal pack and so we ERROR
        # gracefully instead of having motors cut out mid-dock.
        self.declare_parameter('battery_warn_pct', 20)
        self.declare_parameter('battery_abort_pct', 10)

        # ── derived & state ──────────────────────────────────────────────
        self._max_steer_rad = radians(self.get_parameter('max_steering_angle_deg').value)

        # Effective antenna offset. Persisted antenna_offset.json wins over
        # the YAML default; the YAML value is a fallback for first boot. We
        # keep them on the instance (not re-read from params) so a fresh
        # auto-calibration applies to the next mission immediately without
        # requiring a service restart.
        yaml_offset = (
            self.get_parameter('antenna_offset_x').value,
            self.get_parameter('antenna_offset_y').value,
        )
        loaded, payload = load_antenna_offset(default=yaml_offset)
        self._antenna_offset_x = loaded[0]
        self._antenna_offset_y = loaded[1]
        self._antenna_offset_source = 'persisted' if payload else 'yaml_default'

        # Publishers.
        self._pub_velocity = self.create_publisher(Twist, '/rover/cmd/velocity', 10)
        self._pub_state = self.create_publisher(String, '/rover/nav/state', 10)
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_waypoint_reached = self.create_publisher(Int32, '/rover/nav/waypoint_reached', reliable_qos)
        self._pub_spray_result = self.create_publisher(String, '/rover/spray/result', reliable_qos)
        self._pub_spray_cancel = self.create_publisher(Int32, '/rover/spray/cancel', reliable_qos)
        self._pub_error_reason = self.create_publisher(String, '/rover/nav/error_reason', reliable_qos)
        self._pub_skipped = self.create_publisher(Int32, '/rover/nav/skipped', reliable_qos)
        self._pub_cal_antenna_result = self.create_publisher(String, '/rover/cal/antenna_result', reliable_qos)
        self._pub_cal_wheels_result = self.create_publisher(String, '/rover/cal/wheel_result', reliable_qos)
        self._pub_apply_wheel_scales = self.create_publisher(String, '/rover/cmd/apply_wheel_scales', reliable_qos)
        self._pub_apply_steering_trim = self.create_publisher(String, '/rover/cmd/apply_steering_trim', reliable_qos)

        # Subscribers.
        self.create_subscription(NavSatFix, '/rover/gps/position', self._on_gps, 10)
        self.create_subscription(Float64, '/rover/gps/heading', self._on_heading, 10)
        self.create_subscription(String, '/rover/gps/fix_status', self._on_fix_status, 10)
        self.create_subscription(String, '/rover/gps/metrics', self._on_gps_metrics, 10)
        self.create_subscription(String, '/rover/odom', self._on_odom, 10)
        self.create_subscription(String, '/rover/cmd/execute_path', self._on_execute_path, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_emergency_stop, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/clear_emergency', self._on_clear_emergency, reliable_qos)
        self.create_subscription(Empty, '/rover/spray/done', self._on_spray_done, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/calibrate_antenna', self._on_calibrate_antenna, reliable_qos)
        self.create_subscription(String, '/rover/cmd/set_antenna_offset', self._on_set_antenna_offset, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/calibrate_wheels', self._on_calibrate_wheels, reliable_qos)
        self.create_subscription(String, '/rover/battery', self._on_battery, 10)

        # ── runtime state ────────────────────────────────────────────────
        self._state = State.IDLE
        self._waypoints = []           # original [{lat, lng}, ...] from operator
        self._segments = []            # planner output; len = 2 × len(waypoints) (+2 if return)
        self._cur_seg_idx = 0
        self._cur_wp_idx = 0           # last waypoint index whose dock segment we're tracking

        # Mission anchors.
        self._ref_lat = None           # ENU origin for the mission
        self._ref_lon = None
        self._mission_start_chassis_xy = None  # for return-to-start

        # GPS / odometry inputs.
        self._gps_lat = None
        self._gps_lon = None
        self._gps_heading_compass = None   # radians, 0=N, CW+
        self._gps_fix_status = 'no_fix'
        self._gps_speed = 0.0
        self._last_gps_time = 0.0
        self._odom_v_left = 0.0
        self._odom_v_right = 0.0
        # Pre-scale velocities exposed by mcu_bridge for the CAL_WHEELS
        # routine; everywhere else we use the post-scale v_left/v_right.
        self._odom_v_left_raw = 0.0
        self._odom_v_right_raw = 0.0
        self._odom_have_sample = False

        # Battery state-of-charge. Updated from /rover/battery telemetry
        # JSON; navigator gates mission start and emits ERROR on critical.
        self._battery_pct = None

        # Estimator (constructed when calibration completes; needs ref_lat/lon).
        self._estimator = None

        # Trackers (constructed from params; reused across segments).
        self._cruise_tracker = None
        self._dock_tracker = None

        # Calibration state.
        self._cal_start_lat = None
        self._cal_start_lon = None
        self._cal_samples = []          # list of (e_enu, n_enu)
        self._cal_extended = False

        # Settling state.
        self._settle_count = 0
        self._settle_enter_time = 0.0

        # Spray state.
        self._spray_enter_time = 0.0

        # Stuck detection.
        self._last_progress_time = 0.0
        self._last_progress_dist = float('inf')
        self._stuck_retries = 0
        # Chassis displacement window (list of (t_mono, x, y)). The
        # distance-to-target gate alone misses dock-cycle stuck cases
        # where dist oscillates >2 cm each tick (5-30 cm cycle observed
        # at WP1 in the 18:39 mission), because every oscillation low
        # resets the timer. This window tracks the chassis's actual
        # bounding-box displacement over `stuck_timeout` seconds.
        self._stuck_window = []

        # Fix hysteresis.
        self._fix_degraded_since = None

        # Error recovery.
        self._pre_error_state = None
        self._last_error_reason = None

        # Wheel scale auto-calibration state. CAL_WHEELS drives a
        # straight chord; we accumulate per-wheel ∫|v_raw| dt and chord
        # GPS distance, then divide. The same drive doubles as the
        # source data for steering-trim auto-cal — ENU samples here feed
        # a circle fit at completion, since both calibrations want
        # exactly a κ=0 long chord and there's no point making the
        # operator drive twice.
        self._cal_wheels_start_lat = None
        self._cal_wheels_start_lon = None
        self._cal_wheels_enc_l_m = 0.0
        self._cal_wheels_enc_r_m = 0.0
        self._cal_wheels_samples = 0
        self._cal_wheels_last_t = None
        self._cal_wheels_enu_samples = []     # (e, n) for steering-trim circle fit
        self._cal_wheels_last_gps_idx = -1

        # Antenna offset auto-calibration state.
        self._cal_antenna_phase = None
        self._cal_antenna_chassis = None     # integrated (x, y, ψ) during circle
        self._cal_antenna_psi_init = None
        self._cal_antenna_start_lat = None
        self._cal_antenna_start_lon = None
        self._cal_antenna_samples = []       # for chord fit during straight phase
        self._cal_antenna_data = []          # (x_c, y_c, ψ, a_obs_x, a_obs_y) during circle
        self._cal_antenna_phase_start_t = 0.0
        self._cal_antenna_last_predict_t = None
        self._cal_antenna_last_gps_idx = -1
        self._cal_antenna_drive_distance = 0.0
        self._cal_antenna_extended = False
        # Cumulative orbit angle (Σ ω·dt) since CIRCLE phase started. Used as
        # the termination condition (revolutions completed) since cpsi wraps
        # to ±π and can't be compared against 2π·N directly.
        self._cal_antenna_orbit_angle = 0.0

        # Published state dedup.
        self._last_published_state = None

        # Per-segment 1 Hz tracker trace clock. Reset to None on segment
        # boundary so the first tick of each segment always logs.
        self._last_dock_trace_t = None

        # Control loop @ 20 Hz.
        self._timer = self.create_timer(0.05, self._control_loop)

        self._publish_state()
        self.get_logger().info('Navigator node started')

    # ── helpers ──────────────────────────────────────────────────────────

    def _safe_destroy_timer(self, timer):
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

    def _has_required_fix(self):
        required = self.get_parameter('required_fix_status').value
        return has_required_fix_status(self._gps_fix_status, required)

    def _params_for_trackers(self):
        return {
            'cruise_speed': self.get_parameter('cruise_speed').value,
            'approach_speed': self.get_parameter('approach_speed').value,
            'creep_speed': self.get_parameter('creep_speed').value,
            'pp_lookahead_min': self.get_parameter('pp_lookahead_min').value,
            'pp_lookahead_gain': self.get_parameter('pp_lookahead_gain').value,
            'pp_damping': self.get_parameter('pp_damping').value,
            'cruise_done_tolerance': self.get_parameter('cruise_done_tolerance').value,
            'dock_k_y': self.get_parameter('dock_k_y').value,
            'dock_k_psi': self.get_parameter('dock_k_psi').value,
            'dock_k_i': self.get_parameter('dock_k_i').value,
            'dock_integral_limit': self.get_parameter('dock_integral_limit').value,
            'pp_min_speed_fraction': self.get_parameter('pp_min_speed_fraction').value,
            'pp_handoff_blend_distance': self.get_parameter('pp_handoff_blend_distance').value,
            'approach_tolerance': self.get_parameter('approach_tolerance').value,
            'creep_zone': self.get_parameter('creep_zone').value,
            'max_curvature': self.get_parameter('max_curvature').value,
            'wheelbase': self.get_parameter('wheelbase').value,
            'max_steering_angle_rad': self._max_steer_rad,
            # Pull from instance, not yaml param, so a fresh auto-cal is
            # picked up on the next mission start without restart.
            'antenna_offset_x': self._antenna_offset_x,
            'antenna_offset_y': self._antenna_offset_y,
        }

    def _odom_chassis_kinematics(self):
        v = 0.5 * (self._odom_v_left + self._odom_v_right)
        track = self.get_parameter('track_width').value
        if track <= 0:
            return v, 0.0
        # Right wheel faster than left = CCW yaw = positive ω in math frame.
        omega = (self._odom_v_right - self._odom_v_left) / track
        return v, omega

    # ── input callbacks ──────────────────────────────────────────────────

    def _on_gps(self, msg):
        self._gps_lat = msg.latitude
        self._gps_lon = msg.longitude
        self._last_gps_time = time.monotonic()
        if self._estimator is not None and self._estimator.initialized:
            self._estimator.correct_position(msg.latitude, msg.longitude)

    def _on_heading(self, msg):
        # gps_node only publishes when ground_speed > 0.3 m/s, so receiving
        # a value implies the rover is moving — but we still use the
        # estimator's own min-speed gate for the antenna-offset inversion.
        self._gps_heading_compass = radians(msg.data)
        if self._estimator is not None and self._estimator.initialized:
            self._estimator.correct_heading(self._gps_heading_compass, self._gps_speed)

    def _on_fix_status(self, msg):
        self._gps_fix_status = msg.data

    def _on_gps_metrics(self, msg):
        try:
            data = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError, TypeError):
            return
        spd = data.get('speed') if isinstance(data, dict) else None
        if isinstance(spd, (int, float)):
            self._gps_speed = float(spd)

    def _on_battery(self, msg):
        try:
            data = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError, TypeError):
            return
        if not isinstance(data, dict):
            return
        pct = data.get('percent')
        if isinstance(pct, (int, float)):
            self._battery_pct = float(pct)

    def _on_odom(self, msg):
        try:
            data = json.loads(msg.data)
        except (json.JSONDecodeError, AttributeError, TypeError):
            return
        if not isinstance(data, dict):
            return
        vl = data.get('v_left')
        vr = data.get('v_right')
        if isinstance(vl, (int, float)):
            self._odom_v_left = float(vl)
        if isinstance(vr, (int, float)):
            self._odom_v_right = float(vr)
        # Raw (pre-wheel-scale) values; only the CAL_WHEELS routine reads
        # these. Older mcu_bridge builds without raw fields fall back to
        # the scaled value, which gives a no-op result on the next cal.
        vl_raw = data.get('v_left_raw', vl)
        vr_raw = data.get('v_right_raw', vr)
        if isinstance(vl_raw, (int, float)):
            self._odom_v_left_raw = float(vl_raw)
        if isinstance(vr_raw, (int, float)):
            self._odom_v_right_raw = float(vr_raw)
        self._odom_have_sample = True

    # ── command callbacks ────────────────────────────────────────────────

    def _on_execute_path(self, msg):
        try:
            waypoints = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().error('Invalid waypoint JSON')
            return
        if not isinstance(waypoints, list) or not waypoints:
            return

        # Preempt guard: only accept new mission from IDLE / ERROR. Mid-
        # NAVIGATING/SETTLING/SPRAYING/CAL_* swap-and-restart leaves the
        # chassis cruising under the prior tracker for one tick and
        # anchors the new ENU origin at the moving rover, biasing the
        # CALIBRATING chord regression. Operator must explicitly stop
        # the active mission first. (CAL_ANTENNA / CAL_WHEELS already
        # apply this guard via their own callbacks; mirror it here for
        # consistency.)
        if self._state not in (State.IDLE, State.ERROR):
            self.get_logger().warn(
                f'execute_path rejected: state={self._state.value} '
                '(stop the current activity first)'
            )
            return

        if self._gps_lat is None or not self._has_required_fix():
            self._set_error('Cannot start mission without RTK-fixed GPS position')
            return
        # Refuse to start if battery is below the warn threshold — running
        # a multi-waypoint mission to ~22 V then dying mid-dock leaves the
        # rover stranded with the spray uncoordinated and the operator
        # walking out to the field. We make the operator swap or charge
        # before the mission begins instead.
        warn_pct = self.get_parameter('battery_warn_pct').value
        if (self._battery_pct is not None
                and self._battery_pct < warn_pct):
            self._set_error(
                f'Battery low ({self._battery_pct:.0f}% < {warn_pct}%) — '
                f'charge or swap before starting mission'
            )
            return

        # Reset every per-mission knob — leakage between missions was the
        # exact failure that caused the previous calibration regressions
        # to recur after a stop/restart.
        self._waypoints = waypoints
        self._segments = []
        self._cur_seg_idx = 0
        self._cur_wp_idx = 0
        self._stuck_retries = 0
        self._reset_progress()
        self._cal_samples = []
        self._cal_extended = False
        self._fix_degraded_since = None
        self._pre_error_state = None
        self._last_error_reason = None

        # Anchor ENU to the calibration start so all subsequent ENU math
        # is in a single linearised frame.
        self._ref_lat = self._gps_lat
        self._ref_lon = self._gps_lon
        self._cal_start_lat = self._gps_lat
        self._cal_start_lon = self._gps_lon

        self._set_state(State.CALIBRATING)
        self.get_logger().info(f'Mission started: {len(waypoints)} waypoints, calibrating heading')

    def _on_emergency_stop(self, _msg):
        self._stop_motors()
        self._cruise_tracker = None
        self._dock_tracker = None
        self._set_state(State.EMERGENCY_STOP)

    def _on_clear_emergency(self, _msg):
        if self._state == State.EMERGENCY_STOP:
            self.get_logger().info('Emergency-stop cleared by operator')
            self._set_state(State.IDLE)

    def _on_spray_done(self, _msg):
        if self._state != State.SPRAYING:
            return
        self._advance_to_next_waypoint()

    def _on_calibrate_wheels(self, _msg):
        """Operator-triggered per-wheel scale auto-calibration.

        Only valid from IDLE — drives the rover ~10 m through a straight
        chord and divides GPS distance by per-wheel encoder integration
        to recover the rolling-radius scale. Requires RTK fix at start
        for the chord measurement to be cm-accurate.
        """
        if self._state != State.IDLE:
            self._publish_cal_wheels_result(
                ok=False,
                reason=f'must be IDLE to start (current: {self._state.value})',
            )
            return
        if self._gps_lat is None or not self._has_required_fix():
            self._publish_cal_wheels_result(
                ok=False,
                reason='RTK-fixed GPS required to start calibration',
            )
            return
        self._cal_wheels_start_lat = self._gps_lat
        self._cal_wheels_start_lon = self._gps_lon
        self._cal_wheels_enc_l_m = 0.0
        self._cal_wheels_enc_r_m = 0.0
        self._cal_wheels_samples = 0
        self._cal_wheels_last_t = None
        self._cal_wheels_enu_samples = []
        self._cal_wheels_last_gps_idx = -1
        self._fix_degraded_since = None
        self.get_logger().info('Wheel scale auto-calibration started')
        self._set_state(State.CAL_WHEELS)

    def _on_calibrate_antenna(self, _msg):
        """Operator-triggered antenna offset auto-calibration.

        Only valid from IDLE — the maneuver drives the rover ~5 m through
        an S-curve, which would interfere with any active mission.
        Requires RTK fix at the start (the chord regression for ψ_init
        depends on cm-level antenna positions).
        """
        if self._state != State.IDLE:
            self._publish_cal_antenna_result(
                ok=False,
                reason=f'must be IDLE to start (current: {self._state.value})',
            )
            return
        if self._gps_lat is None or not self._has_required_fix():
            self._publish_cal_antenna_result(
                ok=False,
                reason='RTK-fixed GPS required to start calibration',
            )
            return
        # Reset every per-cal scratch field so a previous failed run can't
        # leak into this one.
        self._cal_antenna_phase = CalAntennaPhase.STRAIGHT
        self._cal_antenna_chassis = None
        self._cal_antenna_psi_init = None
        self._cal_antenna_start_lat = self._gps_lat
        self._cal_antenna_start_lon = self._gps_lon
        self._cal_antenna_samples = []
        self._cal_antenna_data = []
        self._cal_antenna_phase_start_t = time.monotonic()
        self._cal_antenna_last_predict_t = None
        self._cal_antenna_last_gps_idx = -1
        self._cal_antenna_drive_distance = 0.0
        self._cal_antenna_extended = False
        self._cal_antenna_orbit_angle = 0.0
        self._fix_degraded_since = None
        self.get_logger().info('Antenna offset auto-calibration started')
        self._set_state(State.CAL_ANTENNA)

    def _on_set_antenna_offset(self, msg):
        """Operator-typed antenna offset (a_x, a_y) from a tape measure.

        Auto-cal is fragile under open-loop drive (the SCURVE pose
        integrator drifts metres without PID closed-loop velocity), so
        the practical path is to measure the offset once with a tape and
        type it in. We persist via the same JSON file the auto-cal uses,
        tagged source='manual', so the next mission picks it up
        identically. No state change — this is metadata, not a drive.
        """
        try:
            data = json.loads(msg.data)
            a_x = float(data['a_x'])
            a_y = float(data['a_y'])
        except (json.JSONDecodeError, AttributeError, TypeError, KeyError, ValueError):
            self._publish_cal_antenna_result(
                ok=False, reason='invalid manual offset payload',
            )
            return
        if not (-OFFSET_BOUND_M <= a_x <= OFFSET_BOUND_M
                and -OFFSET_BOUND_M <= a_y <= OFFSET_BOUND_M):
            self._publish_cal_antenna_result(
                ok=False,
                reason=(f'offset out of bounds ({a_x:.2f}, {a_y:.2f}) — '
                        f'must be within ±{OFFSET_BOUND_M:.1f} m'),
                a_x=a_x, a_y=a_y,
            )
            return
        try:
            payload = save_antenna_offset(
                a_x, a_y,
                rms_residual_m=0.0,
                samples=0,
                drive_distance_m=0.0,
                source='manual',
            )
        except (OSError, ValueError) as exc:
            self._publish_cal_antenna_result(
                ok=False, reason=f'persistence failed: {exc}',
                a_x=a_x, a_y=a_y,
            )
            return
        self._antenna_offset_x = a_x
        self._antenna_offset_y = a_y
        self._antenna_offset_source = 'manual'
        self.get_logger().info(
            f'Antenna offset set manually: a_x={a_x:.3f} m, a_y={a_y:.3f} m'
        )
        self._publish_cal_antenna_result(ok=True, **payload)

    # ── main control loop ────────────────────────────────────────────────

    def _control_loop(self):
        # GPS health gate first — any state that drives motors must abort
        # immediately on GPS loss.
        active_states = (
            State.CALIBRATING, State.NAVIGATING, State.SETTLING,
            State.CAL_ANTENNA, State.CAL_WHEELS,
        )
        if self._state in active_states:
            # Battery critical — stop and ERROR before motors cut out under
            # the MCU's hard cutoff (BATTERY_UNDERVOLT_V) mid-mission.
            abort_pct = self.get_parameter('battery_abort_pct').value
            if (self._battery_pct is not None
                    and self._battery_pct < abort_pct):
                self._stop_motors()
                self._pre_error_state = self._state
                self._set_error(
                    f'Battery critical ({self._battery_pct:.0f}% < {abort_pct}%) — '
                    f'aborting mission'
                )
                return
            now = time.monotonic()
            if now - self._last_gps_time > self.get_parameter('gps_timeout').value:
                self._stop_motors()
                self._pre_error_state = self._state
                self._set_error('GPS timeout (no position for >gps_timeout)')
                return
            hysteresis = self.get_parameter('fix_hysteresis_s').value
            if not self._has_required_fix():
                if self._fix_degraded_since is None:
                    self._fix_degraded_since = now
                # Hold position while the fix is degraded. Without this,
                # cruise/dock keep publishing forward Twists for the full
                # hysteresis window (0.8 s = ~80 cm at cruise_speed=1 m/s)
                # before the ERROR transition stops motors, and the
                # operator sees the chassis "fail to brake" when RTK
                # drops to float. Position is held by emitting Twist(0,0)
                # every tick — mcu_bridge's accel_limit then ramps the
                # actual chassis speed to zero, so we're not relying on
                # whatever cmd was last latched.
                self._stop_motors()
                if now - self._fix_degraded_since >= hysteresis:
                    self._pre_error_state = self._state
                    self._set_error(
                        f'GPS fix below required quality ({self._gps_fix_status}) '
                        f'for {now - self._fix_degraded_since:.2f}s'
                    )
                return
            else:
                self._fix_degraded_since = None

        # Run the estimator predict step on every tick once we're past
        # calibration. This keeps chassis pose smooth between GPS fixes.
        if self._estimator is not None and self._estimator.initialized:
            v, om = self._odom_chassis_kinematics()
            self._estimator.predict(v, om, time.monotonic())

        if self._state == State.IDLE or self._state == State.EMERGENCY_STOP:
            # Keep republishing Twist(0,0) every tick so mcu_bridge's
            # accel-limit ramp can decay any residual speed smoothly to a
            # stop. Without this, the single zero-twist published on
            # state-machine transitions would only step the speed down
            # by accel_limit · 50 ms and leave the rover coasting at
            # whatever the ramp landed on (the original "끝나도 계속
            # 직진" symptom). Manual control is unaffected — mcu_bridge
            # ignores autonomous Twists during the manual_priority_s
            # window after the operator's last joystick input.
            self._stop_motors()
            return
        if self._state == State.ERROR:
            self._handle_error()
        elif self._state == State.CALIBRATING:
            self._handle_calibrating()
        elif self._state == State.NAVIGATING:
            self._handle_navigating()
        elif self._state == State.SETTLING:
            self._handle_settling()
        elif self._state == State.SPRAYING:
            self._handle_spraying()
        elif self._state == State.CAL_ANTENNA:
            self._handle_cal_antenna()
        elif self._state == State.CAL_WHEELS:
            self._handle_cal_wheels()

    # ── error recovery ───────────────────────────────────────────────────

    def _handle_error(self):
        # Hold position every tick while in ERROR. _set_error stops the
        # motors once on transition, but mcu_bridge needs a continuous
        # zero-twist stream so its accel-limit ramp can drive actual
        # chassis speed to zero — otherwise the chassis keeps rolling
        # on the last forward cmd while we sit in ERROR waiting for
        # RTK recovery.
        self._stop_motors()
        gps_timeout = self.get_parameter('gps_timeout').value
        if (
            time.monotonic() - self._last_gps_time < gps_timeout
            and self._gps_lat is not None
            and self._has_required_fix()
        ):
            if self._pre_error_state is not None:
                self.get_logger().info(
                    f'GPS recovered, resuming {self._pre_error_state.value}'
                )
                # Reset any wall-clock timers that ran during the outage.
                # Without this, a 30 s GPS dropout during SETTLING resumes
                # with _settle_enter_time from BEFORE the outage; the
                # 10 s timeout fires immediately on the next tick and
                # triggers spray on a possibly-drifted antenna. Same for
                # _last_progress_time during NAVIGATING (instantly
                # declares "stuck"). Tracker D/I terms also reset so the
                # control law restarts from a clean state.
                now = time.monotonic()
                self._settle_enter_time = now
                self._last_progress_time = now
                self._last_progress_dist = float('inf')
                if self._cruise_tracker is not None:
                    self._cruise_tracker.reset()
                if self._dock_tracker is not None:
                    self._dock_tracker.reset()
                # Path replan when resuming into NAVIGATING. Without this,
                # the chassis pose can jump several metres during a GPS
                # dropout (RTK lost → 3d_fix dead-reckoning → RTK fixed
                # hard-correct to the new antenna fix). Resuming on the
                # pre-error segments then puts the chassis well past the
                # dock target, which trips the dock's along<0 reverse
                # latch for tens of seconds. Replanning from the live
                # chassis pose rebuilds cruise+dock so the next forward
                # cycle actually leads to the waypoint. We replan only
                # on NAVIGATING resume — SETTLING/CAL_* don't have an
                # active path to rebuild.
                resume_state = self._pre_error_state
                self._set_state(resume_state)
                self._pre_error_state = None
                self._last_error_reason = None
                if resume_state == State.NAVIGATING:
                    self._replan_from_current_chassis()
            else:
                self._set_state(State.IDLE)

    # ── calibration ──────────────────────────────────────────────────────

    def _handle_calibrating(self):
        if self._gps_lat is None:
            return

        cal_speed = self.get_parameter('calibration_speed').value
        # Drive straight, no curvature, no D-term entanglement with PP.
        self._publish_velocity(cal_speed, 0.0)

        # Sample antenna ENU position for chord regression.
        e, n = enu_from_gps(self._gps_lat, self._gps_lon, self._ref_lat, self._ref_lon)
        # Drop duplicate samples at the same GPS position to keep the
        # regression weighted by movement, not by 50 ms ticks at standstill.
        if not self._cal_samples or hypot(
            e - self._cal_samples[-1][0], n - self._cal_samples[-1][1]
        ) >= 0.02:
            self._cal_samples.append((e, n))

        dist_from_start = hypot(e, n)  # ref is the calibration start
        cal_distance = self.get_parameter('calibration_distance').value
        cal_max = self.get_parameter('calibration_max_distance').value
        effective_distance = cal_distance + (1.5 if self._cal_extended else 0.0)

        if dist_from_start >= cal_max:
            self._stop_motors()
            self._set_error(
                f'Calibration max distance reached ({dist_from_start:.2f} m) '
                'without a usable heading fit'
            )
            return

        if dist_from_start < effective_distance:
            return

        min_samples = self.get_parameter('calibration_min_samples').value
        if len(self._cal_samples) < min_samples:
            return

        psi_math, residual_rms, chord_len = fit_chord_heading(self._cal_samples)
        chord_min = self.get_parameter('calibration_chord_min_m').value
        residual_max = self.get_parameter('calibration_residual_max').value

        if chord_len < chord_min or residual_rms > residual_max:
            if not self._cal_extended:
                self._cal_extended = True
                self.get_logger().warn(
                    f'Calibration fit weak (chord={chord_len:.2f} m, '
                    f'rms={residual_rms*100:.1f} cm), extending'
                )
                return
            self._stop_motors()
            self._set_error(
                f'Calibration fit unusable after extension '
                f'(chord={chord_len:.2f} m, rms={residual_rms*100:.1f} cm)'
            )
            return

        # Build estimator anchored at the mission ENU origin.
        self._estimator = ChassisPoseEstimator(
            antenna_offset_x=self._antenna_offset_x,
            antenna_offset_y=self._antenna_offset_y,
            ref_lat=self._ref_lat,
            ref_lon=self._ref_lon,
            pos_correction_gain=self.get_parameter('estimator_pos_gain').value,
            psi_correction_gain=self.get_parameter('estimator_psi_gain').value,
            psi_correction_min_speed=self.get_parameter('estimator_psi_min_speed').value,
        )
        self._estimator.set_initial(self._gps_lat, self._gps_lon, psi_math)
        # Mission-start chassis position is the chassis pose at the moment
        # of mission trigger (CALIBRATING entry), NOT the chassis pose at
        # cal-end (which is ~2.5 m further down the calibration chord).
        # The ENU origin is the antenna at mission trigger, so the chassis
        # at trigger sits at -R(ψ_init)·offset from that origin.
        ax = self._antenna_offset_x
        ay = self._antenna_offset_y
        self._mission_start_chassis_xy = (
            -(cos(psi_math) * ax - sin(psi_math) * ay),
            -(sin(psi_math) * ax + cos(psi_math) * ay),
        )

        # Plan path now that chassis pose is known.
        params = self._params_for_trackers()
        try:
            self._segments = plan_path(
                current_chassis_pose=self._estimator.chassis_pose(),
                antenna_offset=(params['antenna_offset_x'], params['antenna_offset_y']),
                waypoints_lat_lng=self._waypoints,
                ref_lat_lon=(self._ref_lat, self._ref_lon),
                dock_distance=self.get_parameter('dock_approach_distance').value,
                return_to_start=self.get_parameter('return_to_start').value,
                start_chassis_xy=self._mission_start_chassis_xy,
            )
        except Exception as exc:  # pragma: no cover - defensive
            self._stop_motors()
            self._set_error(f'Path planning failed: {exc}')
            return
        self._cur_seg_idx = 0
        self._cur_wp_idx = 0

        self._cruise_tracker = CruiseTracker(params)
        self._dock_tracker = DockTracker(params)
        self._cruise_tracker.reset()
        self._dock_tracker.reset()
        self._reset_progress()
        self.get_logger().info(
            f'Calibration done: ψ={degrees(psi_math):.1f}° (chord={chord_len:.2f} m, '
            f'rms={residual_rms*100:.1f} cm), {len(self._segments)} segments'
        )
        self._set_state(State.NAVIGATING)

    # ── navigation ───────────────────────────────────────────────────────

    def _handle_navigating(self):
        if self._estimator is None or not self._estimator.initialized:
            return
        if self._cur_seg_idx >= len(self._segments):
            self._stop_motors()
            self._set_state(State.IDLE)
            return

        seg = self._segments[self._cur_seg_idx]
        chassis_pose = self._estimator.chassis_pose()
        antenna_world = self._estimator.antenna_position()

        if seg.kind == 'cruise':
            v, kappa, done = self._cruise_tracker.step(chassis_pose, seg, time.monotonic())
            self._publish_velocity(v, kappa)
            self._update_progress(chassis_pose, seg.end_pose)

            now_mono = time.monotonic()
            if (self._last_dock_trace_t is None
                    or now_mono - self._last_dock_trace_t >= 1.0):
                self._last_dock_trace_t = now_mono
                cx, cy, cpsi = chassis_pose
                ex, ey, _ = seg.end_pose
                dist_to_end = hypot(ex - cx, ey - cy)
                self.get_logger().info(
                    f'CRUISE seg{self._cur_seg_idx} (WP{seg.waypoint_index + 1}) '
                    f'ch=({cx:+.2f},{cy:+.2f},{degrees(cpsi):+.0f}°) '
                    f'end=({ex:+.2f},{ey:+.2f}) dist_to_end={dist_to_end*100:.1f}cm '
                    f'cmd v={v:+.2f} k={kappa:+.2f}'
                )

            if done:
                self._cur_seg_idx += 1
                self._cruise_tracker.reset()
                self._reset_progress()
                self._last_dock_trace_t = None  # reset trace clock for next segment
            return

        if seg.kind == 'dock':
            v, kappa, status = self._dock_tracker.step(chassis_pose, seg, time.monotonic(), antenna_world)
            self._publish_velocity(v, kappa)
            self._update_progress(chassis_pose, seg.end_pose)

            # 1 Hz dock trace. The cycle/stuck symptoms could be (a) chassis
            # entering the corridor with too much lateral residual, (b) the
            # forward+reverse loop never closing it, or (c) the reach
            # condition gating on something the chassis can't satisfy. Need
            # per-tick e_y / e_psi / along / dist / commanded κ to tell.
            now_mono = time.monotonic()
            if (self._last_dock_trace_t is None
                    or now_mono - self._last_dock_trace_t >= 1.0):
                self._last_dock_trace_t = now_mono
                cx, cy, cpsi = chassis_pose
                ax, ay = antenna_world
                sx, sy, psi_path = seg.start_pose
                ex, ey, _ = seg.end_pose
                tx, ty = seg.target_antenna
                a_along, e_y = _project_onto_line(ax, ay, sx, sy, psi_path)
                target_along, _ = _project_onto_line(tx, ty, sx, sy, psi_path)
                along_to_target = target_along - a_along
                e_psi = normalize_angle(cpsi - psi_path)
                dist = hypot(tx - ax, ty - ay)
                self.get_logger().info(
                    f'DOCK WP{seg.waypoint_index + 1} '
                    f'ch=({cx:+.2f},{cy:+.2f},{degrees(cpsi):+.0f}°) '
                    f'ant=({ax:+.2f},{ay:+.2f}) tgt=({tx:+.2f},{ty:+.2f}) '
                    f'e_y={e_y*100:+.1f}cm e_psi={degrees(e_psi):+.1f}° '
                    f'along_to_target={along_to_target*100:+.1f}cm '
                    f'dist={dist*100:.1f}cm '
                    f'cmd v={v:+.2f} k={kappa:+.2f} {status}'
                )

            if status == 'reached':
                # Dock reached → run settling to confirm antenna position.
                self._cur_wp_idx = seg.waypoint_index
                self._stop_motors()
                self._settle_count = 0
                self._settle_enter_time = time.monotonic()
                self._set_state(State.SETTLING)
            elif status == 'reverse_stalled':
                # DockTracker gave up on a reverse stroke that wasn't
                # making ground (chassis rotating in place under a
                # saturated latched κ — happens when the estimator
                # jump-corrects far past the target on RTK recovery).
                # Don't skip — replan from current chassis pose and
                # keep the same waypoint as the target so the next
                # cruise/dock pair leads back to it.
                self.get_logger().warn(
                    f'Dock reverse stalled on WP{seg.waypoint_index + 1}, replanning'
                )
                self._stop_motors()
                self._reset_progress()
                if self._cruise_tracker is not None:
                    self._cruise_tracker.reset()
                if self._dock_tracker is not None:
                    self._dock_tracker.reset()
                self._replan_from_current_chassis()
            return

    # ── stuck detection ──────────────────────────────────────────────────

    def _reset_progress(self):
        self._last_progress_time = time.monotonic()
        self._last_progress_dist = float('inf')
        self._stuck_window = []

    def _update_progress(self, chassis_pose, target_pose):
        x, y, _ = chassis_pose
        ex, ey, _ = target_pose
        dist = hypot(ex - x, ey - y)
        now = time.monotonic()
        timeout = self.get_parameter('stuck_timeout').value

        # Maintain chassis-displacement window of length `timeout` seconds.
        self._stuck_window.append((now, x, y))
        cutoff = now - timeout
        while self._stuck_window and self._stuck_window[0][0] < cutoff:
            self._stuck_window.pop(0)

        if dist < self._last_progress_dist - 0.02:
            self._last_progress_dist = dist
            self._last_progress_time = now
            # Chassis is making progress toward target — no need to also
            # check the displacement gate.
            return

        # Distance-to-target hasn't improved. Two ways to be stuck:
        # (a) timeout elapsed since last improvement (original gate);
        # (b) chassis hasn't moved more than 15 cm in the last `timeout`
        #     seconds (catches dock-cycle where dist oscillates but the
        #     chassis is bouncing around a 10 cm patch).
        bbox_disp = 0.0
        if len(self._stuck_window) >= 2:
            xs = [r[1] for r in self._stuck_window]
            ys = [r[2] for r in self._stuck_window]
            bbox_disp = hypot(max(xs) - min(xs), max(ys) - min(ys))
        # Threshold sized for the dock-cycle bbox actually observed: the
        # 04:18 mission's WP0 stuck cycled within 25 cm of the target
        # (oscillating 6-24 cm of along-corridor distance per tick) and
        # the previous 0.15 m gate didn't fire. 0.30 m catches that
        # cycle while still being well inside any non-cycle motion
        # (settled chassis sits in <5 cm, normal cruise covers >1 m
        # in stuck_timeout seconds).
        chassis_pinned = (
            len(self._stuck_window) >= 2
            and (now - self._stuck_window[0][0]) >= timeout
            and bbox_disp < 0.30
        )

        if not chassis_pinned and now - self._last_progress_time < timeout:
            return

        self._stuck_retries += 1
        max_retries = self.get_parameter('stuck_max_retries').value
        wp_idx = self._segments[self._cur_seg_idx].waypoint_index if self._cur_seg_idx < len(self._segments) else -1
        gate = 'displacement' if chassis_pinned else 'no-progress'
        self.get_logger().warn(
            f'Stuck on segment {self._cur_seg_idx} (waypoint {wp_idx + 1}) '
            f'retry {self._stuck_retries}/{max_retries} '
            f'gate={gate} bbox_disp={bbox_disp*100:.1f}cm'
        )
        if self._stuck_retries > max_retries:
            self._skip_current_waypoint()
        else:
            # Reset trackers so the retry doesn't reuse a saturated I-term
            # (DockTracker integral) or stale D-term (CruiseTracker prev_alpha).
            # Without this, retry is functionally a no-op: the same control
            # law re-runs against the same wall it failed against.
            if self._cruise_tracker is not None:
                self._cruise_tracker.reset()
            if self._dock_tracker is not None:
                self._dock_tracker.reset()
            self._reset_progress()

    def _skip_current_waypoint(self):
        if self._cur_seg_idx >= len(self._segments):
            return
        skipped_idx = self._segments[self._cur_seg_idx].waypoint_index
        # Skip both the cruise + dock segments belonging to this waypoint.
        # Synthetic return segments have waypoint_index = -1 — their skip
        # ends the mission cleanly rather than trying to parse the next.
        while (self._cur_seg_idx < len(self._segments)
               and self._segments[self._cur_seg_idx].waypoint_index == skipped_idx):
            self._cur_seg_idx += 1
        if skipped_idx >= 0:
            msg = Int32()
            msg.data = int(skipped_idx)
            self._pub_skipped.publish(msg)
            self.get_logger().warn(f'Skipped waypoint {skipped_idx + 1}')
        self._stuck_retries = 0
        self._reset_progress()
        # Reset BOTH trackers so saturated DockTracker integral from the
        # failed dock doesn't leak into the next waypoint's docking.
        if self._cruise_tracker is not None:
            self._cruise_tracker.reset()
        if self._dock_tracker is not None:
            self._dock_tracker.reset()
        # Re-plan the remaining path anchored at the chassis's actual
        # current pose. Without this, the next cruise segment has its
        # start_pose pinned to where the previous waypoint's dock-end
        # WOULD have been if the chassis had reached it — but after a
        # skip the chassis is sitting at the stuck spot, often metres
        # off the original corridor. The cruise pure-pursuit then orbits
        # the lookahead trying to reach a corridor it isn't on, which is
        # the WP1/WP2/WP7 in-place spin the operator was seeing.
        if skipped_idx >= 0:
            self._replan_from_current_chassis()

    def _replan_from_current_chassis(self):
        """Rebuild self._segments anchored at the chassis's live pose.

        Used after a skip — the planner originally laid out cruise/dock
        segments under the assumption the chassis would be at each dock-
        end before transitioning to the next cruise. A skip breaks that
        assumption, so we regenerate the remaining segments using the
        actual chassis pose as the next cruise's start. The waypoint
        index offset keeps the new segments numbered against the
        original `self._waypoints` list so any consumer of
        seg.waypoint_index (the UI skip publisher, settle handler) sees
        the same indices it saw before the replan.
        """
        if self._estimator is None or not self._estimator.initialized:
            return
        # Find the next pending waypoint index in the ORIGINAL waypoint list.
        if self._cur_seg_idx < len(self._segments):
            next_seg = self._segments[self._cur_seg_idx]
            if next_seg.waypoint_index < 0:
                # Currently in the synthetic return-to-start segments.
                # Replan them from chassis pose using the same target.
                next_wp_idx = len(self._waypoints)
            else:
                next_wp_idx = next_seg.waypoint_index
        else:
            next_wp_idx = len(self._waypoints)

        remaining = self._waypoints[next_wp_idx:]
        params = self._params_for_trackers()
        try:
            new_segments = plan_path(
                current_chassis_pose=self._estimator.chassis_pose(),
                antenna_offset=(params['antenna_offset_x'], params['antenna_offset_y']),
                waypoints_lat_lng=remaining,
                ref_lat_lon=(self._ref_lat, self._ref_lon),
                dock_distance=self.get_parameter('dock_approach_distance').value,
                return_to_start=self.get_parameter('return_to_start').value,
                start_chassis_xy=self._mission_start_chassis_xy,
                waypoint_index_offset=next_wp_idx,
            )
        except Exception as exc:  # pragma: no cover - defensive
            self.get_logger().warn(f'Replan failed: {exc}')
            return
        self._segments = new_segments
        self._cur_seg_idx = 0

    # ── settling ─────────────────────────────────────────────────────────

    def _handle_settling(self):
        if self._estimator is None or not self._estimator.initialized:
            return
        if self._cur_wp_idx < 0 or self._cur_wp_idx >= len(self._waypoints):
            # Settling on a synthetic return-to-start segment (waypoint
            # index = -1): skip spray and finish the mission. We don't try
            # to wait for cm-tolerance settling on the return — the user
            # hasn't pinned a target there, only a "go home" intent.
            self._stop_motors()
            self.get_logger().info('Returned to start, mission complete')
            self._set_state(State.IDLE)
            self._cur_seg_idx = len(self._segments)
            return

        wp = self._waypoints[self._cur_wp_idx]
        antenna_e, antenna_n = self._estimator.antenna_position()
        target_e, target_n = enu_from_gps(wp['lat'], wp['lng'], self._ref_lat, self._ref_lon)
        dist = hypot(target_e - antenna_e, target_n - antenna_n)

        wp_tol = self.get_parameter('waypoint_tolerance').value
        settle_tol = self.get_parameter('settle_tolerance').value
        settle_readings = self.get_parameter('settle_readings').value
        settle_timeout = self.get_parameter('settle_timeout').value

        # Diagnostic: log estimator state vs raw GPS antenna at the moment
        # of timeout / settle decision, so we can pin down whether settle
        # failures come from estimator drift, antenna_offset error, or
        # dock_tracker stop accuracy.
        if time.monotonic() - self._settle_enter_time > settle_timeout:
            cx, cy, cpsi = self._estimator.chassis_pose()
            gps_e = gps_n = float('nan')
            if self._gps_lat is not None and self._ref_lat is not None:
                gps_e, gps_n = enu_from_gps(
                    self._gps_lat, self._gps_lon, self._ref_lat, self._ref_lon)
            self.get_logger().info(
                f'WP{self._cur_wp_idx + 1} timeout diag: '
                f'chassis=({cx:.3f}, {cy:.3f}, {degrees(cpsi):.1f}°) '
                f'ant_est=({antenna_e:.3f}, {antenna_n:.3f}) '
                f'ant_gps=({gps_e:.3f}, {gps_n:.3f}) '
                f'target=({target_e:.3f}, {target_n:.3f}) '
                f'dist_est={dist*100:.1f}cm '
                f'dist_gps={hypot(target_e-gps_e, target_n-gps_n)*100:.1f}cm'
            )
            # Don't spray on a moving target. If the antenna is currently
            # outside waypoint_tolerance (still in re-approach via the
            # dock tracker), skip the waypoint instead of firing spray
            # at whatever drifted position we happen to be at. Settling
            # included time spent re-tracking, so a bouncy antenna can
            # exhaust the budget while still moving.
            if dist > wp_tol:
                self.get_logger().warn(
                    f'Settle timeout at waypoint {self._cur_wp_idx + 1} '
                    f'(dist={dist*100:.1f} cm > waypoint_tolerance) — '
                    'skipping rather than spraying on moving antenna'
                )
                self._skip_current_waypoint()
                self._set_state(State.NAVIGATING)
                return
            self.get_logger().warn(
                f'Settle timeout at waypoint {self._cur_wp_idx + 1} '
                f'(dist={dist*100:.1f} cm), proceeding to spray'
            )
            self._trigger_spray()
            return

        if dist > wp_tol:
            # Antenna sits outside settle tolerance — but we DON'T hand
            # back to the dock tracker here. The chassis already reached
            # approach_tolerance under the dock controller; any further
            # apparent distance is dominated by GPS multipath / estimator
            # catch-up, not by actual chassis motion. Re-arming dock would
            # see along_to_target flip negative on the next noisy sample,
            # latch into reverse-recovery, and oscillate forever — exactly
            # the back-and-forth the operator saw.
            #
            # Instead, hold the chassis stopped, reset the settle counter,
            # and let settle_timeout decide: if the antenna ends up within
            # waypoint_tolerance at timeout we spray; otherwise we skip.
            self._settle_count = 0
            self._stop_motors()
            return

        # Inside tolerance.
        self._stop_motors()
        if dist <= settle_tol:
            self._settle_count += 1
            if self._settle_count >= settle_readings:
                self.get_logger().info(
                    f'Waypoint {self._cur_wp_idx + 1}/{len(self._waypoints)} '
                    f'settled at {dist*100:.1f} cm'
                )
                self._trigger_spray()
        else:
            self._settle_count = 0

    def _trigger_spray(self):
        msg = Int32()
        msg.data = int(self._cur_wp_idx)
        self._pub_waypoint_reached.publish(msg)
        self._spray_enter_time = time.monotonic()
        self._set_state(State.SPRAYING)

    # ── spraying ─────────────────────────────────────────────────────────

    def _handle_spraying(self):
        if time.monotonic() - self._spray_enter_time > self.get_parameter('spray_timeout').value:
            self.get_logger().warn(
                f'Spray timeout at waypoint {self._cur_wp_idx + 1}, skipping'
            )
            result = String()
            result.data = json.dumps({
                'waypoint': int(self._cur_wp_idx),
                'outcome': 'timeout',
            })
            self._pub_spray_result.publish(result)
            cancel = Int32()
            cancel.data = int(self._cur_wp_idx)
            self._pub_spray_cancel.publish(cancel)
            self._advance_to_next_waypoint()
            return

        # Position hold during spray: keep the antenna parked on target
        # using the dock tracker. This is what catches small GPS drift
        # mid-spray without leaving SPRAYING.
        if self._estimator is None or self._cur_seg_idx >= len(self._segments):
            self._stop_motors()
            return
        seg = self._segments[self._cur_seg_idx]
        if seg.kind != 'dock':
            self._stop_motors()
            return
        antenna_e, antenna_n = self._estimator.antenna_position()
        target_e, target_n = seg.target_antenna
        dist = hypot(target_e - antenna_e, target_n - antenna_n)
        if dist > self.get_parameter('waypoint_tolerance').value:
            v, kappa, _ = self._dock_tracker.step(
                self._estimator.chassis_pose(), seg,
                time.monotonic(),
                (antenna_e, antenna_n),
            )
            self._publish_velocity(v, kappa)
        else:
            self._stop_motors()

    # ── wheel scale auto-calibration ────────────────────────────────────

    def _handle_cal_wheels(self):
        """Drive a straight chord, integrate per-wheel encoder distance,
        derive (scale_l, scale_r) from gps_chord / encoder_distance.

        We don't enforce κ=0 via a lookahead controller — straight at the
        commanded κ=0 is good enough; tiny drift won't change ∫|v_wheel|
        dt meaningfully because the integrand is wheel speed magnitude.
        """
        if self._gps_lat is None:
            return
        speed = self.get_parameter('wheel_cal_speed').value
        self._publish_velocity(speed, 0.0)

        # Encoder integration. Use raw (pre-scale) values from mcu_bridge
        # so the result represents the absolute wheel-radius mismatch
        # rather than composing on top of an existing scale.
        now = time.monotonic()
        if self._cal_wheels_last_t is None:
            self._cal_wheels_last_t = now
        else:
            dt = now - self._cal_wheels_last_t
            self._cal_wheels_last_t = now
            if 0.0 < dt < 0.5:
                self._cal_wheels_enc_l_m += abs(self._odom_v_left_raw) * dt
                self._cal_wheels_enc_r_m += abs(self._odom_v_right_raw) * dt
                self._cal_wheels_samples += 1

        # ENU samples for steering-trim circle fit. Dedupe on GPS time so
        # we capture exactly one sample per fresh fix; the same fix coming
        # in across multiple control ticks must not stack (would weight
        # the LSQ unfairly toward fix-update boundaries).
        gps_idx = int(self._last_gps_time * 1000)
        if gps_idx != self._cal_wheels_last_gps_idx:
            self._cal_wheels_last_gps_idx = gps_idx
            e, n = enu_from_gps(
                self._gps_lat, self._gps_lon,
                self._cal_wheels_start_lat, self._cal_wheels_start_lon,
            )
            self._cal_wheels_enu_samples.append((e, n))

        gps_dist = haversine(
            self._cal_wheels_start_lat, self._cal_wheels_start_lon,
            self._gps_lat, self._gps_lon,
        )

        target = self.get_parameter('wheel_cal_distance').value
        cap = self.get_parameter('wheel_cal_max_distance').value

        if gps_dist >= cap:
            self._stop_motors()
            self._publish_cal_wheels_result(
                ok=False,
                reason=f'drove {gps_dist:.2f} m without converging on target {target:.1f} m',
                gps_distance_m=gps_dist,
                encoder_left_m=self._cal_wheels_enc_l_m,
                encoder_right_m=self._cal_wheels_enc_r_m,
                samples=self._cal_wheels_samples,
            )
            self._set_state(State.IDLE)
            return

        if gps_dist < target:
            return

        self._stop_motors()
        result = solve_wheel_scales(
            samples_enu=self._cal_wheels_enu_samples,
            encoder_left_m=self._cal_wheels_enc_l_m,
            encoder_right_m=self._cal_wheels_enc_r_m,
            samples=self._cal_wheels_samples,
            track_width_m=self.get_parameter('track_width').value,
            gps_distance_m=gps_dist,
        )
        if result['reason'] is not None:
            self.get_logger().warn(f'wheel cal solve failed: {result["reason"]}')
            self._publish_cal_wheels_result(
                ok=False,
                reason=result['reason'],
                gps_distance_m=gps_dist,
                encoder_left_m=self._cal_wheels_enc_l_m,
                encoder_right_m=self._cal_wheels_enc_r_m,
                samples=self._cal_wheels_samples,
                scale_l=result.get('scale_l'),
                scale_r=result.get('scale_r'),
            )
            self._set_state(State.IDLE)
            return

        # Hand the new scales to mcu_bridge, which persists and applies.
        scale_l = result['scale_l']
        scale_r = result['scale_r']
        arc_r = result.get('arc_radius_m')
        arc_th = result.get('arc_theta_rad')
        apply_msg = String()
        apply_payload = {
            'scale_l': scale_l,
            'scale_r': scale_r,
            'gps_distance_m': gps_dist,
            'encoder_left_m': self._cal_wheels_enc_l_m,
            'encoder_right_m': self._cal_wheels_enc_r_m,
            'samples': self._cal_wheels_samples,
        }
        if arc_r is not None:
            apply_payload['arc_radius_m'] = arc_r
        if arc_th is not None:
            apply_payload['arc_theta_rad'] = arc_th
        apply_msg.data = json.dumps(apply_payload)
        self._pub_apply_wheel_scales.publish(apply_msg)
        arc_str = (f', arc r={arc_r:.1f} m θ={degrees(arc_th):.1f}°'
                   if arc_r is not None and arc_th is not None
                   else ', straight')
        self.get_logger().info(
            f'wheel cal: L={scale_l:.4f} R={scale_r:.4f} '
            f'(gps={gps_dist:.2f} m, encL={self._cal_wheels_enc_l_m:.2f} m, '
            f'encR={self._cal_wheels_enc_r_m:.2f} m, '
            f'n={self._cal_wheels_samples}{arc_str})'
        )

        # Steering-trim auto-cal piggy-backs on the same κ=0 chord. We
        # already collected ENU samples; if the path is actually a slight
        # arc, the circle fit recovers the bias.
        #
        # The cal drive itself runs WITH any previously persisted trim
        # already applied by mcu_bridge, so the residual κ_bias the
        # solver sees is what's left over after the existing correction.
        # That makes the solver result a *delta*, not an absolute trim.
        # The previous bug treated it as absolute and overwrote the
        # accumulated correction on every cal — running cal twice would
        # push trim back toward 0 even on a chassis with a real bias,
        # and operators saw the rover veering again after a "successful"
        # second cal. Accumulate instead: read the currently persisted
        # trim, add the delta, re-validate the ±TRIM_BOUND_US bound
        # against the accumulated value, and publish that.
        trim_result = solve_steering_trim(
            samples=self._cal_wheels_enu_samples,
            kappa_max=tan(self._max_steer_rad)
                      / max(self.get_parameter('wheelbase').value, 1e-3),
            servo_range_us=self.get_parameter('servo_range_us').value,
            drive_distance_m=gps_dist,
        )
        trim_us = None
        radius_m = None
        rms_residual_m = None
        steering_reason = trim_result.get('reason')
        if steering_reason is None:
            delta_us = float(trim_result['trim_us'])
            current_trim, _ = load_steering_trim(default=0.0)
            new_trim_us = current_trim + delta_us
            r = trim_result['radius_m']
            radius_m = float(r) if isfinite(r) else None
            rms_residual_m = float(trim_result['rms_residual_m'])
            if abs(new_trim_us) > TRIM_BOUND_US:
                steering_reason = (
                    f'accumulated trim {new_trim_us:+.1f} µs (current '
                    f'{current_trim:+.1f} + delta {delta_us:+.1f}) outside '
                    f'±{TRIM_BOUND_US:.0f} µs'
                )
                self.get_logger().warn(f'steering trim rejected: {steering_reason}')
            else:
                trim_us = new_trim_us
                trim_msg = String()
                trim_msg.data = json.dumps({
                    'trim_us': trim_us,
                    'radius_m': radius_m,
                    'rms_residual_m': rms_residual_m,
                    'samples': int(trim_result['samples']),
                    'drive_distance_m': gps_dist,
                })
                self._pub_apply_steering_trim.publish(trim_msg)
                radius_str = (f'{radius_m:.1f} m' if radius_m is not None
                              else 'straight')
                self.get_logger().info(
                    f'steering trim: {current_trim:+.1f} µs + '
                    f'{delta_us:+.1f} µs = {trim_us:+.1f} µs '
                    f'(radius={radius_str}, rms={rms_residual_m*100:.1f} cm, '
                    f'n={trim_result["samples"]})'
                )
        else:
            self.get_logger().warn(
                f'steering trim solve failed: {steering_reason}'
            )
        self._publish_cal_wheels_result(
            ok=True,
            scale_l=scale_l,
            scale_r=scale_r,
            gps_distance_m=gps_dist,
            encoder_left_m=self._cal_wheels_enc_l_m,
            encoder_right_m=self._cal_wheels_enc_r_m,
            samples=self._cal_wheels_samples,
            trim_us=trim_us,
            radius_m=radius_m,
            steering_rms_m=rms_residual_m,
            steering_reason=steering_reason,
        )
        self._set_state(State.IDLE)

    def _publish_cal_wheels_result(self, *, ok, reason=None,
                                   scale_l=None, scale_r=None,
                                   gps_distance_m=None,
                                   encoder_left_m=None, encoder_right_m=None,
                                   samples=None,
                                   trim_us=None, radius_m=None,
                                   steering_rms_m=None,
                                   steering_reason=None):
        payload = {'ok': bool(ok)}
        if reason is not None:
            payload['reason'] = reason
        for k, v in (('scale_l', scale_l), ('scale_r', scale_r),
                     ('gps_distance_m', gps_distance_m),
                     ('encoder_left_m', encoder_left_m),
                     ('encoder_right_m', encoder_right_m),
                     ('samples', samples),
                     ('trim_us', trim_us),
                     ('radius_m', radius_m),
                     ('steering_rms_m', steering_rms_m),
                     ('steering_reason', steering_reason)):
            if v is not None:
                payload[k] = v
        msg = String()
        msg.data = json.dumps(payload)
        self._pub_cal_wheels_result.publish(msg)

    # ── antenna offset auto-calibration ─────────────────────────────────

    def _handle_cal_antenna(self):
        if self._cal_antenna_phase == CalAntennaPhase.STRAIGHT:
            self._cal_antenna_step_straight()
        elif self._cal_antenna_phase == CalAntennaPhase.CIRCLE:
            self._cal_antenna_step_circle()
        elif self._cal_antenna_phase == CalAntennaPhase.SOLVE:
            self._cal_antenna_step_solve()

    def _cal_antenna_step_straight(self):
        """Drive κ=0 for `antenna_cal_straight_distance`, fit chord → ψ_init."""
        if self._gps_lat is None:
            return
        speed = self.get_parameter('antenna_cal_speed').value
        self._publish_velocity(speed, 0.0)

        # Use the start fix as a local ENU origin for the chord regression.
        e, n = enu_from_gps(
            self._gps_lat, self._gps_lon,
            self._cal_antenna_start_lat, self._cal_antenna_start_lon,
        )
        if (not self._cal_antenna_samples
                or hypot(e - self._cal_antenna_samples[-1][0],
                         n - self._cal_antenna_samples[-1][1]) >= 0.02):
            self._cal_antenna_samples.append((e, n))

        target_distance = self.get_parameter('antenna_cal_straight_distance').value
        if self._cal_antenna_extended:
            target_distance += 1.0
        # Hard cap at 2× the requested distance — refuse to keep driving
        # forever if the fit just won't lock in.
        max_distance = max(2.0 * target_distance, target_distance + 2.0)
        dist = hypot(e, n)

        if dist >= max_distance:
            self._stop_motors()
            self._publish_cal_antenna_result(
                ok=False,
                reason=f'straight phase exceeded {max_distance:.1f} m without a usable chord',
            )
            self._set_state(State.IDLE)
            return

        if dist < target_distance:
            return

        chord_min = self.get_parameter('calibration_chord_min_m').value
        residual_max = self.get_parameter('calibration_residual_max').value
        psi_math, rms, chord_len = fit_chord_heading(self._cal_antenna_samples)
        if chord_len < chord_min or rms > residual_max:
            if not self._cal_antenna_extended:
                self._cal_antenna_extended = True
                self.get_logger().warn(
                    f'Antenna-cal straight fit weak (chord={chord_len:.2f} m, '
                    f'rms={rms*100:.1f} cm), extending'
                )
                return
            self._stop_motors()
            self._publish_cal_antenna_result(
                ok=False,
                reason=(f'straight chord fit unusable '
                        f'(chord={chord_len:.2f} m, rms={rms*100:.1f} cm)'),
            )
            self._set_state(State.IDLE)
            return

        # Bootstrap the chassis pose. The "chassis" reference is the rear
        # axle; we don't know its world-frame position because we don't
        # know the offset yet (that's what we're solving for). Anchor it
        # at the GPS antenna position with zero offset assumption — the
        # closed-form circular solver only depends on the per-sample
        # consistency between chassis_xy and antenna_obs being in the
        # SAME frame, not on an absolute origin. The chord fit gave us
        # ψ_init so the chassis frame is rotation-aligned with ENU.
        self._cal_antenna_psi_init = psi_math
        self._cal_antenna_chassis = (e, n, psi_math)
        self._cal_antenna_phase = CalAntennaPhase.CIRCLE
        self._cal_antenna_phase_start_t = time.monotonic()
        self._cal_antenna_last_predict_t = None
        self._cal_antenna_drive_distance = dist
        self.get_logger().info(
            f'Antenna-cal straight done: ψ_init={degrees(psi_math):.1f}° '
            f'(chord={chord_len:.2f} m, rms={rms*100:.1f} cm) → circle'
        )

    def _cal_antenna_step_circle(self):
        """Drive constant κ = sign / R for N revolutions, sample chassis vs antenna.

        The closed-form circular solver fits two circles (chassis trace and
        antenna trace) and recovers (a_x, a_y) from their common centre and
        the constant phase offset between their orbit angles. It does NOT
        consume per-sample chassis ψ, so this phase deliberately omits the
        GPS heading-of-motion snap that the SCURVE phase relied on — that
        snap injected ~100 ms doppler lag into chassis_xy integration, which
        rotated the recovered r vector while preserving |r|.

        Chassis_xy is open-loop integrated from encoder ω + v. Wheel scales
        are already calibrated (sub-0.2% per side), so the differential ω is
        a direct measurement of chassis rotation. Over a 15-25 s drive on
        smooth ground the cumulative ψ drift is well under 1°, which
        translates to a bounded distortion of the chassis circle fit that
        the rms gate (10 cm) catches if it does sneak through.
        """
        speed = self.get_parameter('antenna_cal_speed').value
        radius = self.get_parameter('antenna_cal_radius_m').value
        revolutions = max(1, int(self.get_parameter('antenna_cal_revolutions').value))
        sign_raw = int(self.get_parameter('antenna_cal_sign').value)
        sign = 1 if sign_raw >= 0 else -1

        if radius <= 0:
            self._stop_motors()
            self._publish_cal_antenna_result(
                ok=False,
                reason=f'antenna_cal_radius_m must be > 0 (got {radius})',
            )
            self._set_state(State.IDLE)
            return

        # Termination: completed the requested orbit angle, OR safety cap
        # at 1.5× nominal duration in case encoder ω lags commanded.
        target_orbit_angle = 2.0 * pi * revolutions
        elapsed = time.monotonic() - self._cal_antenna_phase_start_t
        nominal_t = (2.0 * pi * radius * revolutions) / max(speed, 0.1)
        if (abs(self._cal_antenna_orbit_angle) >= target_orbit_angle
                or elapsed > 1.5 * nominal_t):
            self._stop_motors()
            self._cal_antenna_phase = CalAntennaPhase.SOLVE
            return

        kappa = sign / radius
        # Clamp to physical curvature limit — defends against a misconfigured
        # cal_radius_m smaller than the chassis can actually turn.
        kappa_cap = self.get_parameter('max_curvature').value
        if abs(kappa) > kappa_cap:
            kappa = kappa_cap if kappa > 0 else -kappa_cap
        self._publish_velocity(speed, kappa)

        # Encoder-only chassis pose integration. No GPS heading snap (see
        # docstring above for why).
        v_avg, omega = self._odom_chassis_kinematics()
        now = time.monotonic()
        if self._cal_antenna_last_predict_t is None:
            self._cal_antenna_last_predict_t = now
        else:
            dt = now - self._cal_antenna_last_predict_t
            self._cal_antenna_last_predict_t = now
            if 0.0 < dt < 0.5:
                cx, cy, cpsi = self._cal_antenna_chassis
                mid_psi = cpsi + 0.5 * omega * dt
                cx += v_avg * cos(mid_psi) * dt
                cy += v_avg * sin(mid_psi) * dt
                cpsi = normalize_angle(cpsi + omega * dt)
                self._cal_antenna_chassis = (cx, cy, cpsi)
                self._cal_antenna_drive_distance += abs(v_avg) * dt
                self._cal_antenna_orbit_angle += omega * dt

        # Record one sample per fresh GPS fix. Dedupe via _last_gps_time so
        # we never emit two samples for the same fix.
        if self._cal_antenna_last_gps_idx != int(self._last_gps_time * 1000):
            self._cal_antenna_last_gps_idx = int(self._last_gps_time * 1000)
            if self._gps_lat is not None:
                a_e, a_n = enu_from_gps(
                    self._gps_lat, self._gps_lon,
                    self._cal_antenna_start_lat, self._cal_antenna_start_lon,
                )
                cx, cy, cpsi = self._cal_antenna_chassis
                self._cal_antenna_data.append((cx, cy, cpsi, a_e, a_n))

    def _cal_antenna_step_solve(self):
        """Run circular fit, persist on success, publish result either way."""
        result = solve_antenna_offset_circular(self._cal_antenna_data)
        ok = result.get('reason') is None
        if ok:
            try:
                payload = save_antenna_offset(
                    result['a_x'], result['a_y'],
                    rms_residual_m=result['rms_residual_m'],
                    samples=result['samples'],
                    drive_distance_m=self._cal_antenna_drive_distance,
                )
            except (OSError, ValueError) as exc:
                self._publish_cal_antenna_result(
                    ok=False,
                    reason=f'persistence failed: {exc}',
                    a_x=result['a_x'], a_y=result['a_y'],
                    rms_residual_m=result['rms_residual_m'],
                    samples=result['samples'],
                )
                self._set_state(State.IDLE)
                return
            # Apply immediately so the next mission picks it up.
            self._antenna_offset_x = float(result['a_x'])
            self._antenna_offset_y = float(result['a_y'])
            self._antenna_offset_source = 'persisted'
            self.get_logger().info(
                f'Antenna offset calibrated: a_x={self._antenna_offset_x:.3f} m, '
                f'a_y={self._antenna_offset_y:.3f} m '
                f'(rms={result["rms_residual_m"]*100:.1f} cm, '
                f'n={result["samples"]}, drive={self._cal_antenna_drive_distance:.1f} m)'
            )
            self._publish_cal_antenna_result(ok=True, **payload)
        else:
            cand_a_x = result.get('a_x')
            cand_a_y = result.get('a_y')
            cand_rms = result.get('rms_residual_m')
            extras = ''
            if cand_a_x is not None and cand_a_y is not None:
                extras = f' (candidate a_x={cand_a_x:.3f}, a_y={cand_a_y:.3f}'
                if cand_rms is not None:
                    extras += f', rms={cand_rms*100:.1f} cm'
                extras += ')'
            self.get_logger().warn(
                f'Antenna-cal solve failed: {result["reason"]}{extras}'
            )
            # Dump samples for offline analysis. Path mirrors the persisted
            # offset path family ($PILOT_STATE_DIR/), survives container
            # restarts via the bind mount.
            try:
                dump_dir = os.environ.get('PILOT_STATE_DIR') or tempfile.gettempdir()
                dump_path = os.path.join(dump_dir, 'antenna_cal_failed_samples.json')
                with open(dump_path, 'w') as f:
                    json.dump({
                        'reason': result['reason'],
                        'candidate_a_x': result.get('a_x'),
                        'candidate_a_y': result.get('a_y'),
                        'rms_residual_m': result.get('rms_residual_m'),
                        'psi_init_rad': self._cal_antenna_psi_init,
                        'circle_R_m': result.get('circle_R_m'),
                        'circle_rho_m': result.get('circle_rho_m'),
                        'phase_phi_rad': result.get('phase_phi_rad'),
                        'rotation_sign': result.get('rotation_sign'),
                        'centre_dist_m': result.get('centre_dist_m'),
                        'samples': [
                            {'cx': cx, 'cy': cy, 'cpsi': cpsi,
                             'a_e': a_e, 'a_n': a_n}
                            for cx, cy, cpsi, a_e, a_n
                            in self._cal_antenna_data
                        ],
                    }, f)
                self.get_logger().info(f'Antenna-cal failed samples dumped to {dump_path}')
            except OSError as exc:
                self.get_logger().warn(f'Failed to dump cal samples: {exc}')
            self._publish_cal_antenna_result(
                ok=False,
                reason=result['reason'],
                a_x=result.get('a_x'),
                a_y=result.get('a_y'),
                rms_residual_m=result.get('rms_residual_m'),
                samples=result.get('samples'),
            )
        self._set_state(State.IDLE)

    def _publish_cal_antenna_result(self, *, ok, reason=None, a_x=None,
                                    a_y=None, rms_residual_m=None,
                                    samples=None, drive_distance_m=None,
                                    calibrated_at=None, source=None):
        payload = {'ok': bool(ok)}
        if reason is not None:
            payload['reason'] = reason
        for k, v in (('a_x', a_x), ('a_y', a_y),
                     ('rms_residual_m', rms_residual_m),
                     ('samples', samples),
                     ('drive_distance_m', drive_distance_m),
                     ('calibrated_at', calibrated_at),
                     ('source', source)):
            if v is not None:
                payload[k] = v
        msg = String()
        msg.data = json.dumps(payload)
        self._pub_cal_antenna_result.publish(msg)

    def _advance_to_next_waypoint(self):
        # Move past the dock segment of the current waypoint.
        if self._cur_seg_idx < len(self._segments):
            self._cur_seg_idx += 1
        self._stuck_retries = 0
        self._reset_progress()
        if self._cruise_tracker is not None:
            self._cruise_tracker.reset()
        if self._dock_tracker is not None:
            self._dock_tracker.reset()

        if self._cur_seg_idx >= len(self._segments):
            self._stop_motors()
            self.get_logger().info('Mission complete')
            self._set_state(State.IDLE)
            return
        self._set_state(State.NAVIGATING)

    # ── velocity / state plumbing ────────────────────────────────────────

    def _publish_velocity(self, speed, curvature):
        msg = Twist()
        msg.linear.x = float(speed)
        msg.angular.z = float(curvature)
        self._pub_velocity.publish(msg)

    def _stop_motors(self):
        self._publish_velocity(0.0, 0.0)

    def _set_state(self, new_state):
        if self._state != new_state:
            self.get_logger().info(f'State: {self._state.value} → {new_state.value}')
            self._state = new_state
            self._publish_state()

    def _publish_state(self):
        if self._last_published_state == self._state:
            return
        msg = String()
        msg.data = self._state.value
        self._pub_state.publish(msg)
        self._last_published_state = self._state

    def _set_error(self, reason):
        self._last_error_reason = reason
        self.get_logger().warn(f'ERROR: {reason}')
        msg = String()
        msg.data = reason
        self._pub_error_reason.publish(msg)
        self._set_state(State.ERROR)


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
