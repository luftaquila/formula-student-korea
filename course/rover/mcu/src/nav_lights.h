#ifndef ROVER_MCU_NAV_LIGHTS_H
#define ROVER_MCU_NAV_LIGHTS_H

#include <stdbool.h>
#include <stdint.h>

// Aircraft-style navigation lights (red/green) on a 3-pin module
// (+5V, GND, control); GP9 drives the on/off control line directly.
// On/off only; the MCU drives them autonomously.

void nav_lights_init(void);     // GPIO out, default OFF (safe at boot)
void nav_lights_set(bool on);   // both colours on/off together

// Aircraft anti-collision STROBE cadence on the red/green channel: a quick
// double-flash then a long dark gap, repeating. Call frequently from the main
// loop — timing is derived from now_ms, so the call rate doesn't matter.
void nav_lights_tick(uint32_t now_ms);

#endif // ROVER_MCU_NAV_LIGHTS_H
