import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createClient, makeAuthCookie, setupTestEnv, startServer, stopServer, TRUST_JWT,
} from "../helpers/test-utils.mjs";
import { healthyWirelessBatch } from "../helpers/wireless-fixtures.mjs";
import { currentCompetitionYear } from "../../shared/competition-year.mjs";
import { validateCompetitionDatabase } from "../../competition/lib/database-validation.mjs";

setupTestEnv();
const { createCompetitionApp, createShutdownHandler } = await import("../../competition/index.mjs");
const require = createRequire(import.meta.url);
const Database = require("../../competition/node_modules/better-sqlite3");
const YEAR = currentCompetitionYear();

function validateArtifact(dbPath) {
  const reader = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { validateCompetitionDatabase(reader); }
  finally { reader.close(); }
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-competition-test-"));
  const staticRoots = {};
  for (const name of ["entry", "queue", "registration", "inspection", "traffic", "score", "documents"]) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "index.html"), `<html>${name}</html>`);
    staticRoots[name] = directory;
  }
  return { root, staticRoots, dbPath: path.join(root, "competition.db"), uploadRoot: path.join(root, "uploads") };
}

async function openSse(url, cookie) {
  const controller = new AbortController();
  const response = await fetch(url, {
    signal: controller.signal,
    headers: cookie ? { Cookie: cookie } : {},
  });
  if (response.status !== 200) assert.fail(`SSE ${url} returned ${response.status}: ${await response.text()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function nextEvent() {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const raw = frame.match(/^data: (.+)$/m)?.[1];
        return { event, data: raw ? JSON.parse(raw) : null };
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream ended before the expected event");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  return {
    nextEvent,
    async close() {
      await reader.cancel();
      controller.abort();
    },
  };
}

async function nextNamedEvent(stream, expected) {
  return Promise.race([
    (async () => {
      for (;;) {
        const event = await stream.nextEvent();
        if (event.event === expected) return event;
      }
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`SSE ${expected} timeout`)), 2000)),
  ]);
}

describe("Competition modular monolith", () => {
  const fixtures = [];
  after(() => fixtures.forEach(({ root }) => fs.rmSync(root, { recursive: true, force: true })));

  async function exerciseSubmissionRace(mutate) {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    let runMutation = () => {};
    const created = createCompetitionApp({
      dbPath: fixture.dbPath,
      staticRoots: fixture.staticRoots,
      uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT,
      enableNotificationScheduler: false,
      beforeSubmissionMetadataCommit: () => runMutation(),
    });
    const team = created.teams.createTeam(YEAR, {
      number: 71,
      university: "Race University",
      name: "Original Team",
    });
    created.db.prepare(`
      INSERT INTO student_team (email, team_num, year, team_id)
      VALUES ('upload-race@test.invalid', 71, ?, ?)
    `).run(YEAR, team.id);
    const sessionId = Number(created.db.prepare(`
      INSERT INTO session (name, notice, start_at, end_at, late_end_at, created_by, year)
      VALUES ('Upload race', '', '2020-01-01T00:00:00.000Z',
              '2030-01-01T00:00:00.000Z', '', 'chief@test.invalid', ?)
    `).run(YEAR).lastInsertRowid);
    created.db.prepare(`
      INSERT INTO session_team (session_id, team_num, team_id) VALUES (?, 71, ?)
    `).run(sessionId, team.id);
    let mutated = false;
    runMutation = () => {
      assert.equal(mutated, false, "the controlled race must run exactly once");
      mutated = true;
      mutate({ created, team, sessionId });
    };

    const started = await startServer(created.app);
    try {
      const form = new FormData();
      form.append("files", new Blob(["race payload"], { type: "application/pdf" }), "race.pdf");
      const response = await fetch(
        `${started.baseUrl}/competition/api/v1/documents/sessions/${sessionId}/submit`,
        {
          method: "POST",
          headers: {
            Cookie: makeAuthCookie({
              email: "upload-race@test.invalid",
              name: "Upload Race",
              role: "student",
            }),
          },
          body: form,
        },
      );
      assert.equal(response.status, 409, await response.text());
      assert.equal(mutated, true);
      assert.equal(created.db.prepare("SELECT COUNT(*) AS count FROM submission").get().count, 0);
      assert.equal(created.db.prepare("SELECT COUNT(*) AS count FROM submission_file").get().count, 0);
      assert.deepEqual(fs.readdirSync(path.join(fixture.uploadRoot, "_tmp")), []);
      assert.equal(fs.existsSync(path.join(fixture.uploadRoot, String(sessionId))), false);
      const warning = created.db.prepare(`
        SELECT detail FROM logs
        WHERE action = 'submission.create' AND level = 'warn'
          AND json_extract(detail, '$.phase') = 'metadata_revalidation'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.ok(warning);
      const audit = JSON.parse(warning.detail);
      assert.equal(audit.error, "stale_submission_preflight");
      assert.equal(audit.expected.mapping.team_id, team.id);
      assert.equal(audit.expected.mapping.team_num, 71);
      return audit;
    } finally {
      await stopServer(started.server);
      await created.close();
    }
  }

  it("rejects an upload when its stable student-team mapping is removed while streaming", async () => {
    const audit = await exerciseSubmissionRace(({ created }) => {
      created.db.prepare(`
        DELETE FROM student_team WHERE email = 'upload-race@test.invalid' AND year = ?
      `).run(YEAR);
    });
    assert.equal(audit.current.mapping, null);
  });

  it("rejects an upload when its stable session target is removed while streaming", async () => {
    const audit = await exerciseSubmissionRace(({ created, sessionId, team }) => {
      created.db.prepare("DELETE FROM session_team WHERE session_id = ? AND team_id = ?")
        .run(sessionId, team.id);
    });
    assert.equal(audit.current.target, null);
  });

  it("rejects an upload when the session deadline closes while streaming", async () => {
    const audit = await exerciseSubmissionRace(({ created, sessionId }) => {
      created.db.prepare(`
        UPDATE session
        SET end_at = '2000-01-01T00:00:00.000Z', late_end_at = ''
        WHERE id = ?
      `).run(sessionId);
    });
    assert.equal(audit.current.session.end_at, "2000-01-01T00:00:00.000Z");
  });

  it("rejects renumber-and-reuse without binding upload metadata to the replacement team", async () => {
    const audit = await exerciseSubmissionRace(({ created, team }) => {
      created.teams.updateTeam(team.id, { number: 72 });
      created.teams.createTeam(YEAR, {
        number: 71,
        university: "Replacement University",
        name: "Replacement Team",
      });
    });
    assert.equal(audit.current.mapping.team_id, audit.expected.mapping.team_id);
    assert.equal(audit.current.mapping.team_num, 72);
    assert.equal(audit.current.canonical_team.team_num, 72);
  });

  it("exposes one flat API with stable team IDs and no finalize or legacy Entry routes", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath,
      staticRoots: fixture.staticRoots,
      uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT,
      enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const client = createClient(baseUrl);
    const admin = makeAuthCookie({ email: "admin@test.invalid", name: "Admin", role: "admin" });
    try {
      const meta = await client.get("/competition/api/v1/meta");
      assert.equal(meta.status, 200);
      assert.equal((await meta.json()).currentYear, YEAR);

      const typeResponse = await client.post(`/competition/api/v1/vehicle-types?year=${YEAR}`, {
        cookie: admin, body: { name: "C-Formula", color: "red" },
      });
      assert.equal(typeResponse.status, 201, await typeResponse.clone().text());
      const type = await typeResponse.json();

      const createResponse = await client.post(`/competition/api/v1/teams?year=${YEAR}`, {
        cookie: admin,
        body: { number: 7, university: "Test University", name: "Seven", vehicleTypeId: type.id },
      });
      assert.equal(createResponse.status, 201, await createResponse.clone().text());
      const team = await createResponse.json();
      assert.equal(team.number, 7);
      assert.equal(Object.hasOwn(team, "version"), false);

      const duplicate = await client.post(`/competition/api/v1/teams?year=${YEAR}`, {
        cookie: admin,
        body: { number: 7, university: "Duplicate", name: "Duplicate" },
      });
      assert.equal(duplicate.status, 409);
      const failedCreateLog = created.db.prepare(`
        SELECT level, target, detail FROM logs
        WHERE module = 'entry' AND action = 'team.create'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(failedCreateLog.level, "warn");
      assert.equal(failedCreateLog.target, "#7");
      assert.equal(JSON.parse(failedCreateLog.detail).requested.number, 7);

      const updateResponse = await client.patch(`/competition/api/v1/teams/${team.id}`, {
        cookie: admin, body: { number: 8, active: false },
      });
      assert.equal(updateResponse.status, 200, await updateResponse.clone().text());
      const updated = await updateResponse.json();
      assert.equal(updated.id, team.id);
      assert.equal(updated.number, 8);
      assert.equal(updated.active, false);
      const updateLog = created.db.prepare(`
        SELECT level, detail FROM logs
        WHERE module = 'entry' AND action = 'team.update' AND target = ?
        ORDER BY id DESC LIMIT 1
      `).get(String(team.id));
      assert.equal(updateLog.level, "info");
      assert.equal(JSON.parse(updateLog.detail).after.active, false);

      const listed = await client.get(`/competition/api/v1/teams?year=${YEAR}&includeInactive=true`, { cookie: admin });
      assert.deepEqual((await listed.json()).map(({ id, number }) => ({ id, number })), [{ id: team.id, number: 8 }]);

      const exported = await client.get(`/competition/api/v1/teams/export?year=${YEAR}`, { cookie: admin });
      assert.equal(exported.status, 200);
      assert.equal((await exported.json()).year, YEAR);

      for (const pathname of [
        "/competition/api/v1/teams?year=not-a-year",
        "/competition/api/v1/teams/export?year=not-a-year",
        "/competition/api/v1/vehicle-types?year=not-a-year",
      ]) {
        const failedRead = await client.get(pathname, { cookie: admin });
        assert.equal(failedRead.status, 400, pathname);
      }
      const missingTeam = await client.get("/competition/api/v1/teams/999999", { cookie: admin });
      assert.equal(missingTeam.status, 404);
      const readFailureLogs = created.db.prepare(`
        SELECT action, level, detail FROM logs
        WHERE module = 'entry'
          AND action IN ('team.list', 'team.export', 'team.get', 'vehicle_type.list')
        ORDER BY action
      `).all();
      assert.deepEqual(readFailureLogs.map(({ action, level }) => ({ action, level })), [
        { action: "team.export", level: "warn" },
        { action: "team.get", level: "warn" },
        { action: "team.list", level: "warn" },
        { action: "vehicle_type.list", level: "warn" },
      ]);
      assert.equal(JSON.parse(readFailureLogs.find(({ action }) => action === "team.get").detail).id, "999999");
      for (const log of readFailureLogs.filter(({ action }) => action !== "team.get")) {
        assert.equal(JSON.parse(log.detail).requestedYear, "not-a-year");
      }

      for (const [method, url] of [
        ["get", `/competition/api/v1/teams/api/entries?year=${YEAR}`],
        ["get", `/competition/api/v1/queue/api/state`],
        ["patch", `/competition/api/v1/roster?year=${YEAR}`],
        ["get", `/entry/api/entries?year=${YEAR}`],
      ]) {
        const response = await client[method](url, { cookie: admin, body: method === "patch" ? {} : undefined });
        assert.equal(response.status, 404, `${method.toUpperCase()} ${url}`);
      }
    } finally {
      await stopServer(server);
      created.close();
    }
  });

  it("invalidates cached scores and signals every open team consumer after a canonical renumber", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const client = createClient(baseUrl);
    const admin = makeAuthCookie({ email: "admin@test.invalid", name: "Admin", role: "admin" });
    const streams = [];
    try {
      const typeResponse = await client.post(`/competition/api/v1/vehicle-types?year=${YEAR}`, {
        cookie: admin, body: { name: "Before Type", color: "red" },
      });
      assert.equal(typeResponse.status, 201, await typeResponse.clone().text());
      const vehicleType = await typeResponse.json();
      const teamResponse = await client.post(`/competition/api/v1/teams?year=${YEAR}`, {
        cookie: admin,
        body: {
          number: 71,
          university: "Before University",
          name: "Before Team",
          vehicleTypeId: vehicleType.id,
        },
      });
      assert.equal(teamResponse.status, 201, await teamResponse.clone().text());
      const team = await teamResponse.json();
      const publication = await client.put("/competition/api/v1/score/score/publication", {
        cookie: admin, body: { year: YEAR, enabled: true },
      });
      assert.equal(publication.status, 200, await publication.clone().text());
      const cached = await client.get(`/competition/api/v1/score/score/public/${YEAR}`);
      assert.equal(cached.status, 200, await cached.clone().text());
      assert.deepEqual((await cached.json()).entries[71], {
        univ: "Before University", team: "Before Team", type: "Before Type",
      });

      const endpoints = [
        [`${baseUrl}/competition/api/v1/queue/events`, null, "entries"],
        [`${baseUrl}/competition/api/v1/registration/events?year=${YEAR}`, null, "registration"],
        [`${baseUrl}/competition/api/v1/inspection/sheet/events`, admin, "entries"],
        [`${baseUrl}/competition/api/v1/traffic/events`, admin, "entries"],
        [`${baseUrl}/competition/api/v1/score/score/public/${YEAR}/events`, null, "refresh"],
      ];
      for (const [url, cookie] of endpoints) {
        const stream = await openSse(url, cookie);
        streams.push(stream);
        assert.equal((await stream.nextEvent()).event, "init");
      }

      created.db.prepare(`
        INSERT INTO inspection_queue (inspection, num, phone, timestamp, year)
        VALUES ('battery', 71, '01011112222', 1, ?)
      `).run(YEAR);
      created.db.prepare(`
        INSERT INTO booth_log
          (num, inspection, booth_num, entered_at, exited_at, created_at, year, team_id)
        VALUES (71, 'battery', 1, 1, NULL, 1, ?, ?)
      `).run(YEAR, team.id);
      created.db.prepare(`
        INSERT INTO booth (inspection, booth_num, active, occupied_by, occupied_team_id, entered_at)
        VALUES ('battery', 1, 1, 71, ?, 1)
        ON CONFLICT(inspection, booth_num) DO UPDATE SET
          active = excluded.active, occupied_by = excluded.occupied_by,
          occupied_team_id = excluded.occupied_team_id, entered_at = excluded.entered_at
      `).run(team.id);
      const update = await client.patch(`/competition/api/v1/teams/${team.id}`, {
        cookie: admin,
        body: { number: 72, university: "After University", name: "After Team" },
      });
      assert.equal(update.status, 200, await update.clone().text());

      for (let index = 0; index < streams.length; index++) {
        const event = await nextNamedEvent(streams[index], endpoints[index][2]);
        if (["entries", "registration"].includes(event.event)) assert.equal(event.data.year, YEAR);
      }
      const refreshed = await client.get(`/competition/api/v1/score/score/public/${YEAR}`);
      assert.equal(refreshed.status, 200, await refreshed.clone().text());
      const publicPayload = await refreshed.json();
      assert.equal(publicPayload.entries[71], undefined);
      assert.deepEqual(publicPayload.entries[72], {
        univ: "After University", team: "After Team", type: "Before Type",
      });
      assert.equal(created.db.prepare("SELECT num FROM inspection_queue").get().num, 72);
      assert.equal(created.db.prepare("SELECT occupied_by FROM booth WHERE inspection = 'battery' AND booth_num = 1").get().occupied_by, 72);

      const typeUpdate = await client.patch(`/competition/api/v1/vehicle-types/${vehicleType.id}`, {
        cookie: admin, body: { name: "After Type" },
      });
      assert.equal(typeUpdate.status, 200, await typeUpdate.clone().text());
      const afterType = await client.get(`/competition/api/v1/score/score/public/${YEAR}`);
      assert.equal(afterType.status, 200, await afterType.clone().text());
      assert.equal((await afterType.json()).entries[72].type, "After Type");

      const deactivate = await client.patch(`/competition/api/v1/teams/${team.id}`, {
        cookie: admin, body: { active: false },
      });
      assert.equal(deactivate.status, 200, await deactivate.clone().text());
      assert.equal(created.db.prepare("SELECT COUNT(*) AS count FROM inspection_queue").get().count, 0);
      assert.equal(created.db.prepare("SELECT occupied_by FROM booth WHERE inspection = 'battery' AND booth_num = 1").get().occupied_by, null);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
      await stopServer(server);
      await created.close();
    }
  });

  it("allows operational writes before the event and rejects noncurrent-year mutations", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const client = createClient(baseUrl);
    const admin = makeAuthCookie({ email: "admin@test.invalid", name: "Admin", role: "admin" });
    try {
      const current = await client.post("/competition/api/v1/inspection/sheet/template", {
        cookie: admin, body: { year: YEAR, level: "category", name: "Safety" },
      });
      assert.equal(current.status, 200, await current.clone().text());

      const old = await client.post("/competition/api/v1/inspection/sheet/template", {
        cookie: admin, body: { year: YEAR - 1, level: "category", name: "Old" },
      });
      assert.equal(old.status, 409, await old.clone().text());
      assert.equal((await old.json()).code, "YEAR_READ_ONLY");
      assert.equal(created.db.prepare("SELECT COUNT(*) AS count FROM sheet_template WHERE year = ?").get(YEAR - 1).count, 0);

      created.db.prepare(`
        INSERT INTO sheet_template (year, level, name, sort_order) VALUES (?, 'category', 'Historical Safety', 0)
      `).run(YEAR - 1);
      created.db.prepare("DELETE FROM sheet_template WHERE year = ?").run(YEAR);
      const copy = await client.post("/competition/api/v1/inspection/sheet/template/copy", {
        cookie: admin, body: { from_year: YEAR - 1, to_year: YEAR },
      });
      assert.equal(copy.status, 201, await copy.clone().text());
      assert.equal(
        created.db.prepare("SELECT name FROM sheet_template WHERE year = ?").get(YEAR).name,
        "Historical Safety",
      );
    } finally {
      await stopServer(server);
      created.close();
    }
  });

  it("normalizes persisted prior-year booth occupancy without touching either year history", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const client = createClient(baseUrl);
    const official = makeAuthCookie({ email: "official@test.invalid", name: "Official", role: "official" });
    const previousYear = YEAR - 1;
    try {
      const replacement = created.teams.createTeam(YEAR, {
        number: 81, university: "Replacement University", name: "Replacement Team",
      });
      const historicalWithReplacement = Number(created.db.prepare(`
        INSERT INTO competition_team (year, num, univ, name)
        VALUES (?, 81, 'Historical University', 'Historical Team')
      `).run(previousYear).lastInsertRowid);
      const historicalWithoutReplacement = Number(created.db.prepare(`
        INSERT INTO competition_team (year, num, univ, name)
        VALUES (?, 82, 'Historical Only University', 'Historical Only Team')
      `).run(previousYear).lastInsertRowid);
      created.db.prepare(`
        INSERT INTO booth (inspection, booth_num, active) VALUES ('battery', 2, 1)
      `).run();
      const insertLog = created.db.prepare(`
        INSERT INTO booth_log
          (num, inspection, booth_num, entered_at, exited_at, created_at, year, team_id)
        VALUES (?, 'battery', ?, 1, NULL, 1, ?, ?)
      `);
      insertLog.run(81, 1, previousYear, historicalWithReplacement);
      insertLog.run(82, 2, previousYear, historicalWithoutReplacement);
      const occupy = created.db.prepare(`
        UPDATE booth
        SET occupied_by = ?, occupied_team_id = ?, entered_at = 1,
            timer_paused_at = 4, timer_paused_ms = 2
        WHERE inspection = 'battery' AND booth_num = ?
      `);
      occupy.run(81, historicalWithReplacement, 1);
      occupy.run(82, historicalWithoutReplacement, 2);
      validateArtifact(fixture.dbPath);

      for (const boothNum of [1, 2]) {
        const response = await client.post(
          `/competition/api/v1/queue/admin/booths/battery/${boothNum}/exit`,
          { cookie: official },
        );
        assert.equal(response.status, 200, await response.clone().text());
      }

      assert.deepEqual(created.db.prepare(`
        SELECT booth_num, occupied_by, occupied_team_id, entered_at, timer_paused_at, timer_paused_ms
        FROM booth WHERE inspection = 'battery' AND booth_num IN (1, 2) ORDER BY booth_num
      `).all(), [
        { booth_num: 1, occupied_by: null, occupied_team_id: null, entered_at: null, timer_paused_at: null, timer_paused_ms: 0 },
        { booth_num: 2, occupied_by: null, occupied_team_id: null, entered_at: null, timer_paused_at: null, timer_paused_ms: 0 },
      ]);
      assert.equal(created.db.prepare(`
        SELECT COUNT(*) AS count FROM booth_log
        WHERE year = ? AND num IN (81, 82) AND exited_at IS NULL
      `).get(previousYear).count, 0);
      assert.equal(created.db.prepare(`
        SELECT COUNT(*) AS count FROM inspection_history WHERE num IN (81, 82)
      `).get().count, 0);
      assert.equal(created.db.prepare(`
        SELECT COUNT(*) AS count FROM inspection_history WHERE team_id = ?
      `).get(replacement.id).count, 0);

      const audits = created.db.prepare(`
        SELECT target, detail FROM logs
        WHERE action = 'booth.exit' AND level = 'info' AND target IN ('#81', '#82')
        ORDER BY target
      `).all();
      assert.deepEqual(audits.map(({ target, detail }) => ({ target, ...JSON.parse(detail) })), [
        {
          target: "#81",
          team: {
            id: historicalWithReplacement, year: previousYear, number: 81,
            university: "Historical University", name: "Historical Team", active: true,
          },
          inspection: "battery", booth: 1,
          team_id: historicalWithReplacement, team_num: 81,
          state_year: previousYear, current_year: YEAR,
          normalized_historical_state: true,
          before: {
            occupied_by: 81, occupied_team_id: historicalWithReplacement, entered_at: 1,
            timer_paused_at: 4, timer_paused_ms: 2,
          },
          after: {
            occupied_by: null, occupied_team_id: null, entered_at: null,
            timer_paused_at: null, timer_paused_ms: 0,
          },
          open_log: { action: "deleted_incomplete", count: 1 },
        },
        {
          target: "#82",
          team: {
            id: historicalWithoutReplacement, year: previousYear, number: 82,
            university: "Historical Only University", name: "Historical Only Team", active: true,
          },
          inspection: "battery", booth: 2,
          team_id: historicalWithoutReplacement, team_num: 82,
          state_year: previousYear, current_year: YEAR,
          normalized_historical_state: true,
          before: {
            occupied_by: 82, occupied_team_id: historicalWithoutReplacement, entered_at: 1,
            timer_paused_at: 4, timer_paused_ms: 2,
          },
          after: {
            occupied_by: null, occupied_team_id: null, entered_at: null,
            timer_paused_at: null, timer_paused_ms: 0,
          },
          open_log: { action: "deleted_incomplete", count: 1 },
        },
      ]);

      created.db.prepare(`
        INSERT INTO inspection_queue (inspection, num, phone, timestamp, year, team_id)
        VALUES ('battery', 81, '01081818181', 2, ?, ?)
      `).run(YEAR, replacement.id);
      const currentEnter = await client.post(
        "/competition/api/v1/queue/admin/booths/battery/1/enter",
        { cookie: official, body: { num: 81 } },
      );
      assert.equal(currentEnter.status, 200, await currentEnter.clone().text());
      assert.deepEqual(created.db.prepare(`
        SELECT occupied_by, occupied_team_id FROM booth
        WHERE inspection = 'battery' AND booth_num = 1
      `).get(), { occupied_by: 81, occupied_team_id: replacement.id });
      assert.equal(created.db.prepare(`
        SELECT team_id FROM booth_log
        WHERE inspection = 'battery' AND booth_num = 1 AND year = ? AND exited_at IS NULL
      `).get(YEAR).team_id, replacement.id);
      validateArtifact(fixture.dbPath);

      const currentExit = await client.post(
        "/competition/api/v1/queue/admin/booths/battery/1/exit",
        { cookie: official },
      );
      assert.equal(currentExit.status, 200, await currentExit.clone().text());
      assert.equal(created.db.prepare(`
        SELECT team_id FROM inspection_history
        WHERE num = 81 AND inspection = 'battery' AND year = ?
        ORDER BY timestamp DESC LIMIT 1
      `).get(YEAR).team_id, replacement.id);
      validateArtifact(fixture.dbPath);
    } finally {
      await stopServer(server);
      await created.close();
    }
  });

  it("reports teamless historical domain years through metadata", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const historicalYear = YEAR - 3;
    try {
      created.db.prepare(`
        INSERT INTO sheet_template (year, level, name, sort_order)
        VALUES (?, 'category', 'Historical only', 0)
      `).run(historicalYear);
      const response = await fetch(`${baseUrl}/competition/api/v1/meta`);
      assert.equal(response.status, 200);
      const metadata = await response.json();
      assert.ok(metadata.years.includes(historicalYear));
      assert.equal(created.db.prepare("SELECT COUNT(*) AS count FROM competition_team WHERE year = ?").get(historicalYear).count, 0);
      assert.equal(created.db.prepare("SELECT COUNT(*) AS count FROM competition_vehicle_type WHERE year = ?").get(historicalYear).count, 0);
    } finally {
      await stopServer(server);
      await created.close();
    }
  });

  it("preserves complete prior entities in conflicting update audit warnings", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const client = createClient(baseUrl);
    const admin = makeAuthCookie({ email: "admin@test.invalid", name: "Admin", role: "admin" });
    try {
      const firstType = created.teams.createVehicleType(YEAR, { name: "Audit Type A", color: "red" });
      const secondType = created.teams.createVehicleType(YEAR, { name: "Audit Type B", color: "blue" });
      const firstTeam = created.teams.createTeam(YEAR, {
        number: 701, university: "Prior University", name: "Prior Team", vehicleTypeId: firstType.id,
      });
      created.teams.createTeam(YEAR, { number: 702, university: "Other University", name: "Other Team" });

      const teamConflict = await client.patch(`/competition/api/v1/teams/${firstTeam.id}`, {
        cookie: admin, body: { number: 702 },
      });
      assert.equal(teamConflict.status, 409);
      const typeConflict = await client.patch(`/competition/api/v1/vehicle-types/${firstType.id}`, {
        cookie: admin, body: { name: secondType.name },
      });
      assert.equal(typeConflict.status, 409);

      const teamWarning = created.db.prepare(`
        SELECT detail FROM logs WHERE action = 'team.update' AND level = 'warn' AND target = ?
        ORDER BY id DESC LIMIT 1
      `).get(String(firstTeam.id));
      assert.deepEqual(JSON.parse(teamWarning.detail).before, {
        id: firstTeam.id,
        year: YEAR,
        number: 701,
        university: "Prior University",
        name: "Prior Team",
        vehicleTypeId: firstType.id,
        active: true,
      });
      const typeWarning = created.db.prepare(`
        SELECT detail FROM logs WHERE action = 'vehicle_type.update' AND level = 'warn' AND target = ?
        ORDER BY id DESC LIMIT 1
      `).get(String(firstType.id));
      assert.deepEqual(JSON.parse(typeWarning.detail).before, {
        id: firstType.id,
        year: YEAR,
        name: "Audit Type A",
        color: "red",
        sortOrder: 0,
      });
    } finally {
      await stopServer(server);
      await created.close();
    }
  });

  it("resolves Traffic writes from stable current-year team IDs after a live team edit", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const client = createClient(baseUrl);
    const admin = makeAuthCookie({ email: "admin@test.invalid", name: "Admin", role: "admin" });
    try {
      const currentTeam = created.teams.createTeam(YEAR, {
        number: 7, university: "Canonical University", name: "Canonical Team",
      });
      const historicalId = Number(created.db.prepare(`
        INSERT INTO competition_team (year, num, univ, name)
        VALUES (?, 7, 'Historical University', 'Historical Team')
      `).run(YEAR - 1).lastInsertRowid);

      const historicalSelection = await client.post("/competition/api/v1/traffic/wireless/select", {
        cookie: admin,
        body: {
          event_type: "오토크로스",
          team: { id: historicalId, num: 7, univ: "Historical University", team: "Historical Team" },
          event_name: "CANONICAL-TEAM",
        },
      });
      assert.equal(historicalSelection.status, 409);

      for (const [node, role] of [["canonical-start", "start"], ["canonical-finish", "finish"]]) {
        const mapping = await client.put(`/competition/api/v1/traffic/wireless/mapping/${node}`, {
          cookie: admin, body: { event_type: "오토크로스", role },
        });
        assert.equal(mapping.status, 200, await mapping.clone().text());
      }
      const health = await client.post("/competition/api/v1/traffic/wireless/ingest", {
        cookie: admin,
        body: healthyWirelessBatch(["canonical-start", "canonical-finish"]),
      });
      assert.equal(health.status, 200, await health.clone().text());
      const armed = await client.post("/competition/api/v1/traffic/wireless/arm", {
        cookie: admin,
        body: {
          event_type: "오토크로스",
          action: "green",
          green_tick: "1600000000",
          team: { id: currentTeam.id, num: 7, univ: "stale", team: "stale" },
          event_name: "CANONICAL-TEAM",
        },
      });
      assert.equal(armed.status, 200, await armed.clone().text());
      const armAudit = created.db.prepare(`
        SELECT detail FROM logs
        WHERE action = 'wireless.arm' AND level = 'info' AND target = '오토크로스'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.deepEqual(JSON.parse(armAudit.detail).team, {
        id: currentTeam.id,
        year: YEAR,
        number: 7,
        university: "Canonical University",
        name: "Canonical Team",
        active: true,
      });
      await client.post("/competition/api/v1/traffic/wireless/ingest", {
        cookie: admin,
        body: { events: [{ node_id: "canonical-start", master_tick: "1600000000", ev_seq: 1 }] },
      });

      const updated = await client.patch(`/competition/api/v1/teams/${currentTeam.id}`, {
        cookie: admin,
        body: { number: 17, university: "Updated University", name: "Updated Team" },
      });
      assert.equal(updated.status, 200, await updated.clone().text());
      await client.post("/competition/api/v1/traffic/wireless/ingest", {
        cookie: admin,
        body: { events: [{ node_id: "canonical-finish", master_tick: "1760000000", ev_seq: 1 }] },
      });

      const records = await client.get(
        `/competition/api/v1/traffic/records/${encodeURIComponent(`FSK ${YEAR} CANONICAL-TEAM`)}`,
        { cookie: admin },
      );
      assert.equal(records.status, 200, await records.clone().text());
      assert.deepEqual((await records.json()).map(({ num, univ, team, type, result }) => ({
        num, univ, team, type, result,
      })), [{
        num: 17,
        univ: "Updated University",
        team: "Updated Team",
        type: "오토크로스",
        result: 10000,
      }]);

      for (const name of ["trg_wireless_session_bind_team_update", "trg_booth_validate_team_update"]) {
        const sql = created.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name).sql;
        assert.doesNotMatch(sql, /strftime\('%Y', 'now', '\+9 hours'\)/);
      }
    } finally {
      await stopServer(server);
      created.close();
    }
  });

  it("keeps DSQ unbound legacy Traffic rows permanently non-reactivatable", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const client = createClient(baseUrl);
    const admin = makeAuthCookie({ email: "admin@test.invalid", name: "Admin", role: "admin" });
    try {
      const team = created.teams.createTeam(YEAR, {
        number: 41, university: "Legacy University", name: "Legacy Team",
      });
      const insert = created.db.prepare(`
        INSERT INTO record
          (name, legacy_rowid, time, num, univ, team, type, result, status, scoreboard, team_id)
        VALUES (?, 1, '2026-01-01T00:00:00.000Z', 41, 'Legacy University', 'Legacy Team',
          'Acceleration', 1000, 'DSQ', 0, NULL)
      `);
      insert.run("legacy-record");
      const currentName = `FSK ${YEAR} Legacy Record`;
      insert.run(currentName);
      // The insert binder can resolve the current-year row. Reproduce a legacy
      // DSQ artifact whose stable binding was never migrated.
      created.db.prepare("UPDATE record SET team_id = NULL WHERE name = ?").run(currentName);
      validateArtifact(fixture.dbPath);

      const malformed = await client.patch(
        `/competition/api/v1/traffic/records/${encodeURIComponent("legacy-record")}/1`,
        { cookie: admin, body: { field: "status", value: null } },
      );
      assert.equal(malformed.status, 400, await malformed.clone().text());

      const unbound = await client.patch(
        `/competition/api/v1/traffic/records/${encodeURIComponent(currentName)}/1`,
        { cookie: admin, body: { field: "status", value: null } },
      );
      assert.equal(unbound.status, 409, await unbound.clone().text());
      assert.deepEqual(created.db.prepare(`
        SELECT name, status, scoreboard, team_id FROM record ORDER BY name
      `).all(), [
        { name: currentName, status: "DSQ", scoreboard: 0, team_id: null },
        { name: "legacy-record", status: "DSQ", scoreboard: 0, team_id: null },
      ]);
      assert.equal(team.active, true);
      validateArtifact(fixture.dbPath);
    } finally {
      await stopServer(server);
      created.close();
    }
  });

  it("enforces each module UI grant while serving every SPA from one process", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    });
    const { server, baseUrl } = await startServer(created.app);
    const student = makeAuthCookie({ email: "student@test.invalid", name: "Student", role: "student" });
    const official = makeAuthCookie({
      email: "official@test.invalid", name: "Official", role: "official", permissions: [],
    });
    const registrationOperator = makeAuthCookie({
      email: "registration-operator@test.invalid", name: "Registration Operator", role: "official",
      permissions: ["registration.operate"],
    });
    const registrationManager = makeAuthCookie({
      email: "registration-manager@test.invalid", name: "Registration Manager", role: "official",
      permissions: ["registration.manage"],
    });
    const queueOperator = makeAuthCookie({
      email: "queue-operator@test.invalid", name: "Queue Operator", role: "official",
      permissions: ["queue.operate"],
    });
    const inspectionOperator = makeAuthCookie({
      email: "inspection-operator@test.invalid", name: "Inspection Operator", role: "official",
      permissions: ["inspection.operate"],
    });
    const trafficOperator = makeAuthCookie({
      email: "traffic-operator@test.invalid", name: "Traffic Operator", role: "official",
      permissions: ["traffic.operate"],
    });
    const scoreOperator = makeAuthCookie({
      email: "score-operator@test.invalid", name: "Score Operator", role: "official",
      permissions: ["score.operate"],
    });
    // Entry is an Admin tool; a forged legacy grant must not open it.
    const entryManager = makeAuthCookie({
      email: "entry-manager@test.invalid", name: "Entry Manager", role: "official",
      permissions: ["entry.manage"],
    });
    const documentsOperator = makeAuthCookie({
      email: "documents-operator@test.invalid", name: "Documents Operator", role: "official",
      permissions: ["documents.operate"],
    });
    const admin = makeAuthCookie({ email: "admin@test.invalid", name: "Admin", role: "admin" });
    const get = (pathname, cookie) => fetch(`${baseUrl}${pathname}`, {
      redirect: "manual",
      headers: cookie ? { Cookie: cookie } : {},
    });
    try {
      assert.equal((await get("/entry/")).status, 302);
      assert.equal((await get("/entry/", official)).status, 302);
      assert.equal((await get("/entry/", entryManager)).status, 302);
      assert.equal((await get("/entry/", admin)).status, 200);
      assert.equal((await get("/inspection/", official)).status, 302);
      assert.equal((await get("/inspection/", inspectionOperator)).status, 200);
      assert.equal((await get("/traffic/", official)).status, 302);
      assert.equal((await get("/traffic/", trafficOperator)).status, 200);
      assert.equal((await get("/score/", official)).status, 302);
      assert.equal((await get("/score/", scoreOperator)).status, 200);
      assert.equal((await get("/score/", admin)).status, 200);
      assert.equal((await get("/documents/", student)).status, 200);
      assert.equal((await get("/documents/", documentsOperator)).status, 302);
      assert.equal((await get("/documents/admin", documentsOperator)).status, 200);
      assert.equal((await get("/queue/")).status, 200);
      assert.equal((await get("/registration/")).status, 200);
      assert.equal((await get("/registration/manage", student)).status, 302);
      assert.equal((await get("/registration/manage", official)).status, 302);
      assert.equal((await get("/registration/manage", registrationOperator)).status, 200);
      assert.equal((await get("/registration/manage", registrationManager)).status, 200);
      assert.equal((await get("/registration/register", official)).status, 302);
      assert.equal((await get("/registration/register", registrationOperator)).status, 302);
      assert.equal((await get("/registration/register", registrationManager)).status, 200);
      assert.equal((await get("/queue/admin", official)).status, 302);
      assert.equal((await get("/queue/admin", queueOperator)).status, 200);
      assert.equal((await get("/inspection/", registrationManager)).status, 302);
    } finally {
      await stopServer(server);
      created.close();
    }
  });

  it("removes temp and unreferenced managed uploads at startup but preserves referenced files", () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const options = {
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
    };
    const first = createCompetitionApp(options);
    const team = first.teams.createTeam(YEAR, { number: 1, university: "A", name: "Alpha" });
    const sessionId = Number(first.db.prepare(`
      INSERT INTO session (name, start_at, end_at, late_end_at, created_by, year)
      VALUES ('Docs', '2026-01-01', '2026-01-02', '2026-01-03', 'admin', ?)
    `).run(YEAR).lastInsertRowid);
    const submissionId = Number(first.db.prepare(`
      INSERT INTO submission (session_id, team_num, submitted_by, submitted_at, storage_dir)
      VALUES (?, 1, 'student', '2026-01-01', ?)
    `).run(sessionId, `${sessionId}/team-${team.id}/1`).lastInsertRowid);
    first.db.prepare(`
      INSERT INTO submission_file (submission_id, original_name, stored_name, size)
      VALUES (?, 'kept.pdf', 'kept.pdf', 4)
    `).run(submissionId);
    first.close();

    const kept = path.join(fixture.uploadRoot, String(sessionId), `team-${team.id}`, "1", "kept.pdf");
    const orphan = path.join(fixture.uploadRoot, "orphan", "lost.pdf");
    const temp = path.join(fixture.uploadRoot, "_tmp", "abandoned.part");
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.mkdirSync(path.dirname(temp), { recursive: true });
    fs.writeFileSync(kept, "kept");
    fs.writeFileSync(orphan, "orphan");
    fs.writeFileSync(temp, "temp");

    const second = createCompetitionApp(options);
    assert.equal(fs.existsSync(kept), true);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(temp), false);
    const log = second.db.prepare("SELECT detail FROM logs WHERE action = 'file.startup_cleanup' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(log.detail).deletedCount, 2);
    second.close();
  });

  it("drains an in-flight Documents scheduler send before closing the shared database", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    let releaseSend;
    let markSendStarted;
    const sendStarted = new Promise((resolve) => { markSendStarted = resolve; });
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    let created;
    created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
      sendNotificationEmail: async () => {
        markSendStarted();
        await sendGate;
        assert.equal(created.db.open, true, "the shared DB must remain open until the send completes");
        return { ok: true };
      },
    });
    const team = created.teams.createTeam(YEAR, { number: 31, university: "Drain U", name: "Drain T" });
    created.db.prepare(`
      INSERT INTO student_team (email, team_num, year, team_id)
      VALUES ('drain@test.invalid', 31, ?, ?)
    `).run(YEAR, team.id);
    const sessionId = Number(created.db.prepare(`
      INSERT INTO session (name, notice, start_at, end_at, late_end_at, created_by, year)
      VALUES ('Drain', '', '2020-01-01', '2030-01-01', '', 'admin', ?)
    `).run(YEAR).lastInsertRowid);
    created.db.prepare("INSERT INTO session_team (session_id, team_num, team_id) VALUES (?, 31, ?)")
      .run(sessionId, team.id);
    created.db.prepare(`
      INSERT INTO scheduled_notification (session_id, type, scheduled_at)
      VALUES (?, 'session_open', '2000-01-01T00:00:00.000Z')
    `).run(sessionId);

    const scheduler = created.modules.documents.processScheduledNotifications();
    await sendStarted;
    let serverCloseCallback;
    let deadlineCleared = false;
    const exitCodes = [];
    const shutdown = createShutdownHandler({
      server: { close(callback) { serverCloseCallback = callback; } },
      runtime: created,
      exit: (code) => exitCodes.push(code),
      setTimeoutFn: () => ({ unref() {} }),
      clearTimeoutFn: () => { deadlineCleared = true; },
    });
    shutdown("SIGTERM");
    const closing = serverCloseCallback();
    assert.equal(created.db.open, true);
    assert.equal(deadlineCleared, false, "the deadline must remain armed while module work drains");
    assert.deepEqual(exitCodes, []);
    releaseSend();
    await Promise.all([scheduler, closing]);
    assert.equal(created.db.open, false);
    assert.equal(deadlineCleared, true);
    assert.deepEqual(exitCodes, [0]);
  });

  it("persists recipient successes when a later Documents notification send throws", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const calls = [];
    let failSecond = true;
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
      sendNotificationEmail: async (_subject, _html, recipient) => {
        calls.push(recipient);
        if (recipient === "notify-b@test.invalid" && failSecond) {
          throw new Error("injected recipient transport failure");
        }
        return { ok: true };
      },
    });
    try {
      const first = created.teams.createTeam(YEAR, { number: 41, university: "Notify A", name: "A" });
      const second = created.teams.createTeam(YEAR, { number: 42, university: "Notify B", name: "B" });
      created.db.prepare("INSERT INTO student_team (email, team_num, year, team_id) VALUES (?, ?, ?, ?)")
        .run("notify-a@test.invalid", 41, YEAR, first.id);
      created.db.prepare("INSERT INTO student_team (email, team_num, year, team_id) VALUES (?, ?, ?, ?)")
        .run("notify-b@test.invalid", 42, YEAR, second.id);
      const sessionId = Number(created.db.prepare(`
        INSERT INTO session (name, notice, start_at, end_at, late_end_at, created_by, year)
        VALUES ('Recipient retry', '', '2020-01-01', '2030-01-01', '', 'admin', ?)
      `).run(YEAR).lastInsertRowid);
      created.db.prepare("INSERT INTO session_team (session_id, team_num, team_id) VALUES (?, ?, ?)")
        .run(sessionId, 41, first.id);
      created.db.prepare("INSERT INTO session_team (session_id, team_num, team_id) VALUES (?, ?, ?)")
        .run(sessionId, 42, second.id);
      const notificationId = Number(created.db.prepare(`
        INSERT INTO scheduled_notification (session_id, type, scheduled_at)
        VALUES (?, 'session_open', '2000-01-01T00:00:00.000Z')
      `).run(sessionId).lastInsertRowid);

      await created.modules.documents.processScheduledNotifications();
      let notification = created.db.prepare(
        "SELECT sent, sent_recipients, attempts FROM scheduled_notification WHERE id = ?",
      ).get(notificationId);
      assert.equal(notification.sent, 0);
      assert.deepEqual(JSON.parse(notification.sent_recipients), ["notify-a@test.invalid"]);
      assert.equal(notification.attempts, 1);

      failSecond = false;
      await created.modules.documents.processScheduledNotifications();
      notification = created.db.prepare(
        "SELECT sent, sent_recipients, attempts FROM scheduled_notification WHERE id = ?",
      ).get(notificationId);
      assert.equal(notification.sent, 1);
      assert.deepEqual(new Set(JSON.parse(notification.sent_recipients)), new Set([
        "notify-a@test.invalid",
        "notify-b@test.invalid",
      ]));
      assert.deepEqual(calls, [
        "notify-a@test.invalid",
        "notify-b@test.invalid",
        "notify-b@test.invalid",
      ]);
    } finally {
      await created.close();
    }
  });

  it("aggregates a rejected Documents sender result with recipient and integration error", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
      sendNotificationEmail: async () => ({
        ok: false,
        error: "injected email service rejection",
      }),
    });
    try {
      const team = created.teams.createTeam(YEAR, { number: 43, university: "Notify C", name: "C" });
      created.db.prepare("INSERT INTO student_team (email, team_num, year, team_id) VALUES (?, ?, ?, ?)")
        .run("notify-c@test.invalid", 43, YEAR, team.id);
      const sessionId = Number(created.db.prepare(`
        INSERT INTO session (name, notice, start_at, end_at, late_end_at, created_by, year)
        VALUES ('Sender rejection', '', '2020-01-01', '2030-01-01', '', 'admin', ?)
      `).run(YEAR).lastInsertRowid);
      created.db.prepare("INSERT INTO session_team (session_id, team_num, team_id) VALUES (?, 43, ?)")
        .run(sessionId, team.id);
      const notificationId = Number(created.db.prepare(`
        INSERT INTO scheduled_notification (session_id, type, scheduled_at)
        VALUES (?, 'session_open', '2000-01-01T00:00:00.000Z')
      `).run(sessionId).lastInsertRowid);

      await created.modules.documents.processScheduledNotifications();
      const notification = created.db.prepare(
        "SELECT sent, sent_recipients, attempts FROM scheduled_notification WHERE id = ?",
      ).get(notificationId);
      assert.equal(notification.sent, 0);
      assert.deepEqual(JSON.parse(notification.sent_recipients), []);
      assert.equal(notification.attempts, 1);
      const warnings = created.db.prepare(`
        SELECT actor_email, detail FROM logs
        WHERE action = 'schedule.session_open' AND level = 'warn'
          AND target = 'Sender rejection'
        ORDER BY id
      `).all();
      assert.equal(warnings.length, 1, "one scheduler attempt must produce one aggregate warning");
      const warning = warnings[0];
      assert.equal(warning.actor_email, null);
      assert.deepEqual(JSON.parse(warning.detail), {
        error: "partial_send",
        sent: 0,
        remaining: 1,
        attempts: 1,
        failed: [{
          email: "notify-c@test.invalid",
          error: "injected email service rejection",
        }],
      });
    } finally {
      await created.close();
    }
  });

  it("audits a no-recipient Documents notification completion without calling the sender", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const calls = [];
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
      sendNotificationEmail: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    });
    try {
      const team = created.teams.createTeam(YEAR, { number: 44, university: "No Recipient U", name: "No Recipient T" });
      const sessionId = Number(created.db.prepare(`
        INSERT INTO session (name, notice, start_at, end_at, late_end_at, created_by, year)
        VALUES ('No recipients', '', '2020-01-01', '2030-01-01', '', 'admin', ?)
      `).run(YEAR).lastInsertRowid);
      created.db.prepare("INSERT INTO session_team (session_id, team_num, team_id) VALUES (?, 44, ?)")
        .run(sessionId, team.id);
      const notificationId = Number(created.db.prepare(`
        INSERT INTO scheduled_notification (session_id, type, scheduled_at)
        VALUES (?, 'session_open', '2000-01-01T00:00:00.000Z')
      `).run(sessionId).lastInsertRowid);

      await created.modules.documents.processScheduledNotifications();

      assert.deepEqual(calls, []);
      assert.equal(created.db.prepare(
        "SELECT sent FROM scheduled_notification WHERE id = ?",
      ).get(notificationId).sent, 1);
      const audit = created.db.prepare(`
        SELECT level, target, detail FROM logs
        WHERE action = 'schedule.session_open' AND level = 'info'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(audit.target, "No recipients");
      assert.deepEqual(JSON.parse(audit.detail), {
        notificationId,
        sessionId,
        year: YEAR,
        type: "session_open",
        recipientCount: 0,
        completionReason: "no_recipients",
        before: { sent: 0 },
        after: { sent: 1 },
      });
    } finally {
      await created.close();
    }
  });

  it("keeps a no-recipient Documents notification pending when completion persistence fails", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const created = createCompetitionApp({
      dbPath: fixture.dbPath, staticRoots: fixture.staticRoots, uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT, enableNotificationScheduler: false,
      sendNotificationEmail: async () => assert.fail("the sender must not run without recipients"),
    });
    try {
      const team = created.teams.createTeam(YEAR, { number: 45, university: "Persist Fail U", name: "Persist Fail T" });
      const sessionId = Number(created.db.prepare(`
        INSERT INTO session (name, notice, start_at, end_at, late_end_at, created_by, year)
        VALUES ('No recipient persistence failure', '', '2020-01-01', '2030-01-01', '', 'admin', ?)
      `).run(YEAR).lastInsertRowid);
      created.db.prepare("INSERT INTO session_team (session_id, team_num, team_id) VALUES (?, 45, ?)")
        .run(sessionId, team.id);
      const notificationId = Number(created.db.prepare(`
        INSERT INTO scheduled_notification (session_id, type, scheduled_at)
        VALUES (?, 'session_open', '2000-01-01T00:00:00.000Z')
      `).run(sessionId).lastInsertRowid);
      created.db.exec(`
        CREATE TRIGGER reject_no_recipient_completion
        BEFORE UPDATE OF sent ON scheduled_notification
        WHEN OLD.id = ${notificationId} AND OLD.sent = 0 AND NEW.sent = 1
        BEGIN
          SELECT RAISE(ABORT, 'injected no-recipient completion failure');
        END
      `);

      await created.modules.documents.processScheduledNotifications();

      assert.equal(created.db.prepare(
        "SELECT sent FROM scheduled_notification WHERE id = ?",
      ).get(notificationId).sent, 0);
      const warning = created.db.prepare(`
        SELECT target, detail FROM logs
        WHERE action = 'schedule.session_open' AND level = 'warn'
        ORDER BY id DESC LIMIT 1
      `).get();
      assert.equal(warning.target, "No recipient persistence failure");
      assert.deepEqual(JSON.parse(warning.detail), {
        error: "injected no-recipient completion failure",
        notificationId,
        sessionId,
        year: YEAR,
        type: "session_open",
        phase: "notification_processing",
      });
      assert.equal(created.db.prepare(`
        SELECT count(*) AS count FROM logs
        WHERE action = 'schedule.session_open' AND level = 'info'
      `).get().count, 0);
    } finally {
      await created.close();
    }
  });

  it("holds one SMS client for Queue and Registration", async () => {
    const fixture = fixtureRoot();
    fixtures.push(fixture);
    const configRequests = [];
    const created = createCompetitionApp({
      dbPath: fixture.dbPath,
      staticRoots: fixture.staticRoots,
      uploadRoot: fixture.uploadRoot,
      validateUser: TRUST_JWT,
      enableNotificationScheduler: false,
      fetchImpl: async (url) => {
        configRequests.push(String(url));
        return {
          ok: true,
          json: async () => ({
            naver_cloud_access_key: "key",
            naver_cloud_secret_key: "secret",
            naver_cloud_sms_service_id: "service",
            phone_number_sms_sender: "01000000000",
          }),
        };
      },
    });
    try {
      await created.start();
      // Both modules report SMS as configured, but the credentials were fetched
      // once: Registration borrows the client Queue owns.
      assert.equal(configRequests.length, 1, `expected one sms-config fetch, saw ${configRequests.length}`);
      assert.match(configRequests[0], /\/api\/internal\/sms-config$/);
      assert.equal(await created.modules.queue.loadSmsConfig(), true);
      assert.equal(await created.modules.registration.loadSmsConfig(), true);
      assert.equal(configRequests.length, 2, "only the owner re-reads the configuration");
    } finally {
      await created.close();
    }
  });
});
