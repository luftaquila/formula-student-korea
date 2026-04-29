"""Tests for ChassisPoseEstimator.

The estimator's contract: given a non-zero antenna offset, predict + correct
must converge to the chassis pose that explains the GPS observations, and
heading correction must invert the antenna's swing through R(ψ)·offset so
that GPS heading-of-motion during a turn doesn't drag chassis ψ off.
"""

from math import cos, sin, pi, isclose, hypot, atan2

import pytest

from pilot.lib.state_estimator import ChassisPoseEstimator
from pilot.lib.geo_utils import gps_from_enu, enu_from_gps, math_to_compass


REF_LAT, REF_LON = 35.0, 126.0


def _make_estimator(a_x=0.30, a_y=0.0):
    return ChassisPoseEstimator(
        antenna_offset_x=a_x, antenna_offset_y=a_y,
        ref_lat=REF_LAT, ref_lon=REF_LON,
        pos_correction_gain=0.5, psi_correction_gain=0.3,
        psi_correction_min_speed=0.3,
    )


def _antenna_for(chassis_x, chassis_y, psi, a_x, a_y):
    cp, sp = cos(psi), sin(psi)
    return chassis_x + cp * a_x - sp * a_y, chassis_y + sp * a_x + cp * a_y


class TestSetInitial:
    def test_chassis_position_is_antenna_minus_offset(self):
        est = _make_estimator(a_x=0.3, a_y=0.0)
        # Antenna at the ENU origin, chassis facing east (psi=0):
        # chassis should sit 0.3 m WEST of antenna.
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        x, y, psi = est.chassis_pose()
        assert isclose(x, -0.3, abs_tol=1e-3)
        assert isclose(y, 0.0, abs_tol=1e-3)
        assert isclose(psi, 0.0, abs_tol=1e-9)

    def test_antenna_position_round_trips(self):
        est = _make_estimator(a_x=0.4, a_y=-0.1)
        ant_lat, ant_lon = gps_from_enu(2.0, 3.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=pi / 3)
        ax, ay = est.antenna_position()
        assert isclose(ax, 2.0, abs_tol=1e-3)
        assert isclose(ay, 3.0, abs_tol=1e-3)


class TestPredict:
    def test_straight_drive_advances_along_psi(self):
        est = _make_estimator()
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        # Integrate at the real 20 Hz cadence — single-step dt > 0.5 s is
        # treated as a sensor stall and skipped.
        est.predict(v=1.0, omega=0.0, t_now=100.0)  # seeds timer
        for i in range(1, 21):
            est.predict(v=1.0, omega=0.0, t_now=100.0 + i * 0.05)
        x, y, psi = est.chassis_pose()
        # Initial chassis at (-0.3, 0.0). After 1 m east → (0.7, 0.0).
        assert isclose(x, 0.7, abs_tol=1e-2)
        assert isclose(y, 0.0, abs_tol=1e-2)
        assert isclose(psi, 0.0, abs_tol=1e-9)

    def test_turning_advances_psi(self):
        est = _make_estimator()
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        est.predict(v=1.0, omega=0.5, t_now=100.0)
        for i in range(1, 21):
            est.predict(v=1.0, omega=0.5, t_now=100.0 + i * 0.05)
        _, _, psi = est.chassis_pose()
        # ω=0.5 rad/s for 1 s → psi ≈ 0.5 rad.
        assert isclose(psi, 0.5, abs_tol=0.05)

    def test_skips_huge_dt(self):
        est = _make_estimator()
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        est.predict(v=1.0, omega=0.0, t_now=100.0)
        # 5 s gap → would integrate 5 m if not for the safety guard.
        est.predict(v=1.0, omega=0.0, t_now=105.0)
        x, _, _ = est.chassis_pose()
        # Initial chassis at (-0.3, 0). Long gap should not have integrated.
        assert isclose(x, -0.3, abs_tol=1e-3)


class TestCorrectPosition:
    def test_pulls_chassis_toward_antenna_observation(self):
        est = ChassisPoseEstimator(
            antenna_offset_x=0.3, antenna_offset_y=0.0,
            ref_lat=REF_LAT, ref_lon=REF_LON,
            pos_correction_gain=1.0,  # unity gain for a clean snap
            psi_correction_gain=0.0,
            psi_correction_min_speed=0.0,
        )
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        # Then GPS reports antenna 0.5 m further east — chassis should
        # follow by exactly 0.5 m.
        new_lat, new_lon = gps_from_enu(0.5, 0.0, REF_LAT, REF_LON)
        est.correct_position(new_lat, new_lon)
        x, _, _ = est.chassis_pose()
        assert isclose(x, 0.2, abs_tol=1e-3)  # was -0.3, +0.5 → 0.2


