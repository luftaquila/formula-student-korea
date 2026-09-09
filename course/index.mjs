import { MISSION_TELEMETRY_MAX_ROWS } from "./server/constants.mjs";
import { createCourseEvents } from "./server/services/events.mjs";
import { createCourseValidation } from "./server/services/validation.mjs";
import { createCourseStore } from "./server/store.mjs";
import { createCourseAccess } from "./server/services/access.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerMemosRoutes } from "./server/routes/memos.mjs";
import { registerMarkersRoutes } from "./server/routes/markers.mjs";
import { registerConesRoutes } from "./server/routes/cones.mjs";
import { registerSnapshotsRoutes } from "./server/routes/snapshots.mjs";
import { registerCoursesRoutes } from "./server/routes/courses.mjs";
import { htmlPage } from "../shared/server/social-image.mjs";
import express from "express";
import Database from "better-sqlite3";
import {
  createServiceSkeleton,
  addSpaFallback,
  runIfDirect,
} from "../shared/server/service-bootstrap.mjs";
import { createSSEManager } from "../shared/server/sse.mjs";
import { registerRoverRoutes } from "./lib/rover-routes.mjs";
import { registerPublicCourseRoutes } from "./lib/public-courses.mjs";

export function createCourseApp(options = {}) {
  const { roleFn } = createCourseAccess();

  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "course",
    express,
    Database,
    options,
    authRoleFn: roleFn,
  });

  initializeSchema({ db, MISSION_TELEMETRY_MAX_ROWS, logger });

  /* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
  const {
    broadcast: broadcastEvent,
    handler: sseHandler,
    close: closePrivateSse,
  } = createSSEManager(200, { logger });

  const {
    getCourses,
    getCones,
    getMemos,
    getCourseById,
    getConeById,
    getMemoById,
    getRouteMarkerById,
    getCourseRoute,
    selectSnapshotsForCourse,
    selectSnapshotById,
    takeCourseSnapshot,
  } = createCourseStore({ db });

  const { revalidateSseRole } = createCourseEvents({ app });

  const {
    validateCourseName,
    validateCoordinate,
    validateAltitude,
    validateSide,
    validateMemoDimension,
    validateMemoRotation,
    validateMemoContent,
    validateRouteMarkerLabel,
    rejectRouteRequest,
  } = createCourseValidation({ logger });

  registerPublicCourseRoutes(app, { db, dbRun, logger, getCourseById, getCourses, broadcastEvent });

  app.get(
    "/api/events",
    sseHandler(() => ({ courses: getCourses() }), {
      meta: (req) => ({
        role: req.user?.role,
        permissions: req.user?.permissions || [],
        email: req.user?.email,
      }),
      revalidate: revalidateSseRole,
    }),
  );

  registerCoursesRoutes({
    app,
    dbRun,
    getCourses,
    validateCourseName,
    db,
    logger,
    broadcastEvent,
    getCourseById,
    getConeById,
    getCones,
    getCourseRoute,
    getMemos,
    validateCoordinate,
    validateSide,
    validateAltitude,
    validateMemoDimension,
    validateMemoRotation,
    validateMemoContent,
    validateRouteMarkerLabel,
    rejectRouteRequest,
  });

  registerSnapshotsRoutes({
    app,
    getCourseById,
    selectSnapshotsForCourse,
    getCones,
    dbRun,
    takeCourseSnapshot,
    logger,
    selectSnapshotById,
    db,
    validateCoordinate,
    broadcastEvent,
    getCourses,
  });

  registerConesRoutes({
    app,
    getCourseById,
    dbRun,
    getCones,
    validateCoordinate,
    validateAltitude,
    validateSide,
    db,
    logger,
    broadcastEvent,
    getCourses,
    getConeById,
  });

  registerMarkersRoutes({
    app,
    rejectRouteRequest,
    getCourseById,
    validateCoordinate,
    validateRouteMarkerLabel,
    db,
    dbRun,
    getCourseRoute,
    logger,
    broadcastEvent,
    getRouteMarkerById,
  });

  registerMemosRoutes({
    app,
    getCourseById,
    dbRun,
    getMemos,
    validateCoordinate,
    validateMemoDimension,
    validateMemoRotation,
    validateMemoContent,
    db,
    logger,
    broadcastEvent,
    getMemoById,
  });

  registerRoverRoutes(app, {
    express,
    db,
    dbRun,
    logger,
    broadcastEvent,
    getCourseById,
    getCones,
    takeCourseSnapshot,
    validateCoordinate,
    validateAltitude,
    deviceStaleMs: options.deviceStaleMs,
    deviceWatchdogTickMs: options.deviceWatchdogTickMs,
  });

  /* ============================================
   SPA Fallback
   ============================================ */
  app.use("/api", (req, res) => {
    res.status(404).send("API endpoint not found.");
  });

  // Link preview crawlers need public metadata before the SPA executes.
  app.get("/public", htmlPage("public.html", app.locals.staticRoot));

  addSpaFallback(app);

  return { app, db, close: closePrivateSse };
}

runIfDirect(import.meta, "course", createCourseApp);
