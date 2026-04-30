"""Tests for steering_calibration: Kasa circle fit, gates, persistence."""

import json
import math

import pytest

from pilot.lib.steering_calibration import (
    RADIUS_LARGE_M,
    SOLVE_MIN_DISTANCE_M,
    SOLVE_MIN_SAMPLES,
    STEERING_TRIM_FILENAME,
    TRIM_BOUND_US,
    _fit_circle_kasa,
    load_steering_trim,
    save_steering_trim,
    solve_steering_trim,
    steering_trim_path,
)


# Realistic geometry: max steering 25° on a 0.38 m wheelbase yields
# κ_max = tan(25°) / 0.38 ≈ 1.227 1/m. Servo range ±500 µs.
KAPPA_MAX = math.tan(math.radians(25.0)) / 0.38
SERVO_RANGE = 500.0


def _arc(radius, n=200, total_angle_rad=None, side='left'):
    """Generate ENU samples along an arc starting at origin, heading +x.

    side='left' arcs above the x-axis (centre at (0, +R));
    side='right' arcs below (centre at (0, -R)).
    """
    if total_angle_rad is None:
        # Default: 10 m chord at the requested radius, capped at 90°.
        total_angle_rad = min(10.0 / radius, math.pi / 2)
    cy = radius if side == 'left' else -radius
    pts = []
    for i in range(n):
        # Parameterise so the arc starts heading +x at the origin.
        theta = total_angle_rad * i / (n - 1)
        if side == 'left':
            x = radius * math.sin(theta)
            y = cy - radius * math.cos(theta)
        else:
            x = radius * math.sin(theta)
            y = cy + radius * math.cos(theta)
        pts.append((x, y))
    return pts


class TestKasa:
    def test_recovers_known_circle(self):
        # 50 m radius arc, left turn.
        pts = _arc(50.0, n=200)
        cx, cy, r, rms = _fit_circle_kasa(pts)
        assert r == pytest.approx(50.0, rel=1e-6)
        assert rms < 1e-9

    def test_recovers_right_turn(self):
        pts = _arc(80.0, n=150, side='right')
        cx, cy, r, _rms = _fit_circle_kasa(pts)
        assert r == pytest.approx(80.0, rel=1e-6)
        # Centre below the chord for a right turn.
        assert cy < 0

    def test_collinear_returns_infinite_radius(self):
        pts = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0)]
        _cx, _cy, r, _rms = _fit_circle_kasa(pts)
        assert math.isinf(r)


class TestSolverClean:
    def test_straight_returns_zero_trim(self):
        # 10 m of perfectly straight ENU samples ⇒ trim = 0.
        pts = [(i * 0.05, 0.0) for i in range(201)]
        result = solve_steering_trim(
            samples=pts, kappa_max=KAPPA_MAX,
            servo_range_us=SERVO_RANGE, drive_distance_m=10.0,
        )
        assert result['reason'] is None
        assert result['trim_us'] == pytest.approx(0.0, abs=1e-6)

    def test_left_arc_yields_negative_trim(self):
        # Rover commanded κ=0 but path arcs left (radius 50 m). The
        # corrective trim must be NEGATIVE (counter the bias).
        pts = _arc(50.0, n=200, side='left')
        result = solve_steering_trim(
            samples=pts, kappa_max=KAPPA_MAX,
            servo_range_us=SERVO_RANGE, drive_distance_m=10.0,
        )
        assert result['reason'] is None
        # κ_bias = +1/50 = 0.02; trim_us = -0.02/1.227 * 500 ≈ -8.15 µs.
        expected = -(1.0 / 50.0) / KAPPA_MAX * SERVO_RANGE
        assert result['trim_us'] == pytest.approx(expected, abs=0.01)
        assert result['radius_m'] > 0  # signed positive for left turn

    def test_right_arc_yields_positive_trim(self):
        pts = _arc(50.0, n=200, side='right')
        result = solve_steering_trim(
            samples=pts, kappa_max=KAPPA_MAX,
            servo_range_us=SERVO_RANGE, drive_distance_m=10.0,
        )
        assert result['reason'] is None
        expected = (1.0 / 50.0) / KAPPA_MAX * SERVO_RANGE
        assert result['trim_us'] == pytest.approx(expected, abs=0.01)
        assert result['radius_m'] < 0


