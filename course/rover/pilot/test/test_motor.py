"""Tests for motor_node parameter sanity + accel limiting ceiling."""

import pytest
from pilot.motor_node import MotorNode


@pytest.fixture
def motor():
    return MotorNode()


def test_apply_accel_limit_hard_cap(motor):
    """Ensure a single tick cannot jump duty by more than 100% even if accel is misconfigured."""
    # Force a pathological accel by overriding the underlying param dict
    motor.set_parameter_value('accel_limit', 1000.0)  # way too high
    motor.set_parameter_value('max_speed', 1.0)
    out = motor._apply_accel_limit(target=100.0, current=0.0, dt=0.05)
    # max_delta would be 1000/1*100*0.05=5000 without the cap; must be clamped.
    assert out - 0.0 <= 100.0 + 1e-6


def test_validate_params_rejects_bad_servo_center(motor):
    motor.set_parameter_value('servo_center_us', 100)  # below 500 floor
    with pytest.raises(SystemExit):
        motor._validate_params()


def test_validate_params_rejects_bad_accel(motor):
    motor.set_parameter_value('accel_limit', 0.0)
    with pytest.raises(SystemExit):
        motor._validate_params()


def test_validate_params_rejects_bad_max_speed(motor):
    motor.set_parameter_value('max_speed', 0.01)  # below 0.1 floor
    with pytest.raises(SystemExit):
        motor._validate_params()
