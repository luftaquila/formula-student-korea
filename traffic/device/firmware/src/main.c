/* Stage-2b: two-board LoRa link with USB-CDC serial output.
 *
 * Build twice: default = TX role, -DROLE_RX = RX role. Flash one board each.
 * Status is emitted on the USB CDC port (/dev/ttyACM*) once per second so it is
 * visible regardless of when the host opens the port:
 *
 *   TX: "TX begin=<c> tx=<r> n=<count>"   (begin/transmit return codes; 0 = ok)
 *   RX: "RX begin=<c> pkts=<count>"       + "RX <- packet" on each reception
 *
 * Link confirmed when the RX board's pkts count climbs in step with the TX
 * board's n. The USB stack also gives 1200-baud-touch bootloader entry, so
 * reflashing needs no physical reset.
 */
#include <stdio.h>

#include "board.h"
#include "radio.h"
#include "usb.h"

int main(void)
{
    board_init();

    /* Bring up the radio BEFORE USB: usb_init() makes the dcd start the HFXO,
     * and that HFCLK switch was disturbing the SPI during radio.begin()
     * (-707 SPI_CMD_FAILED). On stable HFINT, begin() succeeds (as in Stage 2a). */
    int st = radio_begin();

#if defined(ROLE_RX)
    if (st == 0) {
        radio_start_rx();
    }
#endif

    usb_init();

    uint32_t pkts = 0;
    uint32_t n = 0;
    uint32_t last = board_millis();
    char line[64];

    for (;;) {
        usb_task();

#if defined(ROLE_RX)
        if (st == 0 && radio_poll_rx() > 0) {
            pkts++;
            board_led_toggle();
            usb_write("RX <- packet\r\n");
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
            int t = (st == 0) ? radio_transmit_beacon() : -999;
            n++;
            board_led_toggle();
            snprintf(line, sizeof(line), "TX begin=%d tx=%d n=%lu\r\n", st, t, (unsigned long)n);
            usb_write(line);
#endif
        }
    }
}
