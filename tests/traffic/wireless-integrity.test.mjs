import test from "node:test";
import assert from "node:assert/strict";
import {
  setupTestEnv, tmpDbPath, makeAuthCookie, createClient,
  startServer, stopServer, cleanup, TRUST_JWT,
} from "../helpers/test-utils.mjs";
import {
  readWirelessClock, wirelessProtocolClient, healthyWirelessTelemetry as healthy,
} from "../helpers/wireless-fixtures.mjs";
import { createTrafficApp } from "../../traffic/index.mjs";

setupTestEnv();
const cookie = makeAuthCookie({ email: "integrity@test.com", name: "Integrity", role: "admin" });
const tick = ms => String(BigInt(ms) * 16000n);
const edge = (node, ms, seq, boot = 1) => ({
  node_id: node, master_tick: tick(ms), ev_seq: seq, flags: 15, master_boot_id: boot,
});

async function fixture(t, clockReader = readWirelessClock) {
  const dbPath = tmpDbPath();
  let state, server, client;
  async function open() {
    state = createTrafficApp({ readWirelessClock: clockReader, dbPath, validateUser: TRUST_JWT });
    const started = await startServer(state.app);
    server = started.server;
    client = wirelessProtocolClient(createClient(started.baseUrl));
  }
  async function close() {
    for (const timer of state.timers) clearInterval(timer);
    state.closeSse();
    await stopServer(server);
    state.db.close();
  }
  await open();
  t.after(async () => { await close(); cleanup(dbPath); });
  const post = async (path, body) => {
    const response = await client.post(path, { body, cookie });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  for (const [node, role] of [["AABB0001", "start"], ["AABB0002", "finish"]]) {
    const response = await client.put(`/api/wireless/mapping/${node}`, {
      body: { event_type: "가속", role }, cookie,
    });
    assert.equal(response.status, 200);
  }
  const refresh = () => post("/api/wireless/ingest", {
    telemetry: [healthy("0"), healthy("AABB0001"), healthy("AABB0002")],
  });
  await refresh();
  return {
    get db() { return state.db; },
    get client() { return client; },
    post, refresh,
    async restart() { await close(); await open(); await refresh(); },
    arm: (ms = 90000) => post("/api/wireless/arm", {
      event_type: "가속", action: "green", green_tick: tick(ms),
      team: { num: 1, univ: "Integrity University", team: "Team A" }, event_name: "INTEGRITY",
    }),
    ingest: (events, telemetry = []) => post("/api/wireless/ingest", { events, telemetry }),
    records: () => state.db.prepare("SELECT num, result FROM record ORDER BY id").all(),
  };
}

test("pre-arm delayed edges must not create a result for the new run", async t => {
  const f = await fixture(t);
  await f.arm(200000);
  await f.ingest([edge("AABB0001", 100000, 1), edge("AABB0002", 105000, 1)]);
  assert.equal(f.records().length, 0);
});

test("a previous master boot cannot contribute an edge even with a newer tick", async t => {
  const f = await fixture(t);
  await f.arm();
  await f.ingest([edge("AABB0001", 100000, 1, 2), edge("AABB0002", 105000, 1)]);
  assert.equal(f.records().length, 0);
  await f.ingest([edge("AABB0001", 100000, 1)]);
  assert.equal(f.records()[0]?.result, 5000);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wireless_event").get().n, 3);
});

for (const restart of [false, true]) {
  test(`finish before start preserves the interval${restart ? " across restart" : " and retry"}`, async t => {
    const f = await fixture(t);
    await f.arm();
    const finish = edge("AABB0002", 102000, 1);
    await f.ingest([finish]);
    if (restart) await f.restart();
    await f.ingest([edge("AABB0001", 100000, 1)]);
    const retry = await f.ingest([finish]);
    assert.equal(retry.stored, 0);
    assert.deepEqual(f.records().map(row => row.result), [2000]);
  });
}

test("failed official record write withholds ACK and retries the same captured interval", async t => {
  const f = await fixture(t);
  await f.arm();
  await f.ingest([edge("AABB0001", 100000, 1)]);
  f.db.exec(`CREATE TEMP TRIGGER injected_record_failure BEFORE INSERT ON record
    BEGIN SELECT RAISE(ABORT, 'injected record failure'); END`);
  const finish = edge("AABB0002", 105000, 1);
  const failed = await f.client.post("/api/wireless/ingest", { body: { events: [finish] }, cookie });
  assert.equal(failed.status, 500);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wireless_event").get().n, 1);
  f.db.exec("DROP TRIGGER injected_record_failure");
  await f.restart();
  const retry = await f.ingest([finish]);
  assert.equal(retry.stored, 1);
  await f.ingest([edge("AABB0002", 106000, 2)]);
  assert.deepEqual(f.records().map(row => row.result), [5000]);
});

test("quality disarm DB failure must not allow an unhealthy finish to become official", async t => {
  const f = await fixture(t);
  await f.arm();
  await f.ingest([edge("AABB0001", 100000, 1)]);
  f.db.exec(`CREATE TEMP TRIGGER injected_disarm_failure BEFORE UPDATE OF armed ON wireless_session
    WHEN NEW.armed = 0 BEGIN SELECT RAISE(ABORT, 'injected disarm failure'); END`);
  const failed = await f.client.post("/api/wireless/ingest", {
    body: {
      events: [edge("AABB0002", 105000, 1)],
      telemetry: [healthy("AABB0001", { capture_overflow: 1 })],
    }, cookie,
  });
  assert.equal(failed.status, 500);
  assert.equal(f.records().length, 0);
  f.db.exec("DROP TRIGGER injected_disarm_failure");
  await f.restart();
  await f.ingest([edge("AABB0002", 105000, 1)]);
  assert.equal(f.records().length, 0, "healthy retry cannot revive the faulted run");
});

test("physical arm keeps the selected team after a selection change and restart", async t => {
  const f = await fixture(t);
  const select = num => f.post("/api/wireless/select", {
    event_type: "가속", team: { num, univ: "Integrity University", team: `Team ${num}` },
    event_name: "INTEGRITY",
  });
  await select(1);
  f.db.prepare("UPDATE wireless_light SET owner_event = '가속' WHERE id = 1").run();
  await f.post("/api/wireless/light", { color: "green", green_tick: tick(90000) });
  await f.ingest([edge("AABB0001", 100000, 1)]);
  await select(2);
  await f.restart();
  await f.ingest([edge("AABB0002", 105000, 1)]);
  assert.equal(f.records()[0]?.num, 1);
});


test("an edge committed while the arm clock response is in flight is applied once", async t => {
  const requested = Promise.withResolvers();
  const response = Promise.withResolvers();
  const f = await fixture(t, () => { requested.resolve(); return response.promise; });
  const arming = f.arm();
  await requested.promise;
  await f.ingest([edge("AABB0001", 100000, 1)]);
  response.resolve({ master_tick: tick(90000), master_boot_id: 1 });
  await arming;
  await f.ingest([edge("AABB0002", 105000, 1)]);
  assert.deepEqual(f.records().map(row => row.result), [5000]);
});
