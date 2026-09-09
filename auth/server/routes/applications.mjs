import { VALID_ROLES } from "../../../shared/server/express-setup.mjs";

export function registerApplicationsRoutes({
  app,
  isApplicationsOpen,
  getApplicant,
  db,
  logger,
  dbRun,
  notifyNewUser,
}) {
  /* ============================================
   계정 신청 (Account Application)
   ============================================ */

  // GET /api/apply/config - 신청 가능 여부 (공개)
  app.get("/api/apply/config", (req, res) => {
    res.json({ open: isApplicationsOpen() });
  });

  // GET /api/apply/me - 현재 세션/신청자 상태
  app.get("/api/apply/me", (req, res) => {
    // 이미 로그인된(등록된) 사용자
    if (req.user) {
      return res.json({ registered: true, email: req.user.email, name: req.user.name });
    }
    const applicant = getApplicant(req);
    if (!applicant) return res.status(401).send("인증이 필요합니다.");
    const application =
      db
        .prepare(
          "SELECT realname, phone, affiliation, created_at, updated_at FROM applications WHERE email = ?",
        )
        .get(applicant.email) || null;
    res.json({
      registered: false,
      email: applicant.email,
      name: applicant.name,
      application,
      applicationsOpen: isApplicationsOpen(),
    });
  });

  // POST /api/apply - 신청서 제출
  app.post("/api/apply", (req, res) => {
    const applicant = getApplicant(req);
    if (!applicant) return res.status(401).send("인증이 필요합니다.");
    // 아래 duplicate 409와 같은 DB 기반 비즈니스 거절 — 셋 다 warn으로 관측 가능해야 한다.
    if (!isApplicationsOpen()) {
      logger.warn(req, "applicant.apply", { error: "closed" }, applicant.email, {
        email: applicant.email,
        name: applicant.name,
      });
      return res.status(403).send("현재 신청이 마감되었습니다.");
    }
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(applicant.email)) {
      logger.warn(req, "applicant.apply", { error: "already registered" }, applicant.email, {
        email: applicant.email,
        name: applicant.name,
      });
      return res.status(409).send("이미 등록된 계정입니다.");
    }

    const realname = (req.body.realname || "").trim();
    const phone = (req.body.phone || "").trim();
    const affiliation = (req.body.affiliation || "").trim();
    if (!realname || !phone || !affiliation) {
      return res.status(400).send("실명, 전화번호, 학교/팀을 모두 입력하세요.");
    }

    const result = dbRun(() =>
      db
        .prepare(
          "INSERT INTO applications (email, name, realname, phone, affiliation) VALUES (?, ?, ?, ?, ?)",
        )
        .run(applicant.email, applicant.name, realname, phone, affiliation),
    );

    if (!result.success) {
      if (result.error.includes("UNIQUE")) {
        logger.warn(req, "applicant.apply", { error: "duplicate" }, applicant.email);
        return res.status(409).send("이미 신청서를 제출했습니다.");
      }
      logger.warn(
        req,
        "applicant.apply",
        { error: result.internalError || result.error },
        applicant.email,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "applicant.apply", { realname, affiliation }, applicant.email, {
      email: applicant.email,
      name: applicant.name,
    });
    res.status(201).json({ ok: true });
  });

  // PATCH /api/apply - 본인 신청서 수정 (토글 off여도 수정은 허용)
  app.patch("/api/apply", (req, res) => {
    const applicant = getApplicant(req);
    if (!applicant) return res.status(401).send("인증이 필요합니다.");

    const existing = db.prepare("SELECT id FROM applications WHERE email = ?").get(applicant.email);
    if (!existing) return res.status(404).send("신청 내역을 찾을 수 없습니다.");

    const realname = (req.body.realname || "").trim();
    const phone = (req.body.phone || "").trim();
    const affiliation = (req.body.affiliation || "").trim();
    if (!realname || !phone || !affiliation) {
      return res.status(400).send("실명, 전화번호, 학교/팀을 모두 입력하세요.");
    }

    const result = dbRun(() =>
      db
        .prepare(
          "UPDATE applications SET realname = ?, phone = ?, affiliation = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email = ?",
        )
        .run(realname, phone, affiliation, applicant.email),
    );

    if (!result.success) {
      logger.warn(
        req,
        "applicant.apply_edit",
        { error: result.internalError || result.error },
        applicant.email,
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "applicant.apply_edit", { realname, affiliation }, applicant.email, {
      email: applicant.email,
      name: applicant.name,
    });
    res.status(200).send();
  });

  /* ============================================
   계정 신청 관리 (관리자)
   ============================================ */

  // GET /api/applications - 대기 중인 신청 목록
  app.get("/api/applications", (req, res) => {
    const result = dbRun(() =>
      db
        .prepare(
          "SELECT id, email, name, realname, phone, affiliation, created_at, updated_at FROM applications ORDER BY id",
        )
        .all(),
    );
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // PATCH /api/applications/config - 신청 접수 on/off
  app.patch("/api/applications/config", (req, res) => {
    const { open } = req.body;
    if (typeof open !== "boolean") return res.status(400).send("open(boolean) 값이 필요합니다.");
    const result = dbRun(() =>
      db
        .prepare(
          "INSERT INTO settings (key, value) VALUES ('applications_open', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(open ? "1" : "0"),
    );
    if (!result.success) {
      logger.warn(req, "applications.config", { error: result.internalError || result.error });
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "applications.config", { open });
    res.json({ open });
  });

  // POST /api/applications/approve - 선택 신청을 계정으로 일괄 추가 후 목록에서 제거
  app.post("/api/applications/approve", (req, res) => {
    const { ids, role } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).send("신청을 선택하세요.");
    if (!VALID_ROLES.includes(role)) return res.status(400).send("올바르지 않은 역할입니다.");

    const numIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (numIds.length === 0) return res.status(400).send("유효한 ID가 없습니다.");
    if (numIds.length !== ids.length) return res.status(400).send("일부 ID가 올바르지 않습니다.");

    const placeholders = numIds.map(() => "?").join(",");
    const insertUser = db.prepare(
      "INSERT OR IGNORE INTO users (email, role, realname, phone, affiliation) VALUES (?, ?, ?, ?, ?)",
    );

    // logger는 트랜잭션 밖에서만 호출 (트랜잭션 내부 호출은 롤백됨)
    const txResult = dbRun(() =>
      db.transaction(() => {
        const apps = db
          .prepare(
            `SELECT id, email, realname, phone, affiliation FROM applications WHERE id IN (${placeholders})`,
          )
          .all(...numIds);
        const added = [];
        const skipped = [];
        for (const a of apps) {
          const email = a.email.trim().toLowerCase();
          const r = insertUser.run(
            email,
            role,
            a.realname || "",
            a.phone || "",
            a.affiliation || "",
          );
          if (r.changes > 0) added.push(email);
          else skipped.push(email);
        }
        db.prepare(`DELETE FROM applications WHERE id IN (${placeholders})`).run(...numIds);
        return { added, skipped };
      })(),
    );

    if (!txResult.success) {
      logger.warn(req, "applications.approve", { error: txResult.internalError || txResult.error });
      return res.status(txResult.status).send(txResult.error);
    }

    const { added, skipped } = txResult.result;
    logger.log(req, "applications.approve", { role, added, skipped });
    if (added.length > 0) notifyNewUser(added);
    res.json({ added: added.length, skipped: skipped.length });
  });

  // DELETE /api/applications - 선택 신청을 계정 추가 없이 삭제(거절/정리)
  app.delete("/api/applications", (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).send("삭제할 신청을 선택하세요.");

    const numIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (numIds.length === 0) return res.status(400).send("유효한 ID가 없습니다.");
    if (numIds.length !== ids.length) return res.status(400).send("일부 ID가 올바르지 않습니다.");

    const placeholders = numIds.map(() => "?").join(",");
    const txResult = dbRun(() =>
      db.transaction(() => {
        const emails = db
          .prepare(`SELECT email FROM applications WHERE id IN (${placeholders})`)
          .all(...numIds)
          .map((r) => r.email);
        const del = db
          .prepare(`DELETE FROM applications WHERE id IN (${placeholders})`)
          .run(...numIds);
        return { changes: del.changes, emails };
      })(),
    );

    if (!txResult.success) {
      logger.warn(req, "applications.delete", {
        error: txResult.internalError || txResult.error,
        ids: numIds,
      });
      return res.status(txResult.status).send(txResult.error);
    }

    logger.log(req, "applications.delete", { emails: txResult.result.emails });
    res.json({ deleted: txResult.result.changes });
  });
}
