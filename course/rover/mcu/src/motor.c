#include "motor.h"
#include "config.h"

#include "pico/stdlib.h"
#include "hardware/clocks.h"
#include "hardware/gpio.h"
#include "hardware/pwm.h"

#include <math.h>

typedef struct {
    uint pin_pwm;
    uint pin_dir;
    uint slice;
    uint channel;
} motor_t;

static motor_t g_mot[2];

static void setup_motor(motor_t *m, uint pin_pwm, uint pin_dir) {
    m->pin_pwm = pin_pwm;
    m->pin_dir = pin_dir;

    gpio_init(pin_dir);
    gpio_set_dir(pin_dir, GPIO_OUT);
    gpio_put(pin_dir, 0);

    gpio_set_function(pin_pwm, GPIO_FUNC_PWM);
    m->slice   = pwm_gpio_to_slice_num(pin_pwm);
    m->channel = pwm_gpio_to_channel(pin_pwm);

    // Pick clkdiv so wrap=MOTOR_PWM_WRAP yields MOTOR_PWM_FREQ_HZ.
    float sys_hz = (float)clock_get_hz(clk_sys);
    float div    = sys_hz / ((float)MOTOR_PWM_FREQ_HZ * (float)(MOTOR_PWM_WRAP + 1));
    pwm_set_clkdiv(m->slice, div);
    pwm_set_wrap(m->slice, MOTOR_PWM_WRAP);
    pwm_set_chan_level(m->slice, m->channel, 0);
    pwm_set_enabled(m->slice, true);
}

void motor_init(void) {
    setup_motor(&g_mot[0], PIN_MOT_LEFT_PWM,  PIN_MOT_LEFT_DIR);
    setup_motor(&g_mot[1], PIN_MOT_RIGHT_PWM, PIN_MOT_RIGHT_DIR);
}

void motor_set(int channel, float duty) {
    if (channel < 0 || channel > 1) return;
    if (duty >  1.0f) duty =  1.0f;
    if (duty < -1.0f) duty = -1.0f;

    motor_t *m = &g_mot[channel];
    // The rover's MDD10A wiring inverts the DIR convention: DIR=LOW is
    // physical forward, DIR=HIGH is physical reverse. The motor cables
    // could be swapped at the H-bridge instead, but flipping the sense
    // here is a single-source change that keeps all the wiring on the
    // chassis intact.
    gpio_put(m->pin_dir, duty >= 0.0f ? 0 : 1);

    uint16_t level = (uint16_t)(fabsf(duty) * (float)MOTOR_PWM_WRAP);
    pwm_set_chan_level(m->slice, m->channel, level);
}

void motor_stop_all(void) {
    motor_set(0, 0.0f);
    motor_set(1, 0.0f);
}
