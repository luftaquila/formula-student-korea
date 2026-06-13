/* Two-board LoRa timing node.
 *
 * MASTER = the controller the PC connects to. It speaks the legacy FSK-TC
 * serial protocol transparently (traffic/device/firmware on main +
 * traffic/web stores/serial.js): VID/PID 0x1999/0x0514, "$...!" framing, ms
 * ticks. Commands $G/$R/$X drive the lights and ack $OK; $HELLO -> $HI; LoRa
 * EVENTs are reported as "$S <sensor> <ms>!". A "$T <sensor> <16MHz tick>!"
 * companion line carries the full HW-capture precision (ignored by the old PC).
 * The master also beacons once per second to keep the sensors time-synced.
 *
 * SENSOR = remote node: syncs to the master's beacons, HW-captures a SENSOR
 * edge, maps it to master time, and transmits an EVENT.  -DSENSOR_SIM fires a
 * synthetic event for bench testing.
 *
 * Timebase is a 64-bit 16 MHz tick; reported ms = tick/16000 truncated to 32
 * bits (wraps at 49 days like the legacy HAL_GetTick, never mid-run).
 */
#include <stdio.h>
#include <stddef.h>

#include "board.h"
#include "radio.h"
#include "usb.h"
#include "capture.h"
#include "protocol.h"
#include "config.h"
#include "lights.h"

#define TICKS_PER_MS 16000u /* TIMER1 is 16 MHz */

#if defined(ROLE_RX)
static void sensor_send_event(uint64_t ev_tick, uint64_t off, uint16_t *ev_seq)
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
}
#endif

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

    uint32_t last = board_millis();
    uint8_t buf[32];

#if defined(ROLE_RX)
    /* ---------------- sensor ---------------- */
    uint64_t prev_l_rx = 0, cur_off = 0;
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
        capture_now64(); /* keep the wrap accounting current */

        int n = radio_receive(buf, sizeof(buf));
        if (n >= (int)sizeof(beacon_t)) {
            uint64_t l_rx = 0;
            capture_dio1_get(&l_rx);
            beacon_t *b = (beacon_t *)buf;
            if (b->type == PKT_TYPE_BEACON &&
                crc16_ccitt(buf, offsetof(beacon_t, crc)) == b->crc) {
                board_led_toggle();
                if (have_prev && prev_seq == (uint8_t)(b->seq - 1u)) {
                    cur_off = b->m_tx_prev + T_AIR_REF_TICKS - prev_l_rx;
                    have_off = 1;
                }
                prev_l_rx = l_rx; prev_seq = b->seq; have_prev = 1;
            }
        }

        uint64_t ev_tick;
        if (capture_sensor_get(&ev_tick) && have_off) {
            sensor_send_event(ev_tick, cur_off, &ev_seq);
        }

#if defined(SENSOR_SIM)
        static uint32_t sim_last;
        if (have_off && (uint32_t)(board_millis() - sim_last) >= 3000u) {
            sim_last = board_millis();
            sensor_send_event(capture_now64(), cur_off, &ev_seq);
        }
#endif
    }
#else
    /* ---------------- master / controller ---------------- */
    char line[80];
    lights_init();
    uint8_t seq = 0;
    uint64_t m_tx_last = 0;
    int in_cmd = 0;

    for (;;) {
        usb_task();

        /* Legacy controller commands from the PC. */
        int c;
        while ((c = usb_read_byte()) >= 0) {
            if (c == '$') { in_cmd = 1; continue; }
            if (!in_cmd) { continue; }
            in_cmd = 0;
            switch (c) {
            case 'G':
                lights_set(LIGHTS_GREEN);
                snprintf(line, sizeof(line), "$OK G %lu!\n",
                         (unsigned long)(uint32_t)(capture_now64() / TICKS_PER_MS));
                usb_write(line);
                break;
            case 'R': lights_set(LIGHTS_RED);   usb_write("$OK R!\n"); break;
            case 'X': lights_set(LIGHTS_OFF);   usb_write("$OK X!\n"); break;
            case 'H': usb_write("$HI!\n"); break; /* $HELLO */
            default:  usb_write("$E!\n");  break;
            }
        }

        if (st != 0) {
            continue; /* radio dead: still serve USB so a reflash works */
        }
        capture_now64(); /* keep the wrap accounting current */

        uint32_t now = board_millis();
        if ((uint32_t)(now - last) >= 1000u) {
            last = now;
            beacon_t b;
            b.type = PKT_TYPE_BEACON;
            b.set_id = SET_ID_A;
            b.seq = seq;
            b.m_tx_prev = m_tx_last;
            b.period_ms = 1000;
            b.crc = crc16_ccitt((uint8_t *)&b, offsetof(beacon_t, crc));
            radio_transmit((uint8_t *)&b, sizeof(b));
            uint64_t cap = 0;
            if (capture_dio1_get(&cap)) { m_tx_last = cap; }
            radio_start_rx();
            seq++;
            continue;
        }

        int n = radio_receive(buf, sizeof(buf));
        if (n >= (int)sizeof(event_t)) {
            event_t *e = (event_t *)buf;
            if (e->type == PKT_TYPE_EVENT &&
                crc16_ccitt(buf, offsetof(event_t, crc)) == e->crc) {
                snprintf(line, sizeof(line), "$S %u %lu!\n",
                         e->node_id,
                         (unsigned long)(uint32_t)(e->ev_master_t / TICKS_PER_MS));
                usb_write(line);
                snprintf(line, sizeof(line), "$T %u %lu!\n",
                         e->node_id, (unsigned long)(uint32_t)e->ev_master_t);
                usb_write(line);
            }
        }
    }
#endif
}
