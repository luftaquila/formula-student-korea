/* Two-board LoRa timing node — single binary, role by chip ID (node_id.c).
 *
 * MASTER = the controller the PC connects to. Speaks the legacy FSK-TC serial
 * protocol transparently (VID/PID 0x1999/0x0514, "$...!", ms ticks): $G/$R/$X
 * drive the lights + ack $OK, $HELLO -> $HI, LoRa EVENTs -> "$S <sensor> <ms>!"
 * with a "$T <sensor> <16MHz tick>!" high-res companion. Beacons once per
 * second to keep the sensors synced.
 *
 * SENSOR = remote node: syncs to beacons, HW-captures a SENSOR edge, maps it to
 * master time, transmits an EVENT tagged with its node id. -DSENSOR_SIM fires a
 * synthetic event; -DNODE_DEBUG prints the chip id + resolved role.
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
#include "node_id.h"

#define TICKS_PER_MS 16000u /* TIMER1 is 16 MHz */

#if defined(NODE_DEBUG)
static void debug_id(const char *role)
{
    static uint32_t dl;
    if ((uint32_t)(board_millis() - dl) < 1000u) { return; }
    dl = board_millis();
    char l[56];
    snprintf(l, sizeof(l), "ID %08lX %08lX %s!\n",
             (unsigned long)node_devid_hi(), (unsigned long)node_devid_lo(), role);
    usb_write(l);
}
#endif

/* Send an EVENT reliably: listen-before-talk, then transmit and wait for the
 * master's ACK; retransmit (same ev_seq, so the master dedups) up to 4 times.
 * DESIGN §2.8 — the event time is preserved across retransmits, so a recovered
 * event is still accurate. */
static void sensor_send_event(uint64_t ev_tick, uint64_t off, uint8_t me, uint16_t *ev_seq)
{
    event_t e;
    e.type = PKT_TYPE_EVENT;
    e.set_id = node_set_id();
    e.node_id = me;
    e.ev_seq = (*ev_seq)++;
    e.ev_master_t = off + ev_tick;
    e.flags = 0;
    e.crc = crc16_ccitt((uint8_t *)&e, offsetof(event_t, crc));
    uint16_t this_seq = e.ev_seq;

    for (int attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0 || radio_channel_busy()) {
            board_delay_ms(5u + (this_seq & 7u)); /* backoff, jittered per event */
        }
        radio_transmit((uint8_t *)&e, sizeof(e));
        radio_start_rx();

        uint32_t t0 = board_millis();
        while ((uint32_t)(board_millis() - t0) < 60u) {
            uint8_t b[16];
            int n = radio_receive(b, sizeof(b));
            if (n >= (int)sizeof(ack_t)) {
                ack_t *a = (ack_t *)b;
                if (a->type == PKT_TYPE_ACK && a->node_id == me &&
                    a->ev_seq == this_seq &&
                    crc16_ccitt(b, offsetof(ack_t, crc)) == a->crc) {
                    return; /* acked */
                }
            }
        }
    }
    radio_start_rx(); /* gave up after retries */
}

static void run_sensor(int st)
{
    uint64_t prev_l_rx = 0, cur_off = 0;
    uint8_t prev_seq = 0, me = node_node_id();
    int have_prev = 0, have_off = 0;
    uint16_t ev_seq = 0;
    uint32_t last = board_millis();
    uint8_t buf[32];

    if (st == 0) { radio_start_rx(); }

    for (;;) {
        usb_task();
#if defined(NODE_DEBUG)
        debug_id("sensor");
#endif
        if (st != 0) {
            uint32_t now = board_millis();
            if ((uint32_t)(now - last) >= 1000u) { last = now; board_led_toggle(); }
            continue;
        }
        capture_now64();

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
            sensor_send_event(ev_tick, cur_off, me, &ev_seq);
        }
#if defined(SENSOR_SIM)
        static uint32_t sim_last;
        if (have_off && (uint32_t)(board_millis() - sim_last) >= 3000u) {
            sim_last = board_millis();
            sensor_send_event(capture_now64(), cur_off, me, &ev_seq);
        }
#endif
    }
}

static void run_master(int st)
{
    char line[80];
    lights_init();
    uint8_t seq = 0;
    uint64_t m_tx_last = 0;
    int in_cmd = 0;
    uint32_t last = board_millis();
    uint8_t buf[32];
    uint16_t last_seq[3] = {0, 0, 0}; /* per-node dedup (node 0..2) */
    int have_seq[3] = {0, 0, 0};

    for (;;) {
        usb_task();

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
            case 'H': usb_write("$HI!\n"); break;
            default:  usb_write("$E!\n");  break;
            }
        }
#if defined(NODE_DEBUG)
        debug_id("master");
#endif
        if (st != 0) { continue; }
        capture_now64();

        uint32_t now = board_millis();
        if ((uint32_t)(now - last) >= 1000u) {
            last = now;
            beacon_t b;
            b.type = PKT_TYPE_BEACON;
            b.set_id = node_set_id();
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
                uint8_t nd = (e->node_id <= 2) ? e->node_id : 0;
                /* Report only the first copy; retransmits share the ev_seq. */
                if (!(have_seq[nd] && last_seq[nd] == e->ev_seq)) {
                    have_seq[nd] = 1;
                    last_seq[nd] = e->ev_seq;
                    snprintf(line, sizeof(line), "$S %u %lu!\n",
                             e->node_id,
                             (unsigned long)(uint32_t)(e->ev_master_t / TICKS_PER_MS));
                    usb_write(line);
                    snprintf(line, sizeof(line), "$T %u %lu!\n",
                             e->node_id, (unsigned long)(uint32_t)e->ev_master_t);
                    usb_write(line);
                }
                /* ACK every copy so the sensor stops retransmitting. */
                ack_t a;
                a.type = PKT_TYPE_ACK;
                a.set_id = e->set_id;
                a.node_id = e->node_id;
                a.ev_seq = e->ev_seq;
                a.crc = crc16_ccitt((uint8_t *)&a, offsetof(ack_t, crc));
                radio_transmit((uint8_t *)&a, sizeof(a));
                radio_start_rx();
            }
        }
    }
}

int main(void)
{
    board_init();
    node_init();

    int st = radio_begin(node_freq_mhz());
    if (st == 0) {
        capture_init();
    }

    usb_init();

    if (node_role() == ROLE_MASTER) {
        run_master(st);
    } else {
        run_sensor(st);
    }
}
