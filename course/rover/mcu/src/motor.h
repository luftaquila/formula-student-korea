#ifndef ROVER_MCU_MOTOR_H
#define ROVER_MCU_MOTOR_H

void motor_init(void);

// Duty in [-1.0, 1.0]. Sign sets DIR; magnitude sets PWM duty.
void motor_set(int channel, float duty);  // channel: 0=left, 1=right
void motor_stop_all(void);

#endif
