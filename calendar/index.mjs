import { canonicalAudience } from "./server/input.mjs";
import { ALLOWED_EVENT_ROLES, LEGACY_EVENT_ROLES } from "./server/constants.mjs";
import { createSubscriptionService } from "./server/services/subscription.mjs";
import { createEventService } from "./server/services/events.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerSubscriptionRoutes } from "./server/routes/subscription.mjs";
import { registerEventsRoutes } from "./server/routes/events.mjs";
import express from "express";
import Database from "better-sqlite3";
import {
  createServiceSkeleton,
  addSpaFallback,
  runIfDirect,
} from "../shared/server/service-bootstrap.mjs";
import { access } from "../shared/common/access-control.js";

/* ============================================
   App
   ============================================ */
export function createCalendarApp(options = {}) {
  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "calendar",
    express,
    Database,
    options,
    authRoleFn: (req) => {
      if (req.path === "/api/health") return null;
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (req.method === "GET" && req.path === "/api/events") return null;
      if (req.path === "/api/events/ical") return null;
      if (req.path === "/api/events/subscribe") return access.authenticated;
      if (req.path.startsWith("/api/")) return access.permission("calendar.manage");
      return null;
    },
  });

  const {
    toEventResponse,
    normalizeDateTime,
    normalizeRangeBound,
    kstDateFromUtcIso,
    canSeeAudience,
    validateEventInput,
  } = createEventService({ canonicalAudience, logger, ALLOWED_EVENT_ROLES });

  initializeSchema({ db, normalizeDateTime });

  const { generateICalSig, generateICal } = createSubscriptionService();

  registerEventsRoutes({
    app,
    logger,
    normalizeRangeBound,
    kstDateFromUtcIso,
    dbRun,
    db,
    canSeeAudience,
    toEventResponse,
    validateEventInput,
  });

  registerSubscriptionRoutes({
    app,
    generateICalSig,
    LEGACY_EVENT_ROLES,
    logger,
    canonicalAudience,
    dbRun,
    db,
    generateICal,
  });

  addSpaFallback(app);

  return { app, db };
}

runIfDirect(import.meta, "calendar", createCalendarApp);
