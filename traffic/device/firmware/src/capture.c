#include "capture.h"

#include "config.h"
#include "nrf.h"

/* TIMER1 = capture timebase (TIMER0 = unused SD, TIMER2 = board_micros).
 * GPIOTE/PPI channel 0; SoftDevice never enabled so all channels are free. */
#define CAP_GPIOTE_CH 0
#define CAP_PPI_CH    0
#define CAP_CC_DIO1   0 /* TIMER1->CC[] holding DIO1 captures */
#define CAP_CC_NOW    1 /* TIMER1->CC[] for on-demand reads */

#define DIO1_PIN (PIN_LORA_DIO1 % 32u) /* 6 */
#define DIO1_PRT (PIN_LORA_DIO1 / 32u) /* 1 */

void capture_init(void)
{
    NRF_TIMER1->TASKS_STOP = 1;
    NRF_TIMER1->MODE = TIMER_MODE_MODE_Timer;
    NRF_TIMER1->BITMODE = TIMER_BITMODE_BITMODE_32Bit;
    NRF_TIMER1->PRESCALER = 0; /* 16 MHz, 62.5 ns/tick */
    NRF_TIMER1->TASKS_CLEAR = 1;
    NRF_TIMER1->TASKS_START = 1;

    NRF_GPIOTE->CONFIG[CAP_GPIOTE_CH] =
        ((uint32_t)GPIOTE_CONFIG_MODE_Event       << GPIOTE_CONFIG_MODE_Pos)     |
        ((uint32_t)DIO1_PIN                       << GPIOTE_CONFIG_PSEL_Pos)     |
        ((uint32_t)DIO1_PRT                       << GPIOTE_CONFIG_PORT_Pos)     |
        ((uint32_t)GPIOTE_CONFIG_POLARITY_LoToHi  << GPIOTE_CONFIG_POLARITY_Pos);
    NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_CH] = 0;

    NRF_PPI->CH[CAP_PPI_CH].EEP = (uint32_t)&NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_CH];
    NRF_PPI->CH[CAP_PPI_CH].TEP = (uint32_t)&NRF_TIMER1->TASKS_CAPTURE[CAP_CC_DIO1];
    NRF_PPI->CHENSET = (1UL << CAP_PPI_CH);
}

int capture_dio1_get(uint32_t *tick)
{
    if (NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_CH] == 0) {
        return 0;
    }
    NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_CH] = 0;
    *tick = NRF_TIMER1->CC[CAP_CC_DIO1];
    return 1;
}

uint32_t capture_now(void)
{
    NRF_TIMER1->TASKS_CAPTURE[CAP_CC_NOW] = 1;
    return NRF_TIMER1->CC[CAP_CC_NOW];
}
