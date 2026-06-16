/* Master <-> PC USB-CDC line protocol (DESIGN §8). Newline-delimited ASCII,
 * one record per line, first token is a single-letter type. Replaces the legacy
 * FSK-TC "$...!" framing. All formatting is dependency-free (no float / long-long
 * printf, which newlib-nano omits) so 64-bit ticks survive intact.
 *
 *   Master -> PC:
 *     I FSK-WL <fw> <devid16hex> <chan> <sf> <bw> <ticks_per_ms>
 *     H <now_tick> <uptime_ms> <beacon_seq> <nsensors_seen>
 *     E <node> <ev_seq> <tmaster_tick> <flags> <rssi> <snr>
 *     D <node> <OK|STALE|LOST> <offset_tick> <skew_ppm> <rx_miss> <beacon_gap> <last_seen_ms> <rssi> <snr> <lat_ms>
 *     L <RED|GREEN|OFF> <tick>
 *     A <cmd> OK
 *     X <reason>
 *   PC -> Master:
 *     G | R | O | ?ID | ?STATUS | PING
 */
#ifndef PROTO_USB_H
#define PROTO_USB_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Link-state codes used in the D line and pu_emit_diag(). */
#define PU_STATE_OK    0
#define PU_STATE_STALE 1
#define PU_STATE_LOST  2

/* Light-state codes used in the L line and pu_emit_light(). */
#define PU_LIGHT_OFF   0
#define PU_LIGHT_RED   1
#define PU_LIGHT_GREEN 2

void pu_emit_identity(uint32_t devid_hi, uint32_t devid_lo);
void pu_emit_heartbeat(uint64_t now_tick, uint32_t uptime_ms, uint8_t beacon_seq, int nseen);
void pu_emit_event(uint8_t node, uint16_t ev_seq, uint64_t tmaster, uint8_t flags,
                   float rssi, float snr);
void pu_emit_diag(uint8_t node, int state, int64_t offset_tick, int32_t skew_ppm,
                  uint16_t rx_miss, uint16_t beacon_gap, uint32_t last_seen_ms,
                  float rssi, float snr, uint32_t lat_ms);
void pu_emit_light(int state, uint64_t tick);
void pu_emit_ack(const char *cmd);
void pu_emit_err(const char *reason);

/* Parsed PC->master command. */
typedef enum {
    PU_CMD_NONE = 0, /* no complete line yet */
    PU_CMD_GREEN,
    PU_CMD_RED,
    PU_CMD_OFF,
    PU_CMD_ID,
    PU_CMD_STATUS,
    PU_CMD_PING,
    PU_CMD_BAD,      /* a full line was parsed but unrecognised */
} pu_cmd_t;

/* Feed one received byte. Returns a command when a full line terminates, else
 * PU_CMD_NONE. */
pu_cmd_t pu_feed(int c);

#ifdef __cplusplus
}
#endif

#endif /* PROTO_USB_H */
