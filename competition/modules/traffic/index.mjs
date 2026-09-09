import {
  CONTROLLER_MAX_ROWS,
  RETAIN_EVENTS,
  WIRELESS_STATUS_MAX_AGE_MS,
  WIRELESS_SYNC_MAX_AGE_MS,
  WIRELESS_MAX_SKEW_PPM,
  WIRELESS_REQUIRED_ROLES,
} from "./server/constants.mjs";
import { createRetentionService } from "./server/services/retention.mjs";
import { createLiveAttemptService } from "./server/services/live-attempts.mjs";
import { createTimingService } from "./server/services/timing.mjs";
import { createBridgeService } from "./server/services/bridge.mjs";
import { createTrafficValidation } from "./server/services/validation.mjs";
import { createTrafficStore } from "./server/store.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerEventsRoutes } from "./server/routes/events.mjs";
import { registerLiveAttemptsRoutes } from "./server/routes/live-attempts.mjs";
import { registerWirelessStateRoutes } from "./server/routes/wireless-state.mjs";
import { registerWirelessControlRoutes } from "./server/routes/wireless-control.mjs";
import { registerWirelessIngestRoutes } from "./server/routes/wireless-ingest.mjs";
import { registerEventModesRoutes } from "./server/routes/event-modes.mjs";
import { registerRecordsRoutes } from "./server/routes/records.mjs";
import express from "express";
import Database from "better-sqlite3";
import {
  createServiceSkeleton,
  addSpaFallback,
} from "../../../shared/server/service-bootstrap.mjs";
import { createSSEManager } from "../../../shared/server/sse.mjs";
import { ensureInactiveTeamView } from "../../lib/team-status.mjs";
import { WIRELESS_PROTOCOL_VERSION } from "./lib/wireless-capture-integrity.mjs";
import { createWirelessClock } from "./lib/wireless-clock.mjs";
import { access } from "../../../shared/common/access-control.js";

