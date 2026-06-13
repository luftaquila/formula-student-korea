/* Stage-3a: hardware timestamp capture on top of the working LoRa link.
 *
 * TIMER1 (16 MHz) latches DIO1's rising edge (Tx/RxDone) via GPIOTE->PPI with
 * no CPU involvement. Output on the USB CDC port confirms the capture:
 *
 *   TX: "TX n=<N> tx=<r> cap=<tick> dt=<ticks>"   dt ≈ 16e6 between beacons (1 s)
 *   RX: "RX pkts=<M> cap=<tick>"                   per received packet
 *
 * This is the deterministic timebase the sync protocol (Stage 3b) builds on.
 */
#include <stdio.h>

#include "board.h"
#include "radio.h"
#include "usb.h"
#include "capture.h"

int main(void)
{
    board_init();

    int st = radio_begin();

    if (st == 0) {
        capture_init();
#if defined(ROLE_RX)
        radio_start_rx();
#endif
    }

    usb_init();

    uint32_t pkts = 0;
    uint32_t n = 0;
    uint32_t prev_cap = 0;
    uint32_t last = board_millis();
    char line[80];

    for (;;) {
        usb_task();

#if defined(ROLE_RX)
        if (st == 0 && radio_poll_rx() > 0) {
            pkts++;
            board_led_toggle();
            uint32_t cap = 0;
            capture_dio1_get(&cap);
            snprintf(line, sizeof(line), "RX pkts=%lu cap=%lu\r\n",
                     (unsigned long)pkts, (unsigned long)cap);
            usb_write(line);
        }
#endif

        uint32_t now = board_millis();
        if ((uint32_t)(now - last) >= 1000u) {
            last = now;
#if defined(ROLE_RX)
            snprintf(line, sizeof(line), "RX begin=%d pkts=%lu\r\n", st, (unsigned long)pkts);
            usb_write(line);
            if (st != 0) {
                board_led_toggle();
            }
#else
            board_led_toggle();
            if (st == 0) {
                int t = radio_transmit_beacon();
                n++;
                uint32_t cap = 0;
                capture_dio1_get(&cap);
                snprintf(line, sizeof(line), "TX n=%lu tx=%d cap=%lu dt=%lu\r\n",
                         (unsigned long)n, t, (unsigned long)cap,
                         (unsigned long)(cap - prev_cap));
                prev_cap = cap;
                usb_write(line);
            } else {
                snprintf(line, sizeof(line), "TX begin=%d\r\n", st);
                usb_write(line);
            }
#endif
        }
    }
}
