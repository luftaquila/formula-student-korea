/* One master + up to 6 sensors, single channel, single timebase — single
 * binary, role decided at runtime from USB (DESIGN §8).
 *
 * MASTER = the node a PC enumerates over USB-CDC. Speaks the FSK-WL line
 * protocol (proto_usb.c): drives the traffic light on G/R/O, beacons once per
 * second to keep the sensors synced, hands out slots to joining sensors, reports
 * sensor EVENTs ("E ...") and per-sensor diagnostics ("D ...") keyed by chip id,
 * and a 1 Hz heartbeat ("H ...").
 *
 * SENSOR = remote node (no PC host): JOINs the master to get a compact on-air
 * slot (DESIGN §2.3), syncs to beacons (single-direction time sync), captures a
 * SENSOR edge in hardware, maps it to master time and transmits an EVENT
 * (reliable: CAD + ACK + retransmit). Periodically reports its sync health in a
 * slot-keyed TDMA STATUS slot. -DSENSOR_SIM fires a synthetic event;
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
#include "nrf.h" /* NVIC_SystemReset for the live role re-check */

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

/* ===== role by USB ====================================================== */

/* Pump the USB stack up to ROLE_SETTLE_MS for a PC to enumerate us. Returns 1
 * (master) as soon as a host is present, else 0 (sensor) when the window closes. */
static int role_decide_master(void)
{
    uint32_t t0 = board_millis();
    for (;;) {
        usb_task();
        if (usb_host_present()) { return 1; }
        if ((uint32_t)(board_millis() - t0) >= ROLE_SETTLE_MS) { return 0; }
    }
}

/* Live role re-check (called every main-loop iteration; the caller pumps
 * usb_task). Returns 1 when USB host presence has disagreed with the current
 * role for ROLE_RECHECK_MS straight — debounced so a brief glitch doesn't reset
 * us — meaning we should NVIC_SystemReset and re-pick the role. */
static int role_should_reset(int am_master)
{
    static int disagreeing = 0;
    static uint32_t since = 0;
    int disagree = am_master ? !usb_host_present() : usb_host_present();
    if (!disagree) { disagreeing = 0; return 0; }
    uint32_t now = board_millis();
    if (!disagreeing) { disagreeing = 1; since = now; return 0; }
    return (uint32_t)(now - since) >= ROLE_RECHECK_MS;
}

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
 * time is preserved across retransmits (DESIGN §2.8). Backoff is keyed by our id
 * so two sensors firing at once de-correlate. */
static void sensor_send_event(uint64_t ev_tick, uint64_t off, uint32_t id,
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
            board_delay_ms(60u + (uint32_t)((this_seq * 7u + id * 11u) & 63u));
        }
        /* Re-seal each attempt: same ev_seq (master dedups), fresh ctr so every
         * retransmit is a distinct authenticated message the master's replay
         * window accepts (a verbatim resend would be dropped as a replay). */
        uint8_t tx[WIRE_EVENT];
        int wlen = sec_seal(tx, sizeof(tx), PKT_TYPE_EVENT, id, &e, sizeof(e));
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
                    a.node_id == id && a.ev_seq == this_seq) {
                    return; /* acked */
                }
            }
        }
    }
    radio_start_rx(); /* gave up after retries */
}

/* Fire-and-forget diagnostics uplink. A CAD just before TX (radio_channel_busy)
 * turns a near-overlap with another sensor's STATUS into a short deferral rather
 * than a collision (DESIGN §2.8). */
static void sensor_send_status(uint32_t id, uint8_t *sseq, uint64_t off, int32_t skew,
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
    int wlen = sec_seal(tx, sizeof(tx), PKT_TYPE_STATUS, id, &s, sizeof(s));
    if (wlen < 0) { radio_start_rx(); return; } /* tx counter exhausted */
    /* If a peer is mid-transmission, back off a short id-derived jitter (so the
     * two colliders de-correlate) and let this cycle's slot pass — STATUS is
     * loss-tolerant and the next cycle re-hashes to a fresh phase. */
    if (radio_channel_busy()) { board_delay_ms(3u + (uint32_t)(id & 7u)); radio_start_rx(); return; }
    radio_transmit(tx, wlen);
    radio_start_rx();
}

/* Cheap 32-bit mix for the STATUS phase: spreads (id, cycle) across the synced
 * cycle so sensors rarely overlap, and re-randomises every cycle so any overlap
 * is transient rather than a permanent pairing (DESIGN §2.8). */
static uint32_t hash32(uint32_t a, uint32_t b)
{
    uint32_t h = a * 2654435761u + b * 2246822519u;
    h ^= h >> 15; h *= 2246822519u; h ^= h >> 13;
    return h;
}

