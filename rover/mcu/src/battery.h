#ifndef ROVER_MCU_BATTERY_H
#define ROVER_MCU_BATTERY_H

void  battery_init(void);
float battery_read_voltage(void);   // averaged, returns Volts

#endif
