#include "config.h"
#include "encoder.h"
#include "battery.h"
#include "motor.h"
#include "servo.h"
#include "pid.h"
#include "estop.h"
#include "status_led.h"
#include "nav_lights.h"
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
// One-shot brake-pulse parameters, host-tunable via 'K' (see protocol.c).
// Seeded from config defaults; rover_params pushes the operating values.
volatile float    g_brake_pulse_duty     = BRAKE_DEFAULT_PULSE_DUTY;
volatile float    g_brake_pulse_ms       = BRAKE_DEFAULT_PULSE_MS;
volatile float    g_brake_fire_above_mps = BRAKE_DEFAULT_FIRE_ABOVE_MPS;
// Brake-arm latch: a brake pulse only fires on a deadband entry that
// happens WHILE the host has armed brakes via 'A'. Manual stick release
// goes through the same deadband path but the host never arms, so it
// just coasts (which matches the operator's stick-feel expectation).
// The arm auto-expires after BRAKE_ARM_WINDOW_MS (config.h) to prevent
// a stale arm from biting an unrelated stop several seconds later.
volatile uint32_t g_brake_arm_until_ms = 0;
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

        // The software E-Stop latch ('E'/'C' from the host) and the
        // physical button are independent sources. 'C' clears the
        // software latch (g_tripped) unconditionally; it can NOT clear
        // the hardware line, which estop_is_active() reads live — so a
        // physically-latched button stays tripped until it is twisted
        // open, while a software stop is cleared only by software.
        //
        // The clear is deliberately NOT gated on the line reading LOW.
        // That old gate coupled the two sources and, combined with the
        // host echoing a hardware press back as 'E', deadlocked the
        // latch: g_tripped held the reported flag high, so the release
        // edge that would have sent 'C' never fired. The host no longer
        // relays the physical button to the MCU at all.
        if (g_estop_clear_request) {
            estop_clear();
            g_estop_clear_request = false;
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
            // Below the setpoint deadband we coast (MDD10A PWM=0 on this
            // wiring is Hi-Z, not short-brake) and reset the integrator.
            // If the host armed brakes via 'A' shortly before the stop
            // command (settling at a waypoint in autonomous mode), the
            // FIRST tick that enters the deadband fires a single open-
            // loop reverse pulse to kill the residual coast — open loop
            // because closed-loop reverse-PWM at low |v| was the source
            // of the original "드드득" chatter.
            static bool was_in_db_l = false, was_in_db_r = false;
            static bool pulse_active_l = false, pulse_active_r = false;
            static uint32_t pulse_end_ms_l = 0, pulse_end_ms_r = 0;
            static float pulse_sign_l = 0.0f, pulse_sign_r = 0.0f;
            bool in_db_l = fabsf(g_target_vel_l) < PID_TARGET_DEADBAND_MPS;
            bool in_db_r = fabsf(g_target_vel_r) < PID_TARGET_DEADBAND_MPS;
            // Both wheels share one arm; consume it the first time either
            // wheel sees the deadband edge so a later unrelated stop can't
            // re-fire on the same arm.
            bool brake_armed = (g_brake_arm_until_ms != 0)
                            && (now_ms < g_brake_arm_until_ms);
            if (in_db_l) {
                if (!was_in_db_l) {
                    pid_reset(&g_pid_left);
                    if (brake_armed && fabsf(vl) > g_brake_fire_above_mps) {
                        pulse_active_l = true;
                        pulse_end_ms_l = now_ms + (uint32_t)g_brake_pulse_ms;
                        pulse_sign_l = (vl > 0.0f) ? -1.0f : 1.0f;
                    } else {
                        pulse_active_l = false;
                    }
                }
                if (pulse_active_l && (int32_t)(pulse_end_ms_l - now_ms) > 0) {
                    motor_set(0, pulse_sign_l * g_brake_pulse_duty);
                } else {
                    pulse_active_l = false;
                    motor_set(0, 0.0f);
                }
            } else {
                pulse_active_l = false;
                float ul = pid_step(&g_pid_left, g_target_vel_l, vl, dt);
                if ((g_target_vel_l > 0.0f && ul < 0.0f)
                    || (g_target_vel_l < 0.0f && ul > 0.0f)) {
                    ul = 0.0f;
                }
                motor_set(0, ul);
            }
            if (in_db_r) {
                if (!was_in_db_r) {
                    pid_reset(&g_pid_right);
                    if (brake_armed && fabsf(vr) > g_brake_fire_above_mps) {
                        pulse_active_r = true;
                        pulse_end_ms_r = now_ms + (uint32_t)g_brake_pulse_ms;
                        pulse_sign_r = (vr > 0.0f) ? -1.0f : 1.0f;
                    } else {
                        pulse_active_r = false;
                    }
                }
                if (pulse_active_r && (int32_t)(pulse_end_ms_r - now_ms) > 0) {
                    motor_set(1, pulse_sign_r * g_brake_pulse_duty);
                } else {
                    pulse_active_r = false;
                    motor_set(1, 0.0f);
                }
            } else {
                pulse_active_r = false;
                float ur = pid_step(&g_pid_right, g_target_vel_r, vr, dt);
                if ((g_target_vel_r > 0.0f && ur < 0.0f)
                    || (g_target_vel_r < 0.0f && ur > 0.0f)) {
                    ur = 0.0f;
                }
                motor_set(1, ur);
            }
            // Consume the arm on the first deadband edge of either wheel.
            if (brake_armed && ((in_db_l && !was_in_db_l)
                             || (in_db_r && !was_in_db_r))) {
                g_brake_arm_until_ms = 0;
            }
            was_in_db_l = in_db_l;
            was_in_db_r = in_db_r;
        } else {
            motor_set(0, g_raw_duty_l);
            motor_set(1, g_raw_duty_r);
        }

        uint32_t flags = 0;
        if (estop)            flags |= FLAG_ESTOP_ACTIVE;
        // Raw physical button line, reported separately from the combined
        // active flag so the host can sync press/release of the latching
        // button independently of the software latch (g_tripped).
        if (gpio_get(PIN_ESTOP_IN) == 1) flags |= FLAG_ESTOP_LINE;
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
    nav_lights_init();
    nav_lights_set(true);   // steady position lights while powered

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
