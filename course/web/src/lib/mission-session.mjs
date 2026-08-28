export const MISSION_MAX_OCCURRENCES = 1000;

export function missionDraftToken(mission) {
  if (!mission || !Number.isInteger(mission.id)
      || typeof mission.plan_hash !== "string"
      || typeof mission.occurrence_revision !== "string") return null;
  return Object.freeze({
    missionId: mission.id,
    planHash: mission.plan_hash,
    occurrenceRevision: mission.occurrence_revision,
  });
}

export function missionDraftMatches(draft, mission) {
  return !!draft && !!mission
    && draft.missionId === mission.id
    && draft.planHash === mission.plan_hash
    && draft.occurrenceRevision === mission.occurrence_revision;
}

export function missionCommandToken(mission) {
  if (!mission || !Number.isInteger(mission.id)
      || typeof mission.plan_hash !== "string"
      || typeof mission.occurrence_revision !== "string") return null;
  return Object.freeze({
    missionId: mission.id,
    planHash: mission.plan_hash,
    occurrenceRevision: mission.occurrence_revision,
  });
}

export function buildMissionCommandPayload({ token, missionId, force = false }) {
  if (!token || token.missionId !== missionId
      || typeof token.planHash !== "string"
      || typeof token.occurrenceRevision !== "string") {
    throw Object.assign(new Error("점검한 미션과 현재 미션이 다릅니다. 최신 미션을 다시 점검하세요."), {
      reason: "mission_preflight_mismatch",
    });
  }
  return {
    force: force === true,
    expected_plan_hash: token.planHash,
    expected_occurrence_revision: token.occurrenceRevision,
  };
}

export function missionCommandTokenAfterSync({ routeAlreadySynced, preflightToken, editedMission }) {
  return routeAlreadySynced === true ? preflightToken : missionCommandToken(editedMission);
}

export function buildMissionCreatePayload({ courseId, finishBehavior, items, presetReference = null }) {
  const coneIds = items.map((item) => item.cone_id);
  const presetMatches = presetReference
    && Number.isInteger(presetReference.id)
    && typeof presetReference.revision === "string"
    && presetReference.finishBehavior === finishBehavior
    && Array.isArray(presetReference.coneIds)
    && presetReference.coneIds.length === coneIds.length
    && presetReference.coneIds.every((coneId, index) => coneId === coneIds[index]);
  return {
    course_id: courseId,
    finish_behavior: finishBehavior,
    items: items.map((item) => ({
      cone_id: item.cone_id,
      lat: item.lat,
      lng: item.lng,
      alt: item.alt ?? null,
      side: item.side ?? null,
    })),
    ...(presetMatches ? {
      preset_id: presetReference.id,
      expected_preset_revision: presetReference.revision,
    } : {}),
  };
}

export function missionMotionConfirmedHeld(mission) {
  if (!mission) return false;
  if (mission.motion_confirmed_held != null) return mission.motion_confirmed_held === true;
  // Compatibility for a server response produced during a rolling deploy.
  // Interrupted is deliberately excluded because it may only mean that the
  // network disappeared while the rover kept driving autonomously.
  return mission.status === "ready" || mission.status === "paused";
}

export function buildMissionRemainingPayload({ draft, mission, finishBehavior, items }) {
  if (!draft || !mission || draft.missionId !== mission.id
      || typeof draft.planHash !== "string"
      || typeof draft.occurrenceRevision !== "string") {
    throw Object.assign(new Error("미션 경로 초안의 기준 버전이 없습니다. 최신 미션을 다시 불러오세요."), {
      reason: "mission_draft_mismatch",
    });
  }
  return {
    expected_plan_hash: draft.planHash,
    expected_occurrence_revision: draft.occurrenceRevision,
    finish_behavior: finishBehavior,
    items: items.map((waypoint) => (waypoint.waypoint_id || typeof waypoint.id === "string")
      ? { waypoint_id: waypoint.waypoint_id || waypoint.id }
      : {
          cone_id: waypoint.cone_id,
          lat: waypoint.lat,
          lng: waypoint.lng,
          alt: waypoint.alt ?? null,
          side: waypoint.side ?? null,
        }),
  };
}

export function missionBuilderSubmission({ editing, run }) {
  return {
    persist: editing === true,
    next: run === true ? (editing ? "resume" : "execute") : "close",
    routeAlreadySynced: editing === true && run === true,
  };
}

