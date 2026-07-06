"""Navigator Node: antenna-precise mission state machine.

Drives the chassis so that the GPS antenna (the user's clicked target) lands
on each waypoint within `waypoint_tolerance`, even when the antenna is offset
from the rear axle.

Pipeline (per control tick, 20 Hz):
    odom + GPS  →  ChassisPoseEstimator  →  (x_chassis, y_chassis, ψ)
    waypoints   →  PathPlanner           →  [segment, segment, …]
    chassis pose + segment → L1Tracker → (v, κ)
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
    /rover/perception/obstacle (std_msgs/Bool)       — corridor obstacle → local auto-pause
    /rover/spray/done      (std_msgs/Empty)

Published:
    /rover/cmd/velocity         (geometry_msgs/Twist)  — linear.x = m/s, angular.z = κ (1/m)
    /rover/nav/state            (std_msgs/String)
    /rover/nav/waypoint_reached (std_msgs/Int32)
    /rover/nav/error_reason     (std_msgs/String)      — populated on every ERROR entry
    /rover/spray/result         (std_msgs/String JSON)
    /rover/spray/cancel         (std_msgs/Int32)
"""

import json
import math
import os
import tempfile
import time
from enum import Enum
from math import atan2, radians, degrees, hypot, cos, sin, tan, isfinite, pi

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from sensor_msgs.msg import NavSatFix
from geometry_msgs.msg import Twist
from std_msgs.msg import Bool, Float64, String, Int32, Empty

from pilot.lib.geo_utils import (
    enu_from_gps, fit_chord_heading, haversine, normalize_angle,
)
from pilot.lib.protocol_utils import has_required_fix_status
from pilot.lib.state_estimator import ChassisPoseEstimator
from pilot.lib.path_planner import plan as plan_path
from pilot.lib.path_tracker import L1Tracker
from pilot.lib.antenna_calibration import (
    OFFSET_BOUND_M, OFFSET_MIN_FORWARD_M,
    load_antenna_offset, save_antenna_offset,
    solve_antenna_offset_circular,
)
from pilot.lib.wheel_calibration import solve_wheel_scales
from pilot.lib.steering_calibration import (
    TRIM_BOUND_US, load_steering_trim, solve_steering_trim,
)


