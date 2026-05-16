"""Path planner: turn waypoints into chassis-frame segments with antenna docks.

The user clicks a target on the map. That target is where the **GPS antenna**
should land, because that's the only quantity we can observe at cm precision.
The chassis (rear axle) needs to be elsewhere — at `target - R(ψ_dock)·offset`
— and pointed along ψ_dock so that as it crosses the dock point, the antenna
crosses the target.

One PathSegment per waypoint, consumed by L1Tracker:

  - end_pose:   the cur WP's dock_pose — the chassis pose that puts the
    antenna on target.
  - target_antenna: the antenna landing point (the WP itself).

ψ_dock is chosen as:
  - For the first waypoint, the bearing from current chassis position to
    the waypoint. (Drives the antenna roughly straight at the target.)
  - For subsequent waypoints, the bearing from the previous waypoint to
    the current one, so consecutive cones are connected by a smooth
    corridor.
  - For return-to-start, the bearing from the last waypoint back to start.

The planner is purely geometric — no controller state — so it can be regen-
erated cheaply if the operator skips a waypoint or restarts mid-mission.
"""

from math import atan2, cos, sin, hypot

from pilot.lib.geo_utils import enu_from_gps, normalize_angle


class PathSegment:
    __slots__ = ('end_pose', 'target_antenna', 'waypoint_index')

    def __init__(self, end_pose, target_antenna, waypoint_index):
        # end_pose: (x, y, psi_math) chassis dock pose; ψ is the corridor
        #     heading. Used by the navigator's stuck-detection progress
        #     check.
        # target_antenna: (e, n) ENU of the antenna's intended landing point.
        #     L1Tracker steers the antenna here.
        # waypoint_index: 0-based index into the original waypoint list, or
        #                 -1 for the synthetic return-to-start segment.
        self.end_pose = end_pose
        self.target_antenna = target_antenna
        self.waypoint_index = waypoint_index

    def __repr__(self):  # pragma: no cover - debug only
        return (f'PathSegment(wp={self.waypoint_index} '
                f'end={self.end_pose} target={self.target_antenna})')


def _dock_chassis_pose(target_e, target_n, psi_dock, antenna_offset):
    """Chassis pose so that the antenna sits at (target_e, target_n)."""
    a_x, a_y = antenna_offset
    cp, sp = cos(psi_dock), sin(psi_dock)
    ox = cp * a_x - sp * a_y
    oy = sp * a_x + cp * a_y
    return target_e - ox, target_n - oy, psi_dock


def plan(current_chassis_pose, antenna_offset,
         waypoints_lat_lng, ref_lat_lon,
         return_to_start=False, start_chassis_xy=None,
         waypoint_index_offset=0,
         prev_target_xy=None):
    """Build the segment list for a mission.

    One PathSegment per waypoint. start_pose is the chassis's pose at the
    start of the segment — the live chassis pose for the first WP, the
    previous WP's dock_pose for subsequent WPs. end_pose is the cur WP's
    dock_pose (chassis pose that puts the antenna on target).
    target_antenna is the WP itself.

    L1Tracker consumes these segments, computes antenna→target geometry
    each tick, and fires 'reached' when the antenna lands within
    `cm_capture_m` of target_antenna.

    For the FIRST waypoint in the list, dock_psi is normally derived from
    the bearing chassis → waypoint. On replans mid-mission, that makes
    the corridor heading pivot every time chassis drifts (14:03 WP5: 4
    consecutive replans gave dock_psi -105°, -87°, -150°, +175° as the
    chassis orbited). Pass ``prev_target_xy`` (the ENU of the last
    sprayed waypoint) so the first waypoint inherits the original prev-
    to-current bearing instead — same dock_psi every replan.
    """
    ref_lat, ref_lon = ref_lat_lon
    cur_x, cur_y, _ = current_chassis_pose

    wp_enu = [enu_from_gps(wp['lat'], wp['lng'], ref_lat, ref_lon)
              for wp in waypoints_lat_lng]

    segments = []
    prev_target = prev_target_xy

    for idx, (wp_e, wp_n) in enumerate(wp_enu):
        if prev_target is None:
            psi_dock = atan2(wp_n - cur_y, wp_e - cur_x)
        else:
            prev_e, prev_n = prev_target
            psi_dock = atan2(wp_n - prev_n, wp_e - prev_e)
        psi_dock = normalize_angle(psi_dock)

        dock_x, dock_y, _ = _dock_chassis_pose(
            wp_e, wp_n, psi_dock, antenna_offset)

        # Skip if chassis is essentially on the dock pose already (e.g.
        # tight replan landing right on top of the next WP). L1Tracker
        # handles cm-capture immediately on the next tick.
        if hypot(dock_x - cur_x, dock_y - cur_y) < 1e-3:
            cur_x, cur_y = dock_x, dock_y
            prev_target = (wp_e, wp_n)
            continue

        seg_wp_idx = idx + waypoint_index_offset
        segments.append(PathSegment(
            (dock_x, dock_y, psi_dock),
            (wp_e, wp_n),
            seg_wp_idx,
        ))

        # Advance the running pose to the WP's dock_pose — the chassis
        # will (approximately) be there when the next segment begins.
        cur_x, cur_y = dock_x, dock_y
        prev_target = (wp_e, wp_n)

    if return_to_start and start_chassis_xy is not None:
        start_x, start_y = start_chassis_xy
        psi_dock = atan2(start_y - cur_y, start_x - cur_x)
        psi_dock = normalize_angle(psi_dock)
        dock_x, dock_y, _ = _dock_chassis_pose(
            start_x, start_y, psi_dock, antenna_offset)
        if hypot(dock_x - cur_x, dock_y - cur_y) >= 1e-3:
            segments.append(PathSegment(
                (dock_x, dock_y, psi_dock),
                (start_x, start_y),
                -1,
            ))

    return segments
