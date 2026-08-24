import { after, before, describe, it } from "node:test";
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
  TEST_INTERNAL_SECRET,
} from "../helpers/test-utils.mjs";

setupTestEnv();

import { createCourseApp } from "../../course/index.mjs";
import { createMissionV2Store, setupMissionV2Schema } from "../../course/lib/mission-v2.mjs";

const requireFromCourse = createRequire(new URL("../../course/package.json", import.meta.url));
const Database = requireFromCourse("better-sqlite3");

const adminCookie = makeAuthCookie({ email: "admin@test.com", name: "Admin", role: "admin" });
const internalHeaders = { "X-Internal-Service": TEST_INTERNAL_SECRET };

let server;
let baseUrl;
let client;
let db;
let dbPath;
let courseId;
let coneIds;
let storeFixtureSeq = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createStoreFixture() {
  const fixturePath = tmpDbPath();
  const created = createCourseApp({ dbPath: fixturePath, skipStaticValidation: true });
  const fixtureDb = created.db;
  const now = Date.now();
  const fixtureCourseId = Number(fixtureDb.prepare(
    "INSERT INTO course (name,created_at,updated_at) VALUES (?,?,?)",
  ).run(`fixture-${++storeFixtureSeq}`, new Date(now).toISOString(), new Date(now).toISOString()).lastInsertRowid);
  const insertCone = fixtureDb.prepare(`INSERT INTO cone
    (course_id,lat,lng,alt,side,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`);
  const fixtureConeIds = [0, 1, 2].map((index) => Number(insertCone.run(
    fixtureCourseId, 35 + index * 0.00001, 126 + index * 0.00001,
    null, index % 2 ? "right" : "left", new Date(now).toISOString(), new Date(now).toISOString(),
  ).lastInsertRowid));
  return {
    db: fixtureDb,
    store: createMissionV2Store(fixtureDb),
    courseId: fixtureCourseId,
    coneIds: fixtureConeIds,
    close() { fixtureDb.close(); cleanup(fixturePath); },
  };
}

function coneSnapshotItems(database, ids) {
  const select = database.prepare("SELECT id,lat,lng,alt,side FROM cone WHERE id=?");
  return ids.map((id) => {
    const cone = select.get(id);
    assert.ok(cone, `missing test cone ${id}`);
    return { cone_id: cone.id, lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side };
  });
}

