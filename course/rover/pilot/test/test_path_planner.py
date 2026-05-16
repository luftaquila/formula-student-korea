"""Tests for the antenna-precise path planner.

The planner's only job is geometry: given waypoints (where the antenna
should land), produce chassis-frame segments such that following them
puts the antenna on each waypoint. The dock pose is load-bearing — if
it doesn't compensate for antenna offset, no controller downstream can
hit the cm-level tolerance.

One PathSegment per waypoint, consumed by L1Tracker. The tests pin
geometric invariants: dock pose puts antenna on target, corridor
heading runs prev → current, return-to-start emits a closing segment.
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
        # Antenna offset 0.30 m forward of rear axle. Target 5 m east
        # of the rover's current chassis position. The segment's
        # end_pose must place the antenna on target.
        antenna_offset = (0.30, 0.0)
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=antenna_offset,
            waypoints_lat_lng=[_gps(5.0, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
        )
        assert len(segments) == 1
        ax, ay = _antenna_pos_for(segments[0].end_pose, antenna_offset)
        assert isclose(ax, 5.0, abs_tol=1e-6)
        assert isclose(ay, 0.0, abs_tol=1e-6)

    def test_dock_heading_matches_approach_direction(self):
        # First waypoint: ψ_dock = bearing(chassis → wp).
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.0, 0.0),
            waypoints_lat_lng=[_gps(3.0, 4.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
        )
        seg = segments[0]
        expected = atan2(4.0, 3.0)
        assert isclose(seg.end_pose[2], expected, abs_tol=1e-6)
        # start_pose carries the corridor direction too.
        assert isclose(seg.start_pose[2], expected, abs_tol=1e-6)

    def test_target_antenna_equals_waypoint(self):
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.30, 0.0),
            waypoints_lat_lng=[_gps(2.0, 1.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
        )
        tx, ty = segments[0].target_antenna
        assert isclose(tx, 2.0, abs_tol=1e-6)
        assert isclose(ty, 1.0, abs_tol=1e-6)

    def test_skip_when_already_on_dock_pose(self):
        # Chassis already at the dock pose (antenna already on target).
        # Planner should emit nothing for that waypoint.
        antenna_offset = (0.30, 0.0)
        # Dock pose for an east-facing approach to (5,0): chassis at
        # (5 - 0.30, 0) facing east.
        chassis_at_dock = (5.0 - 0.30, 0.0, 0.0)
        segments = plan(
            current_chassis_pose=chassis_at_dock,
            antenna_offset=antenna_offset,
            waypoints_lat_lng=[_gps(5.0, 0.0)],
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
        )
        assert segments == []


class TestMultiWaypoint:
    def test_one_segment_per_waypoint(self):
        wps = [_gps(2.0, 0.0), _gps(2.0, 2.0), _gps(0.0, 2.0)]
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.30, 0.0),
            waypoints_lat_lng=wps,
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
        )
        assert len(segments) == 3
        for idx, seg in enumerate(segments):
            assert seg.waypoint_index == idx
            tx, ty = seg.target_antenna
            wp_e, wp_n = enu_from_gps(
                wps[idx]['lat'], wps[idx]['lng'], REF_LAT, REF_LON)
            assert isclose(tx, wp_e, abs_tol=1e-6)
            assert isclose(ty, wp_n, abs_tol=1e-6)

    def test_corridor_heading_from_prev_waypoint(self):
        """For WPs after the first, ψ_dock should be the bearing from
        the previous waypoint to the current one — keeps the corridor
        smooth between cones."""
        wps = [_gps(2.0, 0.0), _gps(2.0, 2.0)]
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.30, 0.0),
            waypoints_lat_lng=wps,
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
        )
        # WP2: bearing (2,0) → (2,2) = +π/2 (north).
        assert isclose(segments[1].end_pose[2], pi / 2, abs_tol=1e-6)

    def test_each_dock_pose_lands_antenna_on_corresponding_wp(self):
        antenna_offset = (0.30, 0.0)
        wps = [_gps(2.0, 0.0), _gps(2.0, 2.0), _gps(0.0, 2.0)]
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=antenna_offset,
            waypoints_lat_lng=wps,
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
        )
        for idx, seg in enumerate(segments):
            ax, ay = _antenna_pos_for(seg.end_pose, antenna_offset)
            wp_e, wp_n = enu_from_gps(
                wps[idx]['lat'], wps[idx]['lng'], REF_LAT, REF_LON)
            assert isclose(ax, wp_e, abs_tol=1e-6)
            assert isclose(ay, wp_n, abs_tol=1e-6)


class TestPrevTargetAnchor:
    def test_first_wp_uses_prev_target_when_provided(self):
        """On a replan mid-mission, prev_target_xy anchors the first
        WP's ψ_dock to the original prev→cur bearing so the corridor
        heading doesn't pivot with each chassis drift."""
        wps = [_gps(2.0, 0.0)]
        prev_target_xy = (-2.0, 0.0)  # 2 m west of origin
        # Chassis nowhere near the prev→cur line.
        segments = plan(
            current_chassis_pose=(0.0, 1.0, pi / 4),
            antenna_offset=(0.30, 0.0),
            waypoints_lat_lng=wps,
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
            prev_target_xy=prev_target_xy,
        )
        # Without prev_target_xy, ψ_dock would be bearing(chassis →
        # wp) = atan2(-1, 2). With prev_target_xy, it should be
        # bearing(prev → wp) = atan2(0, 4) = 0.
        assert isclose(segments[0].end_pose[2], 0.0, abs_tol=1e-6)


class TestReturnToStart:
    def test_emits_closing_segment(self):
        wps = [_gps(2.0, 0.0)]
        start_xy = (0.0, 0.0)
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.30, 0.0),
            waypoints_lat_lng=wps,
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=True,
            start_chassis_xy=start_xy,
        )
        assert len(segments) == 2
        # Last segment closes back to start.
        last = segments[-1]
        assert last.waypoint_index == -1
        tx, ty = last.target_antenna
        assert isclose(tx, 0.0, abs_tol=1e-6)
        assert isclose(ty, 0.0, abs_tol=1e-6)

    def test_no_return_segment_when_disabled(self):
        wps = [_gps(2.0, 0.0)]
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.30, 0.0),
            waypoints_lat_lng=wps,
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
        )
        assert len(segments) == 1


class TestWaypointIndexOffset:
    def test_offset_applied_to_segment_index(self):
        """On replans the planner gets a non-zero offset so segment
        waypoint_index continues to match the mission-wide WP number."""
        wps = [_gps(2.0, 0.0), _gps(2.0, 2.0)]
        segments = plan(
            current_chassis_pose=(0.0, 0.0, 0.0),
            antenna_offset=(0.30, 0.0),
            waypoints_lat_lng=wps,
            ref_lat_lon=(REF_LAT, REF_LON),
            return_to_start=False,
            waypoint_index_offset=5,
        )
        assert [s.waypoint_index for s in segments] == [5, 6]
