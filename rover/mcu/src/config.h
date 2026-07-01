#ifndef ROVER_MCU_CONFIG_H
#define ROVER_MCU_CONFIG_H

// ----- Pin assignments (RP2040-Zero) -----
// Wheel encoders. PIO quadrature decoder needs the two phase pins on
// consecutive GPIOs and reads the lower pin as bit 0, the higher pin as
// bit 1. We pass the lower (= base) pin to the program; whichever
// signal you label "A" or "B" only flips the count's sign convention.
//
// Wiring: LEFT  B → GP2, LEFT  A → GP3
//         RIGHT B → GP4, RIGHT A → GP5
// If wheel-forward ends up reading negative on first power-up, swap
// the two encoder wires at the connector (per side). The MD36L encoder
// connector is XH2.54-4P.
#define PIN_ENC_LEFT_BASE   2
#define PIN_ENC_RIGHT_BASE  4

// MDD10A motor driver (PWM + DIR per channel). PWM on a hardware
// PWM-capable pin; DIR is plain digital out. Pin choice follows the
// rover-mcu PCB routing:
//   LEFT  PWM=GP15 (slice7 chB), DIR=GP27
//   RIGHT PWM=GP28 (slice6 chA), DIR=GP29
// The two PWM pins sit on independent slices (7 vs 6) so each motor's
// PWM frequency is independent. GP27/GP29 are ADC-capable pins driven
// here as plain digital DIR outputs (only GP26/ADC0 is used as an ADC,
// for the battery sense below).
#define PIN_MOT_LEFT_PWM    15
#define PIN_MOT_LEFT_DIR    27
#define PIN_MOT_RIGHT_PWM   28
#define PIN_MOT_RIGHT_DIR   29

// Servo PWM output (50 Hz, 1000-2000 us nominal). slice4 chA.
#define PIN_SERVO_STEER     8   // S20F front steering

// Chalk dispenser servo (MG995, mission-specific). slice3 chA — an
// independent slice from the steering servo (slice4), so each runs at
// its own frequency. GP7 (E-stop) is slice3 chB but used as a plain
// digital input, so that channel's PWM hardware stays idle.
#define PIN_SERVO_DISPENSER 6

// E-Stop input. NC momentary, fail-safe wiring:
//   GP7 ── NC button ── GND, with the MCU's internal pull-up enabled.
// At rest the closed button ties the line LOW; pressing it (or any
// open in the wire/connector) releases the line and the pull-up pulls
// it HIGH. We treat HIGH as the active/tripped state so a broken cable
// or popped connector also stops the rover.
#define PIN_ESTOP_IN        7

// Status RGB LED on RP2040-Zero (single onboard WS2812 on GP16).
#define PIN_STATUS_LED      16

// External status lighting — mirrors the onboard status LED 1:1. Two
// NeoPixel Sticks (8× WS2812 each) wired as one 16-LED chain. GP11 drives
// the chain through a 2N7002 common-source level shifter that inverts the
// line and swings it to the +5V LED rail; the firmware compensates with
// gpio_set_outover(PIN_EXT_LEDS, INVERT) so the first LED sees the PIO's
// intended (non-inverted) data, idle-low reset gap included.
#define PIN_EXT_LEDS        11
#define EXT_LED_COUNT       16  // 2 sticks × 8 WS2812

// Navigation lights (aircraft-style red/green). 3-pin connector J3
// (+5V, GND, control); GP9 drives the on/off control line directly —
// no driver transistor, active-high (HIGH = on). Held on while the MCU
// runs (steady position lights). On/off only — never PWM'd.
#define PIN_NAV_LIGHTS      9

// ADC-capable GPIOs: GP26=ADC0, GP27=ADC1, GP28=ADC2, GP29=ADC3.
// GP27/GP28/GP29 are used as motor DIR/PWM, so the battery sense uses
// GP26/ADC0.
#define PIN_BATTERY_ADC     26  // ADC0 — battery via 1:11 divider

// ----- Battery voltage divider -----
// Vbat -> R1 -> ADC -> R2 -> GND. 8S LiFePO4 max 29.2 V.
// 100k:10k => Vadc = Vbat * 10/110 ~= 2.65 V at full charge.
#define BATTERY_R1_OHMS         100000.0f
#define BATTERY_R2_OHMS         10000.0f
#define BATTERY_DIVIDER         ((BATTERY_R1_OHMS + BATTERY_R2_OHMS) / BATTERY_R2_OHMS)
#define BATTERY_CAL_GAIN        1.0f      // tweak after multimeter measurement
#define BATTERY_UNDERVOLT_V     20.0f     // 8S LiFePO4 cutoff
#define BATTERY_WARN_V          22.0f
#define BATTERY_OVERSAMPLE_N    16

// ----- ADC -----
#define ADC_VREF_V              3.3f
#define ADC_RESOLUTION          4096.0f   // 12-bit