export function missionEmptyRouteMode({
  editing,
  routeLength,
  finishBehavior = "stop",
  initialItems = [],
  missionStart = null,
}) {
  if (editing !== true || routeLength !== 0) return null;
  if (finishBehavior === "return_to_start"
      && Number.isFinite(missionStart?.lat) && Number.isFinite(missionStart?.lng)) {
    return "return_only";
  }
  const pending = Array.isArray(initialItems) ? initialItems : [];
  if (pending.length > 0
      && pending.every((item) => item?.outcome === "dispense_outcome_uncertain")) {
    return "resolve_uncertain";
  }
  return null;
}

export function missionRouteSubmissionAllowed(options) {
  return options.routeLength <= MISSION_MAX_OCCURRENCES
    && (options.routeLength > 0 || missionEmptyRouteMode(options) !== null);
}

export function missionEmptyResumeMode(mission) {
  if (!mission || !Array.isArray(mission.waypoints)
      || mission.waypoints.some((item) => item?.state === "pending" || item?.state === "active")) return null;
  if (mission.empty_plan_mode === "return_only") return "return_only";
  if (mission.empty_plan_mode === "uncertainty_resolved"
      || mission.empty_plan_mode === "resolve_uncertain") return "resolve_uncertain";
  if (mission.finish_behavior === "return_to_start"
      && Number.isFinite(mission.start_position?.lat) && Number.isFinite(mission.start_position?.lng)) {
    return "return_only";
  }
  if (mission.waypoints.some((item) => item?.state === "skipped"
      && item?.outcome === "dispense_outcome_uncertain")) {
    return "resolve_uncertain";
  }
  return null;
}

export function missionPreflightTarget({
  mode,
  waypoints = [],
  finishBehavior = "stop",
  missionStart = null,
  emptyRouteMode = null,
}) {
  if (emptyRouteMode === "resolve_uncertain") {
    return { kind: "resolve_uncertain", target: null };
  }
  if (emptyRouteMode === "return_only") {
    return { kind: "return_only", target: missionStart };
  }
  const route = Array.isArray(waypoints) ? waypoints : [];
  const target = mode === "execute"
    ? route[0]
    : (route.find((waypoint) => waypoint?.state === "pending" || waypoint?.state === "active")
      || (finishBehavior === "return_to_start" ? missionStart : null));
  return { kind: "waypoint", target: target || null };
}

export const MISSION_PREFLIGHT_MAX_RETURN_DISTANCE_M = 200;
export const MISSION_PREFLIGHT_MAX_SEGMENT_DISTANCE_M = 50;

