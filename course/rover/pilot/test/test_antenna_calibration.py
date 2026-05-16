"""Tests for antenna_calibration module.

`solve_antenna_offset_circular` is the load-bearing piece — closed-form
(a_x, a_y) from a known constant-curvature orbit drive, used by the live
calibration drive. Doesn't depend on instantaneous chassis ψ; only orbit
geometry.

If it regresses, auto-cal silently produces a wrong offset and every
subsequent mission misses its target.
"""

import json
import random
from math import cos, sin, pi, isclose

import pytest

from pilot.lib.antenna_calibration import (
    ANTENNA_OFFSET_FILENAME,
    OFFSET_BOUND_M,
    SOLVE_MIN_SAMPLES,
    antenna_offset_path,
    load_antenna_offset,
    save_antenna_offset,
    solve_antenna_offset_circular,
)


def _synthesize_circular_samples(true_a_x, true_a_y, *, radius_m=1.0, n=80,
                                 revolutions=2, sign=1, theta_origin=0.0,
                                 noise_xy_m=0.0, seed=42):
    """Generate orbit-drive samples for a known offset on a constant-R orbit.

    Chassis traces a circle of radius `radius_m` around the origin starting
    at orbit angle `theta_origin`. `sign=+1` is CCW, `sign=−1` is CW. The
    antenna observation is rigid-body forward kinematics + optional Gaussian
    noise — matches what the rover sees during a real circular cal drive.
    """
    rng = random.Random(seed)
    samples = []
    sweep = sign * 2.0 * pi * revolutions
    for i in range(n):
        frac = i / (n - 1) if n > 1 else 0.0
        theta = theta_origin + sweep * frac
        cx = radius_m * cos(theta)
        cy = radius_m * sin(theta)
        psi = theta + sign * pi / 2.0
        a_obs_x = cx + cos(psi) * true_a_x - sin(psi) * true_a_y
        a_obs_y = cy + sin(psi) * true_a_x + cos(psi) * true_a_y
        if noise_xy_m > 0.0:
            a_obs_x += rng.gauss(0.0, noise_xy_m)
            a_obs_y += rng.gauss(0.0, noise_xy_m)
        samples.append((cx, cy, psi, a_obs_x, a_obs_y))
    return samples


class TestCircularSolverClean:
    def test_recovers_known_offset_ccw_zero_noise(self):
        # Truth-rate sanity: zero-noise CCW orbit, the closed-form must
        # round-trip the input offset to floating-point precision.
        samples = _synthesize_circular_samples(0.30, 0.05, radius_m=1.0,
                                               n=80, revolutions=2, sign=1)
        result = solve_antenna_offset_circular(samples)
        assert result['reason'] is None, result.get('reason')
        assert isclose(result['a_x'], 0.30, abs_tol=1e-4)
        assert isclose(result['a_y'], 0.05, abs_tol=1e-4)
        assert result['rotation_sign'] > 0
        assert isclose(result['circle_R_m'], 1.0, abs_tol=1e-4)

    def test_recovers_known_offset_cw_zero_noise(self):
        # CW orbit. The phase-offset formula has a sign flip; this test
        # pins it (a_x sign correctness for both rotation directions is
        # the bit most likely to break under refactor).
        samples = _synthesize_circular_samples(0.30, 0.05, radius_m=1.0,
                                               n=80, revolutions=2, sign=-1)
        result = solve_antenna_offset_circular(samples)
        assert result['reason'] is None, result.get('reason')
        assert isclose(result['a_x'], 0.30, abs_tol=1e-4)
        assert isclose(result['a_y'], 0.05, abs_tol=1e-4)
        assert result['rotation_sign'] < 0

    def test_recovers_negative_y_offset(self):
        # Antenna mounted to the right of centerline (a_y < 0).
        samples = _synthesize_circular_samples(0.30, -0.10, radius_m=1.0,
                                               n=100, revolutions=2, sign=1)
        result = solve_antenna_offset_circular(samples)
        assert result['reason'] is None
        assert abs(result['a_x'] - 0.30) < 1e-4
        assert abs(result['a_y'] + 0.10) < 1e-4

    def test_recovers_zero_offset(self):
        # Antenna at the rear-axle centre — offset (0, 0). The orbit
        # collapses to a single circle (chassis === antenna trace) so the
        # phase mean is near 0 and r vector is near zero.
        samples = _synthesize_circular_samples(0.0, 0.0, radius_m=1.0,
                                               n=60, revolutions=2, sign=1)
        result = solve_antenna_offset_circular(samples)
        assert result['reason'] is None
        assert abs(result['a_x']) < 1e-4
        assert abs(result['a_y']) < 1e-4

    def test_starting_at_arbitrary_orbit_angle(self):
        # The drive doesn't necessarily start at orbit angle 0. The unwrap +
        # circular-mean machinery must handle a starting θ near the ±π
        # boundary without picking the wrong branch.
        samples = _synthesize_circular_samples(0.30, 0.05, radius_m=1.0,
                                               n=80, revolutions=2, sign=1,
                                               theta_origin=pi - 0.1)
        result = solve_antenna_offset_circular(samples)
        assert result['reason'] is None, result.get('reason')
        assert abs(result['a_x'] - 0.30) < 1e-3
        assert abs(result['a_y'] - 0.05) < 1e-3


