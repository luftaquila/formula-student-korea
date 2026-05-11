"""Path planner: turn waypoints into chassis-frame segments with antenna docks.

The user clicks a target on the map. That target is where the **GPS antenna**
should land, because that's the only quantity we can observe at cm precision.
The chassis (rear axle) needs to be elsewhere — at `target - R(ψ_dock)·offset`
— and pointed along ψ_dock so that as it crosses the dock point, the antenna
crosses the target.

Per waypoint we generate:
  1. A *Dubins* cruise — the shortest forward-only path from the chassis's
     current pose to the dock entry pose, respecting the chassis minimum
     turning radius. Decomposed into ~`dubins_sample_step` segments of
     straight line so the existing Stanley-feedforward cruise tracker can
     follow it without arc-curvature primitives.
  2. A straight dock segment from the corridor entry to the chassis dock
     pose (the corridor proper). State-feedback line follower handles this.

The Dubins cruise replaces the previous geometric-line-only cruise. The
old form couldn't tell the chassis how to align with the corridor heading
when consecutive waypoints sat at 60°+ relative bearings — Stanley
saturated kappa during the rotation, the chassis crossed and re-crossed
the corridor as it swung the heading around, and the dock opened at
e_y > 20 cm. Dubins folds the chassis turning-radius constraint into the
geometry: chassis follows a sequence of arc + straight + arc primitives
that lands on (entry_x, entry_y, psi_dock) tangentially, so the dock
tracker takes over with the chassis already on the corridor and aimed
along it. No cross-and-swing-back, no headed-into-the-wall first arc.

ψ_dock is chosen as:
  - For the first waypoint, the bearing from current chassis position to
    the waypoint. (Drives the antenna roughly straight at the target.)
  - For subsequent waypoints, the bearing from the previous waypoint to
    the current one, so consecutive cones are connected by a smooth corridor.
  - For return-to-start, the bearing from the last waypoint back to start.

The planner is purely geometric — no controller state — so it can be regen-
erated cheaply if the operator skips a waypoint or restarts mid-mission.
"""

from math import atan2, cos, sin, hypot, tan, pi

from pilot.lib.geo_utils import enu_from_gps, normalize_angle
from pilot.lib.dubins import plan as _dubins_plan, sample as _dubins_sample


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

# Dubins sample step for cruise decomposition. Each Dubins primitive is
# discretised at this step into straight sub-segments; the cruise tracker
# then treats each sub-segment as a tiny Stanley problem. 0.30 m balances
# (a) being small enough that the inscribed-polygon error on the tightest
# arc (rho=0.56) is sub-cm, and (b) being large enough that
# cruise_done_tolerance=0.20 doesn't trip on every adjacent sub-segment.
_DUBINS_SAMPLE_STEP_M = 0.30


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


def _expand_dubins_cruise(start_pose, end_pose, target_antenna, waypoint_index,
                          turning_radius, sample_step):
    """Build a list of straight cruise sub-segments along the Dubins path
    from start_pose to end_pose.

    Each sub-segment's start_pose.psi and end_pose.psi are set to the
    chord direction (atan2 of end - start), so the cruise tracker's
    Stanley feedforward sees the local path heading. The dense sampling
    is what gives the chassis a continuously-updated tangent direction
    around an arc — without it the chassis would chase a tangent fixed
    at the arc start and overshoot.
    """
    dub = _dubins_plan(start_pose, end_pose, turning_radius)
    sx, sy, _ = start_pose
    ex, ey, e_psi = end_pose
    if dub is None or dub.length < 1e-3:
        # Degenerate / no path: emit one straight sub-segment so the
        # navigator has something to track to (or nothing if start ≈ end).
        if hypot(ex - sx, ey - sy) < 1e-6:
            return []
        chord_psi = atan2(ey - sy, ex - sx)
        return [PathSegment(
            'cruise',
            (sx, sy, chord_psi),
            (ex, ey, chord_psi),
            target_antenna,
            waypoint_index,
        )]
    pts = _dubins_sample(dub, sample_step)
    sub_segments = []
    for i in range(len(pts) - 1):
        x0, y0, _ = pts[i]
        x1, y1, _ = pts[i + 1]
        if hypot(x1 - x0, y1 - y0) < 1e-9:
            continue
        chord_psi = atan2(y1 - y0, x1 - x0)
        sub_segments.append(PathSegment(
            'cruise',
            (x0, y0, chord_psi),
            (x1, y1, chord_psi),
            target_antenna,
            waypoint_index,
        ))
    # Force the final cruise sub-segment's end_pose.psi to match the dock
    # corridor heading (psi_dock = end_pose[2]). The chord_psi of the last
    # sample is usually within a degree or two but Stanley reads psi_path
    # from start_pose.psi of the NEXT segment (the dock) for handoff, so
    # any mismatch matters less than the final approach angle the cruise
    # tracker uses while still in cruise.
    if sub_segments:
        last = sub_segments[-1]
        # Drop the last sub-segment's end-heading onto psi_dock so the
        # handoff into dock has e_psi ≈ 0.
        sub_segments[-1] = PathSegment(
            last.kind,
            last.start_pose,
            (last.end_pose[0], last.end_pose[1], e_psi),
            last.target_antenna,
            last.waypoint_index,
        )
    return sub_segments


def plan(current_chassis_pose, antenna_offset,
         waypoints_lat_lng, ref_lat_lon,
         dock_distance, return_to_start=False, start_chassis_xy=None,
         waypoint_index_offset=0,
         turning_radius=_DEFAULT_TURNING_RADIUS_M,
         dubins_sample_step=_DUBINS_SAMPLE_STEP_M):
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
        turning_radius: chassis minimum turning radius in meters.
        dubins_sample_step: meters per cruise sub-segment after Dubins
            decomposition.

    Returns:
        List of PathSegment, ordered. Each waypoint contributes one or more
        cruise sub-segments (Dubins-decomposed) plus one dock segment;
        return-to-start contributes the same.
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
        effective_dock = min(dock_distance, max(0.5 * span, _DOCK_DISTANCE_FLOOR_M))
        dock_x, dock_y, _ = _dock_chassis_pose(wp_e, wp_n, psi_dock, antenna_offset)
        entry_x = dock_x - effective_dock * cos(psi_dock)
        entry_y = dock_y - effective_dock * sin(psi_dock)

        seg_wp_idx = idx + waypoint_index_offset
        # Dubins cruise: chassis (cur_x, cur_y, cur_psi) → entry pose.
        # Decomposed into ~`dubins_sample_step` straight sub-segments so
        # the existing cruise tracker can chase each chord directly.
        sub_segs = _expand_dubins_cruise(
            (cur_x, cur_y, cur_psi),
            (entry_x, entry_y, psi_dock),
            (wp_e, wp_n),
            seg_wp_idx,
            turning_radius,
            dubins_sample_step,
        )
        segments.extend(sub_segs)
        # Dock straight-line segment (entry → dock pose).
        segments.append(PathSegment(
            'dock', (entry_x, entry_y, psi_dock),
            (dock_x, dock_y, psi_dock), (wp_e, wp_n), seg_wp_idx,
        ))

        cur_x, cur_y, cur_psi = dock_x, dock_y, psi_dock
        prev_target = (wp_e, wp_n)

    if return_to_start and start_chassis_xy is not None:
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
        # Dubins for return cruise too.
        sub_segs = _expand_dubins_cruise(
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
        ))

    return segments
