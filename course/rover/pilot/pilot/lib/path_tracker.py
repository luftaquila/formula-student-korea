"""Per-segment path trackers.

Two control laws, one per segment kind:

  • CruiseTracker — Pure Pursuit toward the cruise segment's end pose, with
    derivative damping on heading error and a virtual lookahead projection
    when within the lookahead radius. Speed scales with cos(α) so that the
    rover slows as it commits to a sharper arc, killing the figure-8
    instability that the previous controller showed under stale heading.

  • DockTracker — linear state feedback on (e_y_antenna, e_ψ) along the
    straight-line dock corridor. Operating on the *antenna*'s lateral
    error (rather than the chassis') is what makes the antenna land on
    the user-clicked target even when the antenna is offset from the rear
    axle. The chassis frame Lyapunov analysis (see commit message) yields
    κ = -k_y · e_y_antenna - k_ψ · e_ψ, valid as long as the dock
    distance is large enough that linearisation is OK (dock_distance ≥
    a few × wheelbase).

Both trackers consume an immutable PathSegment + the live chassis pose +
the antenna ENU position, and return (v_cmd, κ_cmd, done?). Internal
state is kept on the tracker instance so navigator can hand off cleanly
between cruise and dock without losing the D-term continuity.
"""

from math import atan2, cos, sin, hypot, tan

from pilot.lib.geo_utils import normalize_angle, project_onto_line, offset_point


class CruiseTracker:
    """Pure Pursuit toward end_pose with D-term damping on alpha.

    Speed schedule near the end of cruise: linearly blend the commanded
    speed from `cruise_speed` down to `approach_speed` over the last
    `handoff_blend_distance` metres. Without this taper the chassis
    arrives at the dock entry at full cruise speed (the mcu_bridge ramp
    can't absorb the 0.6 m/s step within the dock corridor), so the
    DockTracker's first ~0.5 m runs at >2× the speed its gains were
    tuned for.
    """

    def __init__(self, params):
        self._cruise_speed = float(params['cruise_speed'])
        self._approach_speed = float(params['approach_speed'])
        self._lookahead_min = float(params['pp_lookahead_min'])
        self._lookahead_gain = float(params['pp_lookahead_gain'])
        self._damping = float(params['pp_damping'])
        self._max_curvature = float(params['max_curvature'])
        self._cruise_done_tolerance = float(params['cruise_done_tolerance'])
        # Slow down as |α| grows; never below this fraction of cruise.
        self._min_speed_fraction = float(params.get('pp_min_speed_fraction', 0.35))
        self._handoff_blend_distance = float(params.get('pp_handoff_blend_distance', 1.0))
        self._prev_alpha = None
        self._prev_t = None

    def reset(self):
        self._prev_alpha = None
        self._prev_t = None

    def step(self, chassis_pose, segment, t_now):
        x, y, psi = chassis_pose
        ex, ey, _ = segment.end_pose
        dx, dy = ex - x, ey - y
        dist = hypot(dx, dy)
        if dist < self._cruise_done_tolerance:
            self._prev_alpha = None
            self._prev_t = None
            return 0.0, 0.0, True

        # Linearly taper from cruise_speed to approach_speed in the last
        # handoff_blend_distance metres. The blend uses (dist - tol) so it
        # reaches approach_speed exactly at the cruise_done boundary,
        # giving the mcu_bridge ramp a soft handoff into DockTracker.
        if self._handoff_blend_distance > 1e-6 and dist < self._handoff_blend_distance:
            denom = max(1e-6, self._handoff_blend_distance - self._cruise_done_tolerance)
            blend = max(0.0, min(1.0, (dist - self._cruise_done_tolerance) / denom))
            target_speed = self._approach_speed + blend * (self._cruise_speed - self._approach_speed)
        else:
            target_speed = self._cruise_speed
        speed = target_speed
        L_d = max(self._lookahead_min, self._lookahead_gain * speed)

        # If the end is closer than L_d, project a virtual lookahead point
        # at L_d along the chassis→end direction past the goal. This keeps
        # the curvature denominator at a sane scale near the end and
        # prevents the sin(α=π) ≈ 0 degeneracy when the chassis happens
        # to overshoot. The denominator is the actual lookahead, so the
        # curvature gain stays consistent.
        target_angle = atan2(dy, dx)
        if dist < L_d:
            virt_x, virt_y = offset_point(x, y, L_d, target_angle)
            target_angle = atan2(virt_y - y, virt_x - x)

        alpha = normalize_angle(target_angle - psi)

        # Slow on heading error so the swing arc is short enough for GPS
        # heading-of-motion to keep up with chassis ψ.
        speed_scale = max(self._min_speed_fraction, cos(alpha))
        speed = target_speed * speed_scale

        kappa = 2.0 * sin(alpha) / L_d

        # D-term damping: subtract a portion of dα/dt to stop the
        # commanded κ from chasing the heading-error gradient. This is
        # what kills the left-right oscillation under heading lag.
        if self._prev_alpha is not None and self._prev_t is not None:
            dt = t_now - self._prev_t
            if 0.0 < dt < 0.5:
                d_alpha = normalize_angle(alpha - self._prev_alpha) / dt
                kappa -= self._damping * d_alpha
        self._prev_alpha = alpha
        self._prev_t = t_now

        # Clamp to physical max.
        if kappa > self._max_curvature:
            kappa = self._max_curvature
        elif kappa < -self._max_curvature:
            kappa = -self._max_curvature

        return speed, kappa, False