class TestCircularSolverNoisy:
    def test_field_grade_gps_noise_recovers_truth(self):
        # ZED-F9P RTK fixed at ~1 cm 1σ. With 100 samples over 2 revolutions,
        # the orbit fit averages enough that the recovered (a_x, a_y) lands
        # within ~2 cm of truth.
        samples = _synthesize_circular_samples(0.30, 0.05, radius_m=1.0,
                                               n=100, revolutions=2, sign=1,
                                               noise_xy_m=0.01, seed=7)
        result = solve_antenna_offset_circular(samples)
        assert result['reason'] is None, result.get('reason')
        assert abs(result['a_x'] - 0.30) < 0.02
        assert abs(result['a_y'] - 0.05) < 0.02

    def test_heading_lag_doesnt_rotate_recovered_offset(self):
        # The whole reason we switched from SCURVE to circular drive: GPS
        # heading-of-motion lags actual chassis ψ by ~100 ms, which on a
        # SCURVE rotates the recovered r vector while preserving |r|.
        # The orbit method doesn't consume per-sample ψ at all, so even if
        # we synthesise samples with each chassis_psi shifted by the
        # equivalent of a 100 ms doppler lag, the solver still returns the
        # correct (a_x, a_y).
        true_a_x, true_a_y = 0.30, 0.05
        samples = _synthesize_circular_samples(true_a_x, true_a_y,
                                               radius_m=1.0, n=80,
                                               revolutions=2, sign=1)
        # Inject a 100 ms equivalent ψ lag (ω·dt ≈ 0.1 rad at v=1, R=1).
        lag = 0.1
        biased = [(s[0], s[1], s[2] - lag, s[3], s[4]) for s in samples]
        result = solve_antenna_offset_circular(biased)
        assert result['reason'] is None
        assert abs(result['a_x'] - true_a_x) < 1e-3
        assert abs(result['a_y'] - true_a_y) < 1e-3


class TestCircularSolverGates:
    def test_too_few_samples(self):
        samples = _synthesize_circular_samples(0.30, 0.0, n=SOLVE_MIN_SAMPLES - 1)
        result = solve_antenna_offset_circular(samples)
        assert 'too few' in result['reason']

    def test_short_sweep_rejected(self):
        # Less than ~3/4 revolution → orbit centre fit is poorly
        # constrained. Solver must refuse rather than report a noisy r.
        samples = _synthesize_circular_samples(0.30, 0.0, radius_m=1.0,
                                               n=60, revolutions=0.3,
                                               sign=1)
        result = solve_antenna_offset_circular(samples)
        assert result['reason'] is not None
        assert 'sweep' in result['reason'].lower()

    def test_offset_out_of_bounds_rejected(self):
        # A_x of 2.5 m on a 1 m orbit produces a wildly off-axis antenna
        # circle — solver should still reject on bounds even though the
        # circle fit itself succeeds.
        samples = _synthesize_circular_samples(2.5, 0.0, radius_m=1.0,
                                               n=80, revolutions=2, sign=1)
        result = solve_antenna_offset_circular(samples)
        assert result['reason'] is not None
        assert 'out of bounds' in result['reason']

    def test_chassis_not_circular_rejected(self):
        # Chassis trace with high non-circular noise (e.g. encoder slip).
        # The chassis circle fit RMS exceeds the gate.
        samples = _synthesize_circular_samples(0.30, 0.0, radius_m=1.0,
                                               n=80, revolutions=2, sign=1)
        rng = random.Random(13)
        # Wreck the chassis trace, leave the antenna trace clean.
        wrecked = [(s[0] + rng.gauss(0, 0.30),
                    s[1] + rng.gauss(0, 0.30),
                    s[2], s[3], s[4]) for s in samples]
        result = solve_antenna_offset_circular(wrecked)
        assert result['reason'] is not None
        assert 'chassis' in result['reason'].lower()

    def test_centre_mismatch_rejected(self):
        # Chassis trace and antenna trace must share the same orbit centre
        # (rigid body). Translating the antenna trace by 1 m while leaving
        # the chassis trace alone breaks that — solver should flag it.
        samples = _synthesize_circular_samples(0.30, 0.0, radius_m=1.0,
                                               n=80, revolutions=2, sign=1)
        shifted = [(s[0], s[1], s[2], s[3] + 1.0, s[4]) for s in samples]
        result = solve_antenna_offset_circular(shifted)
        assert result['reason'] is not None
        assert 'centre' in result['reason'].lower()


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
