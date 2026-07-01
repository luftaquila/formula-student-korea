#include "pid.h"
#include "config.h"

#include <stdbool.h>

void pid_init(pid_t *p, float kp, float ki, float kd) {
    p->kp = kp; p->ki = ki; p->kd = kd;
    p->integral = 0.0f;
    p->prev_measured = 0.0f;
    p->out_min = PID_OUT_MIN;
    p->out_max = PID_OUT_MAX;
    p->i_limit = PID_INTEGRAL_LIMIT;
}

void pid_set_gains(pid_t *p, float kp, float ki, float kd) {
    p->kp = kp; p->ki = ki; p->kd = kd;
}

void pid_reset(pid_t *p) {
    p->integral = 0.0f;
    p->prev_measured = 0.0f;
}

float pid_step(pid_t *p, float setpoint, float measured, float dt) {
    float err = setpoint - measured;

    // Derivative-on-measurement (negated) to avoid setpoint-step kicks.
    // d(err)/dt = -d(measured)/dt when setpoint is constant; on a setpoint
    // step the previous form (err - prev_error)/dt produces an instantaneous
    // spike of kd*Δsetpoint/dt that injects into the motor command.
    float deriv = (dt > 0.0f) ? -(measured - p->prev_measured) / dt : 0.0f;
    p->prev_measured = measured;

    // Provisional output without the integral update for back-calculation
    // anti-windup: only integrate when the proposed command isn't already
    // pinned in the same direction as the error. This keeps a saturated
    // command from accumulating integral that takes seconds to bleed off
    // when the error reverses (overshoot on every aggressive setpoint
    // change otherwise).
    float pre_integral_out = p->kp * err + p->ki * p->integral + p->kd * deriv;
    bool saturating_high = (pre_integral_out >= p->out_max) && (err > 0.0f);
    bool saturating_low  = (pre_integral_out <= p->out_min) && (err < 0.0f);
    if (!saturating_high && !saturating_low) {
        p->integral += err * dt;
        if (p->integral >  p->i_limit) p->integral =  p->i_limit;
        if (p->integral < -p->i_limit) p->integral = -p->i_limit;
    }

    float out = p->kp * err + p->ki * p->integral + p->kd * deriv;
    if (out > p->out_max) out = p->out_max;
    if (out < p->out_min) out = p->out_min;
    return out;
}
