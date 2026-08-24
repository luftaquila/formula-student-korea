import express from "express";
import { createApp } from "../../shared/express-setup.mjs";
import { createLogger } from "../../shared/logger.mjs";
import { addSpaFallback } from "../../shared/service-bootstrap.mjs";
import { parseCompetitionYear } from "../../shared/competition-year.mjs";
import { TeamStore } from "../lib/team-store.mjs";

function auditTeam(team) {
  return team && {
    id: team.id,
    year: team.year,
    number: team.number,
    university: team.university,
    name: team.name,
    vehicleTypeId: team.vehicleTypeId,
    active: team.active,
  };
}

function auditVehicleType(type) {
  return type && {
    id: type.id,
    year: type.year,
    name: type.name,
    color: type.color,
    sortOrder: type.sortOrder,
  };
}

function sendError(res, error) {
  const constraint = error?.code?.startsWith?.("SQLITE_CONSTRAINT");
  const status = Number(error?.status) || (constraint ? 409 : 500);
  return res.status(status).json({
    code: error?.code || (status >= 500 ? "TEAM_OPERATION_FAILED" : "INVALID_REQUEST"),
    message: status >= 500 ? "팀 목록 처리 중 오류가 발생했습니다." : error.message,
    ...(error?.year ? { year: error.year } : {}),
  });
}

