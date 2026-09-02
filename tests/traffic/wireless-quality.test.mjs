import { after, before, describe, it } from "node:test";
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

import { createTrafficApp } from "../../traffic/index.mjs";

const cookie = makeAuthCookie({ email: "quality@test.com", name: "Quality", role: "admin" });
let appState;
let server;
let client;
let dbPath;
const emittedEvents = [];

before(async () => {
  dbPath = tmpDbPath();
  appState = createTrafficApp({
    dbPath,
    validateUser: TRUST_JWT,
    onEvent: (event, data) => emittedEvents.push({ event, data }),
  });
  const started = await startServer(appState.app);
  server = started.server;
  client = createClient(started.baseUrl);
});

after(async () => {
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
      body: { event_type: "가속", action: "green", green_tick: "16000000" }, cookie,
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
      body: { event_type: "가속", action: "green", green_tick: "16000000" }, cookie,
    });
    assert.equal(response.status, 200);
    await client.post("/api/wireless/arm", { body: { event_type: "가속", action: "off" }, cookie });
  });

  it("rejects a stale sync even while uplink link_state is online", async () => {
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("quality-start", { sync_valid: 0, sync_age_ms: 5000 })] }, cookie,
    });
    const response = await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "green", green_tick: "16000000" }, cookie,
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /동기/);
  });

  it("adds telemetry transit age to reported sync age", async () => {
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("quality-start", { sync_age_ms: 100, last_seen_ms: 7001 })] }, cookie,
    });
    const response = await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "green", green_tick: "16000000" }, cookie,
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /동기/);
  });

  it("disarms an active run when capture health degrades", async () => {
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("0", { skew_ppm: 0, sync_age_ms: 0 }), healthy("quality-start"), healthy("quality-finish")] },
      cookie,
    });
    const armed = await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "green", green_tick: "16000000" }, cookie,
    });
    assert.equal(armed.status, 200);

    emittedEvents.length = 0;
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("quality-start", { capture_overflow: 1 })] }, cookie,
    });
    const state = await (await client.get("/api/wireless/state", { cookie })).json();
    const session = state.sessions.find((item) => item.event_type === "가속");
    assert.equal(session.armed, false);
    assert.equal(session.light_color, "red");
    assert.equal(state.qualityFaults.length, 1);
    assert.equal(state.qualityFaults[0].event_type, "가속");
    assert.equal(state.qualityFaults[0].kind, "quality");
    assert.ok(state.qualityFaults[0].reasons.some((reason) => /캡처|전달/.test(reason.reason)));
    const faultEvent = emittedEvents.find((item) => item.event === "wireless:quality-fault" && !item.data.cleared);
    assert.equal(faultEvent.data.fault_id, state.qualityFaults[0].fault_id);
    assert.equal(faultEvent.data.run_id, session.run_id);
    const audit = appState.db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'wireless.quality_fault' AND target = '가속'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.match(JSON.parse(audit.detail).error, /캡처|전달/);

    emittedEvents.length = 0;
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("quality-start")] }, cookie,
    });
    assert.equal((await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "green", green_tick: "32000000" }, cookie,
    })).status, 200);
    const recovered = await (await client.get("/api/wireless/state", { cookie })).json();
    assert.deepEqual(recovered.qualityFaults, []);
    assert.ok(emittedEvents.some((item) => item.event === "wireless:quality-fault" && item.data.cleared === true));
    await client.post("/api/wireless/arm", { body: { event_type: "가속", action: "off" }, cookie });
  });

  it("retains raw events but rejects an implausible measured interval", async () => {
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("0", { skew_ppm: 0, sync_age_ms: 0 }), healthy("quality-start"), healthy("quality-finish")] },
      cookie,
    });
    assert.equal((await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "green", green_tick: "16000000" }, cookie,
    })).status, 200);
    emittedEvents.length = 0;
    const events = [
      { node_id: "quality-start", master_tick: "1600000000", ev_seq: 301 },
      { node_id: "quality-finish", master_tick: "1608000000", ev_seq: 302 },
    ];
    assert.equal((await client.post("/api/wireless/ingest", { body: { events }, cookie })).status, 200);

    const state = await (await client.get("/api/wireless/state", { cookie })).json();
    const session = state.sessions.find((item) => item.event_type === "가속");
    assert.equal(session.armed, false);
    assert.equal(state.qualityFaults.length, 1);
    assert.equal(state.qualityFaults[0].kind, "measurement");
    assert.match(state.qualityFaults[0].reasons[0].reason, /500 ms/);
    assert.ok(emittedEvents.some((item) => item.event === "wireless:quality-fault"
      && item.data.fault_id === state.qualityFaults[0].fault_id));
    const stored = await (await client.get("/api/wireless/events?since=0", { cookie })).json();
    assert.ok(events.every((event) => stored.some((row) => row.node_id === event.node_id && row.ev_seq === event.ev_seq)));
    const audit = appState.db.prepare(`
      SELECT detail FROM logs
      WHERE action = 'wireless.measurement_fault' AND target = '가속'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(JSON.parse(audit.detail).duration_ms, 500);
  });

  it("keeps the engine live when measurement disarm persistence fails", async () => {
    await client.post("/api/wireless/ingest", {
      body: { telemetry: [healthy("0", { skew_ppm: 0, sync_age_ms: 0 }), healthy("quality-start"), healthy("quality-finish")] },
      cookie,
    });
    assert.equal((await client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "green", green_tick: "3200000000" }, cookie,
    })).status, 200);
    assert.equal((await client.post("/api/wireless/ingest", {
      body: { events: [{ node_id: "quality-start", master_tick: "3200000000", ev_seq: 401 }] }, cookie,
    })).status, 200);

    appState.db.exec(`
      CREATE TEMP TRIGGER inject_measurement_disarm_failure
      BEFORE UPDATE OF armed, light_color ON wireless_session
      WHEN OLD.event_type = '가속' AND NEW.armed = 0 AND NEW.light_color = 'red'
      BEGIN SELECT RAISE(ABORT, 'injected measurement disarm failure'); END
    `);
    emittedEvents.length = 0;
    try {
      assert.equal((await client.post("/api/wireless/ingest", {
        body: { events: [{ node_id: "quality-finish", master_tick: "3208000000", ev_seq: 402 }] }, cookie,
      })).status, 200);
      const failedState = await (await client.get("/api/wireless/state", { cookie })).json();
      const failedSession = failedState.sessions.find((item) => item.event_type === "가속");
      assert.equal(failedSession.armed, true);
      assert.equal(failedSession.light_color, "green");
      assert.deepEqual(failedState.qualityFaults, []);
      assert.ok(!emittedEvents.some((item) => item.event === "wireless:quality-fault" && !item.data.cleared));
      const failedAudit = appState.db.prepare(`
        SELECT detail FROM logs
        WHERE action = 'wireless.measurement_fault' AND target = '가속'
        ORDER BY id DESC LIMIT 1
      `).get();
      const detail = JSON.parse(failedAudit.detail);
      assert.equal(detail.phase, "database_mutation");
      assert.match(detail.error, /injected measurement disarm failure/);
    } finally {
      appState.db.exec("DROP TRIGGER IF EXISTS inject_measurement_disarm_failure");
    }

    // The failed transition must not latch run.saved. A later accepted finish
    // still reaches the same fault path and can close the session successfully.
    assert.equal((await client.post("/api/wireless/ingest", {
      body: { events: [{ node_id: "quality-finish", master_tick: "3214400000", ev_seq: 403 }] }, cookie,
    })).status, 200);
    const recoveredState = await (await client.get("/api/wireless/state", { cookie })).json();
    const recoveredSession = recoveredState.sessions.find((item) => item.event_type === "가속");
    assert.equal(recoveredSession.armed, false);
    assert.equal(recoveredSession.light_color, "red");
    assert.equal(recoveredState.qualityFaults[0].kind, "measurement");
  });
});

describe("wireless durable handoff", () => {
  it("returns the exact valid event keys that the bridge may acknowledge", async () => {
    const event = { node_id: "quality-start", master_tick: "123456789", ev_seq: 77 };
    const response = await client.post("/api/wireless/ingest", {
      body: { events: [event] }, cookie,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.acknowledged, [event]);
  });

  it("does not acknowledge a malformed event key", async () => {
    const response = await client.post("/api/wireless/ingest", {
      body: { events: [{ node_id: "quality-start", master_tick: "18446744073709551616", ev_seq: 77 }] }, cookie,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rejected, 1);
    assert.deepEqual(body.acknowledged, []);
  });
});
