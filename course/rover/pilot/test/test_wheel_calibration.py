"""Tests for wheel_calibration module: solver, persistence, gates."""

import json
import math

import pytest

from pilot.lib.wheel_calibration import (
    RADIUS_LARGE_M,
    SCALE_BOUND_HI,
    SCALE_BOUND_LO,
    SOLVE_MIN_DISTANCE_M,
    SOLVE_MIN_SAMPLES,
    WHEEL_CAL_FILENAME,
    load_wheel_cal,
    save_wheel_cal,
    solve_wheel_scales,
    wheel_cal_path,
)


TRACK = 0.30


def _straight_samples(distance_m, n=100):
    """ENU samples along a straight chord on the +e axis."""
    return [(distance_m * i / (n - 1), 0.0) for i in range(n)]


def _arc_samples(radius_m, theta_rad, n=100, start=(0.0, 0.0)):
    """ENU samples along a circular arc.

    The rover starts at `start` heading +e and arcs LEFT for theta > 0
    (centre is on the +n side of the start), RIGHT for theta < 0.
    Returns (samples, chord, inner_arc, outer_arc) for assertion convenience.
    """
    sign = 1.0 if theta_rad >= 0 else -1.0
    abs_theta = abs(theta_rad)
    # Centre is perpendicular-left (sign +) or right (sign −) of the +e
    # heading at the start position.
    cx = start[0]
    cy = start[1] + sign * radius_m
    samples = []
    # Initial radial vector points from centre to start: (0, -sign·R).
    # Rotate it by step·sign each tick (sign · positive sweeps LEFT for
    # +theta, RIGHT for -theta).
    for i in range(n):
        phi = sign * abs_theta * i / (n - 1)
        # Initial angle of (start - centre): atan2(-sign·R, 0) = -sign·π/2.
        a0 = -sign * math.pi / 2
        a = a0 + phi
        e = cx + radius_m * math.cos(a)
        nn = cy + radius_m * math.sin(a)
        samples.append((e, nn))
    chord = math.hypot(samples[-1][0] - samples[0][0],
                       samples[-1][1] - samples[0][1])
    inner_arc = (radius_m - TRACK / 2.0) * abs_theta
    outer_arc = (radius_m + TRACK / 2.0) * abs_theta
    return samples, chord, inner_arc, outer_arc


class TestSolverStraight:
    def test_unity_scale_on_perfect_match(self):
        # Both encoder and GPS chord at exactly 10 m on a straight drive.
        samples = _straight_samples(10.0, n=100)
        result = solve_wheel_scales(
            samples_enu=samples,
            encoder_left_m=10.0,
            encoder_right_m=10.0,
            samples=200,
            track_width_m=TRACK,
        )
        assert result['reason'] is None
        assert result['scale_l'] == pytest.approx(1.0, abs=1e-9)
        assert result['scale_r'] == pytest.approx(1.0, abs=1e-9)
        # Straight drive ⇒ no arc geometry reported.
        assert result['arc_radius_m'] is None
        assert result['arc_theta_rad'] is None

    def test_recovers_asymmetric_mismatch(self):
        # Realistic ±0.3 % rolling-radius mismatch on a STRAIGHT drive.
        # Both wheels physically travel 10 m; encoders over-report by the
        # mismatch factor so chord/encoder recovers the per-wheel scale.
        samples = _straight_samples(10.0, n=100)
        result = solve_wheel_scales(
            samples_enu=samples,
            encoder_left_m=10.03,    # right wheel under-reports by 0.3 %
            encoder_right_m=9.97,    # left wheel over-reports by 0.3 %
            samples=200,
            track_width_m=TRACK,
        )
        assert result['reason'] is None
        assert result['scale_l'] == pytest.approx(10.0 / 10.03, abs=1e-4)
        assert result['scale_r'] == pytest.approx(10.0 / 9.97, abs=1e-4)