export function createTeamsModule({
  db, validateUser, validateUserCacheTtl, staticRoot, skipSpaFallback = false, onChange,
}) {
  const store = new TeamStore(db);
  const logger = createLogger(db, "entry");
  const app = createApp({ express, validateUser, validateUserCacheTtl, staticRoot }, (req) => {
    if (req.path === "/health") return null;
    if (req.method === "GET" && req.path === "/teams" && req.query.includeInactive !== "true") return null;
    if (req.method === "GET" && req.path === "/vehicle-types") return null;
    return "admin";
  });
  app.locals.staticRoot = staticRoot;
  const notifyChange = (req, data, target) => {
    try { onChange?.(data); }
    catch (error) {
      logger.warn(req, "team.change_notification", {
        error: error?.message || String(error),
        phase: "post_commit_refresh",
        year: data.year,
      }, target);
    }
  };

  app.get("/health", (req, res) => res.send("ok"));
  app.get("/logs", logger.queryHandler);

  app.get("/teams", (req, res) => {
    try {
      const year = parseCompetitionYear(req.query.year);
      res.json(store.listTeams(year, { includeInactive: req.query.includeInactive === "true" }));
    } catch (error) {
      logger.warn(req, "team.list", {
        requestedYear: req.query.year ?? null,
        includeInactive: req.query.includeInactive === "true",
        error: error.message,
      }, req.query.year == null ? undefined : String(req.query.year));
      sendError(res, error);
    }
  });

  app.get("/teams/export", (req, res) => {
    try {
      const year = parseCompetitionYear(req.query.year);
      res.setHeader("Content-Disposition", `attachment; filename="teams_${year}.json"`);
      res.json(store.exportTeams(year));
    } catch (error) {
      logger.warn(req, "team.export", {
        requestedYear: req.query.year ?? null,
        error: error.message,
      }, req.query.year == null ? undefined : String(req.query.year));
      sendError(res, error);
    }
  });

  app.get("/teams/:id", (req, res) => {
    try {
      const team = store.getById(req.params.id);
      if (!team) {
        logger.warn(req, "team.get", {
          id: req.params.id,
          code: "TEAM_NOT_FOUND",
          error: "존재하지 않는 팀입니다.",
        }, String(req.params.id));
        return res.status(404).json({ code: "TEAM_NOT_FOUND", message: "존재하지 않는 팀입니다." });
      }
      return res.json(team);
    } catch (error) {
      logger.warn(req, "team.get", { id: req.params.id, error: error.message }, String(req.params.id));
      return sendError(res, error);
    }
  });

  app.post("/teams/import", (req, res) => {
    let year;
    try {
      year = parseCompetitionYear(req.query.year);
      const teams = store.importInitial(year, req.body);
      logger.log(req, "team.import_initial", { year, count: teams.length, teams: teams.map(auditTeam) }, String(year));
      notifyChange(req, { year }, String(year));
      res.status(201).json(teams);
    } catch (error) {
      logger.warn(req, "team.import_initial", { year, error: error.message }, String(year));
      sendError(res, error);
    }
  });

  app.post("/teams", (req, res) => {
    let year;
    try {
      year = parseCompetitionYear(req.query.year);
      const team = store.createTeam(year, req.body);
      logger.log(req, "team.create", { team: auditTeam(team) }, String(team.id));
      notifyChange(req, { year: team.year }, String(team.id));
      res.status(201).json(team);
    } catch (error) {
      const requestedNumber = req.body?.number;
      logger.warn(
        req,
        "team.create",
        { year, requested: req.body, error: error.message },
        requestedNumber == null ? undefined : `#${requestedNumber}`,
      );
      sendError(res, error);
    }
  });

  app.patch("/teams/:id", (req, res) => {
    let before = null;
    try {
      before = store.getById(req.params.id);
      const result = store.updateTeam(req.params.id, req.body);
      logger.log(req, "team.update", {
        before: auditTeam(result.before),
        after: auditTeam(result.after),
        updatedProjections: result.projections,
        clearedTransientState: result.clearedTransientState,
      }, String(result.after.id));
      notifyChange(req, { year: result.after.year }, String(result.after.id));
      res.json(result.after);
    } catch (error) {
      logger.warn(req, "team.update", {
        id: req.params.id, before: auditTeam(before), requested: req.body, error: error.message,
      }, String(req.params.id));
      sendError(res, error);
    }
  });

  app.get("/vehicle-types", (req, res) => {
    try { res.json(store.listVehicleTypes(parseCompetitionYear(req.query.year))); }
    catch (error) {
      logger.warn(req, "vehicle_type.list", {
        requestedYear: req.query.year ?? null,
        error: error.message,
      }, req.query.year == null ? undefined : String(req.query.year));
      sendError(res, error);
    }
  });

  app.post("/vehicle-types", (req, res) => {
    let year;
    try {
      year = parseCompetitionYear(req.query.year);
      const type = store.createVehicleType(year, req.body);
      logger.log(req, "vehicle_type.create", { vehicleType: auditVehicleType(type) }, String(type.id));
      notifyChange(req, { year: type.year }, String(type.id));
      res.status(201).json(type);
    } catch (error) {
      logger.warn(req, "vehicle_type.create", { year, requested: req.body, error: error.message });
      sendError(res, error);
    }
  });

  app.patch("/vehicle-types/:id", (req, res) => {
    let before = null;
    try {
      before = store.getVehicleType(req.params.id);
      const result = store.updateVehicleType(req.params.id, req.body);
      logger.log(req, "vehicle_type.update", {
        before: auditVehicleType(result.before), after: auditVehicleType(result.after),
        updatedProjections: result.projections,
      }, String(result.after.id));
      notifyChange(req, { year: result.after.year }, String(result.after.id));
      res.json(result.after);
    } catch (error) {
      logger.warn(req, "vehicle_type.update", {
        id: req.params.id,
        before: auditVehicleType(before),
        requested: req.body,
        error: error.message,
      }, String(req.params.id));
      sendError(res, error);
    }
  });

  app.delete("/vehicle-types/:id", (req, res) => {
    try {
      const type = store.deleteVehicleType(req.params.id);
      logger.log(req, "vehicle_type.delete", { vehicleType: auditVehicleType(type) }, String(type.id));
      notifyChange(req, { year: type.year }, String(type.id));
      res.status(204).send();
    } catch (error) {
      logger.warn(req, "vehicle_type.delete", { id: req.params.id, error: error.message });
      sendError(res, error);
    }
  });

  if (!skipSpaFallback) addSpaFallback(app, staticRoot);
  return { app, store, db };
}
