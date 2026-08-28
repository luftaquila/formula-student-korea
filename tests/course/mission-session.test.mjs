import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMissionCreatePayload,
  buildMissionCommandPayload,
  buildMissionPresetDeletePayload,
  buildMissionPresetPayload,
  buildMissionRemainingPayload,
  captureMissionAuthorityFence,
  captureMissionAuthorityRequest,
  captureMissionCreateRouteAuthority,
  hasDrawableMissionPath,
  MISSION_PREFLIGHT_MAX_RETURN_DISTANCE_M,
  missionBuilderSubmission,
  missionCommandResponseDecision,
  missionEndAwaitingState,
  missionEndReconcileShouldRetry,
  missionEndReconcileIsCurrent,
  missionEndReconcileAuthorityDecision,
  missionEndRequestFailureState,
  missionEndResponseDecision,
  missionCommandToken,
  missionCommandTokenAfterSync,
  missionAuthorityKey,
  missionAuthorityFenceMatches,
  missionAbsentSnapshotDecision,
  missionAuthorityRequestCanApply,
  missionCourseId,
  missionCreateSettlementDecision,
  missionCreateRouteAuthorityMatches,
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
  missionPreflightRouteCheck,
  missionPreflightTarget,
  missionPresetReference,
  missionRestoreDecision,
  missionSummaryRefreshDecision,
  missionHttpResponseAuthorityDecision,
  mergeMissionSummary,
  missionRouteSubmissionAllowed,
  presetResponseIsCurrent,
  reconcileMissionEndAuthorityRequest,
  shouldAbandonMissionForCourseSwitch,
  shouldConsumeLegacyMissionIndexEvent,
  splitMissionStatusPayload,
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
      { cone_id: 92, lat: 35.2, lng: 126.2, alt: null, side: "right" },
    ],
  });

  assert.equal(payload.expected_plan_hash, "hash-at-open");
  assert.equal(payload.expected_occurrence_revision, "occurrences-at-open");
  assert.deepEqual(payload.items, [
    { waypoint_id: "stable-occurrence" },
    { cone_id: 92, lat: 35.2, lng: 126.2, alt: null, side: "right" },
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

test("sends the plan and occurrence revisions captured at preflight", () => {
  const token = missionCommandToken(mission);
  const payload = buildMissionCommandPayload({ token, missionId: mission.id, force: true });
  assert.deepEqual(payload, {
    force: true,
    expected_plan_hash: "hash-at-open",
    expected_occurrence_revision: "occurrences-at-open",
  });
  assert.throws(() => buildMissionCommandPayload({ token, missionId: mission.id + 1 }), /현재 미션이 다릅니다/);
  assert.equal(missionCommandToken({ ...mission, occurrence_revision: null }), null);
  const edited = {
    ...mission,
    plan_hash: "hash-after-final-put",
    occurrence_revision: "occurrences-after-final-put",
  };
  assert.equal(missionCommandTokenAfterSync({
    routeAlreadySynced: true,
    preflightToken: token,
    editedMission: edited,
  }).planHash, "hash-at-open");
  assert.equal(missionCommandTokenAfterSync({
    routeAlreadySynced: true,
    preflightToken: token,
    editedMission: edited,
  }).occurrenceRevision, "occurrences-at-open");
  assert.equal(missionCommandTokenAfterSync({
    routeAlreadySynced: false,
    preflightToken: token,
    editedMission: edited,
  }).planHash, "hash-after-final-put");
  assert.equal(missionCommandTokenAfterSync({
    routeAlreadySynced: false,
    preflightToken: token,
    editedMission: edited,
  }).occurrenceRevision, "occurrences-after-final-put");
});

test("sends the reviewed cone geometry when creating a mission", () => {
  assert.deepEqual(buildMissionCreatePayload({
    courseId: 7,
    finishBehavior: "return_to_start",
    items: [{ cone_id: 11, lat: 35.1, lng: 126.1, side: "right" }],
  }), {
    course_id: 7,
    finish_behavior: "return_to_start",
    items: [{ cone_id: 11, lat: 35.1, lng: 126.1, alt: null, side: "right" }],
  });
});

test("keeps preset attribution only while the reviewed route still matches", () => {
  const preset = {
    id: 4,
    preset_revision: "preset-at-read",
    finish_behavior: "stop",
    stale: false,
    items: [{ cone_id: 11 }, { cone_id: 12 }],
  };
  const items = [
    { cone_id: 11, lat: 35.1, lng: 126.1, alt: null, side: "left" },
    { cone_id: 12, lat: 35.2, lng: 126.2, alt: null, side: "right" },
  ];
  const reference = missionPresetReference({ preset, items, finishBehavior: "stop" });
  assert.deepEqual(buildMissionCreatePayload({
    courseId: 7,
    finishBehavior: "stop",
    items,
    presetReference: reference,
  }), {
    course_id: 7,
    finish_behavior: "stop",
    items,
    preset_id: 4,
    expected_preset_revision: "preset-at-read",
  });
  assert.equal(missionPresetReference({
    preset,
    items: [...items].reverse(),
    finishBehavior: "stop",
  }), null);
  assert.equal(missionPresetReference({
    preset: { ...preset, stale: true },
    items,
    finishBehavior: "stop",
  }), null);
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

test("fences delayed status and mutation snapshots behind newer mission authority", () => {
  const ready = {
    ...mission,
    status: "ready",
    motion_confirmed_held: true,
    active_command_id: null,
  };
  const token = captureMissionAuthorityRequest({ requestId: 1, authorityGeneration: 3, mission: ready });
  assert.equal(missionAuthorityRequestCanApply({
    token,
    latestRequestId: 1,
    currentAuthorityGeneration: 3,
    currentMission: ready,
  }), true);
  const running = {
    ...ready,
    status: "running",
    motion_confirmed_held: false,
    active_command_id: "start-1",
  };
  assert.notEqual(missionAuthorityKey(ready), missionAuthorityKey(running));
  assert.equal(missionAuthorityRequestCanApply({
    token,
    latestRequestId: 1,
    currentAuthorityGeneration: 4,
    currentMission: running,
  }), false);
  assert.deepEqual(missionHttpResponseAuthorityDecision({
    token,
    latestRequestId: 1,
    currentAuthorityGeneration: 4,
    currentMission: running,
    responseMission: ready,
  }), {
    requestCurrent: false,
    installResponse: false,
    responseMatchesCurrent: false,
    terminalSeen: false,
  });

  assert.equal(missionHttpResponseAuthorityDecision({
    token,
    latestRequestId: 1,
    currentAuthorityGeneration: 4,
    currentMission: running,
    responseMission: { ...running, waypoints: [] },
  }).installResponse, true);

  const split = splitMissionStatusPayload({
    connected: true,
    active_mission: ready,
    active_mission_summary: running,
  });
  assert.deepEqual(split.status, { connected: true });
  assert.equal(split.activeMission, ready);
  assert.equal(split.activeMissionSummary, running);
  assert.equal(mergeMissionSummary({ ...ready, waypoints: [] }, running).status, "running");
});

test("fences an open preflight against intervening mission authority even after ABA", () => {
  const paused = {
    ...mission,
    status: "paused",
    motion_confirmed_held: true,
    active_command_id: null,
  };
  const token = captureMissionAuthorityFence({ authorityGeneration: 7, mission: paused });
  assert.equal(missionAuthorityFenceMatches({
    token,
    currentAuthorityGeneration: 7,
    currentMission: paused,
  }), true);
  assert.equal(missionAuthorityFenceMatches({
    token,
    currentAuthorityGeneration: 9,
    currentMission: { ...paused },
  }), false);
});

test("invalidates pending mission creation when its reviewed course or route changes", () => {
  const token = captureMissionCreateRouteAuthority({
    requestId: 4,
    courseId: 7,
    routeGeneration: 12,
  });
  const current = {
    token,
    latestRequestId: 4,
    currentCourseId: 7,
    currentRouteGeneration: 12,
  };
  assert.equal(missionCreateRouteAuthorityMatches(current), true);
  assert.equal(missionCreateRouteAuthorityMatches({ ...current, currentCourseId: 8 }), false);
  assert.equal(missionCreateRouteAuthorityMatches({ ...current, currentRouteGeneration: 13 }), false);
  assert.equal(missionCreateRouteAuthorityMatches({ ...current, latestRequestId: 5 }), false);
});

test("clears a pending local route when only foreign summary authority remains", () => {
  assert.deepEqual(missionCreateSettlementDecision({
    requestId: 4,
    latestRequestId: 4,
    authorityMission: mission,
    hasFullSnapshot: false,
  }), { clearLocalRoute: true, recoverSnapshot: true });
  assert.deepEqual(missionCreateSettlementDecision({
    requestId: 4,
    latestRequestId: 4,
    authorityMission: mission,
    hasFullSnapshot: true,
  }), { clearLocalRoute: false, recoverSnapshot: false });
  assert.deepEqual(missionCreateSettlementDecision({
    requestId: 3,
    latestRequestId: 4,
    authorityMission: mission,
    hasFullSnapshot: false,
  }), { clearLocalRoute: false, recoverSnapshot: false });
});

test("treats summary-only mission absence as terminal server route authority", () => {
  assert.deepEqual(missionAbsentSnapshotDecision({
    displayedMissionId: null,
    authorityMissionId: mission.id,
    awaitingMissionId: mission.id,
  }), {
    clearsDisplayedMission: true,
    preservesLocalPlan: false,
    terminalMissionId: mission.id,
    acknowledgesPendingEnd: true,
  });
  assert.deepEqual(missionAbsentSnapshotDecision({
    displayedMissionId: null,
    authorityMissionId: null,
  }), {
    clearsDisplayedMission: false,
    preservesLocalPlan: true,
    terminalMissionId: null,
    acknowledgesPendingEnd: false,
  });
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
    finish_behavior: "stop",
    empty_plan_mode: "resolve_uncertain",
    waypoints: [],
  }), "resolve_uncertain");
  assert.equal(missionEmptyResumeMode({
    finish_behavior: "stop",
    empty_plan_mode: "uncertainty_resolved",
    waypoints: [],
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

test("checks every internal and return leg against the server segment limit", () => {
  const near = { lat: 35, lng: 126, state: "pending" };
  const far = { lat: 35.001, lng: 126, state: "pending" };
  assert.deepEqual(missionPreflightRouteCheck({
    mode: "execute",
    waypoints: [near, { lat: 35.0001, lng: 126 }],
  }), { ok: true, reason: null, index: null, distance: null });
  const segment = missionPreflightRouteCheck({ mode: "execute", waypoints: [near, far] });
  assert.equal(segment.ok, false);
  assert.equal(segment.reason, "segment_too_long");
  assert.equal(segment.index, 1);
  const resume = missionPreflightRouteCheck({
    mode: "resume",
    waypoints: [{ ...far, state: "completed" }, near],
    finishBehavior: "return_to_start",
    returnPoint: far,
  });
  assert.equal(resume.reason, "return_segment_too_long");
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

test("keeps an accepted End until terminal authority and fences a delayed response", () => {
  const interrupted = { ...mission, status: "interrupted", active_command_id: "end-1" };
  assert.deepEqual(missionEndResponseDecision({ delivered: true, command_id: "end-1", mission: interrupted }), {
    mission: interrupted,
    delivered: true,
    failed: false,
    commandId: "end-1",
    commandPending: true,
    terminalSeen: false,
    keepMission: true,
    awaitAcknowledgement: true,
    releaseAwaitingAcknowledgement: false,
  });
  assert.equal(missionEndResponseDecision(
    { delivered: true, command_id: "end-1", mission: interrupted },
    new Set([mission.id]),
  ).keepMission, false);
  const offlinePending = missionEndResponseDecision({
    delivered: false,
    command_id: "end-1",
    mission: interrupted,
  });
  assert.equal(offlinePending.failed, false);
  assert.equal(offlinePending.awaitAcknowledgement, true);
  const failed = missionEndResponseDecision({
    delivered: false,
    command_id: "end-1",
    mission: { ...interrupted, active_command_id: null },
  });
  assert.equal(failed.keepMission, true);
  assert.equal(failed.releaseAwaitingAcknowledgement, true);

  const pending = missionEndAwaitingState({
    awaitingMissionId: mission.id,
    authorityMission: interrupted,
    responseDecision: offlinePending,
  });
  assert.deepEqual(pending, { missionId: mission.id, commandId: "end-1" });
  assert.deepEqual(missionEndAwaitingState({
    awaitingMissionId: mission.id,
    authorityMission: { ...interrupted, active_command_id: null },
    responseDecision: offlinePending,
  }), { missionId: mission.id, commandId: "end-1" });
  assert.deepEqual(missionEndAwaitingState({
    awaitingMissionId: pending.missionId,
    awaitingCommandId: pending.commandId,
    authorityMission: { ...interrupted, active_command_id: null, hold_reason: "rover_rebooted" },
  }), { missionId: null, commandId: null });
  assert.deepEqual(missionEndAwaitingState({
    awaitingMissionId: mission.id,
    authorityMission: { ...interrupted, hold_reason: "rover_rebooted" },
    responseDecision: failed,
  }), { missionId: null, commandId: null });
});

test("reconciles a lost End response from authoritative pending or failed state", () => {
  const pending = { ...mission, status: "paused", active_command_id: "end-after-loss" };
  assert.deepEqual(missionEndRequestFailureState({
    awaitingMissionId: mission.id,
    requestedMissionId: mission.id,
    authorityMission: pending,
  }), { missionId: mission.id, commandId: "end-after-loss" });
  assert.deepEqual(missionEndRequestFailureState({
    awaitingMissionId: mission.id,
    requestedMissionId: mission.id,
    authorityMission: { ...pending, status: "interrupted", active_command_id: null },
  }), { missionId: null, commandId: null });
  assert.deepEqual(missionEndRequestFailureState({
    awaitingMissionId: mission.id,
    requestedMissionId: mission.id,
    authorityMission: null,
  }), { missionId: null, commandId: null });
  assert.equal(missionEndReconcileShouldRetry({
    awaitingMissionId: mission.id,
    requestedMissionId: mission.id,
  }), true);
  assert.equal(missionEndReconcileShouldRetry({
    awaitingMissionId: null,
    requestedMissionId: mission.id,
  }), false);
  assert.equal(missionEndReconcileIsCurrent({
    expectedEpoch: 4,
    currentEpoch: 4,
    awaitingMissionId: mission.id,
    requestedMissionId: mission.id,
  }), true);
  assert.equal(missionEndReconcileIsCurrent({
    expectedEpoch: 4,
    currentEpoch: 5,
    awaitingMissionId: 99,
    requestedMissionId: mission.id,
  }), false);
  assert.deepEqual(missionEndRequestFailureState({
    awaitingMissionId: 99,
    awaitingCommandId: "successor-end",
    requestedMissionId: mission.id,
    authorityMission: pending,
  }), { missionId: 99, commandId: "successor-end" });
  assert.deepEqual(missionEndReconcileAuthorityDecision({
    authorityChangedDuringRequest: true,
    responseMission: pending,
    currentMission: { ...pending, active_command_id: null },
  }), { resolve: false, authorityMission: null });
  assert.deepEqual(missionEndReconcileAuthorityDecision({
    authorityChangedDuringRequest: true,
    responseMission: pending,
    currentMission: { ...pending },
  }), { resolve: true, authorityMission: { ...pending } });
});

test("orchestrates delayed End reconciliation without crossing mission epochs", async () => {
  const pendingEnd = { ...mission, status: "paused", active_command_id: "end-delayed" };
  let state = {
    epoch: 1,
    awaitingMissionId: mission.id,
    authorityGeneration: 10,
    authorityMission: { ...pendingEnd, active_command_id: null },
  };
  let releaseOld;
  const oldFetch = new Promise((resolve) => { releaseOld = resolve; });
  const oldRequest = reconcileMissionEndAuthorityRequest({
    requestedMissionId: mission.id,
    expectedEpoch: 1,
    authorityGenerationAtStart: 10,
    getCurrentState: () => state,
    fetchActiveMission: () => oldFetch,
  });
  state = {
    epoch: 2,
    awaitingMissionId: 99,
    authorityGeneration: 11,
    authorityMission: { ...pendingEnd, id: 99, active_command_id: "successor-end" },
  };
  releaseOld(pendingEnd);
  assert.deepEqual(await oldRequest, {
    outcome: "stale",
    authorityMission: null,
    installResponse: false,
  });
  assert.equal(state.authorityMission.active_command_id, "successor-end");

  state = {
    epoch: 3,
    awaitingMissionId: mission.id,
    authorityGeneration: 20,
    authorityMission: { ...pendingEnd, active_command_id: null },
  };
  let releaseCrossChannel;
  const crossChannelFetch = new Promise((resolve) => { releaseCrossChannel = resolve; });
  const crossChannel = reconcileMissionEndAuthorityRequest({
    requestedMissionId: mission.id,
    expectedEpoch: 3,
    authorityGenerationAtStart: 20,
    getCurrentState: () => state,
    fetchActiveMission: () => crossChannelFetch,
  });
  state = { ...state, authorityGeneration: 21 };
  releaseCrossChannel(pendingEnd);
  assert.equal((await crossChannel).outcome, "retry");

  state = { ...state, authorityMission: pendingEnd };
  assert.deepEqual(await reconcileMissionEndAuthorityRequest({
    requestedMissionId: mission.id,
    expectedEpoch: 3,
    authorityGenerationAtStart: 21,
    getCurrentState: () => state,
    fetchActiveMission: async () => pendingEnd,
  }), {
    outcome: "resolve",
    authorityMission: pendingEnd,
    installResponse: true,
  });
});

test("deduplicates unchanged full summaries while retrying summary-only recovery", () => {
  const summary = { ...mission, status: "running", motion_confirmed_held: false };
  const key = missionAuthorityKey(summary);
  for (let index = 0; index < 100; index += 1) {
    assert.deepEqual(missionSummaryRefreshDecision({
      summary,
      observedAuthorityKey: key,
      hasFullSnapshot: true,
    }), {
      valid: true,
      unchanged: true,
      recoverSnapshot: false,
      summaryKey: key,
    });
  }
  assert.equal(missionSummaryRefreshDecision({
    summary,
    observedAuthorityKey: key,
    hasFullSnapshot: false,
  }).recoverSnapshot, true);
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

test("puts reviewed geometry on preset writes and revision tokens on mutations", () => {
  const common = {
    courseId: 7,
    name: "Morning",
    finishBehavior: "stop",
    items: [{ cone_id: 3, lat: 35.1, lng: 126.1, side: "left" }],
  };
  assert.deepEqual(buildMissionPresetPayload(common), {
    course_id: 7,
    name: "Morning",
    finish_behavior: "stop",
    items: [{ cone_id: 3, lat: 35.1, lng: 126.1, alt: null, side: "left" }],
  });
  assert.equal(buildMissionPresetPayload({
    ...common,
    existing: { id: 4, preset_revision: "preset-at-read" },
  }).expected_preset_revision, "preset-at-read");
  assert.throws(() => buildMissionPresetPayload({ ...common, existing: { id: 4 } }), /기준 버전/);
  assert.deepEqual(buildMissionPresetDeletePayload({ preset_revision: "preset-at-read" }), {
    expected_preset_revision: "preset-at-read",
  });
  assert.throws(() => buildMissionPresetDeletePayload({ id: 4 }), /기준 버전/);
});
