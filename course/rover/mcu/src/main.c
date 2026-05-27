#include "config.h"
#include "encoder.h"
#include "battery.h"
#include "motor.h"
#include "servo.h"
#include "pid.h"
#include "estop.h"
#include "status_led.h"
#include "protocol.h"

#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "hardware/watchdog.h"

#include <math.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>

// ----- Shared state (referenced from protocol.c via extern) -----
pid_t g_pid_left, g_pid_right;
volatile bool     g_pid_enabled  = false;     // raw duty by default; host turns PID on
volatile float    g_target_vel_l = 0.0f;
volatile float    g_target_vel_r = 0.0f;
volatile uint32_t g_last_heartbeat_ms = 0;
volatile bool     g_estop_clear_request = false;
volatile bool     g_use_raw_motor = true;
volatile float    g_raw_duty_l   = 0.0f;
volatile float    g_raw_duty_r   = 0.0f;
// Active-brake gains, host-tunable via the 'K' command (see protocol.c).
// Seeded from config defaults; rover_params pushes the operating values.
volatile float    g_brake_kp       = BRAKE_DEFAULT_KP;
volatile float    g_brake_max_duty = BRAKE_DEFAULT_MAX_DUTY;
volatile float    g_brake_stop_mps = BRAKE_DEFAULT_STOP_MPS;
// Pi-reported navigation fault flag. Set/cleared via the 'N' protocol
// command. Surfaces in telemetry as FLAG_GPS_LOST and drives the
// LED_GPS_LOST (orange blink) status indication.
volatile bool     g_nav_gps_lost = false;

// ----- Inter-core latched state -----
static volatile float    g_last_vbat  = 0.0f;
static volatile uint32_t g_last_flags = 0;

static led_state_t pick_led_state(uint32_t flags, bool driving) {
    // Priority: estop > battery_undervolt > gps_lost (operator must
    // see RTK-fix failures during a mission) > heartbeat_timeout >
    // battery_warn > driving > idle.
    if (flags & FLAG_ESTOP_ACTIVE)         return LED_ESTOP;
    if (flags & FLAG_BATTERY_UNDERVOLT)    return LED_FAULT;
    if (flags & FLAG_GPS_LOST)             return LED_GPS_LOST;
    if (flags & FLAG_PI_HEARTBEAT_TIMEOUT) return LED_WARN;
    if (flags & FLAG_BATTERY_WARN)         return LED_WARN;
    return driving ? LED_ACTIVE : LED_IDLE;
}