async function openRover(bootId = "boot-v2-a") {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/rover/stream?protocol_version=2&boot_id=${bootId}`, {
    headers: { ...internalHeaders, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const waiters = [];
  const buffered = [];
  const ready = deferred();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let event = null;
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!event) continue;
          const item = { event, data: data ? JSON.parse(data) : {} };
          if (event === "connected") ready.resolve(item);
          const waiterIndex = waiters.findIndex((waiter) => waiter.event === event && (!waiter.match || waiter.match(item.data)));
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0].resolve(item);
          else buffered.push(item);
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        ready.reject(error);
        for (const waiter of waiters.splice(0)) waiter.reject(error);
      }
    }
  })();
  await ready.promise;
  return {
    bootId,
    close: async () => {
      // Cancel the active reader explicitly before aborting fetch. This gives
      // the Web Streams pump a deterministic completion signal even when the
      // repository-wide parallel runner has the HTTP client under load.
      try { await reader.cancel(); } catch { /* already closed */ }
      controller.abort();
      await pump;
      // Yield once so the server-side request close callback has completed
      // before the test tears down the database. This is an event-loop barrier,
      // not a timing sleep or synchronization poll.
      await new Promise((resolve) => setImmediate(resolve));
    },
    waitFor(event, match = null) {
      const index = buffered.findIndex((item) => item.event === event && (!match || match(item.data)));
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      const waiter = deferred();
      waiters.push({ event, match, ...waiter });
      return waiter.promise;
    },
  };
}

async function jsonRequest(method, path, body, { internal = false } = {}) {
  const response = await client[method](path, {
    cookie: internal ? undefined : adminCookie,
    headers: internal ? internalHeaders : undefined,
    body,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, data };
}

async function waitForActiveMission(match, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const body = await (await client.get("/api/missions/active", { cookie: adminCookie })).json();
    if (match(body.mission)) return body.mission;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("active mission did not reach the expected state before the deterministic event-loop barrier limit");
}

before(async () => {
  dbPath = tmpDbPath();
  // This suite deliberately keeps SSE streams open while exercising many
  // state transitions. Under the repository-wide parallel runner, CPU-heavy
  // sibling suites can stretch wall time beyond the production 15 s telemetry
  // watchdog even though the in-process test rover is healthy. Keep liveness
  // expiry out of protocol tests; disconnect/stale transitions are triggered
  // explicitly and deterministically below.
  const app = createCourseApp({
    dbPath,
    validateUser: TRUST_JWT,
    deviceStaleMs: 10 * 60 * 1000,
  });
  db = app.db;
  const started = await startServer(app.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);

  let result = await jsonRequest("post", "/api/courses", { name: "Mission V2" });
  assert.equal(result.response.status, 201);
  courseId = result.data.id;
  coneIds = [];
  for (const [lat, lng, side] of [
    [35.0, 126.0, "left"],
    [35.00001, 126.00001, "right"],
    [35.00002, 126.00002, "center"],
  ]) {
    result = await jsonRequest("post", `/api/courses/${courseId}/cones`, { lat, lng, side });
    assert.equal(result.response.status, 201);
    coneIds.push(result.data.id);
  }
});

after(async () => {
  server.closeAllConnections?.();
  await stopServer(server);
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
  cleanup(dbPath);
});

describe("mission route presets", () => {
  it("bounds missions to hundreds-scale routes and presets", () => {
    const fixture = createStoreFixture();
    try {
      const coneId = fixture.coneIds[0];
      const oversized = coneSnapshotItems(
        fixture.db,
        Array.from({ length: 1001 }, () => coneId),
      );
      assert.throws(() => fixture.store.createMission({
        courseId: fixture.courseId,
        items: oversized,
      }), /1,000개/);

      for (let index = 0; index < 20; index += 1) {
        fixture.store.savePreset({
          courseId: fixture.courseId,
          name: `bounded-${index}`,
          items: [{ cone_id: coneId }],
        });
      }
      assert.throws(() => fixture.store.savePreset({
        courseId: fixture.courseId,
        name: "one-too-many",
        items: [{ cone_id: coneId }],
      }), (error) => error?.reason === "preset_limit");
    } finally {
      fixture.close();
    }
  });

  it("stores arbitrary order and explicit duplicate cone occurrences", async () => {
    const result = await jsonRequest("post", "/api/rover/mission-presets", {
      course_id: courseId,
      name: "Reverse with repeat",
      finish_behavior: "return_to_start",
      items: coneSnapshotItems(db, [coneIds[2], coneIds[0], coneIds[2]]),
    });
    assert.equal(result.response.status, 201);
    assert.deepEqual(result.data.items.map((item) => item.cone_id), [coneIds[2], coneIds[0], coneIds[2]]);
    assert.equal(result.data.finish_behavior, "return_to_start");

    const duplicateName = await jsonRequest("post", "/api/rover/mission-presets", {
      course_id: courseId,
      name: "reverse WITH repeat",
      finish_behavior: "stop",
      items: [{ cone_id: coneIds[0] }],
    });
    assert.equal(duplicateName.response.status, 409);
  });

  it("marks a preset stale instead of silently dropping a deleted cone", async () => {
    const created = await jsonRequest("post", "/api/rover/mission-presets", {
      course_id: courseId,
      name: "Will become stale",
      finish_behavior: "stop",
      items: [{ cone_id: coneIds[1] }],
    });
    assert.equal(created.response.status, 201);
    const deleted = await client.delete(`/api/cones/${coneIds[1]}`, { cookie: adminCookie });
    assert.equal(deleted.status, 200);
    const list = await client.get(`/api/rover/mission-presets?course_id=${courseId}`, { cookie: adminCookie });
    const body = await list.json();
    const stale = body.presets.find((preset) => preset.id === created.data.id);
    assert.equal(stale.stale, true);
    assert.equal(stale.items[0].cone_id, null);
    assert.equal(stale.items[0].cone_id_snapshot, coneIds[1]);
  });

  it("rejects a stale preset revision without overwriting the newer value", async () => {
    const created = await jsonRequest("post", "/api/rover/mission-presets", {
      course_id: courseId,
      name: "Preset CAS",
      finish_behavior: "stop",
      items: [{ cone_id: coneIds[0] }],
    });
    assert.equal(created.response.status, 201);
    assert.match(created.data.preset_revision, /^[a-f0-9]{64}$/);
    const updated = await jsonRequest("put", `/api/rover/mission-presets/${created.data.id}`, {
      course_id: courseId,
      name: "Preset CAS current",
      finish_behavior: "stop",
      items: [{ cone_id: coneIds[2] }],
      expected_preset_revision: created.data.preset_revision,
    });
    assert.equal(updated.response.status, 200);
    const stale = await jsonRequest("put", `/api/rover/mission-presets/${created.data.id}`, {
      course_id: courseId,
      name: "Preset CAS stale",
      finish_behavior: "stop",
      items: [{ cone_id: coneIds[0] }],
      expected_preset_revision: created.data.preset_revision,
    });
    assert.equal(stale.response.status, 409);
    const list = await (await client.get(
      `/api/rover/mission-presets?course_id=${courseId}`, { cookie: adminCookie },
    )).json();
    assert.equal(list.presets.find((preset) => preset.id === created.data.id).name, "Preset CAS current");

    const staleDelete = await jsonRequest("delete", `/api/rover/mission-presets/${created.data.id}`, {
      expected_preset_revision: created.data.preset_revision,
    });
    assert.equal(staleDelete.response.status, 409);
    assert.equal(staleDelete.data.reason, "preset_revision_mismatch");
    assert.equal(staleDelete.data.current_preset_revision, updated.data.preset_revision);
    const currentDelete = await jsonRequest("delete", `/api/rover/mission-presets/${created.data.id}`, {
      expected_preset_revision: updated.data.preset_revision,
    });
    assert.equal(currentDelete.response.status, 204);
  });
});

describe("durable mission protocol", () => {
  let rover;
  let mission;
  let resumeCommand;
  let reportSeq = 0;

  it("creates a server-authoritative mission and starts only after v2 command acknowledgement", async () => {
    rover = await openRover();
    const reviewed = coneSnapshotItems(db, [coneIds[2], coneIds[0], coneIds[2]]);
    const changedAfterReview = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: reviewed.map((item, position) => position === 1 ? { ...item, side: "right" } : item),
    });
    assert.equal(changedAfterReview.response.status, 409);
    assert.equal(changedAfterReview.data.reason, "cone_snapshot_mismatch");
    assert.equal(changedAfterReview.data.position, 1);
    assert.equal(changedAfterReview.data.cone_id, coneIds[0]);
    assert.equal(changedAfterReview.data.current_cone.side, "left");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mission WHERE protocol_version=2").get().n, 0);
    const created = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: reviewed,
    });
    assert.equal(created.response.status, 201);
    mission = created.data;
    assert.equal(mission.status, "ready");
    assert.equal(mission.waypoints.length, 3);
    assert.equal(new Set(mission.waypoints.map((waypoint) => waypoint.id)).size, 3);

    const commandPromise = rover.waitFor("mission-command", (data) => data.action === "start");
    const start = await jsonRequest("post", `/api/missions/${mission.id}/start`, {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
    });
    assert.equal(start.response.status, 202);
    assert.equal(start.data.mission.status, "starting");
    const command = (await commandPromise).data;
    assert.equal(command.mission_id, mission.id);
    assert.deepEqual(command.waypoints.map((waypoint) => waypoint.id), mission.waypoints.map((waypoint) => waypoint.id));

    const malformedAck = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: rover.bootId,
      report_seq: reportSeq + 1,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "command",
      command_id: command.command_id,
      command_seq: command.command_seq,
    }, { internal: true });
    assert.equal(malformedAck.response.status, 400);

    const ack = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: rover.bootId,
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "command",
      command_id: command.command_id,
      command_seq: command.command_seq,
      command_result: "accepted",
      motion_state: "running",
      start_position: { lat: 35.0, lng: 126.0 },
    }, { internal: true });
    assert.equal(ack.response.status, 200);
    assert.equal(ack.data.mission.status, "running");
  });

  it("does not complete from an uncorrelated IDLE telemetry frame", async () => {
    let response = await jsonRequest("post", "/api/rover/telemetry", { boot_id: rover.bootId, nav_state: "NAVIGATING", fix_status: "rtk_fixed" }, { internal: true });
    assert.equal(response.response.status, 200);
    response = await jsonRequest("post", "/api/rover/telemetry", { boot_id: rover.bootId, nav_state: "IDLE", fix_status: "rtk_fixed" }, { internal: true });
    assert.equal(response.response.status, 200);
    const active = await client.get("/api/missions/active", { cookie: adminCookie });
    const body = await active.json();
    assert.equal(body.mission.id, mission.id);
    assert.equal(body.mission.status, "running");

    const manual = await client.post("/api/rover/control", {
      cookie: adminCookie,
      body: { throttle: 10, steering: 0 },
    });
    assert.equal(manual.status, 409, "manual motion must be gated until autonomy is held");
  });

  it("keeps the same mission id while editing and resuming only pending occurrences", async () => {
    const first = mission.waypoints[0];
    const completed = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: rover.bootId,
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "waypoint_completed",
      waypoint_id: first.id,
    }, { internal: true });
    assert.equal(completed.response.status, 200);

    const held = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: rover.bootId,
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "held",
      reason: "operator_pause",
    }, { internal: true });
    assert.equal(held.data.mission.status, "paused");
    mission = held.data.mission;
    const preEditHash = mission.plan_hash;

    const pending = mission.waypoints.filter((waypoint) => waypoint.state === "pending");
    const edited = await jsonRequest("put", `/api/missions/${mission.id}/remaining`, {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
      finish_behavior: "stop",
      items: [{ waypoint_id: pending[1].id }],
    });
    assert.equal(edited.response.status, 200);
    mission = edited.data;
    assert.equal(mission.id, completed.data.mission.id);
    assert.equal(mission.waypoints.filter((waypoint) => waypoint.state === "completed").length, 1);
    assert.equal(mission.waypoints.filter((waypoint) => waypoint.state === "skipped").length, 1);
    assert.equal(mission.waypoints.filter((waypoint) => waypoint.state === "pending").length, 1);

    const staleEdit = await jsonRequest("put", `/api/missions/${mission.id}/remaining`, {
      expected_plan_hash: preEditHash,
      expected_occurrence_revision: mission.occurrence_revision,
      finish_behavior: "stop",
      items: [{ waypoint_id: pending[1].id }],
    });
    assert.equal(staleEdit.response.status, 409);

    const commandPromise = rover.waitFor("mission-command", (data) => data.action === "resume");
    const resume = await jsonRequest("post", `/api/missions/${mission.id}/resume`, {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
    });
    assert.equal(resume.response.status, 202);
    resumeCommand = (await commandPromise).data;
    assert.equal(resumeCommand.mission_id, mission.id);
    assert.deepEqual(resumeCommand.waypoints.map((waypoint) => waypoint.id), [pending[1].id]);
  });

  it("completes only from correlated durable reports and tolerates replay", async () => {
    let result = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: rover.bootId,
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "command",
      command_id: resumeCommand.command_id,
      command_seq: resumeCommand.command_seq,
      command_result: "accepted",
      motion_state: "running",
    }, { internal: true });
    assert.equal(result.data.mission.status, "running");

    const pendingId = mission.waypoints.find((waypoint) => waypoint.state === "pending").id;
    for (let replay = 0; replay < 2; replay += 1) {
      result = await jsonRequest("post", "/api/rover/mission-report", {
        protocol_version: 2,
        boot_id: rover.bootId,
        report_seq: ++reportSeq,
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        event: "waypoint_completed",
        waypoint_id: pendingId,
      }, { internal: true });
      assert.equal(result.response.status, 200);
    }

    result = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: rover.bootId,
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "mission_completed",
      completed_waypoint_ids: [pendingId],
    }, { internal: true });
    assert.equal(result.data.mission.status, "completed");
    assert.equal(result.data.reset_mission, true);
    const duplicateCompletion = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: rover.bootId,
      report_seq: reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "mission_completed",
      completed_waypoint_ids: [pendingId],
    }, { internal: true });
    assert.equal(duplicateCompletion.response.status, 200);
    assert.equal(duplicateCompletion.data.duplicate, true);
    assert.equal(duplicateCompletion.data.reset_mission, true);
    assert.equal(duplicateCompletion.data.mission.status, "completed");
    const active = await (await client.get("/api/missions/active", { cookie: adminCookie })).json();
    assert.equal(active.mission, null);

    const restoredAfterCrash = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: rover.bootId,
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "state",
      motion_state: "held",
      completed_waypoint_ids: [pendingId],
    }, { internal: true });
    assert.equal(restoredAfterCrash.response.status, 200);
    assert.equal(restoredAfterCrash.data.reset_mission, true);
  });

  it("rejects stale boot reports", async () => {
    const stale = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: "old-boot",
      report_seq: 999,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "mission_completed",
    }, { internal: true });
    assert.equal(stale.response.status, 409);
    await rover.close();
  });

  it("holds a moving mission when a different rover boot takes over", async () => {
    const firstBoot = await openRover("boot-restart-a");
    const created = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: coneSnapshotItems(db, [coneIds[0]]),
    });
    assert.equal(created.response.status, 201);
    const nextMission = created.data;

    const commandPromise = firstBoot.waitFor("mission-command", (data) => data.action === "start");
    const start = await jsonRequest("post", `/api/missions/${nextMission.id}/start`, {
      expected_plan_hash: nextMission.plan_hash,
      expected_occurrence_revision: nextMission.occurrence_revision,
    });
    assert.equal(start.response.status, 202);
    const command = (await commandPromise).data;
    const accepted = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: firstBoot.bootId,
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "command",
      command_id: command.command_id,
      command_seq: command.command_seq,
      command_result: "accepted",
      motion_state: "running",
    }, { internal: true });
    assert.equal(accepted.data.mission.status, "running");

    const replacementBoot = await openRover("boot-restart-b");
    const bootHold = await replacementBoot.waitFor("mission-safety-hold");
    assert.equal(bootHold.data.mission_id, nextMission.id);
    assert.equal(bootHold.data.reason, "rover_rebooted");
    const active = await (await client.get("/api/missions/active", { cookie: adminCookie })).json();
    assert.equal(active.mission.id, nextMission.id);
    assert.equal(active.mission.status, "interrupted");
    assert.equal(active.mission.hold_reason, "rover_rebooted");

    const estopLogCountBefore = db.prepare(
      "SELECT COUNT(*) AS count FROM logs WHERE action='mission.v2.estop_observed'",
    ).get().count;
    const originalPrepare = db.prepare;
    let fullWaypointSelectExecutions = 0;
    db.prepare = function instrumentWaypointSelect(sql) {
      const statement = originalPrepare.call(this, sql);
      if (/^\s*SELECT\s+\*\s+FROM\s+mission_waypoint\s+WHERE\s+mission_id\s*=\s*\?/i.test(sql)) {
        const originalAll = statement.all;
        statement.all = function countWaypointSelect(...args) {
          fullWaypointSelectExecutions += 1;
          return originalAll.apply(this, args);
        };
      }
      return statement;
    };
    try {
      for (let frame = 0; frame < 3; frame += 1) {
        const estopDuringRebootHold = await jsonRequest("post", "/api/rover/telemetry", {
          boot_id: replacementBoot.bootId,
          nav_state: "EMERGENCY_STOP",
        }, { internal: true });
        assert.equal(estopDuringRebootHold.response.status, 200);
      }
      for (let frame = 0; frame < 3; frame += 1) {
        const manualDuringUnconfirmedHold = await client.post("/api/rover/control", {
          cookie: adminCookie,
          body: { throttle: 10, steering: frame },
        });
        assert.equal(manualDuringUnconfirmedHold.status, 409);
      }
      assert.equal(fullWaypointSelectExecutions, 0);
    } finally {
      delete db.prepare;
    }
    const estopLogCountAfter = db.prepare(
      "SELECT COUNT(*) AS count FROM logs WHERE action='mission.v2.estop_observed'",
    ).get().count;
    assert.equal(estopLogCountAfter - estopLogCountBefore, 1);
    const afterEstop = await (await client.get("/api/missions/active", { cookie: adminCookie })).json();
    assert.equal(afterEstop.mission.active_hold_id, bootHold.data.hold_id);
    assert.equal(afterEstop.mission.hold_reason, "rover_rebooted");
    assert.equal(afterEstop.mission.motion_confirmed_held, false);
    await jsonRequest("post", "/api/rover/telemetry", {
      boot_id: replacementBoot.bootId,
      nav_state: "IDLE",
    }, { internal: true });

    const strayRunning = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: replacementBoot.bootId,
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "state",
      motion_state: "running",
      completed_waypoint_ids: [],
    }, { internal: true });
    assert.equal(strayRunning.response.status, 200);
    assert.equal(strayRunning.data.mission.status, "interrupted");
    assert.equal(strayRunning.data.mission.hold_reason, "rover_rebooted");

    const restoredHold = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: replacementBoot.bootId,
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "held",
      hold_id: bootHold.data.hold_id,
      checkpoint_persisted: true,
      reason: "checkpoint_restored",
      completed_waypoint_ids: [],
    }, { internal: true });
    assert.equal(restoredHold.data.mission.status, "paused");
    assert.equal(restoredHold.data.mission.motion_confirmed_held, true);

    const delayedRunning = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: replacementBoot.bootId,
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "state",
      motion_state: "running",
      completed_waypoint_ids: [],
    }, { internal: true });
    assert.equal(delayedRunning.data.mission.status, "paused");
    assert.equal(delayedRunning.data.mission.hold_reason, "checkpoint_restored");

    await firstBoot.close();
    const endPromise = replacementBoot.waitFor("mission-command", (data) => data.action === "end");
    const ended = await jsonRequest("post", `/api/missions/${nextMission.id}/end`, {});
    assert.equal(ended.response.status, 202);
    assert.equal(ended.data.mission.status, "paused");
    const endCommand = (await endPromise).data;
    const endAck = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2, boot_id: replacementBoot.bootId, report_seq: ++reportSeq,
      mission_id: nextMission.id, plan_hash: nextMission.plan_hash,
      event: "command", command_id: endCommand.command_id,
      command_seq: endCommand.command_seq, command_result: "accepted", motion_state: "held",
    }, { internal: true });
    assert.equal(endAck.data.mission.status, "cancelled");
    await replacementBoot.close();
  });

  it("re-adopts motion only for a reconnect from the same boot", async () => {
    const firstConnection = await openRover("boot-network-reconnect");
    const created = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: coneSnapshotItems(db, [coneIds[2]]),
    });
    const reconnectMission = created.data;
    const commandPromise = firstConnection.waitFor("mission-command", (data) => data.action === "start");
    await jsonRequest("post", `/api/missions/${reconnectMission.id}/start`, {
      expected_plan_hash: reconnectMission.plan_hash,
      expected_occurrence_revision: reconnectMission.occurrence_revision,
    });
    const command = (await commandPromise).data;
    let result = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: firstConnection.bootId,
      report_seq: ++reportSeq,
      mission_id: reconnectMission.id,
      plan_hash: reconnectMission.plan_hash,
      event: "command",
      command_id: command.command_id,
      command_seq: command.command_seq,
      command_result: "accepted",
      motion_state: "running",
    }, { internal: true });
    assert.equal(result.data.mission.status, "running");

    await firstConnection.close();
    let activeMission = await waitForActiveMission((candidate) => candidate?.status === "interrupted");
    assert.equal(activeMission.hold_reason, "sse_disconnect");
    assert.equal(activeMission.motion_confirmed_held, false);

    const editWhileMotionUnconfirmed = await jsonRequest("put", `/api/missions/${reconnectMission.id}/remaining`, {
      expected_plan_hash: reconnectMission.plan_hash,
      expected_occurrence_revision: activeMission.occurrence_revision,
      finish_behavior: "stop",
      items: [{ waypoint_id: reconnectMission.waypoints[0].id }],
    });
    assert.equal(editWhileMotionUnconfirmed.response.status, 409);

    const secondConnection = await openRover("boot-network-reconnect");
    const manualBeforeReconcile = await client.post("/api/rover/control", {
      cookie: adminCookie,
      body: { throttle: 10, steering: 0 },
    });
    assert.equal(manualBeforeReconcile.status, 409);

    result = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: secondConnection.bootId,
      report_seq: ++reportSeq,
      mission_id: reconnectMission.id,
      plan_hash: reconnectMission.plan_hash,
      event: "state",
      motion_state: "running",
      completed_waypoint_ids: [],
    }, { internal: true });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.mission.status, "running");

    await secondConnection.close();
    const replacementConnection = await openRover("boot-after-network-interruption");
    const hardHold = await replacementConnection.waitFor("mission-safety-hold", (data) =>
      data.mission_id === reconnectMission.id);
    assert.equal(hardHold.data.reason, "rover_rebooted");
    activeMission = await waitForActiveMission((candidate) => candidate?.hold_reason === "rover_rebooted");
    assert.equal(activeMission.status, "interrupted");
    assert.equal(activeMission.motion_confirmed_held, false);
    const holdAck = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2, boot_id: replacementConnection.bootId, report_seq: ++reportSeq,
      mission_id: reconnectMission.id, plan_hash: reconnectMission.plan_hash,
      event: "held", hold_id: hardHold.data.hold_id, checkpoint_persisted: true,
      reason: "checkpoint_restored",
    }, { internal: true });
    assert.equal(holdAck.data.mission.status, "paused");
    const endPromise = replacementConnection.waitFor("mission-command", (data) => data.action === "end");
    const ended = await jsonRequest("post", `/api/missions/${reconnectMission.id}/end`, {});
    assert.equal(ended.response.status, 202);
    const endCommand = (await endPromise).data;
    const endAck = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2, boot_id: replacementConnection.bootId, report_seq: ++reportSeq,
      mission_id: reconnectMission.id, plan_hash: reconnectMission.plan_hash,
      event: "command", command_id: endCommand.command_id,
      command_seq: endCommand.command_seq, command_result: "accepted", motion_state: "held",
    }, { internal: true });
    assert.equal(endAck.data.mission.status, "cancelled");
    await replacementConnection.close();
  });

  it("replays only the same pending action and lets end supersede it", async () => {
    const commandRover = await openRover("boot-command-conflict");
    const created = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: coneSnapshotItems(db, [coneIds[0]]),
    });
    const conflictMission = created.data;
    const courseDelete = await client.delete(`/api/courses/${courseId}`, { cookie: adminCookie });
    assert.equal(courseDelete.status, 409);
    assert.equal((await courseDelete.json()).reason, "active_mission_course");
    assert.ok(db.prepare(`SELECT 1 FROM logs WHERE action='course.delete' AND level='warn'
      AND json_extract(detail,'$.reason')='active_mission_course' ORDER BY id DESC LIMIT 1`).get());
    const staleOccurrence = await jsonRequest("post", `/api/missions/${conflictMission.id}/start`, {
      expected_plan_hash: conflictMission.plan_hash,
      expected_occurrence_revision: "0".repeat(64),
    });
    assert.equal(staleOccurrence.response.status, 409);
    assert.equal(staleOccurrence.data.reason, "occurrence_revision_mismatch");
    assert.equal(staleOccurrence.data.current_occurrence_revision, conflictMission.occurrence_revision);
    const staleStart = await jsonRequest("post", `/api/missions/${conflictMission.id}/start`, {
      expected_plan_hash: "0".repeat(64),
      expected_occurrence_revision: conflictMission.occurrence_revision,
    });
    assert.equal(staleStart.response.status, 409);
    assert.equal((await (await client.get("/api/missions/active", { cookie: adminCookie })).json()).mission.status, "ready");
    const startPromise = commandRover.waitFor("mission-command", (data) =>
      data.mission_id === conflictMission.id && data.action === "start");
    const start = await jsonRequest("post", `/api/missions/${conflictMission.id}/start`, {
      expected_plan_hash: conflictMission.plan_hash,
      expected_occurrence_revision: conflictMission.occurrence_revision,
    });
    const startCommand = (await startPromise).data;
    assert.equal(start.response.status, 202);

    const conflictingPause = await jsonRequest("post", `/api/missions/${conflictMission.id}/pause`, {});
    assert.equal(conflictingPause.response.status, 409);

    const replayPromise = commandRover.waitFor("mission-command", (data) =>
      data.command_id === startCommand.command_id);
    const replay = await jsonRequest("post", `/api/missions/${conflictMission.id}/start`, {
      expected_plan_hash: conflictMission.plan_hash,
      expected_occurrence_revision: conflictMission.occurrence_revision,
    });
    assert.equal(replay.response.status, 202);
    assert.equal(replay.data.replay, true);
    assert.equal((await replayPromise).data.action, "start");

    const endPromise = commandRover.waitFor("mission-command", (data) =>
      data.mission_id === conflictMission.id && data.action === "end");
    const ended = await jsonRequest("post", `/api/missions/${conflictMission.id}/end`, {});
    const endCommand = (await endPromise).data;
    assert.equal(ended.response.status, 202);
    assert.equal(ended.data.mission.status, "starting");
    const successor = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: coneSnapshotItems(db, [coneIds[2]]),
    });
    assert.equal(successor.response.status, 409);
    const manualBeforeEndAck = await client.post("/api/rover/control", {
      cookie: adminCookie,
      body: { throttle: 10, steering: 0 },
    });
    assert.equal(manualBeforeEndAck.status, 409);
    assert.equal(endCommand.command_seq, startCommand.command_seq + 1);
    const storedStart = db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?").get(startCommand.command_id);
    assert.deepEqual(storedStart, { state: "superseded", reject_reason: "operator_end" });
    const endAck = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2, boot_id: commandRover.bootId, report_seq: ++reportSeq,
      mission_id: conflictMission.id, plan_hash: conflictMission.plan_hash,
      event: "command", command_id: endCommand.command_id,
      command_seq: endCommand.command_seq, command_result: "accepted", motion_state: "held",
    }, { internal: true });
    assert.equal(endAck.data.mission.status, "cancelled");
    await commandRover.close();
  });

  it("rejects an A to B to A rover stream takeover before replacing the current session", async () => {
    const bootA = await openRover("boot-lease-a");
    const bootB = await openRover("boot-lease-b");
    const currentPosition = await jsonRequest("post", "/api/rover/position", {
      boot_id: bootB.bootId, lat: 35, lng: 126,
    }, { internal: true });
    assert.equal(currentPosition.response.status, 200);
    const stalePosition = await jsonRequest("post", "/api/rover/position", {
      boot_id: bootA.bootId, lat: 0, lng: 0,
    }, { internal: true });
    assert.equal(stalePosition.response.status, 409);
    const staleA = await fetch(`${baseUrl}/api/rover/stream?protocol_version=2&boot_id=${bootA.bootId}`, {
      headers: { ...internalHeaders, Accept: "text/event-stream" },
    });
    assert.equal(staleA.status, 409);
    assert.match(await staleA.text(), /이전 로버 부팅 세션/);
    const status = await (await client.get("/api/rover/status", { cookie: adminCookie })).json();
    assert.equal(status.mission_protocol.boot_id, bootB.bootId);
    assert.equal(status.connected, true);
    assert.equal(status.last_position.lat, 35);
    assert.equal(status.last_position.lng, 126);
    await bootA.close();
    await bootB.close();
  });

  it("binds telemetry to the current boot and confirms E-Stop hold only from authoritative telemetry", async () => {
    const estopRover = await openRover("boot-estop-current");
    const created = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: coneSnapshotItems(db, [coneIds[0]]),
    });
    const estopMission = created.data;
    const startPromise = estopRover.waitFor("mission-command", (data) => data.action === "start");
    await jsonRequest("post", `/api/missions/${estopMission.id}/start`, {
      expected_plan_hash: estopMission.plan_hash,
      expected_occurrence_revision: estopMission.occurrence_revision,
    });
    const startCommand = (await startPromise).data;
    let result = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2, boot_id: estopRover.bootId, report_seq: ++reportSeq,
      mission_id: estopMission.id, plan_hash: estopMission.plan_hash,
      event: "command", command_id: startCommand.command_id,
      command_seq: startCommand.command_seq, command_result: "accepted", motion_state: "running",
    }, { internal: true });
    assert.equal(result.data.mission.status, "running");

    const staleTelemetry = await jsonRequest("post", "/api/rover/telemetry", {
      boot_id: "boot-lease-b", nav_state: "EMERGENCY_STOP",
    }, { internal: true });
    assert.equal(staleTelemetry.response.status, 409);
    assert.equal((await (await client.get("/api/missions/active", { cookie: adminCookie })).json()).mission.status, "running");

    const stopped = await jsonRequest("post", "/api/rover/stop", {});
    assert.equal(stopped.response.status, 200);
    let active = await (await client.get("/api/missions/active", { cookie: adminCookie })).json();
    assert.equal(active.mission.status, "running");
    assert.equal(active.mission.motion_confirmed_held, false);

    result = await jsonRequest("post", "/api/rover/telemetry", {
      boot_id: estopRover.bootId, nav_state: "EMERGENCY_STOP",
    }, { internal: true });
    assert.equal(result.response.status, 200);
    active = await (await client.get("/api/missions/active", { cookie: adminCookie })).json();
    assert.equal(active.mission.status, "interrupted");
    assert.equal(active.mission.hold_reason, "emergency_stop");
    assert.equal(active.mission.motion_confirmed_held, true);

    const endPromise = estopRover.waitFor("mission-command", (data) => data.action === "end");
    await jsonRequest("post", `/api/missions/${estopMission.id}/end`, {});
    const endCommand = (await endPromise).data;
    result = await jsonRequest("post", "/api/rover/mission-report", {
      protocol_version: 2, boot_id: estopRover.bootId, report_seq: ++reportSeq,
      mission_id: estopMission.id, plan_hash: estopMission.plan_hash,
      event: "command", command_id: endCommand.command_id,
      command_seq: endCommand.command_seq, command_result: "accepted", motion_state: "held",
    }, { internal: true });
    assert.equal(result.data.mission.status, "cancelled");
    await estopRover.close();
  });

  it("makes a failed command delivery auditable and immediately resumable", () => {
    const store = createMissionV2Store(db);
    const deliveryMission = store.createMission({
      courseId,
      finishBehavior: "stop",
      items: coneSnapshotItems(db, [coneIds[2]]),
      actor: "test",
    });
    const issued = store.issueCommand({
      missionId: deliveryMission.id,
      action: "start",
      expectedPlanHash: deliveryMission.plan_hash,
      expectedOccurrenceRevision: deliveryMission.occurrence_revision,
      actor: "test",
      targetBootId: "boot-write-failure",
    });
    const failed = store.markCommandDeliveryFailed(
      deliveryMission.id, issued.command.id, "boot-write-failure",
    );
    assert.equal(failed.status, "interrupted");
    assert.equal(failed.hold_reason, "command_delivery_failed");
    assert.equal(failed.motion_confirmed_held, false);
    assert.equal(failed.active_command_id, null);
    assert.deepEqual(
      db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?").get(issued.command.id),
      { state: "superseded", reject_reason: "command_delivery_failed" },
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM mission_event
      WHERE mission_id=? AND event_type='command.delivery_failed'`).get(deliveryMission.id).n, 1);
    assert.throws(() => store.issueCommand({
      missionId: deliveryMission.id,
      action: "resume",
      expectedPlanHash: failed.plan_hash,
      expectedOccurrenceRevision: failed.occurrence_revision,
    }), (error) => error.reason === "motion_not_confirmed_held");
    const roverConfirmed = store.applyReport({
      mission_id: deliveryMission.id,
      plan_hash: deliveryMission.plan_hash,
      boot_id: "boot-write-failure",
      event: "interrupted",
      reason: "dispense_outcome_uncertain",
      active_waypoint_id: deliveryMission.waypoints[0].id,
    });
    assert.equal(roverConfirmed.status, "interrupted");
    assert.equal(roverConfirmed.hold_reason, "dispense_outcome_uncertain");
    assert.equal(roverConfirmed.motion_confirmed_held, true);
    assert.equal(roverConfirmed.waypoints[0].outcome, "dispense_outcome_uncertain");
    const edited = store.editRemaining({
      missionId: deliveryMission.id,
      expectedPlanHash: roverConfirmed.plan_hash,
      expectedOccurrenceRevision: roverConfirmed.occurrence_revision,
      items: [],
      actor: "test",
    });
    assert.equal(edited.status, "interrupted");
    assert.equal(edited.hold_reason, "route_edited");
    assert.equal(edited.motion_confirmed_held, true);
    const emptyResume = store.issueCommand({
      missionId: deliveryMission.id,
      action: "resume",
      expectedPlanHash: edited.plan_hash,
      expectedOccurrenceRevision: edited.occurrence_revision,
      actor: "test",
    });
    assert.deepEqual(JSON.parse(emptyResume.command.payload_json).waypoints, []);
    const end = store.issueCommand({ missionId: deliveryMission.id, action: "end", actor: "test" });
    const endPayload = JSON.parse(end.command.payload_json);
    const cancelled = store.applyReport({
      mission_id: deliveryMission.id,
      plan_hash: edited.plan_hash,
      boot_id: "boot-write-failure",
      event: "command",
      command_id: end.command.id,
      command_seq: endPayload.command_seq,
      command_result: "accepted",
      motion_state: "held",
    });
    assert.equal(cancelled.status, "cancelled");
  });
});

