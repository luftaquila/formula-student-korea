export function registerContactsRoutes({ app, dbRun, db, logger }) {
  /* ============================================
   운영 오피셜 연락처 (사이드바 표시)
   ============================================ */

  // GET /api/ops-contacts - 사이드바에 표시할 사용자 목록
  app.get("/api/ops-contacts", (req, res) => {
    const result = dbRun(() =>
      db
        .prepare(
          `
    SELECT u.id, u.email, u.name, u.realname, u.phone, d.description, d.sort_order
    FROM ops_display d JOIN users u ON d.user_id = u.id
    WHERE u.active = 1
    ORDER BY d.sort_order, u.id
  `,
        )
        .all(),
    );
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // POST /api/ops-contacts - 사용자를 사이드바 표시 목록에 추가
  app.post("/api/ops-contacts", (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).send("사용자 ID가 필요합니다.");

    const user = db
      .prepare("SELECT email, name, role FROM users WHERE id = ? AND active = 1")
      .get(user_id);
    if (!user) return res.status(404).send("사용자를 찾을 수 없습니다.");
    if (!["official", "admin"].includes(user.role)) {
      logger.warn(
        req,
        "ops_contact.create",
        { reason: "insufficient_role", role: user.role },
        user.email,
      );
      return res.status(400).send("official 이상 권한 사용자만 추가할 수 있습니다.");
    }

    const result = dbRun(() =>
      db.transaction(() => {
        const nextOrder = db
          .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM ops_display")
          .get().value;
        return db
          .prepare("INSERT OR IGNORE INTO ops_display (user_id, sort_order) VALUES (?, ?)")
          .run(user_id, nextOrder);
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "ops_contact.create",
        { error: result.internalError || result.error },
        user.email,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "ops_contact.create", { name: user.name, role: user.role }, user.email);
    res.status(201).send();
  });

  // POST /api/ops-contacts/reorder - 사이드바 표시 순서 변경
  app.post("/api/ops-contacts/reorder", (req, res) => {
    const { user_ids: userIds } = req.body ?? {};
    if (!Array.isArray(userIds)) return res.status(400).send("user_ids 배열이 필요합니다.");
    if (userIds.length > 1000) return res.status(400).send("연락처가 너무 많습니다.");
    const requestedIds = new Set(userIds);
    if (
      userIds.some((id) => !Number.isInteger(id) || id <= 0) ||
      requestedIds.size !== userIds.length
    ) {
      return res.status(400).send("user_ids에는 중복되지 않은 유효한 사용자 ID가 필요합니다.");
    }

    const rows = db
      .prepare(
        `
    SELECT d.user_id, u.active
    FROM ops_display d JOIN users u ON d.user_id = u.id
    ORDER BY d.sort_order, d.user_id
  `,
      )
      .all();
    const visibleIds = rows.filter((row) => row.active === 1).map((row) => row.user_id);
    if (visibleIds.length !== userIds.length || visibleIds.some((id) => !requestedIds.has(id))) {
      return res.status(400).send("현재 표시 중인 연락처를 모두 포함해야 합니다.");
    }

    const hiddenIds = rows.filter((row) => row.active !== 1).map((row) => row.user_id);
    const result = dbRun(() => {
      const update = db.prepare("UPDATE ops_display SET sort_order = ? WHERE user_id = ?");
      db.transaction(() => {
        [...userIds, ...hiddenIds].forEach((id, index) => update.run(index, id));
      })();
    });
    if (!result.success) {
      logger.warn(req, "ops_contact.reorder", {
        error: result.internalError || result.error,
        count: userIds.length,
      });
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "ops_contact.reorder", { count: userIds.length });
    res.status(200).send();
  });

  // PATCH /api/ops-contacts/:userId - 사이드바에 이름 뒤에 표시할 짧은 설명 수정
  app.patch("/api/ops-contacts/:userId", (req, res) => {
    const userId = Number(req.params.userId);
    const { description } = req.body ?? {};
    if (typeof description !== "string") return res.status(400).send("설명이 필요합니다.");

    const normalizedDescription = description.trim();
    if (normalizedDescription.length > 30)
      return res.status(400).send("설명은 30자 이내로 입력하세요.");

    const row = db
      .prepare(
        "SELECT d.user_id, u.email, u.name FROM ops_display d JOIN users u ON d.user_id = u.id WHERE d.user_id = ?",
      )
      .get(userId);
    if (!row) return res.status(404).send("표시 목록에 없는 사용자입니다.");

    const result = dbRun(() =>
      db
        .prepare("UPDATE ops_display SET description = ? WHERE user_id = ?")
        .run(normalizedDescription, userId),
    );
    if (!result.success) {
      logger.warn(
        req,
        "ops_contact.update",
        { error: result.internalError || result.error },
        row.email,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "ops_contact.update",
      { name: row.name, description: normalizedDescription },
      row.email,
    );
    res.json({ description: normalizedDescription });
  });

  // DELETE /api/ops-contacts/:userId - 사이드바 표시 목록에서 제거
  app.delete("/api/ops-contacts/:userId", (req, res) => {
    const userId = Number(req.params.userId);
    const row = db
      .prepare(
        "SELECT d.user_id, u.email, u.name FROM ops_display d JOIN users u ON d.user_id = u.id WHERE d.user_id = ?",
      )
      .get(userId);
    if (!row) return res.status(404).send("표시 목록에 없는 사용자입니다.");
    const result = dbRun(() => db.prepare("DELETE FROM ops_display WHERE user_id = ?").run(userId));
    if (!result.success) {
      logger.warn(
        req,
        "ops_contact.delete",
        { error: result.internalError || result.error },
        row.email,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "ops_contact.delete", { name: row.name }, row.email);
    res.status(200).send();
  });
}
