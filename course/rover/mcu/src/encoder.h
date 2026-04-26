#ifndef ROVER_MCU_ENCODER_H
#define ROVER_MCU_ENCODER_H

#include <stdint.h>

typedef enum {
    ENC_LEFT  = 0,
    ENC_RIGHT = 1,
    ENC_COUNT_,
} encoder_id_t;

void encoder_init(void);

// Atomic 32-bit signed count snapshot (quadrature x4 ticks).
int32_t encoder_get_count(encoder_id_t id);

// Speed in m/s, computed by `encoder_tick()` from count delta.
float encoder_get_velocity(encoder_id_t id);

// Call from the control loop at CONTROL_TICK_HZ to refresh velocity.
void encoder_tick(void);

#endif
