#include "proto_usb.h"

#include <string.h>

#include "usb.h"
#include "config.h"

/* ---- dependency-free line builder ------------------------------------------
 * newlib-nano's printf has no %f and no %llu, and we must not truncate 64-bit
 * ticks, so lines are assembled from these primitives instead of snprintf. */
typedef struct { char *p; char *end; } lb_t;

static void lb_init(lb_t *b, char *buf, unsigned n) { b->p = buf; b->end = buf + n - 1; }
static void lb_ch(lb_t *b, char c) { if (b->p < b->end) { *b->p++ = c; } }
static void lb_str(lb_t *b, const char *s) { while (*s) { lb_ch(b, *s++); } }

static void lb_u32(lb_t *b, uint32_t v)
{
    char t[10];
    int n = 0;
    if (v == 0) { t[n++] = '0'; }
    while (v) { t[n++] = (char)('0' + (v % 10u)); v /= 10u; }
    while (n) { lb_ch(b, t[--n]); }
}

static void lb_u64(lb_t *b, uint64_t v)
{
    char t[20];
    int n = 0;
    if (v == 0) { t[n++] = '0'; }
    while (v) { t[n++] = (char)('0' + (uint32_t)(v % 10u)); v /= 10u; }
    while (n) { lb_ch(b, t[--n]); }
}

static void lb_i64(lb_t *b, int64_t v)
{
    if (v < 0) { lb_ch(b, '-'); lb_u64(b, (uint64_t)(-v)); }
    else { lb_u64(b, (uint64_t)v); }
}

static void lb_i32(lb_t *b, int32_t v)
{
    if (v < 0) { lb_ch(b, '-'); lb_u32(b, (uint32_t)(-v)); }
    else { lb_u32(b, (uint32_t)v); }
}

/* Two-decimal fixed point, e.g. -91.50. Enough for RSSI (0.5 dB) / SNR (0.25 dB). */
static void lb_f2(lb_t *b, float v)
{
    int neg = v < 0.0f;
    if (neg) { v = -v; }
    uint32_t s = (uint32_t)(v * 100.0f + 0.5f);
    if (neg && s) { lb_ch(b, '-'); }
    lb_u32(b, s / 100u);
    lb_ch(b, '.');
    uint32_t f = s % 100u;
    lb_ch(b, (char)('0' + f / 10u));
    lb_ch(b, (char)('0' + f % 10u));
}

static void lb_hex8(lb_t *b, uint32_t v)
{
    for (int i = 7; i >= 0; i--) {
        int d = (int)((v >> (i * 4)) & 0xFu);
        lb_ch(b, (char)(d < 10 ? '0' + d : 'A' + d - 10));
    }
}

static void lb_finish(lb_t *b) { lb_ch(b, '\n'); *b->p = '\0'; }

/* ---- emit helpers ---------------------------------------------------------- */
void pu_emit_identity(uint32_t devid_hi, uint32_t devid_lo)
{
    char line[80];
    lb_t b; lb_init(&b, line, sizeof(line));
    lb_str(&b, "I FSK-WL 2.0.0 ");
    lb_hex8(&b, devid_hi); lb_hex8(&b, devid_lo);
    lb_ch(&b, ' '); lb_f2(&b, LORA_FREQ_MHZ);
    lb_ch(&b, ' '); lb_u32(&b, (uint32_t)LORA_SF);
    lb_ch(&b, ' '); lb_f2(&b, LORA_BW_KHZ);
    lb_str(&b, " 16000");
    lb_finish(&b);
    usb_write(line);
}

void pu_emit_heartbeat(uint64_t now_tick, uint32_t uptime_ms, uint8_t beacon_seq, int nseen)
{
    char line[64];
    lb_t b; lb_init(&b, line, sizeof(line));
    lb_str(&b, "H ");
    lb_u64(&b, now_tick);
    lb_ch(&b, ' '); lb_u32(&b, uptime_ms);
    lb_ch(&b, ' '); lb_u32(&b, beacon_seq);
    lb_ch(&b, ' '); lb_u32(&b, (uint32_t)(nseen < 0 ? 0 : nseen));
    lb_finish(&b);
    usb_write(line);
}

