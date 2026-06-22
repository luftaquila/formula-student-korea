/* One master + up to 6 sensors, single channel, single timebase — single
 * binary, role by chip ID (node_id.c).
 *
 * MASTER = the node the PC connects to over USB-CDC. Speaks the FSK-WL line
 * protocol (proto_usb.c): drives the traffic light on G/R/O, beacons once per
 * second to keep the sensors synced, reports sensor EVENTs ("E ...") and
 * per-sensor diagnostics ("D ...") and a 1 Hz heartbeat ("H ...").
 *
 * SENSOR = remote node: syncs to beacons (single-direction time sync), captures
 * a SENSOR edge in hardware, maps it to master time and transmits an EVENT
 * (reliable: CAD + ACK + retransmit). Periodically reports its sync health in a
 * node-keyed TDMA STATUS slot. -DSENSOR_SIM fires a synthetic event;
 * -DNODE_DEBUG prints the chip id + resolved role.
 */
#include <stdint.h>
#include <stddef.h>

#include "board.h"
#include "radio.h"
#include "usb.h"
#include "capture.h"
#include "protocol.h"
#include "proto_usb.h"
#include "config.h"
#include "lights.h"
#include "node_id.h"
#include "meas.h"
#include "secure.h"
#include "keystore.h"

#define TICKS_PER_MS 16000u /* TIMER1 is 16 MHz */
#define OFF_HIST     8u     /* offset ring depth for the skew estimate */

#if defined(NODE_DEBUG)
static void debug_id(const char *role)
{
    static uint32_t dl;
    if ((uint32_t)(board_millis() - dl) < 1000u) { return; }
    dl = board_millis();
    char l[40];
    /* hand-built (no %llX needed); 32-bit halves of the chip id. */
    static const char hex[] = "0123456789ABCDEF";
    char *p = l;
    *p++ = '#'; *p++ = ' ';
    uint32_t hi = node_devid_hi(), lo = node_devid_lo();
    for (int i = 7; i >= 0; i--) { *p++ = hex[(hi >> (i * 4)) & 0xF]; }
    for (int i = 7; i >= 0; i--) { *p++ = hex[(lo >> (i * 4)) & 0xF]; }
    *p++ = ' ';
    while (*role) { *p++ = *role++; }
    *p++ = '\n'; *p = '\0';
    usb_write(l);
}
#endif

/* Write the fleet key from a PU_CMD_SETKEY command to the flash keystore and
 * reload it live. Common to both roles — any board is provisioned by plugging it
 * into USB and sending `K <64-hex>`. Write-only: there is no read-back command,
 * so the key can't be exfiltrated over serial. */
static void provision_key(void)
{
    if (keystore_write(pu_setkey()) == 0) {
        sec_reload();
        pu_emit_ack("K");
    } else {
        pu_emit_err("keyfail");
    }
}

/* ===== sensor =========================================================== */

/* Send an EVENT reliably: listen-before-talk, transmit, wait for the master's
 * ACK; retransmit (same ev_seq, so the master dedups) up to 4 times. The event
 * time is preserved across retransmits (DESIGN §2.8). Backoff is keyed by node
 * so two sensors firing at once de-correlate. */
static void sensor_send_event(uint64_t ev_tick, uint64_t off, uint8_t me,
                              uint32_t master_boot_id, uint16_t *ev_seq)
{
    event_pl_t e;
    e.ev_seq = (*ev_seq)++;
    e.ev_master_t = off + ev_tick;
    e.master_boot_id = master_boot_id; /* binds the event to the current master session */
    e.flags = 0;
    uint16_t this_seq = e.ev_seq;

    for (int attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0 || radio_channel_busy()) {
            board_delay_ms(60u + (uint32_t)((this_seq * 7u + me * 11u) & 63u));
        }
        /* Re-seal each attempt: same ev_seq (master dedups), fresh ctr so every
         * retransmit is a distinct authenticated message the master's replay
         * window accepts (a verbatim resend would be dropped as a replay). */
        uint8_t tx[WIRE_EVENT];
        int wlen = sec_seal(tx, sizeof(tx), PKT_TYPE_EVENT, me, &e, sizeof(e));
        if (wlen < 0) { break; } /* tx counter exhausted (unreachable in a session) */
        radio_transmit(tx, wlen);
        radio_start_rx();

        uint32_t t0 = board_millis();
        while ((uint32_t)(board_millis() - t0) < 120u) {
            uint8_t b[WIRE_MAX];
            int n = radio_receive(b, sizeof(b));
            if (n >= WIRE_ACK && b[0] == PKT_TYPE_ACK) {
                sec_meta_t m;
                ack_pl_t a;
                if (sec_unseal(b, n, &m, &a, sizeof(a)) == 0 &&
                    m.node_id == NODE_MASTER &&
                    a.node_id == me && a.ev_seq == this_seq) {
                    return; /* acked */
                }
            }
        }
    }
    radio_start_rx(); /* gave up after retries */
}

