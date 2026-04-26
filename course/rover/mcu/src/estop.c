#include "estop.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include "hardware/sync.h"

#include <stdbool.h>

static volatile bool g_tripped = false;

bool estop_is_active(void) {
    return g_tripped || (gpio_get(PIN_ESTOP_IN) == 0);
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
    gpio_pull_up(PIN_ESTOP_IN);  // button shorts to GND when pressed
    // Latch on first low edge so a momentary push still trips. Edge IRQ
    // is multiplexed through the encoder GPIO callback (gpio.c uses a
    // single bank-wide handler), but estop only needs a polled latch
    // because main and core1 both check estop_is_active() every tick.
    g_tripped = false;
}
