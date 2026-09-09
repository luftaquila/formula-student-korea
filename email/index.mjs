import { BREVO_API_BASE, CONFIG_KEYS, MASKED_KEYS } from "./server/constants.mjs";
import { createEmailService } from "./server/services/send.mjs";
import { createConfigService } from "./server/services/config.mjs";
import { createEmailStore } from "./server/store.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerTestRoutes } from "./server/routes/test.mjs";
import { registerRecipientsRoutes } from "./server/routes/recipients.mjs";
import { registerSendRoutes } from "./server/routes/send.mjs";
import { registerHistoryRoutes } from "./server/routes/history.mjs";
import { registerConfigRoutes } from "./server/routes/config.mjs";
import express from "express";
import Database from "better-sqlite3";
import { createSecretChecker } from "../shared/server/express-setup.mjs";
import {
  createServiceSkeleton,
  addSpaFallback,
  runIfDirect,
} from "../shared/server/service-bootstrap.mjs";
import { access } from "../shared/common/access-control.js";

/* ============================================
   App
   ============================================ */
export function createEmailApp(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;

  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "email",
    express,
    Database,
    options,
    authRoleFn: (req) => {
      if (req.path === "/api/health") return null;
      if (req.path.startsWith("/api/internal/")) return access.internal;
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (req.path.startsWith("/api/config")) return access.admin;
      if (req.path.startsWith("/api/")) return access.admin;
      return access.admin;
    },
  });

  initializeSchema({ db, CONFIG_KEYS });

  const isInternalSecret = createSecretChecker(process.env.INTERNAL_SECRET);

  const { getConfig, getAllConfig } = createEmailStore({ db });

  const { maskValue, CONFIG_GROUPS } = createConfigService({ MASKED_KEYS });

  const { sendEmail } = createEmailService({
    fetchFn,
    BREVO_API_BASE,
    logger,
    getConfig,
    dbRun,
    db,
    isInternalSecret,
  });

  registerConfigRoutes({
    app,
    dbRun,
    getAllConfig,
    logger,
    maskValue,
    db,
    CONFIG_KEYS,
    MASKED_KEYS,
    getConfig,
    CONFIG_GROUPS,
  });

  registerHistoryRoutes({ app, dbRun, db, logger, getConfig, fetchFn, BREVO_API_BASE });

  registerSendRoutes({ app, logger, sendEmail });

  registerRecipientsRoutes({ app, fetchFn, logger });

  registerTestRoutes({ app, logger, getConfig, fetchFn, BREVO_API_BASE });

  addSpaFallback(app);

  return { app, db };
}

runIfDirect(import.meta, "email", createEmailApp);
