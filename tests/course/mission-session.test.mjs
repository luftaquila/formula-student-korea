import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMissionCommandPayload,
  buildMissionPresetPayload,
  buildMissionRemainingPayload,
  hasDrawableMissionPath,
  MISSION_PREFLIGHT_MAX_RETURN_DISTANCE_M,
  missionBuilderSubmission,
  missionCommandResponseDecision,
  missionCommandToken,
  missionCommandTokenAfterSync,
  missionCourseId,
  missionDraftMatches,
  missionDraftToken,
  missionEmptyResumeMode,
  missionEmptyRouteMode,
  MISSION_MAX_OCCURRENCES,
  missionMotionConfirmedHeld,
  missionNeedsManualRelease,
  missionPathActionDisabled,
  missionPathGeometry,
  missionPreflightCanConfirm,
  missionPreflightDistanceAllowed,
  missionPreflightTarget,
  missionRestoreDecision,
  missionRouteSubmissionAllowed,
  presetResponseIsCurrent,
  shouldAbandonMissionForCourseSwitch,
  shouldConsumeLegacyMissionIndexEvent,
  trackManualControlRequest,
  uncertainMissionOccurrenceIds,
  waitForManualControlDrain,
} from "../../course/web/src/lib/mission-session.mjs";

const mission = {
  id: 41,
  course_id: 7,
  plan_hash: "hash-at-open",
  occurrence_revision: "occurrences-at-open",
  protocol_version: 2,
  waypoints: [],
};

test("binds a remaining-route draft to both plan and occurrence revisions", () => {
  const draft = missionDraftToken(mission);
  const liveMission = { ...mission, plan_hash: "newer-live-hash" };
  const payload = buildMissionRemainingPayload({
    draft,
    mission: liveMission,
    finishBehavior: "return_to_start",
    items: [
      { waypoint_id: "stable-occurrence" },
      { cone_id: 92 },
    ],
  });

  assert.equal(payload.expected_plan_hash, "hash-at-open");
  assert.equal(payload.expected_occurrence_revision, "occurrences-at-open");
  assert.deepEqual(payload.items, [
    { waypoint_id: "stable-occurrence" },
    { cone_id: 92 },
  ]);
  assert.equal(missionDraftMatches(draft, liveMission), false);
  assert.equal(missionDraftMatches(draft, {
    ...mission,
    occurrence_revision: "newer-occurrences",
  }), false);
  assert.throws(() => buildMissionRemainingPayload({
    draft,
    mission: { ...mission, id: 42 },
    finishBehavior: "stop",
    items: [],
  }), /기준 버전/);
});

test("sends the plan hash captured at preflight even when the live hash changes", () => {
  const token = missionCommandToken(mission);
  const payload = buildMissionCommandPayload({ token, missionId: mission.id, force: true });
  assert.deepEqual(payload, { force: true, expected_plan_hash: "hash-at-open" });
  assert.throws(() => buildMissionCommandPayload({ token, missionId: mission.id + 1 }), /현재 미션이 다릅니다/);
  const edited = { ...mission, plan_hash: "hash-after-final-put" };
  assert.equal(missionCommandTokenAfterSync({
    routeAlreadySynced: true,
    preflightToken: token,
    editedMission: edited,
  }).planHash, "hash-at-open");
  assert.equal(missionCommandTokenAfterSync({
    routeAlreadySynced: false,
    preflightToken: token,
    editedMission: edited,
  }).planHash, "hash-after-final-put");
});

test("persists held-mission Apply and Run while keeping new plans local until creation", () => {
  assert.deepEqual(missionBuilderSubmission({ editing: true, run: false }), {
    persist: true, next: "close", routeAlreadySynced: false,
  });
  assert.deepEqual(missionBuilderSubmission({ editing: true, run: true }), {
    persist: true, next: "resume", routeAlreadySynced: true,
  });
  assert.deepEqual(missionBuilderSubmission({ editing: false, run: false }), {
    persist: false, next: "close", routeAlreadySynced: false,
  });
  assert.deepEqual(missionBuilderSubmission({ editing: false, run: true }), {
    persist: false, next: "execute", routeAlreadySynced: false,
  });
});

test("always restores a server-active mission over a different displayed route", () => {
  assert.deepEqual(missionRestoreDecision({
    mission,
    displayedMissionId: 40,
    localWaypointCount: 300,
  }), { restore: true, discardsLocalDraft: true });
  assert.equal(missionRestoreDecision({ mission, displayedMissionId: null, localWaypointCount: 300 }).discardsLocalDraft, true);
  assert.equal(missionRestoreDecision({ mission, displayedMissionId: 41, localWaypointCount: 300 }).restore, true);
});

