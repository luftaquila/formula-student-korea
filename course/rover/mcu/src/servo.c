#include "servo.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/clocks.h"
#include "hardware/gpio.h"
#include "hardware/pwm.h"

typedef struct {
    uint pin;
    uint slice;
    uint channel;
    uint16_t min_us;
    uint16_t max_us;
    uint16_t target_us;
    uint16_t current_us;
} servo_t;

static servo_t g_srv[SERVO_COUNT_];

// Convert pulse_us to PWM level given current slice config.
// We pick clkdiv so wrap = SERVO_PERIOD_US, then level = pulse_us directly.
static void setup_servo(servo_t *s, uint pin,
                        uint16_t min_us, uint16_t max_us) {
    s->pin    = pin;
    s->min_us = min_us;
    s->max_us = max_us;
    gpio_set_function(pin, GPIO_FUNC_PWM);
    s->slice   = pwm_gpio_to_slice_num(pin);
    s->channel = pwm_gpio_to_channel(pin);

    // Want 1 PWM count = 1 us. clkdiv = sys_hz / 1_000_000.
    float sys_hz = (float)clock_get_hz(clk_sys);
    float div    = sys_hz / 1.0e6f;
    pwm_set_clkdiv(s->slice, div);
    pwm_set_wrap(s->slice, SERVO_PERIOD_US - 1);
    pwm_set_chan_level(s->slice, s->channel, SERVO_CENTER_US);
    pwm_set_enabled(s->slice, true);
    s->target_us  = SERVO_CENTER_US;
    s->current_us = SERVO_CENTER_US;
}

void servo_init(void) {
    setup_servo(&g_srv[SERVO_STEER],
                PIN_SERVO_STEER,
                SERVO_MIN_US, SERVO_MAX_US);
    setup_servo(&g_srv[SERVO_DISPENSER],
                PIN_SERVO_DISPENSER,
                SERVO_DISPENSER_MIN_US, SERVO_DISPENSER_MAX_US);
}

void servo_set_target_us(servo_id_t id, uint16_t pulse_us) {
    if (id >= SERVO_COUNT_) return;
    servo_t *s = &g_srv[id];
    if (pulse_us < s->min_us) pulse_us = s->min_us;
    if (pulse_us > s->max_us) pulse_us = s->max_us;
    int32_t delta = (int32_t)pulse_us - (int32_t)s->target_us;
    if (delta < 0) delta = -delta;
    if (delta < SERVO_DEADBAND_US) return;  // ignore sub-deadzone wobble
    s->target_us = pulse_us;
}

void servo_tick(void) {
    for (int i = 0; i < SERVO_COUNT_; i++) {
        servo_t *s = &g_srv[i];
        int32_t diff = (int32_t)s->target_us - (int32_t)s->current_us;
        if (diff >  SERVO_SLEW_US_PER_TICK) diff =  SERVO_SLEW_US_PER_TICK;
        if (diff < -SERVO_SLEW_US_PER_TICK) diff = -SERVO_SLEW_US_PER_TICK;
        s->current_us = (uint16_t)((int32_t)s->current_us + diff);
        pwm_set_chan_level(s->slice, s->channel, s->current_us);
    }
}

void servo_center_all(void) {
    for (int i = 0; i < SERVO_COUNT_; i++) {
        g_srv[i].target_us  = SERVO_CENTER_US;
        g_srv[i].current_us = SERVO_CENTER_US;
        pwm_set_chan_level(g_srv[i].slice, g_srv[i].channel, SERVO_CENTER_US);
    }
}