// ----- Core 1: 50 Hz control loop -----
static void core1_main(void) {
    pid_init(&g_pid_left,  PID_DEFAULT_KP, PID_DEFAULT_KI, PID_DEFAULT_KD);
    pid_init(&g_pid_right, PID_DEFAULT_KP, PID_DEFAULT_KI, PID_DEFAULT_KD);

    const float dt = 1.0f / (float)CONTROL_TICK_HZ;
    absolute_time_t next = make_timeout_time_ms(CONTROL_TICK_MS);

    while (true) {
        sleep_until(next);
        next = delayed_by_ms(next, CONTROL_TICK_MS);

        encoder_tick();
        servo_tick();

        uint32_t now_ms = to_ms_since_boot(get_absolute_time());

        bool hb_timeout = (now_ms - g_last_heartbeat_ms) > PI_HEARTBEAT_TIMEOUT_MS;
        // Drop readings below 1 V — divider sees that only when unpowered.
        bool batt_known = g_last_vbat > 1.0f;
        bool undervolt  = batt_known && g_last_vbat < BATTERY_UNDERVOLT_V;
        bool batt_warn  = batt_known && !undervolt && g_last_vbat < BATTERY_WARN_V;

        // Clear before re-reading the latch, and gate only on the hardware
        // line. estop_is_active() ORs in g_tripped, so checking "!estop"
        // here would deadlock the latch — once tripped, it could never
        // clear regardless of the GPIO state.
        //
        // Debounced clear: the NC button bounces ~10 ms on release. A
        // single-sample LOW read could land on a transient bounce while
        // the operator is still pressing, fire estop_clear(), and let
        // one full tick (20 ms) of motor motion through before the next
        // tick re-trips. Require N=5 consecutive LOW samples before
        // honouring the clear request.
        static int g_estop_low_samples = 0;
        if (gpio_get(PIN_ESTOP_IN) == 0) {
            if (g_estop_low_samples < 100) g_estop_low_samples++;
        } else {
            g_estop_low_samples = 0;
        }
        if (g_estop_clear_request && g_estop_low_samples >= 5) {
            estop_clear();
            g_estop_clear_request = false;
            g_estop_low_samples = 0;
        }
        bool estop = estop_is_active();

        if (estop || hb_timeout) {
            motor_stop_all();
            servo_set_target_us(SERVO_STEER, SERVO_CENTER_US);
            pid_reset(&g_pid_left);
            pid_reset(&g_pid_right);
        } else if (g_pid_enabled && !g_use_raw_motor) {
            float vl = encoder_get_velocity(ENC_LEFT);
            float vr = encoder_get_velocity(ENC_RIGHT);
            // "Drive-only" PID: closed-loop output is allowed to push
            // the wheel in the commanded direction (positive duty for
            // forward target, negative for reverse) but never the
            // opposite. The combination of a target ramp-down (fast)
            // against natural wheel inertia (slow) makes target − v
            // sit on the wrong side of zero for several ticks; without
            // this clamp PID would reverse-PWM the wheel to drag it
            // down, which judders the H-bridge ("드드득") and cogs the
            // motor at low duty.
            //
            // Below the setpoint deadband we want a full friction
            // coast plus integrator reset (otherwise wind-up during
            // the deadband window slams the motor on the next non-zero
            // command). Above the deadband, PID runs but its output is
            // sign-clamped against the target sign — wheels decelerate
            // on friction, never on reverse-drive.
            if (fabsf(g_target_vel_l) < PID_TARGET_DEADBAND_MPS) {
                // Commanded stop: brake hard instead of coasting. Reverse-
                // drive opposing motion, proportional to speed and capped,
                // until nearly stopped; then hold a hard 0.
                pid_reset(&g_pid_left);
                if (fabsf(vl) > g_brake_stop_mps) {
                    float bd = g_brake_kp * fabsf(vl);
                    if (bd > g_brake_max_duty) bd = g_brake_max_duty;
                    motor_set(0, vl > 0.0f ? -bd : bd);
                } else {
                    motor_set(0, 0.0f);
                }
            } else {
                float ul = pid_step(&g_pid_left, g_target_vel_l, vl, dt);
                if ((g_target_vel_l > 0.0f && ul < 0.0f)
                    || (g_target_vel_l < 0.0f && ul > 0.0f)) {
                    ul = 0.0f;
                }
                motor_set(0, ul);
            }
            if (fabsf(g_target_vel_r) < PID_TARGET_DEADBAND_MPS) {
                // Commanded stop: brake hard (see left wheel above).
                pid_reset(&g_pid_right);
                if (fabsf(vr) > g_brake_stop_mps) {
                    float bd = g_brake_kp * fabsf(vr);
                    if (bd > g_brake_max_duty) bd = g_brake_max_duty;
                    motor_set(1, vr > 0.0f ? -bd : bd);
                } else {
                    motor_set(1, 0.0f);
                }
            } else {
                float ur = pid_step(&g_pid_right, g_target_vel_r, vr, dt);
                if ((g_target_vel_r > 0.0f && ur < 0.0f)
                    || (g_target_vel_r < 0.0f && ur > 0.0f)) {
                    ur = 0.0f;
                }
                motor_set(1, ur);
            }
        } else {
            motor_set(0, g_raw_duty_l);
            motor_set(1, g_raw_duty_r);
        }

        uint32_t flags = 0;
        if (estop)            flags |= FLAG_ESTOP_ACTIVE;
        if (hb_timeout)       flags |= FLAG_PI_HEARTBEAT_TIMEOUT;
        if (undervolt)        flags |= FLAG_BATTERY_UNDERVOLT;
        if (batt_warn)        flags |= FLAG_BATTERY_WARN;
        if (g_nav_gps_lost)   flags |= FLAG_GPS_LOST;
        if (g_pid_enabled && !g_use_raw_motor) flags |= FLAG_PID_ACTIVE;
        if (watchdog_caused_reboot())          flags |= FLAG_HW_WDT_REBOOT;
        g_last_flags = flags;
    }
}

int main(void) {
    stdio_init_all();
    // Give USB CDC a moment to enumerate before the first telemetry write.
    sleep_ms(1500);

    encoder_init();
    motor_init();
    servo_init();
    servo_center_all();
    battery_init();
    estop_init();
    status_led_init();

    g_last_heartbeat_ms = to_ms_since_boot(get_absolute_time());

    // HW watchdog backstop. Both cores must keep the chip alive — core0
    // calls watchdog_update() in the telemetry loop below.
    watchdog_enable(HW_WATCHDOG_MS, true);

    multicore_launch_core1(core1_main);

    absolute_time_t next_tlm = make_timeout_time_ms(TELEMETRY_TICK_MS);
    uint32_t led_div = 0;

    while (true) {
        protocol_poll_input();

        if (absolute_time_diff_us(get_absolute_time(), next_tlm) <= 0) {
            next_tlm = delayed_by_ms(next_tlm, TELEMETRY_TICK_MS);

            g_last_vbat = battery_read_voltage();

            uint32_t now_ms = to_ms_since_boot(get_absolute_time());
            int32_t enc_l = encoder_get_count(ENC_LEFT);
            int32_t enc_r = encoder_get_count(ENC_RIGHT);
            float   vl    = encoder_get_velocity(ENC_LEFT);
            float   vr    = encoder_get_velocity(ENC_RIGHT);

            protocol_emit_telemetry(now_ms, enc_l, enc_r, vl, vr,
                                    g_last_vbat, g_last_flags);

            bool driving = (g_use_raw_motor &&
                            ((g_raw_duty_l > 0.01f) || (g_raw_duty_r > 0.01f) ||
                             (g_raw_duty_l < -0.01f) || (g_raw_duty_r < -0.01f))) ||
                           (g_pid_enabled &&
                            ((g_target_vel_l != 0.0f) || (g_target_vel_r != 0.0f)));
            status_led_set(pick_led_state(g_last_flags, driving));

            if (++led_div >= 1) {
                status_led_tick();
                led_div = 0;
            }
        }

        watchdog_update();
        // Brief sleep to yield without missing CDC bytes — getchar_timeout_us(0)
        // is non-blocking, so this just prevents 100% CPU spin.
        sleep_us(200);
    }
}
