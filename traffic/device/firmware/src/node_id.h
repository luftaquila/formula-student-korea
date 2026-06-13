/* Per-chip role/set/channel assignment from the nRF52840 factory unique ID
 * (FICR.DEVICEID), so every board runs the SAME binary and self-assigns
 * (DESIGN §2.3 ID_SETUP, static-table form). The bootloader's USB serial is the
 * same DEVICEID, so boards are identified by the serials we already know.
 * Adding a set = add its 3 boards (1 master + 2 sensors) with a new channel.
 */
#ifndef NODE_ID_H
#define NODE_ID_H

#include <stdint.h>

typedef enum { ROLE_MASTER, ROLE_SENSOR } node_role_t;

/* Read FICR.DEVICEID and resolve this board's role/set/node/channel. */
void node_init(void);

node_role_t node_role(void);
uint8_t node_set_id(void);  /* 0..2 */
uint8_t node_node_id(void); /* 0 = master, 1/2 = sensors */
float node_freq_mhz(void);  /* set channel frequency */

/* Raw 64-bit chip ID (for debug / provisioning). */
uint32_t node_devid_hi(void);
uint32_t node_devid_lo(void);

#endif /* NODE_ID_H */
