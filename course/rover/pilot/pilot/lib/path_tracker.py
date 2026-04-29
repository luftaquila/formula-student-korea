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
    """Pure Pursuit toward end_pose with D-term damping on alpha."""

    def __init__(self, params):
        self._cruise_speed = float(params['cruise_speed'])
        self._lookahead_min = float(params['pp_lookahead_min'])
        self._lookahead_gain = float(params['pp_lookahead_gain'])
        self._damping = float(params['pp_damping'])
        self._max_curvature = float(params['max_curvature'])
        self._cruise_done_tolerance = float(params['cruise_done_tolerance'])
        # Slow down as |α| grows; never below this fraction of cruise.
        self._min_speed_fraction = 0.35
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

        speed = self._cruise_speed
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
        speed = self._cruise_speed * speed_scale

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
              (positive when the line is to the LEFT of antenna heading)
        e_ψ = chassis ψ - psi_path     (signed, [-π, π])

    Curvature command:
        κ = -k_y · e_y − k_ψ · e_ψ

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
        self._max_curvature = float(params['max_curvature'])
        self._wheelbase = float(params['wheelbase'])
        self._max_steering_rad = float(params['max_steering_angle_rad'])
        self._approach_tolerance = float(params['approach_tolerance'])
        self._creep_zone = float(params['creep_zone'])
        # Antenna offset is needed to compute antenna position from chassis
        # pose without round-tripping through the estimator (so this module
        # has no side effects on estimator state).
        self._a_x = float(params['antenna_offset_x'])
        self._a_y = float(params['antenna_offset_y'])

    def reset(self):
        pass

    def _antenna_world(self, chassis_pose):
        x, y, psi = chassis_pose
        cp, sp = cos(psi), sin(psi)
        return (x + cp * self._a_x - sp * self._a_y,
                y + sp * self._a_x + cp * self._a_y)

    def step(self, chassis_pose, segment, antenna_world=None):
        """Return (speed_cmd, kappa_cmd, status).

        status: 'tracking' | 'reached'
        'reached' is set when the antenna has reached the target waypoint
        within `approach_tolerance` AND the chassis has crossed the dock
        end along the path direction (so we're not declaring done while
        still overshooting laterally).
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

        # State feedback. Negative e_y (antenna to the LEFT of path) wants
        # to come right → negative κ (right turn) → κ ∝ -e_y. Positive e_ψ
        # (chassis pointing CCW from path) wants to come back → negative κ
        # (right turn). Hence both terms negate.
        kappa = -self._k_y * e_y - self._k_psi * e_psi

        # Clamp to physical curvature.
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
