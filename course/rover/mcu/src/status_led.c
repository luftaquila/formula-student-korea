#include "status_led.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "hardware/gpio.h"
#include "ws2812.pio.h"

#include <stdint.h>

// PIO0 is owned by the quadrature encoder (program must load at offset 0,
// uses SM0+SM1). Park both WS2812 chains on PIO1: SM0 = onboard status
// LED (GP16), SM1 = external 16-LED stick chain (GP11). Both run the same
// ws2812 program; the external chain mirrors the onboard colour 1:1.
static PIO     g_pio    = pio1;
static uint    g_sm     = 0;   // onboard WS2812 (GP16)
static uint    g_ext_sm = 0;   // external NeoPixel chain (GP11)
static led_state_t g_state = LED_BOOT;
static uint32_t g_tick = 0;

// WS2812 expects GRB ordering, MSB-first in 24 bits.
static inline uint32_t grb(uint8_t r, uint8_t g, uint8_t b) {
    return ((uint32_t)g << 24) | ((uint32_t)r << 16) | ((uint32_t)b << 8);
}

// Drive the same colour to the onboard LED (1 pixel) and the external
// stick chain (EXT_LED_COUNT pixels) so the sticks mirror the onboard
// status indicator exactly. ~50 Hz refresh leaves ample WS2812 reset gap.
static void put_pixel(uint32_t pixel_grb) {
    pio_sm_put_blocking(g_pio, g_sm, pixel_grb);
    for (int i = 0; i < EXT_LED_COUNT; i++) {
        pio_sm_put_blocking(g_pio, g_ext_sm, pixel_grb);
    }
}

void status_led_init(void) {
    // One program load on PIO1, shared by both state machines.
    uint offset = pio_add_program(g_pio, &ws2812_program);

    g_sm = (uint)pio_claim_unused_sm(g_pio, true);
    ws2812_program_init(g_pio, g_sm, offset, PIN_STATUS_LED, 800000.0f);

    // External stick chain on a second SM, same program/offset.
    g_ext_sm = (uint)pio_claim_unused_sm(g_pio, true);
    ws2812_program_init(g_pio, g_ext_sm, offset, PIN_EXT_LEDS, 800000.0f);
    // The external data line is inverted by the 2N7002 level shifter
    // (3V3 → +5V). Invert the GPIO output so the LED DIN sees the
    // program's true polarity, including the idle-low reset gap.
    gpio_set_outover(PIN_EXT_LEDS, GPIO_OVERRIDE_INVERT);

    put_pixel(grb(255, 255, 255));
}

void status_led_set(led_state_t state) {
    g_state = state;
}

void status_led_tick(void) {
    g_tick++;
    bool blink_on = (g_tick % 25) < 13;  // ~2 Hz at 50 Hz tick
    switch (g_state) {
        // Full-brightness WS2812 with hue preserved (largest channel = 255).
        case LED_BOOT:    put_pixel(grb(255, 255, 255)); break;
        case LED_IDLE:    put_pixel(grb(0, 255, 0)); break;
        case LED_ACTIVE:  put_pixel(grb(0, 0, 255)); break;
        case LED_WARN:    put_pixel(grb(255, 170, 0)); break;
        case LED_ESTOP:   put_pixel(blink_on ? grb(255, 0, 0) : 0); break;
        case LED_FAULT:   put_pixel(grb(255, 0, 255)); break;
        // Orange (RGB ≈ 255,112,0). Blink at the same ~2 Hz cadence as
        // LED_ESTOP so operators see the chassis-halted indication at a
        // glance, distinguished from estop only by hue (orange vs red).
        case LED_GPS_LOST: put_pixel(blink_on ? grb(255, 112, 0) : 0); break;
        default:           put_pixel(0); break;
    }
}