/* Fire-and-forget diagnostics uplink in the node's TDMA slot. */
static void sensor_send_status(uint8_t me, uint8_t *sseq, uint64_t off, int32_t skew,
                               uint16_t rx_miss, uint16_t gap)
{
    status_pl_t s;
    s.seq = (*sseq)++;
    s.offset_tick = (int64_t)off;
    s.skew_ppm = skew;
    s.rx_miss = rx_miss;
    s.beacon_gap = gap;
    /* Cell estimate: VDDH (via SAADC VDDHDIV5) + the W5 diode drop. Sampled here,
     * right before TX, so VDDH reflects near-peak load. */
    s.batt_mv = (uint16_t)(meas_vddh_mv() + BATT_DIODE_DROP_MV);
    s.temp_c10 = meas_temp_c10();
    uint8_t tx[WIRE_STATUS];
    int wlen = sec_seal(tx, sizeof(tx), PKT_TYPE_STATUS, me, &s, sizeof(s));
    if (wlen < 0) { radio_start_rx(); return; } /* tx counter exhausted */
    if (radio_channel_busy()) { board_delay_ms(3u); }
    radio_transmit(tx, wlen);
    radio_start_rx();
}

static void run_sensor(int st)
{
    uint64_t prev_l_rx = 0, cur_off = 0;
    uint8_t prev_seq = 0, me = node_node_id();
    int have_prev = 0, have_off = 0;
    uint16_t ev_seq = 0;

    int64_t off_hist[OFF_HIST];
    uint64_t lrx_hist[OFF_HIST];
    unsigned hist_n = 0, hist_i = 0;
    int32_t cur_skew = 0;
    uint16_t rx_miss = 0, beacon_gap = 0;
    uint8_t status_seq = 0;
    int sent_status_frame = 0;
    uint8_t frame_seq = 0;

    uint32_t last_blink = board_millis();
    uint8_t buf[WIRE_MAX];
    sec_replay_t from_master = {0}; /* replay window for the master's beacons/acks */
    uint32_t master_boot_id = 0;    /* current master session, learned from beacons */

    if (st == 0) { radio_start_rx(); }

    for (;;) {
        usb_task();
        /* Serial provisioning works regardless of radio/role: plug the board in
         * and send `K <64-hex>` (also ?ID to identify it). */
        int uc;
        while ((uc = usb_read_byte()) >= 0) {
            switch (pu_feed(uc)) {
            case PU_CMD_SETKEY: provision_key(); break;
            case PU_CMD_ID: pu_emit_identity(node_devid_hi(), node_devid_lo()); pu_emit_ack("ID"); break;
            case PU_CMD_PING: pu_emit_ack("PING"); break;
            case PU_CMD_BAD: pu_emit_err("badcmd"); break;
            default: break;
            }
        }
#if defined(NODE_DEBUG)
        debug_id(me == 0xFFu ? "unprov" : "sensor");
#endif
        if (st != 0) {
            uint32_t now = board_millis();
            if ((uint32_t)(now - last_blink) >= 1000u) { last_blink = now; board_led_toggle(); }
            continue;
        }
        capture_now64();

        float rssi, snr;
        int n = radio_receive_q(buf, sizeof(buf), &rssi, &snr);
        if (n >= WIRE_BEACON && buf[0] == PKT_TYPE_BEACON) {
            uint64_t l_rx = 0;
            capture_dio1_get(&l_rx);
            sec_meta_t m;
            beacon_pl_t b;
            if (sec_unseal(buf, n, &m, &b, sizeof(b)) == 0 &&
                m.node_id == NODE_MASTER && b.ver == PROTO_VER &&
                sec_replay(&from_master, m.boot_id, m.ctr)) {
                board_led_toggle();
                master_boot_id = m.boot_id; /* track the session events bind to */
                if (have_prev) {
                    if (b.seq == (uint8_t)(prev_seq + 1u)) {
                        cur_off = b.m_tx_prev + T_AIR_REF_TICKS - prev_l_rx;
                        have_off = 1;
                        beacon_gap = 0;
                        off_hist[hist_i] = (int64_t)cur_off;
                        lrx_hist[hist_i] = prev_l_rx;
                        hist_i = (hist_i + 1u) % OFF_HIST;
                        if (hist_n < OFF_HIST) { hist_n++; }
                        if (hist_n >= 2u) {
                            unsigned newest = (hist_i + OFF_HIST - 1u) % OFF_HIST;
                            unsigned oldest = (hist_n < OFF_HIST) ? 0u : hist_i;
                            int64_t doff = off_hist[newest] - off_hist[oldest];
                            int64_t dl = (int64_t)(lrx_hist[newest] - lrx_hist[oldest]);
                            if (dl != 0) { cur_skew = (int32_t)((doff * 1000000) / dl); }
                        }
                    } else {
                        uint8_t miss = (uint8_t)(b.seq - prev_seq - 1u);
                        if ((uint16_t)(rx_miss + miss) >= rx_miss) { rx_miss += miss; }
                        beacon_gap = miss;
                    }
                }
                prev_l_rx = l_rx;
                prev_seq = b.seq;
                frame_seq = b.seq;
                have_prev = 1;
                sent_status_frame = 0;
            }
        }

        uint64_t ev_tick;
        if (capture_sensor_get(&ev_tick) && have_off && me < MAX_NODES) {
            sensor_send_event(ev_tick, cur_off, me, master_boot_id, &ev_seq);
        }

        /* TDMA STATUS: only on frames selected for this node, and only once we
         * reach this node's slot offset from the beacon RxDone. */
        if (have_off && have_prev && !sent_status_frame && me >= 1u && me < MAX_NODES &&
            (uint8_t)(frame_seq % STATUS_PERIOD_S) == (uint8_t)((me - 1u) % STATUS_PERIOD_S)) {
            uint32_t slot_off_ms = TDMA_BASE_MS + (uint32_t)(me - 1u) * SLOT_WIDTH_MS + STATUS_GUARD_MS;
            uint64_t status_tick = prev_l_rx + (uint64_t)slot_off_ms * TICKS_PER_MS;
            if (capture_now64() >= status_tick) {
                sensor_send_status(me, &status_seq, cur_off, cur_skew, rx_miss, beacon_gap);
                sent_status_frame = 1;
            }
        }

#if defined(SENSOR_SIM)
        static uint32_t sim_last;
        if (have_off && me < MAX_NODES && (uint32_t)(board_millis() - sim_last) >= 3000u) {
            sim_last = board_millis();
            sensor_send_event(capture_now64(), cur_off, me, master_boot_id, &ev_seq);
        }
#endif
    }
}

