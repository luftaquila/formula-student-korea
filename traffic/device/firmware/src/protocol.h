/* LoRa packet formats + time-sync helpers (DESIGN.md §2.5, §2.6).
 *
 * One master + up to 6 sensors, all on ONE channel sharing ONE timebase (the
 * master's 16 MHz TIMER1). node_id is the only node identity (0 = master,
 * 1..6 = sensors); the sensor->event mapping lives on the server, not here, so
 * packets carry no set_id. Timestamps are 64-bit 16 MHz ticks, software-extended
 * from the 32-bit counter so they never wrap during a run.
 */
#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <stdint.h>

#define PKT_TYPE_BEACON 0x01u
#define PKT_TYPE_EVENT  0x02u
#define PKT_TYPE_ACK    0x03u
#define PKT_TYPE_STATUS 0x04u

#define PROTO_VER   2u

/* node_id 0 = master, 1..6 = sensors. Per-node arrays are sized to MAX_NODES and
 * indexed directly by node_id, so node_id must satisfy 1 <= id < MAX_NODES. */
#define MAX_NODES   7u
#define NODE_MASTER 0u

/* Master -> all sensors (broadcast sync anchor). Carries the master TxDone tick
 * of the PREVIOUS beacon so a sensor can pair it with its own stored RxDone of
 * that beacon (§2.5), plus the TDMA parameters the sensors schedule STATUS by. */
typedef struct __attribute__((packed)) {
    uint8_t  type;       /* PKT_TYPE_BEACON */
    uint8_t  ver;        /* PROTO_VER */
    uint8_t  seq;        /* beacon sequence (wraps at 256) */
    uint64_t m_tx_prev;  /* master TxDone tick of beacon (seq-1) */
    uint16_t period_ms;  /* beacon/sync period (1000) */
    uint16_t slot_us;    /* TDMA status slot width in microseconds */
    uint16_t crc;        /* CRC16-CCITT over the preceding bytes */
} beacon_t;

/* Sensor -> master. ev_master_t = event tick already mapped to master time. */
typedef struct __attribute__((packed)) {
    uint8_t  type;       /* PKT_TYPE_EVENT */
    uint8_t  node_id;    /* 1..6 */
    uint16_t ev_seq;
    uint64_t ev_master_t;
    uint8_t  flags;
    uint16_t crc;
} event_t;

/* Master -> sensor: acknowledges a received EVENT so the sensor stops
 * retransmitting (DESIGN §2.8 reliable event delivery). */
typedef struct __attribute__((packed)) {
    uint8_t  type;     /* PKT_TYPE_ACK */
    uint8_t  node_id;  /* sensor being acked */
    uint16_t ev_seq;   /* event being acked */
    uint16_t crc;
} ack_t;

/* Sensor -> master: periodic diagnostics, transmitted in the node's TDMA slot
 * (DESIGN §2.10). offset/skew are the sensor's own sync health; the master adds
 * RSSI/SNR/last-seen/latency on its side. */
typedef struct __attribute__((packed)) {
    uint8_t  type;        /* PKT_TYPE_STATUS */
    uint8_t  node_id;     /* 1..6 */
    uint8_t  seq;         /* status sequence (uplink-loss detect) */
    int64_t  offset_tick; /* current master-time offset (master_t - local_t) */
    int32_t  skew_ppm;    /* clock drift estimate, signed ppm */
    uint16_t rx_miss;     /* beacons missed since boot (saturating) */
    uint16_t beacon_gap;  /* consecutive beacons missed right now */
    uint16_t batt_mv;     /* reserved (0 until VBAT ADC wired) */
    uint16_t crc;
} status_t;

/* CRC16-CCITT (poly 0x1021, init 0xFFFF). */
uint16_t crc16_ccitt(const uint8_t *data, uint32_t len);

#endif /* PROTOCOL_H */
