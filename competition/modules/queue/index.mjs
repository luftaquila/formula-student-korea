import { INSPECTIONS } from "./server/constants.mjs";
import { createQueueSms } from "./server/services/sms.mjs";
import { createQueueEvents } from "./server/services/events.mjs";
import { createQueueValidation } from "./server/services/validation.mjs";
import { createQueueStore } from "./server/store.mjs";
import { createQueueRateLimits } from "./server/services/rate-limit.mjs";
import { createInspectionSettings } from "./server/services/settings.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerEventsRoutes } from "./server/routes/events.mjs";
import { registerSettingsRoutes } from "./server/routes/settings.mjs";
import { registerStatisticsRoutes } from "./server/routes/statistics.mjs";
import { registerBoothsRoutes } from "./server/routes/booths.mjs";
import { registerHistoryRoutes } from "./server/routes/history.mjs";
import { registerPriorityRoutes } from "./server/routes/priority.mjs";
import { registerPenaltiesRoutes } from "./server/routes/penalties.mjs";
import { registerQueueRoutes } from "./server/routes/queue.mjs";
import { registerInspectionsRoutes } from "./server/routes/inspections.mjs";
import { registerPublicRoutes } from "./server/routes/public.mjs";
import express from "express";
import Database from "better-sqlite3";
import {
  createServiceSkeleton,
  addSpaFallback,
} from "../../../shared/server/service-bootstrap.mjs";
import { access } from "../../../shared/common/access-control.js";

export { INSPECTIONS } from "./server/constants.mjs";

