"""Per-segment path trackers.

Three control laws live here. Pick one with the yaml param
``path_tracker_kind``:

  • L1Tracker (``'l1'``, Stage 2 design) — Park 2007 geometric pursuit
    with Macenski-style regulated speed. Single controller for cruise
    AND dock segments: same code path, same κ law, just different
    "reached" gates per kind. Self-tunes lookahead from speed so the
    same controller stretches from fast cruise (L1 ≈ a few m, smooth)
    to creep dock (L1 floored, tight closure). Reverse-recovery on
    dock overshoot uses saturated κ in the e_y-closing direction (not
    the legacy DockTracker's latched-κ which devolves to a ~0 rotation
    rate on small lateral residuals). This is what ArduPilot Rover
    uses on every commercial RTK rover, and replaces the cruise+dock
    split as the eventual one-controller architecture.

  • CruiseTracker (``'legacy'`` half) — heading-only P-control toward
    the segment end pose. Drives the chassis like a human steering
    toward a visible target: compute the bearing from current chassis
    position to the goal, set κ proportional to (bearing - chassis_ψ),
    drive forward at cruise speed. No path-following, no lateral term
    — there is literally no way for chassis-position noise or
    chord_psi discretisation to feed into the κ command, so straight
    stretches stay straight (e_psi → 0 drives κ → 0) and turns are
    single smooth arcs that taper out as the chassis aligns.

  • DockTracker (``'legacy'`` half) — Stanley line follower on the
    *antenna*'s lateral error with an integral term for κ-bias
    rejection. Operating on the antenna e_y (rather than the chassis')
    is what makes the antenna land on the user-clicked target even when
    the antenna is offset from the rear axle. The Stanley refinement
    uses atan2(k_y·e_y, v) for the desired offset which gives
    perpendicular closure at low v and a pure heading regulator at
    small e_y.

All trackers consume an immutable PathSegment + the live chassis pose +
the antenna ENU position, and return (v_cmd, κ_cmd, status). State is
kept on the tracker instance (dock integral, reverse latch) so the
navigator can hand off cleanly between segments without losing
controller state continuity.
"""

from math import atan2, cos, pi, sin, hypot, tan

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


