#include <assert.h>
#include <stdint.h>
#define GPIO_H
#include "stubs/nrf.h"
static void gpio_cfg_input_pullup(uint32_t pin) { (void)pin; }
static timer_mock_t capture_timer;
static struct { uint32_t EVENTS_IN[2], CONFIG[2], INTENSET; } capture_gpiote;
static struct { struct { uintptr_t EEP, TEP; } CH[3]; uint32_t CHENSET; } capture_ppi;
static struct { uint32_t EVENTS_SOF, ENABLE, FRAMECNTR; } capture_usb;
#define NRF_TIMER1 (&capture_timer)
#define NRF_GPIOTE (&capture_gpiote)
#define NRF_PPI (&capture_ppi)
#define NRF_USBD (&capture_usb)
#define GPIOTE_CONFIG_MODE_Event 0
#define GPIOTE_CONFIG_MODE_Pos 0
#define GPIOTE_CONFIG_PSEL_Pos 0
#define GPIOTE_CONFIG_PORT_Pos 0
#define GPIOTE_CONFIG_POLARITY_LoToHi 0
#define GPIOTE_CONFIG_POLARITY_HiToLo 0
#define GPIOTE_CONFIG_POLARITY_Pos 0
#define GPIOTE_INTENSET_IN0_Pos 0
#define USBD_ENABLE_ENABLE_Msk 1
#define GPIOTE_IRQn 0
#define NVIC_ClearPendingIRQ(x) ((void)0)
#define NVIC_SetPriority(x,y) ((void)0)
#define NVIC_EnableIRQ(x) ((void)0)
#define NVIC_DisableIRQ(x) ((void)0)
#define __DMB() ((void)0)
#include "../../../competition/modules/traffic/device/wireless/firmware/src/capture.c"
int board_hfclk_xtal(void) { return 1; }
static void edge(uint32_t at) {
    NRF_TIMER1->CC[CAP_CC_NOW] = at;
    NRF_TIMER1->CC[CAP_CC_SENS] = at;
    NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_SENS] = 1;
    GPIOTE_IRQHandler();
}
int main(void) {
    for (unsigned i = 1; i <= 17; i++) edge(i * 100);
    uint64_t at, end;
    uint32_t seq, last;
    int xtal;
    assert(capture_sensor_overflow() == 2);
    assert(!capture_sensor_checkpoint(&at, &seq));
    for (unsigned i = 1; i <= 15; i++) {
        assert(capture_sensor_get(&at, &seq, &xtal));
        assert(seq == i && at == i * 100 && xtal);
    }
    assert(!capture_sensor_checkpoint(&at, &seq)); // loss must be drained too
    assert(capture_sensor_loss(&at, &end, &seq, &last));
    assert(seq == 16 && last == 17 && at == 1600 && end == 1700);
    assert(capture_sensor_checkpoint(&at, &seq) && seq == 17);
    edge(1800);
    assert(capture_sensor_get(&at, &seq, &xtal) && seq == 18 && at == 1800);
    assert(capture_sensor_checkpoint(&at, &seq) && seq == 18);
    NRF_GPIOTE->EVENTS_IN[CAP_GPIOTE_SENS] = 1;
    assert(!capture_sensor_checkpoint(&at, &seq)); // hardware edge awaiting ISR
    return 0;
}
