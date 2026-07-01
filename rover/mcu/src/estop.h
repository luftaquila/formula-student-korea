#ifndef ROVER_MCU_ESTOP_H
#define ROVER_MCU_ESTOP_H

#include <stdbool.h>

void estop_init(void);
bool estop_is_active(void);     // sticky once tripped, until cleared
void estop_clear(void);         // host-acknowledged release
void estop_trip(void);          // software-triggered

#endif
