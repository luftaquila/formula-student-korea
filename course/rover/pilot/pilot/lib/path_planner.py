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
# straight sub-segments. 0.30 m balances (a) inscribed-polygon error
# on tight arcs (≤ 5 mm at rho = 0.56) and (b) keeping
# cruise_done_tolerance = 0.20 m from tripping on every adjacent sub.
_CRUISE_SAMPLE_STEP_M = 0.30


class PathSegment:
    __slots__ = ('kind', 'start_pose', 'end_pose', 'target_antenna',
                 'waypoint_index', 'direction')

    def __init__(self, kind, start_pose, end_pose, target_antenna,
                 waypoint_index, direction=1):
        # kind: 'cruise' | 'dock'
        # *_pose: (x, y, psi_math)
        # target_antenna: (e, n) ENU of the antenna's intended landing point
        # waypoint_index: 0-based index into the original waypoint list, or
        #                 -1 for the synthetic return-to-start segment.
        # direction: +1 forward, -1 reverse. Cruise sub-segments inherit
        #            the sign from the Reed-Shepp primitive they were
        #            sampled from; dock is always forward.
        self.kind = kind
        self.start_pose = start_pose
        self.end_pose = end_pose
        self.target_antenna = target_antenna
        self.waypoint_index = waypoint_index
        self.direction = int(direction)

    def __repr__(self):  # pragma: no cover - debug only
        sign = '+' if self.direction >= 0 else '-'
        return (f'PathSegment({self.kind}{sign} wp={self.waypoint_index} '
                f'start={self.start_pose} end={self.end_pose})')


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
    """
    sx, sy, _ = start_pose
    ex, ey, dock_psi = end_pose
    rs = _reed_shepp_plan(start_pose, end_pose, turning_radius)
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
        )]

    pts = _reed_shepp_sample(rs, sample_step)
    # pts = [(x, y, psi, motion_sign), ...], first sample carries
    # motion_sign = 0 (start point), rest are +1/-1.
    sub_segments = []
    for i in range(len(pts) - 1):
        x0, y0, _, _ = pts[i]
        x1, y1, _, sign1 = pts[i + 1]
        if hypot(x1 - x0, y1 - y0) < 1e-9:
            continue
        # Chord heading from start sample to end sample.
        chord_psi = atan2(y1 - y0, x1 - x0)
        # If the sub-segment is a *reverse* sub (chassis backs along
        # the chord), the chassis heading at start AND end is the
        # chord direction PLUS pi (chassis points opposite to its
        # motion). The cruise tracker reads start_pose.psi as the
        # corridor heading; setting it equal to chassis-facing-psi
        # (chord + pi for reverse) keeps Stanley's e_psi computed
        # against the chassis's actual heading rather than its
        # direction of travel.
        if sign1 < 0:
            chassis_psi = normalize_angle(chord_psi + 3.141592653589793)
        else:
            chassis_psi = chord_psi
        sub_segments.append(PathSegment(
            'cruise',
            (x0, y0, chassis_psi),
            (x1, y1, chassis_psi),
            target_antenna,
            waypoint_index,
            direction=sign1 if sign1 != 0 else 1,
        ))
    # Force the final cruise sub-segment's end heading to the dock
    # heading so the handoff has e_psi ≈ 0. Only meaningful when the
    # final motion was forward (which Reed-Shepp normally guarantees
    # for the last sub if the goal pose is reached).
    if sub_segments:
        last = sub_segments[-1]
        sub_segments[-1] = PathSegment(
            last.kind,
            last.start_pose,
            (last.end_pose[0], last.end_pose[1], dock_psi),
            last.target_antenna,
            last.waypoint_index,
            direction=last.direction,
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
