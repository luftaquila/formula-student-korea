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
    async restart({ refreshHealth = true } = {}) {
      await close();
      await open();
      if (refreshHealth) await refresh();
    },
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

for (const action of ["red", "off", "reset"]) {
  test(`successful ${action} cancels a pending initial arm`, async t => {
    const requested = Promise.withResolvers();
    const clock = Promise.withResolvers();
    const f = await fixture(t, () => { requested.resolve(); return clock.promise; });
    const arming = f.client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "green" }, cookie,
    });
    await requested.promise;
    await f.post("/api/wireless/arm", { event_type: "가속", action });
    clock.resolve({ master_tick: tick(90000), master_boot_id: 1 });
    const response = await arming;
    assert.equal(response.status, 409);
    const state = await (await f.client.get("/api/wireless/state", { cookie })).json();
    assert.equal(state.sessions.find(s => s.event_type === "가속").armed, false);
  });
}

async function enduranceFixture(t) {
  const f = await fixture(t);
  await f.client.put("/api/wireless/mapping/AABB0001", {
    body: { event_type: "내구", role: "start" }, cookie,
  });
  await f.post("/api/wireless/arm", {
    event_type: "내구", action: "green", green_tick: tick(90000),
    team: { num: 1, univ: "Integrity University", team: "Team A" }, event_name: "INTEGRITY",
  });
  await f.ingest([edge("AABB0001", 100000, 1), edge("AABB0001", 160000, 2)]);
  const row = f.db.prepare("SELECT name, legacy_rowid FROM record").get();
  const patch = value => f.client.patch(`/api/records/${encodeURIComponent(row.name)}/${row.legacy_rowid}`, {
    body: { field: "status", value }, cookie,
  });
  return { f, patch };
}

for (const classify of ["status", "patch"]) {
  test(`${classify} finalization stays final after restoring normal status and restarting`, async t => {
    const { f, patch } = await enduranceFixture(t);
    if (classify === "status") await f.post("/api/wireless/status", { event_type: "내구", status: "DNF" });
    else assert.equal((await patch("DNF")).status, 200);
    assert.equal((await patch(null)).status, 200);
    await f.restart();
    await f.ingest([edge("AABB0001", 220000, 3)]);
    assert.deepEqual(f.records().map(row => row.result), [60000]);
  });
}

for (const classify of ["status", "patch"]) {
  test(`${classify} rolls back classification when finalization cannot be persisted`, async t => {
    const { f, patch } = await enduranceFixture(t);
    f.db.exec(`CREATE TEMP TRIGGER fail_finalization BEFORE UPDATE OF engine_state ON wireless_session
      BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END`);
    const response = classify === "status"
      ? await f.client.post("/api/wireless/status", { body: { event_type: "내구", status: "DNF" }, cookie })
      : await patch("DNF");
    assert.equal(response.status, 500);
    assert.equal(f.db.prepare("SELECT status FROM record").get().status, null);
    f.db.exec("DROP TRIGGER fail_finalization");
    await f.ingest([edge("AABB0001", 220000, 3)]);
    assert.deepEqual(f.records().map(row => row.result), [120000]);
  });
}


for (const partialRefresh of [false, true]) {
  test(`restart accepts a queued finish with ${partialRefresh ? "partial" : "no"} fresh diagnostic deltas`, async t => {
    const f = await fixture(t);
    await f.arm();
    await f.ingest([edge("AABB0001", 100000, 1)]);
    await f.restart({ refreshHealth: false });
    if (partialRefresh) await f.ingest([], [healthy("AABB0002")]);
    const finish = edge("AABB0002", 105000, 1);
    const delivered = await f.ingest([finish]);
    assert.equal(delivered.acknowledged.length, 1);
    assert.deepEqual(f.records().map(row => row.result), [5000]);
    // A bridge sends per-node deltas, not a guaranteed complete health snapshot.
    for (const node of ["AABB0002", "0", "AABB0001"]) await f.ingest([], [healthy(node)]);
    const retry = await f.ingest([finish]);
    assert.equal(retry.deduped, 1);
    assert.deepEqual(f.records().map(row => row.result), [5000]);
  });
}

