import { auditTeam, auditVehicleType, sendError } from "./server/input.mjs";
import { registerVehicleTypesRoutes } from "./server/routes/vehicle-types.mjs";
import { registerTeamsRoutes } from "./server/routes/teams.mjs";
import express from "express";
import { createApp } from "../../../shared/server/express-setup.mjs";
import { createLogger } from "../../../shared/server/logger.mjs";
import { addSpaFallback } from "../../../shared/server/service-bootstrap.mjs";
import { TeamStore } from "../../lib/team-store.mjs";
import { access } from "../../../shared/common/access-control.js";

export function createTeamsModule({
  db,
  validateUser,
  validateUserCacheTtl,
  staticRoot,
  skipSpaFallback = false,
  onChange,
}) {
  const store = new TeamStore(db);

  const logger = createLogger(db, "entry", 50000, { teamSource: store });

  const app = createApp(
    { express, logger, validateUser, validateUserCacheTtl, staticRoot },
    (req) => {
      if (req.path === "/health") return null;
      if (req.method === "GET" && req.path === "/teams" && req.query.includeInactive !== "true")
        return null;
      if (req.method === "GET" && req.path === "/vehicle-types") return null;
      if (req.path === "/logs") return access.anyOf(access.admin, access.internal);
      return access.admin;
    },
  );

  app.locals.staticRoot = staticRoot;

  const notifyChange = (req, data, target) => {
    try {
      onChange?.(data);
    } catch (error) {
      logger.warn(
        req,
        "team.change_notification",
        {
          error: error?.message || String(error),
          phase: "post_commit_refresh",
          year: data.year,
        },
        target,
      );
    }
  };

  app.get("/health", (req, res) => res.send("ok"));

  app.get("/logs", logger.queryHandler);

  registerTeamsRoutes({ app, store, logger, sendError, auditTeam, notifyChange });

  registerVehicleTypesRoutes({ app, store, logger, sendError, auditVehicleType, notifyChange });

  if (!skipSpaFallback) addSpaFallback(app, staticRoot);

  return { app, store, db };
}