/* ===== master =========================================================== */

typedef struct {
    int      seen;
    uint16_t last_ev_seq;  int have_ev;
    uint8_t  last_status_seq; int have_status; uint16_t status_miss;
    uint32_t last_seen_ms;
    float    rssi, snr;
    int64_t  offset_tick;
    int32_t  skew_ppm;
    uint16_t rx_miss, beacon_gap;
    uint16_t batt_mv;
    int16_t  temp_c10;
    uint32_t last_lat_ms;
    int      last_state;
    sec_replay_t rx;   /* per-sensor replay window (EVENT + STATUS uplinks) */
} node_stat_t;

static node_stat_t g_node[MAX_NODES];

static int node_count_seen(void)
{
    int c = 0;
    for (unsigned i = 1; i < MAX_NODES; i++) { if (g_node[i].seen) { c++; } }
    return c;
}

static int link_state_of(uint32_t now, const node_stat_t *s)
{
    if (!s->seen) { return PU_STATE_LOST; }
    uint32_t age = now - s->last_seen_ms;
    if (age <= 2u * STATUS_PERIOD_S * 1000u) { return PU_STATE_OK; }
    if (age <= 15000u) { return PU_STATE_STALE; }
    return PU_STATE_LOST;
}

static void master_emit_diag(unsigned i, int state, uint32_t now)
{
    pu_emit_diag((uint8_t)i, state, g_node[i].offset_tick, g_node[i].skew_ppm,
                 g_node[i].rx_miss, g_node[i].beacon_gap,
                 (uint32_t)(now - g_node[i].last_seen_ms),
                 g_node[i].rssi, g_node[i].snr, g_node[i].last_lat_ms,
                 g_node[i].temp_c10, g_node[i].batt_mv);
}