test("restart preserves diagnostic age and rejects an expired healthy snapshot", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t);
  await f.arm();
  await f.ingest([edge("AABB0001", 100000, 1)]);
  t.mock.timers.tick(13000);
  await f.restart({ refreshHealth: false });
  await f.ingest([edge("AABB0002", 105000, 1)]);
  assert.equal(f.records().length, 0);
  await f.refresh();
  await f.ingest([edge("AABB0002", 105000, 1)]);
  assert.equal(f.records().length, 0, "fresh diagnostics cannot revive a stopped run");
});

test("a real quality fault in the first post-restart batch overrides restored healthy diagnostics", async t => {
  const f = await fixture(t);
  await f.arm();
  await f.ingest([edge("AABB0001", 100000, 1)]);
  await f.restart({ refreshHealth: false });
  await f.ingest([edge("AABB0002", 105000, 1)], [healthy("AABB0002", { event_drop: 1 })]);
  assert.equal(f.records().length, 0);
  await f.refresh();
  await f.ingest([edge("AABB0002", 106000, 2)]);
  assert.equal(f.records().length, 0);
});

test("active runs reject rearm before clock capture; stopping allows one new run to own in-flight edges", async t => {
  const requested = Promise.withResolvers();
  const clock = Promise.withResolvers();
  let clockCalls = 0;
  let delayClock = false;
  const f = await fixture(t, options => {
    clockCalls++;
    if (!delayClock) return readWirelessClock(options);
    requested.resolve();
    return clock.promise;
  });
  const original = await f.arm(90000);
  await f.ingest([edge("AABB0001", 100000, 1)]);
  const rejected = await f.client.post("/api/wireless/arm", {
    body: { event_type: "가속", action: "green", green_tick: tick(110000) }, cookie,
  });
  assert.equal(rejected.status, 409);
  assert.equal(clockCalls, 1, "rejected rearm must not request a hardware boundary");
  const state = await (await f.client.get("/api/wireless/state", { cookie })).json();
  assert.equal(state.sessions.find(s => s.event_type === "가속").run_id, original.run_id);

  await f.post("/api/wireless/arm", { event_type: "가속", action: "off" });
  delayClock = true;
  const arming = f.arm(110000);
  await requested.promise;
  await f.ingest([edge("AABB0001", 120000, 2), edge("AABB0002", 125000, 1)]);
  assert.equal(f.records().length, 0);
  clock.resolve({ master_tick: tick(110000), master_boot_id: 1 });
  const next = await arming;
  assert.notEqual(next.run_id, original.run_id);
  assert.deepEqual(f.records().map(row => row.result), [5000]);
});

for (const relevant of [true, false]) {
  test(`pending arm ${relevant ? "latches a relevant" : "ignores an unrelated"} quality fault despite later recovery`, async t => {
    const requested = Promise.withResolvers();
    const clock = Promise.withResolvers();
    let clockCalls = 0;
    const f = await fixture(t, options => {
      if (++clockCalls > 1) return readWirelessClock(options);
      requested.resolve();
      return clock.promise;
    });
    const arming = f.client.post("/api/wireless/arm", {
      body: {
        event_type: "가속", action: "green",
        team: { num: 1, univ: "Integrity University", team: "Team A" }, event_name: "INTEGRITY",
      }, cookie,
    });
    await requested.promise;
    await f.ingest([edge("AABB0001", 100000, 1)], [
      healthy(relevant ? "AABB0001" : "UNMAPPED", { beacon_gap: 1 }),
    ]);
    await f.refresh();
    clock.resolve({ master_tick: tick(99900), master_boot_id: 1 });
    const response = await arming;
    assert.equal(response.status, relevant ? 409 : 200);
    await f.ingest([edge("AABB0002", 105000, 1)]);
    assert.deepEqual(f.records().map(row => row.result), relevant ? [] : [5000]);
    if (relevant) {
      // The failure belongs to that request, not a later healthy attempt.
      await f.arm(110000);
      await f.ingest([edge("AABB0001", 120000, 2), edge("AABB0002", 125000, 2)]);
      assert.deepEqual(f.records().map(row => row.result), [5000]);
    }
  });
}