class L1Tracker:
    """L1 geometric pursuit + Macenski-regulated speed.

    Replaces CruiseTracker + DockTracker with one continuous controller.
    The same `step()` runs on every PathSegment regardless of kind; only
    the "reached" gate and the speed-target floor differ between cruise
    and dock. The L1 lateral controller is identical to ArduPilot Rover's
    L1_Control:

        L1 = clamp(damping/π · period · v,  L1_min,  L1_max)
        η  = atan2(L1_y - chassis_y, L1_x - chassis_x)  -  chassis_ψ
        κ  = 2·sin(η) / L1

    The lookahead point sits L1 metres ahead of the chassis's projection
    on the segment line (start_pose → end_pose). η is the bearing from
    chassis position to that point relative to chassis heading. The
    classical pure-pursuit derivation gives κ = 2·sin(η)/L1; with η = 0
    (chassis pointed at the lookahead) κ → 0 and the chassis runs
    straight. Lateral closure is exponential with time-constant ≈
    L1·damping/v, so on a 1 m residual at v=1 m/s the chassis closes
    to under 5 cm in ~3 s — no oscillation, no saturated Stanley
    perpendicular swing.

    Reached condition is per-segment:
      cruise: chassis projects past end_pose along the segment line, OR
              chassis within `cruise_done_tolerance` of end_pose. cm-
              capture is not enforced here — the cruise segment exists
              only to bring the chassis to the dock corridor entry.
      dock:   antenna within `cm_capture` of `target_antenna` (default
              3 cm). Direct cm-precision gate, no along-track sign
              requirement (no overshoot mandate, so no obligatory dock-
              cycle on every WP).

    Reverse-recovery (dock segments only): when the antenna overshoots
    the target along the corridor (along_to_target < 0), the chassis
    reverses with curvature saturated in the e_y-closing direction.
    This is the key correction from the legacy DockTracker: latched κ
    on overshoot devolved to ≈0.06 rad/m at small e_y, yielding
    0.27°/0.8 s — useless. Saturated κ gives 7.8°/0.8 s, closing ≈ 1
    cm lateral per reverse cycle. Recovery distance is adaptive
    (max(min, 2·|e_y|)) so the cycle scales with the residual.
    Termination is on EITHER e_y sign-flip (chassis crossed the
    corridor — keep reversing past that would re-open the lateral) OR
    reaching the adaptive recovery distance.
    """

    def __init__(self, params):
        self._cruise_speed = float(params['cruise_speed'])
        self._approach_speed = float(params['approach_speed'])
        self._creep_speed = float(params['creep_speed'])
        self._max_curvature = float(params['max_curvature'])
        self._wheelbase = float(params['wheelbase'])
        self._max_steering_rad = float(params['max_steering_angle_rad'])
        self._a_x = float(params['antenna_offset_x'])
        self._a_y = float(params['antenna_offset_y'])

        # L1 self-tuning lookahead. ArduPilot defaults are period=18s,
        # damping=0.75 for plane-scale; rover dynamics are 10× tighter,
        # so period=2.5 s pulls L1 down to ~0.6-1.5 m at our speed
        # range. damping=1/√2 is the critical-damping pick.
        self._l1_period = float(params.get('l1_period_s', 2.5))
        self._l1_damping = float(params.get('l1_damping', 0.7071))
        self._l1_min = float(params.get('l1_min_m', 0.6))
        self._l1_max = float(params.get('l1_max_m', 4.0))

        # cm-precision capture radius on dock segments. Matches the
        # navigator's waypoint_tolerance / settle_tolerance for L1
        # mode (3 cm). Going much tighter than this exceeds the RTK
        # noise band; looser gives away accuracy that's free to claim.
        self._cm_capture = float(params.get('l1_cm_capture_m', 0.03))

        # Cruise advancement tolerance. Used as a backup to the
        # along-projection gate so a chassis that drifts laterally
        # close to the entry without quite crossing it still hands off.
        self._cruise_done_tolerance = float(
            params.get('cruise_done_tolerance', 0.20))

        # Reverse-recovery sizing. _min_m floors the adaptive distance
        # at 8 cm so even sub-cm overshoots get one meaningful reverse
        # stroke; 2× scaling above that means 5 cm overshoot reverses
        # 10 cm, 10 cm reverses 20 cm — closure per cycle scales with
        # residual.
        self._reverse_recovery_min_m = float(
            params.get('l1_reverse_recovery_min_m', 0.08))
        self._reverse_speed = float(
            params.get('l1_reverse_speed', self._creep_speed))

        # Macenski regulated-speed knobs. _kappa_lim is the curvature
        # at which speed regulation starts kicking in; speed scales by
        # min(1, kappa_lim/|κ|) so tight turns slow down proportional
        # to 1/κ. _e_y_gain (default 2.0) is the linear cross-track
        # speed cut: speed *= max(_e_y_speed_floor, 1 - gain·|e_y|).
        self._kappa_lim = float(
            params.get('l1_kappa_speed_lim', 0.5 * self._max_curvature))
        self._e_y_gain = float(params.get('l1_e_y_speed_gain', 2.0))
        self._e_y_speed_floor = float(
            params.get('l1_e_y_speed_floor', 0.4))

        # Dock-only target-distance brake. cm_capture = 3 cm; at
        # v=approach_speed=0.40 m/s the chassis travels 2 cm per 50 ms
        # tick, so without a brake the antenna overshoots cm_capture
        # on every approach and kicks off reverse-recovery cycles
        # (15:24:50 WP1 trace: dist 15→14.6→7.6→3.8 → stalled at 7 cm
        # outside cm_capture, settle timeout fired). Linear ramp from
        # approach_speed at brake_zone edge down to brake_min_frac ·
        # approach_speed at the target. Sized to ~6× cm_capture so
        # the MCU PID has time to settle around the min approach
        # speed before the antenna crosses 3 cm.
        self._brake_zone_m = float(params.get('l1_brake_zone_m', 0.20))
        self._brake_min_speed_frac = float(
            params.get('l1_brake_min_speed_frac', 0.175))
        # Creep zone — distance to target inside which the unified
        # 'l1' segment downshifts v_target from cruise_speed to
        # approach_speed. Mirrors legacy DockTracker's creep_zone:
        # once we're within ~40 cm of the antenna landing, the L1
        # is functionally acting as a dock corridor and should use
        # the precision speed schedule, not the long-haul cruise
        # schedule.
        self._creep_zone = float(params.get('creep_zone', 0.40))
        # Hard floor on commanded forward speed inside the brake zone.
        # Decoupled from `creep_speed` (which legacy DockTracker uses
        # as the creep-zone speed BEFORE the brake_min_frac modulation
        # — its effective stop floor is 0.10·0.70 = 0.07). Match legacy
        # at 0.07 so the final cm-capture is reached at the same
        # forward velocity the dock was field-validated at. PID
        # deadband is 0.05 m/s; 0.07 gives a 40 % margin to keep the
        # chassis moving under power until cm_capture fires.
        self._min_speed = float(params.get('l1_min_speed_m_s', 0.07))

        # Sharp-turn lookahead boost. On WP-to-WP transitions where the
        # path direction turns by more than `sharp_turn_thresh_rad`
        # (default 45°), the L1_min floor (0.6 m) bites with chassis
        # still wide of the path — the close lookahead pulls η ≈ 30°
        # and κ saturates, the speed regulator drops v to 0.20 m/s,
        # and the chassis pivots tightly in place for 4-5 s before
        # advancing toward the corridor (15:48 mission WP5 trace:
        # 9.3 s cruise, saturated κ throughout). Boosting L1_min to
        # ~1.2 m during the sharp-turn window widens the η/κ to a
        # gentle arc — κ stays well below saturation, the speed
        # regulator keeps full v_target, and the chassis advances
        # toward the corridor while it rotates. Auto-disengages once
        # e_psi falls under the threshold (chassis aligned with path).
        self._sharp_turn_thresh = float(
            params.get('l1_sharp_turn_thresh_rad', 0.785))  # 45°
        self._sharp_turn_l1_min = float(
            params.get('l1_sharp_turn_l1_min_m', 1.2))

        # Reverse-recovery lockout: after exiting reverse-recovery,
        # block re-entry for this many seconds. Without it, the chassis
        # toggles between forward and reverse every tick near the target
        # (14:23 mission WP4 trace: 30+ ticks of v=+0.4/-0.10 alternating,
        # κ flipping ±1.70 each tick — the "조향 휙휙" symptom).
        # 1.5 s lets the brake_zone ramp settle into the chassis before
        # along_to_target can flip negative again.
        self._reverse_lockout_s = float(
            params.get('l1_reverse_lockout_s', 1.5))

        # Reverse latch state. Captured at the moment along_to_target
        # crosses zero (antenna projects past target along corridor);
        # held until termination (sign-flip or adaptive distance).
        self._reverse_active = False
        self._reverse_entry_e_y = 0.0
        self._reverse_recovery_target_m = 0.0
        self._reverse_entry_along_to_target = 0.0
        # Lockout window — t_now value until which new reverse entries
        # are suppressed. Set by `_reset_reverse` when reverse exits.
        self._reverse_lockout_until = 0.0
        # Cached last commanded forward speed — feeds L1 sizing on the
        # next tick so the lookahead doesn't shrink to L1_min on a
        # zero-cmd recovery tick and then snap back on the next.
        self._last_v_cmd = self._approach_speed

    def reset(self):
        self._reverse_active = False
        self._reverse_entry_e_y = 0.0
        self._reverse_recovery_target_m = 0.0
        self._reverse_entry_along_to_target = 0.0
        self._reverse_lockout_until = 0.0
        self._last_v_cmd = self._approach_speed

    def _antenna_world(self, chassis_pose):
        x, y, psi = chassis_pose
        cp, sp = cos(psi), sin(psi)
        return (x + cp * self._a_x - sp * self._a_y,
                y + sp * self._a_x + cp * self._a_y)

    def _reset_reverse(self, t_now=None):
        was_active = self._reverse_active
        self._reverse_active = False
        self._reverse_entry_e_y = 0.0
        self._reverse_recovery_target_m = 0.0
        self._reverse_entry_along_to_target = 0.0
        # Arm the forward-only lockout if we just exited a real reverse
        # stroke (not a no-op clear from segment advance / reset()).
        if was_active and t_now is not None:
            self._reverse_lockout_until = t_now + self._reverse_lockout_s

    def _clamp_curvature(self, kappa):
        if kappa > self._max_curvature:
            return self._max_curvature
        if kappa < -self._max_curvature:
            return -self._max_curvature
        max_k_from_steer = tan(self._max_steering_rad) / self._wheelbase
        if kappa > max_k_from_steer:
            return max_k_from_steer
        if kappa < -max_k_from_steer:
            return -max_k_from_steer
        return kappa

    def _reverse_step(self, antenna_e_y, along_to_target, t_now):
        # Latch entry state on first reverse tick.
        if not self._reverse_active:
            self._reverse_active = True
            self._reverse_entry_e_y = antenna_e_y
            self._reverse_recovery_target_m = max(
                self._reverse_recovery_min_m, 2.0 * abs(antenna_e_y))
            self._reverse_entry_along_to_target = along_to_target

        # Termination: e_y sign-flip. Chassis crossed the corridor —
        # continuing reverse past this would push lateral the other
        # way. Snapshot entry sign vs current sign.
        entry_sign = self._reverse_entry_e_y
        if (entry_sign > 0.0 and antenna_e_y < 0.0) or \
           (entry_sign < 0.0 and antenna_e_y > 0.0):
            self._reset_reverse(t_now)
            return None

        # Termination: reversed far enough. along_to_target starts
        # negative (antenna past target) and INCREASES as chassis
        # reverses (antenna_along decreases). reversed_dist is how
        # much the antenna has moved back along the corridor.
        reversed_dist = along_to_target - self._reverse_entry_along_to_target
        if reversed_dist >= self._reverse_recovery_target_m:
            self._reset_reverse(t_now)
            return None

        # Saturated κ in the e_y-closing direction. Derivation:
        # ė_y = v·κ·a_x (chassis aligned with path, a_x = antenna
        # forward offset). In reverse v < 0; to close e_y > 0
        # (antenna LEFT of path), need ė_y < 0 → v·κ < 0 → κ > 0.
        # Symmetrically κ < 0 closes e_y < 0. So κ = sign(e_y)·max.
        if antenna_e_y > 0.0:
            kappa_rev = self._max_curvature
        elif antenna_e_y < 0.0:
            kappa_rev = -self._max_curvature
        else:
            kappa_rev = 0.0
        return -self._reverse_speed, kappa_rev, 'tracking'

    def step(self, chassis_pose, segment, t_now, antenna_world=None):
        """Return (v_cmd, kappa_cmd, status).

        status: 'tracking' | 'reached'

        `t_now` is accepted for parity with the legacy trackers; L1 has
        no time-integrating state so the value is unused. Kept in the
        signature so the navigator can dispatch trackers uniformly.
        """
        if antenna_world is None:
            antenna_world = self._antenna_world(chassis_pose)
        x, y, psi = chassis_pose
        ax, ay = antenna_world
        sx, sy, psi_path = segment.start_pose
        ex, ey, _ = segment.end_pose
        tx, ty = segment.target_antenna
        seg_len = hypot(ex - sx, ey - sy)
        is_dock = segment.kind == 'dock'

        # Degenerate path: start ≈ end (e.g. tight replan).
        # Use bearing-to-end as the synthetic path direction so the
        # lookahead still has something to chase.
        if seg_len < 1e-3:
            chassis_to_end = hypot(ex - x, ey - y)
            if chassis_to_end < 1e-3:
                psi_path = psi
            else:
                psi_path = atan2(ey - y, ex - x)

        c_along, c_e_y = project_onto_line(x, y, sx, sy, psi_path)
        a_along, a_e_y = project_onto_line(ax, ay, sx, sy, psi_path)
        target_dist = hypot(tx - ax, ty - ay)

        # Segment kind semantics:
        #   'dock' (legacy planner): chassis is on the dock corridor
        #     between the entry and the dock pose. cm_capture + reverse-
        #     recovery apply.
        #   'l1' (l1 planner, Stage 3-style): unified segment from
        #     chassis-now (or prev dock_pose) to cur WP's dock_pose.
        #     Same reached/reverse-recovery semantics as 'dock' — the
        #     antenna landing on the WP is what matters, regardless of
        #     where the segment started.
        #   'cruise' (legacy planner): chassis transit to the dock
        #     corridor entry. Reached on along-projection past entry
        #     or chassis proximity — antenna is NOT cm-precise here,
        #     the dock segment handles that.
        precision_kind = is_dock or segment.kind == 'l1'

        # ── Reached gates ────────────────────────────────────────────
        if precision_kind:
            if target_dist <= self._cm_capture:
                self._reset_reverse()
                self._last_v_cmd = self._approach_speed
                return 0.0, 0.0, 'reached'
            target_along, _ = project_onto_line(tx, ty, sx, sy, psi_path)
            along_to_target = target_along - a_along
            # Reverse-recovery handles overshoot. Once latched, stays
            # in reverse until termination signal flips _reverse_active
            # back to False — at which point the next tick falls
            # through to forward L1.
            # Reverse-recovery has a forward-only lockout window after
            # each exit (see _reverse_lockout_s). While locked out, even
            # along_to_target<0 doesn't re-enter reverse — forward L1
            # runs instead. This prevents the WP-near ping-pong cycle
            # where chassis crosses target by <5 cm, reverse fires,
            # exits 50 ms later, forward fires, target crosses again,
            # and κ flips ±max every tick.
            lockout = (not self._reverse_active
                       and t_now is not None
                       and t_now < self._reverse_lockout_until)
            if (along_to_target < 0.0 or self._reverse_active) \
                    and not lockout:
                cmd = self._reverse_step(a_e_y, along_to_target, t_now)
                if cmd is not None:
                    self._last_v_cmd = abs(cmd[0])
                    return cmd
        else:
            chassis_to_end = hypot(ex - x, ey - y)
            if c_along >= seg_len - 1e-3 \
                    or chassis_to_end <= self._cruise_done_tolerance:
                self._reset_reverse()
                self._last_v_cmd = self._approach_speed
                return 0.0, 0.0, 'reached'

        # ── Forward L1 ───────────────────────────────────────────────
        # Speed schedule. Single smooth ramp on precision segments:
        # outside brake_zone the chassis runs at cruise_speed; inside,
        # v_target ramps LINEARLY from cruise_speed at the zone edge
        # down to min_speed at the target. No creep_zone step (the
        # prior creep_zone/brake_zone two-stage produced a 0.80→0.28
        # cmd v step at the creep_zone boundary that MCU PID couldn't
        # follow — 15:15 mission WP1: chassis blew past cm_capture
        # with real v ≈ 0.6 m/s and landed 21.6 cm past target).
        # Legacy 'dock' (short corridor) keeps its original approach_
        # speed behaviour via the brake_ramp logic below.
        if is_dock:
            v_target = self._approach_speed
        elif precision_kind and target_dist < self._brake_zone_m:
            t_ramp = target_dist / self._brake_zone_m
            v_target = self._min_speed + t_ramp * (
                self._cruise_speed - self._min_speed)
        else:
            v_target = self._cruise_speed
        # L1 distance from current commanded speed, with the segment's
        # target speed as the floor so L1 doesn't collapse to L1_min
        # immediately on segment entry before chassis has accelerated.
        v_for_l1 = max(self._last_v_cmd, v_target)
        l1 = (self._l1_damping / pi) * self._l1_period * v_for_l1

        # Sharp-turn handling. Three regimes by |e_psi|:
        #   (a) ≤ thresh (45°): normal L1, no boost.
        #   (b) thresh..π/2 (45-90°): progressive lookahead boost — linear
        #       interp from sharp_turn_l1_min at the threshold up to
        #       l1_max at 90°. The chassis traces a wide, gentle arc
        #       without κ saturation.
        #   (c) > π/2 (90-180°): forward L1 cannot widen its arc fast
        #       enough — the lookahead falls behind the chassis at large
        #       e_psi, η wraps near ±π, sin(η)→0, and κ collapses to ~0
        #       (14:52 mission WP1, e_psi=-170°: chassis drifted 8 m in
        #       the WRONG direction at v=0.15 m/s before E-stop). Under
        #       this branch we drop normal L1 and command saturated κ
        #       in the rotation-closing direction at creep speed —
        #       chassis pivots close-to-in-place until e_psi drops
        #       under 90°, then the next tick rejoins regime (b).
        e_psi_seg = abs(normalize_angle(psi - psi_path))
        if e_psi_seg > pi / 2:
            # Backward K-turn override. When chassis ψ is more than
            # 90° off the corridor direction, forward saturated κ
            # arcs sweep the chassis ~1 m sideways from the corridor
            # before alignment completes (15:00 mission WP1 trace:
            # e_y -36→-163 cm during a 5 s forward rotation, then
            # 4 s of L1 lateral closure to re-attack the corridor).
            # Instead REVERSE during the rotation: chassis backs
            # away from the target while turning, with the same
            # saturated κ closing |e_psi|. Once e_psi falls under
            # π/2 the next tick drops out of this branch and forward
            # L1 takes over — chassis is now pointed at the target
            # from ~1 m past the start, and approaches cleanly.
            # Sign derivation: ψ̇ = v·κ. In reverse v<0; we want
            # ψ̇ opposite to sign(e_psi_signed) to close the angle.
            # → sign(v·κ) = -sign(e_psi); with v<0, sign(κ) =
            # sign(e_psi). So κ = sign(e_psi_signed) × max.
            e_psi_signed = normalize_angle(psi - psi_path)
            if e_psi_signed > 0:
                kappa_t = self._max_curvature
            elif e_psi_signed < 0:
                kappa_t = -self._max_curvature
            else:
                kappa_t = 0.0
            kappa_t = self._clamp_curvature(kappa_t)
            # Reverse at approach_speed magnitude. ψ̇ ≈ 39°/s, so
            # 90° rotation takes ~2.3 s with chassis backing ~1 m
            # AWAY from the target — out of any wide-arc corridor
            # divergence path. Forward-only reverse-recovery
            # interlock doesn't apply here (this isn't a target
            # overshoot, it's an angle-too-large condition).
            self._last_v_cmd = self._approach_speed
            return -self._approach_speed, kappa_t, 'tracking'

        if e_psi_seg <= self._sharp_turn_thresh:
            l1_min_eff = self._l1_min
        else:
            # Linear interp from sharp_turn_l1_min at the threshold up
            # to l1_max at 90°. Beyond 90° the override above takes
            # over, so this branch never sees e_psi_seg > π/2.
            t = (e_psi_seg - self._sharp_turn_thresh) / \
                (pi / 2 - self._sharp_turn_thresh)
            l1_min_eff = self._sharp_turn_l1_min + t * (
                self._l1_max - self._sharp_turn_l1_min)

        if l1 < l1_min_eff:
            l1 = l1_min_eff
        elif l1 > self._l1_max:
            l1 = self._l1_max

        # Lookahead point: advance chassis projection by L1 along path.
        # For precision segments (dock + l1), cap at target_along so we
        # don't carrot PAST the target (which would command continued
        # forward motion after the antenna is at the dock pose).
        look_along = c_along + l1
        if precision_kind:
            t_along, _ = project_onto_line(tx, ty, sx, sy, psi_path)
            if look_along > t_along:
                look_along = t_along
        cos_p, sin_p = cos(psi_path), sin(psi_path)
        lx = sx + look_along * cos_p
        ly = sy + look_along * sin_p

        # η = bearing from chassis to lookahead, minus chassis heading.
        eta = normalize_angle(atan2(ly - y, lx - x) - psi)
        # κ = 2·sin(η) / L1. We use the L1 nominal (not the actual
        # chassis-to-lookahead distance) so that large lateral offsets
        # don't shrink the effective denominator and amplify κ beyond
        # the path's natural geometry.
        kappa = 2.0 * sin(eta) / l1
        kappa = self._clamp_curvature(kappa)

        # ── Regulated speed (Macenski/Nav2 RPP) ──────────────────────
        # Slow on tight curvature: speed *= κ_lim/|κ| capped at 1.
        kappa_scale = 1.0
        if abs(kappa) > self._kappa_lim:
            kappa_scale = self._kappa_lim / abs(kappa)
        # Slow on large cross-track residual. Use antenna e_y on
        # precision segments (cm precision target), chassis e_y on
        # cruise (path-follow without cm requirement at end).
        e_y_for_reg = a_e_y if precision_kind else c_e_y
        e_y_scale = 1.0 - self._e_y_gain * abs(e_y_for_reg)
        if e_y_scale < self._e_y_speed_floor:
            e_y_scale = self._e_y_speed_floor

        speed = v_target * kappa_scale * e_y_scale
        # Legacy 'dock' segments still need a separate brake_ramp
        # because their v_target is fixed at approach_speed; the
        # cruise_speed→min_speed linear ramp above only applies to
        # 'l1' (unified) segments. For 'dock', keep the old
        # brake_min_frac asymptote (0.40 × 0.175 = 0.07 m/s).
        if is_dock and target_dist < self._brake_zone_m:
            brake_ramp = target_dist / self._brake_zone_m
            if brake_ramp < self._brake_min_speed_frac:
                brake_ramp = self._brake_min_speed_frac
            speed *= brake_ramp
        # Hard floor so PID deadband (0.05 m/s) doesn't freeze the
        # chassis short of cm-capture. Default 0.07 m/s matches the
        # legacy DockTracker's effective stop floor (creep_speed ×
        # brake_min_speed_frac = 0.10 × 0.70).
        if speed < self._min_speed:
            speed = self._min_speed

        self._last_v_cmd = speed
        return speed, kappa, 'tracking'
