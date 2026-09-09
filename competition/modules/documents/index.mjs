import { createDocumentNotifications } from "./server/services/notifications.mjs";
import { createDocumentPreflight } from "./server/services/preflight.mjs";
import { createDownloadService } from "./server/services/downloads.mjs";
import { createUploadStorage } from "./server/services/uploads.mjs";
import { createDocumentDates } from "./server/services/dates.mjs";
import { initializeSchema, normalizeDocumentTimestamps } from "./server/schema.mjs";
import { registerYearsRoutes } from "./server/routes/years.mjs";
import { registerStudentsRoutes } from "./server/routes/students.mjs";
import { registerAdminDownloadsRoutes } from "./server/routes/admin-downloads.mjs";
import { registerAdminSessionsRoutes } from "./server/routes/admin-sessions.mjs";
import { registerDownloadsRoutes } from "./server/routes/downloads.mjs";
import { registerSubmissionsRoutes } from "./server/routes/submissions.mjs";
import { registerSessionsRoutes } from "./server/routes/sessions.mjs";
import { registerEntriesRoutes } from "./server/routes/entries.mjs";
import express from "express";
import Database from "better-sqlite3";
import archiver from "archiver";
import {
  createServiceSkeleton,
  addSpaFallback,
} from "../../../shared/server/service-bootstrap.mjs";
import { access } from "../../../shared/common/access-control.js";

export function createDocumentsApp(options = {}) {
  const createArchive = options.archiveFactory || archiver;

  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "documents",
    express,
    Database,
    options,
    authRoleFn: (req) => {
      if (req.path === "/api/health") return null;
      if (req.path.startsWith("/api/internal/")) return access.internal;
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (req.path.startsWith("/api/admin")) {
        return req.method === "GET"
          ? access.permission("documents.operate")
          : access.permission("documents.manage");
      }
      if (req.path.startsWith("/api/")) return access.student;
      if (req.path.startsWith("/admin")) return access.permission("documents.operate");
      return access.student;
    },
  });

  const {
    UPLOADS_DIR,
    readTMP_DIR,
    safeExt,
    sanitize,
    rmDir,
    logCleanupFailures,
    submissionUploadDir,
    submissionFilePath,
    cleanupManagedUploads,
  } = createUploadStorage({ options, logger, db });

  initializeSchema({ db });

  cleanupManagedUploads();

  const { now, normalizeTimestamp, toKST, subtractHours } = createDocumentDates();

  normalizeDocumentTimestamps({ db, normalizeTimestamp });
  const {
    scheduleSessionNotifications,
    fetchEntries,
    processScheduledNotifications,
    _schedulerInterval,
    _schedulerStartupTimer,
    launchOpenSessionNotification,
    drainNotificationTasks,
    hasPendingNotificationTasks,
  } = createDocumentNotifications({ options, db, now, subtractHours, logger, toKST });

  const { auditedLookup } = createDocumentPreflight({ dbRun, logger });

  const {
    inlineDisposition,
    createTextCharsetDetector,
    setFileResponseHeaders,
    isInitialDownload,
  } = createDownloadService({ db, logger });

  _schedulerInterval?.unref?.();

  _schedulerStartupTimer?.unref?.();

  registerEntriesRoutes({ app, db, fetchEntries });

  registerSessionsRoutes({ app, db, logger });

  registerSubmissionsRoutes({
    app,
    auditedLookup,
    db,
    logger,
    options,
    now,
    readTMP_DIR,
    rmDir,
    safeExt,
    inlineDisposition,
    createTextCharsetDetector,
    dbRun,
    submissionUploadDir,
  });

  registerDownloadsRoutes({
    app,
    db,
    logger,
    submissionFilePath,
    isInitialDownload,
    setFileResponseHeaders,
    sanitize,
    createArchive,
  });

  registerAdminSessionsRoutes({
    app,
    db,
    normalizeTimestamp,
    dbRun,
    logger,
    scheduleSessionNotifications,
    auditedLookup,
    submissionUploadDir,
    rmDir,
    logCleanupFailures,
    UPLOADS_DIR,
  });

  registerAdminDownloadsRoutes({
    app,
    db,
    fetchEntries,
    sanitize,
    submissionFilePath,
    createArchive,
    logger,
    isInitialDownload,
    setFileResponseHeaders,
  });

  registerStudentsRoutes({ app, logger, db, dbRun, launchOpenSessionNotification });

  registerYearsRoutes({
    app,
    dbRun,
    db,
    logger,
    UPLOADS_DIR,
    rmDir,
    logCleanupFailures,
    fetchEntries,
    submissionFilePath,
    sanitize,
    createArchive,
  });

  if (!options.skipSpaFallback) addSpaFallback(app);

  return {
    app,
    db,
    processScheduledNotifications,
    drainNotificationTasks,
    drain: drainNotificationTasks,
    hasPendingNotificationTasks,
    _schedulerInterval,
    _schedulerStartupTimer,
    timers: [_schedulerInterval, _schedulerStartupTimer].filter(Boolean),
  };
}
