import { createCourseEvents } from "./server/services/events.mjs";
import { createCourseAccess } from "./server/services/access.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { createServiceResponder } from "./server/respond.mjs";
import { createCoursePublication, registerPublicationRoutes } from "./server/publication.mjs";
import { registerCourseDataRoutes } from "./server/routes/course-data.mjs";
import { createCourseService } from "fsk-coursekeeper/service";
import { loadCourseDevices, registerDeviceRoutes } from "./server/devices.mjs";
import { htmlPage } from "../shared/server/social-image.mjs";
import express from "express";
import Database from "better-sqlite3";
import {
  createServiceSkeleton,
  addSpaFallback,
  runIfDirect,
} from "../shared/server/service-bootstrap.mjs";
import { createSSEManager } from "../shared/server/sse.mjs";

export function createCourseApp(options = {}) {
  const { roleFn } = createCourseAccess();

  const { app, db, logger } = createServiceSkeleton({
    name: "course",
    express,
    Database,
    options,
    authRoleFn: roleFn,
  });

  initializeSchema({ db, logger });

  /* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
  const {
    broadcast: broadcastEvent,
    handler: sseHandler,
    close: closePrivateSse,
  } = createSSEManager(200, { logger });

  const service = createCourseService(db);
  const publication = createCoursePublication(db);
  const respond = createServiceResponder({ logger, broadcast: broadcastEvent, decorate: publication.decorateEvent });

  const { revalidateSseRole } = createCourseEvents({ app });

  registerPublicationRoutes(app, { db, logger, service, publication, broadcast: broadcastEvent });

  app.get(
    "/api/events",
    sseHandler(() => ({ courses: publication.decorateCourses(service.reads.listCourses()) }), {
      meta: (req) => ({
        role: req.user?.role,
        permissions: req.user?.permissions || [],
        email: req.user?.email,
      }),
      revalidate: revalidateSseRole,
    }),
  );

  registerCourseDataRoutes({ app, service, respond, publication });

  registerDeviceRoutes(app, { devices: loadCourseDevices(process.env.COURSE_DEVICES, logger) });

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
