#ifndef ROVER_MCU_PUMP_H
#define ROVER_MCU_PUMP_H

#include <stdbool.h>

// Peristaltic pump (mission dispenser). GP6 drives the gate of an
// IRLZ44N logic-level N-MOSFET (low-side switch) that powers the pump
// motor; a 1N4007 flyback diode across the pump clamps the inductive
// turn-off spike. Simple on/off — replaces the former MG995 dispenser
// servo that used to own this pin.
void pump_init(void);        // GP6 output, pump off (no dispense on power-on)

// Set the pump on/off (MOSFET gate HIGH = pump runs).
void pump_set(bool on);

// Current commanded state.
bool pump_is_on(void);

#endif
