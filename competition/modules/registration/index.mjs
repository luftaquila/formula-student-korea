import { parsePositiveInteger, normalizePhone, auditTeam, sendError } from "./server/input.mjs";
import { ACTIVE_STATUS, QUEUE_TABLE_SQL, DEFAULT_SETTINGS } from "./server/constants.mjs";
import { createSmsClient } from "../../../shared/server/sms-client.mjs";
import { createRegistrationTransitions } from "./server/services/transitions.mjs";
import { createRegistrationSms } from "./server/services/sms.mjs";
import { createRegistrationEvents } from "./server/services/events.mjs";
import { createRegistrationStore } from "./server/store.mjs";
import { createRegistrationRateLimits } from "./server/services/rate-limit.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerEventsRoutes } from "./server/routes/events.mjs";
import { registerSettingsRoutes } from "./server/routes/settings.mjs";
import { registerQueueRoutes } from "./server/routes/queue.mjs";
import { registerPublicRoutes } from "./server/routes/public.mjs";
import express from "express";
import Database from "better-sqlite3";
import {
  createServiceSkeleton,
  addSpaFallback,
} from "../../../shared/server/service-bootstrap.mjs";
import { access } from "../../../shared/common/access-control.js";

export function createRegistrationApp(options = {}) {
  if (!options.teamStore) throw new Error("Competition team store is required");

  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "registration",
    express,
    Database,
    options,
    authRoleFn: (req) => {
      if (["/api/health", "/api/status", "/api/lookup", "/api/events"].includes(req.path))
        return null;
      if (/^\/api\/lookup\/[^/]+$/.test(req.path)) return null;
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (req.path === "/api/queue" && req.method === "POST") {
        return access.anyOf(
          access.permission("registration.manage"),
          access.device("kiosk.registration.register"),
        );
      }
      if (req.path === "/api/settings" && req.method !== "GET")
        return access.permission("registration.manage");
      if (req.path.startsWith("/api/")) return access.permission("registration.operate");
      if (/^\/register(?:\/|$)/.test(req.path))
        return {
          ...access.anyOf(
            access.permission("registration.manage"),
            access.device("kiosk.registration.register"),
          ),
          unauthenticatedRedirect: "/auth/device",
        };
      if (/^\/manage(?:\/|$)/.test(req.path)) return access.permission("registration.operate");
      return null;
    },
  });

  initializeSchema({ db, QUEUE_TABLE_SQL });

  const { rateLimitTimer, lookupRateLimit, kioskRegisterRateLimit } = createRegistrationRateLimits({
    logger,
  });

  rateLimitTimer.unref();

  // Competition 은 Queue 가 만든 클라이언트를 주입한다 — 자격 증명 사본과 Email
  // 서비스 폴링이 모듈 수만큼 늘어나지 않게 한다. 독립 실행·테스트에서만 직접 만든다.
  const ownsSmsClient = !options.smsClient;

  const smsClient =
    options.smsClient ||
    createSmsClient({
      logger,
      smsRequest: options.smsRequest,
      smsConfig: options.smsConfig,
      fetchImpl: options.fetchImpl,
    });

  const { settingsForYear, registrationRow, publicStatus, advanceTarget } = createRegistrationStore(
    { db, DEFAULT_SETTINGS, smsClient },
  );

  const { pendingTasks, notifyUpcoming } = createRegistrationSms({
    smsClient,
    logger,
    dbRun,
    db,
    auditTeam,
    settingsForYear,
    advanceTarget,
  });

  const { sseHandler, closeSse, broadcastChange, parseEventYear, sourceEvent } =
    createRegistrationEvents({ logger, publicStatus });

  const { transition } = createRegistrationTransitions({
    parsePositiveInteger,
    registrationRow,
    logger,
    advanceTarget,
    settingsForYear,
    dbRun,
    db,
    auditTeam,
    notifyUpcoming,
    broadcastChange,
    sendError,
  });

  registerEventsRoutes({ app, parseEventYear, sseHandler, publicStatus });

  registerPublicRoutes({
    app,
    publicStatus,
    logger,
    sendError,
    lookupRateLimit,
    parsePositiveInteger,
    db,
  });

  registerQueueRoutes({
    app,
    db,
    settingsForYear,
    logger,
    sendError,
    kioskRegisterRateLimit,
    parsePositiveInteger,
    normalizePhone,
    options,
    auditTeam,
    broadcastChange,
    transition,
    ACTIVE_STATUS,
  });

  registerSettingsRoutes({
    app,
    settingsForYear,
    logger,
    sendError,
    smsClient,
    dbRun,
    db,
    broadcastChange,
  });

  if (!options.skipSpaFallback) addSpaFallback(app);

  return {
    app,
    db,
    // 클라이언트를 공유받았으면 그 소유자가 설정을 읽는다.
    loadSmsConfig: (ownsSmsClient && smsClient.loadConfig) || (async () => smsClient.isAvailable()),
    closeSse,
    sourceEvent,
    drain: () => Promise.allSettled([...pendingTasks]),
    hasPendingTasks: () => pendingTasks.size > 0,
    timers: [rateLimitTimer, ...(ownsSmsClient && smsClient.timer ? [smsClient.timer] : [])],
  };
}
