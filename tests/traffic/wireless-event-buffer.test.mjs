import test from "node:test";
import assert from "node:assert/strict";
import { createWirelessEventBuffer } from "../../traffic/lib/wireless-event-buffer.mjs";

const session = {
  event_type: "가속", armed: true, run_id: "run-1", master_boot_id: 7, green_tick: "1000",
};
const edge = (id, tick = "1100", boot = 7) => ({ id, master_tick: tick, master_boot_id: boot });

test("an edge received before arm is delivered once when the matching run is established", () => {
  const buffer = createWirelessEventBuffer();
  const received = [];
  buffer.add(edge(1));
  buffer.replay({ ...session, armed: false, run_id: null }, e => received.push(e.id));
  assert.deepEqual(received, []);
  buffer.replay(session, e => received.push(e.id));
  assert.deepEqual(received, [1]);
  buffer.add(edge(1)); // duplicate SSE/backfill delivery
  buffer.replay(session, e => received.push(e.id));
  assert.deepEqual(received, [1]);
});

test("buffered events remain fenced by boot and capture boundary for each run", () => {
  const buffer = createWirelessEventBuffer();
  for (const event of [edge(1, "999"), edge(2, "1200", 8), edge(3)]) buffer.add(event);
  const received = [];
  buffer.replay(session, e => received.push(e.id));
  assert.deepEqual(received, [3]);
  buffer.replay({ ...session, run_id: "run-2", green_tick: "1150", master_boot_id: 8 }, e => received.push(e.id));
  assert.deepEqual(received, [3, 2]);
});

test("shared sensors can deliver once to each event and the recent window is bounded", () => {
  const buffer = createWirelessEventBuffer(2);
  for (let id = 1; id <= 3; id++) buffer.add(edge(id));
  const received = [];
  buffer.replay(session, e => received.push(e.id));
  buffer.replay({ ...session, event_type: "내구" }, e => received.push(e.id));
  assert.deepEqual(received, [2, 3, 2, 3]);
});
