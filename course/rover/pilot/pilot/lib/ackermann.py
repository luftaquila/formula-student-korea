"""Ackermann steering geometry conversion.

Converts (speed, curvature) commands to (left_duty, right_duty, servo_us)
for the Wheeltec R550 AKM Plus platform.
"""

from math import atan, tan, fabs, pi


def _validate_params(wheelbase, track_width, max_steering_angle_rad):
    if wheelbase <= 0:
        raise ValueError(f"wheelbase must be > 0 (got {wheelbase})")
    if track_width <= 0:
        raise ValueError(f"track_width must be > 0 (got {track_width})")
    if not (0.0 < max_steering_angle_rad < pi / 2):
        raise ValueError(
            f"max_steering_angle_rad must be in (0, pi/2); got {max_steering_angle_rad}"
        )


def ackermann_convert(speed, curvature, wheelbase, track_width,
                      max_speed, max_steering_angle_rad,
                      servo_center_us, servo_range_us):
    """Convert desired speed and curvature to motor duties and steering servo pulse.

    Args:
        speed: desired forward speed in m/s (positive=forward, negative=reverse)
        curvature: desired path curvature in 1/m (positive=left turn, negative=right turn)
        wheelbase: distance between front and rear axles in meters
        track_width: distance between left and right rear wheels in meters
        max_speed: maximum speed in m/s (maps to 100% duty)
        max_steering_angle_rad: maximum front wheel steering angle in radians
        servo_center_us: servo center pulse width in microseconds
        servo_range_us: servo range from center in microseconds (+/- for full lock)

    Returns:
        (left_duty, right_duty, servo_us) where duty is -100.0 to 100.0 percent
        and servo_us is pulse width in microseconds.
    """
    _validate_params(wheelbase, track_width, max_steering_angle_rad)
    # Compute steering angle from curvature
    # curvature = 1/R, steering_angle = atan(wheelbase / R) = atan(curvature * wheelbase)
    if fabs(curvature) > 1e-6:
        steering_angle = atan(curvature * wheelbase)
    else:
        steering_angle = 0.0

    # Clamp steering angle
    steering_angle = max(-max_steering_angle_rad, min(max_steering_angle_rad, steering_angle))

    # Servo pulse width
    servo_us = servo_center_us + (steering_angle / max_steering_angle_rad) * servo_range_us

    # Inner/outer wheel speed differential for Ackermann
    if fabs(steering_angle) > 0.01:
        turn_radius = wheelbase / tan(fabs(steering_angle))
        v_left = speed * (turn_radius - track_width / 2) / turn_radius
        v_right = speed * (turn_radius + track_width / 2) / turn_radius
        # Swap if turning right (negative steering angle)
        if steering_angle < 0:
            v_left, v_right = v_right, v_left
    else:
        v_left = speed
        v_right = speed

    # Convert to duty cycle percentage (-100 to 100)
    if max_speed > 0:
        left_duty = max(-100.0, min(100.0, (v_left / max_speed) * 100.0))
        right_duty = max(-100.0, min(100.0, (v_right / max_speed) * 100.0))
    else:
        left_duty = 0.0
        right_duty = 0.0

    return left_duty, right_duty, servo_us


def manual_to_ackermann(throttle_pct, steering_pct, servo_center_us, servo_range_us):
    """Convert manual joystick input (-100~100) to motor duties and steering servo.

    Simple direct mapping for manual control mode.

    Args:
        throttle_pct: throttle percentage -100 to 100 (positive=forward)
        steering_pct: steering percentage -100 to 100 (positive=right)
        servo_center_us: servo center pulse width
        servo_range_us: servo range from center

    Returns:
        (left_duty, right_duty, servo_us)
    """
    # Direct throttle mapping - both motors same speed
    left_duty = max(-100.0, min(100.0, throttle_pct))
    right_duty = max(-100.0, min(100.0, throttle_pct))

    # Direct steering mapping
    # Negate: positive steering_pct = right = servo_us < center
    # (consistent with ackermann_convert where negative curvature = right turn)
    servo_us = servo_center_us - (steering_pct / 100.0) * servo_range_us

    return left_duty, right_duty, servo_us
