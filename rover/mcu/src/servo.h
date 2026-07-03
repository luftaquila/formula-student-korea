#ifndef ROVER_MCU_SERVO_H
#define ROVER_MCU_SERVO_H

#include <stdint.h>

typedef enum {
    SERVO_STEER     = 0,
    SERVO_COUNT_
} servo_id_t;

void servo_init(void);

// Set immediate target. Slew-limited per CONTROL_TICK_HZ inside servo_tick().
void servo_set_target_us(servo_id_t id, uint16_t pulse_us);

// Apply slew-limited update toward target. Call at CONTROL_TICK_HZ.
void servo_tick(void);

void servo_center_all(void);

#endif
