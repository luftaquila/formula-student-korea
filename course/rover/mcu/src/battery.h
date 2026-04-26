#ifndef ROVER_MCU_BATTERY_H
#define ROVER_MCU_BATTERY_H

#include <stdbool.h>

void  battery_init(void);
float battery_read_voltage(void);   // averaged, returns Volts
bool  battery_is_undervolt(void);

#endif