void pu_emit_event(uint8_t node, uint16_t ev_seq, uint64_t tmaster, uint8_t flags,
                   float rssi, float snr)
{
    char line[80];
    lb_t b; lb_init(&b, line, sizeof(line));
    lb_str(&b, "E ");
    lb_u32(&b, node);
    lb_ch(&b, ' '); lb_u32(&b, ev_seq);
    lb_ch(&b, ' '); lb_u64(&b, tmaster);
    lb_ch(&b, ' '); lb_u32(&b, flags);
    lb_ch(&b, ' '); lb_f2(&b, rssi);
    lb_ch(&b, ' '); lb_f2(&b, snr);
    lb_finish(&b);
    usb_write(line);
}

void pu_emit_diag(uint8_t node, int state, int64_t offset_tick, int32_t skew_ppm,
                  uint16_t rx_miss, uint16_t beacon_gap, uint32_t last_seen_ms,
                  float rssi, float snr, uint32_t lat_ms,
                  int16_t temp_c10, uint16_t batt_mv)
{
    const char *st = state == PU_STATE_OK ? "OK" : (state == PU_STATE_STALE ? "STALE" : "LOST");
    char line[112];
    lb_t b; lb_init(&b, line, sizeof(line));
    lb_str(&b, "D ");
    lb_u32(&b, node);
    lb_ch(&b, ' '); lb_str(&b, st);
    lb_ch(&b, ' '); lb_i64(&b, offset_tick);
    lb_ch(&b, ' '); lb_i32(&b, skew_ppm);
    lb_ch(&b, ' '); lb_u32(&b, rx_miss);
    lb_ch(&b, ' '); lb_u32(&b, beacon_gap);
    lb_ch(&b, ' '); lb_u32(&b, last_seen_ms);
    lb_ch(&b, ' '); lb_f2(&b, rssi);
    lb_ch(&b, ' '); lb_f2(&b, snr);
    lb_ch(&b, ' '); lb_u32(&b, lat_ms);
    lb_ch(&b, ' '); lb_i32(&b, temp_c10);
    lb_ch(&b, ' '); lb_u32(&b, batt_mv);
    lb_finish(&b);
    usb_write(line);
}

void pu_emit_light(int state, uint64_t tick)
{
    const char *st = state == PU_LIGHT_GREEN ? "GREEN" : (state == PU_LIGHT_RED ? "RED" : "OFF");
    char line[40];
    lb_t b; lb_init(&b, line, sizeof(line));
    lb_str(&b, "L "); lb_str(&b, st); lb_ch(&b, ' '); lb_u64(&b, tick);
    lb_finish(&b);
    usb_write(line);
}

void pu_emit_ack(const char *cmd)
{
    char line[24];
    lb_t b; lb_init(&b, line, sizeof(line));
    lb_str(&b, "A "); lb_str(&b, cmd); lb_str(&b, " OK");
    lb_finish(&b);
    usb_write(line);
}

void pu_emit_err(const char *reason)
{
    char line[40];
    lb_t b; lb_init(&b, line, sizeof(line));
    lb_str(&b, "X "); lb_str(&b, reason);
    lb_finish(&b);
    usb_write(line);
}

/* ---- command parser -------------------------------------------------------- */
static char s_line[32];
static unsigned s_len;

static pu_cmd_t classify(const char *s)
{
    if (s[0] == '\0') { return PU_CMD_NONE; } /* blank line — ignore */
    if (!strcmp(s, "G")) { return PU_CMD_GREEN; }
    if (!strcmp(s, "R")) { return PU_CMD_RED; }
    if (!strcmp(s, "O")) { return PU_CMD_OFF; }
    if (!strcmp(s, "?ID")) { return PU_CMD_ID; }
    if (!strcmp(s, "?STATUS")) { return PU_CMD_STATUS; }
    if (!strcmp(s, "PING")) { return PU_CMD_PING; }
    return PU_CMD_BAD;
}

pu_cmd_t pu_feed(int c)
{
    if (c == '\n' || c == '\r') {
        s_line[s_len] = '\0';
        s_len = 0;
        return classify(s_line);
    }
    if (s_len < sizeof(s_line) - 1) {
        s_line[s_len++] = (char)c;
    }
    return PU_CMD_NONE;
}