export function createTrafficApp(options = {}) {
  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "traffic",
    express,
    Database,
    options,
    authRoleFn: (req) => {
      if (req.path === "/api/health" || req.path === "/api/time") return null;
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (req.method === "PUT" && /^\/api\/records\/[^/]+\/visibility$/.test(req.path))
        return access.permission("traffic.manage");
      if (req.method === "DELETE" && /^\/api\/records\/[^/]+$/.test(req.path))
        return access.permission("traffic.manage");
      if (req.method === "PUT" && req.path.startsWith("/api/event-modes/"))
        return access.permission("traffic.manage");
      if (["PUT", "DELETE"].includes(req.method) && req.path.startsWith("/api/wireless/mapping/"))
        return access.permission("traffic.manage");
      if (req.method === "PUT" && req.path === "/api/wireless/debounce")
        return access.permission("traffic.manage");
      return access.permission("traffic.operate");
    },
  });

  ensureInactiveTeamView(db);

  const { reservedSql, pruneWirelessEvents } = initializeSchema({
    db,
    CONTROLLER_MAX_ROWS,
    RETAIN_EVENTS,
  });

  /* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
  const {
    broadcast: broadcastSSEEvent,
    handler: sseHandler,
    close: closeSseStream,
  } = createSSEManager(200, { logger });

  const wirelessClock = createWirelessClock({
    send: (command) => broadcastEvent("wireless:command", command),
  });

  const pendingArmRequests = new Map();

  const readWirelessClock = options.readWirelessClock || (() => wirelessClock.read());

  function closeSse() {
    wirelessClock.close();
    closeSseStream();
  }

  const {
    getRecordFiles,
    getRecordRows,
    getYearRecordGroups,
    getRecordRow,
    recordFileExists,
    insertRecordRow,
    getEventModes,
    getRecordVisibility,
    getLightState,
    getMapping,
    LEASE_TTL_MS,
    getSessions,
    getSession,
    getDebounceMs,
    getLastEventId,
    tableExists,
  } = createTrafficStore({
    db,
    recordYearFromName: (...args) => recordYearFromName(...args),
    currentRecordYear: (...args) => currentRecordYear(...args),
    resolveCanonicalTeam: (...args) => resolveCanonicalTeam(...args),
    getRun: (...args) => getRun(...args),
  });

  const {
    wirelessActor,
    controllerEmail,
    rejectMutation,
    runRecordPreflight,
    runMutationPreflight,
    currentRecordYear,
    resolveCanonicalTeam,
    validateNodeId,
    tickToText,
    validBootId,
    ALLOWED_ROLE,
    validateRecordName,
    recordYearFromName,
    isRecordBoundToActiveTeam,
    validateRecordData,
    validateSelectionRequest,
  } = createTrafficValidation({ logger, dbRun, options, db });

  // An older in-flight run has no v9 source frontier. Preserve official records,
  // but do not join new captures onto unverifiable pre-upgrade state.
  const interruptedRuns = db
    .prepare(
      "SELECT event_type, run_id FROM wireless_session WHERE armed = 1 AND (engine_state IS NULL OR json_extract(engine_state, '$.version') IS NOT ?)",
    )
    .all(WIRELESS_PROTOCOL_VERSION);

  if (interruptedRuns.length) {
    db.prepare(
      "UPDATE wireless_session SET armed = 0, engine_state = NULL WHERE armed = 1 AND (engine_state IS NULL OR json_extract(engine_state, '$.version') IS NOT ?)",
    ).run(WIRELESS_PROTOCOL_VERSION);
    logger.warn(
      null,
      "wireless.run.recovery",
      { error: "기존 계측에 캡처 검증 정보가 없어 중단했습니다.", runs: interruptedRuns },
      "wireless",
    );
  }

  // 백그라운드(기록 엔진·워치독) 로그의 actorOverride. 사용자 요청 경로에서는 쓰지 않는다.
  const SYS_ACTOR = { email: "system", name: "system", role: "admin" };

  const {
    liveTelemetry,
    readBridgeOnline,
    readLastBridgeSeenIso,
    getLiveTelemetry,
    getBridgeState,
    getLiveQualityFaults,
    publishWirelessQualityFault,
    clearWirelessQualityFault,
    telemetryAgeMs,
    rejectWirelessQuality,
    enforceArmedWirelessQuality,
    stageBridgeSeen,
    markBridgeOffline,
    commitBridgeSeen,
    runBridgeWatch,
    bridgeWatch,
  } = createBridgeService({
    getSessions,
    getRun: (...args) => getRun(...args),
    broadcastEvent: (...args) => broadcastEvent(...args),
    readTimingContext: () => readTimingContext(),
    WIRELESS_STATUS_MAX_AGE_MS,
    getMapping,
    WIRELESS_REQUIRED_ROLES,
    WIRELESS_SYNC_MAX_AGE_MS,
    WIRELESS_MAX_SKEW_PPM,
    rejectMutation,
    getSession,
    db,
    logger,
    SYS_ACTOR,
    timingTransaction: (...args) => timingTransaction(...args),
  });

  const {
    readTimingContext,
    broadcastEvent,
    getRun,
    setRun,
    timingTransaction,
    resetEngineRun,
    engineSaveRecord,
    invalidateRun,
    processRecordEngine,
  } = createTimingService({
    broadcastSSEEvent,
    options,
    db,
    dbRun,
    liveTelemetry,
    commitBridgeSeen,
    getLastEventId,
    getMapping,
    telemetryAgeMs,
    WIRELESS_STATUS_MAX_AGE_MS,
    validateRecordName,
    validateRecordData,
    insertRecordRow,
    logger,
    SYS_ACTOR,
    getRecordFiles,
    getRecordRow,
    publishWirelessQualityFault,
    getSessions,
    getDebounceMs,
    clearWirelessQualityFault,
    getSession,
  });

  const {
    liveAttempts,
    liveAttemptPayload,
    getLiveAttempts,
    runLiveAttemptWatch,
    liveAttemptWatch,
  } = createLiveAttemptService({ logger, SYS_ACTOR, broadcastEvent });

  bridgeWatch.unref?.();

  const { runLeaseWatch, leaseWatch, runEventRetention, eventRetention, telemetryRetention } =
    createRetentionService({
      db,
      logger,
      SYS_ACTOR,
      broadcastEvent,
      getSession,
      pruneWirelessEvents,
      RETAIN_EVENTS,
      liveTelemetry,
    });

  leaseWatch.unref?.();

  eventRetention.unref?.();

  telemetryRetention.unref?.();

  liveAttemptWatch.unref?.();

  registerEventsRoutes({
    app,
    sseHandler,
    getRecordFiles,
    getEventModes,
    getRecordVisibility,
    getLiveAttempts,
    getLightState,
    getMapping,
    getLiveTelemetry,
    getBridgeState,
    getSessions,
    getLiveQualityFaults,
    getLastEventId,
  });

  registerLiveAttemptsRoutes({
    app,
    rejectMutation,
    validateSelectionRequest,
    liveAttemptPayload,
    logger,
    liveAttempts,
    broadcastEvent,
  });

  registerRecordsRoutes({
    app,
    dbRun,
    getRecordFiles,
    getRecordVisibility,
    getYearRecordGroups,
    validateRecordName,
    logger,
    runRecordPreflight,
    tableExists,
    db,
    broadcastEvent,
    getRecordRows,
    rejectMutation,
    validateRecordData,
    insertRecordRow,
    recordYearFromName,
    currentRecordYear,
    isRecordBoundToActiveTeam,
    timingTransaction,
    getRun,
    getRecordRow,
    recordFileExists,
    getSession,
    reservedSql,
  });

  registerEventModesRoutes({
    app,
    dbRun,
    getEventModes,
    runMutationPreflight,
    db,
    logger,
    broadcastEvent,
  });

  registerWirelessControlRoutes({
    app,
    tickToText,
    validBootId,
    rejectMutation,
    wirelessClock,
    logger,
    readBridgeOnline,
    dbRun,
    db,
    markBridgeOffline,
    broadcastEvent,
    getBridgeState,
    readLastBridgeSeenIso,
    timingTransaction,
    enforceArmedWirelessQuality,
    getLightState,
    runMutationPreflight,
    getSession,
    wirelessActor,
    controllerEmail,
    validateSelectionRequest,
    rejectWirelessQuality,
    getLastEventId,
    pendingArmRequests,
    readWirelessClock,
    getRun,
    resetEngineRun,
    clearWirelessQualityFault,
    processRecordEngine,
    setRun,
    LEASE_TTL_MS,
    getMapping,
    validateNodeId,
    ALLOWED_ROLE,
  });

  registerWirelessIngestRoutes({
    app,
    rejectMutation,
    timingTransaction,
    stageBridgeSeen,
    db,
    validateNodeId,
    tickToText,
    validBootId,
    liveTelemetry,
    readTimingContext,
    broadcastEvent,
    enforceArmedWirelessQuality,
    processRecordEngine,
    getSessions,
    getRun,
    invalidateRun,
    getSession,
    logger,
    readLastBridgeSeenIso,
  });

  registerWirelessStateRoutes({
    app,
    rejectMutation,
    runMutationPreflight,
    getSession,
    wirelessActor,
    controllerEmail,
    timingTransaction,
    getRun,
    db,
    resetEngineRun,
    getRecordRow,
    recordYearFromName,
    currentRecordYear,
    broadcastEvent,
    getRecordFiles,
    engineSaveRecord,
    logger,
    dbRun,
    getLightState,
    getMapping,
    getLiveTelemetry,
    getBridgeState,
    getSessions,
    getLiveQualityFaults,
    getLastEventId,
  });

  /* ============================================
   SPA Fallback
   ============================================ */
  if (!options.skipSpaFallback) addSpaFallback(app);

  return {
    app,
    db,
    closeSse,
    sourceEvent: broadcastSSEEvent,
    timers: [bridgeWatch, leaseWatch, eventRetention, telemetryRetention, liveAttemptWatch],
    queries: { yearRecordGroups: getYearRecordGroups, eventModes: getEventModes },
    runBridgeWatch,
    runLeaseWatch,
    runEventRetention,
    runLiveAttemptWatch,
  };
}
