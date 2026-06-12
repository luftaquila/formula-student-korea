#include "protocol.h"
#include "config.h"
#include "motor.h"
#include "servo.h"
#include "estop.h"
#include "pid.h"
#include "nav_lights.h"
#include "status_led.h"

#include "pico/stdlib.h"
#include "pico/stdio.h"
#include "pico/bootrom.h"

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>

// Live PID gains shared with main.c via a small accessor.
extern pid_t g_pid_left;
extern pid_t g_pid_right;
extern volatile bool     g_pid_enabled;
extern volatile float    g_target_vel_l;
extern volatile float    g_target_vel_r;
extern volatile uint32_t g_last_heartbeat_ms;
extern volatile bool     g_estop_clear_request;
extern volatile bool     g_use_raw_motor;
extern volatile float    g_raw_duty_l;
extern volatile float    g_raw_duty_r;
extern volatile bool     g_nav_gps_lost;
extern volatile float    g_brake_pulse_duty;
extern volatile float    g_brake_pulse_ms;
extern volatile float    g_brake_fire_above_mps;
extern volatile uint32_t g_brake_arm_until_ms;

#define LINE_MAX 96
static char     g_line[LINE_MAX];
static unsigned g_len = 0;
static bool     g_discard_line = false;

static float clampf(float value, float lo, float hi) {
    if (!isfinite(value)) return lo;
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

static void handle_line(char *line) {
    if (line[0] == '\0') return;

    // Single-letter command + space-separated args.
    char cmd = line[0];
    char *args = (line[1] == ' ') ? line + 2 : line + 1;

    switch (cmd) {
        case 'H': {
            g_last_heartbeat_ms = to_ms_since_boot(get_absolute_time());
            break;
        }
        case 'E': {
            estop_trip();
            break;
        }
        case 'C': {  // clear estop (host explicitly acknowledges)
            g_estop_clear_request = true;
            break;
        }
        case 'M': {
            // M <left_duty> <right_duty> <steering_us>
            float lf = 0.0f, rf = 0.0f;
            int   us = SERVO_CENTER_US;
            if (sscanf(args, "%f %f %d", &lf, &rf, &us) >= 2) {
                g_use_raw_motor = true;
                g_raw_duty_l = lf;
                g_raw_duty_r = rf;
                servo_set_target_us(SERVO_STEER, (uint16_t)us);
                g_last_heartbeat_ms = to_ms_since_boot(get_absolute_time());
            }
            break;
        }
        case 'V': {
            // V <left_mps> <right_mps> <steering_us>
            float lv = 0.0f, rv = 0.0f;
            int   us = SERVO_CENTER_US;
            if (sscanf(args, "%f %f %d", &lv, &rv, &us) >= 2) {
                g_use_raw_motor = false;
                g_target_vel_l = lv;
                g_target_vel_r = rv;
                servo_set_target_us(SERVO_STEER, (uint16_t)us);
                g_last_heartbeat_ms = to_ms_since_boot(get_absolute_time());
            }
            break;
        }
        case 'P': {
            float kp = 0.0f, ki = 0.0f, kd = 0.0f;
            if (sscanf(args, "%f %f %f", &kp, &ki, &kd) == 3) {
                pid_set_gains(&g_pid_left,  kp, ki, kd);
                pid_set_gains(&g_pid_right, kp, ki, kd);
            }
            break;
        }
        case 'L': {  // toggle PID closed loop on/off
            int on = 0;
            if (sscanf(args, "%d", &on) == 1) {
                g_pid_enabled = (on != 0);
            }
            break;
        }
        case 'K': {
            // K <pulse_duty> <pulse_ms> <fire_above_mps>
            // One-shot brake-pulse parameters (mirrors 'P' for PID). The
            // pulse itself only fires when 'A' has armed it within the
            // last BRAKE_ARM_WINDOW_MS; manual stops are never armed and
            // therefore never brake. ('B' is taken by BOOTSEL below.)
            float duty = 0.0f, ms = 0.0f, fa = 0.0f;
            if (sscanf(args, "%f %f %f", &duty, &ms, &fa) == 3) {
                g_brake_pulse_duty = clampf(
                    duty, BRAKE_PULSE_DUTY_MIN, BRAKE_PULSE_DUTY_MAX);
                g_brake_pulse_ms = clampf(
                    ms, BRAKE_PULSE_MS_MIN, BRAKE_PULSE_MS_MAX);
                g_brake_fire_above_mps = clampf(
                    fa, BRAKE_FIRE_ABOVE_MPS_MIN, BRAKE_FIRE_ABOVE_MPS_MAX);
            }
            break;
        }
        case 'A': {
            // Arm a single brake pulse on the next deadband edge. The
            // host (mcu_bridge_node) sends this just before the
            // settle-at-waypoint 'V 0 0 ...' so that only deliberate
            // autonomous stops brake; the arm auto-expires after
            // BRAKE_ARM_WINDOW_MS to avoid biting an unrelated later stop.
            g_brake_arm_until_ms = to_ms_since_boot(get_absolute_time())
                                 + BRAKE_ARM_WINDOW_MS;
            break;
        }
        case 'D': {
            // D <pulse_us>  Set dispenser servo target. Independent of
            // M/V (steering+drive) so the dispenser can be commanded
            // without touching motors or steering.
            int us = SERVO_CENTER_US;
            if (sscanf(args, "%d", &us) == 1) {
                servo_set_target_us(SERVO_DISPENSER, (uint16_t)us);
            }
            break;
        }
        case 'G': {
            // G <mode>  Nav-light pattern: 0=off 1=steady 2=double-strobe
            // 3=single-strobe 4=50% blink. ('N' is the nav-fault flag below,
            // so nav *lights* use 'G'.) Out-of-range ignored by set_mode().
            int mode = -1;
            if (sscanf(args, "%d", &mode) == 1 && mode >= 0) {
                nav_lights_set_mode((nav_mode_t)mode);
            }
            break;
        }
        case 'I': {
            // I <0-255>  Status-LED (WS2812) global brightness scale.
            int b = -1;
            if (sscanf(args, "%d", &b) == 1 && b >= 0 && b <= 255) {
                status_led_set_brightness((uint8_t)b);
            }
            break;
        }
        case 'N': {
            // Pi-reported navigation fault. 'N 1' = GPS fix lost /
            // below required quality; 'N 0' = cleared. Sets FLAG_GPS_LOST
            // and drives LED_GPS_LOST (orange blink). The MCU does not
            // independently halt motors on this flag — the Pi already
            // commands v=0 when the fix is bad — but the flag is reported
            // back in telemetry and the LED makes the cause visible at a
            // glance, distinct from estop (red blink) and battery warn
            // (solid yellow).
            int on = 0;
            if (sscanf(args, "%d", &on) == 1) {
                g_nav_gps_lost = (on != 0);
            }
            break;
        }
        case 'B': {
            // Reboot into USB BOOTSEL mode for firmware update.
            // Stops motors and announces the reset over USB CDC before
            // the bootloader takes over the USB interface.
            motor_stop_all();
            protocol_emit_event("BOOTSEL");
            sleep_ms(50);
            reset_usb_boot(0, 0);
            // Unreachable — chip resets into the mass-storage bootloader.
            break;
        }
        default:
            // Unknown command — ignore silently to avoid feedback loops.
            break;
    }
}

bool protocol_poll_input(void) {
    bool consumed = false;
    int c;
    while ((c = getchar_timeout_us(0)) != PICO_ERROR_TIMEOUT) {
        if (c == '\r') continue;
        if (c == '\n') {
            if (!g_discard_line) {
                g_line[g_len] = '\0';
                handle_line(g_line);
            }
            g_len = 0;
            g_discard_line = false;
            consumed = true;
            continue;
        }
        if (g_discard_line) {
            continue;
        }
        if (g_len < LINE_MAX - 1) {
            g_line[g_len++] = (char)c;
        } else {
            // Overflow — discard line.
            g_len = 0;
            g_discard_line = true;
        }
    }
    return consumed;
}

void protocol_emit_telemetry(uint32_t ms,
                             int32_t enc_l, int32_t enc_r,
                             float vel_l, float vel_r,
                             float vbat,
                             uint32_t flags) {
    printf("T %lu %ld %ld %.3f %.3f %.2f 0x%lx\n",
           (unsigned long)ms,
           (long)enc_l, (long)enc_r,
           (double)vel_l, (double)vel_r,
           (double)vbat,
           (unsigned long)flags);
}

void protocol_emit_event(const char *msg) {
    printf("! %s\n", msg);
}
