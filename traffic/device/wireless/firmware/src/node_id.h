/* Per-chip role/node assignment from the nRF52840 factory unique ID
 * (FICR.DEVICEID), so every board runs the SAME binary and self-assigns
 * (DESIGN §2.3). The bootloader's USB serial is the same DEVICEID, so boards are
 * identified by the serials we already know. One master + up to 6 sensors, all
 * on one channel — adding a sensor = add its DEVICEID row with a node_id.
 */
#ifndef NODE_ID_H
#define NODE_ID_H

#include <stdint.h>

typedef enum { ROLE_MASTER, ROLE_SENSOR } node_role_t;

/* Read FICR.DEVICEID and resolve this board's role/node. */
void node_init(void);

node_role_t node_role(void);
uint8_t node_node_id(void); /* 0 = master, 1..6 = sensors, 0xFF = unprovisioned */
float node_freq_mhz(void);  /* the single shared channel frequency */

/* Raw 64-bit chip ID (for debug / provisioning). */
uint32_t node_devid_hi(void);
uint32_t node_devid_lo(void);

#endif /* NODE_ID_H */
