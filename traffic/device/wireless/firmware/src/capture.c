#include "capture.h"

#include "config.h"
#include "gpio.h"
#include "nrf.h"

/* TIMER1 = capture timebase (TIMER0 = unused SD, TIMER2 = board_micros).
 * SoftDevice never enabled so all GPIOTE/PPI channels are free. */
#define CAP_GPIOTE_DIO1 0
#define CAP_GPIOTE_SENS 1
#define CAP_PPI_DIO1    0
#define CAP_PPI_SENS    1
#define CAP_CC_DIO1     0 /* TIMER1->CC[] holding DIO1 captures */
#define CAP_CC_NOW      1 /* TIMER1->CC[] for on-demand reads */
#define CAP_CC_SENS     2 /* TIMER1->CC[] holding SENSOR captures */

#define DIO1_PIN (PIN_LORA_DIO1 % 32u) /* 6 */
#define DIO1_PRT (PIN_LORA_DIO1 / 32u) /* 1 */
#define SENS_PIN (PIN_SENSOR_IN % 32u) /* 11 */
#define SENS_PRT (PIN_SENSOR_IN / 32u) /* 1 */

void capture_init(void)
{
    NRF_TIMER1->TASKS_STOP = 1;
    NRF_TIMER1->MODE = TIMER_MODE_MODE_Timer;
    NRF_TIMER1->BITMODE = TIMER_BITMODE_BITMODE_32Bit;
    NRF_TIMER1->PRESCALER = 0; /* 16 MHz, 62.5 ns/tick */
    NRF_TIMER1->TASKS_CLEAR = 1;
    NRF_TIMER1->TASKS_START = 1;

    /* DIO1 (Tx/RxDone) — rising edge. */
    NRF_GPIOTE->CONFIG[CAP_GPIOTE_DIO1] =
        ((uint32_t)GPIOTE_CONFIG_MODE_Event       << GPIOTE_CONFIG_MODE_Pos)     |
        ((uint32_t)DIO1_PIN                       << GPIOTE_CONFIG_PSEL_Pos)     |
        ((uint32_t)DIO1_PRT                       << GPIOTE_CONFIG_PORT_Pos)     |
        ((uint32_t)GPIOTE_CONFIG_POLARITY_LoToHi  << GPIOTE_CONFIG_POLARITY_Pos);
    NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_DIO1] = 0;
    NRF_PPI->CH[CAP_PPI_DIO1].EEP = (uint32_t)&NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_DIO1];
    NRF_PPI->CH[CAP_PPI_DIO1].TEP = (uint32_t)&NRF_TIMER1->TASKS_CAPTURE[CAP_CC_DIO1];

    /* SENSOR (event) — falling edge (NPN open-collector); needs the pull-up. */
    gpio_cfg_input_pullup(PIN_SENSOR_IN);
    NRF_GPIOTE->CONFIG[CAP_GPIOTE_SENS] =
        ((uint32_t)GPIOTE_CONFIG_MODE_Event       << GPIOTE_CONFIG_MODE_Pos)     |
        ((uint32_t)SENS_PIN                       << GPIOTE_CONFIG_PSEL_Pos)     |
        ((uint32_t)SENS_PRT                       << GPIOTE_CONFIG_PORT_Pos)     |
        ((uint32_t)GPIOTE_CONFIG_POLARITY_HiToLo  << GPIOTE_CONFIG_POLARITY_Pos);
    NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_SENS] = 0;
    NRF_PPI->CH[CAP_PPI_SENS].EEP = (uint32_t)&NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_SENS];
    NRF_PPI->CH[CAP_PPI_SENS].TEP = (uint32_t)&NRF_TIMER1->TASKS_CAPTURE[CAP_CC_SENS];

    NRF_PPI->CHENSET = (1UL << CAP_PPI_DIO1) | (1UL << CAP_PPI_SENS);
}

/* 32->64-bit extension. capture_now64() polls the 32-bit counter and bumps the
 * high word on wrap; it must be called more often than the ~268 s wrap period. */
static uint64_t s_base; /* accumulated multiples of 2^32 */
static uint32_t s_prev; /* last low word observed */

static uint32_t timer1_now32(void)
{
    NRF_TIMER1->TASKS_CAPTURE[CAP_CC_NOW] = 1;
    return NRF_TIMER1->CC[CAP_CC_NOW];
}

uint64_t capture_now64(void)
{
    uint32_t low = timer1_now32();
    if (low < s_prev) {
        s_base += (uint64_t)1 << 32;
    }
    s_prev = low;
    return s_base + low;
}

/* Widen a recently-latched 32-bit capture (< 2^32 ticks ago) to 64 bits. */
static uint64_t widen(uint32_t cap_low)
{
    uint64_t now = capture_now64();
    uint32_t delta = (uint32_t)now - cap_low; /* ticks since capture (mod 2^32) */
    return now - delta;
}

int capture_dio1_get(uint64_t *tick)
{
    if (NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_DIO1] == 0) {
        return 0;
    }
    NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_DIO1] = 0;
    *tick = widen(NRF_TIMER1->CC[CAP_CC_DIO1]);
    return 1;
}

int capture_sensor_get(uint64_t *tick)
{
    if (NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_SENS] == 0) {
        return 0;
    }
    NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_SENS] = 0;
    *tick = widen(NRF_TIMER1->CC[CAP_CC_SENS]);
    return 1;
}
