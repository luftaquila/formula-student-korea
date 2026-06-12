#include "nav_lights.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/gpio.h"

// Red (port) + green (starboard) nav lights are a 3-pin module powered
// from the +5V rail (J3: +5V, GND, control). PIN_NAV_LIGHTS drives the
// module's on/off control line directly, active-high (HIGH = on).
// Plain on/off — no PWM.

void nav_lights_init(void) {
    gpio_init(PIN_NAV_LIGHTS);
    gpio_set_dir(PIN_NAV_LIGHTS, GPIO_OUT);
    gpio_put(PIN_NAV_LIGHTS, 0);  // off until explicitly turned on
}

void nav_lights_set(bool on) {
    gpio_put(PIN_NAV_LIGHTS, on ? 1 : 0);
}

// Aircraft anti-collision strobe cadence applied to the single red+green
// on/off channel. Real strobes are white wingtip lights; here we can only
// flash the red/green module, so we reproduce the *rhythm*, not the colour:
// two quick flashes, then a long dark gap, repeating. Tune the three
// constants to change the cadence.
#define NAV_STROBE_FLASH_MS    60u    // each flash on-time
#define NAV_STROBE_GAP_MS      120u   // dark time between the two flashes
#define NAV_STROBE_PERIOD_MS   1400u  // full double-flash cycle length

void nav_lights_tick(uint32_t now_ms) {
    uint32_t t = now_ms % NAV_STROBE_PERIOD_MS;
    bool on = (t < NAV_STROBE_FLASH_MS) ||
              (t >= (NAV_STROBE_FLASH_MS + NAV_STROBE_GAP_MS) &&
               t <  (2u * NAV_STROBE_FLASH_MS + NAV_STROBE_GAP_MS));
    gpio_put(PIN_NAV_LIGHTS, on ? 1 : 0);
}
