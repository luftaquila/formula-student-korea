#include "nav_lights.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/gpio.h"

// Red (port) + green (starboard) nav lights share one low-side N-channel
// switch on PIN_NAV_LIGHTS. The light current comes from the +5V servo
// rail; the MCU only gates the switch. Plain on/off — no PWM.

void nav_lights_init(void) {
    gpio_init(PIN_NAV_LIGHTS);
    gpio_set_dir(PIN_NAV_LIGHTS, GPIO_OUT);
    gpio_put(PIN_NAV_LIGHTS, 0);  // off until explicitly turned on
}

void nav_lights_set(bool on) {
    gpio_put(PIN_NAV_LIGHTS, on ? 1 : 0);
}
