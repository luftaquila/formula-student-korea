"""Tests for ackermann module."""

import pytest
from math import radians, isclose
from pilot.lib.ackermann import ackermann_convert, manual_to_ackermann

# Common test parameters
WHEELBASE = 0.38
TRACK_WIDTH = 0.30
MAX_SPEED = 1.0
MAX_STEER_RAD = radians(25.0)
CENTER_US = 1500
RANGE_US = 500


class TestAckermannConvert:
    def test_straight_forward(self):
        left, right, servo = ackermann_convert(
            0.5, 0.0, WHEELBASE, TRACK_WIDTH,
            MAX_SPEED, MAX_STEER_RAD, CENTER_US, RANGE_US,
        )
        assert isclose(left, 50.0, abs_tol=0.1)
        assert isclose(right, 50.0, abs_tol=0.1)
        assert isclose(servo, CENTER_US, abs_tol=1)

    def test_stopped(self):
        left, right, servo = ackermann_convert(
            0.0, 0.0, WHEELBASE, TRACK_WIDTH,
            MAX_SPEED, MAX_STEER_RAD, CENTER_US, RANGE_US,
        )
        assert left == 0.0
        assert right == 0.0
        assert isclose(servo, CENTER_US, abs_tol=1)

    def test_left_turn_differential(self):
        # Left turn: positive curvature, inner (left) wheel slower
        left, right, servo = ackermann_convert(
            0.5, 1.0, WHEELBASE, TRACK_WIDTH,
            MAX_SPEED, MAX_STEER_RAD, CENTER_US, RANGE_US,
        )
        assert left < right  # inner wheel slower
        assert servo > CENTER_US  # servo turns left

    def test_right_turn_differential(self):
        # Right turn: negative curvature, inner (right) wheel slower
        left, right, servo = ackermann_convert(
            0.5, -1.0, WHEELBASE, TRACK_WIDTH,
            MAX_SPEED, MAX_STEER_RAD, CENTER_US, RANGE_US,
        )
        assert right < left  # inner wheel slower
        assert servo < CENTER_US  # servo turns right

    def test_reverse(self):
        left, right, servo = ackermann_convert(
            -0.5, 0.0, WHEELBASE, TRACK_WIDTH,
            MAX_SPEED, MAX_STEER_RAD, CENTER_US, RANGE_US,
        )
        assert isclose(left, -50.0, abs_tol=0.1)
        assert isclose(right, -50.0, abs_tol=0.1)

    def test_steering_clamp(self):
        # Very high curvature should clamp to max_steering_angle
        _, _, servo = ackermann_convert(
            0.5, 100.0, WHEELBASE, TRACK_WIDTH,
            MAX_SPEED, MAX_STEER_RAD, CENTER_US, RANGE_US,
        )
        assert servo <= CENTER_US + RANGE_US + 1

    def test_duty_clamp(self):
        # Full speed should not exceed 100%
        left, right, _ = ackermann_convert(
            2.0, 0.0, WHEELBASE, TRACK_WIDTH,
            MAX_SPEED, MAX_STEER_RAD, CENTER_US, RANGE_US,
        )
        assert left <= 100.0
        assert right <= 100.0


class TestManualToAckermann:
    def test_center(self):
        left, right, servo = manual_to_ackermann(0, 0, CENTER_US, RANGE_US)
        assert left == 0.0
        assert right == 0.0
        assert isclose(servo, CENTER_US, abs_tol=1)

    def test_full_forward(self):
        left, right, servo = manual_to_ackermann(100, 0, CENTER_US, RANGE_US)
        assert left == 100.0
        assert right == 100.0
        assert isclose(servo, CENTER_US, abs_tol=1)

    def test_full_right(self):
        # positive steering = right = servo_us < center
        _, _, servo = manual_to_ackermann(50, 100, CENTER_US, RANGE_US)
        assert isclose(servo, CENTER_US - RANGE_US, abs_tol=1)

    def test_full_left(self):
        # negative steering = left = servo_us > center
        _, _, servo = manual_to_ackermann(50, -100, CENTER_US, RANGE_US)
        assert isclose(servo, CENTER_US + RANGE_US, abs_tol=1)