function missionGeoDistance(left, right) {
  if (![left?.lat, left?.lng, right?.lat, right?.lng].every(Number.isFinite)) return null;
  const radians = (value) => value * Math.PI / 180;
  const deltaLat = radians(right.lat - left.lat);
  const deltaLng = radians(right.lng - left.lng);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(radians(left.lat)) * Math.cos(radians(right.lat))
    * Math.sin(deltaLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function missionPreflightRouteCheck({
  mode,
  waypoints = [],
  finishBehavior = "stop",
  returnPoint = null,
}) {
  const route = (Array.isArray(waypoints) ? waypoints : [])
    .filter((item) => mode === "execute"
      || item?.state === "pending" || item?.state === "active");
  for (let index = 1; index < route.length; index += 1) {
    const distance = missionGeoDistance(route[index - 1], route[index]);
    if (!Number.isFinite(distance) || distance > MISSION_PREFLIGHT_MAX_SEGMENT_DISTANCE_M) {
      return { ok: false, reason: "segment_too_long", index, distance };
    }
  }
  if (finishBehavior === "return_to_start" && route.length > 0) {
    const distance = missionGeoDistance(route[route.length - 1], returnPoint);
    if (!Number.isFinite(distance) || distance > MISSION_PREFLIGHT_MAX_SEGMENT_DISTANCE_M) {
      return { ok: false, reason: "return_segment_too_long", index: route.length, distance };
    }
  }
  return { ok: true, reason: null, index: null, distance: null };
}

export function missionPreflightDistanceAllowed({ kind, distance }) {
  if (kind === "resolve_uncertain") return true;
  if (!Number.isFinite(distance) || distance < 0) return false;
  // A return-only leg begins at the rover's current position, so its total
  // distance uses the server's normal first-leg geofence rather than the 5 m
  // operator alignment guard applied to a planned first waypoint.
  return kind === "return_only"
    ? distance <= MISSION_PREFLIGHT_MAX_RETURN_DISTANCE_M
    : distance < 5;
}

export function uncertainMissionOccurrenceIds(items) {
  return items
    .filter((item) => item?.outcome === "dispense_outcome_uncertain")
    .map((item) => item.waypoint_id || item.id)
    .filter((id) => typeof id === "string" && id.length > 0);
}

export function missionPathGeometry({ pathStart, waypoints, finishBehavior = "stop", returnOrigin = null }) {
  if (!Number.isFinite(pathStart?.lat) || !Number.isFinite(pathStart?.lng)
      || !Array.isArray(waypoints)) return null;
  if (waypoints.length > 0) {
    const points = [pathStart, ...waypoints];
    if (finishBehavior === "return_to_start") points.push(pathStart);
    return { points, returnOnly: false };
  }
  if (finishBehavior === "return_to_start"
      && Number.isFinite(returnOrigin?.lat) && Number.isFinite(returnOrigin?.lng)) {
    return { points: [returnOrigin, pathStart], returnOnly: true };
  }
  return null;
}

export function hasDrawableMissionPath(pathStart, waypoints, options = {}) {
  return missionPathGeometry({ pathStart, waypoints, ...options }) !== null;
}

export function missionCommandResponseDecision(data) {
  const mission = data?.mission && typeof data.mission === "object" ? data.mission : null;
  return {
    mission,
    delivered: data?.delivered === true,
    failed: data?.delivered !== true,
  };
}

export function missionEndResponseDecision(data, terminalMissionIds = new Set()) {
  const decision = missionCommandResponseDecision(data);
  const missionId = Number.isInteger(decision.mission?.id) ? decision.mission.id : null;
  const commandId = typeof data?.command_id === "string" ? data.command_id : null;
  const terminalSeen = missionId != null && terminalMissionIds.has(missionId);
  const commandPending = commandId != null
    && decision.mission?.active_command_id === commandId;
  const accepted = terminalSeen || commandPending;
  return {
    ...decision,
    failed: !accepted,
    commandId,
    commandPending,
    terminalSeen,
    keepMission: decision.mission != null && !terminalSeen,
    awaitAcknowledgement: commandPending && !terminalSeen,
    releaseAwaitingAcknowledgement: !commandPending || terminalSeen,
  };
}

export function missionEndAwaitingState({
  awaitingMissionId,
  awaitingCommandId = null,
  authorityMission = null,
  responseDecision = null,
}) {
  let missionId = awaitingMissionId;
  let commandId = awaitingCommandId;
  const responseMissionId = responseDecision?.mission?.id;
  if (responseDecision?.releaseAwaitingAcknowledgement
      && responseMissionId === missionId) {
    return { missionId: null, commandId: null };
  }
  if (responseDecision?.awaitAcknowledgement && responseMissionId === missionId) {
    return { missionId, commandId: responseDecision.commandId };
  }
  if (missionId != null && commandId != null
      && authorityMission?.id === missionId
      && authorityMission.active_command_id !== commandId) {
    missionId = null;
    commandId = null;
  }
  return { missionId, commandId };
}

export function missionEndRequestFailureState({
  awaitingMissionId,
  awaitingCommandId = null,
  requestedMissionId,
  authorityMission,
}) {
  if (awaitingMissionId !== requestedMissionId) {
    return { missionId: awaitingMissionId, commandId: awaitingCommandId };
  }
  if (authorityMission?.id !== requestedMissionId) {
    return { missionId: null, commandId: null };
  }
  const commandId = typeof authorityMission.active_command_id === "string"
    ? authorityMission.active_command_id : null;
  return commandId == null
    ? { missionId: null, commandId: null }
    : { missionId: requestedMissionId, commandId };
}

export function missionEndReconcileShouldRetry({ awaitingMissionId, requestedMissionId }) {
  return Number.isInteger(requestedMissionId) && awaitingMissionId === requestedMissionId;
}

export function missionEndReconcileIsCurrent({
  expectedEpoch,
  currentEpoch,
  awaitingMissionId,
  requestedMissionId,
}) {
  return expectedEpoch === currentEpoch
    && missionEndReconcileShouldRetry({ awaitingMissionId, requestedMissionId });
}

export function missionEndReconcileAuthorityDecision({
  authorityChangedDuringRequest,
  responseMission,
  currentMission,
}) {
  if (!authorityChangedDuringRequest) {
    return { resolve: true, authorityMission: responseMission ?? null };
  }
  const responseKey = missionAuthorityKey(responseMission ?? null);
  const currentKey = missionAuthorityKey(currentMission ?? null);
  if (responseKey != null && responseKey === currentKey) {
    return { resolve: true, authorityMission: currentMission ?? null };
  }
  return { resolve: false, authorityMission: null };
}

export async function reconcileMissionEndAuthorityRequest({
  requestedMissionId,
  expectedEpoch,
  authorityGenerationAtStart,
  getCurrentState,
  fetchActiveMission,
}) {
  const current = () => {
    const state = getCurrentState();
    return {
      ...state,
      valid: missionEndReconcileIsCurrent({
        expectedEpoch,
        currentEpoch: state.epoch,
        awaitingMissionId: state.awaitingMissionId,
        requestedMissionId,
      }),
    };
  };
  if (!current().valid) return { outcome: "stale", authorityMission: null, installResponse: false };
  let responseMission;
  try {
    responseMission = await fetchActiveMission();
  } catch {
    return current().valid
      ? { outcome: "retry", authorityMission: null, installResponse: false }
      : { outcome: "stale", authorityMission: null, installResponse: false };
  }
  const latest = current();
  if (!latest.valid) return { outcome: "stale", authorityMission: null, installResponse: false };
  const authorityChangedDuringRequest = authorityGenerationAtStart !== latest.authorityGeneration;
  const authority = missionEndReconcileAuthorityDecision({
    authorityChangedDuringRequest,
    responseMission,
    currentMission: latest.authorityMission,
  });
  if (!authority.resolve) return { outcome: "retry", authorityMission: null, installResponse: false };
  return {
    outcome: "resolve",
    authorityMission: authority.authorityMission,
    installResponse: !authorityChangedDuringRequest,
  };
}

export function missionSummaryRefreshDecision({
  summary,
  observedAuthorityKey,
  hasFullSnapshot,
}) {
  const summaryKey = missionAuthorityKey(summary);
  if (summaryKey == null) return { valid: false, unchanged: false, recoverSnapshot: false, summaryKey: null };
  const unchanged = summaryKey === observedAuthorityKey;
  return {
    valid: true,
    unchanged,
    recoverSnapshot: unchanged && !hasFullSnapshot,
    summaryKey,
  };
}

export function captureMissionAuthorityFence({ authorityGeneration, mission }) {
  const missionKey = missionAuthorityKey(mission);
  if (!Number.isInteger(authorityGeneration) || missionKey == null
      || !Number.isInteger(mission?.id)) return null;
  return Object.freeze({
    authorityGeneration,
    missionId: mission.id,
    missionKey,
  });
}

export function missionAuthorityFenceMatches({ token, currentAuthorityGeneration, currentMission }) {
  return !!token
    && token.authorityGeneration === currentAuthorityGeneration
    && token.missionId === currentMission?.id
    && token.missionKey === missionAuthorityKey(currentMission);
}

export function missionNeedsManualRelease({ roverMode, mission, held }) {
  return roverMode === "manual" && !!mission && held !== true;
}

export function trackManualControlRequest(pending, requestPromise) {
  const tracked = Promise.resolve(requestPromise);
  pending.add(tracked);
  tracked.then(
    () => pending.delete(tracked),
    () => pending.delete(tracked),
  );
  return tracked;
}

export function waitForManualControlDrain(pending) {
  return Promise.allSettled([...pending]);
}

export function missionPathActionDisabled({
  activeConeCount,
  activeMission,
  roverMode,
  stopping,
  emergencyStopped,
}) {
  const commandMode = roverMode === "stopped" || roverMode === "path-ready";
  return (activeConeCount === 0 && !activeMission)
    || roverMode === "manual"
    || (stopping === true && (roverMode === "executing" || roverMode === "stopped"))
    || (emergencyStopped === true && commandMode);
}

export function missionPreflightCanConfirm(checks, force = false) {
  const allOk = checks.every((check) => check.ok === true);
  const blockingFailure = checks.some((check) => check.blocking === true && check.ok !== true);
  return allOk || (force === true && !blockingFailure);
}

export function buildMissionPresetPayload({ courseId, name, finishBehavior, items, existing = null }) {
  if (existing && typeof existing.preset_revision !== "string") {
    throw Object.assign(new Error("프리셋의 기준 버전이 없습니다. 목록을 다시 불러오세요."), {
      reason: "preset_revision_missing",
    });
  }
  return {
    course_id: courseId,
    name,
    finish_behavior: finishBehavior,
    items: items.map((item) => ({
      cone_id: item.cone_id,
      lat: item.lat,
      lng: item.lng,
      alt: item.alt ?? null,
      side: item.side ?? null,
    })),
    ...(existing ? { expected_preset_revision: existing.preset_revision } : {}),
  };
}

export function buildMissionPresetDeletePayload(preset) {
  if (!preset || typeof preset.preset_revision !== "string") {
    throw Object.assign(new Error("프리셋의 기준 버전이 없습니다. 목록을 다시 불러오세요."), {
      reason: "preset_revision_missing",
    });
  }
  return { expected_preset_revision: preset.preset_revision };
}

export function missionPresetReference({ preset, items, finishBehavior }) {
  if (!preset || preset.stale === true || !Number.isInteger(preset.id)
      || typeof preset.preset_revision !== "string"
      || preset.finish_behavior !== finishBehavior) return null;
  const presetItems = Array.isArray(preset.items) ? preset.items : [];
  const routeItems = Array.isArray(items) ? items : [];
  if (presetItems.length !== routeItems.length
      || presetItems.some((item, index) => item.cone_id !== routeItems[index]?.cone_id)) return null;
  return Object.freeze({
    id: preset.id,
    revision: preset.preset_revision,
    finishBehavior,
    coneIds: Object.freeze(routeItems.map((item) => item.cone_id)),
  });
}

export function missionRestoreDecision({ mission, displayedMissionId, localWaypointCount = 0 }) {
  if (!mission || !Array.isArray(mission.waypoints)) return { restore: false, discardsLocalDraft: false };
  return {
    restore: true,
    discardsLocalDraft: localWaypointCount > 0
      && displayedMissionId !== mission.id,
  };
}

export function missionAbsentSnapshotDecision({
  displayedMissionId,
  authorityMissionId = null,
  awaitingMissionId = null,
}) {
  const terminalMissionId = Number.isInteger(displayedMissionId)
    ? displayedMissionId
    : (Number.isInteger(authorityMissionId) ? authorityMissionId : null);
  const clearsDisplayedMission = terminalMissionId != null;
  return {
    clearsDisplayedMission,
    preservesLocalPlan: !clearsDisplayedMission,
    terminalMissionId,
    acknowledgesPendingEnd: clearsDisplayedMission && awaitingMissionId === terminalMissionId,
  };
}

export function missionAuthorityKey(mission) {
  if (mission == null) return "absent";
  if (!Number.isInteger(mission?.id)
      || typeof mission?.plan_hash !== "string"
      || typeof mission?.occurrence_revision !== "string"
      || typeof mission?.status !== "string") return null;
  return JSON.stringify([
    mission.id,
    mission.plan_hash,
    mission.occurrence_revision,
    mission.status,
    mission.motion_confirmed_held ?? null,
    mission.active_command_id ?? null,
    mission.active_hold_id ?? null,
    mission.hold_reason ?? null,
    mission.empty_plan_mode ?? null,
  ]);
}

export function missionSummaryKey(mission) {
  if (!Number.isInteger(mission?.id) || typeof mission?.occurrence_revision !== "string") return null;
  return `${mission.id}:${mission.occurrence_revision}`;
}

export function captureMissionAuthorityRequest({ requestId, authorityGeneration, mission }) {
  const authorityKey = missionAuthorityKey(mission);
  if (!Number.isInteger(requestId) || requestId <= 0
      || !Number.isInteger(authorityGeneration) || authorityKey == null) return null;
  return Object.freeze({
    requestId,
    authorityGenerationAtStart: authorityGeneration,
    authorityKeyAtStart: authorityKey,
    missionIdAtStart: Number.isInteger(mission?.id) ? mission.id : null,
  });
}

export function missionAuthorityRequestCanApply({
  token,
  latestRequestId,
  currentAuthorityGeneration,
  currentMission,
}) {
  return !!token
    && token.requestId === latestRequestId
    && token.authorityGenerationAtStart === currentAuthorityGeneration
    && token.authorityKeyAtStart === missionAuthorityKey(currentMission);
}

export function missionHttpResponseAuthorityDecision({
  token,
  latestRequestId,
  currentAuthorityGeneration,
  currentMission,
  responseMission,
  terminalMissionIds = new Set(),
}) {
  const requestCurrent = missionAuthorityRequestCanApply({
    token, latestRequestId, currentAuthorityGeneration, currentMission,
  });
  const responseKey = missionAuthorityKey(responseMission);
  const currentKey = missionAuthorityKey(currentMission);
  const responseMissionId = Number.isInteger(responseMission?.id) ? responseMission.id : null;
  const expectedMissionMatches = token?.missionIdAtStart == null
    || token.missionIdAtStart === responseMissionId;
  const terminalSeen = responseMissionId != null && terminalMissionIds.has(responseMissionId);
  const validResponseMission = responseMission != null && responseKey != null
    && expectedMissionMatches && !terminalSeen;
  const responseMatchesCurrent = token?.requestId === latestRequestId
    && validResponseMission && responseKey === currentKey;
  return {
    requestCurrent,
    installResponse: validResponseMission && (requestCurrent || responseMatchesCurrent),
    responseMatchesCurrent,
    terminalSeen,
  };
}

export function missionCreateSettlementDecision({
  requestId,
  latestRequestId,
  authorityMission,
  hasFullSnapshot,
}) {
  const summaryOnlyAuthority = Number.isInteger(authorityMission?.id) && !hasFullSnapshot;
  const current = requestId === latestRequestId;
  return {
    clearLocalRoute: current && summaryOnlyAuthority,
    recoverSnapshot: current && summaryOnlyAuthority,
  };
}

export function splitMissionStatusPayload(payload) {
  const status = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...payload } : {};
  const hasActiveMission = Object.hasOwn(status, "active_mission");
  const activeMission = status.active_mission;
  const hasActiveMissionSummary = Object.hasOwn(status, "active_mission_summary");
  const activeMissionSummary = status.active_mission_summary;
  delete status.active_mission;
  delete status.active_mission_summary;
  return { status, hasActiveMission, activeMission, hasActiveMissionSummary, activeMissionSummary };
}

export function missionSnapshotMatchesSummary(snapshot, summary) {
  return Array.isArray(snapshot?.waypoints)
    && missionSummaryKey(snapshot) !== null
    && missionSummaryKey(snapshot) === missionSummaryKey(summary);
}

export function mergeMissionSummary(snapshot, summary) {
  if (!missionSnapshotMatchesSummary(snapshot, summary)) return null;
  return { ...snapshot, ...summary, waypoints: snapshot.waypoints };
}

export function captureMissionCreateRouteAuthority({ requestId, courseId, routeGeneration }) {
  if (!Number.isInteger(requestId) || requestId <= 0
      || !Number.isInteger(courseId) || !Number.isInteger(routeGeneration)) return null;
  return Object.freeze({ requestId, courseId, routeGeneration });
}

export function missionCreateRouteAuthorityMatches({
  token,
  latestRequestId,
  currentCourseId,
  currentRouteGeneration,
}) {
  return !!token
    && token.requestId === latestRequestId
    && token.courseId === currentCourseId
    && token.routeGeneration === currentRouteGeneration;
}

export function missionCourseId(activeCourseId, mission) {
  return Number.isInteger(mission?.course_id) && mission.course_id !== activeCourseId
    ? mission.course_id
    : activeCourseId;
}

export function shouldAbandonMissionForCourseSwitch({ missionAlignment, roverMode }) {
  return missionAlignment !== true && (roverMode === "executing" || roverMode === "stopped");
}

export function presetResponseIsCurrent({ requestId, latestRequestId, requestedCourseId, activeCourseId }) {
  return requestId === latestRequestId && requestedCourseId === activeCourseId;
}

export function shouldConsumeLegacyMissionIndexEvent({ activeMission, connectedProtocol }) {
  return activeMission?.protocol_version !== 2 && connectedProtocol !== 2;
}
