#include "board.h"

#include "config.h"
#include "gpio.h"
#include "nrf.h"

/* App is linked at the S140 v6 user-app base (0x26000); point the core at our
 * vector table so interrupts dispatch to us, not the SoftDevice's. */
#define APP_VECTOR_BASE 0x00026000UL

/* Switch HFCLK from the 64 MHz internal RC (HFINT, the reset default) to the
 * external crystal (HFXO). The TIMERs derive PCLK16M from HFCLK, so the capture
 * timebase (TIMER1) inherits the source's accuracy. HFINT is only ~±1-2% — two
 * nodes on RC drift apart by ~1% (skew_ppm reads ~10000 and never settles). The
 * external SX1262 radio does not need the nRF RADIO peripheral, so nothing else
 * forces HFXO on; previously only the USB-connected master got HFXO for free
 * (TinyUSB starts it on VBUS), leaving battery sensors on RC. Start it here so
 * every role's timebase is crystal-disciplined (±40 ppm) regardless of USB. */
static void hfclk_init(void)
{
    NRF_CLOCK->EVENTS_HFCLKSTARTED = 0;
    NRF_CLOCK->TASKS_HFCLKSTART = 1;
    while (NRF_CLOCK->EVENTS_HFCLKSTARTED == 0) {
        /* spin until the crystal is running and HFCLK has switched to it */
    }
}

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

    hfclk_init();
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
