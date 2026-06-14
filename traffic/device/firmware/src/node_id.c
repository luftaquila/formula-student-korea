#include "node_id.h"

#include "config.h"
#include "protocol.h"
#include "nrf.h"

/* The one shared channel (sync word 0x12 for all — DESIGN §2.2). */
#define FREQ_HZ LORA_FREQ_MHZ

/* Provisioning table, keyed by FICR.DEVICEID (= bootloader USB serial: hi word
 * first, then lo). node_id 0 = master, 1..6 = sensors. Unknown boards stay
 * unprovisioned (node_id 0xFF) so the master ignores their traffic and they
 * never masquerade as a real sensor. */
typedef struct {
    uint32_t devid_hi;
    uint32_t devid_lo;
    uint8_t  node_id;
} node_cfg_t;

static const node_cfg_t TABLE[] = {
    {0x8C0853F7, 0x0D2243B0, NODE_MASTER}, /* serial 8C0853F70D2243B0 — master */
    {0x4EA0A33C, 0x063E3984, 1},           /* serial 4EA0A33C063E3984 — sensor 1 */
    /* TODO: add sensor 2..6 DEVICEIDs -> node_id 2..6 as boards are provisioned. */
};

static uint8_t  g_node_id = 0xFFu;
static uint32_t g_hi, g_lo;

void node_init(void)
{
    g_hi = NRF_FICR->DEVICEID[1];
    g_lo = NRF_FICR->DEVICEID[0];

    for (unsigned i = 0; i < sizeof(TABLE) / sizeof(TABLE[0]); i++) {
        if (TABLE[i].devid_hi == g_hi && TABLE[i].devid_lo == g_lo) {
            g_node_id = TABLE[i].node_id;
            return;
        }
    }
    /* Unknown board: unprovisioned. Acts as an inert sensor — it will sync but
     * the master rejects node_id 0xFF, so it can't collide with a real node. */
    g_node_id = 0xFFu;
}

node_role_t node_role(void) { return g_node_id == NODE_MASTER ? ROLE_MASTER : ROLE_SENSOR; }
uint8_t node_node_id(void) { return g_node_id; }
float node_freq_mhz(void) { return FREQ_HZ; }
uint32_t node_devid_hi(void) { return g_hi; }
uint32_t node_devid_lo(void) { return g_lo; }
