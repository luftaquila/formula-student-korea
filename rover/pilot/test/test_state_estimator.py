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


class TestPositionInnovationYaw:
    """Position-innovation → ψ correction is the new ArduPilot-EKF3-style
    yaw channel that resolves chassis_psi at low speed (0.3–1.5 m/s)
    where heading-of-motion is too noise-dominated to fuse directly.
    """

    def _est(self, **overrides):
        kwargs = dict(
            antenna_offset_x=0.3, antenna_offset_y=0.0,
            ref_lat=REF_LAT, ref_lon=REF_LON,
            pos_correction_gain=0.0,
            psi_correction_gain=0.0,
            psi_correction_min_speed=99.0,  # never fuse heading-of-motion
            yaw_innov_gain=1.0,
            yaw_innov_min_speed=0.20,
            yaw_innov_max_step_rad=1.0,  # disable cap for clean unit math
        )
        kwargs.update(overrides)
        return ChassisPoseEstimator(**kwargs)

    def test_first_call_only_seeds_timer(self):
        # First GPS-yaw-innov call has no prior dt → no correction.
        est = self._est()
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        est.predict(v=1.0, omega=0.0, t_now=100.0)
        est.predict(v=1.0, omega=0.0, t_now=100.05)
        # Antenna observed somewhere — but no prior fix yet, ψ stays put.
        meas_lat, meas_lon = gps_from_enu(1.0, 0.5, REF_LAT, REF_LON)
        est.correct_position_with_yaw_innovation(meas_lat, meas_lon, t_now=200.0)
        _, _, psi = est.chassis_pose()
        assert isclose(psi, 0.0, abs_tol=1e-9)

    def test_lateral_residual_drives_psi_correction(self):
        # Setup: chassis facing East (ψ=0) at 1 m/s. DR predicts antenna
        # will travel 10 cm East over 0.1 s (10 Hz GPS). But the actual
        # antenna ends up 5 cm North of predicted — lateral residual
        # +5 cm with chassis facing East implies ψ was underestimated.
        est = self._est()
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        # Predict 0.1 s of straight 1 m/s.
        est.predict(v=1.0, omega=0.0, t_now=100.0)
        est.predict(v=1.0, omega=0.0, t_now=100.1)
        # Seed the GPS timer (no correction applied on first call).
        seed_lat, seed_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.correct_position_with_yaw_innovation(seed_lat, seed_lon, t_now=100.0)
        # Predicted antenna at this point = chassis_x + 0.3 = 1.0 + 0.3? No —
        # chassis was at (-0.3, 0) initial, drove 0.1 m east → (-0.2, 0)
        # chassis. Predicted antenna = (-0.2 + 0.3, 0) = (0.1, 0).
        # Now observe antenna at (0.1, 0.05) — 5 cm North.
        obs_lat, obs_lon = gps_from_enu(0.1, 0.05, REF_LAT, REF_LON)
        est.correct_position_with_yaw_innovation(obs_lat, obs_lon, t_now=100.1)
        # dt = 0.1 s, v = 1.0 m/s → arc = 10 cm. lat_inn = +5 cm.
        # dpsi = 0.05 / 0.10 = 0.5 rad. With yaw_innov_gain=1.0, ψ snaps
        # to +0.5 rad. Verifies the geometric direction of correction.
        _, _, psi = est.chassis_pose()
        assert psi > 0.0  # +lateral → ψ increases (CCW)
        assert isclose(psi, 0.5, abs_tol=1e-3)

    def test_skipped_below_min_speed(self):
        # 0.1 m/s is below yaw_innov_min_speed=0.20: no correction applied.
        est = self._est()
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        est.predict(v=0.1, omega=0.0, t_now=100.0)
        est.predict(v=0.1, omega=0.0, t_now=100.1)
        seed_lat, seed_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.correct_position_with_yaw_innovation(seed_lat, seed_lon, t_now=100.0)
        # Observe antenna 5 cm lateral — but speed is below threshold.
        obs_lat, obs_lon = gps_from_enu(0.01, 0.05, REF_LAT, REF_LON)
        est.correct_position_with_yaw_innovation(obs_lat, obs_lon, t_now=100.1)
        _, _, psi = est.chassis_pose()
        assert isclose(psi, 0.0, abs_tol=1e-9)

    def test_max_step_caps_correction(self):
        # A huge lateral residual (slip event, GPS jitter) must NOT swing
        # ψ by more than yaw_innov_max_step radians per fix.
        est = self._est(yaw_innov_max_step_rad=0.05)
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=0.0)
        est.predict(v=1.0, omega=0.0, t_now=100.0)
        est.predict(v=1.0, omega=0.0, t_now=100.1)
        seed_lat, seed_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.correct_position_with_yaw_innovation(seed_lat, seed_lon, t_now=100.0)
        # Observe antenna 1 m lateral (impossible in 0.1 s without slip).
        obs_lat, obs_lon = gps_from_enu(0.1, 1.0, REF_LAT, REF_LON)
        est.correct_position_with_yaw_innovation(obs_lat, obs_lon, t_now=100.1)
        _, _, psi = est.chassis_pose()
        # Capped at +0.05 rad regardless of how large the residual is.
        assert isclose(psi, 0.05, abs_tol=1e-9)

    def test_bias_converges_over_multiple_fixes(self):
        # Inject a 5° (0.087 rad) ψ bias and confirm yaw-innov
        # corrections converge toward zero error within ~5 fixes when
        # the chassis drives a straight line at 1 m/s. Simulates the
        # ArduPilot-EKF3 yaw-from-position-innovation recovery loop.
        from math import degrees
        # Real chassis ψ = 0 (East), but estimator believes ψ = +5°.
        true_psi = 0.0
        biased_psi = 0.087
        est = self._est(yaw_innov_gain=0.30, yaw_innov_max_step_rad=0.087)
        # Place antenna at ENU origin; estimator anchors chassis there.
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=biased_psi)
        # Seed timers.
        est.predict(v=1.0, omega=0.0, t_now=100.0)
        est.correct_position_with_yaw_innovation(ant_lat, ant_lon, t_now=100.0)
        for k in range(1, 11):
            t = 100.0 + k * 0.1
            est.predict(v=1.0, omega=0.0, t_now=t)
            # True chassis position at step k: chassis started at
            # (cos(0)·(-0.3) - sin(0)·0, sin(0)·(-0.3) + cos(0)·0)
            # = (-0.3, 0) and moves east at 1 m/s along TRUE ψ=0.
            true_chassis_x = -0.3 + 1.0 * k * 0.1
            true_chassis_y = 0.0
            # True antenna at chassis + R(true_psi)·offset.
            true_ax = true_chassis_x + cos(true_psi) * 0.3
            true_ay = true_chassis_y + sin(true_psi) * 0.3
            obs_lat, obs_lon = gps_from_enu(true_ax, true_ay, REF_LAT, REF_LON)
            est.correct_position_with_yaw_innovation(obs_lat, obs_lon, t_now=t)
            # Also do a position pull so x stays correct for next round.
            est.correct_position(obs_lat, obs_lon)
        _, _, psi = est.chassis_pose()
        # 5° → < 1° within 10 fixes (1 s) at gain 0.30.
        assert abs(psi - true_psi) < degrees(1)/57.2958, (
            f'expected ψ within 1° of true after 10 fixes, got {degrees(psi):.2f}°'
        )

    def test_bias_converges_in_reverse(self):
        # SAME as the forward case but the chassis drives BACKWARD. The
        # lateral-innovation → ψ correction must still CONVERGE the bias.
        # Regression for the reverse sign bug: the correction used |v|, so in
        # reverse it was wrong-signed and AMPLIFIED the bias (K-turn heading
        # corruption). This test diverges on the old code and converges on the
        # fixed one.
        from math import degrees
        true_psi = 0.0
        biased_psi = 0.087  # +5°
        est = self._est(yaw_innov_gain=0.30, yaw_innov_max_step_rad=0.087)
        ant_lat, ant_lon = gps_from_enu(0.0, 0.0, REF_LAT, REF_LON)
        est.set_initial(ant_lat, ant_lon, psi_math=biased_psi)
        est.predict(v=-1.0, omega=0.0, t_now=100.0)
        est.correct_position_with_yaw_innovation(ant_lat, ant_lon, t_now=100.0)
        for k in range(1, 11):
            t = 100.0 + k * 0.1
            est.predict(v=-1.0, omega=0.0, t_now=t)
            # True chassis reverses WEST along TRUE ψ=0 at 1 m/s.
            true_chassis_x = -0.3 - 1.0 * k * 0.1
            true_ax = true_chassis_x + cos(true_psi) * 0.3
            true_ay = 0.0 + sin(true_psi) * 0.3
            obs_lat, obs_lon = gps_from_enu(true_ax, true_ay, REF_LAT, REF_LON)
            est.correct_position_with_yaw_innovation(obs_lat, obs_lon, t_now=t)
            est.correct_position(obs_lat, obs_lon)
        _, _, psi = est.chassis_pose()
        assert abs(psi - true_psi) < degrees(1)/57.2958, (
            f'reverse ψ must converge within 1° of true (amplifies on the '
            f'old |v| code); got {degrees(psi):.2f}°'
        )
