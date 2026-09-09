import { validateEntryNum } from "../../../../../shared/common/validation.mjs";

export function registerPriorityRoutes({
  app,
  validateInspection,
  dbRun,
  db,
  currentYear,
  validatePriority,
  requestTeamActivity,
  logger,
  broadcastQueue,
}) {
  /* ============================================
   API 라우트: Admin - 팀 우선순위 관리
   ============================================ */

  // GET /api/admin/priority/:type - 검차별 팀 우선순위 조회
  app.get("/api/admin/priority/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const result = dbRun(() =>
      db
        .prepare(
          `
      SELECT p.* FROM team_priority p
      WHERE p.inspection = ? AND p.year = ?
        AND NOT EXISTS (
          SELECT 1 FROM competition_inactive_team s
          WHERE s.year = p.year AND s.team_num = p.num
        )
      ORDER BY p.priority ASC, p.num ASC
    `,
        )
        .all(req.params.type, currentYear()),
    );

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // POST /api/admin/priority/:type - 검차별 팀 우선순위 설정/추가
  app.post("/api/admin/priority/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const numValidation = validateEntryNum(req.body.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const priorityValidation = validatePriority(req.body.priority);
    if (!priorityValidation.valid) {
      return res.status(400).send(priorityValidation.error);
    }

    const activity = requestTeamActivity(req, res, {
      action: "priority.set",
      num: numValidation.value,
    });
    if (!activity.ok) return;
    if (!activity.active) {
      logger.warn(
        req,
        "priority.set",
        {
          error: "inactive_or_missing_team",
          reason: "inactive_or_missing_team",
          year: currentYear(),
          team_num: numValidation.value,
          inspection: req.params.type,
          requested_priority: priorityValidation.value,
        },
        `#${numValidation.value}`,
      );
      return res.status(409).send("비활성화된 엔트리에는 우선순위를 설정할 수 없습니다.");
    }

    const result = dbRun(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO team_priority (num, inspection, year, priority) VALUES (?, ?, ?, ?)",
        )
        .run(numValidation.value, req.params.type, currentYear(), priorityValidation.value),
    );

    if (!result.success) {
      logger.warn(
        req,
        "priority.set",
        { error: result.internalError || result.error },
        `#${numValidation.value}`,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(
      req,
      "priority.set",
      { inspection: req.params.type, priority: priorityValidation.value },
      `#${numValidation.value}`,
    );

    // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
    broadcastQueue(req.params.type);

    res.status(201).send();
  });

  // DELETE /api/admin/priority/:type - 검차별 팀 우선순위 삭제
  app.delete("/api/admin/priority/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const numValidation = validateEntryNum(req.body.num);
    if (!numValidation.valid) {
      return res.status(400).send(numValidation.error);
    }

    const year = currentYear();
    const result = dbRun(() =>
      db.transaction(() => {
        const prior = db
          .prepare(
            "SELECT priority FROM team_priority WHERE num = ? AND inspection = ? AND year = ?",
          )
          .get(numValidation.value, req.params.type, year);
        const deleted = db
          .prepare("DELETE FROM team_priority WHERE num = ? AND inspection = ? AND year = ?")
          .run(numValidation.value, req.params.type, year);
        return { prior, deleted };
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "priority.delete",
        {
          error: result.internalError || result.error,
          phase: "mutation_preflight",
          year,
          team_num: numValidation.value,
          inspection: req.params.type,
        },
        `#${numValidation.value}`,
      );
      return res.status(result.status).send(result.error);
    }

    if (!result.result.deleted.changes) {
      logger.warn(
        req,
        "priority.delete",
        { error: "존재하지 않는 우선순위 엔트리" },
        "#" + numValidation.value,
      );
      return res.status(400).send("존재하지 않는 우선순위 엔트리입니다.");
    }

    logger.log(
      req,
      "priority.delete",
      { inspection: req.params.type, priority: result.result.prior?.priority },
      `#${numValidation.value}`,
    );

    // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
    broadcastQueue(req.params.type);

    res.status(200).send();
  });

  // DELETE /api/admin/priority/:type/all - 검차별 우선순위 전체 초기화
  app.delete("/api/admin/priority/:type/all", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const result = dbRun(() =>
      db
        .prepare("DELETE FROM team_priority WHERE inspection = ? AND year = ?")
        .run(req.params.type, currentYear()),
    );

    if (!result.success) {
      logger.warn(
        req,
        "priority.clear",
        { error: result.internalError || result.error },
        req.params.type,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "priority.clear", null, req.params.type);

    // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
    broadcastQueue(req.params.type);

    res.status(200).send();
  });
}
