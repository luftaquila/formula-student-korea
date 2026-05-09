"""Path planner: turn waypoints into chassis-frame segments with antenna docks.

The user clicks a target on the map. That target is where the **GPS antenna**
should land, because that's the only quantity we can observe at cm precision.
The chassis (rear axle) needs to be elsewhere — at `target - R(ψ_dock)·offset`
— and pointed along ψ_dock so that as it crosses the dock point, the antenna
crosses the target.

Per waypoint we generate two segments:
  1. Cruise: from the previous chassis pose to the start of a straight
     approach corridor, length = `dock_distance` ahead of the dock pose.
     Pure Pursuit handles this; tolerance is loose.
  2. Dock: a straight line ending at the chassis dock pose with heading
     ψ_dock. State-feedback line follower handles this; tolerance is the
     physical antenna-to-target tolerance.

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


# Floor on the dock corridor length. Below ~0.3 m the chassis can't
# settle its heading on the line before reaching the dock pose, so a
# very short clamp would break the dock tracker's linearisation. If the
# requested span doesn't allow at least this much corridor, the planner
# accepts the squeeze rather than U-turning back.
_DOCK_DISTANCE_FLOOR_M = 0.3


class PathSegment:
    __slots__ = ('kind', 'start_pose', 'end_pose', 'target_antenna', 'waypoint_index')

    def __init__(self, kind, start_pose, end_pose, target_antenna, waypoint_index):
        # kind: 'cruise' | 'dock'
        # *_pose: (x, y, psi_math)
        # target_antenna: (e, n) ENU of the antenna's intended landing point
        # waypoint_index: 0-based index into the original waypoint list, or
        #                 -1 for the synthetic return-to-start segment.
        self.kind = kind
        self.start_pose = start_pose
        self.end_pose = end_pose
        self.target_antenna = target_antenna
        self.waypoint_index = waypoint_index

    def __repr__(self):  # pragma: no cover - debug only
        return (f'PathSegment({self.kind} wp={self.waypoint_index} '
                f'start={self.start_pose} end={self.end_pose})')


def _dock_chassis_pose(target_e, target_n, psi_dock, antenna_offset):
    """Chassis pose so that the antenna sits at (target_e, target_n)."""
    a_x, a_y = antenna_offset
    cp, sp = cos(psi_dock), sin(psi_dock)
    ox = cp * a_x - sp * a_y
    oy = sp * a_x + cp * a_y
    return target_e - ox, target_n - oy, psi_dock


def plan(current_chassis_pose, antenna_offset,
         waypoints_lat_lng, ref_lat_lon,
         dock_distance, return_to_start=False, start_chassis_xy=None,
         waypoint_index_offset=0):
    """Build the segment list for a mission.

    Args:
        current_chassis_pose: (x, y, psi_math) of the chassis at planning time.
        antenna_offset: (a_x, a_y) body-frame offset of the antenna.
        waypoints_lat_lng: list of {'lat', 'lng'} dicts (waypoint = antenna target).
        ref_lat_lon: (ref_lat, ref_lon) for ENU conversion.
        dock_distance: meters of straight approach before the dock pose.
            Must be >= 1× wheelbase + a margin so the chassis can settle
            its heading on the line before reaching the dock point.
        return_to_start: if True, append a synthetic waypoint at start_chassis_xy.
        start_chassis_xy: (x, y) chassis position where the mission started,
            required when return_to_start=True.
        waypoint_index_offset: integer added to each segment's
            waypoint_index. Used by the navigator when re-planning a
            partial mission (after a skip) so the segment indices continue
            to align with the original full waypoint list.

    Returns:
        List of PathSegment, ordered. Each waypoint contributes (cruise, dock);
        return-to-start contributes (cruise, dock) too.
    """
    ref_lat, ref_lon = ref_lat_lon
    cur_x, cur_y, cur_psi = current_chassis_pose

    # Convert waypoint lat/lon → ENU once.
    wp_enu = [enu_from_gps(wp['lat'], wp['lng'], ref_lat, ref_lon)
              for wp in waypoints_lat_lng]

    segments = []
    prev_target = None  # antenna ENU of the previous waypoint, for dock heading

    for idx, (wp_e, wp_n) in enumerate(wp_enu):
        if prev_target is None:
            # First waypoint: dock heading = bearing from CURRENT chassis to
            # waypoint. Picking chassis-to-target rather than antenna-to-
            # target is intentional — at planning time the antenna may be
            # behind a slightly-off chassis ψ (e.g. fresh out of calibration);
            # using chassis position keeps the dock corridor aligned with how
            # the rover will actually approach.
            psi_dock = atan2(wp_n - cur_y, wp_e - cur_x)
            span = hypot(wp_e - cur_x, wp_n - cur_y)
        else:
            prev_e, prev_n = prev_target
            psi_dock = atan2(wp_n - prev_n, wp_e - prev_e)
            span = hypot(wp_e - prev_e, wp_n - prev_n)

        psi_dock = normalize_angle(psi_dock)
        # Clamp the dock corridor to half the span between consecutive
        # antenna targets so the entry point doesn't sit BEHIND the
        # previous waypoint. With dock_distance=1.5 m and 1 m cone-to-
        # cone spacing the original code projected the entry 50 cm
        # behind the previous cone, making the cruise leg a U-turn.
        effective_dock = min(dock_distance, max(0.5 * span, _DOCK_DISTANCE_FLOOR_M))
        dock_x, dock_y, _ = _dock_chassis_pose(wp_e, wp_n, psi_dock, antenna_offset)
        entry_x = dock_x - effective_dock * cos(psi_dock)
        entry_y = dock_y - effective_dock * sin(psi_dock)

        # cruise_start.psi = psi_dock (corridor heading), NOT chassis ψ.
        # CruiseTracker reads psi_path from start_pose.psi to compute
        # e_psi = chassis ψ - psi_path; if we wrote cur_psi here, e_psi
        # would be 0 for the chassis at planning time and the cruise_done
        # heading-aligned gate (cruise_done_heading_max) becomes vacuous.
        # Then a chassis sitting next to the cruise end with a 30+° offset
        # from the dock heading gets handed off to the dock tracker with
        # that heading offset baked in, and the dock tracker cycles trying
        # to close it inside the corridor (observed at WP1 in 18:39
        # mission: e_psi=+36° at dock entry → 53 s cycle → skip).
        cruise_start = (cur_x, cur_y, psi_dock)
        cruise_end = (entry_x, entry_y, psi_dock)
        dock_end = (dock_x, dock_y, psi_dock)

        seg_wp_idx = idx + waypoint_index_offset
        segments.append(PathSegment('cruise', cruise_start, cruise_end, (wp_e, wp_n), seg_wp_idx))
        segments.append(PathSegment('dock', cruise_end, dock_end, (wp_e, wp_n), seg_wp_idx))

        cur_x, cur_y, cur_psi = dock_end
        prev_target = (wp_e, wp_n)

    if return_to_start and start_chassis_xy is not None and prev_target is not None:
        # Antenna landing point for the return = the antenna position the
        # operator started at. We approximate it as the chassis start
        # position; the physical antenna offset just shifts the final
        # parking spot by the offset vector, which is fine for "go home".
        start_x, start_y = start_chassis_xy
        psi_dock = atan2(start_y - cur_y, start_x - cur_x)
        psi_dock = normalize_angle(psi_dock)
        span = hypot(start_x - cur_x, start_y - cur_y)
        effective_dock = min(dock_distance, max(0.5 * span, _DOCK_DISTANCE_FLOOR_M))
        dock_x, dock_y, _ = _dock_chassis_pose(start_x, start_y, psi_dock, antenna_offset)
        entry_x = dock_x - effective_dock * cos(psi_dock)
        entry_y = dock_y - effective_dock * sin(psi_dock)
        segments.append(PathSegment(
            'cruise', (cur_x, cur_y, psi_dock),
            (entry_x, entry_y, psi_dock), (start_x, start_y), -1,
        ))
        segments.append(PathSegment(
            'dock', (entry_x, entry_y, psi_dock),
            (dock_x, dock_y, psi_dock), (start_x, start_y), -1,
        ))

    return segments