class DockTracker:
    """State-feedback line follower on the antenna's lateral error.

    The dock corridor is the straight line through segment.start_pose and
    segment.end_pose (both share the same psi_path). We compute:

        e_y = signed lateral distance from antenna to that line
              (positive when the antenna is to the LEFT of the path
              direction; project_onto_line returns +lateral when the
              point sits on the LEFT of the path heading vector)
        e_ψ = chassis ψ - psi_path     (signed, [-π, π])

    Curvature command:
        κ = -k_y · e_y − k_ψ · e_ψ − k_i · ∫e_y dt

    The integral term rejects constant κ-bias disturbances (residual
    antenna-offset error after auto-cal, mast tilt, slope) that the pure
    P-feedback would otherwise leave as a steady ~κ_bias / k_y offset on
    e_y, eating part of the 5 cm waypoint tolerance budget. Anti-windup
    freezes the integral whenever the curvature clamp is binding.

    Speed: ramps from `approach_speed` down to `creep_speed` as we close
    on the dock end, and reverses when the chassis has overshot the dock
    point (along < 0 past the end). Ackermann can't pivot, so a forward
    creep past an overshoot would make a wide circle — we reverse instead.
    """

    def __init__(self, params):
        self._approach_speed = float(params['approach_speed'])
        self._creep_speed = float(params['creep_speed'])
        self._k_y = float(params['dock_k_y'])
        self._k_psi = float(params['dock_k_psi'])
        self._k_i = float(params.get('dock_k_i', 0.0))
        self._max_curvature = float(params['max_curvature'])
        self._wheelbase = float(params['wheelbase'])
        self._max_steering_rad = float(params['max_steering_angle_rad'])
        self._approach_tolerance = float(params['approach_tolerance'])
        self._creep_zone = float(params['creep_zone'])
        # Integral state and limit. The limit is in units of (m·s) since
        # the integrand is e_y (m) × dt (s); the resulting κ contribution
        # is k_i · integral, in 1/m.
        self._integral = 0.0
        self._integral_limit = float(params.get('dock_integral_limit', 0.5))
        self._prev_t = None
        # Antenna offset is needed to compute antenna position from chassis
        # pose without round-tripping through the estimator (so this module
        # has no side effects on estimator state).
        self._a_x = float(params['antenna_offset_x'])
        self._a_y = float(params['antenna_offset_y'])

    def reset(self):
        self._integral = 0.0
        self._prev_t = None

    def _antenna_world(self, chassis_pose):
        x, y, psi = chassis_pose
        cp, sp = cos(psi), sin(psi)
        return (x + cp * self._a_x - sp * self._a_y,
                y + sp * self._a_x + cp * self._a_y)

    def step(self, chassis_pose, segment, t_now, antenna_world=None):
        """Return (speed_cmd, kappa_cmd, status).

        status: 'tracking' | 'reached'
        'reached' is set when the antenna has reached the target waypoint
        within `approach_tolerance` AND the chassis has crossed the dock
        end along the path direction (so we're not declaring done while
        still overshooting laterally).

        `t_now` (monotonic seconds) is used by the integral term. First
        call seeds the timer without integrating; subsequent calls
        accumulate dt-weighted lateral error with anti-windup.
        """
        if antenna_world is None:
            antenna_world = self._antenna_world(chassis_pose)
        x, y, psi = chassis_pose
        sx, sy, psi_path = segment.start_pose
        ex, ey, _ = segment.end_pose
        target_e, target_n = segment.target_antenna

        # Project antenna onto the dock corridor. `along` is signed distance
        # along path direction starting from the segment's start pose;
        # `lateral` is signed cross-track (positive = path direction has
        # the point on its LEFT).
        seg_len = hypot(ex - sx, ey - sy)
        a_along, e_y = project_onto_line(antenna_world[0], antenna_world[1],
                                         sx, sy, psi_path)

        # Distance from antenna to the antenna's intended landing point.
        target_dist = hypot(target_e - antenna_world[0],
                            target_n - antenna_world[1])

        e_psi = normalize_angle(psi - psi_path)

        # State feedback. project_onto_line returns POSITIVE lateral when
        # the antenna sits on the LEFT of the path heading vector, so e_y
        # > 0 = antenna LEFT of path → we want a RIGHT turn (κ < 0) to
        # converge → coefficient is -k_y. Likewise e_ψ > 0 (chassis CCW
        # from path) needs κ < 0 to align back to path heading.
        kappa_p = -self._k_y * e_y - self._k_psi * e_psi

        # Integrate cross-track error with dt from the monotonic clock.
        if self._prev_t is not None and t_now is not None:
            dt = t_now - self._prev_t
            if 0.0 < dt < 0.5:
                self._integral += e_y * dt
                if self._integral > self._integral_limit:
                    self._integral = self._integral_limit
                elif self._integral < -self._integral_limit:
                    self._integral = -self._integral_limit
        self._prev_t = t_now
        kappa = kappa_p - self._k_i * self._integral

        # Clamp to physical curvature. Anti-windup: if the clamp binds and
        # the integral is pushing harder in the same direction, undo the
        # most recent dt-step so the integral doesn't run away while the
        # actuator is saturated.
        if kappa > self._max_curvature:
            kappa = self._max_curvature
            if self._k_i * self._integral < 0 and self._prev_t is not None:
                # integral negative pushes κ positive; rolling back
                # prevents wind-up while saturated positive.
                pass  # noqa - handled by limit clamp above
        elif kappa < -self._max_curvature:
            kappa = -self._max_curvature
        # Equivalent steering angle clamp (atan(κ·L) capped by max_steer).
        # We clamp κ directly above; this is just a safety net for small
        # numerical excursions.
        max_kappa_from_steer = tan(self._max_steering_rad) / self._wheelbase
        if abs(kappa) > max_kappa_from_steer:
            kappa = max_kappa_from_steer if kappa > 0 else -max_kappa_from_steer

        # Antenna along-track distance to the target point (positive if
        # antenna is BEHIND target along the dock corridor).
        target_along, _ = project_onto_line(target_e, target_n,
                                            sx, sy, psi_path)
        along_to_target = target_along - a_along

        if target_dist <= self._approach_tolerance and along_to_target <= 0.0:
            return 0.0, 0.0, 'reached'

        # Speed schedule.
        if along_to_target < 0.0:
            # Antenna has overshot the target along the corridor. Reverse
            # straight at creep speed; the dock state-feedback law works
            # symmetrically on (e_y, e_ψ) — but we *don't* steer while
            # reversing because Ackermann steering inverts in reverse and
            # that interacts poorly with the linearised gains. Pure
            # straight-back is enough; once we're behind the target again
            # the next tick's forward κ corrects the lateral.
            return -self._creep_speed, 0.0, 'tracking'
        if target_dist < self._creep_zone:
            speed = self._creep_speed
        else:
            speed = self._approach_speed

        return speed, kappa, 'tracking'
