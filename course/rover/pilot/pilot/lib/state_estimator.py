"""Chassis pose estimator.

Fuses four sources to track the chassis (rear-axle) pose at 20 Hz:
  - MCU encoder odometry → chassis (v, ω). Predicts pose between GPS fixes.
    Encoder yaw rate ω = (v_right − v_left) / track_width is the PRIMARY
    chassis_psi source (σ_ω ≈ 0.06 rad/s, two orders of magnitude better
    than GPS heading-of-motion at low speed).
  - GPS antenna position → corrects (x, y). Antenna offset is removed by
    subtracting R(ψ)·(a_x, a_y) — the rigid-body link to the chassis.
  - GPS position innovation → corrects ψ. After encoder DR predicts the
    antenna's position, the GPS measurement reveals a residual. The
    component PERPENDICULAR to the current chassis heading is mostly
    attributable to a ψ estimation error (lateral DR drift is a yaw
    error multiplied by arc length). This is the ArduPilot EKF3 pattern
    for single-antenna RTK rovers without an IMU — and it's why the
    chassis_psi stays clean even at speeds where GPS heading-of-motion
    is too noisy to fuse directly.
  - GPS heading-of-motion → slow ψ drift correction at HIGH speed only
    (≥ psi_correction_min_speed). At low speed (<1.5 m/s) the displacement
    between consecutive fixes is small enough that atan2(dy, dx) carries
    ±10°+ noise; we don't fuse those readings at all.

All internal angles are in math frame (0 = East, CCW positive). The GPS
boundary converts compass bearings via geo_utils.compass_to_math.

The estimator is intentionally a complementary filter rather than a full
EKF — separate scalar gains per observation channel, each gated by signal
quality. Sufficient because (a) GPS RTK position is cm-accurate, (b) wheel
encoders are mm-resolution, (c) the position-innovation ψ correction
closes the only remaining gap (yaw drift without an IMU). This matches
ArduPilot Rover's encoder-only EKF3 configuration on commercial RTK rover
platforms.
"""

from math import cos, sin, atan2, hypot

from pilot.lib.geo_utils import (
    enu_from_gps, compass_to_math, normalize_angle,
)


