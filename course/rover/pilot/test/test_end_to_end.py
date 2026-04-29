"""End-to-end simulation: planner → estimator → trackers → motion model.

These tests catch class-of-bug issues that unit tests miss because each
file passes its own contract while the composition fails. The original
SCURVE NameError (`navigator_node.py` missing `cos`/`sin` imports) was a
prime example: every component test passed but the live pipeline crashed
on first run.

The harness here is small but exercises the load-bearing path:
  • A synthetic chassis simulator integrates Ackermann kinematics from
    the (v, κ) commands the trackers emit.
  • At each step, the simulator publishes a "GPS antenna position" by
    forward-kinematics the chassis pose plus the true antenna offset,
    and feeds (v_left, v_right) "encoder readings" into the
    ChassisPoseEstimator via predict().
  • A path is planned to a single waypoint and run until the antenna
    lands within tolerance OR a step cap fires. We assert <5 cm landing.

We deliberately avoid rclpy here — this is a library-layer integration
test that runs in pure Python so CI can execute it without a ROS env.
"""

from math import cos, sin, atan2, hypot

import pytest

from pilot.lib.geo_utils import gps_from_enu
from pilot.lib.path_planner import plan
from pilot.lib.path_tracker import CruiseTracker, DockTracker
from pilot.lib.state_estimator import ChassisPoseEstimator


REF_LAT, REF_LON = 35.0, 126.0
DT = 0.05  # 20 Hz control / sim tick

# Chassis-side physical params, matching production yaml.
ANTENNA_OFFSET = (0.30, 0.0)
WHEELBASE = 0.38
TRACK_WIDTH = 0.30
MAX_STEER = 0.4363  # 25°

# Tracker / estimator params chosen to mirror production yaml so the
# regression catches anyone bumping a default into instability.
_TRACKER_PARAMS = {
    'cruise_speed': 1.0,
    'approach_speed': 0.4,
    'creep_speed': 0.18,
    'pp_lookahead_min': 0.6,
    'pp_lookahead_gain': 0.6,
    'pp_damping': 0.18,
    'cruise_done_tolerance': 0.20,
    'pp_min_speed_fraction': 0.25,
    'pp_handoff_blend_distance': 1.0,
    'dock_k_y': 1.4,
    'dock_k_psi': 2.4,
    'dock_k_i': 0.4,
    'dock_integral_limit': 0.5,
    'approach_tolerance': 0.10,
    'creep_zone': 0.40,
    'max_curvature': 1.2,
    'wheelbase': WHEELBASE,
    'max_steering_angle_rad': MAX_STEER,
    'antenna_offset_x': ANTENNA_OFFSET[0],
    'antenna_offset_y': ANTENNA_OFFSET[1],
}


def _gps_at(e, n):
    lat, lon = gps_from_enu(e, n, REF_LAT, REF_LON)
    return lat, lon


def _antenna_at(chassis_pose):
    x, y, psi = chassis_pose
    a_x, a_y = ANTENNA_OFFSET
    return (x + cos(psi) * a_x - sin(psi) * a_y,
            y + sin(psi) * a_x + cos(psi) * a_y)


def _step_chassis(pose, v, kappa, dt=DT):
    """Bicycle-model integration. Front-axle steering κ caps at the
    physical limit before being applied; v is taken as commanded."""
    x, y, psi = pose
    # Clamp curvature to the physical range so a runaway tracker can't
    # teleport the simulated chassis sideways.
    if kappa > _TRACKER_PARAMS['max_curvature']:
        kappa = _TRACKER_PARAMS['max_curvature']
    elif kappa < -_TRACKER_PARAMS['max_curvature']:
        kappa = -_TRACKER_PARAMS['max_curvature']
    # Mid-point integration so 20 Hz handles 1 m/s × 1 1/m turns cleanly.
    omega = v * kappa
    psi_mid = psi + 0.5 * omega * dt
    x += v * cos(psi_mid) * dt
    y += v * sin(psi_mid) * dt
    psi += omega * dt
    return (x, y, psi)


def _wheel_velocities(v, kappa):
    """Per-wheel m/s consistent with chassis (v, κ) for the encoder feed."""
    omega = v * kappa
    return v - 0.5 * TRACK_WIDTH * omega, v + 0.5 * TRACK_WIDTH * omega


