#ifndef ROVER_MCU_PROTOCOL_H
#define ROVER_MCU_PROTOCOL_H

#include <stdbool.h>
#include <stdint.h>

// Telemetry status flags packed into one uint32 sent over USB CDC.
#define FLAG_ESTOP_ACTIVE         (1u << 0)
#define FLAG_PI_HEARTBEAT_TIMEOUT (1u << 1)
#define FLAG_BATTERY_UNDERVOLT    (1u << 2)
#define FLAG_PID_ACTIVE           (1u << 4)
#define FLAG_HW_WDT_REBOOT        (1u << 5)

// Process whatever bytes have arrived on stdin (USB CDC). Non-blocking.
// Returns true if at least one complete command was consumed.
bool protocol_poll_input(void);

// Emit one telemetry line. Format:
//   T <ms> <enc_l> <enc_r> <vel_l> <vel_r> <vbat> <flags>\n
void protocol_emit_telemetry(uint32_t ms,
                             int32_t enc_l, int32_t enc_r,
                             float vel_l, float vel_r,
                             float vbat,
                             uint32_t flags);

void protocol_emit_event(const char *msg);

#endif
