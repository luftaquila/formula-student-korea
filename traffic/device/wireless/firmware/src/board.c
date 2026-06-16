#include "board.h"

#include "config.h"
#include "gpio.h"
#include "nrf.h"

/* App is linked at the S140 v6 user-app base (0x26000); point the core at our
 * vector table so interrupts dispatch to us, not the SoftDevice's. */
#define APP_VECTOR_BASE 0x00026000UL

static void timebase_init(void)
{
    /* TIMER2 free-running at 1 MHz (16 MHz / 2^4). TIMER0 belongs to the
     * (unused) SoftDevice, TIMER1 is reserved for the Stage-3 capture base. */
    NRF_TIMER2->TASKS_STOP = 1;
    NRF_TIMER2->MODE = TIMER_MODE_MODE_Timer;
    NRF_TIMER2->BITMODE = TIMER_BITMODE_BITMODE_32Bit;
    NRF_TIMER2->PRESCALER = 4;
    NRF_TIMER2->TASKS_CLEAR = 1;
    NRF_TIMER2->TASKS_START = 1;
}

uint32_t board_micros(void)
{
    NRF_TIMER2->TASKS_CAPTURE[0] = 1;
    return NRF_TIMER2->CC[0];
}

uint32_t board_millis(void)
{
    return board_micros() / 1000UL;
}

void board_init(void)
{
    SCB->VTOR = APP_VECTOR_BASE;

    timebase_init();
    board_ext_power_on();

    gpio_cfg_output(PIN_LED_STATUS);
    board_led_off();
}

void board_ext_power_on(void)
{
    gpio_cfg_output(PIN_EXT_POWER);
    gpio_set(PIN_EXT_POWER);
}

void board_ext_power_off(void)
{
    gpio_clear(PIN_EXT_POWER);
}

void board_led_on(void)
{
    gpio_set(PIN_LED_STATUS);
}

void board_led_off(void)
{
    gpio_clear(PIN_LED_STATUS);
}

void board_led_toggle(void)
{
    gpio_toggle(PIN_LED_STATUS);
}

void board_led_write(int on)
{
    gpio_write(PIN_LED_STATUS, on);
}

void board_delay_ms(uint32_t ms)
{
    uint32_t start = board_micros();
    uint32_t target = ms * 1000UL;
    while ((uint32_t)(board_micros() - start) < target) {
    }
}