class TestSolverGates:
    def test_too_few_samples(self):
        pts = _arc(50.0, n=SOLVE_MIN_SAMPLES - 1)
        result = solve_steering_trim(
            samples=pts, kappa_max=KAPPA_MAX,
            servo_range_us=SERVO_RANGE, drive_distance_m=10.0,
        )
        assert 'too few' in result['reason']

    def test_short_chord_rejected(self):
        pts = _arc(50.0, n=200)
        result = solve_steering_trim(
            samples=pts, kappa_max=KAPPA_MAX,
            servo_range_us=SERVO_RANGE,
            drive_distance_m=SOLVE_MIN_DISTANCE_M - 0.1,
        )
        assert 'chord too short' in result['reason']

    def test_radius_above_threshold_treated_as_straight(self):
        # 200 m radius is detectable but irrelevant — chord deviation
        # over 10 m is < 1 cm. Solver must report 0 trim, not a tiny
        # always-changing correction that shifts µs each cal.
        pts = _arc(2 * RADIUS_LARGE_M, n=200)
        result = solve_steering_trim(
            samples=pts, kappa_max=KAPPA_MAX,
            servo_range_us=SERVO_RANGE, drive_distance_m=10.0,
        )
        assert result['reason'] is None
        assert result['trim_us'] == 0.0

    def test_huge_bias_rejected(self):
        # Radius 5 m on a κ=0 commanded drive is pathological — κ ≈ 0.2,
        # which would produce a trim of ~80 µs. That's beyond TRIM_BOUND_US;
        # the solver must refuse to persist it.
        pts = _arc(5.0, n=200, total_angle_rad=math.pi / 4)
        result = solve_steering_trim(
            samples=pts, kappa_max=KAPPA_MAX,
            servo_range_us=SERVO_RANGE, drive_distance_m=10.0,
        )
        assert result['reason'] is not None
        assert 'outside' in result['reason']
        # Reported value still surfaced for logging, just not persisted.
        assert abs(result['trim_us']) > TRIM_BOUND_US


class TestPersistence:
    def test_round_trip(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        save_steering_trim(
            7.4,
            radius_m=-103.2,
            rms_residual_m=0.018,
            samples=850,
            drive_distance_m=10.05,
        )
        trim, payload = load_steering_trim(default=0.0)
        assert trim == pytest.approx(7.4, abs=1e-3)
        assert payload['samples'] == 850

    def test_load_missing_returns_default(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        trim, payload = load_steering_trim(default=0.0)
        assert trim == 0.0
        assert payload is None

    def test_load_corrupt_returns_default(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        (tmp_path / STEERING_TRIM_FILENAME).write_text('{not valid json')
        trim, _ = load_steering_trim(default=0.0)
        assert trim == 0.0

    def test_load_out_of_range_rejected(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        (tmp_path / STEERING_TRIM_FILENAME).write_text(
            json.dumps({'trim_us': TRIM_BOUND_US * 2, 'calibrated_at': 1})
        )
        trim, _ = load_steering_trim(default=0.0)
        assert trim == 0.0

    def test_save_rejects_out_of_range(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        with pytest.raises(ValueError):
            save_steering_trim(
                TRIM_BOUND_US * 2,
                radius_m=10.0,
                rms_residual_m=0.01,
                samples=100,
                drive_distance_m=10.0,
            )

    def test_save_handles_infinite_radius(self, tmp_path, monkeypatch):
        # Straight drive returns radius_m = inf; persistence must not
        # write `Infinity` (invalid JSON in some readers) — the schema
        # uses null for "no measurable arc".
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        save_steering_trim(
            0.0,
            radius_m=float('inf'),
            rms_residual_m=0.005,
            samples=200,
            drive_distance_m=10.0,
        )
        with open(steering_trim_path()) as f:
            data = json.load(f)
        assert data['radius_m'] is None
