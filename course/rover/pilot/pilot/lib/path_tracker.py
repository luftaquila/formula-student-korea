"""Per-segment path trackers.

Two control laws, one per segment kind:

  • CruiseTracker — Stanley line follower. Regulates chassis ψ toward a
    desired ψ that biases toward the cruise corridor by atan2(k_lat·e_y, v).
    Speed scales with cos(e_psi_corrected) so the rover slows as the
    corrected heading error grows, keeping GPS heading-of-motion
    measurement noise low. Was Pure Pursuit + D damping until the 04:16
    figure-8 incident on chassis ψ way off corridor — Stanley actively
    aligns chassis ψ with the corridor instead of chasing a lookahead
    point, eliminating the PP orbit pathology.

  • DockTracker — Stanley line follower on the *antenna*'s lateral error
    with an integral term for κ-bias rejection. Operating on the antenna
    e_y (rather than the chassis') is what makes the antenna land on the
    user-clicked target even when the antenna is offset from the rear
    axle. The chassis frame Lyapunov analysis yields the legacy dual-P
    form κ = -k_y·e_y_antenna - k_ψ·e_ψ; the Stanley refinement uses
    atan2(k_y·e_y, v) for the desired offset which gives perpendicular
    closure at low v and a pure heading regulator at small e_y.

Both trackers consume an immutable PathSegment + the live chassis pose +
the antenna ENU position, and return (v_cmd, κ_cmd, done?). Internal
state is kept on the tracker instance (dock integral, cruise zero-cross
direction memory) so navigator can hand off cleanly between cruise and
dock without losing controller state continuity.
"""

from math import atan2, cos, sin, hypot, tan

