import { validateEntryNum } from "../../../../../shared/common/validation.mjs";

export function registerPenaltiesRoutes({
  app,
  currentYear,
  dbRun,
  db,
  validateInspection,
  requestTeamActivity,
  getQueueRow,
  addCurrentInspection,
  insertQueueRow,
  logger,
  broadcastQueue,
  broadcastPenalties,
}) {
  // GET /api/admin/penalties - 현재 연도에 적용 중인 취소 페널티 조회
  app.get("/api/admin/penalties", (req, res) => {
    const year = currentYear();
    const now = Date.now();
    const result = dbRun(() =>
      db
        .prepare(
          `
      SELECT
        cp.num,
        cp.inspection,
        i.name AS inspection_name,
        cp.until,
        CASE WHEN cp.phone IS NOT NULL AND cp.queue_timestamp IS NOT NULL THEN 1 ELSE 0 END AS can_restore
      FROM cancel_penalty cp
      JOIN inspection i ON i.type = cp.inspection
      WHERE cp.year = ? AND cp.until > ?
        AND NOT EXISTS (
          SELECT 1 FROM competition_inactive_team s
          WHERE s.year = cp.year AND s.team_num = cp.num
        )
      ORDER BY cp.until ASC, cp.num ASC, cp.inspection ASC
    `,
        )
        .all(year, now),
    );

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // POST /api/admin/penalties/:type/:num/restore - 페널티 해제 후 취소 전 순번 복구
  app.post("/api/admin/penalties/:type/:num/restore", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const numValidation = validateEntryNum(req.params.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const type = typeValidation.value;
    const num = numValidation.value;
    const year = currentYear();
    const activity = requestTeamActivity(req, res, { action: "penalty.restore", num, year });
    if (!activity.ok) return;
    const result = dbRun(() =>
      db.transaction(() => {
        if (!activity.active) {
          throw { status: 409, message: "비활성화된 엔트리의 대기열 상태는 복구할 수 없습니다." };
        }
        if (!db.prepare("SELECT active FROM inspection WHERE type = ?").get(type).active) {
          throw { status: 400, message: "대기열이 비활성화 상태입니다." };
        }

        const penalty = db
          .prepare(
            `
        SELECT phone, queue_timestamp
        FROM cancel_penalty
        WHERE num = ? AND inspection = ? AND year = ? AND until > ?
      `,
          )
          .get(num, type, year, Date.now());

        if (!penalty) {
          throw { status: 404, message: "적용 중인 페널티가 없습니다." };
        }
        if (!penalty.phone || penalty.queue_timestamp == null) {
          throw {
            status: 409,
            message: "취소 당시 대기열 정보가 없어 원래 순번으로 복구할 수 없습니다.",
          };
        }
        if (getQueueRow(type, num, year)) {
          throw { status: 409, message: "이미 대기열에 등록된 엔트리입니다." };
        }

        addCurrentInspection(num, penalty.phone, type, year);
        insertQueueRow(type, num, penalty.phone, penalty.queue_timestamp, year);
        db.prepare("DELETE FROM cancel_penalty WHERE num = ? AND inspection = ? AND year = ?").run(
          num,
          type,
          year,
        );
        db.prepare(
          "INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)",
        ).run("restore", num, type, Date.now(), year);

        return { queueTimestamp: penalty.queue_timestamp };
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "penalty.restore",
        { error: result.internalError || result.error, inspection: type, year },
        `#${num}`,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "penalty.restore",
      {
        inspection: type,
        year,
        queueTimestamp: result.result.queueTimestamp,
      },
      `#${num}`,
    );
    broadcastQueue(type);
    broadcastPenalties();
    res.status(200).send();
  });

  // DELETE /api/admin/penalties/:type/:num - 적용 중인 취소 페널티 해제
  app.delete("/api/admin/penalties/:type/:num", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const numValidation = validateEntryNum(req.params.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const type = typeValidation.value;
    const num = numValidation.value;
    const year = currentYear();
    const result = dbRun(() =>
      db
        .prepare(
          `
      DELETE FROM cancel_penalty
      WHERE num = ? AND inspection = ? AND year = ? AND until > ?
    `,
        )
        .run(num, type, year, Date.now()),
    );

    if (!result.success) {
      logger.warn(
        req,
        "penalty.clear",
        { error: result.internalError || result.error, inspection: type, year },
        `#${num}`,
      );
      return res.status(result.status).send(result.error);
    }

    if (!result.result.changes) {
      logger.warn(
        req,
        "penalty.clear",
        { error: "적용 중인 페널티 없음", inspection: type, year },
        `#${num}`,
      );
      return res.status(404).send("적용 중인 페널티가 없습니다.");
    }

    logger.log(req, "penalty.clear", { inspection: type, year }, `#${num}`);
    broadcastPenalties();
    res.status(200).send();
  });
}
