"""Tests for the dock-and-approach path planner.

The planner's only job is geometry: given waypoints (where the antenna
should land), produce chassis-frame segments such that following them
puts the antenna on each waypoint. The dock pose is the load-bearing
part — if it doesn't compensate for antenna offset, no controller
downstream can hit the cm-level tolerance.

With Dubins-decomposed cruise, the number of cruise sub-segments per
waypoint depends on the chassis turning radius and the chassis→entry
geometry; tests assert invariants (dock count, last dock antenna
landing, corridor length) rather than fixed segment counts.
"""

from math import cos, sin, pi, isclose, hypot, atan2

import pytest

from pilot.lib.path_planner import plan
from pilot.lib.geo_utils import gps_from_enu, enu_from_gps


REF_LAT, REF_LON = 35.0, 126.0


def _gps(e, n):
    lat, lon = gps_from_enu(e, n, REF_LAT, REF_LON)
    return {'lat': lat, 'lng': lon}


def _antenna_pos_for(chassis_pose, antenna_offset):
    x, y, psi = chassis_pose
    a_x, a_y = antenna_offset
    return (x + cos(psi) * a_x - sin(psi) * a_y,
            y + sin(psi) * a_x + cos(psi) * a_y)


def _docks(segments):
    return [s for s in segments if s.kind == 'dock']


def _cruise_for(segments, wp_idx):
    """Cruise sub-segments belonging to a particular waypoint, in order."""
    return [s for s in segments if s.kind == 'cruise' and s.waypoint_index == wp_idx]


