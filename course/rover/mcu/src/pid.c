#include "pid.h"
#include "config.h"

void pid_init(pid_t *p, float kp, float ki, float kd) {
    p->kp = kp; p->ki = ki; p->kd = kd;
    p->integral = 0.0f;
    p->prev_error = 0.0f;
    p->out_min = PID_OUT_MIN;
    p->out_max = PID_OUT_MAX;
    p->i_limit = PID_INTEGRAL_LIMIT;
}

void pid_set_gains(pid_t *p, float kp, float ki, float kd) {
    p->kp = kp; p->ki = ki; p->kd = kd;
}

void pid_reset(pid_t *p) {
    p->integral = 0.0f;
    p->prev_error = 0.0f;
}

float pid_step(pid_t *p, float setpoint, float measured, float dt) {
    float err = setpoint - measured;
    p->integral += err * dt;
    if (p->integral >  p->i_limit) p->integral =  p->i_limit;
    if (p->integral < -p->i_limit) p->integral = -p->i_limit;

    float deriv = (dt > 0.0f) ? (err - p->prev_error) / dt : 0.0f;
    p->prev_error = err;

    float out = p->kp * err + p->ki * p->integral + p->kd * deriv;
    if (out > p->out_max) out = p->out_max;
    if (out < p->out_min) out = p->out_min;
    return out;
}
