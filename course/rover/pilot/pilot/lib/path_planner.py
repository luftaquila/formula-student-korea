"""Path planner: turn waypoints into chassis-frame segments with antenna docks.

The user clicks a target on the map. That target is where the **GPS antenna**
should land, because that's the only quantity we can observe at cm precision.
The chassis (rear axle) needs to be elsewhere — at `target - R(ψ_dock)·offset`
— and pointed along ψ_dock so that as it crosses the dock point, the antenna
crosses the target.

Per waypoint we emit two segments:

  1. CRUISE — a single point-to-point segment from the chassis's current pose
     to the dock corridor entry. The cruise tracker drives the chassis like a
     human driver: look at the destination, steer toward it (heading-only
     P-control), drive forward. No path-following, no sub-segments, no
     Stanley line lateral term. The chassis traces a smooth arc into the
     dock corridor entry and is naturally aligned with the corridor direction
     by the time it arrives (because that's where it's been steering).

  2. DOCK — straight line from dock entry to chassis dock pose. State-
     feedback line follower handles fine cm-level antenna landing in forward
     motion only.

We previously used Reed-Shepp expansion into ~0.15 m sub-segments with
Stanley line-following on each. Three problems with that:

  - Stanley's lateral term coupled chassis_psi noise into κ noise on every
    sample, producing visible steering wiggle on what should have been
    straight stretches.
  - Reed-Shepp sample-step discretisation created chord_psi jumps at
    primitive boundaries that Stanley reacted to as fresh heading errors.
  - Reverse primitives required direction-switch zero-cross gating that
    interacted poorly with the MCU accel_limit ramp.

A goal-seeking heading controller has none of these:

  - On straight stretches (e_psi small), κ = k_heading · e_psi → 0. The
    chassis goes literally straight; there is no path to deviate from.
  - On turns (e_psi large), κ saturates at ±κ_max for one smooth arc.
    As the chassis aligns with the goal direction, e_psi → 0 and κ →
    0 continuously — no overshoot, no sign flip, no Stanley feedback
    pumping.
  - There is no forward/reverse choice — the chassis always drives
    forward toward the goal, arcing wider if needed. Mission time on
    the worst geometry is ~1 extra second per waypoint vs Reed-Shepp's
    optimal, which is well below the per-waypoint settle/spray budget.

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


# Floor on the dock corridor length. The dock tracker needs enough along-
# corridor distance for the chassis to close any lateral residual at
# creep speed without overshooting the target along-track and triggering
# reverse. 0.6 m gives the forward state-feedback law enough corridor to
# bleed lateral while still being well inside the 2.5 m default
# dock_distance for normally-spaced waypoints.
_DOCK_DISTANCE_FLOOR_M = 0.6


class PathSegment:
    __slots__ = ('kind', 'start_pose', 'end_pose', 'target_antenna',
                 'waypoint_index', 'direction')

    def __init__(self, kind, start_pose, end_pose, target_antenna,
                 waypoint_index, direction=1):
        # kind: 'cruise' | 'dock'
        # *_pose: (x, y, psi_math). start_pose.psi carries the *bearing
        #     from start to end* for cruise (i.e. the direction the chassis
        #     ideally faces while traversing); for dock it's the corridor
        #     heading. end_pose.psi carries the dock corridor heading on
        #     both (chassis must arrive at dock entry pointed along ψ_dock).
        # target_antenna: (e, n) ENU of the antenna's intended landing point
        # waypoint_index: 0-based index into the original waypoint list, or
        #                 -1 for the synthetic return-to-start segment.
        # direction: +1 forward, -1 reverse. With the goal-seeking cruise
        #     tracker the chassis only drives forward; reverse is reserved
        #     for the dock tracker's overshoot-recovery stroke and not
        #     used at the segment level.
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


def plan(current_chassis_pose, antenna_offset,
         waypoints_lat_lng, ref_lat_lon,
         dock_distance, return_to_start=False, start_chassis_xy=None,
         waypoint_index_offset=0,
         prev_target_xy=None,           # ENU (e, n) of the previously
                                         # sprayed waypoint, used to
                                         # anchor the first waypoint's
                                         # dock_psi on replans so the
                                         # corridor heading doesn't pivot
                                         # with every chassis drift.
         turning_radius=None,           # accepted for backward compat, unused
         dubins_sample_step=None):      # accepted for backward compat, unused
    """Build the segment list for a mission.

    Each waypoint becomes one cruise segment (from current chassis to dock
    entry) and one dock segment (from dock entry to chassis-with-antenna-
    on-target). Reverse and arc primitives are NOT emitted — the cruise
    tracker handles all geometry by steering toward the goal point.

    For the FIRST waypoint in the list, dock_psi is normally derived from
    the bearing chassis → waypoint. On replans mid-mission, that makes
    the corridor heading pivot every time chassis drifts (14:03 WP5: 4
    consecutive replans gave dock_psi -105°, -87°, -150°, +175° as the
    chassis orbited). Pass ``prev_target_xy`` (the ENU of the last
    sprayed waypoint) so the first waypoint inherits the original prev-
    to-current bearing instead — same dock_psi every replan.

    ``turning_radius`` and ``dubins_sample_step`` are accepted but
    ignored. They survive in the signature so callers that built up
    against the Reed-Shepp era don't break; new callers should pass
    nothing.
    """
    del turning_radius, dubins_sample_step  # unused

    ref_lat, ref_lon = ref_lat_lon
    cur_x, cur_y, cur_psi = current_chassis_pose

    wp_enu = [enu_from_gps(wp['lat'], wp['lng'], ref_lat, ref_lon)
              for wp in waypoints_lat_lng]

    segments = []
    prev_target = prev_target_xy  # None on initial plan, override on replan

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

        # Cruise segment: chassis pose now → dock entry pose. start_pose.psi
        # is the *bearing from start to dock entry* — this is the heading
        # the chassis wants to ideally be pointed along while traversing,
        # and the cruise tracker uses it as a fallback heading reference
        # when the chassis sits right on top of the entry. end_pose.psi is
        # the dock corridor heading, matching the next dock segment.
        seg_wp_idx = idx + waypoint_index_offset
        cruise_bearing = atan2(entry_y - cur_y, entry_x - cur_x)
        if hypot(entry_x - cur_x, entry_y - cur_y) < 1e-3:
            # Chassis essentially on the dock entry already (e.g. after a
            # tight replan). Skip the cruise; dock takes over directly.
            pass
        else:
            segments.append(PathSegment(
                'cruise',
                (cur_x, cur_y, normalize_angle(cruise_bearing)),
                (entry_x, entry_y, psi_dock),
                (wp_e, wp_n),
                seg_wp_idx,
                direction=1,
            ))

        segments.append(PathSegment(
            'dock',
            (entry_x, entry_y, psi_dock),
            (dock_x, dock_y, psi_dock),
            (wp_e, wp_n),
            seg_wp_idx,
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

        cruise_bearing = atan2(entry_y - cur_y, entry_x - cur_x)
        if hypot(entry_x - cur_x, entry_y - cur_y) >= 1e-3:
            segments.append(PathSegment(
                'cruise',
                (cur_x, cur_y, normalize_angle(cruise_bearing)),
                (entry_x, entry_y, psi_dock),
                (start_x, start_y),
                -1,
                direction=1,
            ))

        segments.append(PathSegment(
            'dock',
            (entry_x, entry_y, psi_dock),
            (dock_x, dock_y, psi_dock),
            (start_x, start_y),
            -1,
            direction=1,
        ))

    return segments