class TestSolverArc:
    def test_curved_drive_recovers_unity_scales(self):
        # Rover arcs LEFT through 0.15 rad on a 60 m radius — ψ swings ~9°,
        # 60 cm differential between inner/outer rear-wheel arcs. Pre-fix
        # the chord-only formula misread that as wheel-radius mismatch and
        # produced scale_r ≈ 0.985. The arc model attributes it to geometry
        # and recovers (1.0, 1.0) since both wheels physically have unity
        # scale.
        samples, _, inner, outer = _arc_samples(60.0, 0.15, n=100)
        result = solve_wheel_scales(
            samples_enu=samples,
            encoder_left_m=inner,    # left is inner on a left arc
            encoder_right_m=outer,
            samples=200,
            track_width_m=TRACK,
        )
        assert result['reason'] is None
        assert result['scale_l'] == pytest.approx(1.0, abs=2e-3)
        assert result['scale_r'] == pytest.approx(1.0, abs=2e-3)
        assert result['arc_radius_m'] == pytest.approx(60.0, rel=1e-3)
        assert result['arc_theta_rad'] == pytest.approx(0.15, abs=1e-3)

    def test_arc_direction_does_not_flip_scales(self):
        # The same chassis arcing LEFT vs RIGHT through the same magnitude
        # must produce the same per-wheel scales. Pre-fix this was the
        # observed alternating-result symptom: scale_r flipped between
        # 0.984 and 0.997 on consecutive cals depending on which direction
        # the rover happened to drift.
        for theta in (0.12, -0.12):
            samples, _, inner, outer = _arc_samples(50.0, theta, n=100)
            if theta > 0:
                enc_l, enc_r = inner, outer  # left arc: left wheel inner
            else:
                enc_l, enc_r = outer, inner  # right arc: left wheel outer
            result = solve_wheel_scales(
                samples_enu=samples,
                encoder_left_m=enc_l,
                encoder_right_m=enc_r,
                samples=200,
                track_width_m=TRACK,
            )
            assert result['reason'] is None
            assert result['scale_l'] == pytest.approx(1.0, abs=2e-3)
            assert result['scale_r'] == pytest.approx(1.0, abs=2e-3)

    def test_arc_with_real_mismatch_separates_geometry_from_scale(self):
        # Right wheel really has 1.0 % under-reported scale (over-rolls
        # for unit encoder count) on top of a curved drive. The arc model
        # must attribute the geometric component to the arc and the
        # remainder to the per-wheel scale.
        samples, _, inner, outer = _arc_samples(80.0, 0.12, n=100)
        # inner = left, outer = right (left arc). Right wheel scale = 0.99
        # ⇒ encoder_right reports outer / 0.99.
        result = solve_wheel_scales(
            samples_enu=samples,
            encoder_left_m=inner,
            encoder_right_m=outer / 0.99,
            samples=200,
            track_width_m=TRACK,
        )
        assert result['reason'] is None
        assert result['scale_l'] == pytest.approx(1.0, abs=2e-3)
        assert result['scale_r'] == pytest.approx(0.99, abs=2e-3)


