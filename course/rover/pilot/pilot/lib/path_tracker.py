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
        # Maximum heading misalignment with the segment direction at which
        # cruise is allowed to declare done. Without this gate, chassis can
        # arrive at the end pose with a 50° heading offset and hand off to
        # the dock tracker, which then can't close that within its 1.5 m
        # corridor and cycles forever (observed at WP2 in 2026-05-08
        # mission). 0.52 rad = 30°.
        self._cruise_done_heading_max = float(
            params.get('cruise_done_heading_max_rad', 0.52))
        # Past-end fail-safe. When chassis overshoots the cruise end along
        # the corridor by `cruise_pass_through_m` metres, declare done
        # regardless of heading. Without this, an overshooting chassis
        # tries to swing back, the lookahead orbits the end pose, and the
        # tracker max-curvature loops in place (observed at WP7).
        self._cruise_pass_through_m = float(
            params.get('cruise_pass_through_m', 0.30))
        self._prev_alpha = None
        self._prev_t = None

    def reset(self):
        self._prev_alpha = None
        self._prev_t = None

    def step(self, chassis_pose, segment, t_now):
        x, y, psi = chassis_pose
        sx, sy, psi_path = segment.start_pose
        ex, ey, _ = segment.end_pose
        dx, dy = ex - x, ey - y
        dist = hypot(dx, dy)
        # Project onto the corridor to detect pass-through overshoots.
        # `along` is signed distance from start in the corridor direction.
        a_along, _ = project_onto_line(x, y, sx, sy, psi_path)
        seg_len = hypot(ex - sx, ey - sy)
        e_psi = abs(normalize_angle(psi - psi_path))

        # Done conditions:
        # 1. Chassis arrived at end pose AND heading aligned with corridor
        #    — clean handoff to the dock tracker.
        # 2. Chassis already passed the cruise end along the corridor by
        #    cruise_pass_through_m — keep going forward only re-orbits
        #    the end pose; declare done and let the dock tracker take over
        #    with whatever heading we ended up with.
        if (dist < self._cruise_done_tolerance
                and e_psi <= self._cruise_done_heading_max):
            self._prev_alpha = None
            self._prev_t = None
            return 0.0, 0.0, True
        if a_along >= seg_len + self._cruise_pass_through_m:
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

        # D-term damping: ADD damping × dα/dt so that as the chassis
        # converges (α decreases, dα/dt < 0) the commanded κ is REDUCED
        # — opposing the rate of heading change. The earlier `kappa -=`
        # form was anti-damping: it added |κ| while α was already
        # closing, which under heading-lag amplified figure-8 swings.
        # Sign change here matches classical PD: u = Kp·α + Kd·dα/dt
        # with Kd > 0 (where Kp = 2·sin(α)/L_d gives κ ∝ α for small α
        # so the same-sign Kd damps the closing rate).
        if self._prev_alpha is not None and self._prev_t is not None:
            dt = t_now - self._prev_t
            if 0.0 < dt < 0.5:
                d_alpha = normalize_angle(alpha - self._prev_alpha) / dt
                kappa += self._damping * d_alpha
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
        # Reverse-recovery state. When the antenna overshoots the target
        # along the corridor we back up far enough that the next forward
        # pass has room to close lateral error before re-reaching the
        # target. Without this, a small lateral residual makes the dock
        # oscillate one tick past the target and one tick back, never
        # actually closing.
        self._reverse_active = False
        # Distance behind the target (along the corridor) to back up to
        # before re-engaging forward dock control. 0.20 m gives the
        # state-feedback law roughly one time-constant of forward travel
        # to bleed the residual lateral error.
        self._reverse_recovery_m = float(
            params.get('dock_reverse_recovery_m', 0.20)
        )

    def reset(self):
        self._integral = 0.0
        self._prev_t = None
        self._reverse_active = False

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

        # 'reached' as soon as we're inside the approach tolerance,
        # regardless of along-track sign. The previous version required
        # along_to_target <= 0 (chassis must have crossed past the target)
        # which forced an along-track overshoot on every dock and then
        # short reverse blips that oscillated when lateral wasn't already
        # closed. Without that constraint, the dock stops as soon as the
        # antenna is close enough — no overshoot, no oscillation.
        if target_dist <= self._approach_tolerance:
            self._reverse_active = False
            return 0.0, 0.0, 'reached'

        # Reverse recovery. Once the antenna overshoots the target along
        # the corridor we don't want a tick-by-tick blip — we want to
        # back up far enough (`_reverse_recovery_m`) that the next forward
        # pass has room to close any lateral residual before re-reaching
        # the target. _reverse_active latches once we cross past the
        # target, and clears once the antenna sits a full recovery
        # distance behind the target (along_to_target ≥ +recovery_m, since
        # backing the chassis up the corridor moves a_along DOWN, which
        # makes along_to_target = target_along - a_along go from negative
        # toward +recovery_m).
        if along_to_target < 0.0:
            self._reverse_active = True
        if self._reverse_active:
            if along_to_target < self._reverse_recovery_m:
                # Reverse with e_ψ P-only steering (no e_y term).
                #
                # Why not the full sign-flipped forward law (fd61bbf
                # attempt): that returns -κ where κ includes -k_y·e_y.
                # When the chassis crosses the corridor line mid-reverse,
                # e_y flips sign while -k_y·e_y keeps the linearised
                # closure direction wrong, and the law steers the chassis
                # further off-line. fd61bbf got stuck on WP1 from the
                # first segment for exactly this reason.
                #
                # What we use instead: for forward, the e_ψ P-term is
                # κ_p_ψ_fwd = -k_ψ·e_ψ. Ackermann reverse keeps the
                # steering→ψ̇ map but flips its sign for the same δ
                # (servo left → chassis rear swings left → ψ rotates
                # right). To get the same e_ψ closure direction in the
                # world frame, flip the sign of the κ command:
                #   κ_rev = +k_ψ·e_ψ
                # This is a P controller on e_ψ alone — bounded,
                # converges to e_ψ = 0 monotonically, and never picks
                # up an e_y sign-flip discontinuity. lateral closure
                # is left to the forward half (where the linearisation
                # is valid).
                kappa_rev = self._k_psi * e_psi
                if kappa_rev > self._max_curvature:
                    kappa_rev = self._max_curvature
                elif kappa_rev < -self._max_curvature:
                    kappa_rev = -self._max_curvature
                return -self._creep_speed, kappa_rev, 'tracking'
            self._reverse_active = False

        # Speed schedule (forward).
        if target_dist < self._creep_zone:
            speed = self._creep_speed
        else:
            speed = self._approach_speed

        # Dist-proportional brake near the 'reached' threshold. Without
        # this, the chassis hits v=0 abruptly at approach_tolerance and
        # rolls forward several cm on inertia + PID tracking lag, which
        # showed up as a 5-10 cm overshoot at the first waypoint of every
        # mission. Linear ramp from creep_speed at 2× threshold down to
        # 20% of creep_speed at the threshold itself.
        brake_zone = max(2.0 * self._approach_tolerance, 0.05)
        if target_dist < brake_zone:
            ramp = max(target_dist / brake_zone, 0.2)
            speed *= ramp

        return speed, kappa, 'tracking'
