#include "secure.h"

#include <string.h>

#include "protocol.h"
#include "secret.h"   /* LORA_PSK_BYTES — gitignored; see secret.h.example */
#include "monocypher.h"
#include "nrf.h"

/* Release builds (-DFLEET_KEY_REQUIRED, see CMakeLists.txt) refuse to compile
 * against the all-zero placeholder key, so a deployment can never silently ship
 * with no security. The placeholder defines LORA_PSK_PLACEHOLDER; a real key
 * does not. */
#if defined(FLEET_KEY_REQUIRED) && defined(LORA_PSK_PLACEHOLDER)
#error "FLEET_KEY_REQUIRED build but src/secret.h is the placeholder key. Generate a real fleet key (see secret.h.example)."
#endif

/* Fleet-wide pre-shared key. All boards must be flashed with the same key. */
static const uint8_t KEY[32] = { LORA_PSK_BYTES };

/* Nonce domain byte — separates this protocol's use of the key from any other.
 * 'W' for FSK-WL (wireless). */
#define NONCE_DOMAIN 0x57u

static uint32_t g_boot_id;
static uint32_t g_tx_ctr;

/* Blocking 32-bit read of the nRF52840 hardware RNG (bias-corrected). Used once
 * at boot for boot_id; latency is irrelevant. */
static uint32_t rng32(void)
{
    NRF_RNG->CONFIG = (RNG_CONFIG_DERCEN_Enabled << RNG_CONFIG_DERCEN_Pos);
    NRF_RNG->TASKS_START = 1;
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        NRF_RNG->EVENTS_VALRDY = 0;
        while (NRF_RNG->EVENTS_VALRDY == 0) { /* wait for a fresh byte */ }
        v = (v << 8) | (NRF_RNG->VALUE & 0xFFu);
    }
    NRF_RNG->TASKS_STOP = 1;
    return v;
}

void sec_init(void)
{
    g_boot_id = rng32();
    g_tx_ctr = 0;
}

uint32_t sec_boot_id(void) { return g_boot_id; }

/* 24-byte XChaCha nonce from the message identity. Unique per (key, message):
 * ctr never repeats within a boot, boot_id makes it unique across boots. */
static void build_nonce(uint8_t nonce[24], uint8_t type, uint8_t node_id,
                        uint32_t boot_id, uint32_t ctr)
{
    memset(nonce, 0, 24);
    nonce[0] = NONCE_DOMAIN;
    nonce[1] = type;
    nonce[2] = node_id;
    memcpy(&nonce[4], &boot_id, 4);
    memcpy(&nonce[8], &ctr, 4);
}

int sec_seal(uint8_t *out, int out_cap, uint8_t type, uint8_t node_id,
             const void *payload, int payload_len)
{
    int wire = SEC_OVERHEAD + payload_len;
    if (out_cap < wire) { return -1; }

    sec_hdr_t h;
    h.type = type;
    h.node_id = node_id;
    h.boot_id = g_boot_id;
    /* Never let ctr wrap: a repeated (boot_id, ctr) would reuse a nonce, which is
     * catastrophic for the stream cipher. 2^32 seals is unreachable in a session
     * (decades at any real packet rate); refuse rather than wrap. */
    if (g_tx_ctr == 0xFFFFFFFFu) { return -3; }
    h.ctr = ++g_tx_ctr; /* first sealed packet uses ctr = 1 */

    uint8_t nonce[24];
    build_nonce(nonce, type, node_id, h.boot_id, h.ctr);

    memcpy(out, &h, SEC_HDR_LEN);
    crypto_aead_lock(out + SEC_HDR_LEN,           /* ciphertext */
                     out + SEC_HDR_LEN + payload_len, /* mac (16) */
                     KEY, nonce,
                     out, SEC_HDR_LEN,            /* associated data = header */
                     (const uint8_t *)payload, (size_t)payload_len);
    return wire;
}

int sec_unseal(const uint8_t *in, int in_len, sec_meta_t *meta,
               void *out_payload, int payload_len)
{
    int wire = SEC_OVERHEAD + payload_len;
    if (in_len < wire) { return -1; }

    sec_hdr_t h;
    memcpy(&h, in, SEC_HDR_LEN);

    uint8_t nonce[24];
    build_nonce(nonce, h.type, h.node_id, h.boot_id, h.ctr);

    uint8_t plain[WIRE_MAX];
    if (crypto_aead_unlock(plain,
                           in + SEC_HDR_LEN + payload_len, /* mac */
                           KEY, nonce,
                           in, SEC_HDR_LEN,                /* associated data */
                           in + SEC_HDR_LEN, (size_t)payload_len) != 0) {
        return -2; /* forgery / bit error / wrong key */
    }

    memcpy(out_payload, plain, (size_t)payload_len);
    crypto_wipe(plain, sizeof(plain));

    meta->type = h.type;
    meta->node_id = h.node_id;
    meta->boot_id = h.boot_id;
    meta->ctr = h.ctr;
    return 0;
}

int sec_replay(sec_replay_t *st, uint32_t boot_id, uint32_t ctr)
{
    if (!st->have || boot_id != st->boot_id) {
        st->have = 1;
        st->boot_id = boot_id;
        st->max_ctr = ctr;
        return 1; /* first contact or a new boot session */
    }
    if (ctr > st->max_ctr) {
        st->max_ctr = ctr;
        return 1;
    }
    return 0; /* stale: replayed or out-of-order */
}