class TestCorrectHeading:
    def test_no_offset_GPS_heading_equals_chassis_psi(self):
        # With antenna at the rear axle (a_x = a_y = 0), GPS heading-of-
        # motion equals chassis ψ. A correction with full gain should snap
        # ψ to the GPS reading.
        est = ChassisPoseEstimator(
            antenna_offset_x=0.0, antenna_offset_y=0.0,
            ref_lat=REF_LAT, ref_lon=REF_LON,
            pos_correction_gain=0.0,
            psi_correction_gain=1.0,
            psi_correction_min_speed=0.0,
        )
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        # Simulate a recent (v, ω) so the offset inversion has well-posed
        # inputs. With no offset the inversion is identity anyway.
        est.predict(v=1.0, omega=0.0, t_now=100.0)
        est.predict(v=1.0, omega=0.0, t_now=100.05)
        # GPS reports motion heading 90° compass = East = math 0.
        est.correct_heading(heading_compass_rad=pi / 2, ground_speed_mps=1.0)
        _, _, psi = est.chassis_pose()
        assert isclose(psi, 0.0, abs_tol=1e-9)

    def test_offset_inversion_recovers_chassis_psi(self):
        # The crucial test. Antenna offset 0.3 m forward; chassis is yawing
        # CCW at ω = 1 rad/s while moving at v = 1 m/s. The antenna's
        # velocity vector points at chassis_psi + atan2(ω·a_x, v) =
        # chassis_psi + atan2(0.3, 1.0) ≈ chassis_psi + 0.291 rad.
        #
        # If the chassis is heading East (psi=0), GPS reports motion
        # heading ≈ 0.291 rad (math). Naive code that treated GPS heading
        # as chassis psi would set psi=0.291 and the controller would
        # think the chassis is rotated 17° from reality — exactly the
        # figure-8 failure mode. Our estimator must invert the offset and
        # land on chassis_psi=0.
        est = ChassisPoseEstimator(
            antenna_offset_x=0.3, antenna_offset_y=0.0,
            ref_lat=REF_LAT, ref_lon=REF_LON,
            pos_correction_gain=0.0,
            psi_correction_gain=1.0,
            psi_correction_min_speed=0.0,
        )
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        # Stamp the most-recent v, ω that the inversion uses.
        est.predict(v=1.0, omega=1.0, t_now=100.0)
        est.predict(v=1.0, omega=1.0, t_now=100.05)
        # After 50 ms at ω=1, true psi advanced by 0.05 rad. We disregard
        # that for the test — the point is that GPS reports the antenna
        # velocity heading, which we must un-rotate.
        true_psi = est.psi  # whatever the predict landed on
        antenna_motion_math = true_psi + atan2(1.0 * 0.3, 1.0 - 1.0 * 0.0)
        gps_compass = math_to_compass(antenna_motion_math)
        est.correct_heading(heading_compass_rad=gps_compass, ground_speed_mps=1.0)
        _, _, psi = est.chassis_pose()
        assert isclose(psi, true_psi, abs_tol=1e-6)

    def test_skipped_below_min_speed(self):
        est = ChassisPoseEstimator(
            antenna_offset_x=0.0, antenna_offset_y=0.0,
            ref_lat=REF_LAT, ref_lon=REF_LON,
            pos_correction_gain=0.0,
            psi_correction_gain=1.0,
            psi_correction_min_speed=0.5,
        )
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        est.predict(v=0.1, omega=0.0, t_now=100.0)
        est.predict(v=0.1, omega=0.0, t_now=100.05)
        # GPS reports a wildly-different heading at 0.1 m/s — the
        # estimator should ignore it because heading-of-motion is
        # noise-dominated below psi_min_speed.
        est.correct_heading(heading_compass_rad=0.0, ground_speed_mps=0.1)
        _, _, psi = est.chassis_pose()
        assert isclose(psi, 0.0, abs_tol=1e-9)