from pilot.lib.geo_utils import normalize_angle, project_onto_line


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
        # Zero-cross gate threshold. When a new cruise sub-segment has a
        # different direction sign than the previously executed one (i.e.
        # Reed-Shepp asks for a forward→reverse or reverse→forward
        # transition mid-cruise), command v=0 until measured chassis
        # speed magnitude drops below this value. Without the gate, the
        # MCU accel_limit (0.8 m/s²) takes ~1.5 s to ramp setpoint from
        # +0.5 m/s through zero to −0.5 m/s — during which the chassis
        # drifts forward under inertia while the cruise tracker thinks
        # it is already reversing. 16:47 WP2 trace: cmd v=−0.68 at
        # t=23.36 s, chassis still moving +0.30 m east at t=24.36 s,
        # only reversed by t=25.41 s — by which point chassis was 0.65
        # m past the planned dock entry and dock opened at |e_y|=43 cm.
        # 0.10 m/s threshold is well above MCU PID deadband (0.05 m/s)
        # so the gate releases as soon as the chassis is genuinely at
        # rest, not on encoder noise.
        self._zero_cross_speed_threshold = float(
            params.get('cruise_zero_cross_speed_threshold', 0.10))
        # Persistent last-executed direction across step() calls. None
        # means "no prior cruise sub-seg executed yet"; +1/-1 once the
        # tracker has commanded motion in that direction. reset()
        # clears this so the navigator can flush state at cruise→dock
        # boundaries.
        self._last_direction = None
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
        # Stanley k_lat is the gain inside atan2(k_lat * e_y, v). Common
        # values in the literature are 0.5–1.0; 2.0 (the original guess
        # carried over from the dual-P era) gives a 24° desired-offset
        # for only e_y = 5 cm at v = 0.4, so a 10 cm bounce across the
        # corridor swings the chassis target heading 48° — full
        # left-right wari-gari with no dwell on the corridor. Dropped
        # to 1.0 (≈12°/5 cm) so chassis can track without slamming
        # back and forth on noise.
        # k_lat 2.5 -> 4.0: 15:01 mission WP4 dock final approach (e_y=
        # 1.6 cm, e_psi=-4.5°, dist=8.6 cm) gave kappa=-0.03, chassis
        # crawled the last cm with no meaningful turn. At k_lat=4 the
        # same residual yields desired_offset=7.3° → e_psi_corrected=
        # +2.8° → kappa=-0.15 (5× larger), so the final cm closes under
        # real steering instead of inertia.
        # cap 0.61 -> 0.52 (35° -> 30°): large e_y cases saturate the
        # cap rather than the chassis curvature, but a tighter cap
        # reduces the over-rotation during S-shaped cruise (15:01 WP5
        # cruise: 67° rotation in 4 s, chassis ended 60 cm off corridor
        # entry). cap 30° still admits 4 m of lateral closure per meter
        # forward — strong enough for real corridors, gentle enough to
        # avoid cross-and-swing-back.
        # k_heading 2.0 -> 3.0: the heading regulator now responds 1.5×
        # faster, which closes both the final-approach precision gap and
        # the S-curve overshoot in tandem.
        self._k_lat = float(params.get('cruise_k_lat', 4.0))
        self._k_heading = float(params.get('cruise_k_heading', 3.0))
        # cap 30° → 15°: the 16:38 trace showed cruise→dock handoff
        # with e_y = 7 cm + e_psi = +2° drove desired_offset to the cap
        # (29.2°), Stanley commanded saturated kappa, and chassis
        # crossed the corridor 23 cm in one second. Then the same
        # mechanism flipped sign and crossed back 26 cm (the wari-gari
        # the operator reported). cap 15° at k_lat=4 means e_y ≥ 4 cm
        # already saturates, but the saturation level is gentler
        # (chassis still rotates ~20°/s instead of 39°/s), so the
        # cross is < corridor width and chassis converges instead of
        # overshooting. Final approach (e_y < 2 cm) doesn't hit the
        # cap so precision is unchanged.
        self._stanley_offset_cap = float(
            params.get('cruise_stanley_offset_cap_rad', 0.262))

    def reset(self):
        # Stanley itself has no per-segment state to clear. The zero-
        # cross gate's `_last_direction` is deliberately NOT reset here
        # — the navigator calls reset() between every Reed-Shepp sub-
        # segment (kind = 'cruise') on done=True, and if reset() wiped
        # `_last_direction` the gate could never fire on direction
        # switches across sub-seg boundaries (which is exactly where
        # Reed-Shepp puts them). The 17:18 WP6 trace shows this
        # failure mode: a reverse sub-seg ran to completion at
        # chassis_v=-0.38 m/s, the next forward sub-seg got cmd v=
        # +0.84 m/s without the gate ever activating because the
        # intervening reset() had cleared the history. `_last_direction`
        # is set in __init__ and updated only inside step(); it
        # survives mission state transitions because chassis_v is at
        # rest after ERROR / SETTLING / SPRAYING anyway, so a stale
        # value cannot incorrectly gate a fresh leg.
        pass

    def step(self, chassis_pose, segment, t_now, chassis_v=None):
        x, y, psi = chassis_pose
        sx, sy, psi_path = segment.start_pose
        ex, ey, _ = segment.end_pose
        # Direction: +1 forward, -1 reverse. For reverse sub-segments
        # the chassis's direction of *travel* is psi + π (the rear axle
        # leads), so Stanley's control quantities must be computed
        # against that effective heading rather than the chassis facing.
        direction = getattr(segment, 'direction', 1)
        if direction < 0:
            effective_psi = normalize_angle(psi + 3.141592653589793)
        else:
            effective_psi = psi
        dx, dy = ex - x, ey - y
        dist_to_end = hypot(dx, dy)

        # Corridor projection: a_along is signed distance from start
        # along psi_path; e_y is signed lateral (positive = chassis on
        # LEFT of corridor heading).
        a_along, e_y = project_onto_line(x, y, sx, sy, psi_path)
        seg_len = hypot(ex - sx, ey - sy)
        e_psi_raw = normalize_angle(effective_psi - psi_path)

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

        # Zero-cross gate. Reed-Shepp can hand us a sub-seg whose
        # direction differs from the previously executed one. If the
        # chassis hasn't yet decelerated through zero, sending the new
        # signed-speed command immediately would let the MCU accel_limit
        # ramp setpoint smoothly through zero while the chassis itself
        # continues drifting in the *old* direction for ~1 s — which is
        # what produced the WP2 catastrophe in the 16:47 trace. Hold the
        # gate closed (v=0, kappa=0) until either chassis_v signals the
        # chassis has actually slowed below threshold, or chassis_v is
        # unavailable (caller didn't pass it — backward compat for the
        # existing tests; production callers always pass it).
        if (self._last_direction is not None
                and direction != self._last_direction
                and chassis_v is not None
                and abs(chassis_v) > self._zero_cross_speed_threshold):
            return 0.0, 0.0, False

        # Speed taper: handoff blend now keys on the *remaining cruise
        # distance to the dock corridor entry*, not on the current sub-
        # segment's residual length. The planner stamps each cruise
        # sub-seg with dist_to_dock (= cumulative metres from this sub-
        # seg's end through all later sub-segs to the dock entry); the
        # taper begins when (dist_to_end + dist_to_dock) drops below
        # handoff_blend_distance, i.e. on the genuine final approach.
        # Before that, target_speed is held at cruise_speed across
        # arbitrarily many short Reed-Shepp sub-segs.
        dist_to_dock = getattr(segment, 'dist_to_dock', 0.0)
        remaining_to_dock = dist_to_end + dist_to_dock
        if (self._handoff_blend_distance > 1e-6
                and remaining_to_dock < self._handoff_blend_distance):
            denom = max(1e-6,
                        self._handoff_blend_distance - self._cruise_done_tolerance)
            blend = max(0.0, min(1.0,
                                 (remaining_to_dock - self._cruise_done_tolerance) / denom))
            target_speed = (self._approach_speed
                            + blend * (self._cruise_speed - self._approach_speed))
        else:
            target_speed = self._cruise_speed

        # Stanley feedforward — same structure as DockTracker.step.
        # Use target_speed (pre-scale) for the atan2 denominator: at
        # high speed the desired-offset stays small (gentle bias toward
        # corridor); at low speed it saturates near pi/2 (perpendicular
        # entry).
        # v_eff floor sized to the speed at which Stanley's atan2
        # responds smoothly to e_y. Too low (≈creep speed) and the
        # arctan saturates near pi/2 on every cm of e_y — wari-gari.
        # 0.5 m/s gives a desired_offset of 11°/5 cm e_y at k_lat=1,
        # which is a real correction the chassis can track without
        # ringing.
        v_eff = max(target_speed, 0.5)
        desired_offset = atan2(self._k_lat * e_y, v_eff)
        # Cap the desired offset. Without this, large lateral residuals
        # (cruise often starts with e_y ~ 0.3 m off-corridor when the
        # previous dock ended pointing 60° off the next corridor) drive
        # desired_offset toward ±pi/2 — chassis points nearly perpen-
        # dicular to the corridor, saturated kappa for several seconds,
        # overshoots the corridor, flips e_y sign, swings back. The
        # 13:33:57 mission showed 4 s of k=-1.70 followed by a flipped
        # k=+1.46 reverse — the wari-gari the operator reported. 35°
        # cap keeps Stanley's lateral closure rate respectable
        # (v·sin(35°) ≈ 0.57·v) without driving the chassis at the
        # corridor like a battering ram.
        offset_cap = self._stanley_offset_cap
        if desired_offset > offset_cap:
            desired_offset = offset_cap
        elif desired_offset < -offset_cap:
            desired_offset = -offset_cap
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

        # Record the direction we are about to command so the zero-
        # cross gate can detect transitions on the next call.
        self._last_direction = direction

        # Reverse motion: signed speed (mcu_bridge / ackermann_convert
        # accept negative speed) and flip kappa because chassis ψ̇ = v·κ
        # — with v < 0 the same kappa rotates the chassis the *wrong*
        # way for closing e_psi_corrected, so the cruise tracker must
        # negate kappa to drive the heading regulator in the right
        # direction.
        if direction < 0:
            return -speed, -kappa, False
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
