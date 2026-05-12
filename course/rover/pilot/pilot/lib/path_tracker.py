"""Per-segment path trackers.

Two control laws, one per segment kind:

  • CruiseTracker — heading-only P-control toward the segment end pose.
    Drives the chassis like a human steering toward a visible target:
    compute the bearing from current chassis position to the goal, set
    κ proportional to (bearing - chassis_ψ), drive forward at cruise
    speed. No path-following, no lateral term — there is literally no
    way for chassis-position noise or chord_psi discretisation to feed
    into the κ command, so straight stretches stay straight (e_psi → 0
    drives κ → 0) and turns are single smooth arcs that taper out as
    the chassis aligns. This replaces the Reed-Shepp + Stanley line
    follower whose lateral Stanley term coupled GPS noise into κ noise
    and produced visible wiggle.

  • DockTracker — Stanley line follower on the *antenna*'s lateral error
    with an integral term for κ-bias rejection. Operating on the antenna
    e_y (rather than the chassis') is what makes the antenna land on the
    user-clicked target even when the antenna is offset from the rear
    axle. The chassis frame Lyapunov analysis yields the legacy dual-P
    form κ = -k_y·e_y_antenna - k_ψ·e_ψ; the Stanley refinement uses
    atan2(k_y·e_y, v) for the desired offset which gives perpendicular
    closure at low v and a pure heading regulator at small e_y.

Both trackers consume an immutable PathSegment + the live chassis pose +
the antenna ENU position, and return (v_cmd, κ_cmd, done?). State is
kept on the tracker instance (dock integral, reverse latch) so the
navigator can hand off cleanly between cruise and dock without losing
controller state continuity.
"""

from math import atan2, cos, sin, hypot, tan

from pilot.lib.geo_utils import normalize_angle, project_onto_line


