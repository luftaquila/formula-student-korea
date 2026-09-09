import { parseCompetitionYear } from "../../../../../shared/common/competition-year.mjs";

export function registerTeamsRoutes({ app, store, logger, sendError, auditTeam, notifyChange }) {
  app.get("/teams", (req, res) => {
    try {
      const year = parseCompetitionYear(req.query.year);
      res.json(store.listTeams(year, { includeInactive: req.query.includeInactive === "true" }));
    } catch (error) {
      logger.warn(
        req,
        "team.list",
        {
          requestedYear: req.query.year ?? null,
          includeInactive: req.query.includeInactive === "true",
          error: error.message,
        },
        req.query.year == null ? undefined : String(req.query.year),
      );
      sendError(res, error);
    }
  });

  app.get("/teams/export", (req, res) => {
    try {
      const year = parseCompetitionYear(req.query.year);
      res.setHeader("Content-Disposition", `attachment; filename="teams_${year}.json"`);
      res.json(store.exportTeams(year));
    } catch (error) {
      logger.warn(
        req,
        "team.export",
        {
          requestedYear: req.query.year ?? null,
          error: error.message,
        },
        req.query.year == null ? undefined : String(req.query.year),
      );
      sendError(res, error);
    }
  });

  app.get("/teams/:id", (req, res) => {
    try {
      const team = store.getById(req.params.id);
      if (!team) {
        logger.warn(
          req,
          "team.get",
          {
            id: req.params.id,
            code: "TEAM_NOT_FOUND",
            error: "존재하지 않는 팀입니다.",
          },
          String(req.params.id),
        );
        return res.status(404).json({ code: "TEAM_NOT_FOUND", message: "존재하지 않는 팀입니다." });
      }
      return res.json(team);
    } catch (error) {
      logger.warn(
        req,
        "team.get",
        { id: req.params.id, error: error.message },
        String(req.params.id),
      );
      return sendError(res, error);
    }
  });

  app.post("/teams/import", (req, res) => {
    let year;
    try {
      year = parseCompetitionYear(req.query.year);
      const teams = store.importInitial(year, req.body);
      logger.log(
        req,
        "team.import_initial",
        { year, count: teams.length, teams: teams.map(auditTeam) },
        String(year),
      );
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
      logger.log(
        req,
        "team.update",
        {
          before: auditTeam(result.before),
          after: auditTeam(result.after),
          updatedProjections: result.projections,
          clearedTransientState: result.clearedTransientState,
        },
        String(result.after.id),
      );
      notifyChange(req, { year: result.after.year }, String(result.after.id));
      res.json(result.after);
    } catch (error) {
      logger.warn(
        req,
        "team.update",
        {
          id: req.params.id,
          before: auditTeam(before),
          requested: req.body,
          error: error.message,
        },
        String(req.params.id),
      );
      sendError(res, error);
    }
  });
}
