#include "nav_lights.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/gpio.h"

// Red (port) + green (starboard) nav lights are a 3-pin module powered from
// the +5V rail (J3: +5V, GND, control). PIN_NAV_LIGHTS drives the module's
// on/off control line directly, active-high (HIGH = on). Plain on/off, no PWM
// — colour is fixed, only the on/off *cadence* is selectable.
//
// The mode is set over the serial protocol ('N <mode>'): the operator picks it
// in the web UI → server → pilot → MCU. The pattern renders from a free-running
// clock, so it's independent of the control/telemetry loop rate.

// Cadence constants (tune to taste).
#define NAV_STROBE_FLASH_MS     60u    // double-strobe: each flash on-time
#define NAV_STROBE_GAP_MS       120u   // double-strobe: dark gap between flashes
#define NAV_STROBE2_PERIOD_MS   1400u  // double-strobe: full cycle
#define NAV_STROBE1_ON_MS       120u   // single-strobe: flash on-time
#define NAV_STROBE1_PERIOD_MS   1000u  // single-strobe: cycle (~1 Hz)
#define NAV_BLINK_PERIOD_MS     1000u  // 50%-duty blink cycle (~1 Hz)

static nav_mode_t g_mode = NAV_MODE_STROBE2;

void nav_lights_init(void) {
    gpio_init(PIN_NAV_LIGHTS);
    gpio_set_dir(PIN_NAV_LIGHTS, GPIO_OUT);
    gpio_put(PIN_NAV_LIGHTS, 0);   // off until the first tick
    g_mode = NAV_MODE_STROBE2;     // aircraft double-flash by default
}

void nav_lights_set(bool on) {
    gpio_put(PIN_NAV_LIGHTS, on ? 1 : 0);
}

void nav_lights_set_mode(nav_mode_t m) {
    if (m < NAV_MODE_COUNT_) {
        g_mode = m;
    }
}

nav_mode_t nav_lights_get_mode(void) {
    return g_mode;
}

void nav_lights_tick(uint32_t now_ms) {
    bool on = false;
    switch (g_mode) {
        case NAV_MODE_OFF:
            on = false;
            break;
        case NAV_MODE_STEADY:
            on = true;
            break;
        case NAV_MODE_STROBE2: {
            uint32_t t = now_ms % NAV_STROBE2_PERIOD_MS;
            on = (t < NAV_STROBE_FLASH_MS) ||
                 (t >= (NAV_STROBE_FLASH_MS + NAV_STROBE_GAP_MS) &&
                  t <  (2u * NAV_STROBE_FLASH_MS + NAV_STROBE_GAP_MS));
            break;
        }
        case NAV_MODE_STROBE1: {
            uint32_t t = now_ms % NAV_STROBE1_PERIOD_MS;
            on = (t < NAV_STROBE1_ON_MS);
            break;
        }
        case NAV_MODE_BLINK: {
            uint32_t t = now_ms % NAV_BLINK_PERIOD_MS;
            on = (t < NAV_BLINK_PERIOD_MS / 2u);
            break;
        }
        default:
            on = false;
            break;
    }
    gpio_put(PIN_NAV_LIGHTS, on ? 1 : 0);
}
