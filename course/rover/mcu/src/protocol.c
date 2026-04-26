#include "protocol.h"
#include "config.h"
#include "motor.h"
#include "servo.h"
#include "estop.h"
#include "pid.h"

#include "pico/stdlib.h"
#include "pico/stdio.h"

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>

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

#define LINE_MAX 96
static char     g_line[LINE_MAX];
static unsigned g_len = 0;

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
            g_line[g_len] = '\0';
            handle_line(g_line);
            g_len = 0;
            consumed = true;
            continue;
        }
        if (g_len < LINE_MAX - 1) {
            g_line[g_len++] = (char)c;
        } else {
            // Overflow — discard line.
            g_len = 0;
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