static void run_master(int st)
{
    lights_init();
    for (unsigned i = 0; i < MAX_NODES; i++) { g_node[i].last_state = -1; }
    uint8_t seq = 0;
    uint64_t m_tx_last = 0;
    uint64_t green_tick = 0;
    uint32_t last = board_millis();
    uint8_t buf[WIRE_MAX];

    pu_emit_identity(node_devid_hi(), node_devid_lo());

    for (;;) {
        usb_task();

        int c;
        while ((c = usb_read_byte()) >= 0) {
            switch (pu_feed(c)) {
            case PU_CMD_GREEN:
                lights_set(LIGHTS_GREEN);
                green_tick = (st == 0) ? capture_now64() : 0;
                pu_emit_light(PU_LIGHT_GREEN, green_tick);
                pu_emit_ack("G");
                break;
            case PU_CMD_RED:
                lights_set(LIGHTS_RED);
                pu_emit_light(PU_LIGHT_RED, 0);
                pu_emit_ack("R");
                break;
            case PU_CMD_OFF:
                lights_set(LIGHTS_OFF);
                pu_emit_light(PU_LIGHT_OFF, 0);
                pu_emit_ack("O");
                break;
            case PU_CMD_ID:
                pu_emit_identity(node_devid_hi(), node_devid_lo());
                pu_emit_ack("ID");
                break;
            case PU_CMD_STATUS: {
                uint32_t now = board_millis();
                pu_emit_heartbeat((st == 0) ? capture_now64() : 0, now, seq, node_count_seen());
                for (unsigned i = 1; i < MAX_NODES; i++) {
                    if (g_node[i].seen) { master_emit_diag(i, link_state_of(now, &g_node[i]), now); }
                }
                pu_emit_ack("STATUS");
                break;
            }
            case PU_CMD_PING:
                pu_emit_ack("PING");
                break;
            case PU_CMD_SETKEY:
                provision_key();
                break;
            case PU_CMD_BAD:
                pu_emit_err("badcmd");
                break;
            default:
                break;
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
            /* No key yet → sec_seal refuses, so no beacon goes out; tell the PC. */
            if (!sec_provisioned() && (seq % 5u) == 0u) { pu_emit_err("noprov"); }
            beacon_pl_t b;
            b.ver = PROTO_VER;
            b.seq = seq;
            b.m_tx_prev = m_tx_last;
            b.period_ms = 1000;
            b.slot_ms = SLOT_WIDTH_MS;
            uint8_t tx[WIRE_BEACON];
            int wlen = sec_seal(tx, sizeof(tx), PKT_TYPE_BEACON, NODE_MASTER, &b, sizeof(b));
            if (wlen > 0) {
                radio_transmit(tx, wlen);
                uint64_t cap = 0;
                if (capture_dio1_get(&cap)) { m_tx_last = cap; }
            }
            radio_start_rx();

            pu_emit_heartbeat(capture_now64(), now, seq, node_count_seen());
            seq++;

            for (unsigned i = 1; i < MAX_NODES; i++) {
                if (!g_node[i].seen) { continue; }
                int ls = link_state_of(now, &g_node[i]);
                if (ls != g_node[i].last_state) {
                    g_node[i].last_state = ls;
                    master_emit_diag(i, ls, now);
                }
            }

            /* Master self-diag (node 0) every STATUS_PERIOD_S beacons: its own die
             * temp + charge-rail voltage. last_seen=0 (just measured); LoRa-only
             * fields are 0 since they don't apply to the master itself. */
            if ((uint8_t)(seq % STATUS_PERIOD_S) == 0u) {
                pu_emit_diag(0, PU_STATE_OK, 0, 0, 0, 0, 0, 0.0f, 0.0f, 0,
                             meas_temp_c10(), meas_vddh_mv());
            }
            continue;
        }

        float rssi = 0, snr = 0;
        int n = radio_receive_q(buf, sizeof(buf), &rssi, &snr);
        if (n <= 0) { continue; }
        uint8_t type = buf[0];
        uint8_t sender = buf[1]; /* sec_hdr.node_id (authenticated below) */
        if (sender < 1u || sender >= MAX_NODES) { continue; }

        if (type == PKT_TYPE_EVENT && n >= WIRE_EVENT) {
            sec_meta_t m;
            event_pl_t e;
            if (sec_unseal(buf, n, &m, &e, sizeof(e)) != 0) { continue; }
            /* Session binding: the event must name THIS master's current boot_id.
             * An event captured under a previous master power-cycle names the old
             * session and is dropped — closing cross-reboot EVENT replay
             * (DESIGN §2.11). A sensor learns the current id from live beacons, so
             * after a master swap its events re-bind as soon as it re-syncs. */
            if (e.master_boot_id != sec_boot_id()) { continue; }
            if (!sec_replay(&g_node[m.node_id].rx, m.boot_id, m.ctr)) { continue; }
            /* Freshness backstop: reject a timestamp too far in the past (stale
             * replay) or implausibly in the future. Asymmetric — a real event is
             * at most a few ms ahead of master time (sync error). dt = now - ev. */
            uint64_t now_t = capture_now64();
            int64_t dt = (int64_t)now_t - (int64_t)e.ev_master_t;
            if (dt > (int64_t)EVENT_FRESH_MS * (int64_t)TICKS_PER_MS ||
                dt < -((int64_t)EVENT_FUTURE_MS * (int64_t)TICKS_PER_MS)) { continue; }
            node_stat_t *ns = &g_node[m.node_id];
            ns->seen = 1;
            ns->rssi = rssi;
            ns->snr = snr;
            ns->last_seen_ms = board_millis();
            ns->last_lat_ms = (uint32_t)((dt < 0 ? 0 : dt) / TICKS_PER_MS);
            /* Report only the first copy; retransmits share the ev_seq. */
            if (!(ns->have_ev && ns->last_ev_seq == e.ev_seq)) {
                ns->have_ev = 1;
                ns->last_ev_seq = e.ev_seq;
                pu_emit_event(m.node_id, e.ev_seq, e.ev_master_t, e.flags, rssi, snr);
            }
            /* ACK every copy so the sensor stops retransmitting. */
            ack_pl_t a;
            a.node_id = m.node_id;
            a.ev_seq = e.ev_seq;
            uint8_t tx[WIRE_ACK];
            int wlen = sec_seal(tx, sizeof(tx), PKT_TYPE_ACK, NODE_MASTER, &a, sizeof(a));
            if (wlen > 0) { radio_transmit(tx, wlen); }
            radio_start_rx();
        } else if (type == PKT_TYPE_STATUS && n >= WIRE_STATUS) {
            sec_meta_t m;
            status_pl_t s;
            if (sec_unseal(buf, n, &m, &s, sizeof(s)) != 0) { continue; }
            if (!sec_replay(&g_node[m.node_id].rx, m.boot_id, m.ctr)) { continue; }
            node_stat_t *ns = &g_node[m.node_id];
            if (ns->have_status) {
                uint8_t d = (uint8_t)(s.seq - ns->last_status_seq);
                if (d > 1u) { ns->status_miss += (uint16_t)(d - 1u); }
            }
            ns->have_status = 1;
            ns->last_status_seq = s.seq;
            ns->seen = 1;
            ns->rssi = rssi;
            ns->snr = snr;
            ns->last_seen_ms = board_millis();
            ns->offset_tick = s.offset_tick;
            ns->skew_ppm = s.skew_ppm;
            ns->rx_miss = s.rx_miss;
            ns->beacon_gap = s.beacon_gap;
            ns->batt_mv = s.batt_mv;
            ns->temp_c10 = s.temp_c10;
            int ls = link_state_of(board_millis(), ns);
            ns->last_state = ls;
            master_emit_diag(m.node_id, ls, board_millis());
        }
    }
}

int main(void)
{
    board_init();
    node_init();
    sec_init(); /* seed boot_id (RNG) + reset tx counter before any sealed TX */

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
