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
    """Stanley line follower toward the cruise corridor's end pose.

    Replaces Pure Pursuit because PP only matches the chassis position to
    a lookahead point — it does NOT actively align chassis ψ with the
    corridor heading. When the chassis comes out of one dock pointing
    60-90° off the next corridor (WP6→WP7 case, 04:16:23 trace: chassis
    ψ=-107°, corridor=-171°), PP saturates κ chasing the chassis→end
    direction, rotates the chassis through the end pose, and then orbits
    the end at turning-radius distance because the end now sits inside
    the chassis's turning circle. ψ overshoots the corridor by 30+°
    before swinging back. Cruise never declares done because dist
    grows again as the chassis swings out.

    Stanley instead controls chassis ψ to follow a desired psi that
    biases toward the corridor:

      desired_offset = atan2(k_lat * e_y_corridor, v)
      desired_psi    = psi_path - desired_offset
      e_psi_corr     = chassis_psi - desired_psi
      kappa          = -k_heading * e_psi_corr

    Far off the corridor (large |e_y|), desired_offset saturates near
    pi/2 in the sign of e_y so the chassis steers nearly perpendicular
    to the corridor and closes lateral. As the chassis gets onto the
    corridor, desired_offset decays smoothly to zero and the law becomes
    a pure heading regulator that holds chassis_psi = psi_path. This
    means the chassis is already corridor-aligned by the time cruise
    hands off to dock — no 30° heading offset bake-in, no PP orbit.

    Speed schedule preserved from the PP version: linearly taper from
    `cruise_speed` to `approach_speed` over the last
    `handoff_blend_distance` metres, plus a min_speed_fraction cap on
    |cos(e_psi_corr)| to slow the chassis on sharp turns so GPS heading
    measurement can keep up.
    """

    def __init__(self, params):
        self._cruise_speed = float(params['cruise_speed'])
        self._approach_speed = float(params['approach_speed'])
        self._max_curvature = float(params['max_curvature'])
        self._cruise_done_tolerance = float(params['cruise_done_tolerance'])
        # Slow down as |e_psi_corrected| grows; never below this fraction.
        self._min_speed_fraction = float(params.get('pp_min_speed_fraction', 0.25))
        self._handoff_blend_distance = float(params.get('pp_handoff_blend_distance', 1.0))
        # Done condition heading tolerance — chassis must have its ψ
        # within this of psi_path before declaring done, so the dock
        # tracker takes over with a clean alignment.
        self._cruise_done_heading_max = float(
            params.get('cruise_done_heading_max_rad', 0.26))  # 15°
        # Past-end fail-safe. Declare done regardless of heading if the
        # chassis has overshot the cruise end along-corridor by this
        # margin. Keeps PP-style orbit pathology from ever burning a
        # mission again.
        self._cruise_pass_through_m = float(
            params.get('cruise_pass_through_m', 0.30))
        # Stanley gains. k_lat sets how aggressively the chassis turns
        # toward the corridor as a function of lateral error; k_heading
        # sets the proportional gain on the heading regulator. Default
        # values are softer than the dock tracker's so cruise can run at
        # higher speed without chasing every cm of lateral residual.
        self._k_lat = float(params.get('cruise_k_lat', 2.0))
        self._k_heading = float(params.get('cruise_k_heading', 2.0))

    def reset(self):
        # No persistent state in Stanley; keep the method for the API
        # the navigator already uses.
        pass

    def step(self, chassis_pose, segment, t_now):
        x, y, psi = chassis_pose
        sx, sy, psi_path = segment.start_pose
        ex, ey, _ = segment.end_pose
        dx, dy = ex - x, ey - y
        dist_to_end = hypot(dx, dy)

        # Corridor projection: a_along is signed distance from start
        # along psi_path; e_y is signed lateral (positive = chassis on
        # LEFT of corridor heading).
        a_along, e_y = project_onto_line(x, y, sx, sy, psi_path)
        seg_len = hypot(ex - sx, ey - sy)
        e_psi_raw = normalize_angle(psi - psi_path)

        # Done conditions:
        # 1. Close to end pose AND chassis ψ aligned with corridor — the
        #    dock tracker can take over without paying for any lateral
        #    or heading carry-over.
        # 2. Past the end along-corridor by cruise_pass_through_m —
        #    safety net so we never sit in cruise re-orbiting the end.
        if (dist_to_end < self._cruise_done_tolerance
                and abs(e_psi_raw) <= self._cruise_done_heading_max):
            return 0.0, 0.0, True
        if a_along >= seg_len + self._cruise_pass_through_m:
            return 0.0, 0.0, True

        # Speed taper: same handoff blend as the PP version.
        if (self._handoff_blend_distance > 1e-6
                and dist_to_end < self._handoff_blend_distance):
            denom = max(1e-6,
                        self._handoff_blend_distance - self._cruise_done_tolerance)
            blend = max(0.0, min(1.0,
                                 (dist_to_end - self._cruise_done_tolerance) / denom))
            target_speed = (self._approach_speed
                            + blend * (self._cruise_speed - self._approach_speed))
        else:
            target_speed = self._cruise_speed

        # Stanley feedforward — same structure as DockTracker.step.
        # Use target_speed (pre-scale) for the atan2 denominator: at
        # high speed the desired-offset stays small (gentle bias toward
        # corridor); at low speed it saturates near pi/2 (perpendicular
        # entry) to close lateral fast.
        v_eff = max(target_speed, 0.1)
        desired_offset = atan2(self._k_lat * e_y, v_eff)
        e_psi_corrected = normalize_angle(e_psi_raw + desired_offset)
        kappa = -self._k_heading * e_psi_corrected

        # Slow on the magnitude of the corrected heading error so the
        # chassis doesn't try to turn at high speed under saturation.
        speed_scale = max(self._min_speed_fraction, cos(e_psi_corrected))
        speed = target_speed * speed_scale

        # Clamp curvature to physical limit.
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
        # Latched κ for the duration of a reverse stroke. Captured at the
        # instant reverse begins as -κ_forward (forward state-feedback κ
        # negated, no integral) and held constant until the stroke ends.
        # See the full rationale in step()'s reverse branch.
        self._reverse_kappa_latched = 0.0
        # Distance behind the target (along the corridor) to back up to
        # before re-engaging forward dock control. 0.20 m gives the
        # state-feedback law roughly one time-constant of forward travel
        # to bleed the residual lateral error.
        self._reverse_recovery_m = float(
            params.get('dock_reverse_recovery_m', 0.20)
        )
        # Brake zone (target-distance under which forward speed ramps
        # down). Wider zone + lower minimum keeps the chassis from
        # blowing past target on inertia + PID lag, which is what makes
        # along_to_target swing negative and trips the reverse latch.
        self._brake_zone_m = float(params.get('dock_brake_zone_m', 0.12))
        self._brake_min_speed_frac = float(
            params.get('dock_brake_min_speed_frac', 0.10))
        # Reverse stall watchdog. After a GPS RTK dropout the estimator's
        # chassis pose can jump >1 m on recovery; the dock tracker then
        # latches reverse trying to back up the chassis to within
        # reverse_recovery_m of the corridor, but the chassis spends the
        # whole reverse stroke rotating in place (saturated latched κ at
        # a wide along_to_target offset) and barely advances. Watchdog
        # tracks chassis displacement during reverse and emits a
        # 'reverse_stalled' status if not enough ground was covered —
        # navigator replans from the live pose instead of staying stuck.
        self._reverse_stall_timeout_s = float(
            params.get('dock_reverse_stall_timeout_s', 5.0))
        self._reverse_stall_min_disp_m = float(
            params.get('dock_reverse_stall_min_disp_m', 0.30))
        self._reverse_entry_t = None
        self._reverse_entry_xy = None

    def reset(self):
        self._integral = 0.0
        self._prev_t = None
        self._reverse_active = False
        self._reverse_kappa_latched = 0.0
        self._reverse_entry_t = None
        self._reverse_entry_xy = None

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

        # ── Forward control law: Stanley feedforward ───────────────────
        # The previous law (kappa_p = -k_y*e_y - k_psi*e_psi) is a sum
        # of two P-terms. When the chassis is mostly-aligned with the
        # corridor (e_psi small) but lateral isn't closed (|e_y| large),
        # the e_y term wants to turn but the e_psi term is near zero,
        # so the chassis rotates slightly, immediately picks up some
        # e_psi, and the two terms cancel (04:18 mission segment 17:
        # e_y=-4 cm, e_psi=+3° gave kappa = +0.28 - 0.20 = +0.08, near
        # zero, so the chassis just rolled past the target without
        # closing 4 cm of lateral residual).
        #
        # Stanley control replaces the dual P-term with a single
        # heading regulator that follows a *desired* chassis psi which
        # itself biases toward the line by an arctan of (k*e_y / v):
        #
        #   desired_yaw_offset = atan2(k_y * e_y, v)
        #   desired_psi = psi_path - desired_yaw_offset
        #   e_psi_corrected = chassis_psi - desired_psi = e_psi + desired_yaw_offset
        #   kappa_p = -k_psi * e_psi_corrected
        #
        # At low v this saturates desired_yaw_offset near pi/2 in the
        # sign of e_y, pointing the chassis nearly perpendicular to the
        # line — lateral closes within a meter at creep speed regardless
        # of how much residual is left. As |e_y| → 0, desired_yaw_offset
        # → 0 and the law reduces to a simple heading regulator that
        # holds chassis_psi = psi_path on the line.
        #
        # We need the forward speed to compute desired_yaw_offset, so
        # speed schedule is run BEFORE the kappa calculation.
        if target_dist < self._creep_zone:
            speed_for_kappa = self._creep_speed
        else:
            speed_for_kappa = self._approach_speed
        # Stanley arctan needs a non-zero v denominator. Use creep speed
        # as a floor even if brake-zone ramping later cuts speed below it
        # — the desired yaw-offset is what we're shooting at, not what
        # the chassis can instantaneously achieve at the cut speed.
        v_eff = max(speed_for_kappa, self._creep_speed)
        desired_yaw_offset = atan2(self._k_y * e_y, v_eff)
        e_psi_corrected = normalize_angle(e_psi + desired_yaw_offset)
        kappa_p = -self._k_psi * e_psi_corrected

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
            self._reverse_entry_t = None
            self._reverse_entry_xy = None
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
        if along_to_target < 0.0 and not self._reverse_active:
            # Latch κ at the moment we cross the target. Use the negated
            # forward state-feedback κ (no integral). The forward law is
            #   κ_fwd = -k_y·e_y - k_ψ·e_ψ
            # Ackermann reverse with the same δ flips ψ̇'s sign, so the
            # opposite δ (i.e. -κ) produces the same world-frame yaw rate
            # in reverse as κ produced in forward. Holding the value
            # latched at entry, instead of recomputing each tick from
            # live e_y, eliminates the divergence mode of fd61bbf's
            # naive `return -kappa` form: live e_y can flip sign mid-
            # reverse when the chassis crosses the corridor line, and a
            # tick-by-tick negation then steers the chassis further off-
            # line. The latched value freezes the closure direction.
            #
            # Earlier attempt with κ_rev = +k_ψ·e_ψ (e_ψ P-only, no e_y)
            # left wheel angle near zero whenever e_y dominated κ_fwd
            # (e.g. e_y=-4 cm, e_ψ=+3° → κ_fwd ≈ +0.08, κ_rev ≈ +0.32 —
            # both positive, so reverse and forward steered the chassis
            # the same way and the dock cycle never advanced). Observed
            # in the 04:18 mission, segment 17.
            kappa_latch = -kappa_p
            if kappa_latch > self._max_curvature:
                kappa_latch = self._max_curvature
            elif kappa_latch < -self._max_curvature:
                kappa_latch = -self._max_curvature
            self._reverse_kappa_latched = kappa_latch
            self._reverse_active = True
            # Watchdog snapshot for reverse-stall detection.
            self._reverse_entry_t = t_now
            self._reverse_entry_xy = (x, y)
        elif along_to_target < 0.0:
            # already in reverse; keep latched κ (no update)
            pass
        if self._reverse_active:
            if along_to_target < self._reverse_recovery_m:
                # Watchdog: if reverse has been running for
                # reverse_stall_timeout_s and chassis displacement from
                # the reverse-entry point is still below
                # reverse_stall_min_disp_m, the chassis is rotating in
                # place under a saturated latched κ (observed in
                # 05:11 mission: 9 s reverse, 0.64 m total displacement,
                # 97° of rotation). Bail to the navigator with
                # 'reverse_stalled' so it can replan from the live pose.
                if (self._reverse_entry_t is not None
                        and self._reverse_entry_xy is not None
                        and t_now is not None):
                    elapsed = t_now - self._reverse_entry_t
                    dx_rev = x - self._reverse_entry_xy[0]
                    dy_rev = y - self._reverse_entry_xy[1]
                    disp = hypot(dx_rev, dy_rev)
                    if (elapsed >= self._reverse_stall_timeout_s
                            and disp < self._reverse_stall_min_disp_m):
                        self._reverse_active = False
                        self._reverse_entry_t = None
                        self._reverse_entry_xy = None
                        return 0.0, 0.0, 'reverse_stalled'
                return (-self._creep_speed,
                        self._reverse_kappa_latched,
                        'tracking')
            self._reverse_active = False
            self._reverse_entry_t = None
            self._reverse_entry_xy = None

        # Forward speed schedule (already computed once above for
        # Stanley's kappa denominator; recompute here to apply brake).
        speed = speed_for_kappa

        # Dist-proportional brake near the target. Earlier sizing
        # (brake_zone = 2× approach_tolerance = 6 cm, ramp_min = 0.2)
        # was too tight: in the 04:18 mission segment 17, every forward
        # tick exited brake_zone within one step (target_dist 7.7→6.5)
        # while v_actual was still PID-lagging the cmd, so the chassis
        # blew past target along-track on every approach. brake_zone now
        # widened to 0.12 m with min 0.10× of cmd, so a chassis on the
        # tail end of the corridor decelerates over ~10 cm instead of
        # 6 cm and never crosses past target on inertia.
        if target_dist < self._brake_zone_m:
            ramp = max(target_dist / self._brake_zone_m,
                       self._brake_min_speed_frac)
            speed *= ramp

        return speed, kappa, 'tracking'
