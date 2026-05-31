#ifndef ROVER_MCU_NAV_LIGHTS_H
#define ROVER_MCU_NAV_LIGHTS_H

#include <stdbool.h>

// Aircraft-style navigation lights (red/green) on a single low-side
// switch (GP9 → SS8050). On/off only; the MCU drives them autonomously.

void nav_lights_init(void);     // GPIO out, default OFF (safe at boot)
void nav_lights_set(bool on);   // both colours on/off together

#endif // ROVER_MCU_NAV_LIGHTS_H
