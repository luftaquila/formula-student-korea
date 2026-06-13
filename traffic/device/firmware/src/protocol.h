/* LoRa packet formats + time-sync helpers (DESIGN.md §2.5, §2.6).
 *
 * Timestamps are 16 MHz TIMER1 ticks. DESIGN specifies 64-bit fields with a
 * software 32->64 extension; bring-up uses the raw 32-bit tick (wraps ~268 s),
 * which is fine for the per-beacon offset math (done mod 2^32). 64-bit
 * extension is a later step.
 */
#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <stdint.h>

#define PKT_TYPE_BEACON 0x01u
#define PKT_TYPE_EVENT  0x02u

#define SET_ID_A    0u
#define NODE_MASTER 0u
#define NODE_SENSOR 1u

/* Master -> sensors. Carries the master TxDone tick of the PREVIOUS beacon so a
 * sensor can pair it with its own stored RxDone of that beacon (§2.5). */
typedef struct __attribute__((packed)) {
    uint8_t  type;       /* PKT_TYPE_BEACON */
    uint8_t  set_id;
    uint8_t  seq;        /* beacon sequence (wraps at 256) */
    uint32_t m_tx_prev;  /* master TxDone tick of beacon (seq-1) */
    uint16_t period_ms;
    uint16_t crc;        /* CRC16-CCITT over the preceding bytes */
} beacon_t;

/* Sensor -> master. ev_master_t = event tick already mapped to master time. */
typedef struct __attribute__((packed)) {
    uint8_t  type;       /* PKT_TYPE_EVENT */
    uint8_t  set_id;
    uint8_t  node_id;
    uint16_t ev_seq;
    uint32_t ev_master_t;
    uint8_t  flags;
    uint16_t crc;
} event_t;

/* CRC16-CCITT (poly 0x1021, init 0xFFFF). */
uint16_t crc16_ccitt(const uint8_t *data, uint32_t len);

#endif /* PROTOCOL_H */
