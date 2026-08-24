import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
import { currentCompetitionYear } from "../../shared/competition-year.mjs";
import { createRegistrationApp } from "../../registration/index.mjs";
import { createModuleYearGuard } from "../../competition/lib/year-guard.mjs";
import { ensureCompetitionTeamSchema, TeamStore } from "../../competition/lib/team-store.mjs";

setupTestEnv();
const require = createRequire(import.meta.url);
const Database = require("../../registration/node_modules/better-sqlite3");
const YEAR = currentCompetitionYear();
const cookies = Object.fromEntries(["student", "official", "chief", "admin"].map((role) => [
  role,
  makeAuthCookie({ email: `${role}@test.invalid`, name: role, role }),
]));

const activeFixtures = [];

async function assertStatus(response, expected) {
  if (response.status !== expected) {
    assert.fail(`expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
}

function fakeSmsClient() {
  const messages = [];
  let available = true;
  let failures = 0;
  let deferredSend = null;
  return {
    messages,
    setAvailable(value) { available = value; },
    failNext(count = 1) { failures += count; },
    deferNext() {
      let resolve;
      let reject;
      let markStarted;
      const started = new Promise((done) => { markStarted = done; });
      const result = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
      deferredSend = { markStarted, result };
      return { started, resolve, reject };
    },
    isAvailable() { return available; },
    async loadConfig() { return available; },
    send(phone, content) {
      messages.push({ phone, content });
      if (deferredSend) {
        const pending = deferredSend;
        deferredSend = null;
        pending.markStarted();
        return pending.result;
      }
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(Object.assign(new Error("simulated SENS failure"), { status: 503 }));
      }
      return Promise.resolve({ status: 202, response: "accepted" });
    },
  };
}

async function fixture() {
  const dbPath = tmpDbPath();
  const db = new Database(dbPath);
  ensureCompetitionTeamSchema(db);
  const teamStore = new TeamStore(db);
  const smsClient = fakeSmsClient();
  const guard = createModuleYearGuard({ module: "registration", db });
  const registration = createRegistrationApp({
    db,
    teamStore,
    smsClient,
    validateUser: TRUST_JWT,
    validateUserCacheTtl: 0,
    skipSpaFallback: true,
    mutationGuard: guard,
  });
  const started = await startServer(registration.app);
  const created = {
    dbPath,
    db,
    teamStore,
    smsClient,
    guard,
    registration,
    server: started.server,
    client: createClient(started.baseUrl),
    baseUrl: started.baseUrl,
    team(number, overrides = {}) {
      return teamStore.createTeam(YEAR, {
        number,
        university: overrides.university || `University ${number}`,
        name: overrides.name || `Team ${number}`,
      });
    },
  };
  activeFixtures.push(created);
  return created;
}

async function openQueue(f) {
  const response = await f.client.patch("/api/settings", {
    cookie: cookies.chief,
    body: { year: YEAR, open: true },
  });
  await assertStatus(response, 200);
}

async function register(f, team, phone = "01012345678") {
  const response = await f.client.post("/api/queue", {
    cookie: cookies.chief,
    body: { teamId: team.id, phone },
  });
  await assertStatus(response, 201);
  return response.json();
}

async function openSse(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  await assertStatus(response, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(expected) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1];
          if (event !== expected) continue;
          const data = frame.match(/^data: (.+)$/m)?.[1];
          return data ? JSON.parse(data) : null;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`SSE ended before ${expected}`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close() {
      await reader.cancel();
      controller.abort();
    },
  };
}

afterEach(async () => {
  while (activeFixtures.length) {
    const f = activeFixtures.pop();
    f.registration.closeSse();
    for (const timer of f.registration.timers) clearTimeout(timer);
    await f.registration.drain();
    await stopServer(f.server);
    f.db.close();
    cleanup(f.dbPath);
  }
});

describe("Registration queue", () => {
  it("enforces the public, official, chief, and admin flows", async () => {
    const f = await fixture();
    const team = f.team(11);

    let response = await f.client.get(`/api/status?year=${YEAR}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { year: YEAR, open: false, waiting: 0 });

    response = await f.client.get(`/api/queue?year=${YEAR}`, { cookie: cookies.student });
    assert.equal(response.status, 403);
    response = await f.client.post("/api/queue", {
      cookie: cookies.official,
      body: { teamId: team.id, phone: "01012345678" },
    });
    assert.equal(response.status, 403);

    await openQueue(f);
    const created = await register(f, team);
    assert.equal(created.position, 1);
    response = await f.client.get(`/api/queue?year=${YEAR}`, { cookie: cookies.official });
    await assertStatus(response, 200);
    const board = await response.json();
    assert.equal(board.waiting.length, 1);
    assert.equal(Object.hasOwn(board, "called"), false);
    response = await f.client.post(`/api/queue/${created.id}/call`, { cookie: cookies.official });
    assert.equal(response.status, 404);
    response = await f.client.get(`/api/status?year=${YEAR}`);
    assert.deepEqual(await response.json(), { year: YEAR, open: true, waiting: 1 });
    response = await f.client.post(`/api/queue/${created.id}/done`, { cookie: cookies.official });
    await assertStatus(response, 200);
    response = await f.client.get(`/api/status?year=${YEAR}`);
    assert.deepEqual(await response.json(), { year: YEAR, open: true, waiting: 0 });

    response = await f.client.patch("/api/settings", {
      cookie: cookies.official,
      body: { year: YEAR, open: false },
    });
    assert.equal(response.status, 403);
    response = await f.client.patch("/api/settings", {
      cookie: cookies.admin,
      body: { year: YEAR, open: false },
    });
    assert.equal(response.status, 200);
  });

  it("verifies public lookups with year, entry number, and phone without exposing phone data", async () => {
    const f = await fixture();
    const first = f.team(21);
    const second = f.team(22);
    await openQueue(f);
    await register(f, first, "01011112222");
    await register(f, second, "01033334444");

    let response = await f.client.post("/api/lookup", {
      body: { year: YEAR, num: first.number, phone: "010-1111-2222" },
    });
    await assertStatus(response, 200);
    const result = await response.json();
    assert.equal(result.teamId, first.id);
    assert.equal(result.position, 1);
    assert.equal(result.waitingTotal, 2);
    assert.equal(Object.hasOwn(result, "phone"), false);

    response = await f.client.post("/api/lookup", {
      body: { year: YEAR, num: first.number, phone: "01099999999" },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "REGISTRATION_NOT_FOUND");

    const warning = f.db.prepare(`
      SELECT detail FROM logs
      WHERE module = 'registration' AND action = 'registration.lookup' AND level = 'warn'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(JSON.parse(warning.detail).phone, "010****9999");
    assert.equal(warning.detail.includes("01099999999"), false);
  });

  it("logs only the first rejected lookup in each rate-limit window", async () => {
    const f = await fixture();
    const team = f.team(23);
    await openQueue(f);
    await register(f, team, "01023232323");

    const statuses = [];
    for (let i = 0; i < 62; i += 1) {
      const response = await f.client.post("/api/lookup", {
        headers: { "X-Real-IP": "192.0.2.23" },
        body: { year: YEAR, num: team.number, phone: "01023232323" },
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 60), Array(60).fill(200));
    assert.deepEqual(statuses.slice(60), [429, 429]);

    const warnings = f.db.prepare(`
      SELECT detail FROM logs
      WHERE module = 'registration' AND action = 'registration.lookup' AND level = 'warn'
        AND json_extract(detail, '$.reason') = 'rate_limit'
      ORDER BY id
    `).all();
    assert.equal(warnings.length, 1);
    assert.deepEqual(JSON.parse(warnings[0].detail), {
      reason: "rate_limit",
      count: 61,
      ip: "192.0.2.23",
    });
  });

  it("keeps stable team identity through renumbering and retains the phone in finished history", async () => {
    const f = await fixture();
    const team = f.team(31);
    await openQueue(f);
    const created = await register(f, team, "01055556666");

    const changed = f.teamStore.updateTeam(team.id, { number: 131 });
    assert.equal(changed.after.id, team.id);
    let response = await f.client.post("/api/lookup", {
      body: { year: YEAR, num: 131, phone: "01055556666" },
    });
    await assertStatus(response, 200);
    assert.equal((await response.json()).teamId, team.id);

    response = await f.client.post(`/api/queue/${created.id}/done`, { cookie: cookies.official });
    await assertStatus(response, 200);
    const finished = f.db.prepare(`
      SELECT team_id, phone, status, finished_at FROM registration_queue WHERE id = ?
    `).get(created.id);
    assert.equal(finished.team_id, team.id);
    assert.equal(finished.phone, "01055556666");
    assert.equal(finished.status, "done");
    assert.ok(finished.finished_at);
  });

  it("cancels active registration state on team deactivation while preserving history", async () => {
    const f = await fixture();
    const team = f.team(41);
    await openQueue(f);
    const created = await register(f, team, "01077778888");

    const changed = f.teamStore.updateTeam(team.id, { active: false });
    assert.deepEqual(changed.clearedTransientState, { registration_queue: 1 });
    const retained = f.db.prepare(`
      SELECT team_id, phone, status, finished_at FROM registration_queue WHERE id = ?
    `).get(created.id);
    assert.deepEqual({ ...retained, finished_at: !!retained.finished_at }, {
      team_id: team.id,
      phone: "01077778888",
      status: "canceled",
      finished_at: true,
    });
  });

  it("allows historical reads and rejects every historical mutation using KST year rules", async () => {
    const f = await fixture();
    const oldYear = YEAR - 1;
    const oldTeamId = Number(f.db.prepare(`
      INSERT INTO competition_team (year, num, univ, name) VALUES (?, 51, 'Old U', 'Old Team')
    `).run(oldYear).lastInsertRowid);
    const oldRegistrationId = Number(f.db.prepare(`
      INSERT INTO registration_queue (team_id, phone) VALUES (?, '01012121212')
    `).run(oldTeamId).lastInsertRowid);

    let response = await f.client.post("/api/lookup", {
      body: { year: oldYear, num: 51, phone: "01012121212" },
    });
    await assertStatus(response, 200);

    response = await f.client.post("/api/queue", {
      cookie: cookies.chief,
      body: { teamId: oldTeamId, phone: "01034343434" },
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "YEAR_READ_ONLY");
    response = await f.client.post(`/api/queue/${oldRegistrationId}/done`, { cookie: cookies.official });
    assert.equal(response.status, 409);
    response = await f.client.patch("/api/settings", {
      cookie: cookies.chief,
      body: { year: oldYear, open: true },
    });
    assert.equal(response.status, 409);
  });

  it("classifies the credentialed POST lookup explicitly and fails closed for unknown mutations", async () => {
    const f = await fixture();
    for (const path of ["/api/lookup", "/api/lookup/", "/API/LOOKUP/"]) {
      assert.deepEqual(f.guard({ path, body: { year: YEAR - 1 } }), {
        module: "registration",
        years: [],
      });
    }
    assert.throws(
      () => f.guard({ path: "/api/future-mutation", body: { year: YEAR } }),
      (error) => error.code === "UNKNOWN_REGISTRATION_MUTATION" && error.status === 500,
    );
  });

  it("resolves concurrent transitions with one success and one auditable conflict", async () => {
    const f = await fixture();
    const team = f.team(61);
    await openQueue(f);
    const created = await register(f, team);

    const responses = await Promise.all([
      f.client.post(`/api/queue/${created.id}/done`, { cookie: cookies.official }),
      f.client.post(`/api/queue/${created.id}/done`, { cookie: cookies.official }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(f.db.prepare("SELECT status FROM registration_queue WHERE id = ?").get(created.id).status, "done");
    const conflict = f.db.prepare(`
      SELECT detail FROM logs
      WHERE module = 'registration' AND action = 'registration.done' AND level = 'warn'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.ok(conflict);
  });

  it("matches Queue exact-rank SMS targeting when a registration is completed", async () => {
    const f = await fixture();
    const first = f.team(71);
    const second = f.team(72);
    const third = f.team(73);
    const fourth = f.team(74);
    await openQueue(f);
    const response = await f.client.patch("/api/settings", {
      cookie: cookies.chief,
      body: { year: YEAR, sms: true, notifyRank: 2 },
    });
    await assertStatus(response, 200);

    const firstRegistration = await register(f, first, "01011111111");
    await register(f, second, "01022222222");
    await register(f, third, "01033333333");
    const fourthRegistration = await register(f, fourth, "01044444444");
    await f.registration.drain();
    assert.equal(f.smsClient.messages.length, 0, "joining the configured rank does not send before the queue advances");

    const canceled = await f.client.post(`/api/queue/${fourthRegistration.id}/cancel`, { cookie: cookies.official });
    await assertStatus(canceled, 200);
    await f.registration.drain();
    assert.equal(f.smsClient.messages.length, 0, "a change behind the configured rank does not send a message");

    const completed = await f.client.post(`/api/queue/${firstRegistration.id}/done`, { cookie: cookies.official });
    await assertStatus(completed, 200);
    await f.registration.drain();

    assert.equal(f.smsClient.messages.length, 1);
    const advanceMessage = f.smsClient.messages[0];
    assert.match(advanceMessage.content, /등록 대기 2번째/);
    assert.equal(advanceMessage.phone, "01033333333");
    assert.equal(f.smsClient.messages.some((message) => ["01011111111", "01022222222"].includes(message.phone)), false);
  });

  it("releases a failed exact-rank claim and restricts the rank to Queue limits", async () => {
    const f = await fixture();
    const first = f.team(75);
    const second = f.team(76);
    const third = f.team(77);
    await openQueue(f);
    let response = await f.client.patch("/api/settings", {
      cookie: cookies.chief,
      body: { year: YEAR, sms: true, notifyRank: 1 },
    });
    await assertStatus(response, 200);

    const firstRegistration = await register(f, first, "01044444444");
    const secondRegistration = await register(f, second, "01055555555");
    await register(f, third, "01066666666");
    f.smsClient.failNext();
    response = await f.client.post(`/api/queue/${firstRegistration.id}/cancel`, { cookie: cookies.official });
    await assertStatus(response, 200);
    await f.registration.drain();
    assert.equal(f.db.prepare("SELECT notified FROM registration_queue WHERE id = ?").get(secondRegistration.id).notified, 0);
    assert.equal(f.smsClient.messages.length, 1);

    response = await f.client.patch("/api/settings", {
      cookie: cookies.chief,
      body: { year: YEAR, notifyRank: 2 },
    });
    await assertStatus(response, 200);
    await f.registration.drain();
    assert.equal(f.smsClient.messages.length, 1, "changing the configured rank does not send a message");

    for (const notifyRank of [0, 11]) {
      response = await f.client.patch("/api/settings", {
        cookie: cookies.chief,
        body: { year: YEAR, notifyRank },
      });
      assert.equal(response.status, 400);
    }
  });

  it("does not let an older failed SMS release a replacement claim", async () => {
    const f = await fixture();
    const first = f.team(78);
    const second = f.team(79);
    await openQueue(f);
    let response = await f.client.patch("/api/settings", {
      cookie: cookies.chief,
      body: { year: YEAR, sms: true, notifyRank: 1 },
    });
    await assertStatus(response, 200);

    const firstRegistration = await register(f, first, "01077770001");
    const secondRegistration = await register(f, second, "01077770002");
    const pending = f.smsClient.deferNext();
    response = await f.client.post(`/api/queue/${firstRegistration.id}/done`, { cookie: cookies.official });
    await assertStatus(response, 200);
    await pending.started;

    const original = f.db.prepare(`
      SELECT notified, notify_claimed_at FROM registration_queue WHERE id = ?
    `).get(secondRegistration.id);
    assert.equal(original.notified, 2);
    assert.ok(original.notify_claimed_at);

    const replacementToken = "2099-01-01T00:00:00.000Z";
    f.db.prepare(`
      UPDATE registration_queue SET notify_claimed_at = ? WHERE id = ?
    `).run(replacementToken, secondRegistration.id);
    pending.reject(Object.assign(new Error("first claim timed out"), { status: 503 }));
    await f.registration.drain();

    assert.deepEqual(f.db.prepare(`
      SELECT notified, notify_claimed_at FROM registration_queue WHERE id = ?
    `).get(secondRegistration.id), {
      notified: 2,
      notify_claimed_at: replacementToken,
    });
  });

  it("publishes a distinct entries invalidation so open clients re-query the roster", async () => {
    const f = await fixture();
    const stream = await openSse(`${f.baseUrl}/api/events?year=${YEAR}`);
    try {
      assert.equal((await stream.next("init")).year, YEAR);
      const entriesEvent = stream.next("entries");
      f.registration.sourceEvent("entries", { year: YEAR });
      assert.deepEqual(await entriesEvent, { year: YEAR });
    } finally {
      await stream.close();
    }
  });

  it("ignores source events for other years and other sources", async () => {
    const f = await fixture();
    const stream = await openSse(`${f.baseUrl}/api/events?year=${YEAR}`);
    try {
      assert.equal((await stream.next("init")).year, YEAR);
      f.registration.sourceEvent("entries", { year: YEAR - 1 });
      f.registration.sourceEvent("teams", { year: YEAR });
      const entriesEvent = stream.next("entries");
      f.registration.sourceEvent("entries", { year: YEAR });
      // 다른 연도/다른 소스 이벤트가 먼저 왔더라도 이 연도 스트림이 받는 첫
      // entries 는 마지막 호출뿐이다.
      assert.deepEqual(await entriesEvent, { year: YEAR });
    } finally {
      await stream.close();
    }
  });

  it("publishes the year-scoped public status after a successful mutation", async () => {
    const f = await fixture();
    const team = f.team(81);
    await openQueue(f);
    const stream = await openSse(`${f.baseUrl}/api/events?year=${YEAR}`);
    try {
      const init = await stream.next("init");
      assert.equal(init.year, YEAR);
      const eventPromise = stream.next("registration");
      await register(f, team);
      assert.deepEqual(await eventPromise, { year: YEAR, open: true, waiting: 1 });
    } finally {
      await stream.close();
    }
  });
});
