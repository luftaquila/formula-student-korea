#ifndef ROVER_MCU_PID_H
#define ROVER_MCU_PID_H

#include <stdbool.h>

typedef struct {
    float kp, ki, kd;
    float integral;
    float prev_error;
    float out_min, out_max;
    float i_limit;
} pid_t;

void  pid_init(pid_t *p, float kp, float ki, float kd);
void  pid_set_gains(pid_t *p, float kp, float ki, float kd);
void  pid_reset(pid_t *p);
float pid_step(pid_t *p, float setpoint, float measured, float dt);

#endif
