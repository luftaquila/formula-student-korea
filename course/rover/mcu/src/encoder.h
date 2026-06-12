#ifndef ROVER_MCU_ENCODER_H
#define ROVER_MCU_ENCODER_H

#include <stdint.h>

typedef enum {
    ENC_LEFT  = 0,
    ENC_RIGHT = 1,
    ENC_COUNT_,
} encoder_id_t;

void encoder_init(void);

// Running signed tick count (forward-positive, quadrature x4) accumulated by
// encoder_tick() with the ±1-count noise deadband applied, so its deltas stay
// consistent with encoder_get_velocity(). NOT the raw PIO count and NOT a true
// absolute odometer — single-count creep steps are filtered out.
int32_t encoder_get_count(encoder_id_t id);

// Speed in m/s, computed by `encoder_tick()` from count delta.
float encoder_get_velocity(encoder_id_t id);

// Call from the control loop at CONTROL_TICK_HZ to refresh velocity.
void encoder_tick(void);

#endif
