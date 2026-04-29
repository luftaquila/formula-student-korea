"""Tests for wheel_calibration module: solver, persistence, gates."""

import json

import pytest

from pilot.lib.wheel_calibration import (
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


class TestSolverClean:
    def test_recovers_unity_scale_on_perfect_match(self):
        # gps_distance == encoder distance for both wheels ⇒ scales == 1.0.
        result = solve_wheel_scales(
            gps_distance_m=10.0,
            encoder_left_m=10.0,
            encoder_right_m=10.0,
            samples=200,
        )
        assert result['reason'] is None
        assert result['scale_l'] == pytest.approx(1.0, abs=1e-9)
        assert result['scale_r'] == pytest.approx(1.0, abs=1e-9)

    def test_recovers_asymmetric_mismatch(self):
        # Left wheel under-reports by 2 %, right over-reports by 1 %.
        # gps_dist = 10, enc_l = 9.8 ⇒ scale_l = 1.0204; enc_r = 10.1 ⇒ scale_r = 0.9901.
        result = solve_wheel_scales(
            gps_distance_m=10.0,
            encoder_left_m=9.8,
            encoder_right_m=10.1,
            samples=200,
        )
        assert result['reason'] is None
        assert result['scale_l'] == pytest.approx(10.0 / 9.8, abs=1e-6)
        assert result['scale_r'] == pytest.approx(10.0 / 10.1, abs=1e-6)


class TestSolverGates:
    def test_too_few_samples(self):
        result = solve_wheel_scales(
            gps_distance_m=10.0,
            encoder_left_m=10.0,
            encoder_right_m=10.0,
            samples=SOLVE_MIN_SAMPLES - 1,
        )
        assert result['reason'] is not None
        assert 'too few' in result['reason']

    def test_short_chord_rejected(self):
        # Even with healthy encoder data, a short drive can't resolve
        # wheel-scale signal above RTK noise floor.
        result = solve_wheel_scales(
            gps_distance_m=SOLVE_MIN_DISTANCE_M - 0.1,
            encoder_left_m=4.0,
            encoder_right_m=4.0,
            samples=200,
        )
        assert result['reason'] is not None
        assert 'chord too short' in result['reason']

    def test_zero_encoder_rejected(self):
        # Wheel didn't turn (slip / stall) — must not divide by ~zero.
        result = solve_wheel_scales(
            gps_distance_m=10.0,
            encoder_left_m=0.0,
            encoder_right_m=10.0,
            samples=200,
        )
        assert result['reason'] is not None
        assert 'encoder displacement' in result['reason']

    def test_out_of_range_left_rejected(self):
        # gps 10 m, encoder 5 m ⇒ scale 2.0 — refuse to persist.
        result = solve_wheel_scales(
            gps_distance_m=10.0,
            encoder_left_m=5.0,
            encoder_right_m=10.0,
            samples=200,
        )
        assert result['reason'] is not None
        assert 'left scale' in result['reason']

    def test_out_of_range_right_rejected(self):
        result = solve_wheel_scales(
            gps_distance_m=10.0,
            encoder_left_m=10.0,
            encoder_right_m=20.0,
            samples=200,
        )
        assert result['reason'] is not None
        assert 'right scale' in result['reason']


class TestPersistence:
    def test_round_trip(self, tmp_path, monkeypatch):
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
        assert scales[1] == pytest.approx(0.987, abs=1e-5)
        assert payload['samples'] == 200
        assert isinstance(payload['calibrated_at'], int)

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
