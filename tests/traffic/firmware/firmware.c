#include <stdio.h>
#include <assert.h>
#include <string.h>
#include <setjmp.h>
#define main firmware_entry
#include "../../../competition/modules/traffic/device/wireless/firmware/src/main.c"
#undef main
static jmp_buf done;
static unsigned iteration, popped;
static unsigned observed_drop, observed_flags, sent_events;
static int lose_clock_after_ready;
static uint32_t capture_count;
static event_pl_t last_sent;
static unsigned sent_losses, sent_after_recovery, premature_recovery;
int board_hfclk_xtal(void){return !(lose_clock_after_ready && iteration == 8);}
uint32_t board_millis(void){return iteration*1000u+800u;}
void board_delay_ms(uint32_t x){(void)x;}
void board_led_toggle(void){}
void usb_task(void){if(++iteration>(lose_clock_after_ready ? 16u : 7u))longjmp(done,1);}
int usb_read_byte(void){return -1;}
int radio_start_rx(void){return 0;}
int radio_lbt_clear(void){return 1;}
int radio_transmit(const uint8_t *b,int n){return 0;}
int radio_receive(uint8_t*b,int n){b[0]=SEC_VT(PROTO_VER,PKT_TYPE_ACK);return WIRE_ACK;}
int radio_receive_q(uint8_t*b,int n,float*r,float*s){b[0]=SEC_VT(PROTO_VER,PKT_TYPE_BEACON);return WIRE_BEACON;}
uint64_t capture_now64(void){return (uint64_t)(iteration*1000u+800u)*TICKS_PER_MS;}
int capture_dio1_get(uint64_t*t){*t=(uint64_t)iteration*1000u*TICKS_PER_MS;return 1;}
int capture_sensor_get(uint64_t*t, uint32_t*seq, int*xtal){if((iteration==2||iteration==5||iteration==6||(lose_clock_after_ready&&(iteration==8||iteration==10||iteration==14)))&&popped!=iteration){popped=iteration;*seq=++capture_count;*xtal=board_hfclk_xtal();*t=(uint64_t)(iteration*1000u+100u)*TICKS_PER_MS;return 1;}return 0;}
int capture_sensor_loss(uint64_t*a,uint64_t*b,uint32_t*c,uint32_t*d){return 0;}
int capture_sensor_checkpoint(uint64_t*t,uint32_t*s){*t=capture_now64();*s=capture_count;return 1;}
uint16_t capture_sensor_overflow(void){return 0;}
uint32_t node_sender_id(void){return 1;}
uint32_t node_devid_hi(void){return 0;}
uint32_t node_devid_lo(void){return 1;}
uint32_t sec_boot_id(void){return 42;}
int sec_unseal(const uint8_t*b,int n,sec_meta_t*m,void*out,int len){if(SEC_VT_TYPE(b[0])==PKT_TYPE_ACK){m->node_id=0;m->boot_id=0x1234007b;m->ctr=iteration;ack_pl_t a={.node_id=1,.ev_seq=last_sent.ev_seq,.sensor_boot_id=42,.ev_master_t=last_sent.ev_master_t};memcpy(out,&a,sizeof a);return 0;}m->node_id=0;m->boot_id=0x1234007b;m->ctr=iteration;beacon_pl_t e={.seq=(uint8_t)(iteration-1),.m_tx_prev=(uint64_t)(iteration-1)*1000u*TICKS_PER_MS};memcpy(out,&e,sizeof e);return 0;}
int sec_replay(sec_replay_t*s,uint32_t b,uint32_t c){return 1;}
int sec_seal(uint8_t*b,int cap,uint8_t type,uint32_t id,const void*p,int n){if(type==PKT_TYPE_EVENT){const event_pl_t*e=p;assert(e->master_boot_id==0x1234007b);last_sent=*e;sent_events++;if(e->flags&EVENT_LOSS)sent_losses++;if(iteration==10 && e->flags==HEALTH_EVENT_REQUIRED)premature_recovery++;if(iteration>=14 && e->flags==HEALTH_EVENT_REQUIRED)sent_after_recovery++;return WIRE_EVENT;}if(type==PKT_TYPE_STATUS){const status_pl_t*s=p;observed_drop=s->event_drop;observed_flags=s->flags;printf("status iteration=%u sync=%u skew=%u event_drop=%u flags=%u\n",iteration,!!(s->flags&HEALTH_SYNC_VALID),!!(s->flags&HEALTH_SKEW_VALID),s->event_drop,s->flags);}return WIRE_STATUS;}
int keystore_write(const uint8_t*k){return 0;}
void sec_reload(void){}
const uint8_t *pu_setkey(void){return 0;}
void pu_emit_ack(const char*x){}
void pu_emit_err(const char*x){}
void pu_emit_identity(uint32_t x,uint32_t y){}
pu_cmd_t pu_feed(int x){return 0;}
uint16_t meas_vddh_mv(void){return 3700;}
int16_t meas_temp_c10(void){return 250;}
int main(int argc, char **argv) {
    (void)argv;
    lose_clock_after_ready = argc > 1;
    if (setjmp(done) == 0) run_sensor(0);
    if (lose_clock_after_ready) {
        return observed_drop > 0 && (observed_flags & HEALTH_CAPTURE_OK) && sent_losses > 0 && sent_after_recovery > 0 && premature_recovery == 0 ? 0 : 1;
    }
    return sent_events > 0 && observed_drop == 0 && observed_flags == HEALTH_EVENT_REQUIRED ? 0 : 1;
}
