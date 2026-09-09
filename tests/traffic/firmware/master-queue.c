#include <assert.h>
#define main firmware_entry
#include "../../../traffic/device/wireless/firmware/src/main.c"
#undef main
static uint32_t boot = 1;
static int xtal = 1;
static unsigned emitted;
uint32_t board_millis(void) { return 1000; }
int board_hfclk_xtal(void) { return xtal; }
uint64_t capture_now64(void) { return 1234; }
uint32_t sec_boot_id(void) { return boot; }
void sec_init(void) { boot++; }
int pu_emit_event(uint32_t node, const event_pl_t *event, uint32_t sensor_boot, float rssi, float snr) {
    assert(event->master_boot_id == 1);
    emitted++;
    return 1;
}
int main(void) {
    event_pl_t event = { .master_boot_id = 1, .ev_master_t = 123, .flags = HEALTH_EVENT_REQUIRED };
    for (unsigned i = 0; i < MASTER_EVENT_QUEUE_LEN; i++) {
        event.ev_seq = i;
        assert(master_event_enqueue(1, &event, 2, 0, 0));
    }
    event.ev_seq++;
    assert(!master_event_enqueue(1, &event, 2, 0, 0));
    assert(g_event_backpressure == 1);
    xtal = 0;
    assert(!master_clock_check());
    master_event_host_ack(1, 0, 123, 3, 1); // foreign sensor boot cannot drain
    assert(g_event_count == MASTER_EVENT_QUEUE_LEN);
    for (unsigned i = 0; i < MASTER_EVENT_QUEUE_LEN; i++) {
        master_event_pump();
        master_event_host_ack(1, i, 123, 2, 1);
    }
    assert(emitted == MASTER_EVENT_QUEUE_LEN);
    assert(master_event_enqueue(1, &event, 2, 0, 0)); // retry retained by sensor
    assert(!master_clock_check()); // fault evidence retained after capacity returns
    assert(g_event_count == 2);
    xtal = 1;
    assert(master_clock_check());
    assert(boot == 2);
    master_event_host_ack(1, event.ev_seq, 123, 2, 2);
    assert(g_event_count == 2);
    master_event_host_ack(1, event.ev_seq, 123, 2, 1); // old session survives logical renewal
    master_event_host_ack(0, 0, 1234, 1, 1);
    assert(g_event_count == 0);
    return 0;
}