describe("mission v2 state-machine regressions", () => {
  it("keeps the hot-path mission summary bounded and revisioned", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.store.createMission({
        courseId: fixture.courseId,
        items: coneSnapshotItems(fixture.db, fixture.coneIds),
      });
      const summary = fixture.store.activeMissionSummary();
      assert.deepEqual(Object.keys(summary).sort(), [
        "active_command_id", "active_hold_id", "course_id", "course_name", "empty_plan_mode",
        "finish_behavior", "hold_reason", "id", "motion_confirmed_held",
        "occurrence_revision", "plan_hash", "protocol_version", "status",
      ]);
      assert.equal(summary.id, mission.id);
      assert.equal(summary.course_name, `fixture-${storeFixtureSeq}`);
      assert.equal(summary.occurrence_revision, mission.occurrence_revision);
      assert.equal(Object.hasOwn(summary, "waypoints"), false);
      summary.status = "tampered-client-copy";
      assert.equal(fixture.store.activeMissionSummary().status, "ready");
    } finally {
      fixture.close();
    }
  });

  it("reconciles completed checkpoint ids on failed, held, and interrupted reports", () => {
    for (const event of ["waypoint_failed", "held", "interrupted"]) {
      const fixture = createStoreFixture();
      try {
        const mission = fixture.store.createMission({
          courseId: fixture.courseId,
          items: coneSnapshotItems(fixture.db, fixture.coneIds.slice(0, 2)),
        });
        fixture.db.prepare("UPDATE mission SET lifecycle_state='running',status='running' WHERE id=?").run(mission.id);
        const report = {
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: `boot-${event}`,
          event,
          completed_waypoint_ids: [mission.waypoints[0].id],
        };
        if (event === "waypoint_failed") report.waypoint_id = mission.waypoints[1].id;
        const after = fixture.store.applyReport(report);
        assert.equal(after.waypoints[0].state, "completed", event);
        assert.equal(after.waypoints[0].outcome, "success", event);
      } finally {
        fixture.close();
      }
    }
  });

  it("does not let a late accepted command overwrite a newer held report", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      const issued = fixture.store.issueCommand({
        missionId: mission.id, action: "start", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(issued.command.payload_json);
      const held = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-held",
        event: "held", reason: "operator_pause",
      });
      assert.equal(held.status, "paused");
      const replay = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-held",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "accepted", motion_state: "running",
      });
      assert.equal(replay.status, "paused");
      assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?").get(issued.command.id).state, "superseded");
    } finally {
      fixture.close();
    }
  });

  it("keeps a pending resume through its pre-command held snapshot", () => {
    const fixture = createStoreFixture();
    try {
      let mission = fixture.store.createMission({
        courseId: fixture.courseId,
        items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      fixture.db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',
        hold_reason='checkpoint_restored' WHERE id=?`).run(mission.id);
      mission = fixture.store.missionPublic(mission.id);
      const resume = fixture.store.issueCommand({
        missionId: mission.id,
        action: "resume",
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(resume.command.payload_json);
      const observed = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-resume-order",
        event: "state",
        motion_state: "held",
        last_command_id: "older-command",
        command_seq: payload.command_seq - 1,
        last_command_result: "accepted",
        last_command_reason: null,
      });
      assert.equal(observed.status, "resuming");
      assert.equal(observed.active_command_id, resume.command.id);
      assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?")
        .get(resume.command.id).state, "pending");
      const accepted = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-resume-order",
        event: "command",
        command_id: resume.command.id,
        command_seq: payload.command_seq,
        command_result: "accepted",
        motion_state: "running",
      });
      assert.equal(accepted.status, "running");
      assert.equal(accepted.active_command_id, null);
      const pause = fixture.store.issueCommand({ missionId: mission.id, action: "pause" });
      const pausePayload = JSON.parse(pause.command.payload_json);
      const recovered = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-resume-order",
        event: "state",
        motion_state: "held",
        last_command_id: pause.command.id,
        command_seq: pausePayload.command_seq,
        last_command_result: "accepted",
        last_command_reason: null,
      });
      assert.equal(recovered.status, "paused");
      assert.equal(recovered.active_command_id, null);
      assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?")
        .get(pause.command.id).state, "accepted");
    } finally {
      fixture.close();
    }
  });

  it("recovers a rejected start checkpoint to the direct-report ready state", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.store.createMission({
        courseId: fixture.courseId,
        items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      const start = fixture.store.issueCommand({
        missionId: mission.id,
        action: "start",
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(start.command.payload_json);
      const recovered = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-start-rejected",
        event: "state",
        motion_state: "held",
        last_command_id: start.command.id,
        command_seq: payload.command_seq,
        last_command_result: "rejected",
        last_command_reason: "preflight_rejected",
      });
      assert.equal(recovered.status, "ready");
      assert.equal(recovered.active_command_id, null);
      assert.deepEqual(
        fixture.db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?")
          .get(start.command.id),
        { state: "rejected", reject_reason: "preflight_rejected" },
      );
    } finally {
      fixture.close();
    }
  });

  it("keeps terminal state immutable when a pending command result arrives late", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      const issued = fixture.store.issueCommand({
        missionId: mission.id, action: "start", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(issued.command.payload_json);
      const completed = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-terminal",
        event: "mission_completed", completed_waypoint_ids: [mission.waypoints[0].id],
      });
      assert.equal(completed.status, "completed");
      const late = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-terminal",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "accepted", motion_state: "running",
      });
      assert.equal(late.status, "completed");
      assert.equal(late.ended_at, completed.ended_at);
    } finally {
      fixture.close();
    }
  });

  it("does not roll a confirmed held pause back to running when pause is rejected", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      fixture.db.prepare("UPDATE mission SET lifecycle_state='running',status='running' WHERE id=?").run(mission.id);
      const issued = fixture.store.issueCommand({ missionId: mission.id, action: "pause" });
      const payload = JSON.parse(issued.command.payload_json);
      assert.throws(() => fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-pause",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "accepted", motion_state: "running",
      }), (error) => error.reason === "pause_motion_not_held");
      const rejected = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-pause",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "rejected", motion_state: "held", reason: "already_held",
      });
      assert.equal(rejected.status, "paused");
      assert.equal(rejected.motion_confirmed_held, true);
    } finally {
      fixture.close();
    }
  });

  it("does not label a rejected start as safely ready when the rover reports motion", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      const issued = fixture.store.issueCommand({
        missionId: mission.id, action: "start", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(issued.command.payload_json);
      const rejected = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-start-reject",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "rejected", motion_state: "running", reason: "late_failure",
      });
      assert.equal(rejected.status, "interrupted");
      assert.equal(rejected.motion_confirmed_held, false);
      assert.throws(() => fixture.store.issueCommand({
        missionId: mission.id, action: "resume", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: rejected.occurrence_revision,
      }), (error) => error.reason === "motion_not_confirmed_held");
    } finally {
      fixture.close();
    }
  });

  it("accepts only explicit return-only or uncertainty-resolved empty plans", () => {
    const fixture = createStoreFixture();
    try {
      let mission = fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      assert.throws(() => fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "stop",
        items: [],
      }), (error) => error.reason === "empty_remaining_plan");
      const beforeReturnOnly = mission;
      assert.throws(() => fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "return_to_start",
        items: [],
      }), (error) => error.reason === "return_start_unavailable");
      const afterRejectedReturnOnly = fixture.store.missionPublic(mission.id);
      assert.equal(afterRejectedReturnOnly.plan_hash, beforeReturnOnly.plan_hash);
      assert.equal(afterRejectedReturnOnly.empty_plan_mode, null);
      assert.equal(afterRejectedReturnOnly.waypoints[0].state, "pending");
      fixture.db.prepare("UPDATE mission SET start_lat=35,start_lng=126 WHERE id=?").run(mission.id);
      mission = fixture.store.missionPublic(mission.id);
      mission = fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "return_to_start",
        items: [],
      });
      assert.equal(mission.empty_plan_mode, "return_only");
      const start = fixture.store.issueCommand({
        missionId: mission.id, action: "start", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      assert.deepEqual(JSON.parse(start.command.payload_json).waypoints, []);
    } finally {
      fixture.close();
    }

    const uncertainFixture = createStoreFixture();
    try {
      let mission = uncertainFixture.store.createMission({
        courseId: uncertainFixture.courseId,
        items: coneSnapshotItems(uncertainFixture.db, uncertainFixture.coneIds.slice(0, 2)),
      });
      uncertainFixture.db.prepare("UPDATE mission SET lifecycle_state='running',status='running' WHERE id=?").run(mission.id);
      mission = uncertainFixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-uncertain",
        event: "held", reason: "dispense_outcome_uncertain",
        motion_state: "dispense_uncertain",
        active_waypoint_id: mission.waypoints[0].id,
      });
      assert.equal(mission.waypoints[0].outcome, "dispense_outcome_uncertain");
      assert.throws(() => uncertainFixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "stop",
        items: [],
      }), (error) => error.reason === "empty_remaining_plan");
      mission = uncertainFixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-uncertain",
        event: "interrupted", reason: "dispense_outcome_uncertain",
        active_waypoint_id: mission.waypoints[1].id,
      });
      mission = uncertainFixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "stop",
        items: [],
      });
      assert.equal(mission.empty_plan_mode, "uncertainty_resolved");
      const resume = uncertainFixture.store.issueCommand({
        missionId: mission.id, action: "resume", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      assert.deepEqual(JSON.parse(resume.command.payload_json).waypoints, []);
    } finally {
      uncertainFixture.close();
    }
  });

  it("uses occurrence and preset revisions as value-based conditional writes", () => {
    const fixture = createStoreFixture();
    try {
      let mission = fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      const staleOccurrenceRevision = mission.occurrence_revision;
      mission = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-revision",
        event: "state", motion_state: "held", completed_waypoint_ids: [],
      });
      assert.throws(() => fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: staleOccurrenceRevision,
        items: [{ waypoint_id: mission.waypoints[0].id }],
      }), (error) => error.reason === "occurrence_revision_mismatch");

      const created = fixture.store.savePreset({
        courseId: fixture.courseId, name: "CAS", items: [{ cone_id: fixture.coneIds[0] }],
      }).after;
      const updated = fixture.store.savePreset({
        id: created.id, courseId: fixture.courseId, name: "CAS updated",
        items: [{ cone_id: fixture.coneIds[1] }], expectedPresetRevision: created.preset_revision,
      }).after;
      assert.notEqual(updated.preset_revision, created.preset_revision);
      assert.throws(() => fixture.store.savePreset({
        id: created.id, courseId: fixture.courseId, name: "stale",
        items: [{ cone_id: fixture.coneIds[2] }], expectedPresetRevision: created.preset_revision,
      }), (error) => error.reason === "preset_revision_mismatch");
    } finally {
      fixture.close();
    }
  });

  it("keeps end active until ACK and makes a failed end delivery authoritative", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      const end = fixture.store.issueCommand({ missionId: mission.id, action: "end" });
      assert.equal(end.mission.status, "ready");
      assert.equal(end.mission.active_command_id, end.command.id);
      assert.throws(() => fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[1]]),
      }), (error) => error.reason === "active_mission");
      const endPayload = JSON.parse(end.command.payload_json);
      assert.throws(() => fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-end",
        event: "command", command_id: end.command.id, command_seq: endPayload.command_seq,
        command_result: "accepted", motion_state: "running",
      }), (error) => error.reason === "end_motion_not_held");
      assert.equal(fixture.store.missionPublic(mission.id).active_command_id, end.command.id);
      assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?").get(end.command.id).state, "pending");
      const failed = fixture.store.markCommandDeliveryFailed(mission.id, end.command.id, "boot-end");
      assert.equal(failed.status, "interrupted");
      assert.equal(failed.active_command_id, null);
      assert.deepEqual(
        fixture.db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?").get(end.command.id),
        { state: "superseded", reject_reason: "command_delivery_failed" },
      );
    } finally {
      fixture.close();
    }
  });

  it("preserves a pending end when either reboot-hold ACK arrives first", () => {
    for (const event of ["held", "interrupted"]) {
      const fixture = createStoreFixture();
      try {
        fixture.store.claimRoverBootSession(`${event}-boot-a`);
        fixture.store.claimRoverBootSession(`${event}-boot-b`);
        const mission = fixture.store.createMission({
          courseId: fixture.courseId,
          items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
        });
        fixture.db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',
          last_rover_boot_id=? WHERE id=?`).run(`${event}-boot-a`, mission.id);
        const held = fixture.store.reconcileRoverBoot(`${event}-boot-b`);
        const end = fixture.store.issueCommand({ missionId: mission.id, action: "end" });
        const endPayload = JSON.parse(end.command.payload_json);
        const holdAck = fixture.store.applyReport({
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: `${event}-boot-b`,
          event,
          hold_id: held.active_hold_id,
          checkpoint_persisted: true,
          reason: "checkpoint_restored",
        });
        assert.equal(holdAck.status, "interrupted", event);
        assert.equal(holdAck.active_hold_id, null, event);
        assert.equal(holdAck.active_command_id, end.command.id, event);
        assert.equal(holdAck.motion_confirmed_held, true, event);
        assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?")
          .get(end.command.id).state, "pending", event);
        const terminal = fixture.store.applyReport({
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: `${event}-boot-b`,
          event: "command",
          command_id: end.command.id,
          command_seq: endPayload.command_seq,
          command_result: "accepted",
          motion_state: "held",
        });
        assert.equal(terminal.status, "cancelled", event);
        assert.equal(terminal.active_command_id, null, event);
      } finally {
        fixture.close();
      }
    }
  });

  it("retires a pending command atomically when completion becomes terminal", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.store.createMission({
        courseId: fixture.courseId,
        items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      const start = fixture.store.issueCommand({
        missionId: mission.id,
        action: "start",
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const completed = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-completion-interleaving",
        event: "mission_completed",
        completed_waypoint_ids: [mission.waypoints[0].id],
      });
      assert.equal(completed.status, "completed");
      assert.equal(completed.active_command_id, null);
      assert.deepEqual(
        fixture.db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?")
          .get(start.command.id),
        { state: "superseded", reject_reason: "mission_completed" },
      );
      assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM mission_command WHERE state='pending'")
        .get().n, 0);
    } finally {
      fixture.close();
    }
  });

  it("persists boot generations and allows a correlated end to terminate a reboot hold", () => {
    const fixture = createStoreFixture();
    try {
      assert.equal(fixture.store.claimRoverBootSession("boot-a").accepted, true);
      assert.equal(fixture.store.claimRoverBootSession("boot-b").accepted, true);
      assert.equal(fixture.store.claimRoverBootSession("boot-a").reason, "stale_boot_session");
      const mission = fixture.store.createMission({
        courseId: fixture.courseId, items: coneSnapshotItems(fixture.db, [fixture.coneIds[0]]),
      });
      fixture.db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',
        last_rover_boot_id='boot-a' WHERE id=?`).run(mission.id);
      const held = fixture.store.reconcileRoverBoot("boot-b");
      assert.equal(held.motion_confirmed_held, false);
      assert.ok(held.active_hold_id);
      assert.throws(() => fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-b",
        event: "waypoint_failed", waypoint_id: mission.waypoints[0].id,
      }), (error) => error.reason === "safety_hold_pending");
      const end = fixture.store.issueCommand({ missionId: mission.id, action: "end" });
      assert.equal(end.mission.active_hold_id, held.active_hold_id);
      assert.equal(end.mission.hold_reason, "rover_rebooted");
      const payload = JSON.parse(end.command.payload_json);
      const acknowledged = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-b",
        event: "command", command_id: end.command.id, command_seq: payload.command_seq,
        command_result: "accepted", motion_state: "held",
      });
      assert.equal(acknowledged.status, "cancelled");
      assert.equal(acknowledged.active_hold_id, null);
      assert.equal(acknowledged.active_command_id, null);
    } finally {
      fixture.close();
    }
  });
});

describe("mission v2 legacy migration", () => {
  it("audits every legacy open mission closed by the one-active migration", () => {
    const legacyDb = new Database(":memory:");
    legacyDb.pragma("foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE course (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE cone (
        id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL, lat REAL NOT NULL,
        lng REAL NOT NULL, alt REAL, side TEXT NOT NULL,
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
      );
      CREATE TABLE mission (
        id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER, started_at INTEGER NOT NULL,
        ended_at INTEGER, status TEXT NOT NULL DEFAULT 'running', waypoints_json TEXT NOT NULL,
        current_waypoint_idx INTEGER NOT NULL DEFAULT 0, spray_results_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER, actor TEXT,
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE SET NULL
      );
      INSERT INTO course (id,name) VALUES (1,'Legacy duplicates');
      INSERT INTO mission (id,course_id,started_at,status,waypoints_json)
        VALUES (1,1,1000,'running','[{"lat":35,"lng":126}]');
      INSERT INTO mission (id,course_id,started_at,status,waypoints_json)
        VALUES (2,1,2000,'paused','[{"lat":35.1,"lng":126.1}]');
    `);
    setupMissionV2Schema(legacyDb);
    const closed = legacyDb.prepare("SELECT lifecycle_state,hold_reason FROM mission WHERE id=1").get();
    assert.deepEqual(closed, { lifecycle_state: "cancelled", hold_reason: "migration_superseded" });
    const event = legacyDb.prepare(`SELECT event_type,before_json,after_json,detail_json
      FROM mission_event WHERE mission_id=1 AND event_type='mission.migration_superseded'`).get();
    assert.ok(event);
    assert.equal(JSON.parse(event.before_json).state, "interrupted");
    assert.equal(JSON.parse(event.after_json).state, "cancelled");
    assert.equal(JSON.parse(event.detail_json).kept_mission_id, 2);
    legacyDb.close();
  });

  it("retires pending commands and clears terminal pointers when deduplicating open missions", () => {
    const legacyDb = new Database(":memory:");
    legacyDb.pragma("foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE course (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE cone (
        id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL, lat REAL NOT NULL,
        lng REAL NOT NULL, alt REAL, side TEXT NOT NULL,
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
      );
      CREATE TABLE mission (
        id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER, started_at INTEGER NOT NULL,
        ended_at INTEGER, status TEXT NOT NULL DEFAULT 'running', waypoints_json TEXT NOT NULL,
        current_waypoint_idx INTEGER NOT NULL DEFAULT 0, spray_results_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER, actor TEXT,
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE SET NULL
      );
      INSERT INTO course (id,name) VALUES (1,'Legacy pending duplicates');
      INSERT INTO mission (id,course_id,started_at,status,waypoints_json)
        VALUES (1,1,1000,'running','[{"lat":35,"lng":126}]');
      INSERT INTO mission (id,course_id,started_at,status,waypoints_json)
        VALUES (2,1,2000,'paused','[{"lat":35.1,"lng":126.1}]');
    `);
    setupMissionV2Schema(legacyDb);

    legacyDb.exec("DROP INDEX idx_mission_one_active");
    legacyDb.prepare(`UPDATE mission SET protocol_version=2,lifecycle_state='interrupted',
      status='interrupted',active_command_id=?,active_hold_id=? WHERE id=1`)
      .run("migration-pending", "migration-hold");
    legacyDb.prepare(`INSERT INTO mission_command
      (id,mission_id,command_seq,action,state,requested_at,payload_json)
      VALUES (?,?,1,'pause','pending',3000,'{}')`).run("migration-pending", 1);
    setupMissionV2Schema(legacyDb);

    assert.deepEqual(
      legacyDb.prepare(`SELECT lifecycle_state,active_command_id,active_hold_id
        FROM mission WHERE id=1`).get(),
      { lifecycle_state: "cancelled", active_command_id: null, active_hold_id: null },
    );
    assert.deepEqual(
      legacyDb.prepare("SELECT state,reject_reason FROM mission_command WHERE id='migration-pending'").get(),
      { state: "superseded", reject_reason: "migration_superseded" },
    );
    const commandEvent = legacyDb.prepare(`SELECT detail_json FROM mission_event
      WHERE mission_id=1 AND command_id='migration-pending' AND event_type='command.superseded'`).get();
    assert.equal(JSON.parse(commandEvent.detail_json).reason, "migration_superseded");
    const closeEvent = legacyDb.prepare(`SELECT before_json,after_json,detail_json FROM mission_event
      WHERE mission_id=1 AND event_type='mission.migration_superseded' ORDER BY id DESC`).get();
    assert.equal(JSON.parse(closeEvent.before_json).active_command_id, "migration-pending");
    assert.equal(JSON.parse(closeEvent.after_json).active_command_id, null);
    assert.deepEqual(JSON.parse(closeEvent.detail_json).retired_pending_command_ids, ["migration-pending"]);
    legacyDb.close();
  });

  it("promotes an open legacy route to a valid resumable v2 plan", () => {
    const legacyDb = new Database(":memory:");
    legacyDb.pragma("foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE course (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE cone (
        id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL, lat REAL NOT NULL,
        lng REAL NOT NULL, alt REAL, side TEXT NOT NULL,
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
      );
      CREATE TABLE mission (
        id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER, started_at INTEGER NOT NULL,
        ended_at INTEGER, status TEXT NOT NULL DEFAULT 'running', waypoints_json TEXT NOT NULL,
        current_waypoint_idx INTEGER NOT NULL DEFAULT 0, spray_results_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER, actor TEXT,
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE SET NULL
      );
      INSERT INTO course (id,name) VALUES (1,'Legacy');
    `);
    legacyDb.prepare(`INSERT INTO mission
      (course_id,started_at,status,waypoints_json,current_waypoint_idx,spray_results_json)
      VALUES (1,?,'running',?,1,?)`).run(
      1000,
      JSON.stringify([
        { lat: 35, lng: 126 },
        { lat: 35.00001, lng: 126.00001 },
        { lat: 35.00002, lng: 126.00002 },
      ]),
      JSON.stringify({ 0: "success" }),
    );

    setupMissionV2Schema(legacyDb);
    const store = createMissionV2Store(legacyDb);
    const promoted = store.activeMission();
    assert.equal(promoted.protocol_version, 2);
    assert.match(promoted.plan_hash, /^[a-f0-9]{64}$/);
    assert.equal(promoted.status, "interrupted");
    assert.deepEqual(promoted.waypoints.map((waypoint) => waypoint.state), [
      "completed", "pending", "pending",
    ]);
    const held = store.applyReport({
      mission_id: promoted.id,
      plan_hash: promoted.plan_hash,
      boot_id: "boot-after-upgrade",
      event: "state",
      motion_state: "held",
      completed_waypoint_ids: [promoted.waypoints[0].id],
    });
    const resumed = store.issueCommand({
      missionId: held.id,
      action: "resume",
      expectedPlanHash: held.plan_hash,
      expectedOccurrenceRevision: held.occurrence_revision,
      targetBootId: "boot-after-upgrade",
    });
    const payload = JSON.parse(resumed.command.payload_json);
    assert.equal(payload.plan_hash, promoted.plan_hash);
    assert.deepEqual(payload.waypoints.map((waypoint) => waypoint.id), [
      "legacy-1-1", "legacy-1-2",
    ]);
    legacyDb.close();
  });
});
