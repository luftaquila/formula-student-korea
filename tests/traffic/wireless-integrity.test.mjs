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
  const protocolState = { nodes: new Map(), keys: new Map(), packet: 60000, tick: 0n };
  async function open() {
    state = createTrafficApp({ readWirelessClock: clockReader, dbPath, validateUser: TRUST_JWT });
    const started = await startServer(state.app);
    server = started.server;
    client = wirelessProtocolClient(createClient(started.baseUrl), protocolState);
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
      event_type: "가속", action: "start", start_tick: tick(ms),
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
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wireless_event WHERE flags = 15").get().n, 3);
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
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wireless_event WHERE flags = 15").get().n, 1);
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
      events: [{ ...edge("AABB0002", 105000, 1), flags: 31 }],
      telemetry: [healthy("AABB0001")],
    }, cookie,
  });
  assert.equal(failed.status, 500);
  assert.equal(f.records().length, 0);
  f.db.exec("DROP TRIGGER injected_disarm_failure");
  await f.restart();
  await f.ingest([{ ...edge("AABB0002", 105000, 1), flags: 31 }]);
  assert.equal(f.records().length, 0, "the unacknowledged loss evidence is retried after restart");
});

test("start keeps the selected team after a selection change and restart", async t => {
  const f = await fixture(t);
  const select = num => f.post("/api/wireless/select", {
    event_type: "가속", team: { num, univ: "Integrity University", team: `Team ${num}` },
    event_name: "INTEGRITY",
  });
  await select(1);
  await f.arm();
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

for (const action of ["stop", "reset"]) {
  test(`successful ${action} cancels a pending initial arm`, async t => {
    const requested = Promise.withResolvers();
    const clock = Promise.withResolvers();
    const f = await fixture(t, () => { requested.resolve(); return clock.promise; });
    const arming = f.client.post("/api/wireless/arm", {
      body: { event_type: "가속", action: "start" }, cookie,
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
    event_type: "내구", action: "start", start_tick: tick(90000),
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
    assert.ok(delivered.acknowledged.some(event => event.node_id === finish.node_id && event.ev_seq === finish.ev_seq));
    assert.deepEqual(f.records().map(row => row.result), [5000]);
    // A bridge sends per-node deltas, not a guaranteed complete health snapshot.
    for (const node of ["AABB0002", "0", "AABB0001"]) await f.ingest([], [healthy(node)]);
    const retry = await f.ingest([finish]);
    assert.equal(retry.deduped, 1);
    assert.deepEqual(f.records().map(row => row.result), [5000]);
  });
}

for (const refreshHealth of [false, true]) {
  test(`restart retains captures while diagnostics are stale (refresh=${refreshHealth})`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await fixture(t);
    await f.arm();
    await f.ingest([edge("AABB0001", 100000, 1)]);
    t.mock.timers.tick(13000);
    await f.restart({ refreshHealth });
    const state = await (await f.client.get("/api/wireless/state", { cookie })).json();
    assert.equal(state.sessions.find(s => s.event_type === "가속").armed, true);
    await f.post("/api/wireless/ingest", { events: [edge("AABB0002", 105000, 1)], checkpoints: false });
    assert.equal(f.records().length, 0);
    await f.ingest([]); // reliable source checkpoints cover the captured interval
    assert.deepEqual(f.records().map(row => row.result), [5000]);
  });
}

test("a real quality fault in the first post-restart batch overrides restored healthy diagnostics", async t => {
  const f = await fixture(t);
  await f.arm();
  await f.ingest([edge("AABB0001", 100000, 1)]);
  await f.restart({ refreshHealth: false });
  await f.ingest([{ ...edge("AABB0002", 105000, 1), flags: 31 }], [healthy("AABB0002")]);
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
    body: { event_type: "가속", action: "start", start_tick: tick(110000) }, cookie,
  });
  assert.equal(rejected.status, 409);
  assert.equal(clockCalls, 1, "rejected rearm must not request a hardware boundary");
  const state = await (await f.client.get("/api/wireless/state", { cookie })).json();
  assert.equal(state.sessions.find(s => s.event_type === "가속").run_id, original.run_id);

  await f.post("/api/wireless/arm", { event_type: "가속", action: "stop" });
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
  test(`pending arm tolerates a ${relevant ? "mapped" : "unmapped"} beacon gap`, async t => {
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
        event_type: "가속", action: "start",
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
    assert.equal(response.status, 200);
    await f.ingest([edge("AABB0002", 105000, 1)]);
    assert.deepEqual(f.records().map(row => row.result), [5000]);

  });
}

for (const duration of [1n, 8000000n, 496000000n]) {
  test(`accepts a verified positive interval of ${duration} ticks without race-time bounds`, async t => {
    const f = await fixture(t);
    await f.arm();
    const start = edge("AABB0001", 100000, 1);
    const finish = { ...edge("AABB0002", 100000, 1), master_tick: String(BigInt(start.master_tick) + duration) };
    await f.ingest([start, finish]);
    assert.deepEqual(f.records().map(row => row.result), [Number((duration + 8000n) / 16000n)]);
  });
}

test("wireless controls only expose start, stop, and reset", async t => {
  const f = await fixture(t);
  await f.post("/api/wireless/arm", { event_type: "가속", action: "start" });
  for (const path of ["light", "command"]) {
    assert.equal((await f.client.post(`/api/wireless/${path}`, { cookie, body: {} })).status, 404);
  }
  assert.equal((await f.client.put("/api/wireless/physical-event", { cookie, body: {} })).status, 404);
  await f.post("/api/wireless/arm", { event_type: "가속", action: "stop" });
  await f.post("/api/wireless/arm", { event_type: "가속", action: "reset" });
});

test("first DNS failure rolls back the run identity as well as the record", async t => {
  const f = await fixture(t);
  await f.post("/api/wireless/select", { event_type: "가속", team: {num: 1, univ: "Integrity University", team: "Team A"}, event_name: "INTEGRITY" });
  f.db.exec(`CREATE TEMP TRIGGER fail_engine BEFORE UPDATE OF engine_state ON wireless_session
    BEGIN SELECT RAISE(ABORT, 'injected engine failure'); END`);
  const response = await f.client.post("/api/wireless/status", { cookie, body: {event_type: "가속", status: "DNS"} });
  assert.equal(response.status, 500);
  assert.equal(f.db.prepare("SELECT run_id FROM wireless_session WHERE event_type = '가속'").get().run_id, null);
  assert.equal(f.records().length, 0);
  f.db.exec("DROP TRIGGER fail_engine");
  await f.post("/api/wireless/status", {event_type: "가속", status: "DNS"});
  assert.equal(f.records().length, 1);
});

const evidence = (node, seq, ms, flags = 15) => ({
  node_id: node, ev_seq: seq + (flags === 47 ? 40000 : 0), master_tick: tick(ms),
  master_boot_id: 1, sensor_boot_id: 1, capture_seq: seq, end_seq: seq,
  end_tick: tick(ms), flags, sync_age_ms: 0,
});
test('raw protocol holds a reordered finish until every source proves delivery', async t => {
  const f = await fixture(t);
  await f.arm();
  const send = events => f.post('/api/wireless/ingest', { rawProtocol: true, events });
  await send([evidence('AABB0002', 1, 110000), evidence('AABB0002', 1, 110001, 47)]);
  assert.equal(f.records().length, 0);
  await send([evidence('AABB0001', 1, 100000)]);
  assert.equal(f.records().length, 0);
  await send([evidence('AABB0001', 1, 110001, 47)]);
  assert.deepEqual(f.records(), [{ num: 1, result: 10000 }]);
});

for (const finish of [100000, 99999]) {
  test(`a nonpositive raw start/finish difference (${finish}) cannot become official`, async t => {
    const f = await fixture(t);
    await f.arm();
    await f.ingest([edge('AABB0001', 100000, 1), edge('AABB0002', finish, 1)]);
    assert.equal(f.records().length, 0);
    const state = await (await f.client.get('/api/wireless/state', {cookie})).json();
    assert.equal(state.sessions.find(s => s.event_type === '가속').verification, 'invalid');
  });
}

test('starting one run persists one draft and diagnostics do not rewrite a completed run', async t => {
  const f = await fixture(t);
  f.db.exec(`CREATE TEMP TABLE run_writes (event_type TEXT);
    CREATE TEMP TRIGGER track_run_writes AFTER UPDATE OF engine_state ON wireless_session
    BEGIN INSERT INTO run_writes VALUES (NEW.event_type); END;`);
  await f.arm();
  assert.deepEqual(f.db.prepare('SELECT * FROM run_writes').all(), [{event_type: '가속'}]);
  await f.ingest([edge('AABB0001', 100000, 1), edge('AABB0002', 110000, 1)]);
  f.db.exec('DELETE FROM run_writes');
  await f.refresh();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM run_writes').get().n, 0);
});

test('an unverifiable pre-v9 active run closes on upgrade while its official record survives', async t => {
  const f = await fixture(t);
  await f.arm();
  await f.ingest([edge('AABB0001', 100000, 1), edge('AABB0002', 110000, 1)]);
  f.db.exec("UPDATE wireless_session SET engine_state = json_set(engine_state, '$.version', 8) WHERE event_type = '가속'");
  await f.restart();
  assert.deepEqual(f.records(), [{num: 1, result: 10000}]);
  const state = await (await f.client.get('/api/wireless/state', {cookie})).json();
  assert.equal(state.sessions.find(s => s.event_type === '가속').armed, false);
  await f.arm(120000);
});

test('START waits for a checkpoint from the currently reported sensor boot', async t => {
  const f = await fixture(t);
  await f.post('/api/wireless/ingest', { rawProtocol: true, telemetry: [healthy('AABB0001', {sensor_boot_id: 2})] });
  const result = await f.client.post('/api/wireless/arm', {
    cookie, body: {event_type: '가속', action: 'start', start_tick: tick(90000)},
  });
  assert.equal(result.status, 409);
});

test('a reliable master clock fault closes the active run without diagnostic updates', async t => {
  const f = await fixture(t);
  await f.arm();
  await f.ingest([edge('AABB0001', 100000, 1)]);
  const marker = {node_id: '0', ev_seq: 7, master_tick: tick(100001), end_tick: tick(100001),
    master_boot_id: 1, sensor_boot_id: 1, capture_seq: 0, end_seq: 0, flags: 16, sync_age_ms: 0};
  const saved = await f.post('/api/wireless/ingest', {rawProtocol: true, events: [marker]});
  assert.deepEqual(saved.acknowledged, [{node_id: '0', ev_seq: 7, master_tick: tick(100001), master_boot_id: 1, sensor_boot_id: 1}]);
  const state = await (await f.client.get('/api/wireless/state', {cookie})).json();
  const session = state.sessions.find(s => s.event_type === '가속');
  assert.equal(session.armed, false);
  assert.equal(session.verification, 'invalid');
  assert.equal(f.records().length, 0);
});
