export function registerEventModesRoutes({
  app,
  dbRun,
  getEventModes,
  runMutationPreflight,
  db,
  logger,
  broadcastEvent,
}) {
  /* ============================================
   API 라우트: /api/event-modes
   ============================================ */

  // GET /api/event-modes - 경기 모드 목록 및 활성화 상태 조회
  app.get("/api/event-modes", (req, res) => {
    const result = dbRun(() => getEventModes());
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // PUT /api/event-modes/:type - 경기 모드 활성화/비활성화 토글
  app.put("/api/event-modes/:type", (req, res) => {
    const eventType = req.params.type;
    const preflight = runMutationPreflight(req, res, {
      action: "event_mode.toggle",
      operation: "toggle",
      target: eventType,
      context: { event_type: eventType },
      lookup: () =>
        db.prepare("SELECT enabled FROM event_mode WHERE event_type = ?").get(eventType),
      failureMessage: "경기 모드 상태를 확인할 수 없습니다.",
    });
    if (!preflight.ok) return;
    const row = preflight.value;
    if (!row) {
      logger.warn(req, "event_mode.toggle", { error: "not_found" }, eventType);
      return res.status(404).send("경기 모드를 찾을 수 없습니다.");
    }

    const newEnabled = row.enabled ? 0 : 1;
    const result = dbRun(() =>
      db
        .prepare("UPDATE event_mode SET enabled = ? WHERE event_type = ?")
        .run(newEnabled, eventType),
    );
    if (!result.success) {
      logger.warn(
        req,
        "event_mode.toggle",
        { error: result.internalError || result.error },
        eventType,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "event_mode.toggle", { enabled: !!newEnabled }, eventType);

    broadcastEvent("event-mode", { event_type: eventType, enabled: newEnabled });
    res.json({ event_type: eventType, enabled: newEnabled });
  });
}
