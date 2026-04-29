"""Tests for antenna_calibration module: solver, persistence, drive shape.

The solver test is the load-bearing one. It synthesises calibration-drive
samples from a known offset, runs the LSQ, and pins the output to the
input within sub-mm. If this regresses, the auto-cal silently produces a
wrong offset and every subsequent mission misses its target.
"""

import json
import os
import random
from math import cos, sin, pi, isclose

import pytest

from pilot.lib.antenna_calibration import (
    ANTENNA_OFFSET_FILENAME,
    OFFSET_BOUND_M,
    SOLVE_MIN_SAMPLES,
    SOLVE_PSI_SPREAD_MIN_RAD,
    antenna_offset_path,
    load_antenna_offset,
    save_antenna_offset,
    solve_antenna_offset,
    scurve_curvature,
)


def _synthesize_samples(true_a_x, true_a_y, n=80, noise_xy_m=0.0, seed=42):
    """Generate (chassis_pose, antenna_obs) samples for a known offset.

    Chassis traces a representative S-curve trajectory. Antenna observation
    is rigid-body forward kinematics + optional Gaussian noise — matches
    what the rover sees during a real calibration drive.
    """
    rng = random.Random(seed)
    samples = []
    for i in range(n):
        t = i * 0.1
        # Chassis position swings in a rough S-curve.
        psi = 0.6 * (i / n) - 0.3 + 0.2 * rng.gauss(0.0, 1.0) * 0.0  # noise off
        psi = 0.8 * (0.5 - (i / n)) ** 2 - 0.1  # smooth function of time
        x_c = 0.5 * t  # roughly forward
        y_c = 0.05 * sin(2 * pi * t / 4.0)
        a_obs_x = x_c + cos(psi) * true_a_x - sin(psi) * true_a_y
        a_obs_y = y_c + sin(psi) * true_a_x + cos(psi) * true_a_y
        if noise_xy_m > 0.0:
            a_obs_x += rng.gauss(0.0, noise_xy_m)
            a_obs_y += rng.gauss(0.0, noise_xy_m)
        samples.append((x_c, y_c, psi, a_obs_x, a_obs_y))
    return samples


class TestSolverClean:
    def test_recovers_known_offset_zero_noise(self):
        # If the math is right, zero-noise samples must round-trip the
        # input offset to within floating point.
        true_a_x, true_a_y = 0.30, 0.05
        samples = _synthesize_samples(true_a_x, true_a_y, n=80, noise_xy_m=0.0)
        result = solve_antenna_offset(samples)
        assert result['reason'] is None
        assert isclose(result['a_x'], true_a_x, abs_tol=1e-6)
        assert isclose(result['a_y'], true_a_y, abs_tol=1e-6)
        assert result['rms_residual_m'] < 1e-6
        assert result['samples'] == 80

    def test_recovers_negative_offsets(self):
        # The solver must work for a_y < 0 (antenna mounted to the right
        # of centerline) without sign confusion.
        samples = _synthesize_samples(0.40, -0.12, n=60)
        result = solve_antenna_offset(samples)
        assert result['reason'] is None
        assert isclose(result['a_x'], 0.40, abs_tol=1e-6)
        assert isclose(result['a_y'], -0.12, abs_tol=1e-6)

    def test_rear_axle_antenna_zero_offset(self):
        # Edge case: antenna at the rear axle. Solver must report (0, 0)
        # cleanly rather than picking up numerical drift from the
        # constant-zero u vectors.
        samples = _synthesize_samples(0.0, 0.0, n=60)
        result = solve_antenna_offset(samples)
        assert result['reason'] is None
        assert abs(result['a_x']) < 1e-9
        assert abs(result['a_y']) < 1e-9


class TestSolverNoisy:
    def test_recovers_offset_with_field_grade_gps_noise(self):
        # ZED-F9P RTK fixed positioning is ~1 cm 1σ at the antenna. With 60
        # samples the solver should still land within a few mm of truth —
        # the field requirement is ~3 cm to keep antenna within
        # waypoint_tolerance.
        samples = _synthesize_samples(0.30, 0.05, n=60, noise_xy_m=0.01)
        result = solve_antenna_offset(samples)
        assert result['reason'] is None
        assert abs(result['a_x'] - 0.30) < 0.01
        assert abs(result['a_y'] - 0.05) < 0.01