export function createQueueApp(options = {}) {
  const inspections = INSPECTIONS;

  const {
    INSPECTION_SETTING_DEFAULTS,
    INSPECTION_SETTING_FIELDS,
    inspectionSettingKey,
    normalizeInspectionSetting,
  } = createInspectionSettings();

  const { rateLimitTimer, rateLimit, kioskRegisterRateLimit } = createQueueRateLimits();

  rateLimitTimer.unref();

  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "queue",
    express,
    Database,
    options,
    authRoleFn: (req) => {
      if (req.path === "/api/health") return null;
      if (req.path.startsWith("/api/internal/")) return access.internal;
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (req.method === "POST" && /^\/api\/admin\/register\/[^/]+$/.test(req.path)) {
        return access.anyOf(
          access.permission("queue.manage"),
          access.device("kiosk.queue.register"),
        );
      }
      // Queue management: registration, priority, reset, visibility and settings.
      if (req.path.startsWith("/api/admin/priority")) return access.permission("queue.manage");
      if (req.path.startsWith("/api/admin/history") && req.method !== "GET")
        return access.permission("queue.manage");
      if (req.path.startsWith("/api/admin/settings") && req.method !== "GET")
        return access.permission("queue.manage");
      if (/^\/api\/admin\/inspection\/[^/]+\/(visibility|ignore)/.test(req.path))
        return access.permission("queue.manage");
      if (req.method === "PATCH" && /^\/api\/admin\/inspection\/[^/]+$/.test(req.path))
        return access.permission("queue.manage");
      if (/^\/api\/admin\/booths\/[^/]+\/config$/.test(req.path))
        return access.permission("queue.manage");
      // Queue operation: read/cancel/walk-in/out and individual booth operation.
      if (req.path.startsWith("/api/admin")) return access.permission("queue.operate");
      // SPA routes
      if (/^\/register(?:\/|$)/.test(req.path))
        return {
          ...access.anyOf(access.permission("queue.manage"), access.device("kiosk.queue.register")),
          unauthenticatedRedirect: "/auth/device",
        };
      if (/^\/(?:priority|settings)(?:\/|$)/.test(req.path))
        return access.permission("queue.manage");
      if (/^\/(admin|stats)/.test(req.path)) return access.permission("queue.operate");
      if (req.path === "/api/events") return null;
      if (req.path === "/api/active") return null;
      if (req.path === "/api/public/queues") return null;
      if (req.path.startsWith("/api/booths/")) return null;
      if (req.path.startsWith("/api/state/")) return null;
      if (req.path.startsWith("/api/")) return access.permission("queue.operate"); // API 기본값: default-close
      return null; // SPA (public display)
    },
  });

  const { tableColumns } = initializeSchema({
    db,
    INSPECTION_SETTING_FIELDS,
    normalizeInspectionSetting,
    INSPECTION_SETTING_DEFAULTS,
    inspectionSettingKey,
    inspections,
    INSPECTIONS,
  });

  const {
    currentYear,
    requestTeamActivity,
    parseYearQuery,
    getActiveInspections,
    getAllInspections,
    getInspectionSettings,
    getCurrentEntry,
    setCurrentInspections,
    addCurrentInspection,
    insertQueueRow,
    deleteQueueRow,
    getQueueRow,
    getQueueStmt,
    getQueueParams,
    getQueueRankRow,
    getBoothsForType,
    getEntries,
  } = createQueueStore({
    options,
    logger,
    db,
    inspections,
    INSPECTION_SETTING_FIELDS,
    normalizeInspectionSetting,
    inspectionSettingKey,
    INSPECTIONS,
  });

  const {
    broadcastEvent,
    sseHandler,
    closeSse,
    broadcastQueue,
    broadcastBooth,
    broadcastInspections,
    broadcastPenalties,
    sourceEvent,
  } = createQueueEvents({ logger, getActiveInspections, getBoothsForType, inspections });

  const { validatePhone, validateInspection, validatePriority } = createQueueValidation({
    inspections,
  });

  const { smsClient, loadSmsConfig, sendSmsNotification } = createQueueSms({
    logger,
    options,
    getInspectionSettings,
    currentYear,
    getQueueStmt,
    getQueueParams,
    inspections,
  });

  registerEventsRoutes({ app, sseHandler, getActiveInspections, db });

  registerPublicRoutes({
    app,
    dbRun,
    getActiveInspections,
    rateLimit,
    getEntries,
    logger,
    currentYear,
    getCurrentEntry,
    getQueueRankRow,
    inspections,
    getQueueStmt,
    getQueueParams,
    db,
    validateInspection,
    getBoothsForType,
  });

  registerInspectionsRoutes({
    app,
    dbRun,
    getAllInspections,
    validateInspection,
    currentYear,
    getQueueStmt,
    getQueueParams,
    db,
    logger,
    broadcastInspections,
    broadcastQueue,
  });

  registerPenaltiesRoutes({
    app,
    currentYear,
    dbRun,
    db,
    validateInspection,
    requestTeamActivity,
    getQueueRow,
    addCurrentInspection,
    insertQueueRow,
    logger,
    broadcastQueue,
    broadcastPenalties,
  });

  registerPriorityRoutes({
    app,
    validateInspection,
    dbRun,
    db,
    currentYear,
    validatePriority,
    requestTeamActivity,
    logger,
    broadcastQueue,
  });

  registerHistoryRoutes({
    app,
    currentYear,
    db,
    validateInspection,
    dbRun,
    logger,
    broadcastQueue,
    broadcastBooth,
  });

  registerBoothsRoutes({
    app,
    validateInspection,
    dbRun,
    getBoothsForType,
    db,
    logger,
    broadcastEvent,
    currentYear,
    requestTeamActivity,
    getInspectionSettings,
    getQueueStmt,
    getQueueParams,
    getQueueRow,
    deleteQueueRow,
    getCurrentEntry,
    setCurrentInspections,
    broadcastBooth,
    broadcastQueue,
    sendSmsNotification,
    options,
    tableColumns,
  });

  registerStatisticsRoutes({
    app,
    parseYearQuery,
    dbRun,
    db,
    validateInspection,
    requestTeamActivity,
  });

  registerSettingsRoutes({
    app,
    validateInspection,
    dbRun,
    getInspectionSettings,
    logger,
    smsClient,
    db,
    inspectionSettingKey,
  });

  registerQueueRoutes({
    app,
    validateInspection,
    currentYear,
    dbRun,
    getQueueRankRow,
    logger,
    smsClient,
    inspections,
    kioskRegisterRateLimit,
    validatePhone,
    getEntries,
    requestTeamActivity,
    db,
    addCurrentInspection,
    insertQueueRow,
    broadcastQueue,
    getInspectionSettings,
    getQueueStmt,
    getQueueParams,
    getQueueRow,
    deleteQueueRow,
    getCurrentEntry,
    setCurrentInspections,
    broadcastPenalties,
    sendSmsNotification,
  });

  /* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
  if (!options.skipSpaFallback) addSpaFallback(app);

  return {
    app,
    db,
    loadSmsConfig,
    smsClient,
    closeSse,
    sourceEvent,
    timers: [rateLimitTimer, smsClient.timer],
  };
}
