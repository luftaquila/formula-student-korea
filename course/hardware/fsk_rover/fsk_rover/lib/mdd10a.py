"""Cytron MDD10A dual-channel DC motor driver via GPIO PWM+DIR.

Each channel uses two GPIO pins:
  - DIR pin: direction (HIGH=forward, LOW=reverse)
  - PWM pin: speed as duty cycle (0-100%)

Uses lgpio library for hardware PWM on Raspberry Pi 5.
"""

import lgpio

PWM_FREQUENCY = 1000  # 1kHz PWM frequency


class MDD10A:
    """Cytron MDD10A dual motor driver controller."""

    def __init__(self, dir1_pin, pwm1_pin, dir2_pin, pwm2_pin, chip=4):
        """Initialize the MDD10A motor driver.

        Args:
            dir1_pin: GPIO pin number for channel 1 direction
            pwm1_pin: GPIO pin number for channel 1 PWM
            dir2_pin: GPIO pin number for channel 2 direction
            pwm2_pin: GPIO pin number for channel 2 PWM
            chip: GPIO chip number (4 for RPi5 RP1)
        """
        self._dir1 = dir1_pin
        self._pwm1 = pwm1_pin
        self._dir2 = dir2_pin
        self._pwm2 = pwm2_pin

        self._handle = lgpio.gpiochip_open(chip)

        # Setup direction pins as output
        lgpio.gpio_claim_output(self._handle, self._dir1, 0)
        lgpio.gpio_claim_output(self._handle, self._dir2, 0)

        # Setup PWM pins - start with 0% duty (stopped)
        lgpio.tx_pwm(self._handle, self._pwm1, PWM_FREQUENCY, 0)
        lgpio.tx_pwm(self._handle, self._pwm2, PWM_FREQUENCY, 0)

    def set_motor(self, channel, duty_pct):
        """Set motor speed and direction.

        Args:
            channel: 1 or 2
            duty_pct: -100.0 to 100.0 (positive=forward, negative=reverse)
        """
        duty_pct = max(-100.0, min(100.0, duty_pct))

        if channel == 1:
            dir_pin, pwm_pin = self._dir1, self._pwm1
        elif channel == 2:
            dir_pin, pwm_pin = self._dir2, self._pwm2
        else:
            raise ValueError(f"Invalid channel: {channel}")

        # Set direction
        forward = duty_pct >= 0
        lgpio.gpio_write(self._handle, dir_pin, 1 if forward else 0)

        # Set speed (absolute duty cycle)
        lgpio.tx_pwm(self._handle, pwm_pin, PWM_FREQUENCY, abs(duty_pct))

    def stop(self):
        """Stop both motors immediately."""
        lgpio.tx_pwm(self._handle, self._pwm1, PWM_FREQUENCY, 0)
        lgpio.tx_pwm(self._handle, self._pwm2, PWM_FREQUENCY, 0)

    def cleanup(self):
        """Release GPIO resources."""
        self.stop()
        lgpio.gpiochip_close(self._handle)

    def __del__(self):
        try:
            self.cleanup()
        except Exception:
            pass
