import { parseCompetitionYear } from "../../../../../shared/common/competition-year.mjs";

export function registerPublicRoutes({
  app,
  publicStatus,
  logger,
  sendError,
  lookupRateLimit,
  parsePositiveInteger,
  db,
}) {
  app.get("/api/status", (req, res) => {
    try {
      res.json(publicStatus(parseCompetitionYear(req.query.year)));
    } catch (error) {
      logger.warn(req, "registration.status", {
        requestedYear: req.query.year,
        error: error.message,
      });
      sendError(res, error, "REGISTRATION_STATUS_FAILED");
    }
  });

  app.get("/api/lookup/:num", lookupRateLimit, (req, res) => {
    let year;
    let number;
    try {
      year = parseCompetitionYear(req.query.year);
      number = parsePositiveInteger(req.params.num, "엔트리 번호");

      const row = db
        .prepare(
          `
        SELECT q.id, q.team_id,
               t.num, t.univ, t.name
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND t.num = ? AND q.status = 'waiting'
      `,
        )
        .get(year, number);
      if (!row) {
        logger.warn(
          req,
          "registration.lookup",
          {
            reason: "not_found",
            year,
            number,
          },
          `${year}#${number}`,
        );
        return res
          .status(404)
          .json({ code: "REGISTRATION_NOT_FOUND", message: "대기 중인 등록 내역이 없습니다." });
      }

      const waitingTotal = db
        .prepare(
          `
        SELECT COUNT(*) AS count
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting'
      `,
        )
        .get(year).count;
      const position = db
        .prepare(
          `
        SELECT COUNT(*) AS count
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting' AND q.id <= ?
      `,
        )
        .get(year, row.id).count;

      return res.json({
        year,
        teamId: row.team_id,
        number: row.num,
        university: row.univ,
        name: row.name,
        status: "waiting",
        position,
        waitingTotal,
      });
    } catch (error) {
      logger.warn(
        req,
        "registration.lookup",
        {
          reason: "invalid_request",
          year,
          number,
          error: error.message,
        },
        year && number ? `${year}#${number}` : "public",
      );
      return sendError(res, error, "REGISTRATION_LOOKUP_FAILED");
    }
  });

  app.get("/", (_req, res) => res.redirect("/queue/"));
}
