import {
  parseCompetitionYear,
  assertCurrentCompetitionYear,
} from "../../../../../shared/common/competition-year.mjs";

export function registerQueueRoutes({
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
}) {
  app.get("/api/queue", (req, res) => {
    let year;
    try {
      year = parseCompetitionYear(req.query.year);
      const waiting = db
        .prepare(
          `
        SELECT q.id, q.team_id AS teamId, t.num AS number, t.univ AS university, t.name,
               q.phone, q.registered_at AS registeredAt, q.notified
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting'
        ORDER BY q.id
      `,
        )
        .all(year)
        .map((row, index) => ({ ...row, position: index + 1 }));
      const today = db
        .prepare(
          `
        SELECT
          COALESCE(SUM(q.status = 'done'), 0) AS done,
          COALESCE(SUM(q.status = 'canceled'), 0) AS canceled
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ?
          AND q.finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','+9 hours','start of day','-9 hours')
          AND q.finished_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','+9 hours','start of day','-9 hours','+1 day')
      `,
        )
        .get(year);
      return res.json({
        year,
        waiting,
        today: { done: today.done, canceled: today.canceled },
        settings: settingsForYear(year),
      });
    } catch (error) {
      logger.warn(
        req,
        "registration.queue_view",
        { year, error: error.message },
        year && String(year),
      );
      return sendError(res, error, "REGISTRATION_QUEUE_VIEW_FAILED");
    }
  });

  app.post("/api/queue", kioskRegisterRateLimit, (req, res) => {
    let team;
    let phone;
    try {
      const teamId = parsePositiveInteger(req.body?.teamId, "팀 ID");
      phone = normalizePhone(req.body?.phone);
      if (!phone)
        throw Object.assign(new Error("올바르지 않은 전화번호입니다."), {
          status: 400,
          code: "INVALID_PHONE",
        });
      team = options.teamStore.getById(teamId);
      if (!team || !team.active) {
        logger.warn(
          req,
          "registration.register",
          {
            reason: "inactive_or_missing_team",
            teamId,
          },
          String(teamId),
        );
        return res
          .status(409)
          .json({ code: "TEAM_INACTIVE", message: "현재 등록 가능한 활성 팀이 아닙니다." });
      }
      assertCurrentCompetitionYear(team.year);
      const settings = settingsForYear(team.year);
      if (!settings.open) {
        logger.warn(
          req,
          "registration.register",
          {
            reason: "closed",
            team: auditTeam(team),
          },
          String(team.id),
        );
        return res
          .status(403)
          .json({ code: "REGISTRATION_CLOSED", message: "지금은 등록 대기 접수를 받지 않습니다." });
      }
      const active = db
        .prepare(
          `
        SELECT id, status FROM registration_queue
        WHERE team_id = ? AND status = 'waiting'
      `,
        )
        .get(team.id);
      if (active) {
        logger.warn(
          req,
          "registration.register",
          {
            reason: "duplicate",
            team: auditTeam(team),
            existingStatus: active.status,
          },
          String(team.id),
        );
        return res.status(409).json({
          code: "REGISTRATION_ALREADY_ACTIVE",
          message: "이미 대기 중인 엔트리입니다.",
        });
      }

      let inserted;
      try {
        inserted = db
          .prepare(
            `
          INSERT INTO registration_queue (team_id, phone) VALUES (?, ?)
        `,
          )
          .run(team.id, phone);
      } catch (insertError) {
        // 위 중복 검사와 INSERT 사이에 다른 요청이 끼면 부분 유니크 인덱스
        // idx_registration_queue_active_team 가 막는다. dbRun 은 이를 400 +
        // 원시 SQL 문구로 바꿔 계약을 깨므로, 여기서 중복 응답으로 직접 매핑한다.
        if (String(insertError?.code || "").startsWith("SQLITE_CONSTRAINT")) {
          logger.warn(
            req,
            "registration.register",
            {
              reason: "duplicate_race",
              team: auditTeam(team),
              error: insertError.message,
            },
            String(team.id),
          );
          return res.status(409).json({
            code: "REGISTRATION_ALREADY_ACTIVE",
            message: "이미 대기 중인 엔트리입니다.",
          });
        }
        throw insertError;
      }
      const id = Number(inserted.lastInsertRowid);
      const position = db
        .prepare(
          `
        SELECT COUNT(*) AS count
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting' AND q.id <= ?
      `,
        )
        .get(team.year, id).count;
      const waitingTotal = db
        .prepare(
          `
        SELECT COUNT(*) AS count
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting'
      `,
        )
        .get(team.year).count;

      logger.log(
        req,
        "registration.register",
        {
          registrationId: id,
          team: auditTeam(team),
          phone,
          position,
        },
        String(id),
      );
      broadcastChange(team.year);
      return res.status(201).json({
        id,
        teamId: team.id,
        number: team.number,
        university: team.university,
        name: team.name,
        position,
        waitingTotal,
      });
    } catch (error) {
      logger.warn(
        req,
        "registration.register",
        {
          error: error.message,
          team: auditTeam(team),
          phone,
        },
        team ? String(team.id) : "registration",
      );
      return sendError(res, error, "REGISTRATION_CREATE_FAILED");
    }
  });

  app.post("/api/queue/:id/done", (req, res) =>
    transition(req, res, {
      from: [ACTIVE_STATUS],
      to: "done",
      timestampColumn: "finished_at",
      action: "registration.done",
    }),
  );

  app.post("/api/queue/:id/cancel", (req, res) =>
    transition(req, res, {
      from: [ACTIVE_STATUS],
      to: "canceled",
      timestampColumn: "finished_at",
      action: "registration.cancel",
    }),
  );
}
