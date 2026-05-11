"""Path planner: turn waypoints into chassis-frame segments with antenna docks.

The user clicks a target on the map. That target is where the **GPS antenna**
should land, because that's the only quantity we can observe at cm precision.
The chassis (rear axle) needs to be elsewhere — at `target - R(ψ_dock)·offset`
— and pointed along ψ_dock so that as it crosses the dock point, the antenna
crosses the target.

Per waypoint we generate:
  1. A *Reed-Shepp* cruise — the shortest path from the chassis's current
     pose to the dock entry pose, respecting the chassis minimum turning
     radius AND allowing both forward and reverse motion. Decomposed into
     short straight sub-segments along each Reed-Shepp primitive; each
     sub-segment carries its motion direction so the cruise tracker can
     command +v or −v accordingly.
  2. A straight dock segment from the corridor entry to the chassis dock
     pose. State-feedback line follower handles this in forward.

Reed-Shepp replaced the earlier forward-only Dubins cruise because the
Dubins planner produced ~1.5 m loops whenever consecutive waypoints sat
inside the chassis turning circle (e.g. WP1→WP2 in the 15:15 mission
trace cycled 1.5 m around a left-right circuit before reaching the dock
entry, ~5 s of wasted motion). Reed-Shepp's reverse leg lets the chassis
back up a few centimetres and then approach the goal directly when that's
shorter than circling forward.

ψ_dock is chosen as:
  - For the first waypoint, the bearing from current chassis position to
    the waypoint. (Drives the antenna roughly straight at the target.)
  - For subsequent waypoints, the bearing from the previous waypoint to
    the current one, so consecutive cones are connected by a smooth corridor.
  - For return-to-start, the bearing from the last waypoint back to start.

The planner is purely geometric — no controller state — so it can be regen-
erated cheaply if the operator skips a waypoint or restarts mid-mission.
"""

from math import atan2, cos, sin, hypot

from pilot.lib.geo_utils import enu_from_gps, normalize_angle
from pilot.lib.reed_shepp import plan as _reed_shepp_plan, sample as _reed_shepp_sample


# Floor on the dock corridor length. The dock tracker needs enough along-
# corridor distance for the chassis to close any lateral residual at
# creep speed without overshooting the target along-track and triggering
# reverse. 0.6 m gives the forward state-feedback law enough corridor to
# bleed lateral while still being well inside the 2.5 m default
# dock_distance for normally-spaced waypoints.
_DOCK_DISTANCE_FLOOR_M = 0.6

# Default chassis minimum turning radius if not supplied. Computed from
# the current rover (wheelbase 0.33 m, max_steering 30.5°):
#   rho = wheelbase / tan(max_steer) = 0.33 / tan(30.5°) ≈ 0.561 m
# Caller should pass the current value explicitly via `turning_radius`.
_DEFAULT_TURNING_RADIUS_M = 0.56

# Reed-Shepp sample step for cruise decomposition. Each primitive (arc
# or straight) of the Reed-Shepp path is discretised at this step into
# straight sub-segments. 0.15 m keeps the chord-vs-arc deviation under
# 0.5 cm on the tightest planned arc (rho = 0.56 m, sweep = 0.27 rad,
# half-chord deviation = rho·(1-cos(sweep/2)) ≈ 5 mm at 0.30 m, ≈ 1.3
# mm at 0.15 m). The 0.30 m original gave 5 mm "false" lateral that
# Stanley with k_lat=4 reacted to on every sub-seg boundary —
# desired-offset jumped ~5°·k between adjacent sub-segs, kappa flipped
# sign tick-by-tick, and the chassis traced a ±10° heading wiggle on
# what should have been a single smooth arc (16:47 WP0 return cruise
# trace, ~13 kappa sign-flips over 9 s). 0.15 m holds wiggle under
# 1 cm of arc-correction noise without blowing up the sub-seg count
# (longest cruise: 30 sub-segs vs 15, still trivial vs 50 ms tick
# rate). cruise_done_tolerance (0.20 m) now spans 1-2 sub-segs so the
# done condition still fires cleanly without burning through several
# trailing sub-segs at zero speed.
_CRUISE_SAMPLE_STEP_M = 0.15

