/* Stage-3b: single-direction time sync (DESIGN.md §2.5) over the LoRa link.
 *
 * Master sends a BEACON each second carrying the TxDone tick of the PREVIOUS
 * beacon (m_tx_prev) and HW-captures this beacon's TxDone for the next one.
 * The sensor HW-captures each beacon's RxDone and, when the next beacon arrives
 * carrying m_tx_prev for the beacon it already received, computes
 *   offset = m_tx_prev + T_air_ref - l_rx_prev   (mod 2^32, 16 MHz ticks)
 * which maps sensor ticks to master time. A stable/slowly-drifting offset (the
 * drift is the relative HFXO skew, ~hundreds of ticks/s) confirms sync.
 *
 * USB CDC output:
 *   master: "TX seq=<s> m_tx=<tick>"
 *   sensor: "RX seq=<s> off=<offset> dOff=<delta>"   (dOff ~ per-beacon skew)
 */
#include <stdio.h>
#include <stddef.h>

#include "board.h"
#include "radio.h"
#include "usb.h"
#include "capture.h"
#include "protocol.h"
#include "config.h"

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

    char line[80];
    uint32_t last = board_millis();

#if defined(ROLE_RX)
    /* sensor */
    uint32_t prev_l_rx = 0, prev_off = 0;
    uint8_t prev_seq = 0;
    int have_prev = 0, have_off = 0;

    for (;;) {
        usb_task();
        if (st != 0) {
            uint32_t now = board_millis();
            if ((uint32_t)(now - last) >= 1000u) { last = now; board_led_toggle(); }
            continue;
        }

        uint8_t buf[32];
        int n = radio_receive(buf, sizeof(buf));
        if (n >= (int)sizeof(beacon_t)) {
            uint32_t l_rx = 0;
            capture_dio1_get(&l_rx); /* RxDone of this beacon */
            beacon_t *b = (beacon_t *)buf;
            if (b->type == PKT_TYPE_BEACON &&
                crc16_ccitt(buf, offsetof(beacon_t, crc)) == b->crc) {
                board_led_toggle();
                if (have_prev && prev_seq == (uint8_t)(b->seq - 1u)) {
                    uint32_t off = b->m_tx_prev + T_AIR_REF_TICKS - prev_l_rx;
                    int32_t d = have_off ? (int32_t)(off - prev_off) : 0;
                    snprintf(line, sizeof(line), "RX seq=%u off=%lu dOff=%ld\r\n",
                             b->seq, (unsigned long)off, (long)d);
                    usb_write(line);
                    prev_off = off; have_off = 1;
                }
                prev_l_rx = l_rx; prev_seq = b->seq; have_prev = 1;
            }
        }
    }
#else
    /* master */
    uint8_t seq = 0;
    uint32_t m_tx_last = 0;

    for (;;) {
        usb_task();
        uint32_t now = board_millis();
        if ((uint32_t)(now - last) < 1000u) {
            continue;
        }
        last = now;
        board_led_toggle();

        if (st != 0) {
            snprintf(line, sizeof(line), "TX begin=%d\r\n", st);
            usb_write(line);
            continue;
        }

        beacon_t b;
        b.type = PKT_TYPE_BEACON;
        b.set_id = SET_ID_A;
        b.seq = seq;
        b.m_tx_prev = m_tx_last;
        b.period_ms = 1000;
        b.crc = crc16_ccitt((uint8_t *)&b, offsetof(beacon_t, crc));
        radio_transmit((uint8_t *)&b, sizeof(b));

        uint32_t cap = 0;
        if (capture_dio1_get(&cap)) {
            m_tx_last = cap; /* this beacon's TxDone -> next beacon's m_tx_prev */
        }
        snprintf(line, sizeof(line), "TX seq=%u m_tx=%lu\r\n", seq, (unsigned long)m_tx_last);
        usb_write(line);
        seq++;
    }
#endif
}
