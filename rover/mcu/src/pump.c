#include "pump.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/gpio.h"

// The pump is a plain digital output — no PWM slice, no slew. The
// IRLZ44N switches the whole pump rail, so a HIGH gate runs the pump at
// full flow and a LOW gate stops it. GP6 was formerly the dispenser
// servo's PWM pin (slice3 chA); driven here as SIO the slice stays idle.
static bool g_pump_on = false;

void pump_init(void) {
    gpio_init(PIN_PUMP);
    gpio_set_dir(PIN_PUMP, GPIO_OUT);
    gpio_put(PIN_PUMP, 0);   // off on boot — never dispense on power-on
    g_pump_on = false;
}

void pump_set(bool on) {
    g_pump_on = on;
    gpio_put(PIN_PUMP, on ? 1 : 0);
}

bool pump_is_on(void) {
    return g_pump_on;
}
