/* Secured LoRa packet formats + time-sync helpers (DESIGN.md §2.5, §2.6, §2.11).
 *
 * One master + up to 6 sensors, single channel, single timebase (the master's
 * 16 MHz TIMER1). node_id is the SENDER's own identity = the low 32 bits of its
 * chip id (FICR.DEVICEID); the master is the reserved id 0. Nothing is hardcoded
 * and there is no slot/number: a sensor transmits under its own id and the master
 * auto-registers it on first contact, reporting that id over USB. The
 * sensor->event mapping lives on the server, so packets carry no set_id.
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

#define PKT_TYPE_BEACON   0x01u
#define PKT_TYPE_EVENT    0x02u
#define PKT_TYPE_ACK      0x03u
#define PKT_TYPE_STATUS   0x04u

#define PROTO_VER   5u  /* 5: chip-id identity + hashed-phase STATUS (was 4: fixed node_id) */

/* node_id is a 32-bit identity: the master is the reserved id 0 (NODE_MASTER), a
 * sensor is the low 32 bits of its own chip id (never 0 — see node_sender_id()).
 * The master tracks sensors in a small registry (MAX_NODES entries) keyed by id,
 * auto-registering on first contact; entries are a set, not indexed by id. */
#define MAX_NODES   7u  /* max sensors tracked at once (registry capacity) */
#define NODE_MASTER 0u

/* Cleartext security header — prepended to every packet, authenticated as AEAD
 * associated data and used to build the per-message nonce (secure.c). Kept in
 * the clear so a receiver can route + replay-check before spending a decrypt. */
typedef struct __attribute__((packed)) {
    uint8_t  type;     /* PKT_TYPE_* */
    uint32_t node_id;  /* SENDER id (0 = master, else sensor's low-32 chip id) */
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
    uint16_t status_period_ms; /* STATUS cycle the sensors hash their phase into (§2.8) */
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
 * acked sensor is named here in the payload by its 32-bit id. */
typedef struct __attribute__((packed)) {
    uint32_t node_id;  /* sensor being acked (its low-32 chip id) */
    uint16_t ev_seq;   /* event being acked */
} ack_pl_t;

/* Sensor -> master: periodic diagnostics (DESIGN §2.10), sent once per STATUS
 * cycle at a chip-id-hashed phase within the synced cycle (collision-resistant
 * without coordination, §2.8). offset/skew are the sensor's own sync health; the
 * master adds RSSI/SNR/last-seen/latency on its side. */
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

#define SEC_HDR_LEN   ((int)sizeof(sec_hdr_t)) /* 13 (type 1 + node_id 4 + boot_id 4 + ctr 4) */
#define SEC_MAC_LEN   16                       /* Poly1305 tag */
#define SEC_OVERHEAD  (SEC_HDR_LEN + SEC_MAC_LEN)

/* Sealed wire length for a given plaintext payload length. */
#define SEC_WIRE_LEN(pl) (SEC_OVERHEAD + (int)(pl))

#define WIRE_BEACON   SEC_WIRE_LEN(sizeof(beacon_pl_t))   /* 43 */
#define WIRE_EVENT    SEC_WIRE_LEN(sizeof(event_pl_t))    /* 44 */
#define WIRE_ACK      SEC_WIRE_LEN(sizeof(ack_pl_t))      /* 35 */
#define WIRE_STATUS   SEC_WIRE_LEN(sizeof(status_pl_t))   /* 50 */
#define WIRE_MAX      64 /* RX buffer size; largest sealed packet is WIRE_STATUS */

#endif /* PROTOCOL_H */
