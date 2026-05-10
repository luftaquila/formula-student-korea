"""Tests for the dock-and-approach path planner.

The planner's only job is geometry: given waypoints (where the antenna
should land), produce chassis-frame segments such that following them
puts the antenna on each waypoint. The dock pose is the load-bearing
part — if it doesn't compensate for antenna offset, no controller
downstream can hit the cm-level tolerance.
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
        assert len(segments) == 2
        cruise, dock = segments
        assert cruise.kind == 'cruise' and dock.kind == 'dock'

        ax, ay = _antenna_pos_for(dock.end_pose, antenna_offset)
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
        cruise, dock = segments
        expected_psi = atan2(4.0, 3.0)
        assert isclose(cruise.end_pose[2], expected_psi, abs_tol=1e-9)
        assert isclose(dock.end_pose[2], expected_psi, abs_tol=1e-9)

    def test_dock_distance_separates_cruise_end_from_dock_end(self):
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.3, 0.0),
            waypoints_lat_lng=[_gps(10.0, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            dock_distance=1.5,
            return_to_start=False,
        )
        cruise, dock = segments
        cx, cy, _ = cruise.end_pose
        dx, dy, _ = dock.end_pose
        assert isclose(hypot(dx - cx, dy - cy), 1.5, abs_tol=1e-9)


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
        # Two waypoints → 4 segments.
        assert len(segments) == 4
        # Second waypoint's dock heading is bearing from wp1→wp2.
        expected = atan2(1.0 - 0.0, 4.0 - 2.0)
        assert isclose(segments[3].end_pose[2], expected, abs_tol=1e-9)

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
        assert len(segments) == 6
        for i, (e, n) in enumerate(wps_enu):
            dock = segments[2 * i + 1]
            assert dock.kind == 'dock'
            assert dock.waypoint_index == i
            ax, ay = _antenna_pos_for(dock.end_pose, antenna_offset)
            assert isclose(ax, e, abs_tol=1e-6)
            assert isclose(ay, n, abs_tol=1e-6)


class TestDockDistanceClamp:
    """Regression: dock_distance projection past the previous waypoint
    forced cruise legs to U-turn when consecutive cones were closer than
    dock_distance. The planner now clamps to half the inter-waypoint
    span (with a 0.3 m floor)."""

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
        # Second cruise → second dock; the cruise's end pose is the entry
        # point. Verify it sits BETWEEN the two cones along the corridor,
        # not before the first.
        second_cruise_end = segments[2].end_pose  # (entry_x, entry_y, psi_dock)
        ex, _ey, _ = second_cruise_end
        # First cone is at antenna position (2.0, 0); chassis dock pose
        # for that cone is (1.7, 0). Entry must be ≥ 1.7 (between dock pose
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
        second_dock_end = segments[3].end_pose
        second_cruise_end = segments[2].end_pose
        corridor = hypot(second_dock_end[0] - second_cruise_end[0],
                         second_dock_end[1] - second_cruise_end[1])
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
        # 2 mission segments + 2 return segments
        assert len(segments) == 4
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
        assert len(segments) == 2


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
        dock = segments[1]
        ax, ay = _antenna_pos_for(dock.end_pose, (a_x, a_y))
        assert isclose(ax, 7.0, abs_tol=1e-6)
        assert isclose(ay, 2.0, abs_tol=1e-6)
