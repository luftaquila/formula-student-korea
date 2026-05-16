#include "battery.h"
#include "config.h"

#include "hardware/adc.h"
#include "hardware/gpio.h"

#include <stdint.h>

static uint adc_input;

void battery_init(void) {
    // adc_init() may be called multiple times safely; idempotent in pico-sdk.
    adc_init();
    adc_gpio_init(PIN_BATTERY_ADC);
    // adc_gpio_init clears IE and sets OD but leaves the default pull-down
    // bit alone. RP2040 reset-default is PDE=1 (50–80 kΩ to GND), which
    // loads our 100k:10k divider down ~10 %. Disable pulls explicitly so
    // the ADC sees a clean Thevenin source.
    gpio_disable_pulls(PIN_BATTERY_ADC);
    adc_input = (uint)(PIN_BATTERY_ADC - 26);  // GP26->0, GP27->1, GP28->2
}

float battery_read_voltage(void) {
    uint32_t sum = 0;
    adc_select_input(adc_input);
    for (int i = 0; i < BATTERY_OVERSAMPLE_N; i++) {
        sum += adc_read();
    }
    float v_adc = ((float)sum / (float)BATTERY_OVERSAMPLE_N) * ADC_VREF_V / ADC_RESOLUTION;
    return v_adc * BATTERY_DIVIDER * BATTERY_CAL_GAIN;
}