class State(Enum):
    IDLE = 'IDLE'
    CALIBRATING = 'CALIBRATING'
    NAVIGATING = 'NAVIGATING'
    SETTLING = 'SETTLING'
    SPRAYING = 'SPRAYING'
    CAL_ANTENNA = 'CAL_ANTENNA'
    CAL_WHEELS = 'CAL_WHEELS'
    # Operator/obstacle soft-pause: holds position WITHOUT the E-Stop latch, so
    # manual control still works (mcu_bridge allows manual outside the autonomous
    # states). The mission is preserved and resumes from the current waypoint.
    PAUSED = 'PAUSED'
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
        # Defaults mirror config/rover_params.yaml — that file is the
        # authoritative tuned value and is always passed via the launch
        # file. These defaults only apply if the yaml fails to load (test
        # harness, direct `ros2 run`).
        self.declare_parameter('wheelbase', 0.33)
        self.declare_parameter('track_width', 0.33)
        self.declare_parameter('max_steering_angle_deg', 30.5)
        self.declare_parameter('max_curvature', 1.7)
        # Mirrors mcu_bridge_node.servo_range_us; the steering auto-trim
        # solve at the end of CAL_WHEELS converts κ_bias to a servo µs
        # offset which the bridge then persists. Declared here so the
        # solve doesn't have to round-trip through mcu_bridge just to
        # learn the platform's servo geometry.
        self.declare_parameter('servo_range_us', 500)

        # Speeds.
        self.declare_parameter('cruise_speed', 1.0)
        self.declare_parameter('approach_speed', 0.4)
        self.declare_parameter('calibration_speed', 0.5)

        # L1 tracker (antenna-as-unicycle, Aicardi 1995). See
        # pilot/lib/path_tracker.py::L1Tracker.
        self.declare_parameter('l1_cm_capture_m', 0.03)
        self.declare_parameter('l1_brake_zone_m', 1.00)
        self.declare_parameter('l1_min_speed_m_s', 0.07)
        self.declare_parameter('l1_kturn_enter_rad', 1.047)
        self.declare_parameter('l1_kturn_exit_rad', 0.0873)
        self.declare_parameter('l1_kturn_exit_dist_m', 0.50)

        # Tolerances and timeouts.
        self.declare_parameter('waypoint_tolerance', 0.05)
        self.declare_parameter('settle_tolerance', 0.03)
        self.declare_parameter('settle_readings', 8)
        self.declare_parameter('settle_timeout', 2.0)
        self.declare_parameter('spray_timeout', 5.0)
        self.declare_parameter('stuck_timeout', 12.0)

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
        self.declare_parameter('antenna_cal_radius_m', 1.5)
        self.declare_parameter('antenna_cal_revolutions', 2)
        # `antenna_cal_sign` controls rotation direction: +1 CCW, -1 CW.
        # CCW is the default because that's what we've used in the field;
        # the solver supports both, so flip if site geometry requires.
        self.declare_parameter('antenna_cal_sign', 1)
        self.declare_parameter('antenna_cal_speed', 0.5)

        # Wheel scale auto-calibration (CAL_WHEELS state). Drives a
        # straight chord and divides GPS distance by per-wheel encoder
        # integration to recover the rolling-radius mismatch.
        self.declare_parameter('wheel_cal_distance', 10.0)
        self.declare_parameter('wheel_cal_speed', 0.5)
        self.declare_parameter('wheel_cal_max_distance', 15.0)

        # Estimator gains.
        self.declare_parameter('estimator_pos_gain', 0.30)
        self.declare_parameter('estimator_psi_gain', 0.08)
        self.declare_parameter('estimator_psi_min_speed', 1.5)
        self.declare_parameter('estimator_yaw_innov_gain', 0.10)
        self.declare_parameter('estimator_yaw_innov_min_speed', 0.3)

        # Safety.
        self.declare_parameter('gps_timeout', 3.0)
        self.declare_parameter('fix_hysteresis_s', 0.8)
        # Seconds the fix must hold continuously at required quality
        # AFTER recovery before NAVIGATING resumes. Without it, RTK
        # flapping (rtk_fixed ↔ rtk_float / 3d_fix within sub-second
        # windows, common in marginal sky-view) re-entered ERROR
        # almost instantly each time the navigator tried to resume.
        # LED still clears the moment fix is back so the operator
        # has live feedback; chassis just stays parked until the
        # fix has held long enough to trust.
        self.declare_parameter('fix_recovery_hold_s', 3.0)
        self.declare_parameter('required_fix_status', 'rtk_fixed')
        # When the live fix is rtk_float (integer ambiguity unresolved),
        # accept it as 'good enough' if reported hAcc is at or below this
        # many millimetres. 0 disables the float-accept escape hatch and
        # falls back to fixed-only behaviour. 20 mm chosen so float is
        # accepted only when its reported accuracy is within the
        # waypoint cm-tolerance budget — anything sloppier and the
        # mission errors out instead of plotting the antenna onto a
        # potentially-drifted estimate.
        self.declare_parameter('fix_accept_float_max_h_acc_mm', 0)
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
        # Latched (TRANSIENT_LOCAL, depth 1): nav/state is a CURRENT-STATE topic,
        # so a late-joining subscriber must get the last state immediately. The
        # perception node restarts independently (camera udev replug, auto-update)
        # and gates obstacle detection on this — without latching, a perception
        # restart mid-NAVIGATING would never see the (already-sent) state and
        # would silently leave detection off for the rest of the mission. A
        # TRANSIENT_LOCAL publisher is still compatible with the bridge's VOLATILE
        # subscriber (offered durability >= requested).
        state_qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                               durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self._pub_state = self.create_publisher(String, '/rover/nav/state', state_qos)
        reliable_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._pub_waypoint_reached = self.create_publisher(Int32, '/rover/nav/waypoint_reached', reliable_qos)
        self._pub_spray_result = self.create_publisher(String, '/rover/spray/result', reliable_qos)
        self._pub_spray_cancel = self.create_publisher(Int32, '/rover/spray/cancel', reliable_qos)
        self._pub_error_reason = self.create_publisher(String, '/rover/nav/error_reason', reliable_qos)
        self._pub_cal_antenna_result = self.create_publisher(String, '/rover/cal/antenna_result', reliable_qos)
        self._pub_cal_wheels_result = self.create_publisher(String, '/rover/cal/wheel_result', reliable_qos)
        self._pub_apply_wheel_scales = self.create_publisher(String, '/rover/cmd/apply_wheel_scales', reliable_qos)
        self._pub_apply_steering_trim = self.create_publisher(String, '/rover/cmd/apply_steering_trim', reliable_qos)
        # Surfaces the navigator's RTK-fix-lost halt to the MCU for the
        # LED_GPS_LOST orange-blink status indication. Edge-triggered:
        # published on entering ERROR with data=1, on exiting ERROR
        # back to NAVIGATING with data=0.
        self._pub_nav_fault = self.create_publisher(Int32, '/rover/cmd/nav_fault', reliable_qos)
        # Brake-pulse arm — published once when the navigator commits a
        # settle-on-target stop so mcu_bridge can send 'A' to the MCU.
        # All OTHER navigator stops (ERROR, state transitions, manual
        # overrides) leave this silent so they just coast.
        self._pub_brake_pulse = self.create_publisher(Empty, '/rover/cmd/brake_pulse', reliable_qos)

        # Subscribers.
        self.create_subscription(NavSatFix, '/rover/gps/position', self._on_gps, 10)
        self.create_subscription(Float64, '/rover/gps/heading', self._on_heading, 10)
        self.create_subscription(String, '/rover/gps/fix_status', self._on_fix_status, 10)
        self.create_subscription(String, '/rover/gps/metrics', self._on_gps_metrics, 10)
        self.create_subscription(String, '/rover/odom', self._on_odom, 10)
        self.create_subscription(String, '/rover/cmd/execute_path', self._on_execute_path, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/emergency_stop', self._on_emergency_stop, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/clear_emergency', self._on_clear_emergency, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/pause', self._on_pause, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/resume', self._on_resume, reliable_qos)
        # Obstacle detector (perception container) — a debounced Bool. A rising
        # edge while NAVIGATING auto-pauses the mission locally (no server round
        # trip), so the rover stops itself even during an uplink blip.
        self.create_subscription(Bool, '/rover/perception/obstacle', self._on_obstacle, reliable_qos)
        self.create_subscription(Empty, '/rover/spray/done', self._on_spray_done, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/calibrate_antenna', self._on_calibrate_antenna, reliable_qos)
        self.create_subscription(String, '/rover/cmd/set_antenna_offset', self._on_set_antenna_offset, reliable_qos)
        self.create_subscription(Empty, '/rover/cmd/calibrate_wheels', self._on_calibrate_wheels, reliable_qos)
        self.create_subscription(String, '/rover/battery', self._on_battery, 10)

        # ── runtime state ────────────────────────────────────────────────
        self._state = State.IDLE
        # Last value seen on /rover/perception/obstacle, for edge detection — we
        # auto-pause on the rising edge only, never re-pause on a held signal.
        self._obstacle_present = False
        self._waypoints = []           # original [{lat, lng}, ...] from operator
        self._segments = []            # planner output; len = 2 × len(waypoints) (+2 if return)
        self._cur_seg_idx = 0
        self._cur_wp_idx = 0           # last waypoint index whose dock segment we're tracking

        # Mission anchors.
        self._ref_lat = None           # ENU origin for the mission
        self._ref_lon = None
        self._mission_start_chassis_xy = None  # for return-to-start
        self._mission_start_antenna_xy = None   # ENU origin at mission trigger

        # GPS / odometry inputs.
        self._gps_lat = None
        self._gps_lon = None
        self._gps_heading_compass = None   # radians, 0=N, CW+
        self._gps_fix_status = 'no_fix'
        self._gps_speed = 0.0
        # Horizontal accuracy reported by u-blox (mm). Used by
        # _has_required_fix to accept rtk_float when h_acc is below the
        # configured threshold — float fixes are usable for short
        # missions when the reported accuracy is cm-scale.
        self._gps_h_acc_mm = None
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

        # Tracker (constructed from params; reused across segments).
        self._l1_tracker = None

        # Calibration state.
        self._cal_start_lat = None
        self._cal_start_lon = None
        self._cal_samples = []          # list of (e_enu, n_enu)
        self._cal_extended = False

        # Settling state.
        self._settle_count = 0
        self._settle_enter_time = 0.0
        # Settle retry counter — incremented each time the chassis falls
        # outside waypoint_tolerance during a SETTLING phase and we
        # re-engage L1Tracker to crawl back. No upper bound; the
        # settle_timeout above paces retries.
        self._settle_retries = 0

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
        # Timestamp when fix first returned to required quality while
        # in ERROR. Set by `_handle_error`, cleared on degradation or
        # successful resume. Drives the fix_recovery_hold_s hysteresis.
        self._fix_recovered_at = None

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

    def _has_required_fix(self):
        required = self.get_parameter('required_fix_status').value
        if has_required_fix_status(self._gps_fix_status, required):
            return True
        # Accept rtk_float when reported horizontal accuracy is below the
        # float-accept threshold. Float fixes have unresolved integer
        # ambiguities so their absolute drift can be metres over hours,
        # but for short missions (minutes) where h_acc stays below a
        # few cm the position is usable. 0 disables this acceptance —
        # i.e. behave as the legacy 'fixed only' gate.
        float_max_mm = self.get_parameter('fix_accept_float_max_h_acc_mm').value
        if (float_max_mm > 0
                and self._gps_fix_status == 'rtk_float'
                and self._gps_h_acc_mm is not None
                and self._gps_h_acc_mm <= float_max_mm):
            return True
        return False

    def _params_for_trackers(self):
        p = self.get_parameter
        return {
            'cruise_speed': p('cruise_speed').value,
            'approach_speed': p('approach_speed').value,
            'max_curvature': p('max_curvature').value,
            'l1_cm_capture_m': p('l1_cm_capture_m').value,
            'l1_brake_zone_m': p('l1_brake_zone_m').value,
            'l1_min_speed_m_s': p('l1_min_speed_m_s').value,
            'l1_kturn_enter_rad': p('l1_kturn_enter_rad').value,
            'l1_kturn_exit_rad': p('l1_kturn_exit_rad').value,
            'l1_kturn_exit_dist_m': p('l1_kturn_exit_dist_m').value,
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

    def _validate_waypoints(self, waypoints):
        if not isinstance(waypoints, list) or not waypoints:
            return None
        clean = []
        for wp in waypoints:
            if not isinstance(wp, dict):
                return None
            lat = wp.get('lat')
            lng = wp.get('lng')
            if not (isinstance(lat, (int, float))
                    and isinstance(lng, (int, float))
                    and isfinite(float(lat)) and isfinite(float(lng))
                    and -90.0 <= float(lat) <= 90.0
                    and -180.0 <= float(lng) <= 180.0):
                return None
            clean.append({'lat': float(lat), 'lng': float(lng)})
        return clean

    # ── input callbacks ──────────────────────────────────────────────────

    def _on_gps(self, msg):
        self._gps_lat = msg.latitude
        self._gps_lon = msg.longitude
        now = time.monotonic()
        self._last_gps_time = now
        if self._estimator is not None and self._estimator.initialized:
            # Run yaw-innovation correction BEFORE position correction so
            # the position pull uses the freshly-rotated antenna offset.
            # The yaw correction is the dominant chassis_psi source at
            # 0.3-1.5 m/s where heading-of-motion is too noisy to fuse.
            self._estimator.correct_position_with_yaw_innovation(
                msg.latitude, msg.longitude, now)
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
        h_acc = data.get('h_acc') if isinstance(data, dict) else None
        if isinstance(h_acc, (int, float)):
            self._gps_h_acc_mm = float(h_acc)

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
        waypoints = self._validate_waypoints(waypoints)
        if waypoints is None:
            self.get_logger().error('Invalid waypoint payload')
            return

        # Preempt guard: only accept new mission from IDLE / ERROR. Mid-
        # NAVIGATING/SETTLING/SPRAYING/CAL_* swap-and-restart leaves the
        # chassis cruising under the prior tracker for one tick and
        # anchors the new ENU origin at the moving rover, biasing the
        # CALIBRATING chord regression. Operator must explicitly stop
        # the active mission first. (CAL_ANTENNA / CAL_WHEELS already
        # apply this guard via their own callbacks; mirror it here for
        # consistency.)
        if self._state not in (State.IDLE, State.ERROR, State.PAUSED):
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
        self._l1_tracker = None
        self._set_state(State.EMERGENCY_STOP)

    def _on_clear_emergency(self, _msg):
        if self._state == State.EMERGENCY_STOP:
            self.get_logger().info('Emergency-stop cleared by operator')
            self._set_state(State.IDLE)

    # Mission states from which a soft pause is meaningful — the rover is driving
    # (or parked at a cone) under autonomy. CALIBRATING is excluded: it runs
    # before the L1 tracker / segments exist, so there is nothing to resume into
    # (a pause there should be an E-Stop instead).
    _PAUSABLE_STATES = (State.NAVIGATING, State.SETTLING, State.SPRAYING)

    def _on_pause(self, _msg):
        """Soft-pause the mission: hold position, keep the plan, allow manual.

        Unlike E-Stop this does NOT latch the MCU, so the operator can drive
        the rover manually (e.g. around an obstacle) while paused. The L1
        tracker is preserved; resume re-acquires from the current pose.
        """
        if self._state not in self._PAUSABLE_STATES:
            self.get_logger().warn(
                f'pause ignored: state={self._state.value} (not a pausable mission state)'
            )
            return
        # Abort an in-flight dispense WITHOUT entering EMERGENCY_STOP — publish a
        # targeted cancel so spray_node drops the cycle and we don't emit a stale
        # 'success'. (emergency_stop would latch the MCU and block manual.)
        if self._state == State.SPRAYING and self._cur_wp_idx >= 0:
            cancel = Int32()
            cancel.data = int(self._cur_wp_idx)
            self._pub_spray_cancel.publish(cancel)
        self._stop_motors()
        self.get_logger().info(f'Mission paused (from {self._state.value})')
        self._set_state(State.PAUSED)

    def _on_resume(self, _msg):
        """Resume a paused mission, re-planning from the live chassis pose.

        Mirrors the ERROR-recovery resume (see _handle_error): the operator may
        have driven the rover manually while paused, and the pause may have
        lasted arbitrarily long, so we (1) reset the wall-clock timers that ran
        through the hold — otherwise stuck/settle/spray timeouts fire on the
        first tick — (2) reset the tracker's D/I terms, and (3) replan the
        remaining segments from the current pose so the rover doesn't track the
        stale dock corridor (which would trip the dock reverse-recovery latch).
        """
        if self._state != State.PAUSED:
            return
        # (_set_state(NAVIGATING) below re-arms the obstacle edge.)
        now = time.monotonic()
        self._settle_enter_time = now
        self._spray_enter_time = now
        self._last_progress_time = now
        self._last_progress_dist = float('inf')
        if self._l1_tracker is not None:
            self._l1_tracker.reset()
        self.get_logger().info('Mission resumed by operator')
        self._set_state(State.NAVIGATING)
        self._replan_from_current_chassis()

    def _on_obstacle(self, msg):
        """Perception flagged a corridor obstacle — auto-pause if driving.

        Edge-triggered: only the False→True transition acts, so a held signal
        won't repeatedly re-pause. We gate strictly on NAVIGATING — SETTLING and
        SPRAYING are stationary at a cone (no collision risk), and pausing from
        there would be spurious. Reuses _on_pause so the obstacle pause is
        identical to an operator pause (manual driving stays enabled); the
        operator clears it by driving around and pressing resume.
        """
        present = bool(msg.data)
        rising = present and not self._obstacle_present
        self._obstacle_present = present
        if not rising:
            return
        if self._state != State.NAVIGATING:
            self.get_logger().info(
                f'obstacle signal ignored: state={self._state.value} (not driving)')
            return
        self.get_logger().warn('AUTO-PAUSE: obstacle detected in driving corridor')
        self._on_pause(None)

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
        if not (OFFSET_MIN_FORWARD_M <= a_x <= OFFSET_BOUND_M
                and -OFFSET_BOUND_M <= a_y <= OFFSET_BOUND_M):
            self._publish_cal_antenna_result(
                ok=False,
                reason=(f'offset out of bounds ({a_x:.2f}, {a_y:.2f}) — '
                        f'a_x must be {OFFSET_MIN_FORWARD_M:.2f}..{OFFSET_BOUND_M:.1f} m '
                        f'and a_y within ±{OFFSET_BOUND_M:.1f} m'),
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
            State.SPRAYING, State.CAL_ANTENNA, State.CAL_WHEELS,
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

        if self._state in (State.IDLE, State.EMERGENCY_STOP, State.PAUSED):
            # Keep republishing Twist(0,0) every tick so mcu_bridge's
            # accel-limit ramp can decay any residual speed smoothly to a
            # stop. Without this, the single zero-twist published on
            # state-machine transitions would only step the speed down
            # by accel_limit · 50 ms and leave the rover coasting at
            # whatever the ramp landed on (the original "끝나도 계속
            # 직진" symptom). Manual control is unaffected — mcu_bridge
            # ignores autonomous Twists during the manual_priority_s
            # window after the operator's last joystick input. PAUSED
            # relies on exactly that: the operator can drive manually
            # (it is not an autonomous state) while these zero-twists
            # hold the chassis whenever the joystick is released.
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
        now = time.monotonic()
        fix_ok = (
            now - self._last_gps_time < gps_timeout
            and self._gps_lat is not None
            and self._has_required_fix()
        )
        if fix_ok:
            # Edge-trigger LED clear on the FIRST moment fix is back —
            # operator sees the orange-blink stop instantly even though
            # the chassis won't resume until the recovery has held for
            # `fix_recovery_hold_s` seconds. RTK fixes around the
            # 14:22 / 15:15 / 15:16 missions flapped between fixed and
            # float multiple times per second; without the hold we'd
            # re-enter ERROR within 1-2 ticks of resuming.
            if self._fix_recovered_at is None:
                self._fix_recovered_at = now
                fault = Int32()
                fault.data = 0
                self._pub_nav_fault.publish(fault)
            hold = self.get_parameter('fix_recovery_hold_s').value
            if now - self._fix_recovered_at < hold:
                return  # hold position, LED already cleared
            if self._pre_error_state is not None:
                self.get_logger().info(
                    f'GPS recovered (held {hold:.1f}s), resuming '
                    f'{self._pre_error_state.value}'
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
                # SPRAYING is a safety-gated state too; without resetting its
                # timer the resumed spray would see the pre-outage start time
                # and fire spray_timeout immediately (false 'timeout' + skip).
                self._spray_enter_time = now
                self._last_progress_time = now
                self._last_progress_dist = float('inf')
                if self._l1_tracker is not None:
                    self._l1_tracker.reset()
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
                self._fix_recovered_at = None
                if resume_state == State.NAVIGATING:
                    self._replan_from_current_chassis()
            else:
                self._set_state(State.IDLE)
        else:
            # Fix degraded again before the hold elapsed. If the LED
            # had been cleared on the previous recovery, re-light it
            # so the operator can see the fix lost again. Edge-trigger
            # via _fix_recovered_at: only publish on the recovery →
            # degrade transition, not every tick.
            if self._fix_recovered_at is not None:
                fault = Int32()
                fault.data = 1
                self._pub_nav_fault.publish(fault)
            self._fix_recovered_at = None

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
            yaw_innov_gain=self.get_parameter('estimator_yaw_innov_gain').value,
            yaw_innov_min_speed=self.get_parameter('estimator_yaw_innov_min_speed').value,
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
        self._mission_start_antenna_xy = (0.0, 0.0)

        # Plan path now that chassis pose is known.
        params = self._params_for_trackers()
        try:
            self._segments = plan_path(
                current_chassis_pose=self._estimator.chassis_pose(),
                antenna_offset=(params['antenna_offset_x'], params['antenna_offset_y']),
                waypoints_lat_lng=self._waypoints,
                ref_lat_lon=(self._ref_lat, self._ref_lon),
                return_to_start=self.get_parameter('return_to_start').value,
                start_chassis_xy=self._mission_start_chassis_xy,
                start_antenna_xy=self._mission_start_antenna_xy,
            )
            self._cur_seg_idx = 0
            self._cur_wp_idx = 0
            # L1Tracker.__init__ raises on a bad antenna offset; keep it inside
            # the try so a bad offset fails the mission gracefully (ERROR +
            # stop) instead of crashing the 20 Hz control-loop timer callback.
            self._l1_tracker = L1Tracker(params)
            self._l1_tracker.reset()
        except Exception as exc:  # pragma: no cover - defensive
            self._stop_motors()
            self._set_error(f'Path planning failed: {exc}')
            return
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

        v, kappa, status = self._l1_tracker.step(
            chassis_pose, seg, time.monotonic(), antenna_world)
        self._publish_velocity(v, kappa)
        self._update_progress(chassis_pose, seg.end_pose)

        now_mono = time.monotonic()
        if (self._last_dock_trace_t is None
                or now_mono - self._last_dock_trace_t >= 1.0):
            self._last_dock_trace_t = now_mono
            cx, cy, cpsi = chassis_pose
            ax, ay = antenna_world
            tx, ty = seg.target_antenna
            bearing = atan2(ty - ay, tx - ax)
            eta = normalize_angle(bearing - cpsi)
            dist = hypot(tx - ax, ty - ay)
            self.get_logger().info(
                f'L1 WP{seg.waypoint_index + 1} '
                f'ch=({cx:+.2f},{cy:+.2f},{degrees(cpsi):+.0f}°) '
                f'ant=({ax:+.2f},{ay:+.2f}) tgt=({tx:+.2f},{ty:+.2f}) '
                f'eta={degrees(eta):+.1f}° dist={dist*100:.1f}cm '
                f'cmd v={v:+.2f} k={kappa:+.2f} {status}'
            )

        if status == 'reached':
            if self._cur_wp_idx != seg.waypoint_index:
                self._settle_retries = 0
            self._cur_wp_idx = seg.waypoint_index
            # Arm the MCU brake pulse for the imminent V 0 0. This is the
            # ONLY navigator stop that brakes — other stop sites (ERROR,
            # state transitions, etc.) just coast. The MCU's arm window
            # expires after ~1 s so we publish unconditionally here even
            # if a previous settle hadn't actually moved on yet.
            self._pub_brake_pulse.publish(Empty())
            self._stop_motors()
            self._settle_count = 0
            self._settle_enter_time = time.monotonic()
            self._set_state(State.SETTLING)
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
        # (a) chassis pinned: hasn't moved more than 30 cm in the
        #     stuck_timeout window — actual stuck (dock reverse cycle,
        #     wheel slip, etc.).
        # (b) no-progress timeout: dist-to-target hasn't decreased by
        #     ≥2 cm in stuck_timeout seconds even though chassis is
        #     moving. This catches genuine wedged geometry but also
        #     fires on legitimate orbit-around-tight-goal cases. The
        #     cruise tracker's past-entry / orbit-gate exits should
        #     prevent those from ever entering this branch in the
        #     first place, but we keep the gate for safety.
        bbox_disp = 0.0
        if len(self._stuck_window) >= 2:
            xs = [r[1] for r in self._stuck_window]
            ys = [r[2] for r in self._stuck_window]
            bbox_disp = hypot(max(xs) - min(xs), max(ys) - min(ys))
        chassis_pinned = (
            len(self._stuck_window) >= 2
            and (now - self._stuck_window[0][0]) >= timeout
            and bbox_disp < 0.30
        )

        if not chassis_pinned and now - self._last_progress_time < timeout:
            return

        self._stuck_retries += 1
        wp_idx = self._segments[self._cur_seg_idx].waypoint_index if self._cur_seg_idx < len(self._segments) else -1
        gate = 'displacement' if chassis_pinned else 'no-progress'

        self.get_logger().warn(
            f'Stuck on segment {self._cur_seg_idx} (waypoint {wp_idx + 1}) '
            f'retry {self._stuck_retries} '
            f'gate={gate} bbox_disp={bbox_disp*100:.1f}cm — '
            f'resetting tracker and replanning from current chassis pose'
        )
        # NEVER skip. The operator's stated policy: every waypoint
        # gets sprayed. Reset the tracker (clears K-turn latch) and
        # replan from the live chassis pose so the next attempt uses
        # fresh geometry. Only emergency_stop ends the mission.
        if self._l1_tracker is not None:
            self._l1_tracker.reset()
        self._reset_progress()
        self._replan_from_current_chassis()

    def _replan_from_current_chassis(self):
        """Rebuild self._segments anchored at the chassis's live pose.

        Called from stuck / reverse-stalled / settle-timeout / ERROR
        recovery. The planner originally laid out cruise/dock segments
        under the assumption the chassis would be at each dock-end before
        transitioning to the next cruise. If that assumption breaks
        (chassis stuck off-corridor, estimator hard-corrected past the
        target after RTK reacquire), we regenerate the remaining segments
        using the actual chassis pose as the next cruise's start. The
        waypoint index offset keeps the new segments numbered against
        the original `self._waypoints` list so any consumer of
        seg.waypoint_index (settle handler, telemetry) sees the same
        indices it saw before the replan.
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
        # Anchor the first replanned waypoint's dock_psi on the bearing
        # FROM the previously sprayed waypoint, not from the live chassis
        # pose. Without this, each replan re-derives dock_psi from
        # chassis-to-WP, so a chassis that drifted past the target spins
        # the corridor around it on every retry (14:03 WP5: dock_psi
        # rotated -105°→-87°→-150°→+175° across 4 replans). Keeping the
        # original WP_{n-1} → WP_n bearing preserves the corridor.
        prev_xy = None
        if next_wp_idx > 0:
            prev_wp = self._waypoints[next_wp_idx - 1]
            prev_xy = enu_from_gps(
                prev_wp['lat'], prev_wp['lng'],
                self._ref_lat, self._ref_lon,
            )
        params = self._params_for_trackers()
        try:
            new_segments = plan_path(
                current_chassis_pose=self._estimator.chassis_pose(),
                antenna_offset=(params['antenna_offset_x'], params['antenna_offset_y']),
                waypoints_lat_lng=remaining,
                ref_lat_lon=(self._ref_lat, self._ref_lon),
                return_to_start=self.get_parameter('return_to_start').value,
                start_chassis_xy=self._mission_start_chassis_xy,
                start_antenna_xy=self._mission_start_antenna_xy,
                waypoint_index_offset=next_wp_idx,
                prev_target_xy=prev_xy,
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

        # The settle gate is on RAW GPS antenna position, not the
        # estimator's fused antenna_position(). At a standstill the
        # estimator converges to GPS within ~1 s of corrections, so the
        # two are close in practice — but the estimator's antenna can
        # carry a heading-drift × antenna-offset bias (psi error rotates
        # the body-frame offset into a lateral offset in ENU; with the
        # 0.30 m antenna_offset_x, a 20° psi error becomes ~10 cm of
        # apparent lateral error in antenna_position()). Sourcing the
        # gate directly from the freshly-measured RTK antenna makes the
        # gate semantics match what the operator reads ("3 cm of the
        # GPS target") and removes that bias entirely.
        gps_timeout = self.get_parameter('gps_timeout').value
        gps_fresh = (
            self._gps_lat is not None
            and self._ref_lat is not None
            and (time.monotonic() - self._last_gps_time) < gps_timeout
            and self._has_required_fix()
        )
        if not gps_fresh:
            # No usable raw fix this tick — don't sample the gate, and
            # don't let settle_count carry over from earlier fresh
            # readings. settle_timeout still ticks and will retry/skip
            # if the outage persists.
            self._settle_count = 0
            self._stop_motors()
            return

        antenna_e, antenna_n = enu_from_gps(
            self._gps_lat, self._gps_lon, self._ref_lat, self._ref_lon)
        target_e, target_n = self._segments[self._cur_seg_idx].target_antenna
        dist = hypot(target_e - antenna_e, target_n - antenna_n)

        wp_tol = self.get_parameter('waypoint_tolerance').value
        settle_tol = self.get_parameter('settle_tolerance').value
        settle_readings = self.get_parameter('settle_readings').value
        settle_timeout = self.get_parameter('settle_timeout').value

        # Diagnostic: also log the estimator's antenna at the moment of
        # timeout so a divergence between RTK and the estimator can be
        # pinpointed (heading-drift bias, antenna_offset error, etc.).
        # `dist` is the raw-GPS distance the gate actually uses.
        if time.monotonic() - self._settle_enter_time > settle_timeout:
            cx, cy, cpsi = self._estimator.chassis_pose()
            est_e, est_n = self._estimator.antenna_position()
            self.get_logger().info(
                f'WP{self._cur_wp_idx + 1} timeout diag: '
                f'chassis=({cx:.3f}, {cy:.3f}, {degrees(cpsi):.1f}°) '
                f'ant_gps=({antenna_e:.3f}, {antenna_n:.3f}) '
                f'ant_est=({est_e:.3f}, {est_n:.3f}) '
                f'target=({target_e:.3f}, {target_n:.3f}) '
                f'dist_gps={dist*100:.1f}cm '
                f'dist_est={hypot(target_e-est_e, target_n-est_n)*100:.1f}cm'
            )
            # Don't spray on a moving target. If the antenna is currently
            # outside waypoint_tolerance (still in re-approach via the
            # dock tracker), skip the waypoint instead of firing spray
            # at whatever drifted position we happen to be at. Settling
            # included time spent re-tracking, so a bouncy antenna can
            # exhaust the budget while still moving.
            if dist > wp_tol:
                # In 'l1' mode, never replan from a settle timeout.
                # plan()-from-just-past-target is broken: dock_entry
                # is floored 60 cm behind chassis along the new
                # corridor, forcing a U-turn the forward-only L1
                # cannot make → wide orbit, divergence (15:24 WP1
                # trace: 7 cm → 161 cm spiral away). The correct
                # response is to let L1's internal reverse-recovery
                # cycle the chassis back behind the target and
                # re-approach. Any antenna→target distance beyond
                # waypoint_tolerance (3 cm) is a miss — the chassis
                # retries until it lands within cm_capture or the
                # mission is stopped. No widened spray tolerance.
                self.get_logger().warn(
                    f'Settle timeout WP{self._cur_wp_idx + 1} '
                    f'(dist={dist*100:.1f} cm > '
                    f'{wp_tol*100:.0f} cm) — re-engaging L1 '
                    'reverse-recovery'
                )
                self._settle_count = 0
                self._settle_retries = 0
                if self._l1_tracker is not None:
                    self._l1_tracker.reset()
                self._reset_progress()
                self._set_state(State.NAVIGATING)
                return
            self.get_logger().info(
                f'Settle timeout at waypoint {self._cur_wp_idx + 1} '
                f'(dist={dist*100:.1f} cm <= wp_tol), proceeding to spray'
            )
            self._trigger_spray()
            return

        if dist > wp_tol:
            # L1Tracker handles convergence internally — the navigator
            # holds position here while the SETTLING timeout above
            # decides whether to retry or accept.
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
        # using L1Tracker. This catches small GPS drift mid-spray
        # without leaving SPRAYING.
        if self._estimator is None or self._cur_seg_idx >= len(self._segments) \
                or self._l1_tracker is None:
            self._stop_motors()
            return
        seg = self._segments[self._cur_seg_idx]
        antenna_e, antenna_n = self._estimator.antenna_position()
        target_e, target_n = seg.target_antenna
        dist = hypot(target_e - antenna_e, target_n - antenna_n)
        if dist > self.get_parameter('waypoint_tolerance').value:
            v, kappa, _ = self._l1_tracker.step(
                self._estimator.chassis_pose(), seg,
                time.monotonic(),
                (antenna_e, antenna_n),
            )
            # Position-hold during spray only nulls out small FORWARD drift.
            # A reverse command means L1 entered its K-turn (v = -approach) to
            # rebuild a standoff — correct while NAVIGATING, but here it would
            # drive the rover backward off the cone mid-dispense. That is easy
            # to trigger: within a few cm of target the antenna→target bearing
            # is very noise-sensitive, so RTK jitter spikes |eta| past the 60°
            # K-turn threshold. Hold instead of reversing; a genuinely lost
            # dock is handled by the settle/spray timeouts, not by backing up
            # while the pump is running.
            if v < 0:
                self._stop_motors()
            else:
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
        # Move past the segment of the current waypoint.
        if self._cur_seg_idx < len(self._segments):
            self._cur_seg_idx += 1
        self._stuck_retries = 0
        self._reset_progress()
        if self._l1_tracker is not None:
            self._l1_tracker.reset()

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
            leaving_error = (self._state == State.ERROR and new_state != State.ERROR)
            if new_state == State.NAVIGATING:
                # Entering a driving leg — re-arm the obstacle rising-edge so a
                # stale-True can't suppress the next auto-pause. Covers resume,
                # new mission, segment advance (SETTLING/SPRAYING→NAVIGATING), and
                # ERROR recovery — any case where perception may have missed
                # publishing the clearing False (restart / timing).
                self._obstacle_present = False
            self._state = new_state
            self._publish_state()
            if leaving_error:
                # Clear the MCU's LED_GPS_LOST indicator now that we're
                # back out of ERROR. _set_error publishes data=1 on
                # entry; here we publish data=0 on exit so the flag is
                # edge-triggered both directions.
                fault = Int32()
                fault.data = 0
                self._pub_nav_fault.publish(fault)

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
        # Light the MCU's LED_GPS_LOST (orange blink) so the operator
        # has a hardware indication that the chassis is halted for an
        # RTK / GPS quality reason. _set_state below stops motors;
        # this just labels the cause.
        fault = Int32()
        fault.data = 1
        self._pub_nav_fault.publish(fault)
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