test("selects an active mission's course without treating it as an operator switch", () => {
  assert.equal(missionCourseId(3, mission), 7);
  assert.equal(missionCourseId(7, mission), 7);
  assert.equal(shouldAbandonMissionForCourseSwitch({ missionAlignment: true, roverMode: "stopped" }), false);
  assert.equal(shouldAbandonMissionForCourseSwitch({ missionAlignment: false, roverMode: "stopped" }), true);
});

test("accepts preset responses only for the latest request and active course", () => {
  const current = { requestId: 3, latestRequestId: 3, requestedCourseId: 7, activeCourseId: 7 };
  assert.equal(presetResponseIsCurrent(current), true);
  assert.equal(presetResponseIsCurrent({ ...current, requestId: 2 }), false);
  assert.equal(presetResponseIsCurrent({ ...current, activeCourseId: 8 }), false);
});

test("ignores index-only legacy progress and spray events for protocol v2", () => {
  assert.equal(shouldConsumeLegacyMissionIndexEvent({ activeMission: mission, connectedProtocol: 2 }), false);
  assert.equal(shouldConsumeLegacyMissionIndexEvent({ activeMission: null, connectedProtocol: 1 }), true);
});

test("requires positive rover hold confirmation before held-mission controls", () => {
  assert.equal(missionMotionConfirmedHeld({ status: "interrupted", motion_confirmed_held: false }), false);
  assert.equal(missionMotionConfirmedHeld({ status: "interrupted", motion_confirmed_held: true }), true);
  assert.equal(missionMotionConfirmedHeld({ status: "paused", motion_confirmed_held: true }), true);
  assert.equal(missionMotionConfirmedHeld({ status: "interrupted" }), false);
  assert.equal(missionMotionConfirmedHeld({ status: "paused" }), true);
});

test("allows only explicit uncertainty-resolution or return-only empty held routes", () => {
  const uncertain = [{ waypoint_id: "wp-uncertain", outcome: "dispense_outcome_uncertain" }];
  const normal = [{ waypoint_id: "wp-normal", outcome: null }];
  const missionStart = { lat: 35, lng: 126 };
  assert.equal(missionEmptyRouteMode({ editing: true, routeLength: 0, initialItems: uncertain }), "resolve_uncertain");
  assert.equal(missionRouteSubmissionAllowed({ editing: true, routeLength: 0, initialItems: uncertain }), true);
  assert.equal(missionRouteSubmissionAllowed({ editing: true, routeLength: 0, initialItems: normal }), false);
  assert.equal(missionRouteSubmissionAllowed({
    editing: true, routeLength: 0, initialItems: normal,
    finishBehavior: "return_to_start", missionStart,
  }), true);
  assert.equal(missionRouteSubmissionAllowed({
    editing: true, routeLength: 0, initialItems: normal,
    finishBehavior: "return_to_start", missionStart: null,
  }), false);
  assert.equal(missionRouteSubmissionAllowed({ editing: false, routeLength: 0, initialItems: uncertain }), false);
  assert.equal(missionRouteSubmissionAllowed({ editing: false, routeLength: 1 }), true);
  assert.equal(missionRouteSubmissionAllowed({
    editing: false,
    routeLength: MISSION_MAX_OCCURRENCES + 1,
  }), false);
  assert.equal(missionEmptyResumeMode({
    finish_behavior: "stop",
    waypoints: [{ state: "skipped", outcome: "dispense_outcome_uncertain" }],
  }), "resolve_uncertain");
  assert.equal(missionEmptyResumeMode({
    finish_behavior: "return_to_start",
    start_position: missionStart,
    waypoints: [{ state: "skipped", outcome: null }],
  }), "return_only");
});

test("identifies only stable occurrences whose dispense outcome needs operator resolution", () => {
  assert.deepEqual(uncertainMissionOccurrenceIds([
    { waypoint_id: "wp-uncertain", outcome: "dispense_outcome_uncertain" },
    { waypoint_id: "wp-ok", outcome: "success" },
    { cone_id: 7, outcome: "dispense_outcome_uncertain" },
  ]), ["wp-uncertain"]);
});