# Penalty added to Reed-Shepp candidate length per direction switch in
# the candidate's primitive word. 1.0 m matches the worst-case wasted
# motion per switch (1.5 s of MCU accel_limit ramp through zero from
# 0.5 m/s forward to 0.5 m/s reverse). With penalty=1.0 the planner
# prefers a Dubins-style forward arc over a 1-switch Reed-Shepp word
# unless the Reed-Shepp saving is > 1 m, and over a 2-switch word
# unless saving > 2 m. The 16:47 WP1→WP2 trace selected a 2-switch
# word saving ~1.5 m vs Dubins; with penalty 1.0 the same case will
# pick Dubins (cost +0.5 m forward).
_DIRECTION_SWITCH_PENALTY_M = 1.0


class PathSegment:
    __slots__ = ('kind', 'start_pose', 'end_pose', 'target_antenna',
                 'waypoint_index', 'direction', 'dist_to_dock')

    def __init__(self, kind, start_pose, end_pose, target_antenna,
                 waypoint_index, direction=1, dist_to_dock=0.0):
        # kind: 'cruise' | 'dock'
        # *_pose: (x, y, psi_math)
        # target_antenna: (e, n) ENU of the antenna's intended landing point
        # waypoint_index: 0-based index into the original waypoint list, or
        #                 -1 for the synthetic return-to-start segment.
        # direction: +1 forward, -1 reverse. Cruise sub-segments inherit
        #            the sign from the Reed-Shepp primitive they were
        #            sampled from; dock is always forward.
        # dist_to_dock: cumulative metres from this sub-seg's END pose
        #            forward through all remaining cruise sub-segs to
        #            the dock corridor entry. 0 on the LAST cruise sub-
        #            seg before dock, and on dock segments themselves.
        #            The cruise tracker needs this so its handoff_blend
        #            taper (cruise_speed → approach_speed over the last
        #            1 m before dock) keys on the *path* remaining, not
        #            on the current sub-seg's residual length — without
        #            it, every sub-seg shorter than handoff_blend cuts
        #            speed to approach_speed and the chassis tops out at
        #            ~0.5 m/s on what should be a long cruise stretch
        #            (16:47 trace: cruise_speed=1.0 yaml-configured,
        #            actual cmd peaked at 0.61 m/s).
        self.kind = kind
        self.start_pose = start_pose
        self.end_pose = end_pose
        self.target_antenna = target_antenna
        self.waypoint_index = waypoint_index
        self.direction = int(direction)
        self.dist_to_dock = float(dist_to_dock)

    def __repr__(self):  # pragma: no cover - debug only
        sign = '+' if self.direction >= 0 else '-'
        return (f'PathSegment({self.kind}{sign} wp={self.waypoint_index} '
                f'start={self.start_pose} end={self.end_pose} '
                f'd2d={self.dist_to_dock:.2f})')


def _dock_chassis_pose(target_e, target_n, psi_dock, antenna_offset):
    """Chassis pose so that the antenna sits at (target_e, target_n)."""
    a_x, a_y = antenna_offset
    cp, sp = cos(psi_dock), sin(psi_dock)
    ox = cp * a_x - sp * a_y
    oy = sp * a_x + cp * a_y
    return target_e - ox, target_n - oy, psi_dock


