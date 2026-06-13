/* Stage-3 hardware timestamp capture (DESIGN.md §2.4, §8).
 *
 * TIMER1 free-runs at 16 MHz (62.5 ns) as the common timebase. A GPIOTE event
 * on DIO1's rising edge (Tx/RxDone) is wired through PPI to TIMER1's CAPTURE
 * task, so the done instant is latched in hardware with zero CPU latency — the
 * whole point of the timing system. DIO1 is on port 1, so the GPIOTE PSEL
 * carries the PORT bit. RadioLib still reads DIO1 as a plain input (GPIOTE
 * event sensing coexists with that).
 */
#ifndef CAPTURE_H
#define CAPTURE_H

#include <stdint.h>

/* Set up TIMER1 + GPIOTE(DIO1 rising) + PPI. Call once after radio_begin(). */
void capture_init(void);

/* If a DIO1 rising edge was latched since the last call, store its 16 MHz tick
 * in *tick and return 1; otherwise return 0. */
int capture_dio1_get(uint32_t *tick);

/* Same for a SENSOR falling edge (NPN open-collector pulls the line low on an
 * event). Returns 1 + tick if one was latched since the last call. */
int capture_sensor_get(uint32_t *tick);

/* Current free-running TIMER1 tick (16 MHz). */
uint32_t capture_now(void);

#endif /* CAPTURE_H */
