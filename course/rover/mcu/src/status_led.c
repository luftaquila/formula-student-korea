#include "status_led.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "ws2812.pio.h"

#include <stdint.h>

// PIO0 is owned by the quadrature encoder (program must load at offset 0,
// uses SM0+SM1). Park WS2812 on PIO1.
static PIO     g_pio = pio1;
static uint    g_sm  = 0;
static led_state_t g_state = LED_BOOT;
static uint32_t g_tick = 0;

// WS2812 expects GRB ordering, MSB-first in 24 bits.
static inline uint32_t grb(uint8_t r, uint8_t g, uint8_t b) {
    return ((uint32_t)g << 24) | ((uint32_t)r << 16) | ((uint32_t)b << 8);
}

static void put_pixel(uint32_t pixel_grb) {
    pio_sm_put_blocking(g_pio, g_sm, pixel_grb);
}

void status_led_init(void) {
    g_sm = (uint)pio_claim_unused_sm(g_pio, true);
    uint offset = pio_add_program(g_pio, &ws2812_program);
    ws2812_program_init(g_pio, g_sm, offset, PIN_STATUS_LED, 800000.0f);
    put_pixel(grb(8, 8, 8));
}

void status_led_set(led_state_t state) {
    g_state = state;
}

void status_led_tick(void) {
    g_tick++;
    bool blink_on = (g_tick % 25) < 13;  // ~2 Hz at 50 Hz tick
    switch (g_state) {
        case LED_BOOT:    put_pixel(grb(8, 8, 8)); break;
        case LED_IDLE:    put_pixel(grb(0, 32, 0)); break;
        case LED_ACTIVE:  put_pixel(grb(0, 0, 64)); break;
        case LED_WARN:    put_pixel(grb(48, 32, 0)); break;
        case LED_ESTOP:   put_pixel(blink_on ? grb(80, 0, 0) : 0); break;
        case LED_FAULT:   put_pixel(grb(48, 0, 48)); break;
        // Orange (RGB ≈ 255,140,0 scaled to the WS2812 dim band ~64).
        // Blink at the same ~2 Hz cadence as LED_ESTOP so operators
        // see the chassis-halted indication at a glance, distinguished
        // from estop only by hue (orange vs red).
        case LED_GPS_LOST: put_pixel(blink_on ? grb(64, 28, 0) : 0); break;
        default:           put_pixel(0); break;
    }
}
