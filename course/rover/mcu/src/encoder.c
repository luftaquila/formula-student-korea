#include "encoder.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "quadrature_encoder.pio.h"

#include <stdint.h>

// PIO program is BSD-3-Clause from raspberrypi/pico-examples. It maintains
// the encoder count entirely in the state machine — zero CPU per edge — and
// writes the latest value to the RX FIFO continuously. We just drain the
// FIFO on demand to read the current absolute count.

typedef struct {
    PIO  pio;
    uint sm;
    uint pin_base;     // A pin; B must be pin_base + 1
    int32_t last_count;
    float velocity_mps;
} enc_state_t;

static enc_state_t g_enc[ENC_COUNT_];
static bool        g_program_loaded = false;

static void init_one(enc_state_t *e, PIO pio, uint sm, uint pin_base) {
    e->pio = pio;
    e->sm = sm;
    e->pin_base = pin_base;
    e->last_count = 0;
    e->velocity_mps = 0.0f;
    quadrature_encoder_program_init(pio, sm, pin_base, 0);
}

void encoder_init(void) {
    PIO pio = pio0;

    // The PIO program must be loaded at offset 0 (uses computed jumps).
    // pio_add_program will choose offset 0 since this is the first program.
    if (!g_program_loaded) {
        pio_add_program(pio, &quadrature_encoder_program);
        g_program_loaded = true;
    }

    init_one(&g_enc[ENC_LEFT],  pio, 0, PIN_ENC_LEFT_A);
    init_one(&g_enc[ENC_RIGHT], pio, 1, PIN_ENC_RIGHT_A);
}

int32_t encoder_get_count(encoder_id_t id) {
    if (id >= ENC_COUNT_) return 0;
    return quadrature_encoder_get_count(g_enc[id].pio, g_enc[id].sm);
}

float encoder_get_velocity(encoder_id_t id) {
    if (id >= ENC_COUNT_) return 0.0f;
    return g_enc[id].velocity_mps;
}

void encoder_tick(void) {
    const float dt = 1.0f / (float)CONTROL_TICK_HZ;
    for (int i = 0; i < ENC_COUNT_; i++) {
        int32_t c = quadrature_encoder_get_count(g_enc[i].pio, g_enc[i].sm);
        // Two's complement subtraction wraps correctly even across INT32 wrap.
        int32_t d = c - g_enc[i].last_count;
        g_enc[i].last_count = c;
        g_enc[i].velocity_mps = (float)d * METERS_PER_COUNT / dt;
    }
}
