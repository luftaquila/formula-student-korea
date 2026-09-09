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
    assert(command("C AABB0001 65535 18446744073709551615 4294967295") == PU_CMD_EVENT_ACK);
    assert(pu_event_ack_node() == 0xAABB0001 && pu_event_ack_seq() == UINT16_MAX);
    assert(pu_event_ack_tick() == UINT64_MAX && pu_event_ack_boot() == UINT32_MAX);
    assert(command("C AABB0001 1 100") == PU_CMD_BAD);
    assert(command("C AABB0001 1 100 4294967296") == PU_CMD_BAD);
    pu_emit_event(0xAABB0001, UINT16_MAX, UINT64_MAX, 15, -60, 9, UINT32_MAX);
    assert(strcmp(output, "E AABB0001 65535 18446744073709551615 15 -60.00 9.00 4294967295\n") == 0);
    pu_emit_light(PU_LIGHT_GREEN, UINT64_MAX, UINT32_MAX);
    assert(strcmp(output, "L GREEN 18446744073709551615 4294967295\n") == 0);
    return 0;
}