def _expand_cruise(start_pose, end_pose, target_antenna, waypoint_index,
                   turning_radius, sample_step):
    """Decompose a Reed-Shepp path from start_pose to end_pose into a list
    of straight cruise sub-segments carrying motion direction.

    Each sample-to-sample chord becomes one PathSegment whose direction
    matches the Reed-Shepp sample's motion_sign. The last sub-segment's
    end_pose.psi is forced to the corridor (dock) heading so the
    cruise→dock handoff has e_psi ≈ 0.

    The Reed-Shepp plan is requested with ``require_forward_end=True``
    so that the final sub-segment is always a forward motion — the
    dock state-feedback tracker only supports forward, and a reverse-
    ending cruise would force a direction switch right at the cruise→
    dock boundary while Stanley is trying to lock corridor alignment.

    Each PathSegment carries a ``dist_to_dock`` field equal to the
    cumulative chord length from the sub-segment's END pose forward
    through all later sub-segments to the dock corridor entry. The
    cruise tracker uses (dist_to_end + dist_to_dock) as the effective
    handoff-blend distance, so cruise_speed is held across the whole
    Reed-Shepp path and only tapers into approach_speed on the final
    metre — instead of tapering on every 0.15-0.30 m sub-segment.
    """
    sx, sy, _ = start_pose
    ex, ey, dock_psi = end_pose
    rs = _reed_shepp_plan(start_pose, end_pose, turning_radius,
                          switch_penalty_m=_DIRECTION_SWITCH_PENALTY_M,
                          require_forward_end=True)
    if rs is None or rs.length < 1e-3:
        # Degenerate: chassis already at goal pose, or pose pair the
        # planner doesn't admit (Reed-Shepp 1990 Theorem 1 says this
        # shouldn't happen for rho > 0, but we keep the safety arm).
        if hypot(ex - sx, ey - sy) < 1e-6:
            return []
        chord_psi = atan2(ey - sy, ex - sx)
        return [PathSegment(
            'cruise',
            (sx, sy, chord_psi),
            (ex, ey, chord_psi),
            target_antenna,
            waypoint_index,
            direction=1,
            dist_to_dock=0.0,
        )]

    pts = _reed_shepp_sample(rs, sample_step)
    # pts = [(x, y, psi, motion_sign), ...], first sample carries
    # motion_sign = 0 (start point), rest are +1/-1.
    raw_subs = []  # (x0, y0, x1, y1, sign1, chord)
    for i in range(len(pts) - 1):
        x0, y0, _, _ = pts[i]
        x1, y1, _, sign1 = pts[i + 1]
        chord = hypot(x1 - x0, y1 - y0)
        if chord < 1e-9:
            continue
        raw_subs.append((x0, y0, x1, y1, sign1, chord))
    if not raw_subs:
        return []

    # Walk in reverse to compute dist_to_dock for each sub-segment:
    # the LAST sub's dist_to_dock = 0 (its end IS the dock entry), and
    # each earlier sub's dist_to_dock = next sub's dist_to_dock + next
    # sub's chord length.
    dist_to_dock = [0.0] * len(raw_subs)
    for j in range(len(raw_subs) - 2, -1, -1):
        dist_to_dock[j] = dist_to_dock[j + 1] + raw_subs[j + 1][5]

    sub_segments = []
    for idx, (x0, y0, x1, y1, sign1, _chord) in enumerate(raw_subs):
        # Chord heading is the direction of travel along this sub-
        # segment, set on both start_pose and end_pose. The cruise
        # tracker reads segment.direction (+1/-1) and projects the
        # chassis facing onto the motion direction before computing
        # e_psi, so we don't need to embed the chassis-facing-pi
        # convention here.
        chord_psi = atan2(y1 - y0, x1 - x0)
        sub_segments.append(PathSegment(
            'cruise',
            (x0, y0, chord_psi),
            (x1, y1, chord_psi),
            target_antenna,
            waypoint_index,
            direction=sign1 if sign1 != 0 else 1,
            dist_to_dock=dist_to_dock[idx],
        ))
    # Force the final cruise sub-segment's end heading to the dock
    # heading so the handoff has e_psi ≈ 0. require_forward_end above
    # guarantees the last motion is forward.
    if sub_segments:
        last = sub_segments[-1]
        sub_segments[-1] = PathSegment(
            last.kind,
            last.start_pose,
            (last.end_pose[0], last.end_pose[1], dock_psi),
            last.target_antenna,
            last.waypoint_index,
            direction=last.direction,
            dist_to_dock=0.0,
        )
    return sub_segments