class TestSingleWaypoint:
    def test_dock_pose_puts_antenna_on_target(self):
        # Antenna offset 0.30 m forward of rear axle. Target 5 m east of
        # the rover's current chassis position. After running the dock
        # segment, the antenna must land within rounding error on the
        # target — that's the whole point of the planner.
        antenna_offset = (0.30, 0.0)
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=antenna_offset,
            waypoints_lat_lng=[_gps(5.0, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.5,
            return_to_start=False,
        )
        docks = _docks(segments)
        assert len(docks) == 1
        ax, ay = _antenna_pos_for(docks[0].end_pose, antenna_offset)
        assert isclose(ax, 5.0, abs_tol=1e-6)
        assert isclose(ay, 0.0, abs_tol=1e-6)

    def test_dock_heading_matches_approach_direction(self):
        # A target north-east of the rover should get a dock segment whose
        # heading is the bearing from chassis to target — so that the dock
        # corridor is the natural continuation of the approach.
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.0, 0.0),
            waypoints_lat_lng=[_gps(3.0, 4.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.0,
            return_to_start=False,
        )
        dock = _docks(segments)[0]
        expected_psi = atan2(4.0, 3.0)
        assert isclose(dock.end_pose[2], expected_psi, abs_tol=1e-9)
        assert isclose(dock.start_pose[2], expected_psi, abs_tol=1e-9)

    def test_dock_corridor_length_matches_dock_distance(self):
        # The dock corridor (entry → dock_end) length must equal the
        # requested dock_distance for a target far enough from the chassis
        # that the floor clamp doesn't kick in.
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.3, 0.0),
            waypoints_lat_lng=[_gps(10.0, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.5,
            return_to_start=False,
        )
        dock = _docks(segments)[0]
        sx, sy, _ = dock.start_pose
        dx, dy, _ = dock.end_pose
        assert isclose(hypot(dx - sx, dy - sy), 1.5, abs_tol=1e-9)

    def test_cruise_chain_starts_at_chassis_ends_at_dock_entry(self):
        # The first cruise sub-segment must start at the chassis pose, the
        # last cruise sub-segment must end at the dock segment's start.
        segments = plan(
            current_chassis_pose=(0.5, -0.2, 0.3),
            antenna_offset=(0.3, 0.0),
            waypoints_lat_lng=[_gps(5.0, 2.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.5,
            return_to_start=False,
        )
        cruises = _cruise_for(segments, wp_idx=0)
        assert len(cruises) >= 1
        # First cruise starts at chassis xy (psi may differ — it's the chord)
        assert isclose(cruises[0].start_pose[0], 0.5, abs_tol=1e-6)
        assert isclose(cruises[0].start_pose[1], -0.2, abs_tol=1e-6)
        # Last cruise ends at the dock entry
        dock = _docks(segments)[0]
        assert isclose(cruises[-1].end_pose[0], dock.start_pose[0], abs_tol=1e-6)
        assert isclose(cruises[-1].end_pose[1], dock.start_pose[1], abs_tol=1e-6)


class TestMultiWaypoint:
    def test_subsequent_dock_heading_uses_previous_waypoint(self):
        antenna_offset = (0.3, 0.0)
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=antenna_offset,
            waypoints_lat_lng=[_gps(2.0, 0.0), _gps(4.0, 1.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.0,
            return_to_start=False,
        )
        docks = _docks(segments)
        assert len(docks) == 2
        # Second waypoint's dock heading is bearing from wp1→wp2.
        expected = atan2(1.0 - 0.0, 4.0 - 2.0)
        assert isclose(docks[1].end_pose[2], expected, abs_tol=1e-9)

    def test_each_waypoint_dock_lands_antenna_on_target(self):
        antenna_offset = (0.25, 0.05)
        wps_enu = [(2.0, 0.0), (4.0, 1.0), (3.0, 3.0)]
        wps_gps = [_gps(*p) for p in wps_enu]
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=antenna_offset,
            waypoints_lat_lng=wps_gps,
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.2,
            return_to_start=False,
        )
        docks = _docks(segments)
        assert len(docks) == 3
        for i, (e, n) in enumerate(wps_enu):
            assert docks[i].waypoint_index == i
            ax, ay = _antenna_pos_for(docks[i].end_pose, antenna_offset)
            assert isclose(ax, e, abs_tol=1e-6)
            assert isclose(ay, n, abs_tol=1e-6)


class TestDockDistanceClamp:
    """Regression: dock_distance projection past the previous waypoint
    forced cruise legs to U-turn when consecutive cones were closer than
    dock_distance. The planner now clamps to half the inter-waypoint
    span (with a 0.6 m floor)."""

    def test_close_cones_dont_project_entry_behind_prev(self):
        # Two cones 0.8 m apart with dock_distance=1.5 m. Without the
        # clamp, the second waypoint's entry would sit 0.7 m BEHIND the
        # first cone along the shared corridor, requiring a U-turn.
        antenna_offset = (0.3, 0.0)
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=antenna_offset,
            waypoints_lat_lng=[_gps(2.0, 0.0), _gps(2.8, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.5,
            return_to_start=False,
        )
        # Second dock segment's entry (start_pose).
        docks = _docks(segments)
        ex = docks[1].start_pose[0]
        # First cone is at antenna position (2.0, 0); chassis dock pose
        # for that cone is (1.7, 0). Entry must be ≥ 1.5 (between dock pose
        # of cone 1 and cone 2's antenna landing).
        assert ex > 1.5

    def test_clamp_floor_at_min_distance(self):
        # Even with a tiny span, the corridor must be at least 0.6 m so
        # the dock tracker has room to bleed lateral residual at creep
        # speed without overshooting along-track and triggering reverse.
        antenna_offset = (0.3, 0.0)
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=antenna_offset,
            waypoints_lat_lng=[_gps(2.0, 0.0), _gps(2.1, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.5,
            return_to_start=False,
        )
        docks = _docks(segments)
        sx, sy, _ = docks[1].start_pose
        ex, ey, _ = docks[1].end_pose
        corridor = hypot(ex - sx, ey - sy)
        assert corridor == pytest.approx(0.6, abs=1e-6)


class TestReturnToStart:
    def test_return_segments_appended(self):
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.3, 0.0),
            waypoints_lat_lng=[_gps(5.0, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.0,
            return_to_start=True,
            start_chassis_xy=(0.0, 0.0),
        )
        docks = _docks(segments)
        # One mission dock + one return dock.
        assert len(docks) == 2
        assert segments[-1].kind == 'dock'
        assert segments[-1].waypoint_index == -1

    def test_return_omitted_when_disabled(self):
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.3, 0.0),
            waypoints_lat_lng=[_gps(5.0, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.0,
            return_to_start=False,
        )
        docks = _docks(segments)
        assert len(docks) == 1

    def test_return_created_even_when_all_waypoints_skipped(self):
        # Empty waypoints list with return_to_start=True must still emit
        # the return segments (regression: prev_target was None and the
        # return branch was skipped, leaving the navigator stranded at
        # the last waypoint after a final-wp skip).
        segments = plan(
            current_chassis_pose=(2.0, 1.0, 0.0),
            antenna_offset=(0.3, 0.0),
            waypoints_lat_lng=[],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.0,
            return_to_start=True,
            start_chassis_xy=(0.0, 0.0),
        )
        docks = _docks(segments)
        assert len(docks) == 1
        assert docks[0].waypoint_index == -1


class TestOffsetCompensation:
    @pytest.mark.parametrize('a_x,a_y', [
        (0.0, 0.0),       # rear-axle antenna (degenerate but valid)
        (0.30, 0.0),      # forward only (typical)
        (0.20, 0.10),     # asymmetric (matches a non-centerline mount)
        (0.50, -0.15),    # extreme — verify the closed form holds
    ])
    def test_arbitrary_offset_lands_antenna_on_target(self, a_x, a_y):
        # The dock pose formula `target − R(ψ_dock) · offset` must work for
        # any antenna offset, including off-centerline. Each one would
        # otherwise produce a different lateral bias the controller has
        # no way to undo on a straight dock corridor.
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(a_x, a_y),
            waypoints_lat_lng=[_gps(7.0, 2.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.5,
            return_to_start=False,
        )
        dock = _docks(segments)[0]
        ax, ay = _antenna_pos_for(dock.end_pose, (a_x, a_y))
        assert isclose(ax, 7.0, abs_tol=1e-6)
        assert isclose(ay, 2.0, abs_tol=1e-6)


class TestDubinsCruise:
    """Dubins-decomposed cruise must be a chain of small chord segments
    whose accumulated length is no shorter than the chassis→entry chord
    (because Dubins respects the turning radius) and that ends tangent
    to the corridor heading."""

    def test_cruise_chain_length_at_least_chord(self):
        start_xy = (0.0, 0.0)
        wp = _gps(5.0, 3.0)
        segments = plan(
            current_chassis_pose=(*start_xy, 0.0),
            antenna_offset=(0.0, 0.0),
            waypoints_lat_lng=[wp],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.0,
            return_to_start=False,
            turning_radius=0.5,
        )
        cruises = _cruise_for(segments, 0)
        # Chord from chassis to dock entry.
        dock = _docks(segments)[0]
        chord = hypot(dock.start_pose[0] - start_xy[0],
                      dock.start_pose[1] - start_xy[1])
        path_len = sum(hypot(c.end_pose[0] - c.start_pose[0],
                             c.end_pose[1] - c.start_pose[1])
                       for c in cruises)
        assert path_len >= chord - 1e-6

    def test_last_cruise_aligned_with_dock_heading(self):
        # The final cruise sub-segment's end_pose.psi is forced to
        # psi_dock so the cruise→dock handoff has e_psi ≈ 0.
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.0, 0.0),
            waypoints_lat_lng=[_gps(5.0, 2.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.0,
            return_to_start=False,
        )
        cruises = _cruise_for(segments, 0)
        dock = _docks(segments)[0]
        assert isclose(cruises[-1].end_pose[2], dock.start_pose[2], abs_tol=1e-9)


class TestDistToDockPropagation:
    """Each cruise sub-segment carries `dist_to_dock` = cumulative metres
    from its END pose through all later cruise sub-segs to the dock
    corridor entry. The CruiseTracker's handoff-blend taper keys on
    this so cruise_speed is held across an entire Reed-Shepp expansion;
    without it, every 0.15 m sub-seg trips the taper and caps speed at
    approach_speed."""

    def _simple_segments(self):
        # Single distant waypoint so the Reed-Shepp expansion has many
        # sub-segs; antenna offset zero keeps geometry tidy.
        ref = (37.5, 127.0)
        # 6 m east in metres → adjust by reverse ENU conversion.
        wp_e, wp_n = 6.0, 0.0
        wp_lat, wp_lon = gps_from_enu(wp_e, wp_n, ref[0], ref[1])
        waypoints = [{'lat': wp_lat, 'lng': wp_lon}]
        return plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.0, 0.0),
            waypoints_lat_lng=waypoints,
            ref_lat_lon=ref,
            dock_distance=2.5,
            turning_radius=0.56,
        )

    def test_last_cruise_sub_has_zero_dist_to_dock(self):
        segs = self._simple_segments()
        cruises = _cruise_for(segs, 0)
        assert cruises, 'expected at least one cruise sub-seg'
        last = cruises[-1]
        assert last.dist_to_dock == pytest.approx(0.0, abs=1e-9)

    def test_dist_to_dock_decreases_monotonically(self):
        segs = self._simple_segments()
        cruises = _cruise_for(segs, 0)
        assert len(cruises) >= 2
        for prev, nxt in zip(cruises[:-1], cruises[1:]):
            assert prev.dist_to_dock + 1e-9 >= nxt.dist_to_dock, (
                f'dist_to_dock should never increase along the path; '
                f'got {prev.dist_to_dock:.3f} → {nxt.dist_to_dock:.3f}')

    def test_dist_to_dock_matches_remaining_chord_sum(self):
        # The first cruise sub-seg's dist_to_dock should equal the
        # total chord length of every later sub-seg in the same cruise.
        segs = self._simple_segments()
        cruises = _cruise_for(segs, 0)
        if len(cruises) < 2:
            pytest.skip('Reed-Shepp expansion too short for the check')
        head = cruises[0]
        tail = cruises[1:]
        tail_chord_sum = 0.0
        for s in tail:
            sx, sy, _ = s.start_pose
            ex, ey, _ = s.end_pose
            tail_chord_sum += hypot(ex - sx, ey - sy)
        assert head.dist_to_dock == pytest.approx(tail_chord_sum, abs=1e-6)

    def test_last_cruise_ends_forward(self):
        # require_forward_end is wired through _expand_cruise so the
        # last cruise sub-seg must be forward (direction = +1). The
        # dock tracker only supports forward motion; a reverse-end
        # cruise would force a direction switch right at the dock
        # corridor entry.
        segs = self._simple_segments()
        cruises = _cruise_for(segs, 0)
        assert cruises
        assert cruises[-1].direction == 1
