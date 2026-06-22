/* Secured LoRa packet formats + time-sync helpers (DESIGN.md §2.5, §2.6, §2.11).
 *
 * One master + up to 6 sensors, single channel, single timebase (the master's
 * 16 MHz TIMER1). node_id is the only node identity (0 = master, 1..6 sensors);
 * the sensor->event mapping lives on the server, so packets carry no set_id.
 *
 * SECURITY (DESIGN §2.11): every air packet is sealed with XChaCha20-Poly1305
 * (Monocypher) under a fleet-wide pre-shared key. Wire layout is
 *
 *     [ sec_hdr_t (cleartext, authenticated) | ciphertext(payload) | mac(16) ]
 *
 * The cleartext header carries the sender id + the anti-replay counters and is
 * fed to the AEAD as associated data (so it cannot be tampered). The payload
 * struct (timestamps, offsets, ...) is encrypted. The 16-byte Poly1305 tag
 * replaces the old CRC16 — it detects both bit errors and forgery. See secure.h.
 */
#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <stdint.h>

#define PKT_TYPE_BEACON 0x01u
#define PKT_TYPE_EVENT  0x02u
#define PKT_TYPE_ACK    0x03u
#define PKT_TYPE_STATUS 0x04u

#define PROTO_VER   4u  /* 4: AEAD-secured air protocol (was 3: plaintext + CRC16) */

/* node_id 0 = master, 1..6 = sensors. Per-node arrays are sized to MAX_NODES and
 * indexed directly by node_id, so node_id must satisfy 1 <= id < MAX_NODES. */
#define MAX_NODES   7u
#define NODE_MASTER 0u

/* Cleartext security header — prepended to every packet, authenticated as AEAD
 * associated data and used to build the per-message nonce (secure.c). Kept in
 * the clear so a receiver can route + replay-check before spending a decrypt. */
typedef struct __attribute__((packed)) {
    uint8_t  type;     /* PKT_TYPE_* */
    uint8_t  node_id;  /* SENDER node_id (0 = master, 1..6 = sensors) */
    uint32_t boot_id;  /* sender's per-boot random id — replay re-baseline anchor */
    uint32_t ctr;      /* sender's monotonic per-boot tx counter — nonce + replay */
} sec_hdr_t;

/* ---- Encrypted payloads (plaintext form, before sealing) ----------------- */

/* Master -> all sensors (broadcast sync anchor). Carries the master TxDone tick
 * of the PREVIOUS beacon so a sensor can pair it with its own stored RxDone of
 * that beacon (§2.5), plus the TDMA parameters the sensors schedule STATUS by. */
typedef struct __attribute__((packed)) {
    uint8_t  ver;        /* PROTO_VER */
    uint8_t  seq;        /* beacon sequence (wraps at 256) */
    uint64_t m_tx_prev;  /* master TxDone tick of beacon (seq-1) */
    uint16_t period_ms;  /* beacon/sync period (1000) */
    uint16_t slot_us;    /* TDMA status slot width in microseconds */
} beacon_pl_t;

/* Sensor -> master. ev_master_t = event tick already mapped to master time.
 * master_boot_id = boot_id of the master session this event is synced to (from
 * the beacons the sensor is tracking). The master rejects events that don't name
 * its current session, so an event captured under a previous master power-cycle
 * cannot be replayed after the master reboots (DESIGN §2.11). */
typedef struct __attribute__((packed)) {
    uint16_t ev_seq;
    uint64_t ev_master_t;
    uint32_t master_boot_id;
    uint8_t  flags;
} event_pl_t;

/* Master -> sensor: acknowledges a received EVENT so the sensor stops
 * retransmitting (DESIGN §2.8). The sec_hdr node_id is the master (0); the
 * acked sensor is named here in the payload. */
typedef struct __attribute__((packed)) {
    uint8_t  node_id;  /* sensor being acked (1..6) */
    uint16_t ev_seq;   /* event being acked */
} ack_pl_t;

/* Sensor -> master: periodic diagnostics, transmitted in the node's TDMA slot
 * (DESIGN §2.10). offset/skew are the sensor's own sync health; the master adds
 * RSSI/SNR/last-seen/latency on its side. */
typedef struct __attribute__((packed)) {
    uint8_t  seq;         /* status sequence (uplink-loss detect) */
    int64_t  offset_tick; /* current master-time offset (master_t - local_t) */
    int32_t  skew_ppm;    /* clock drift estimate, signed ppm */
    uint16_t rx_miss;     /* beacons missed since boot (saturating) */
    uint16_t beacon_gap;  /* consecutive beacons missed right now */
    uint16_t batt_mv;     /* cell estimate (VDDH via SAADC VDDHDIV5 + diode drop) */
    int16_t  temp_c10;    /* nRF die temperature, deci-degrees C (235 = 23.5 C) */
} status_pl_t;

/* ---- Wire sizes ---------------------------------------------------------- */

#define SEC_HDR_LEN   ((int)sizeof(sec_hdr_t)) /* 10 */
#define SEC_MAC_LEN   16                       /* Poly1305 tag */
#define SEC_OVERHEAD  (SEC_HDR_LEN + SEC_MAC_LEN)

/* Sealed wire length for a given plaintext payload length. */
#define SEC_WIRE_LEN(pl) (SEC_OVERHEAD + (int)(pl))

#define WIRE_BEACON SEC_WIRE_LEN(sizeof(beacon_pl_t)) /* 40 */
#define WIRE_EVENT  SEC_WIRE_LEN(sizeof(event_pl_t))  /* 41 */
#define WIRE_ACK    SEC_WIRE_LEN(sizeof(ack_pl_t))    /* 29 */
#define WIRE_STATUS SEC_WIRE_LEN(sizeof(status_pl_t)) /* 47 */
#define WIRE_MAX    64 /* RX buffer size; largest sealed packet is WIRE_STATUS */

#endif /* PROTOCOL_H */
