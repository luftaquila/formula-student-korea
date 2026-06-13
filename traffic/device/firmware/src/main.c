/* Stage-3c: sensor event timestamping end-to-end (DESIGN.md §2.4-§2.6).
 *
 * Sensor: receives beacons and tracks the master-time offset (Stage 3b); on a
 * SENSOR falling edge it HW-captures the event tick, maps it to master time
 * (offset + tick), and transmits an EVENT packet (briefly leaving RX, §2.8).
 * Master: beacons once per second, then listens between beacons and prints any
 * EVENT it collects, in master time — the PC-facing output (DESIGN §8).
 *
 * USB CDC:
 *   master: "TX seq=<s>"            and  "EVENT node=<n> seq=<e> t=<masterTick>"
 *   sensor: "RX off=<offset>"       and  "EV seq=<e> t=<masterTick>"
 *
 * Bench test: ground the SENSOR line (P1.11) -> master prints an EVENT.
 */
#include <stdio.h>
#include <stddef.h>

#include "board.h"
#include "radio.h"
#include "usb.h"
#include "capture.h"
#include "protocol.h"
#include "config.h"

#if defined(ROLE_RX)
/* Map a captured event tick to master time and send an EVENT, then resume RX.
 * Logs locally over USB. */
static void sensor_send_event(uint32_t ev_tick, uint32_t off, uint16_t *ev_seq)
{
    event_t e;
    e.type = PKT_TYPE_EVENT;
    e.set_id = SET_ID_A;
    e.node_id = NODE_SENSOR;
    e.ev_seq = (*ev_seq)++;
    e.ev_master_t = off + ev_tick;
    e.flags = 0;
    e.crc = crc16_ccitt((uint8_t *)&e, offsetof(event_t, crc));
    radio_transmit((uint8_t *)&e, sizeof(e));
    radio_start_rx();

    char line[48];
    snprintf(line, sizeof(line), "EV seq=%u t=%lu\r\n",
             e.ev_seq, (unsigned long)e.ev_master_t);
    usb_write(line);
}
#endif

int main(void)
{
    board_init();

    int st = radio_begin();
    if (st == 0) {
        capture_init();
        radio_start_rx();
    }

    usb_init();

    char line[80];
    uint32_t last = board_millis();
    uint8_t buf[32];

#if defined(ROLE_RX)
    /* sensor */
    uint32_t prev_l_rx = 0, cur_off = 0;
    uint8_t prev_seq = 0;
    int have_prev = 0, have_off = 0;
    uint16_t ev_seq = 0;

    for (;;) {
        usb_task();
        if (st != 0) {
            uint32_t now = board_millis();
            if ((uint32_t)(now - last) >= 1000u) { last = now; board_led_toggle(); }
            continue;
        }

        int n = radio_receive(buf, sizeof(buf));
        if (n >= (int)sizeof(beacon_t)) {
            uint32_t l_rx = 0;
            capture_dio1_get(&l_rx);
            beacon_t *b = (beacon_t *)buf;
            if (b->type == PKT_TYPE_BEACON &&
                crc16_ccitt(buf, offsetof(beacon_t, crc)) == b->crc) {
                board_led_toggle();
                if (have_prev && prev_seq == (uint8_t)(b->seq - 1u)) {
                    cur_off = b->m_tx_prev + T_AIR_REF_TICKS - prev_l_rx;
                    have_off = 1;
                    snprintf(line, sizeof(line), "RX seq=%u off=%lu\r\n",
                             b->seq, (unsigned long)cur_off);
                    usb_write(line);
                }
                prev_l_rx = l_rx; prev_seq = b->seq; have_prev = 1;
            }
        }

        uint32_t ev_tick;
        if (capture_sensor_get(&ev_tick) && have_off) {
            sensor_send_event(ev_tick, cur_off, &ev_seq);
        }

#if defined(SENSOR_SIM)
        /* Test-only: synthesize a sensor event every 3 s (the physical SENSOR
         * line isn't wired during bench bring-up). */
        static uint32_t sim_last;
        if (have_off && (uint32_t)(board_millis() - sim_last) >= 3000u) {
            sim_last = board_millis();
            sensor_send_event(capture_now(), cur_off, &ev_seq);
        }
#endif
    }
#else
    /* master */
    uint8_t seq = 0;
    uint32_t m_tx_last = 0;

    for (;;) {
        usb_task();

        uint32_t now = board_millis();
        if (st == 0 && (uint32_t)(now - last) >= 1000u) {
            last = now;
            board_led_toggle();

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
                m_tx_last = cap;
            }
            radio_start_rx(); /* listen for EVENTs until the next beacon */
            snprintf(line, sizeof(line), "TX seq=%u\r\n", seq);
            usb_write(line);
            seq++;
            continue;
        }

        if (st != 0) {
            if ((uint32_t)(now - last) >= 1000u) {
                last = now;
                board_led_toggle();
                snprintf(line, sizeof(line), "TX begin=%d\r\n", st);
                usb_write(line);
            }
            continue;
        }

        int n = radio_receive(buf, sizeof(buf));
        if (n >= (int)sizeof(event_t)) {
            event_t *e = (event_t *)buf;
            if (e->type == PKT_TYPE_EVENT &&
                crc16_ccitt(buf, offsetof(event_t, crc)) == e->crc) {
                snprintf(line, sizeof(line), "EVENT node=%u seq=%u t=%lu\r\n",
                         e->node_id, e->ev_seq, (unsigned long)e->ev_master_t);
                usb_write(line);
            }
        }
    }
#endif
}