test("draws zero-waypoint return-only motion from the rover to mission start", () => {
  assert.equal(hasDrawableMissionPath({ lat: 35, lng: 126 }, []), false);
  assert.equal(hasDrawableMissionPath({ lat: 35, lng: 126 }, [{ lat: 35.1, lng: 126.1 }]), true);
  assert.deepEqual(missionPathGeometry({
    pathStart: { lat: 35, lng: 126 },
    waypoints: [],
    finishBehavior: "return_to_start",
    returnOrigin: { lat: 35.1, lng: 126.1 },
  }), {
    points: [{ lat: 35.1, lng: 126.1 }, { lat: 35, lng: 126 }],
    returnOnly: true,
  });
  assert.equal(hasDrawableMissionPath({ lat: 35, lng: 126 }, [], {
    finishBehavior: "return_to_start",
    returnOrigin: { lat: 35.1, lng: 126.1 },
  }), true);
  assert.deepEqual(missionPreflightTarget({
    mode: "resume",
    waypoints: [],
    finishBehavior: "return_to_start",
    missionStart: { lat: 35, lng: 126 },
    emptyRouteMode: "return_only",
  }), { kind: "return_only", target: { lat: 35, lng: 126 } });
  assert.deepEqual(missionPreflightTarget({
    mode: "resume",
    waypoints: [],
    emptyRouteMode: "resolve_uncertain",
  }), { kind: "resolve_uncertain", target: null });
  assert.equal(missionPreflightDistanceAllowed({ kind: "return_only", distance: 42 }), true);
  assert.equal(missionPreflightDistanceAllowed({
    kind: "return_only",
    distance: MISSION_PREFLIGHT_MAX_RETURN_DISTANCE_M + 0.1,
  }), false);
  assert.equal(missionPreflightDistanceAllowed({ kind: "waypoint", distance: 42 }), false);
  assert.equal(missionPreflightDistanceAllowed({ kind: "waypoint", distance: 4.9 }), true);
  assert.equal(missionPreflightDistanceAllowed({ kind: "return_only", distance: null }), false);
});

test("fails closed on an undelivered mission command and keeps its authority body", () => {
  const interrupted = { ...mission, status: "interrupted" };
  assert.deepEqual(missionCommandResponseDecision({ delivered: false, mission: interrupted }), {
    mission: interrupted,
    delivered: false,
    failed: true,
  });
  assert.equal(missionCommandResponseDecision({ delivered: true, mission }).failed, false);
  assert.equal(missionCommandResponseDecision({ mission }).failed, true);
});

test("releases manual mode only when a newer mission authority is moving", () => {
  assert.equal(missionNeedsManualRelease({ roverMode: "manual", mission, held: false }), true);
  assert.equal(missionNeedsManualRelease({ roverMode: "manual", mission, held: true }), false);
  assert.equal(missionNeedsManualRelease({ roverMode: "stopped", mission, held: false }), false);
});

test("drains an in-flight manual command before issuing the final zero command", async () => {
  const pending = new Set();
  let finishRequest;
  const inFlight = new Promise((resolve) => { finishRequest = resolve; });
  trackManualControlRequest(pending, inFlight);
  const events = [];
  const release = (async () => {
    await waitForManualControlDrain(pending);
    events.push("zero");
  })();
  await Promise.resolve();
  assert.deepEqual(events, []);
  finishRequest();
  await release;
  assert.deepEqual(events, ["zero"]);
  assert.equal(pending.size, 0);
});

test("keeps snapshot-backed missions actionable without live cones and blocks E-Stop commands", () => {
  assert.equal(missionPathActionDisabled({
    activeConeCount: 0, activeMission: mission, roverMode: "stopped", stopping: false, emergencyStopped: false,
  }), false);
  assert.equal(missionPathActionDisabled({
    activeConeCount: 0, activeMission: null, roverMode: "none", stopping: false, emergencyStopped: false,
  }), true);
  assert.equal(missionPathActionDisabled({
    activeConeCount: 4, activeMission: mission, roverMode: "stopped", stopping: false, emergencyStopped: true,
  }), true);
  const checks = [
    { key: "estop", ok: false, blocking: true },
    { key: "battery", ok: false },
  ];
  assert.equal(missionPreflightCanConfirm(checks, true), false);
  assert.equal(missionPreflightCanConfirm([{ key: "battery", ok: false }], true), true);
  assert.equal(missionPreflightCanConfirm([{ key: "estop", ok: true, blocking: true }], false), true);
});

test("puts the last-read preset revision on updates only", () => {
  const common = {
    courseId: 7,
    name: "Morning",
    finishBehavior: "stop",
    items: [{ cone_id: 3 }],
  };
  assert.deepEqual(buildMissionPresetPayload(common), {
    course_id: 7,
    name: "Morning",
    finish_behavior: "stop",
    items: [{ cone_id: 3 }],
  });
  assert.equal(buildMissionPresetPayload({
    ...common,
    existing: { id: 4, preset_revision: "preset-at-read" },
  }).expected_preset_revision, "preset-at-read");
  assert.throws(() => buildMissionPresetPayload({ ...common, existing: { id: 4 } }), /기준 버전/);
});
