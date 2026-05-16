#ifndef ROVER_MCU_STATUS_LED_H
#define ROVER_MCU_STATUS_LED_H

#include <stdint.h>

typedef enum {
    LED_BOOT,        // dim white
    LED_IDLE,        // green
    LED_ACTIVE,      // blue (driving)
    LED_WARN,        // yellow (low battery, watchdog warn)
    LED_ESTOP,       // red blink
    LED_FAULT,       // magenta (battery undervolt)
    LED_GPS_LOST,    // orange blink (Pi reported RTK fix lost / below required)
} led_state_t;

void status_led_init(void);
void status_led_set(led_state_t state);
void status_led_tick(void);  // call ~50 Hz for blink animations

#endif
