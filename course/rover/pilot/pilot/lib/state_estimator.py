"""Chassis pose estimator.

Fuses three sources to track the chassis (rear-axle) pose at 20 Hz:
  - MCU encoder odometry → chassis (v, ω). Predicts pose between GPS fixes.
  - GPS antenna position → corrects (x, y). Antenna offset is removed by
    subtracting R(ψ)·(a_x, a_y) — the rigid-body link to the chassis.
  - GPS heading-of-motion → corrects ψ. The reported angle is the antenna's
    velocity vector direction, which differs from chassis ψ when the chassis
    is turning (because the antenna swings sideways through R·(a_x, a_y)).
    We undo that by subtracting `atan2(ω·a_x, v - ω·a_y)` before fusing.

All internal angles are in math frame (0 = East, CCW positive). The GPS
boundary converts compass bearings via geo_utils.compass_to_math.

The estimator is intentionally a complementary filter rather than a full EKF:
  - GPS position and antenna offset are the dominant accuracies (cm-level).
  - Encoder slip on the rover platform is small over a sub-second prediction.
  - A scalar gain per channel is enough to track within a few cm and stay
    stable under brief GPS dropouts (covered by gps_timeout in navigator).
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
                 psi_correction_gain=0.05,
                 psi_correction_min_speed=0.4):
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

        self.x = 0.0
        self.y = 0.0
        self.psi = 0.0
        self.initialized = False

        # Last commanded chassis kinematics (used to invert the antenna
        # offset effect when we receive a GPS heading-of-motion).
        self._last_v = 0.0
        self._last_omega = 0.0
        self._last_predict_t = None

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

    def correct_position(self, antenna_lat, antenna_lon):
        """Pull chassis (x, y) toward GPS antenna observation.

        The antenna-to-chassis vector is rigid; a delta on antenna position
        applies 1:1 to chassis position. We don't change ψ here because
        rotational error shows up as an apparent translation only when the
        antenna offset is non-zero, and unwinding it from a single position
        sample is poorly conditioned. Heading is corrected separately.
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

    def antenna_offset_world(self, psi=None):
        """Return the antenna→chassis offset in world frame for a given ψ."""
        if psi is None:
            psi = self.psi
        cp, sp = cos(psi), sin(psi)
        return cp * self.a_x - sp * self.a_y, sp * self.a_x + cp * self.a_y