static void run_sensor(int st)
{
    uint64_t prev_l_rx = 0, cur_off = 0;
    uint8_t prev_seq = 0;
    const uint32_t my_id = node_sender_id(); /* our 32-bit on-air identity (chip id low word) */
    int have_prev = 0, have_off = 0;
    uint16_t ev_seq = 0;

    int64_t off_hist[OFF_HIST];
    uint64_t lrx_hist[OFF_HIST];
    unsigned hist_n = 0, hist_i = 0;
    int32_t cur_skew = 0;
    uint16_t rx_miss = 0, beacon_gap = 0;
    uint8_t status_seq = 0;
    uint32_t last_status_cycle = 0xFFFFFFFFu; /* STATUS cycle we last transmitted in */

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
        /* A PC enumerated us → we should be the master, not a sensor: reset to
         * re-pick the role (debounced in role_should_reset). */
        if (role_should_reset(0)) { NVIC_SystemReset(); }
#if defined(NODE_DEBUG)
        debug_id("sensor");
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
                master_boot_id = m.boot_id; /* track the session our events bind to */
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
                have_prev = 1;
            }
        }

        uint64_t ev_tick;
        if (capture_sensor_get(&ev_tick) && have_off) {
            sensor_send_event(ev_tick, cur_off, my_id, master_boot_id, &ev_seq);
        }

        /* STATUS: once per synced STATUS cycle, at a phase hashed from (our id,
         * cycle) within that cycle. Since the sensors share master time the phases
         * land in a common window and rarely overlap; a fresh hash each cycle keeps
         * any overlap transient, and the CAD in sensor_send_status defers a near
         * collision (DESIGN §2.8). master_ms is our local clock mapped to master
         * time, exactly as EVENT timestamps are. */
        if (have_off) {
            uint64_t master_ms = (cur_off + capture_now64()) / TICKS_PER_MS;
            uint32_t cycle = (uint32_t)(master_ms / STATUS_PERIOD_MS);
            if (cycle != last_status_cycle) {
                uint32_t phase = hash32(my_id, cycle) % (STATUS_PERIOD_MS - STATUS_TX_MARGIN_MS);
                if (master_ms >= (uint64_t)cycle * STATUS_PERIOD_MS + phase) {
                    sensor_send_status(my_id, &status_seq, cur_off, cur_skew, rx_miss, beacon_gap);
                    last_status_cycle = cycle;
                }
            }
        }

#if defined(SENSOR_SIM)
        static uint32_t sim_last;
        if (have_off && (uint32_t)(board_millis() - sim_last) >= 3000u) {
            sim_last = board_millis();
            sensor_send_event(capture_now64(), cur_off, my_id, master_boot_id, &ev_seq);
        }
#endif
    }
}

/* ===== master =========================================================== */

typedef struct {
    int      used;         /* registry entry in use */
    uint32_t id;           /* the sensor's 32-bit id (low word of its chip id) */
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
    uint32_t sec_drop; /* authenticated-but-rejected packets from this sensor
                        * (replay / freshness / session-binding) — observability */
} node_stat_t;

static node_stat_t g_node[MAX_NODES];

/* Master-side AEAD verification failures (forgery / wrong key / corruption).
 * Unattributable (the node_id in a failed packet isn't authenticated), so it's a
 * single global counter, surfaced on the node-0 self-report D line. */
static uint32_t g_auth_drop;

