#include <RadioLib.h>

#include "radio_hal.h"
#include "radio.h"
#include "gpio.h"

extern "C" {
#include "config.h"
}

/* Statically allocated — no heap. Constructors run from __libc_init_array
 * before main(); hardware init happens in radio_begin() -> radio.begin(). */
static NrfHal hal(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI);
static Module mod(&hal, PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_NRST, PIN_LORA_BUSY);
static SX1262 radio(&mod);

extern "C" int radio_begin(void)
{
    /* begin() occasionally fails with garbled SPI readback on the hand-built
     * board; retry a few times (each begin() re-resets the radio). */
    int state = RADIOLIB_ERR_NONE;
    for (int attempt = 0; attempt < 5; attempt++) {
        state = radio.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR,
                            LORA_SYNCWORD, LORA_POWER_DBM, LORA_PREAMBLE,
                            LORA_TCXO_V, false);
        if (state == RADIOLIB_ERR_NONE) {
            break;
        }
    }
    if (state != RADIOLIB_ERR_NONE) {
        return state;
    }

    /* Ra-01SH RF switch (TXEN/RXEN) — required for any TX/RX (DESIGN §3/§8). */
    radio.setRfSwitchPins(PIN_LORA_RXEN, PIN_LORA_TXEN);
    return RADIOLIB_ERR_NONE;
}

extern "C" int radio_transmit_beacon(void)
{
    uint8_t msg[] = {'F', 'S', 'K', '-', 'A'};
    return radio.transmit(msg, sizeof(msg));
}

extern "C" int radio_start_rx(void)
{
    return radio.startReceive();
}

extern "C" int radio_poll_rx(void)
{
    /* DIO1 is mapped to RxDone (+ error/timeout) by startReceive(); we poll it
     * since attachInterrupt is a stub in this stage. */
    if (gpio_read(PIN_LORA_DIO1) == 0) {
        return 0;
    }
    uint8_t buf[64];
    int16_t state = radio.readData(buf, sizeof(buf));
    radio.startReceive(); /* re-arm */
    return (state == RADIOLIB_ERR_NONE) ? 1 : -1;
}
