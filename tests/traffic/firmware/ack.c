#include <stdio.h>
#include <string.h>
#include <assert.h>
#define main firmware_entry
#include "../../../competition/modules/traffic/device/wireless/firmware/src/main.c"
#undef main
uint32_t board_millis(void){static uint32_t ms;return ms++;}
int radio_lbt_clear(void){return 1;}
int radio_transmit(const uint8_t*b,int n){return 0;}
int radio_start_rx(void){return 0;}
int sec_seal(uint8_t*b,int c,uint8_t t,uint32_t id,const void*p,int n){return WIRE_EVENT;}
int radio_receive(uint8_t*b,int n){b[0]=SEC_VT(PROTO_VER,PKT_TYPE_ACK);return WIRE_ACK;}
/* Stand in for decrypting a previously recorded, correctly authenticated ACK.
   No forged signature is assumed; the replayed packet has an old master boot. */
static uint32_t ack_master_boot = 222;
static int replay_allowed = 1;
static ack_pl_t ack = {
    .node_id = 0xAABB0001, .ev_seq = 42,
    .sensor_boot_id = 42, .ev_master_t = 1600000000
};
int sec_unseal(const uint8_t*b,int n,sec_meta_t*m,void*out,int len){m->node_id=NODE_MASTER;m->boot_id=ack_master_boot;m->ctr=1;memcpy(out,&ack,sizeof ack);return 0;}
uint32_t sec_boot_id(void){return 42;}
int sec_replay(sec_replay_t*s,uint32_t b,uint32_t c){return replay_allowed;}
int main(void) {
    event_pl_t current = {.ev_seq=42, .ev_master_t=1600000000,
        .master_boot_id=222, .sync_age_ms=100, .flags=HEALTH_EVENT_REQUIRED};
    sec_replay_t replay = {0};
    ack_master_boot = 0x100de; /* same low 16 bits as 222, different session */
    assert(!sensor_try_send_event(&current, 0xAABB0001, 222, &replay));
    ack_master_boot = 222;
    ack.sensor_boot_id = 41;
    assert(!sensor_try_send_event(&current, 0xAABB0001, 222, &replay));
    ack.sensor_boot_id = 42;
    ack.ev_master_t++;
    assert(!sensor_try_send_event(&current, 0xAABB0001, 222, &replay));
    ack.ev_master_t--;
    replay_allowed = 0;
    assert(!sensor_try_send_event(&current, 0xAABB0001, 222, &replay));
    replay_allowed = 1;
    assert(sensor_try_send_event(&current, 0xAABB0001, 222, &replay));
    return 0;
}
