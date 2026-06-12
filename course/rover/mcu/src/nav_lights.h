#ifndef ROVER_MCU_NAV_LIGHTS_H
#define ROVER_MCU_NAV_LIGHTS_H

#include <stdbool.h>
#include <stdint.h>

// Aircraft-style navigation lights (red/green) on a 3-pin module
// (+5V, GND, control); GP9 drives the on/off control line directly.
// On/off only; the MCU renders the selected pattern autonomously.

typedef enum {
    NAV_MODE_OFF     = 0,   // fully off
    NAV_MODE_STEADY  = 1,   // steady on
    NAV_MODE_STROBE2 = 2,   // aircraft double-flash strobe (default)
    NAV_MODE_STROBE1 = 3,   // single flash ~1 Hz
    NAV_MODE_BLINK   = 4,   // 50% duty ~1 Hz
    NAV_MODE_COUNT_,
} nav_mode_t;

void nav_lights_init(void);              // GPIO out, default mode STROBE2
void nav_lights_set(bool on);            // raw both-colours on/off
void nav_lights_set_mode(nav_mode_t m);  // select pattern (ignored if invalid)
nav_mode_t nav_lights_get_mode(void);

// Render the active pattern. Call frequently from the main loop — timing is
// derived from now_ms, so the call rate doesn't matter.
void nav_lights_tick(uint32_t now_ms);

#endif // ROVER_MCU_NAV_LIGHTS_H
