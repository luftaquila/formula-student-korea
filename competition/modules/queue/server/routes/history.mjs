export function registerHistoryRoutes({
  app,
  currentYear,
  db,
  validateInspection,
  dbRun,
  logger,
  broadcastQueue,
  broadcastBooth,
}) {
  // GET /api/admin/history/status - 재검 현황 조회
  app.get("/api/admin/history/status", (req, res) => {
    const year = currentYear();
    const rows = db
      .prepare(
        `
    SELECT DISTINCT h.num, h.inspection
    FROM inspection_history h
    WHERE h.year = ?
      AND NOT EXISTS (
        SELECT 1 FROM competition_inactive_team s
        WHERE s.year = h.year AND s.team_num = h.num
      )
  `,
      )
      .all(year);

    const result = {};
    for (const row of rows) {
      (result[row.inspection] ??= []).push(row.num);
    }
    res.json(result);
  });

  // DELETE /api/admin/history/:type - 검차별 초검/재검 이력 초기화
  app.delete("/api/admin/history/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const type = typeValidation.value;
    const year = currentYear();

    const result = dbRun(() => {
      db.transaction(() => {
        db.prepare("DELETE FROM inspection_history WHERE inspection = ? AND year = ?").run(
          type,
          year,
        );

        // 부스 상태 초기화: 해당 검차 종류의 모든 부스 점유 해제
        db.prepare(
          `
        UPDATE booth
        SET occupied_by = NULL, entered_at = NULL, timer_paused_at = NULL, timer_paused_ms = 0
        WHERE inspection = ?
      `,
        ).run(type);
      })();
    });

    if (!result.success) {
      logger.warn(req, "history.clear", { error: result.internalError || result.error }, type);
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "history.clear", { year }, type);

    // SSE 브로드캐스트: 이력 초기화 -> 대기열 순서 변경 및 부스 상태 변경
    broadcastQueue(type);
    broadcastBooth(type);

    res.status(200).send();
  });
}
