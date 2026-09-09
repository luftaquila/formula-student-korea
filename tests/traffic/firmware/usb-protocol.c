#include <assert.h>
#include <string.h>
#include "../../../traffic/device/wireless/firmware/src/proto_usb.c"

static char output[256];
int usb_write(const char *line) {
    strcpy(output, line);
    return 1;
}

static pu_cmd_t command(const char *line) {
    while (*line) pu_feed(*line++);
    return pu_feed('\n');
}

int main(void) {
    const char *token = "0123456789abcdef0123456789abcdef";
    assert(command("T 0123456789abcdef0123456789abcdef") == PU_CMD_CLOCK);
    assert(strcmp(pu_clock_token(), token) == 0);
    assert(command("T short") == PU_CMD_BAD);
    pu_emit_clock(token, UINT64_MAX, UINT32_MAX);
    assert(strcmp(output, "T 0123456789abcdef0123456789abcdef 18446744073709551615 4294967295\n") == 0);
    assert(command("C AABB0001 65535 18446744073709551615 4294967295 42") == PU_CMD_EVENT_ACK);
    assert(pu_event_ack_node() == 0xAABB0001 && pu_event_ack_seq() == UINT16_MAX);
    assert(pu_event_ack_tick() == UINT64_MAX && pu_event_ack_boot() == UINT32_MAX);
    assert(command("C AABB0001 1 100") == PU_CMD_BAD);
    assert(command("C AABB0001 1 100 4294967296") == PU_CMD_BAD);
    event_pl_t event = { .ev_seq = UINT16_MAX, .ev_master_t = UINT64_MAX, .master_boot_id = UINT32_MAX,
        .flags = 47, .capture_seq = UINT32_MAX, .end_seq = UINT32_MAX, .end_tick = UINT64_MAX, .sync_age_ms = 7 };
    assert(pu_event_ack_sensor_boot() == 42);
    pu_emit_event(0xAABB0001, &event, 42, -60, 9);
    assert(strcmp(output, "E AABB0001 65535 18446744073709551615 47 -60.00 9.00 4294967295 42 4294967295 4294967295 18446744073709551615 7\n") == 0);
    event = (event_pl_t){ .ev_seq = 7, .ev_master_t = 100, .end_tick = 100,
        .master_boot_id = 42, .flags = EVENT_LOSS };
    pu_emit_event(0, &event, 42, 0, 0);
    assert(strcmp(output, "E 0 7 100 16 0.00 0.00 42 42 0 0 100 0\n") == 0);
    assert(command("C 0 7 100 42 42") == PU_CMD_EVENT_ACK);
    assert(pu_event_ack_node() == 0 && pu_event_ack_seq() == 7);
    assert(pu_event_ack_tick() == 100 && pu_event_ack_boot() == 42 && pu_event_ack_sensor_boot() == 42);
    assert(command("C 00 7 100 42 42") == PU_CMD_BAD);
    assert(command("C AABB001 7 100 42 42") == PU_CMD_BAD);
    assert(command("G") == PU_CMD_BAD);
    assert(command("R") == PU_CMD_BAD);
    assert(command("O") == PU_CMD_BAD);
    return 0;
}
