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
  TEST_INTERNAL_SECRET,
} from "../helpers/test-utils.mjs";

setupTestEnv();

import { createCourseApp } from "../../course/index.mjs";

const adminCookie = makeAuthCookie({ email: "admin@test.com", name: "Admin", role: "admin" });
const internalHeaders = { "X-Internal-Service": TEST_INTERNAL_SECRET };

let server;
let baseUrl;
let client;
let db;
let dbPath;
let courseId;
let coneIds;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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

before(async () => {
  dbPath = tmpDbPath();
  const app = createCourseApp({ dbPath, validateUser: TRUST_JWT });
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
  it("stores arbitrary order and explicit duplicate cone occurrences", async () => {
    const result = await jsonRequest("post", "/api/rover/mission-presets", {
      course_id: courseId,
      name: "Reverse with repeat",
      finish_behavior: "return_to_start",
      items: [coneIds[2], coneIds[0], coneIds[2]].map((cone_id) => ({ cone_id })),
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
});

describe("durable mission protocol", () => {
  let rover;
  let mission;
  let resumeCommand;
  let reportSeq = 0;

  it("creates a server-authoritative mission and starts only after v2 command acknowledgement", async () => {
    rover = await openRover();
    const created = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: [coneIds[2], coneIds[0], coneIds[2]].map((cone_id) => ({ cone_id })),
    });
    assert.equal(created.response.status, 201);
    mission = created.data;
    assert.equal(mission.status, "ready");
    assert.equal(mission.waypoints.length, 3);
    assert.equal(new Set(mission.waypoints.map((waypoint) => waypoint.id)).size, 3);

    const commandPromise = rover.waitFor("mission-command", (data) => data.action === "start");
    const start = await jsonRequest("post", `/api/missions/${mission.id}/start`, {});
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
      start_position: { lat: 35.0, lng: 126.0 },
    }, { internal: true });
    assert.equal(ack.response.status, 200);
    assert.equal(ack.data.mission.status, "running");
  });

  it("does not complete from an uncorrelated IDLE telemetry frame", async () => {
    let response = await jsonRequest("post", "/api/rover/telemetry", { nav_state: "NAVIGATING", fix_status: "rtk_fixed" }, { internal: true });
    assert.equal(response.response.status, 200);
    response = await jsonRequest("post", "/api/rover/telemetry", { nav_state: "IDLE", fix_status: "rtk_fixed" }, { internal: true });
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
      finish_behavior: "stop",
      items: [{ waypoint_id: pending[1].id }],
    });
    assert.equal(staleEdit.response.status, 409);

    const commandPromise = rover.waitFor("mission-command", (data) => data.action === "resume");
    const resume = await jsonRequest("post", `/api/missions/${mission.id}/resume`, {});
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
      items: [{ cone_id: coneIds[0] }],
    });
    assert.equal(created.response.status, 201);
    const nextMission = created.data;

    const commandPromise = firstBoot.waitFor("mission-command", (data) => data.action === "start");
    const start = await jsonRequest("post", `/api/missions/${nextMission.id}/start`, {});
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
    }, { internal: true });
    assert.equal(accepted.data.mission.status, "running");

    const replacementBoot = await openRover("boot-restart-b");
    const bootHold = await replacementBoot.waitFor("pause-mission");
    assert.equal(bootHold.data.mission_id, nextMission.id);
    assert.equal(bootHold.data.reason, "rover_rebooted");
    const active = await (await client.get("/api/missions/active", { cookie: adminCookie })).json();
    assert.equal(active.mission.id, nextMission.id);
    assert.equal(active.mission.status, "interrupted");
    assert.equal(active.mission.hold_reason, "rover_rebooted");

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

    await firstBoot.close();
    await replacementBoot.close();
    const ended = await jsonRequest("post", `/api/missions/${nextMission.id}/end`, {});
    assert.equal(ended.response.status, 202);
  });

  it("re-adopts motion only for a reconnect from the same boot", async () => {
    const firstConnection = await openRover("boot-network-reconnect");
    const created = await jsonRequest("post", "/api/missions", {
      course_id: courseId,
      finish_behavior: "stop",
      items: [{ cone_id: coneIds[2] }],
    });
    const reconnectMission = created.data;
    const commandPromise = firstConnection.waitFor("mission-command", (data) => data.action === "start");
    await jsonRequest("post", `/api/missions/${reconnectMission.id}/start`, {});
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
    }, { internal: true });
    assert.equal(result.data.mission.status, "running");

    const secondConnection = await openRover("boot-network-reconnect");
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

    await firstConnection.close();
    await secondConnection.close();
    const ended = await jsonRequest("post", `/api/missions/${reconnectMission.id}/end`, {});
    assert.equal(ended.response.status, 202);
  });
});