// ----- Servo PWM -----
#define SERVO_FREQ_HZ           50
#define SERVO_PERIOD_US         20000
#define SERVO_CENTER_US         1500
#define SERVO_RANGE_US          500       // +- from center; nominal full-lock span
// Steering servo HARD bounds (servo-protection stops). Bench-measured
// 2026-05-29: the right linkage bottoms out at ~1000 µs (its natural
// mechanical max, kept as the floor) and the left wheel fouls the
// bodywork at ~1850 µs, BEFORE the 2000 µs max. The asymmetric
// OPERATIONAL limit on the left is enforced host-side (mcu_bridge
// steer_max_us=1850, live-tunable), separate from these firmware bounds.
#define SERVO_MIN_US            1000
#define SERVO_MAX_US            2000
// Dispenser servo uses full 500-2500 us range (MG995 0-180° travel).
#define SERVO_DISPENSER_MIN_US  500
#define SERVO_DISPENSER_MAX_US  2500
// S20F datasheet: 0.18 s/60deg => ~3 ms/deg.
// 50 Hz tick = 20 ms => mechanical 6.7 deg/tick.
// Limit command rate to ~80% of mechanical capability.
#define SERVO_SLEW_US_PER_TICK  100
// S20F mechanical dead-zone is 4 µs and the UI quantises steering to
// 5 µs per percent. Sit one full step above that (10 µs) so a single
// joystick unit is always rejected and only deliberate two-unit moves
// reach the slew loop — kills the residual stutter from updates that
// landed exactly on the previous 5 µs threshold.
#define SERVO_DEADBAND_US       10

// ----- Motor PWM -----
#define MOTOR_PWM_FREQ_HZ       20000     // 20 kHz - inaudible, MDD10A friendly
#define MOTOR_PWM_WRAP          1000      // duty resolution = 0.1%

// ----- Control loop -----
#define CONTROL_TICK_HZ         50
#define CONTROL_TICK_MS         (1000 / CONTROL_TICK_HZ)
#define TELEMETRY_TICK_MS       20        // 50 Hz telemetry

// ----- Watchdogs -----
// Hardware WDT — backstop in case the firmware itself hangs.
#define HW_WATCHDOG_MS          1000
// Heartbeat WDT — Pi must send 'H' at least this often or motors stop.
#define PI_HEARTBEAT_TIMEOUT_MS 500

// ----- PID (per wheel speed loop) -----
// Speed in m/s. Output in MDD10A duty fraction [-1.0, 1.0].
#define PID_DEFAULT_KP          0.6f
#define PID_DEFAULT_KI          1.5f
#define PID_DEFAULT_KD          0.0f
// Velocity setpoint deadband. A target |v| below this means "stop here".
// On the rising edge into the deadband we fire a single open-loop reverse
// pulse (see BRAKE_DEFAULT_* below) to kill the residual that would
// otherwise coast (MDD10A with PWM=0 is Hi-Z on this wiring, NOT
// short-brake); afterwards we hold a hard duty 0. 0.05 m/s is well below
// creep_speed (0.18 m/s) so it never trips during a legitimate slow
// approach (incl. the inner wheel in a turn).
#define PID_TARGET_DEADBAND_MPS 0.05f
#define PID_OUT_MIN             -1.0f
#define PID_OUT_MAX             1.0f
// Brake-at-stop pulse. On the rising edge into the deadband, IF
// |v| > brake_fire_above_mps, drive the wheel in REVERSE at brake_pulse_duty
// for brake_pulse_ms milliseconds, with the sign frozen at the pulse start
// — then go to duty 0 for the rest of the deadband window. Single-shot
// monostable, not a closed loop, so the encoder-noise chattering that the
// previous (proportional) brake produced is structurally impossible:
// even if the wheel briefly crosses zero during the pulse we keep driving
// the original reverse direction instead of chasing the sign flip.
// Runtime-tunable via the 'K' command ('B' is taken by the BOOTSEL reboot).
#define BRAKE_DEFAULT_PULSE_DUTY      0.35f  // reverse duty during the pulse
#define BRAKE_DEFAULT_PULSE_MS        100.0f // pulse duration (ms)
#define BRAKE_DEFAULT_FIRE_ABOVE_MPS  0.04f  // skip the pulse if |v| ≤ this on entry
#define BRAKE_PULSE_DUTY_MIN          0.0f
#define BRAKE_PULSE_DUTY_MAX          1.0f
#define BRAKE_PULSE_MS_MIN            0.0f
#define BRAKE_PULSE_MS_MAX            1000.0f
#define BRAKE_FIRE_ABOVE_MPS_MIN      0.0f
#define BRAKE_FIRE_ABOVE_MPS_MAX      1.0f
// 'A'-arm validity window. The host must arm within this many ms before
// the deadband-entry tick for the pulse to fire. Long enough to absorb
// serial latency + a couple of control ticks, short enough that a stale
// arm can't bite an unrelated later stop.
#define BRAKE_ARM_WINDOW_MS           1000u
#define PID_INTEGRAL_LIMIT      0.5f

// ----- Wheel kinematics (convert encoder counts -> m/s) -----
// Override at compile time (-D...) or here once encoder + wheel measured.
// Encoder is on the motor shaft, BEFORE the gearbox, so a wheel revolution
// produces ENCODER_PPR * 4 * GEAR_RATIO quadrature counts.
#ifndef WHEEL_RADIUS_M
#define WHEEL_RADIUS_M          0.0625f   // 125 mm dia (Wheeltec R550)
#endif
#ifndef ENCODER_PPR
#define ENCODER_PPR             500       // motor-shaft, single-channel pulses per rev
#endif
#ifndef GEAR_RATIO
#define GEAR_RATIO              27.0f     // MD36L P27 motor:wheel reduction
#endif
// Quadrature decode multiplies by 4. Distance per count =
//   2*pi*r / (PPR * 4 * GEAR_RATIO).
#define METERS_PER_COUNT        ((2.0f * 3.14159265f * WHEEL_RADIUS_M) \
                                 / (ENCODER_PPR * 4.0f * GEAR_RATIO))

#endif // ROVER_MCU_CONFIG_H