def plan(current_chassis_pose, antenna_offset,
         waypoints_lat_lng, ref_lat_lon,
         dock_distance, return_to_start=False, start_chassis_xy=None,
         waypoint_index_offset=0,
         turning_radius=_DEFAULT_TURNING_RADIUS_M,
         dubins_sample_step=_CRUISE_SAMPLE_STEP_M):
    """Build the segment list for a mission.

    `dubins_sample_step` retains its old name for parameter backward
    compatibility; semantically it's the Reed-Shepp sample step now.
    """
    ref_lat, ref_lon = ref_lat_lon
    cur_x, cur_y, cur_psi = current_chassis_pose

    wp_enu = [enu_from_gps(wp['lat'], wp['lng'], ref_lat, ref_lon)
              for wp in waypoints_lat_lng]

    segments = []
    prev_target = None

    for idx, (wp_e, wp_n) in enumerate(wp_enu):
        if prev_target is None:
            psi_dock = atan2(wp_n - cur_y, wp_e - cur_x)
            span = hypot(wp_e - cur_x, wp_n - cur_y)
        else:
            prev_e, prev_n = prev_target
            psi_dock = atan2(wp_n - prev_n, wp_e - prev_e)
            span = hypot(wp_e - prev_e, wp_n - prev_n)

        psi_dock = normalize_angle(psi_dock)
        effective_dock = min(dock_distance, max(0.5 * span, _DOCK_DISTANCE_FLOOR_M))
        dock_x, dock_y, _ = _dock_chassis_pose(wp_e, wp_n, psi_dock, antenna_offset)
        entry_x = dock_x - effective_dock * cos(psi_dock)
        entry_y = dock_y - effective_dock * sin(psi_dock)

        seg_wp_idx = idx + waypoint_index_offset
        sub_segs = _expand_cruise(
            (cur_x, cur_y, cur_psi),
            (entry_x, entry_y, psi_dock),
            (wp_e, wp_n),
            seg_wp_idx,
            turning_radius,
            dubins_sample_step,
        )
        segments.extend(sub_segs)
        segments.append(PathSegment(
            'dock', (entry_x, entry_y, psi_dock),
            (dock_x, dock_y, psi_dock), (wp_e, wp_n), seg_wp_idx,
            direction=1,
        ))

        cur_x, cur_y, cur_psi = dock_x, dock_y, psi_dock
        prev_target = (wp_e, wp_n)

    if return_to_start and start_chassis_xy is not None:
        start_x, start_y = start_chassis_xy
        psi_dock = atan2(start_y - cur_y, start_x - cur_x)
        psi_dock = normalize_angle(psi_dock)
        span = hypot(start_x - cur_x, start_y - cur_y)
        effective_dock = min(dock_distance, max(0.5 * span, _DOCK_DISTANCE_FLOOR_M))
        dock_x, dock_y, _ = _dock_chassis_pose(start_x, start_y, psi_dock, antenna_offset)
        entry_x = dock_x - effective_dock * cos(psi_dock)
        entry_y = dock_y - effective_dock * sin(psi_dock)
        sub_segs = _expand_cruise(
            (cur_x, cur_y, cur_psi),
            (entry_x, entry_y, psi_dock),
            (start_x, start_y),
            -1,
            turning_radius,
            dubins_sample_step,
        )
        segments.extend(sub_segs)
        segments.append(PathSegment(
            'dock', (entry_x, entry_y, psi_dock),
            (dock_x, dock_y, psi_dock), (start_x, start_y), -1,
            direction=1,
        ))

    return segments
