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
// the two encoder wires at the connector (per side).
#define PIN_ENC_LEFT_BASE   2
#define PIN_ENC_RIGHT_BASE  4

// MDD10A motor driver (PWM + DIR per channel). PWM on a hardware
// PWM-capable pin; DIR is plain digital out. Cable layout on rover #1
// puts the LEFT motor on the lower PWM/DIR pair (GP10/GP11, slice5)
// and RIGHT on the higher (GP12/GP13, slice6). Independent slices so
// each motor's PWM frequency is independent.
#define PIN_MOT_LEFT_PWM    10
#define PIN_MOT_LEFT_DIR    11
#define PIN_MOT_RIGHT_PWM   12
#define PIN_MOT_RIGHT_DIR   13

// Servo PWM output (50 Hz, 1000-2000 us nominal). slice4 chA.
#define PIN_SERVO_STEER     8   // S20F front steering

// Chalk dispenser servo (MG995, mission-specific). slice3 chB —
// slice3 chA is GP6 (E-stop) which is configured as a digital input,
// so slice 3 HW is otherwise unused and runs at the dispenser's own
// frequency independent of the steering servo.
#define PIN_SERVO_DISPENSER 7

// E-Stop input. NC momentary, fail-safe wiring:
//   GP6 ── NC button ── GND, with the MCU's internal pull-up enabled.
// At rest the closed button ties the line LOW; pressing it (or any
// open in the wire/connector) releases the line and the pull-up pulls
// it HIGH. We treat HIGH as the active/tripped state so a broken cable
// or popped connector also stops the rover.
#define PIN_ESTOP_IN        6

// Status RGB LED on RP2040-Zero (single WS2812).
#define PIN_STATUS_LED      16

// ADC-capable GPIOs: GP26=ADC0, GP27=ADC1, GP28=ADC2.
#define PIN_BATTERY_ADC     27  // ADC1 — battery via 1:11 divider

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
#define SERVO_RANGE_US          500       // +- from center; full lock at 1000-2000us
#define SERVO_MIN_US            1000
#define SERVO_MAX_US            2000
// Dispenser servo uses full 500-2500 us range (MG995 0-180° travel).
// The steering S20F is mechanically limited at the linkage so its
// 1000-2000 range is preserved separately.
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
// Instead of coasting (raw duty 0), we ACTIVELY BRAKE: reverse-drive the
// wheels proportional to their measured speed until nearly stopped, so
// the rover halts on the spot instead of drifting past the target on
// inertia. (The drive-only sign clamp above the deadband still prevents
// reverse-drive during a normal ramp-down; braking is only on a commanded
// stop.) 0.05 m/s is well below creep_speed (0.18 m/s), so it never trips
// during a legitimate slow approach (incl. the inner wheel in a turn).
#define PID_TARGET_DEADBAND_MPS 0.05f
#define PID_OUT_MIN             -1.0f
#define PID_OUT_MAX             1.0f
// Active-braking-at-stop. When |target| < deadband but the wheel is still
// rolling, reverse-drive duty = brake_kp * |v|, capped at brake_max_duty,
// in the direction opposing motion. Eases to zero as v→0 so it doesn't
// reverse past standstill; below brake_stop_mps hold a hard duty 0 (no
// judder from encoder noise at rest). These are runtime-tunable from the
// host via the 'K' command (mirrors PID's 'P'); the defaults below seed
// g_brake_* at boot before the host pushes rover_params values.
#define BRAKE_DEFAULT_KP        3.0f      // reverse duty per (m/s) residual
#define BRAKE_DEFAULT_MAX_DUTY  0.6f      // cap; conservative to avoid slip/judder
#define BRAKE_DEFAULT_STOP_MPS  0.04f     // below this = stopped, hold 0
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