class TestSolverGates:
    def test_too_few_samples(self):
        samples = _synthesize_samples(0.3, 0.0, n=SOLVE_MIN_SAMPLES - 1)
        result = solve_antenna_offset(samples)
        assert 'too few' in result['reason']

    def test_residual_above_gate_rejected(self):
        # Inject heavy Gaussian noise so residual RMS exceeds the gate. The
        # solver must return a `reason` rather than persisting a poor fit.
        samples = _synthesize_samples(0.3, 0.0, n=80, noise_xy_m=0.20)
        result = solve_antenna_offset(samples)
        assert result['reason'] is not None
        assert 'residual' in result['reason'].lower()

    def test_offset_out_of_bounds_rejected(self):
        # If chassis pose drifts wildly (encoder slip), the solver might
        # land on a physically impossible offset. Reject before persisting.
        samples = _synthesize_samples(2.5, 0.0, n=60)  # a_x > OFFSET_BOUND_M
        result = solve_antenna_offset(samples)
        assert result['reason'] is not None
        assert 'out of bounds' in result['reason']

    def test_near_constant_psi_rejected(self):
        # SCURVE that failed to execute (encoder stall, mid-drive E-Stop)
        # leaves a sample set with effectively no ψ rotation. The solver
        # would silently absorb chassis-pose origin error into a_x/a_y
        # without this gate.
        samples = []
        for i in range(60):
            psi = 0.10 + 1e-3 * (i / 60)  # ~0.001 rad spread, far below gate
            x_c = 0.05 * i
            y_c = 0.0
            a_obs_x = x_c + cos(psi) * 0.30 - sin(psi) * 0.05
            a_obs_y = y_c + sin(psi) * 0.30 + cos(psi) * 0.05
            samples.append((x_c, y_c, psi, a_obs_x, a_obs_y))
        result = solve_antenna_offset(samples)
        assert result['reason'] is not None
        assert 'ψ excitation' in result['reason']

    def test_psi_spread_wraps_across_pi_handled(self):
        # ψ samples that cross the ±π boundary (e.g. SCURVE driving a
        # chassis already pointing near south). Naïve max−min on raw
        # angles would compute spread ≈ 2π and pass the gate even when
        # the actual rotation is tiny. The solver unwraps before checking.
        samples = []
        from math import pi as _pi
        for i in range(60):
            # Oscillate tightly around π: real spread 0.01 rad, raw spread
            # ≈ 2π if half are at +π−ε and half at −π+ε.
            if i % 2 == 0:
                psi = _pi - 0.005
            else:
                psi = -_pi + 0.005
            x_c = 0.05 * i
            y_c = 0.0
            a_obs_x = x_c + cos(psi) * 0.30 - sin(psi) * 0.05
            a_obs_y = y_c + sin(psi) * 0.30 + cos(psi) * 0.05
            samples.append((x_c, y_c, psi, a_obs_x, a_obs_y))
        result = solve_antenna_offset(samples)
        # Real ψ excitation is ~0.01 rad — must be rejected, not promoted
        # to ~6.28 rad by a wrap.
        assert result['reason'] is not None
        assert 'ψ excitation' in result['reason']


class TestPersistence:
    def test_round_trip(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        save_antenna_offset(0.301, 0.045, rms_residual_m=0.012,
                            samples=75, drive_distance_m=5.5)
        offset, payload = load_antenna_offset(default=(0.0, 0.0))
        assert offset == (0.301, 0.045)
        assert payload['samples'] == 75
        assert payload['rms_residual_m'] == 0.012
        assert isinstance(payload['calibrated_at'], int)

    def test_load_missing_returns_default(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        offset, payload = load_antenna_offset(default=(0.25, 0.0))
        assert offset == (0.25, 0.0)
        assert payload is None

    def test_load_corrupt_returns_default(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        (tmp_path / ANTENNA_OFFSET_FILENAME).write_text('{not valid json')
        offset, payload = load_antenna_offset(default=(0.30, 0.0))
        assert offset == (0.30, 0.0)
        assert payload is None

    def test_load_out_of_range_rejected(self, tmp_path, monkeypatch):
        # A stale or hand-edited file with an absurd offset must NOT be
        # adopted on boot — we'd rather fall back to the YAML default than
        # plan with a 5 m offset and fly the rover off course.
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        (tmp_path / ANTENNA_OFFSET_FILENAME).write_text(
            json.dumps({'a_x': 5.0, 'a_y': 0.0, 'calibrated_at': 1})
        )
        offset, payload = load_antenna_offset(default=(0.30, 0.0))
        assert offset == (0.30, 0.0)
        assert payload is None

    def test_save_rejects_out_of_range(self, tmp_path, monkeypatch):
        monkeypatch.setenv('PILOT_STATE_DIR', str(tmp_path))
        with pytest.raises(ValueError):
            save_antenna_offset(2.0, 0.0, rms_residual_m=0.01,
                                samples=60, drive_distance_m=5.0)


class TestScurveShape:
    def test_zero_at_period_boundaries(self):
        # κ(t) = κ_max · sin(2π·t/period). At t = 0, period, 2·period, the
        # curvature is zero — that's the property that makes net yaw zero
        # over a full period and keeps the calibration drive bounded.
        for k in range(4):
            assert isclose(scurve_curvature(k * 4.0, 0.5, 4.0),
                           0.0, abs_tol=1e-12)

    def test_extrema_at_quarter_periods(self):
        # +κ_max at t = period/4, -κ_max at t = 3·period/4.
        assert isclose(scurve_curvature(1.0, 0.5, 4.0), 0.5, abs_tol=1e-12)
        assert isclose(scurve_curvature(3.0, 0.5, 4.0), -0.5, abs_tol=1e-12)

    def test_zero_period_returns_zero(self):
        # Defensive: a misconfigured period must not divide by zero.
        assert scurve_curvature(1.0, 0.5, 0.0) == 0.0
