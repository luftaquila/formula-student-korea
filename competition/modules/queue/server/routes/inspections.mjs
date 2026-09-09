export function registerInspectionsRoutes({
  app,
  dbRun,
  getAllInspections,
  validateInspection,
  currentYear,
  getQueueStmt,
  getQueueParams,
  db,
  logger,
  broadcastInspections,
  broadcastQueue,
}) {
  /* ============================================
   API 라우트: Admin - 검차 관리
   ============================================ */

  // GET /api/admin/all - 모든 검차 목록 조회
  app.get("/api/admin/all", (req, res) => {
    const result = dbRun(() => getAllInspections());

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // GET /api/admin/inspection/:type - 검차별 대기열 조회
  app.get("/api/admin/inspection/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const year = currentYear();
    const result = dbRun(() =>
      getQueueStmt(req.params.type).all(...getQueueParams(req.params.type, year)),
    );

    if (!result.success) {
      return res.status(result.status).send(result.error);
    }

    res.json(result.result);
  });

  // PATCH /api/admin/inspection/:type - 검차 활성화 상태 변경
  app.patch("/api/admin/inspection/:type", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const result = dbRun(() =>
      db
        .prepare("UPDATE inspection SET active = ? WHERE type = ?")
        .run(req.body.active === true ? 1 : 0, req.params.type),
    );

    if (!result.success) {
      logger.warn(
        req,
        "inspection.toggle",
        { error: result.internalError || result.error },
        req.params.type,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "inspection.toggle", { active: req.body.active === true }, req.params.type);

    // SSE 브로드캐스트: 활성 검차 목록 변경
    broadcastInspections();

    res.status(200).send();
  });

  // PATCH /api/admin/inspection/:type/visibility - 검차 등록 페이지 표시 상태 변경
  app.patch("/api/admin/inspection/:type/visibility", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const result = dbRun(() =>
      db
        .prepare("UPDATE inspection SET hidden_from_register = ? WHERE type = ?")
        .run(req.body.hidden === true ? 1 : 0, req.params.type),
    );

    if (!result.success) {
      logger.warn(
        req,
        "inspection.visibility",
        { error: result.internalError || result.error },
        req.params.type,
      );
      return res.status(result.status).send(result.error);
    }

    // 요청 필드(hidden)를 그대로 기록 — 이중 부정(active)은 오독을 부른다.
    logger.log(req, "inspection.visibility", { hidden: req.body.hidden === true }, req.params.type);

    // SSE 브로드캐스트: 활성 검차 목록 변경 (hidden 정보 포함)
    broadcastInspections();

    res.status(200).send();
  });

  // PUT /api/admin/inspection/:type/ignore - 검차별 우선순위/초검재검 무시 설정
  app.put("/api/admin/inspection/:type/ignore", (req, res) => {
    const typeValidation = validateInspection(req.params.type);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }

    const type = typeValidation.value;
    const { field, value } = req.body;

    if (!["ignore_priority", "ignore_reinspection"].includes(field)) {
      return res.status(400).send("유효하지 않은 필드입니다.");
    }

    const result = dbRun(() => {
      if (field === "ignore_priority") {
        db.prepare("UPDATE inspection SET ignore_priority = ? WHERE type = ?").run(
          value ? 1 : 0,
          type,
        );
      } else {
        db.prepare("UPDATE inspection SET ignore_reinspection = ? WHERE type = ?").run(
          value ? 1 : 0,
          type,
        );
      }
    });

    if (!result.success) {
      logger.warn(req, "inspection.ignore", { error: result.internalError || result.error }, type);
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "inspection.ignore", { field, value: !!value }, type);

    // SSE 브로드캐스트: 설정 변경 -> 대기열 순서 변경
    broadcastQueue(type);

    res.status(200).send();
  });
}
