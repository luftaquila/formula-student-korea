#include "lights.h"

#include "config.h"
#include "gpio.h"

void lights_init(void)
{
    gpio_cfg_output(PIN_LIGHT_RED);
    gpio_cfg_output(PIN_LIGHT_GREEN);
    lights_set(LIGHTS_OFF);
}

void lights_set(light_state_t state)
{
    /* GPIO HIGH = colour on (drives +12V onto the SSR control line). */
    gpio_write(PIN_LIGHT_RED, state == LIGHTS_RED);
    gpio_write(PIN_LIGHT_GREEN, state == LIGHTS_GREEN);
}
