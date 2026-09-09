#include <stdio.h>
#include <stdint.h>
#define GPIO_H
static void gpio_cfg_output(uint32_t p){}
static void gpio_set(uint32_t p){}
static void gpio_clear(uint32_t p){}
static void gpio_toggle(uint32_t p){}
static void gpio_write(uint32_t p,int h){}
#include "../../../traffic/device/wireless/firmware/src/board.c"
#define main firmware_entry
#include "../../../traffic/device/wireless/firmware/src/main.c"
#undef main
int main(void){
NRF_TIMER2->CC[0]=4294967000u;uint32_t before=board_millis();
NRF_TIMER2->CC[0]=1000u;uint32_t after=board_millis();
node_stat_t s={.have_status=1,.last_status_ms=before};
printf("real_elapsed_us=1296 before_ms=%u after_ms=%u elapsed_ms=%u link_state=%d pending_expired=%u\n",before,after,(uint32_t)(after-before),link_state_of(after,&s),(uint32_t)(after-before)>=SENSOR_EVENT_MAX_AGE_MS);
return link_state_of(after,&s)==PU_STATE_OK && (uint32_t)(after-before)<2 ?0:1;
}