class CruiseTracker:
    """Heading-only P-controller driving the chassis toward the segment end.

    Computes the desired chassis heading as the bearing from the current
    chassis position to ``segment.end_pose`` (the dock corridor entry).
    Sets curvature proportional to (desired_psi − chassis_psi), capped at
    ``max_curvature``. Speed is ``cruise_speed`` scaled by max(min_frac,
    cos(e_psi)) so the chassis slows gracefully on sharp turns where GPS
    heading-of-motion is noisier.

    Why heading-only (no lateral term):

      A Stanley line follower runs κ = -k_heading·(e_psi + atan2(k_lat·
      e_y, v)). The e_y term is the source of every wiggle problem we
      saw — chassis-position noise of ±1 cm feeds atan2(4·0.01/0.5) =
      ±4.6° into desired_offset, then ±0.24 rad/m into κ; chord_psi
      jumps between Reed-Shepp sample sub-segments inject 5-14° steps
      that the regulator chases; the loop fights its own state-feedback
      lag at the phase margin and oscillates at ~0.25 Hz. Removing the
      e_y term entirely removes all three pathologies — κ depends only
      on (bearing - chassis_psi), and a chassis that is on a straight
      stretch with chassis_psi pointed at the goal has e_psi → 0 and
      κ → 0. No path to deviate from means no false-deviation to react
      to.

    Why this still works for path-following:

      The chassis traces a smooth arc into the dock corridor entry
      naturally. As it approaches the entry, the bearing-to-goal
      direction approaches the entry-to-corridor direction (geometrically:
      a chassis arriving at the entry from any side will have its
      heading pointed at the entry, which is ψ_dock by construction
      because the dock entry sits ahead of the dock target along ψ_dock).
      So the cruise→dock handoff has the chassis already pointed along
      the dock corridor heading, with the antenna roughly on the
      corridor (within ±a few cm at typical approach angles). The dock
      Stanley then handles the cm-precision landing.

      Worst case: chassis arriving at the dock entry from a perpendicular
      direction (90° off ψ_dock). The arc tightens, the chassis arrives
      with chassis_psi ≈ ψ_dock (because it was always steering toward
      the entry point and at entry the bearing-to-entry IS the corridor
      heading), and dock takes over with small e_y residual that the
      Stanley + integral closes within the 2.5 m default corridor.

    Done condition:

      Chassis position within ``cruise_done_tolerance`` of the segment
      end AND chassis_psi within ``cruise_done_heading_max_rad`` of
      ψ_dock (= segment.end_pose.psi). The heading condition keeps the
      dock from opening with a stale ±30° chassis heading the operator
      previously saw cause wari-gari. If the chassis overshoots the end
      pose along the bearing-to-goal direction by
      ``cruise_pass_through_m``, declare done regardless — safety net.
    """

    def __init__(self, params):
        self._cruise_speed = float(params['cruise_speed'])
        self._approach_speed = float(params['approach_speed'])
        self._max_curvature = float(params['max_curvature'])
        self._cruise_done_tolerance = float(params['cruise_done_tolerance'])
        self._cruise_done_heading_max = float(
            params.get('cruise_done_heading_max_rad', 0.14))  # tightened 15→8°
        self._cruise_pass_through_m = float(
            params.get('cruise_pass_through_m', 0.30))
        self._k_heading = float(params.get('cruise_k_heading', 1.5))
        self._min_speed_fraction = float(
            params.get('cruise_min_speed_fraction', 0.40))
        # Carrot lookahead distance. Steer toward a point 1.0 m past
        # the entry along corridor — larger lookahead than the initial
        # 0.60 m so the heading regulator gets a stronger pull toward
        # ψ_dock during the approach, leaving less heading residual
        # at handoff. The chassis still arrives ON the entry because
        # the done condition checks dist to entry, not to carrot.
        self._carrot_lookahead = float(
            params.get('cruise_carrot_lookahead_m', 1.00))
        # Handoff taper: slow chassis from cruise_speed down to
        # approach_speed over the last handoff_taper_m metres of the
        # cruise. Without taper the chassis was arriving at the entry
        # at full cruise speed (1.0 m/s) with whatever heading the
        # bearing-to-carrot wanted 0.5 s ago — typically 5-10° off
        # ψ_dock — and the dock tracker then had to correct that
        # residual at v=0.4 m/s with halved Stanley gains, which
        # produced visible lateral drift before the chassis aligned.
        # Tapering means the chassis enters the dock corridor at the
        # same 0.4 m/s the dock expects, with the carrot having had
        # time to pull e_psi closer to zero. Sized to ~1.5 m: chassis
        # decel from 1.0 to 0.4 m/s at accel_limit=0.8 needs 0.75 s of
        # decel, which covers ~0.6 m at the average speed — well
        # inside 1.5 m so the chassis fully reaches 0.4 m/s before
        # crossing the entry.
        self._handoff_taper_m = float(
            params.get('cruise_handoff_taper_m', 1.50))
        # Orbit gate: when the chassis is closer to the goal than its
        # minimum turning radius AND its heading is more than 90° off
        # the bearing-to-goal, the chassis CANNOT reach the goal by
        # forward arc. Pure-pursuit would orbit forever (14:03 WP5
        # trace: chassis spent 4 minutes circling around the dock entry
        # at radius ~0.6 m). Detect this case and declare cruise done,
        # handing off to the dock tracker whose reverse-recovery can
        # back the chassis up and re-approach properly. The threshold
        # is matched to the dock's expected approach distance — within
        # 0.40 m of the entry, dock can take over even from a wonky
        # heading.
        self._orbit_gate_dist = float(
            params.get('cruise_orbit_gate_dist_m', 0.40))

    def reset(self):
        # No persistent state.
        pass

    def step(self, chassis_pose, segment, t_now, chassis_v=None):
        # chassis_v retained in signature for navigator backward compat;
        # this tracker does not gate on chassis speed.
        del t_now, chassis_v
        x, y, psi = chassis_pose
        ex, ey, end_psi = segment.end_pose

        dx = ex - x
        dy = ey - y
        dist_to_end = hypot(dx, dy)

        # Done conditions. Heading aligned with end pose (which carries
        # ψ_dock) AND within position tolerance — the dock tracker can
        # take over with both heading and lateral close.
        e_psi_to_dock = normalize_angle(psi - end_psi)
        if (dist_to_end < self._cruise_done_tolerance
                and abs(e_psi_to_dock) <= self._cruise_done_heading_max):
            return 0.0, 0.0, True

        # Past-end fail-safe. Project chassis position onto the bearing-
        # to-end ray from segment.start_pose; if a_along is past the
        # end by pass_through_m, declare done. Prevents PP-style orbit
        # if the goal ends up just behind the chassis.
        sx, sy, _ = segment.start_pose
        seg_dx = ex - sx
        seg_dy = ey - sy
        seg_len = hypot(seg_dx, seg_dy)
        if seg_len > 1e-6:
            seg_psi = atan2(seg_dy, seg_dx)
            a_along, _ = project_onto_line(x, y, sx, sy, seg_psi)
            if a_along >= seg_len + self._cruise_pass_through_m:
                return 0.0, 0.0, True

        # Past-entry gate. If the chassis has already moved INTO the
        # dock corridor (i.e., past segment.end_pose along the corridor
        # direction toward the target), no forward arc can bring it
        # back to entry — the chassis is already where the dock tracker
        # wants to start. 14:03 WP5 replan case: dock failed to land,
        # chassis ended south of WP5 target which is south of the new
        # entry, replanned cruise tried to backtrack north and instead
        # orbited. With this gate the cruise hands off immediately and
        # the dock's reverse-recovery handles the back-up.
        # (chassis − entry) · corridor_dir > 0 ⇔ chassis past entry.
        past_entry_dot = (-dx) * cos(end_psi) + (-dy) * sin(end_psi)
        if past_entry_dot > 0 and dist_to_end < self._orbit_gate_dist * 3.0:
            return 0.0, 0.0, True

        # Orbit gate. If the goal is within orbit_gate_dist AND the
        # chassis is facing > 90° off the direction to the goal, the
        # chassis cannot forward-arc to reach it without circling.
        # Declare done; let the dock tracker (which can reverse) handle
        # the final cm-scale repositioning.
        if dist_to_end < self._orbit_gate_dist and dist_to_end >= 1e-3:
            bearing_to_goal = atan2(dy, dx)
            e_psi_bearing = normalize_angle(bearing_to_goal - psi)
            if abs(e_psi_bearing) > 1.5708:  # pi/2
                return 0.0, 0.0, True

        # Carrot point: end_pose extended forward along the corridor by
        # carrot_lookahead. Far from the end, the carrot is close to a
        # straight extrapolation of the bearing-to-goal, so behaviour
        # matches pure heading regulation. Close to the end, the carrot
        # sits inside the dock corridor and the bearing-to-carrot
        # converges to ψ_dock — chassis aligns smoothly with the
        # corridor heading rather than arriving at the entry at an angle.
        carrot_x = ex + self._carrot_lookahead * cos(end_psi)
        carrot_y = ey + self._carrot_lookahead * sin(end_psi)
        cdx = carrot_x - x
        cdy = carrot_y - y
        carrot_dist = hypot(cdx, cdy)
        if carrot_dist < 1e-3:
            desired_psi = end_psi
        else:
            desired_psi = atan2(cdy, cdx)

        e_psi = normalize_angle(desired_psi - psi)
        kappa = self._k_heading * e_psi
        if kappa > self._max_curvature:
            kappa = self._max_curvature
        elif kappa < -self._max_curvature:
            kappa = -self._max_curvature

        # Speed: cruise_speed far from entry, tapered toward
        # approach_speed inside handoff_taper_m so the cruise→dock
        # handoff is at the same speed the dock expects. The taper
        # gives the carrot time to bend the heading into ψ_dock
        # before the chassis crosses the entry.
        if self._handoff_taper_m > 1e-6 and dist_to_end < self._handoff_taper_m:
            blend = max(0.0, min(1.0, dist_to_end / self._handoff_taper_m))
            target_speed = self._approach_speed + blend * (
                self._cruise_speed - self._approach_speed)
        else:
            target_speed = self._cruise_speed

        speed_scale = max(self._min_speed_fraction, cos(e_psi))
        speed = target_speed * speed_scale

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
        # Stanley arctan gain. The yaml param dock_k_y (default 6.0) was
        # the P-gain for the legacy dual-P controller κ = -k_y*e_y -
        # k_psi*e_psi; inside Stanley's atan2(k_y*e_y, v) the same 6.0
        # makes 5 cm of lateral residual rotate the desired-psi by 30°+
        # at creep speed, far past anything the chassis can track. Use
        # a separate Stanley gain (dock_stanley_k_lat, default 4.0) and
        # leave dock_k_y honoured for backward compat only. Raised 2.5
        # -> 4.0 to match the cruise tracker — same final-approach
        # precision argument applies on the dock side: e_y=1.6 cm at
        # k_lat=2.5 left only a 4.6° desired-offset and a near-zero
        # kappa, so the antenna crept the last cm without steering.
        self._k_y = float(params.get('dock_stanley_k_lat',
                                     min(4.0, float(params['dock_k_y']))))
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
        # before re-engaging forward dock control. Shortened from 0.20 m
        # to 0.08 m — if the new overshoot-but-close reach condition
        # ever fails to catch the chassis (e.g. lateral pushed past
        # 2*approach_tolerance), we want a tight retry cycle (4 cm
        # back, 4 cm forward) instead of a 20 cm slingshot that the
        # 13:59 trace showed kicking the chassis 18 cm back from the
        # target every iteration of the cycle.
        self._reverse_recovery_m = float(
            params.get('dock_reverse_recovery_m', 0.08)
        )
        # Brake zone (target-distance under which forward speed ramps
        # down). Wider zone + lower minimum keeps the chassis from
        # blowing past target on inertia + PID lag, which is what makes
        # along_to_target swing negative and trips the reverse latch.
        # brake_zone tightened from 12 cm to 6 cm and min_speed_frac
        # lifted from 0.10 to 0.70 because at the old values the
        # commanded speed at the approach edge worked out to:
        #   v_cmd = creep_speed(0.10) * brake_ramp
        # which falls below the MCU's 0.05 m/s PID deadband as soon as
        # target_dist drops past ~6 cm, freezing the chassis 2-3 cm
        # short of approach_tolerance. 13:49 mission WP4 sat for 13 s
        # at dist=5.3 cm / v_cmd=0.04 before stuck-skip. New floor:
        # min v_cmd = creep_speed * 0.70 = 0.07 m/s, comfortably above
        # the deadband, so the chassis actually crosses the last cm
        # under power.
        self._brake_zone_m = float(params.get('dock_brake_zone_m', 0.06))
        self._brake_min_speed_frac = float(
            params.get('dock_brake_min_speed_frac', 0.70))
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
        # Stanley desired-offset cap — see CruiseTracker.__init__ for
        # the full rationale. Same default as the cruise tracker (15°)
        # so cruise→dock handoff at e_y > 4 cm doesn't suddenly switch
        # to a wider cap and start cross-and-swinging at the dock entry.
        self._stanley_offset_cap = float(
            params.get('dock_stanley_offset_cap_rad', 0.262))

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
        # Same v_eff floor as cruise: arctan needs enough denominator
        # that it doesn't saturate on cm-scale e_y at creep speed.
        # Below 0.5 m/s the Stanley feedforward turns into a relay that
        # commands ±35° from any tiny lateral noise, freezing the
        # chassis while the wheel servos thrash. The 13:42 mission's
        # WP3 dock stuck for 7+ s at e_y=-0.8 cm because brake-zone
        # had ramped v to 0.03 m/s while v_eff was the 0.1 creep
        # floor — desired_offset = atan2(6·−0.008, 0.1) = −26°, kappa
        # saturated, chassis not advancing.
        v_eff = max(speed_for_kappa, 0.5)
        desired_yaw_offset = atan2(self._k_y * e_y, v_eff)
        # Cap desired-offset so dock approach doesn't drive the chassis
        # perpendicular to the corridor on large lateral residuals. The
        # 13:33 mission showed cruise hand off to dock at e_y=30 cm, the
        # dock then commanded kappa saturated for the whole approach as
        # it tried to slam the chassis sideways onto the corridor. 35°
        # cap matches the cruise tracker's cap so handoff is smooth.
        offset_cap = self._stanley_offset_cap
        if desired_yaw_offset > offset_cap:
            desired_yaw_offset = offset_cap
        elif desired_yaw_offset < -offset_cap:
            desired_yaw_offset = -offset_cap
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

        # Clamp to physical curvature. Anti-windup is handled upstream by
        # the ±integral_limit clamp on the integrator itself (lines 548-
        # 551); during sustained κ-saturation the integral pumps up to
        # ±integral_limit and stops, so the post-clamp κ contribution
        # k_i × integral is bounded by k_i × integral_limit regardless of
        # how long saturation persists.
        if kappa > self._max_curvature:
            kappa = self._max_curvature
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

        # Overshoot-but-close: chassis crossed past target along-track
        # while still inside 2*approach_tolerance of the antenna target.
        # Without this, inertia carries the antenna ~5 cm past every
        # approach (PID lag + chassis momentum at 0.07 m/s creep), and
        # the strict 'dist<=tol' gate forces reverse every time, kicking
        # off the wari-gari cycle observed in the 13:59 trace. The dock
        # cycle is more damaging to the mission than 3–6 cm of landing
        # error on the overshoot side; settle re-verifies precision.
        if (along_to_target < 0.0
                and target_dist <= 1.5 * self._approach_tolerance):
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
