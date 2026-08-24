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
  if (!mission || !Number.isInteger(mission.id) || typeof mission.plan_hash !== "string") return null;
  return Object.freeze({ missionId: mission.id, planHash: mission.plan_hash });
}

export function buildMissionCommandPayload({ token, missionId, force = false }) {
  if (!token || token.missionId !== missionId || typeof token.planHash !== "string") {
    throw Object.assign(new Error("점검한 미션과 현재 미션이 다릅니다. 최신 미션을 다시 점검하세요."), {
      reason: "mission_preflight_mismatch",
    });
  }
  return { force: force === true, expected_plan_hash: token.planHash };
}

export function missionCommandTokenAfterSync({ routeAlreadySynced, preflightToken, editedMission }) {
  return routeAlreadySynced === true ? preflightToken : missionCommandToken(editedMission);
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
      : { cone_id: waypoint.cone_id }),
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
    items: items.map((item) => ({ cone_id: item.cone_id })),
    ...(existing ? { expected_preset_revision: existing.preset_revision } : {}),
  };
}

export function missionRestoreDecision({ mission, displayedMissionId, localWaypointCount = 0 }) {
  if (!mission || !Array.isArray(mission.waypoints)) return { restore: false, discardsLocalDraft: false };
  return {
    restore: true,
    discardsLocalDraft: localWaypointCount > 0
      && displayedMissionId !== mission.id,
  };
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