class ChassisPoseEstimator:
    """Tracks chassis (x, y, ψ) in ENU around a reference lat/lon.

    Reference point is fixed at the first `set_initial` call so a mission
    runs in a single linearised frame; ENU error stays sub-cm out to ~1 km.
    """

    def __init__(self, antenna_offset_x, antenna_offset_y,
                 ref_lat, ref_lon,
                 pos_correction_gain=0.3,
                 psi_correction_gain=0.08,
                 psi_correction_min_speed=1.5,
                 yaw_innov_gain=0.10,
                 yaw_innov_min_speed=0.3,
                 yaw_innov_max_step_rad=0.087):
        self.a_x = float(antenna_offset_x)
        self.a_y = float(antenna_offset_y)
        self.ref_lat = float(ref_lat)
        self.ref_lon = float(ref_lon)
        self.pos_gain = float(pos_correction_gain)
        self.psi_gain = float(psi_correction_gain)
        # GPS heading-of-motion is noise-dominated below this speed.
        # gps_node's publish gate (heading_speed_threshold in rover_params)
        # is aligned to the same value so we don't accept reports gps_node
        # has already discarded as noisy.
        self.psi_min_speed = float(psi_correction_min_speed)
        # Position-innovation ψ correction parameters. Below
        # yaw_innov_min_speed the lateral component of the position
        # innovation is too noise-dominated (small DR arc, large
        # 1 cm RTK noise band) to extract a usable ψ correction.
        # max_step caps |Δψ| per fix to stay in the small-angle regime —
        # bigger jumps suggest a slip event, not pure ψ drift.
        self.yaw_innov_gain = float(yaw_innov_gain)
        self.yaw_innov_min_speed = float(yaw_innov_min_speed)
        self.yaw_innov_max_step = float(yaw_innov_max_step_rad)

        self.x = 0.0
        self.y = 0.0
        self.psi = 0.0
        self.initialized = False

        # Last commanded chassis kinematics (used to invert the antenna
        # offset effect when we receive a GPS heading-of-motion).
        self._last_v = 0.0
        self._last_omega = 0.0
        self._last_predict_t = None
        # Wall-clock of the previous GPS fix correction (any kind).
        # Used by correct_position_with_yaw_innovation to compute the
        # DR arc length over which the lateral residual accumulated.
        self._last_gps_t = None

    # ── initialization ────────────────────────────────────────────────────

    def set_initial(self, antenna_lat, antenna_lon, psi_math):
        """Seed the chassis pose from a known antenna fix and chassis yaw.

        Used after cold-start calibration determines ψ from a straight-line
        drive (so antenna velocity direction = chassis ψ).
        """
        e, n = enu_from_gps(antenna_lat, antenna_lon, self.ref_lat, self.ref_lon)
        cp, sp = cos(psi_math), sin(psi_math)
        ox = cp * self.a_x - sp * self.a_y
        oy = sp * self.a_x + cp * self.a_y
        self.x = e - ox
        self.y = n - oy
        self.psi = normalize_angle(psi_math)
        self.initialized = True
        self._last_predict_t = None
        self._last_gps_t = None

    # ── prediction (encoder-driven) ──────────────────────────────────────

    def predict(self, v, omega, t_now):
        """Integrate chassis kinematics over the elapsed time.

        v: chassis longitudinal speed (m/s, signed).
        omega: chassis yaw rate (rad/s, math frame: CCW positive).
        t_now: monotonic seconds.

        First call seeds the timer without integrating; subsequent calls
        use trapezoidal integration with the previous (v, ω). Skips
        integration for dt <= 0 or > 0.5 s (sensor stall / clock jump).
        """
        if not self.initialized:
            return
        if self._last_predict_t is None:
            self._last_predict_t = t_now
            self._last_v = v
            self._last_omega = omega
            return
        dt = t_now - self._last_predict_t
        self._last_predict_t = t_now
        if dt <= 0.0 or dt > 0.5:
            self._last_v = v
            self._last_omega = omega
            return
        avg_v = 0.5 * (self._last_v + v)
        avg_om = 0.5 * (self._last_omega + omega)
        # Mid-point heading for the integration interval — matches a
        # second-order Runge-Kutta and stays accurate at ω up to ~2 rad/s
        # at 20 Hz dt.
        mid_psi = self.psi + 0.5 * avg_om * dt
        self.x += avg_v * cos(mid_psi) * dt
        self.y += avg_v * sin(mid_psi) * dt
        self.psi = normalize_angle(self.psi + avg_om * dt)
        self._last_v = v
        self._last_omega = omega

    # ── corrections (GPS-driven) ─────────────────────────────────────────

    def correct_position_with_yaw_innovation(self, antenna_lat, antenna_lon, t_now):
        """Recover chassis ψ from the GPS position innovation.

        The chassis dead-reckons antenna position from (x, y, ψ) and the
        antenna offset. If ψ is slightly off, the encoder DR moves the
        predicted antenna into the wrong direction over the inter-GPS
        interval, and the actual GPS measurement reveals a lateral
        residual perpendicular to the chassis heading. The size of that
        residual divided by the DR arc length is the ψ error.

        This is the position-innovation-derived yaw observation that
        ArduPilot EKF3 uses on encoder-only ground rovers. Without it,
        single-antenna RTK + encoders cannot resolve yaw at low speed
        (GPS heading-of-motion is too noisy below ~1.5 m/s for direct
        fusion). With it, yaw stays clean down to 0.3 m/s.

        Call this BEFORE `correct_position` on each GPS fix so the
        subsequent position pull uses the freshly-rotated antenna
        offset. ``t_now`` is the monotonic clock at the GPS fix; the
        first call seeds the timer without applying any correction.
        """
        if not self.initialized:
            return
        if self._last_gps_t is None:
            self._last_gps_t = t_now
            return
        dt = t_now - self._last_gps_t
        self._last_gps_t = t_now
        # Need a meaningful arc length to convert lateral residual into
        # a ψ correction. At creep speed (0.10 m/s) over 0.1 s the arc
        # is only 1 cm — comparable to the RTK position noise band, so
        # the ψ correction would be dominated by position noise rather
        # than ψ error. Skip below the speed gate.
        if abs(self._last_v) < self.yaw_innov_min_speed:
            return
        if dt <= 0.0 or dt > 0.5:
            return

        e_meas, n_meas = enu_from_gps(
            antenna_lat, antenna_lon, self.ref_lat, self.ref_lon,
        )
        cp, sp = cos(self.psi), sin(self.psi)
        ox = cp * self.a_x - sp * self.a_y
        oy = sp * self.a_x + cp * self.a_y
        a_pred_x = self.x + ox
        a_pred_y = self.y + oy
        inn_e = e_meas - a_pred_x
        inn_n = n_meas - a_pred_y

        # Component of the innovation in the chassis +LEFT direction
        # (perpendicular to heading, math frame: rotate +90° CCW).
        # A chassis whose ψ estimate is too small leaves the antenna
        # predicted to the RIGHT of where it actually is, observed as
        # +lateral innovation → ψ should increase (rotate CCW).
        lat_inn = -sp * inn_e + cp * inn_n

        # DR arc length over the inter-fix interval. Use commanded
        # speed magnitude × dt — accurate to better than 1 % for the
        # small (<200 ms) intervals we deal with. Floor at 5 cm so we
        # don't divide by a tiny arc and amplify position noise into
        # a wild ψ jump.
        arc = max(abs(self._last_v) * dt, 0.05)
        dpsi = lat_inn / arc
        if dpsi > self.yaw_innov_max_step:
            dpsi = self.yaw_innov_max_step
        elif dpsi < -self.yaw_innov_max_step:
            dpsi = -self.yaw_innov_max_step

        self.psi = normalize_angle(self.psi + self.yaw_innov_gain * dpsi)

    def correct_position(self, antenna_lat, antenna_lon):
        """Pull chassis (x, y) toward GPS antenna observation.

        The antenna-to-chassis vector is rigid; a delta on antenna position
        applies 1:1 to chassis position. We don't change ψ here because
        rotational error shows up as an apparent translation only when the
        antenna offset is non-zero, and unwinding it from a single position
        sample is poorly conditioned. Heading is corrected separately —
        either via correct_position_with_yaw_innovation (position-residual
        based, low-speed dominant) or correct_heading (heading-of-motion
        based, high-speed only).
        """
        if not self.initialized:
            return
        e_meas, n_meas = enu_from_gps(
            antenna_lat, antenna_lon, self.ref_lat, self.ref_lon,
        )
        cp, sp = cos(self.psi), sin(self.psi)
        ox = cp * self.a_x - sp * self.a_y
        oy = sp * self.a_x + cp * self.a_y
        a_pred_x = self.x + ox
        a_pred_y = self.y + oy
        inn_x = e_meas - a_pred_x
        inn_y = n_meas - a_pred_y
        self.x += self.pos_gain * inn_x
        self.y += self.pos_gain * inn_y

    def correct_heading(self, heading_compass_rad, ground_speed_mps):
        """Pull ψ toward the chassis heading implied by GPS heading-of-motion.

        GPS reports the antenna's velocity vector direction, which equals:
            ψ_chassis + atan2(ω · a_x, v - ω · a_y)
        when the chassis moves at (v, ω) at the rear axle. We subtract the
        offset term using the most recent commanded (v, ω) to recover the
        chassis ψ implied by the reading. At low speed we skip — the
        offset term is well-defined but heading-of-motion itself is noise
        at <0.4 m/s.
        """
        if not self.initialized:
            return
        if abs(ground_speed_mps) < self.psi_min_speed:
            return
        v = self._last_v
        om = self._last_omega
        denom = v - om * self.a_y
        # If the linearised denominator collapses (very tight reverse or
        # zero net forward), skip this correction rather than feed a wild
        # atan2.
        if abs(denom) < 0.05:
            return
        offset_angle = atan2(om * self.a_x, denom)
        psi_meas = compass_to_math(heading_compass_rad) - offset_angle
        delta = normalize_angle(psi_meas - self.psi)
        self.psi = normalize_angle(self.psi + self.psi_gain * delta)

    # ── readouts ─────────────────────────────────────────────────────────

    def chassis_pose(self):
        return self.x, self.y, self.psi

    def antenna_position(self):
        cp, sp = cos(self.psi), sin(self.psi)
        return (
            self.x + cp * self.a_x - sp * self.a_y,
            self.y + sp * self.a_x + cp * self.a_y,
        )
