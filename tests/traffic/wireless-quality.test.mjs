import { readWirelessClock, wirelessProtocolClient } from "../helpers/wireless-fixtures.mjs";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanup,
  createClient,
  makeAuthCookie,
  setupTestEnv,
  startServer,
  stopServer,
  tmpDbPath,
  TRUST_JWT,
} from "../helpers/test-utils.mjs";
import { healthyWirelessTelemetry as healthy } from "../helpers/wireless-fixtures.mjs";

setupTestEnv();

import { createTrafficApp } from "../../competition/modules/traffic/index.mjs";

const cookie = makeAuthCookie({ email: "quality@test.com", name: "Quality", role: "admin" });
let appState;
let server;
let client;
let dbPath;
const emittedEvents = [];

before(async () => {
  dbPath = tmpDbPath();
  appState = createTrafficApp({ readWirelessClock,
    dbPath,
    validateUser: TRUST_JWT,
    onEvent: (event, data) => emittedEvents.push({ event, data }),
  });
  const started = await startServer(appState.app);
  server = started.server;
  client = wirelessProtocolClient(createClient(started.baseUrl));
});

after(async () => {
  for (const timer of appState.timers) clearInterval(timer);
  appState.closeSse();
  await stopServer(server);
  appState.db.close();
  cleanup(dbPath);
});

async function mapAccel() {
  await client.put("/api/wireless/mapping/quality-start", {
    body: { event_type: "가속", role: "start" }, cookie,
  });
  await client.put("/api/wireless/mapping/quality-finish", {
    body: { event_type: "가속", role: "finish" }, cookie,
  });
}

describe("wireless quality gate", () => {
  it("fails closed without fresh master and sensor health", async () => {
    await mapAccel();
    const response = await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "start", start_tick: "16000000" }, cookie,
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /계측|센서|마스터/);
  });

  it("arms only after all required nodes report healthy status", async () => {
    const ingest = await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("0", { skew_ppm: 0, sync_age_ms: 0 }), healthy("quality-start"), healthy("quality-finish")] },
      cookie,
    });
    assert.equal(ingest.status, 200);
    const response = await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "start", start_tick: "16000000" }, cookie,
    });
    assert.equal(response.status, 200);
    await client.post("/api/wireless/arm", { body: { event_type: "가속", action: "stop" }, cookie });
  });

  it("rejects a stale sync even while uplink link_state is online", async () => {
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("quality-start", { sync_valid: 0, sync_age_ms: 5000 })] }, cookie,
    });
    const response = await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "start", start_tick: "16000000" }, cookie,
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /동기/);
  });

  it("does not invent sync age from diagnostic transit delay", async () => {
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("quality-start", { sync_age_ms: 100, last_seen_ms: 7001 })] }, cookie,
    });
    const response = await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "start", start_tick: "16000000" }, cookie,
    });
    assert.equal(response.status, 200);
    await client.post("/api/wireless/arm", { body: {event_type: "가속", action: "stop"}, cookie });
  });

  it("keeps beacon gaps and lifetime counters diagnostic rather than permanently blocking runs", async () => {
    await client.post("/api/wireless/ingest", { cookie, body: { telemetry: [healthy("0", {queue_overflow: 3}),
      healthy("quality-start", {beacon_gap: 1, capture_overflow: 4, event_drop: 7}), healthy("quality-finish")] } });
    assert.equal((await client.post("/api/wireless/arm", { cookie,
      body: {event_type: "가속", action: "start", start_tick: "16000000"} })).status, 200);
    await client.post("/api/wireless/ingest", { cookie, body: {telemetry: [healthy("quality-start", {beacon_gap: 1, event_drop: 8})]} });
    const state = await (await client.get("/api/wireless/state", {cookie})).json();
    assert.equal(state.sessions.find(s => s.event_type === "가속").armed, true);
    assert.deepEqual(state.qualityFaults, []);
    await client.post("/api/wireless/arm", { cookie, body: {event_type: "가속", action: "reset"} });
  });

  it("reliably delivered capture loss invalidates the run and the next start clears its fault", async () => {
    assert.equal((await client.post("/api/wireless/arm", { cookie,
      body: {event_type: "가속", action: "start", start_tick: "16000000"} })).status, 200);
    const response = await client.post("/api/wireless/ingest", { cookie, body: { events: [
      {node_id: "quality-start", master_tick: "1600000000", ev_seq: 301},
      {node_id: "quality-finish", master_tick: "1680000000", ev_seq: 302, flags: 31},
    ], telemetry: [healthy("quality-finish")] } });
    assert.equal(response.status, 200);
    const state = await (await client.get("/api/wireless/state", {cookie})).json();
    const session = state.sessions.find(s => s.event_type === "가속");
    assert.equal(session.armed, false);
    assert.equal(session.verification, "invalid");
    assert.equal(state.qualityFaults.length, 1);
    assert.ok(emittedEvents.some(item => item.event === "wireless:quality-fault" && item.data.fault_id === state.qualityFaults[0].fault_id));
    assert.equal((await client.post("/api/wireless/arm", { cookie,
      body: {event_type: "가속", action: "start", start_tick: "1760000000"} })).status, 200);
    const next = await (await client.get("/api/wireless/state", {cookie})).json();
    assert.deepEqual(next.qualityFaults, []);
    await client.post("/api/wireless/arm", { cookie, body: {event_type: "가속", action: "reset"} });
  });

});

describe("wireless durable handoff", () => {
  it("returns the exact valid event keys that the bridge may acknowledge", async () => {
    const event = { node_id: "quality-start", master_tick: "123456789", ev_seq: 77 };
    const response = await client.post("/api/wireless/ingest", {
      body: { events: [event], checkpoints: false }, cookie,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.acknowledged, [{ ...event, master_boot_id: 1, sensor_boot_id: 1 }]);
  });

  it("does not acknowledge a malformed event key", async () => {
    const response = await client.post("/api/wireless/ingest", {
      body: { events: [{ node_id: "quality-start", master_tick: "18446744073709551616", ev_seq: 77 }], checkpoints: false }, cookie,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rejected, 1);
    assert.deepEqual(body.acknowledged, []);
  });
});
