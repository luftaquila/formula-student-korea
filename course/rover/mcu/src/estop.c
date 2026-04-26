#include "estop.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include "hardware/sync.h"

#include <stdbool.h>

static volatile bool g_tripped = false;

bool estop_is_active(void) {
    // NC + pull-up: rest = LOW (button closed), tripped = HIGH (button
    // pressed *or* wire broken). Fail-safe: any open in the loop trips.
    return g_tripped || (gpio_get(PIN_ESTOP_IN) == 1);
}

void estop_clear(void) {
    uint32_t s = save_and_disable_interrupts();
    g_tripped = false;
    restore_interrupts(s);
}

void estop_trip(void) {
    uint32_t s = save_and_disable_interrupts();
    g_tripped = true;
    restore_interrupts(s);
}

void estop_init(void) {
    gpio_init(PIN_ESTOP_IN);
    gpio_set_dir(PIN_ESTOP_IN, GPIO_IN);
    gpio_pull_up(PIN_ESTOP_IN);  // NC button at rest pulls line LOW
    // Polled latch is sufficient — both main and core1 check
    // estop_is_active() every tick, so a transient HIGH (~1 ms press
    // or a contact bounce) is captured on the next sample.
    g_tripped = false;
}