class TestSolverGates:
    def test_too_few_samples(self):
        samples = _straight_samples(10.0, n=100)
        result = solve_wheel_scales(
            samples_enu=samples,
            encoder_left_m=10.0,
            encoder_right_m=10.0,
            samples=SOLVE_MIN_SAMPLES - 1,
            track_width_m=TRACK,
        )
        assert result['reason'] is not None
        assert 'too few' in result['reason']

    def test_short_chord_rejected(self):
        # Even with healthy encoder data, a short drive can't resolve
        # wheel-scale signal above RTK noise floor.
        samples = _straight_samples(SOLVE_MIN_DISTANCE_M - 0.1, n=20)
        result = solve_wheel_scales(
            samples_enu=samples,
            encoder_left_m=4.0,
            encoder_right_m=4.0,
            samples=200,
            track_width_m=TRACK,
        )
        assert result['reason'] is not None
        assert 'chord too short' in result['reason']

    def test_zero_encoder_rejected(self):
        # Wheel didn't turn (slip / stall) — must not divide by ~zero.
        samples = _straight_samples(10.0, n=100)
        result = solve_wheel_scales(
            samples_enu=samples,
            encoder_left_m=0.0,
            encoder_right_m=10.0,
            samples=200,
            track_width_m=TRACK,
        )
        assert result['reason'] is not None
        assert 'encoder displacement' in result['reason']

    def test_too_few_enu_samples(self):
        result = solve_wheel_scales(
            samples_enu=[(0.0, 0.0), (10.0, 0.0)],  # only 2 points
            encoder_left_m=10.0,
            encoder_right_m=10.0,
            samples=200,
            track_width_m=TRACK,
        )
        assert result['reason'] is not None
        assert 'ENU' in result['reason']

    def test_symmetric_out_of_range_rejected(self):
        # Both wheels short by the same amount on a straight drive (e.g.
        # PPR / wheel-radius constants misconfigured) ⇒ symmetric scale
        # 1.25 ⇒ rejected by the per-wheel bound check.
        samples = _straight_samples(10.0, n=100)
        result = solve_wheel_scales(
            samples_enu=samples,
            encoder_left_m=8.0,
            encoder_right_m=8.0,
            samples=200,
            track_width_m=TRACK,
        )
        assert result['reason'] is not None
        assert 'scale' in result['reason']


class TestPersistence:
    def test_round_trip(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        save_wheel_cal(
            1.012, 0.987,
            gps_distance_m=10.21,
            encoder_left_m=10.09,
            encoder_right_m=10.35,
            samples=200,
            arc_radius_m=87.3,
            arc_theta_rad=-0.117,
        )
        scales, payload = load_wheel_cal(default=(1.0, 1.0))
        assert scales[0] == pytest.approx(1.012, abs=1e-5)
        assert scales[1] == pytest.approx(0.987, abs=1e-5)
        assert payload['samples'] == 200
        assert payload['arc_radius_m'] == pytest.approx(87.3, abs=1e-3)
        assert payload['arc_theta_rad'] == pytest.approx(-0.117, abs=1e-5)
        assert isinstance(payload['calibrated_at'], int)

    def test_round_trip_without_arc_fields(self, tmp_path, monkeypatch):
        # Straight drive — arc fields omitted by the solver.
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        save_wheel_cal(
            1.012, 0.987,
            gps_distance_m=10.21,
            encoder_left_m=10.09,
            encoder_right_m=10.35,
            samples=200,
        )
        scales, payload = load_wheel_cal(default=(1.0, 1.0))
        assert scales[0] == pytest.approx(1.012, abs=1e-5)
        assert 'arc_radius_m' not in payload
        assert 'arc_theta_rad' not in payload

    def test_load_missing_returns_default(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        scales, payload = load_wheel_cal(default=(1.0, 1.0))
        assert scales == (1.0, 1.0)
        assert payload is None

    def test_load_corrupt_returns_default(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        (tmp_path / WHEEL_CAL_FILENAME).write_text('{not valid json')
        scales, payload = load_wheel_cal(default=(1.0, 1.0))
        assert scales == (1.0, 1.0)
        assert payload is None

    def test_load_out_of_range_rejected(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        (tmp_path / WHEEL_CAL_FILENAME).write_text(
            json.dumps({'scale_l': 2.0, 'scale_r': 1.0, 'calibrated_at': 1})
        )
        scales, payload = load_wheel_cal(default=(1.0, 1.0))
        assert scales == (1.0, 1.0)
        assert payload is None

    def test_save_rejects_out_of_range(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        with pytest.raises(ValueError):
            save_wheel_cal(
                2.0, 1.0,
                gps_distance_m=10.0,
                encoder_left_m=5.0,
                encoder_right_m=10.0,
                samples=200,
            )