def _run_to_waypoint(target_e, target_n, *, start_pose=(0.0, 0.0, 0.0),
                     max_steps=2000, gps_period=2):
    """Drive the simulated chassis to a single antenna waypoint.

    Returns (final_antenna_position, steps_taken). Asserts internally on
    runaway timesteps.
    """
    # Plan: chassis-frame planner, antenna offset compensated.
    target_lat, target_lon = _gps_at(target_e, target_n)
    waypoints = [{'lat': target_lat, 'lng': target_lon}]
    segments = plan(
        current_chassis_pose=start_pose,
        antenna_offset=ANTENNA_OFFSET,
        waypoints_lat_lng=waypoints,
        ref_lat_lon=(REF_LAT, REF_LON),
        dock_distance=1.5,
        return_to_start=False,
    )

    # Estimator anchored at start GPS position. We seed it with the true
    # initial chassis ψ (as if calibration just succeeded perfectly) so
    # the test isolates *navigation* accuracy from heading-fit noise.
    start_antenna = _antenna_at(start_pose)
    start_lat, start_lon = _gps_at(start_antenna[0], start_antenna[1])
    estimator = ChassisPoseEstimator(
        antenna_offset_x=ANTENNA_OFFSET[0],
        antenna_offset_y=ANTENNA_OFFSET[1],
        ref_lat=REF_LAT,
        ref_lon=REF_LON,
        pos_correction_gain=0.30,
        psi_correction_gain=0.15,
        psi_correction_min_speed=0.4,
    )
    estimator.set_initial(start_lat, start_lon, start_pose[2])

    cruise = CruiseTracker(_TRACKER_PARAMS)
    dock = DockTracker(_TRACKER_PARAMS)

    pose = start_pose
    seg_idx = 0
    t = 0.0
    for step in range(max_steps):
        if seg_idx >= len(segments):
            break
        seg = segments[seg_idx]
        chassis_pose = estimator.chassis_pose()
        antenna_world = estimator.antenna_position()
        if seg.kind == 'cruise':
            v, kappa, done = cruise.step(chassis_pose, seg, t_now=t)
            if done:
                seg_idx += 1
                cruise.reset()
                continue
        else:
            v, kappa, status = dock.step(chassis_pose, seg, t_now=t,
                                         antenna_world=antenna_world)
            if status == 'reached':
                break

        # Advance the truth chassis with the commanded (v, κ).
        pose = _step_chassis(pose, v, kappa)
        # Feed the estimator with synthetic encoder kinematics.
        v_l, v_r = _wheel_velocities(v, kappa)
        # Reuse the chassis-frame derivation rather than the wheels:
        # estimator.predict expects (v_chassis, ω_chassis). We compute
        # both so the downstream test exercises the same path the
        # navigator uses.
        v_chassis = 0.5 * (v_l + v_r)
        omega_chassis = (v_r - v_l) / TRACK_WIDTH
        t += DT
        estimator.predict(v_chassis, omega_chassis, t)
        # GPS arrives at 10 Hz (every 2 control ticks at 20 Hz).
        if step % gps_period == 0:
            true_antenna = _antenna_at(pose)
            lat, lon = _gps_at(true_antenna[0], true_antenna[1])
            estimator.correct_position(lat, lon)
    else:
        pytest.fail(f'simulation did not reach target in {max_steps} steps')

    return _antenna_at(pose), step


def test_single_waypoint_lands_within_5cm():
    """Straight target, no encoder noise, perfect ψ at start. The
    pipeline must land the antenna within 5 cm — the production
    waypoint_tolerance budget."""
    final_antenna, _ = _run_to_waypoint(5.0, 0.0)
    err = hypot(final_antenna[0] - 5.0, final_antenna[1] - 0.0)
    assert err < 0.05, f'antenna landed {err*100:.1f} cm from target'


def test_offset_waypoint_lands_within_5cm():
    """Target at 90° to the start heading exercises the cruise→dock
    transition more aggressively. Same 5 cm budget."""
    final_antenna, _ = _run_to_waypoint(4.0, 3.0)
    err = hypot(final_antenna[0] - 4.0, final_antenna[1] - 3.0)
    assert err < 0.05, f'antenna landed {err*100:.1f} cm from target'


def test_modules_import_cleanly():
    """Smoke test: importing every navigator-side module and constructing
    a NavigatorNode would have caught the SCURVE NameError. We can't
    instantiate the ROS node here without conftest stubs, but we exercise
    every library import the node depends on so an import-time crash
    fails this test directly."""
    from pilot.lib import (
        antenna_calibration, geo_utils, ntrip_client, path_planner,
        path_tracker, protocol_utils, state_estimator, ubx_parser,
        wheel_calibration, ackermann,
    )
    # Pinning attributes that have been the locus of import-related
    # regressions before:
    assert hasattr(antenna_calibration, 'scurve_curvature')
    assert hasattr(antenna_calibration, 'SOLVE_PSI_SPREAD_MIN_RAD')
    assert hasattr(wheel_calibration, 'solve_wheel_scales')
    assert hasattr(path_tracker, 'CruiseTracker')
    assert hasattr(path_tracker, 'DockTracker')
