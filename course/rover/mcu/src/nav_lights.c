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