static int node_count_seen(void)
{
    int c = 0;
    for (unsigned i = 0; i < MAX_NODES; i++) { if (g_node[i].used && g_node[i].seen) { c++; } }
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

/* Find this sender's registry entry, or claim one for it (auto-registration):
 * an unused entry, else one whose sensor has gone LOST. Returns NULL if all
 * MAX_NODES entries are live sensors. An entry claimed for a NEW id is wiped so
 * the newcomer isn't rejected by the previous occupant's replay window. */
static node_stat_t *node_find_or_add(uint32_t id)
{
    for (unsigned i = 0; i < MAX_NODES; i++) {
        if (g_node[i].used && g_node[i].id == id) { return &g_node[i]; }
    }
    int slot = -1;
    for (unsigned i = 0; i < MAX_NODES; i++) { if (!g_node[i].used) { slot = (int)i; break; } }
    if (slot < 0) {
        uint32_t now = board_millis();
        for (unsigned i = 0; i < MAX_NODES; i++) {
            if (link_state_of(now, &g_node[i]) == PU_STATE_LOST) { slot = (int)i; break; }
        }
    }
    if (slot < 0) { return NULL; } /* registry full of live sensors */
    node_stat_t fresh = {0};
    fresh.last_state = -1;
    fresh.used = 1;
    fresh.id = id;
    g_node[slot] = fresh;
    return &g_node[slot];
}

static void master_emit_diag(const node_stat_t *s, int state, uint32_t now)
{
    pu_emit_diag(s->id, 0,
                 state, s->offset_tick, s->skew_ppm,
                 s->rx_miss, s->beacon_gap,
                 (uint32_t)(now - s->last_seen_ms),
                 s->rssi, s->snr, s->last_lat_ms,
                 s->temp_c10, s->batt_mv,
                 s->sec_drop, sec_provisioned());
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
                for (unsigned i = 0; i < MAX_NODES; i++) {
                    if (g_node[i].used && g_node[i].seen) { master_emit_diag(&g_node[i], link_state_of(now, &g_node[i]), now); }
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
        /* The PC host went away (cable pulled / PC off) → a master makes no sense:
         * reset to re-pick the role (debounced). */
        if (role_should_reset(1)) { NVIC_SystemReset(); }
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
            b.status_period_ms = STATUS_PERIOD_MS;
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

            for (unsigned i = 0; i < MAX_NODES; i++) {
                if (!g_node[i].used || !g_node[i].seen) { continue; }
                int ls = link_state_of(now, &g_node[i]);
                if (ls != g_node[i].last_state) {
                    g_node[i].last_state = ls;
                    master_emit_diag(&g_node[i], ls, now);
                }
            }

            /* Master self-diag (node 0) every STATUS_PERIOD_S beacons: its own die
             * temp + charge-rail voltage. last_seen=0 (just measured); LoRa-only
             * fields are 0 since they don't apply to the master itself. The
             * sec_drop slot carries the global AEAD-failure count, and the
             * provisioned flag rides here so the server sees both. */
            if ((uint8_t)(seq % STATUS_PERIOD_S) == 0u) {
                pu_emit_diag(0, 1, PU_STATE_OK, 0, 0, 0, 0, 0, 0.0f, 0.0f, 0,
                             meas_temp_c10(), meas_vddh_mv(),
                             g_auth_drop, sec_provisioned());
            }
            continue;
        }

        float rssi = 0, snr = 0;
        int n = radio_receive_q(buf, sizeof(buf), &rssi, &snr);
        if (n <= 0) { continue; }
        uint8_t type = buf[0];

        if (type == PKT_TYPE_EVENT && n >= WIRE_EVENT) {
            sec_meta_t m;
            event_pl_t e;
            if (sec_unseal(buf, n, &m, &e, sizeof(e)) != 0) { g_auth_drop++; continue; }
            /* Identify (auto-register) the sender by its id, then validate. */
            node_stat_t *ns = node_find_or_add(m.node_id);
            if (!ns) { continue; } /* registry full of live sensors */
            /* Session binding: the event must name THIS master's current boot_id.
             * An event captured under a previous master power-cycle names the old
             * session and is dropped — closing cross-reboot EVENT replay
             * (DESIGN §2.11). A sensor learns the current id from live beacons, so
             * after a master swap its events re-bind as soon as it re-syncs. */
            if (e.master_boot_id != sec_boot_id()) { ns->sec_drop++; continue; }
            if (!sec_replay(&ns->rx, m.boot_id, m.ctr)) { ns->sec_drop++; continue; }
            /* Freshness backstop: reject a timestamp too far in the past (stale
             * replay) or implausibly in the future. Asymmetric — a real event is
             * at most a few ms ahead of master time (sync error). dt = now - ev. */
            uint64_t now_t = capture_now64();
            int64_t dt = (int64_t)now_t - (int64_t)e.ev_master_t;
            if (dt > (int64_t)EVENT_FRESH_MS * (int64_t)TICKS_PER_MS ||
                dt < -((int64_t)EVENT_FUTURE_MS * (int64_t)TICKS_PER_MS)) {
                ns->sec_drop++; continue;
            }
            ns->seen = 1;
            ns->rssi = rssi;
            ns->snr = snr;
            ns->last_seen_ms = board_millis();
            ns->last_lat_ms = (uint32_t)((dt < 0 ? 0 : dt) / TICKS_PER_MS);
            /* Report only the first copy; retransmits share the ev_seq. */
            if (!(ns->have_ev && ns->last_ev_seq == e.ev_seq)) {
                ns->have_ev = 1;
                ns->last_ev_seq = e.ev_seq;
                pu_emit_event(ns->id, e.ev_seq, e.ev_master_t, e.flags, rssi, snr);
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
            if (sec_unseal(buf, n, &m, &s, sizeof(s)) != 0) { g_auth_drop++; continue; }
            node_stat_t *ns = node_find_or_add(m.node_id);
            if (!ns) { continue; } /* registry full of live sensors */
            if (!sec_replay(&ns->rx, m.boot_id, m.ctr)) { ns->sec_drop++; continue; }
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
            master_emit_diag(ns, ls, board_millis());
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

    /* Role by USB (DESIGN §8): master if a PC host enumerates us within the
     * settle window, else sensor. Re-checked live inside each loop, which resets
     * the MCU to re-pick if USB presence later contradicts the choice. */
    if (role_decide_master()) {
        run_master(st);
    } else {
        run_sensor(st);
    }
}
