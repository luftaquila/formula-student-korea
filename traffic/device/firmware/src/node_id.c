#include "node_id.h"

#include "protocol.h"
#include "nrf.h"

/* Set channels — DESIGN §2.2 (sync word 0x12 for all). */
#define FREQ_A 921.3f
#define FREQ_B 922.1f
#define FREQ_C 922.9f

/* Provisioning table, keyed by FICR.DEVICEID (= bootloader USB serial:
 * hi word first, then lo). Unknown boards default to sensor 1 of set A. */
typedef struct {
    uint32_t devid_hi;
    uint32_t devid_lo;
    uint8_t  set_id;
    uint8_t  node_id;
    float    freq_mhz;
} node_cfg_t;

static const node_cfg_t TABLE[] = {
    {0x8C0853F7, 0x0D2243B0, SET_ID_A, NODE_MASTER, FREQ_A}, /* serial 8C0853F70D2243B0 */
    {0x4EA0A33C, 0x063E3984, SET_ID_A, 1,           FREQ_A}, /* serial 4EA0A33C063E3984 */
};

static node_cfg_t g_cfg;
static uint32_t g_hi, g_lo;

void node_init(void)
{
    g_hi = NRF_FICR->DEVICEID[1];
    g_lo = NRF_FICR->DEVICEID[0];

    for (unsigned i = 0; i < sizeof(TABLE) / sizeof(TABLE[0]); i++) {
        if (TABLE[i].devid_hi == g_hi && TABLE[i].devid_lo == g_lo) {
            g_cfg = TABLE[i];
            return;
        }
    }
    /* Unknown board: behave as sensor 1, set A (safe — won't beacon). */
    g_cfg.set_id = SET_ID_A;
    g_cfg.node_id = 1;
    g_cfg.freq_mhz = FREQ_A;
}

node_role_t node_role(void) { return g_cfg.node_id == NODE_MASTER ? ROLE_MASTER : ROLE_SENSOR; }
uint8_t node_set_id(void) { return g_cfg.set_id; }
uint8_t node_node_id(void) { return g_cfg.node_id; }
float node_freq_mhz(void) { return g_cfg.freq_mhz; }
uint32_t node_devid_hi(void) { return g_hi; }
uint32_t node_devid_lo(void) { return g_lo; }
