import {
  accessCatalog,
  PERMISSION_KEYS,
  normalizeAccessGrants,
} from "../../../shared/common/access-control.js";
import { VALID_ROLES } from "../../../shared/server/express-setup.mjs";

export function registerUsersRoutes({
  app,
  db,
  userAccess,
  dbRun,
  ADMIN_EMAIL,
  logger,
  notifyNewUser,
}) {
  // GET /api/users/exists/:email - 사용자 존재 + 활성 여부 (내부 서비스용)
  app.get("/api/users/exists/:email", (req, res) => {
    const user = db
      .prepare("SELECT 1 FROM users WHERE email = ? AND active = 1")
      .get(req.params.email);
    if (!user) return res.status(404).send();
    res.status(200).send();
  });

  // GET /api/users/access/:email - authoritative service authorization snapshot
  app.get("/api/users/access/:email", (req, res) => {
    const user = db
      .prepare(
        "SELECT id, role, realname, access_revision FROM users WHERE email = ? AND active = 1",
      )
      .get(req.params.email);
    if (!user) return res.status(404).send();
    const snapshot = userAccess(user);
    res.json({
      id: user.id,
      role: user.role,
      realname: user.realname || "",
      permissions: snapshot.permissions,
      accessRevision: snapshot.accessRevision,
    });
  });

  app.get("/api/access/catalog", (req, res) => res.json(accessCatalog()));

  app.get("/api/internal/users", (req, res) => {
    const result = dbRun(() =>
      db
        .prepare("SELECT id, email, name, role, realname, phone, active FROM users ORDER BY id")
        .all(),
    );
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // GET /api/users - 전체 사용자 목록
  app.get("/api/users", (req, res) => {
    const result = dbRun(() =>
      db
        .prepare(
          "SELECT id, email, name, role, realname, phone, affiliation, active, created_at, access_revision FROM users ORDER BY id",
        )
        .all(),
    );
    if (!result.success) return res.status(result.status).send(result.error);
    res.json(
      result.result.map((u) => ({
        ...u,
        ...userAccess(u),
        protected: u.email === ADMIN_EMAIL,
      })),
    );
  });

  // PUT /api/users/bulk/access - 선택한 Official 여러 명의 권한을 같은 목록으로 교체
  // Declared before /api/users/:id/access so "bulk" is never read as a user id.
  app.put("/api/users/bulk/access", (req, res) => {
    const { users: targets, grants } = req.body || {};
    const validTargets =
      Array.isArray(targets) &&
      targets.length > 0 &&
      targets.every(
        (target) => Number.isInteger(target?.id) && Number.isInteger(target?.expectedRevision),
      ) &&
      new Set(targets.map((target) => target.id)).size === targets.length;
    if (!validTargets || !Array.isArray(grants)) {
      logger.warn(req, "user.bulk_access_update", { reason: "invalid_request" });
      return res.status(400).json({ code: "INVALID_ACCESS_REQUEST" });
    }
    if (
      new Set(grants).size !== grants.length ||
      grants.some((key) => !PERMISSION_KEYS.includes(key))
    ) {
      logger.warn(req, "user.bulk_access_update", { reason: "invalid_access_key", grants });
      return res.status(400).json({ code: "INVALID_ACCESS_KEY" });
    }
    const normalizedGrants = normalizeAccessGrants(grants);
    const ids = targets.map((target) => target.id);
    const expectedRevisions = new Map(
      targets.map((target) => [target.id, target.expectedRevision]),
    );
    const placeholders = ids.map(() => "?").join(",");
    const selectTargets = db.prepare(
      `SELECT id, email, role, access_revision FROM users WHERE id IN (${placeholders}) ORDER BY id`,
    );

    const result = dbRun(() =>
      db.transaction(() => {
        const rows = selectTargets.all(...ids);
        const found = new Set(rows.map((row) => row.id));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length > 0) return { missing };
        const nonOfficial = rows.filter((row) => row.role !== "official").map((row) => row.email);
        if (nonOfficial.length > 0) return { nonOfficial };
        const stale = rows
          .filter((row) => row.access_revision !== expectedRevisions.get(row.id))
          .map((row) => ({ id: row.id, email: row.email, current: userAccess(row) }));
        if (stale.length > 0) return { stale };

        const before = rows.map((row) => ({ email: row.email, ...userAccess(row) }));
        const deletePermissions = db.prepare("DELETE FROM user_permission WHERE user_id = ?");
        const insertPermission = db.prepare(
          "INSERT INTO user_permission (user_id, permission_key) VALUES (?, ?)",
        );
        const bumpRevision = db.prepare(
          "UPDATE users SET access_revision = access_revision + 1 WHERE id = ?",
        );
        for (const row of rows) {
          deletePermissions.run(row.id);
          for (const key of normalizedGrants) insertPermission.run(row.id, key);
          bumpRevision.run(row.id);
        }
        const after = selectTargets
          .all(...ids)
          .map((row) => ({ id: row.id, email: row.email, ...userAccess(row) }));
        return { before, after };
      })(),
    );

    if (!result.success) {
      logger.warn(req, "user.bulk_access_update", {
        error: result.internalError || result.error,
        ids,
      });
      return res.status(result.status).send(result.error);
    }
    if (result.result.missing) {
      logger.warn(req, "user.bulk_access_update", {
        reason: "not_found",
        ids: result.result.missing,
      });
      return res.status(404).json({ code: "USER_NOT_FOUND", ids: result.result.missing });
    }
    if (result.result.nonOfficial) {
      logger.warn(req, "user.bulk_access_update", {
        reason: "official_only",
        emails: result.result.nonOfficial,
      });
      return res
        .status(409)
        .json({ code: "OFFICIAL_ACCESS_ONLY", emails: result.result.nonOfficial });
    }
    if (result.result.stale) {
      logger.warn(req, "user.bulk_access_update", {
        reason: "stale_write",
        stale: result.result.stale.map(({ id, email, current }) => ({
          id,
          email,
          actual_revision: current.accessRevision,
        })),
      });
      return res.status(409).json({ code: "ACCESS_STALE_WRITE", stale: result.result.stale });
    }
    logger.log(req, "user.bulk_access_update", {
      grants: normalizedGrants,
      before: result.result.before,
      after: result.result.after,
    });
    res.json({ updated: result.result.after.length, users: result.result.after });
  });

  app.put("/api/users/:id/access", (req, res) => {
    const id = Number(req.params.id);
    const { expectedRevision, grants } = req.body || {};
    if (!Number.isInteger(expectedRevision) || !Array.isArray(grants)) {
      logger.warn(
        req,
        "user.access_update",
        { reason: "invalid_request", id },
        String(req.params.id),
      );
      return res.status(400).json({ code: "INVALID_ACCESS_REQUEST" });
    }
    if (
      new Set(grants).size !== grants.length ||
      grants.some((key) => !PERMISSION_KEYS.includes(key))
    ) {
      logger.warn(
        req,
        "user.access_update",
        {
          reason: "invalid_access_key",
          id,
          grants,
        },
        String(req.params.id),
      );
      return res.status(400).json({ code: "INVALID_ACCESS_KEY" });
    }
    const normalizedGrants = normalizeAccessGrants(grants);

    const beforeUser = db
      .prepare("SELECT id, email, role, access_revision FROM users WHERE id = ?")
      .get(id);
    if (!beforeUser) {
      logger.warn(req, "user.access_update", { reason: "not_found", id }, String(req.params.id));
      return res.status(404).send("사용자를 찾을 수 없습니다.");
    }
    if (beforeUser.role !== "official") {
      logger.warn(
        req,
        "user.access_update",
        { reason: "official_only", role: beforeUser.role },
        beforeUser.email,
      );
      return res.status(409).json({ code: "OFFICIAL_ACCESS_ONLY" });
    }
    const before = userAccess(beforeUser);

    const result = dbRun(() =>
      db.transaction(() => {
        const current = db
          .prepare("SELECT id, role, access_revision FROM users WHERE id = ?")
          .get(id);
        if (!current || current.role !== "official") return { roleChanged: true };
        if (current.access_revision !== expectedRevision)
          return { stale: true, current: userAccess(current) };
        db.prepare("DELETE FROM user_permission WHERE user_id = ?").run(id);
        const insertPermission = db.prepare(
          "INSERT INTO user_permission (user_id, permission_key) VALUES (?, ?)",
        );
        for (const key of normalizedGrants) insertPermission.run(id, key);
        db.prepare("UPDATE users SET access_revision = access_revision + 1 WHERE id = ?").run(id);
        return {
          current: userAccess(
            db.prepare("SELECT id, role, access_revision FROM users WHERE id = ?").get(id),
          ),
        };
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "user.access_update",
        { error: result.internalError || result.error },
        beforeUser.email,
      );
      return res.status(result.status).send(result.error);
    }
    if (result.result.roleChanged) {
      logger.warn(req, "user.access_update", { reason: "role_changed" }, beforeUser.email);
      return res.status(409).json({ code: "OFFICIAL_ACCESS_ONLY" });
    }
    if (result.result.stale) {
      logger.warn(
        req,
        "user.access_update",
        {
          reason: "stale_write",
          expected_revision: expectedRevision,
          actual_revision: result.result.current.accessRevision,
        },
        beforeUser.email,
      );
      return res.status(409).json({ code: "ACCESS_STALE_WRITE", current: result.result.current });
    }
    logger.log(
      req,
      "user.access_update",
      { before, after: result.result.current },
      beforeUser.email,
    );
    res.json(result.result.current);
  });

  // POST /api/users - 사용자 추가
  app.post("/api/users", (req, res) => {
    const { email, role } = req.body;
    if (!email || !email.trim()) return res.status(400).send("이메일을 입력하세요.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return res.status(400).send("올바르지 않은 이메일 형식입니다.");
    if (!VALID_ROLES.includes(role)) return res.status(400).send("올바르지 않은 역할입니다.");

    const result = dbRun(() =>
      db
        .prepare("INSERT INTO users (email, role) VALUES (?, ?)")
        .run(email.trim().toLowerCase(), role),
    );

    if (!result.success) {
      if (result.error.includes("UNIQUE")) {
        logger.warn(req, "user.create", { error: "duplicate" }, email.trim().toLowerCase());
        return res.status(400).send("이미 등록된 이메일입니다.");
      }
      logger.warn(
        req,
        "user.create",
        { error: result.internalError || result.error },
        email.trim().toLowerCase(),
      );
      return res.status(result.status).send(result.error);
    }

    logger.log(req, "user.create", { role }, email.trim().toLowerCase());
    notifyNewUser(email.trim().toLowerCase());
    res
      .status(201)
      .json({ id: result.result.lastInsertRowid, email: email.trim().toLowerCase(), role });
  });

  // POST /api/users/bulk - 벌크 사용자 추가
  app.post("/api/users/bulk", (req, res) => {
    const { users: rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).send("추가할 사용자 목록이 비어있습니다.");

    const insert = db.prepare(
      "INSERT OR IGNORE INTO users (email, role, realname, phone, affiliation) VALUES (?, ?, ?, ?, ?)",
    );
    const insertPermission = db.prepare(
      "INSERT INTO user_permission (user_id, permission_key) VALUES (?, ?)",
    );
    const added = [];
    const addedAccess = [];
    const skipped = [];
    const errors = [];

    const run = db.transaction(() => {
      for (const row of rows) {
        const email = (row.email || "").trim().toLowerCase();
        if (!email) {
          errors.push({ row, reason: "이메일 없음" });
          continue;
        }
        // 단건 추가(POST /api/users)와 동일한 형식 검증 — 벌크만 우회해 잘못된 주소가
        // 저장되면 이후 이메일 발송·로그인 매칭이 조용히 실패한다.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push({ row, reason: "올바르지 않은 이메일 형식" });
          continue;
        }

        const role = VALID_ROLES.includes(row.role) ? row.role : "student";
        if (!VALID_ROLES.includes(row.role)) {
          errors.push({ row, reason: `알 수 없는 역할 "${row.role}", "student"로 설정됨` });
        }
        const realname = (row.realname || "").trim();
        const phone = (row.phone || "").trim();
        const affiliation = (row.affiliation || "").trim();
        const grants = Array.isArray(row.grants) ? row.grants : [];
        if (grants.some((key) => !PERMISSION_KEYS.includes(key))) {
          errors.push({ row, reason: "알 수 없는 서비스 권한" });
          continue;
        }
        const normalizedGrants = normalizeAccessGrants([...new Set(grants)]);

        const result = insert.run(email, role, realname, phone, affiliation);
        if (result.changes > 0) {
          if (role === "official") {
            for (const key of normalizedGrants) insertPermission.run(result.lastInsertRowid, key);
          }
          added.push(email);
          addedAccess.push({
            email,
            role,
            grants: role === "official" ? normalizedGrants : [],
          });
        } else skipped.push(email);
      }
    });

    const txResult = dbRun(() => run());
    if (!txResult.success) {
      logger.warn(req, "user.bulk_create", { error: txResult.internalError || txResult.error });
      return res.status(txResult.status).send(txResult.error);
    }

    // 클라이언트로만 반환되고 버려지던 행별 거절 사유를 로그에도 남긴다(형식 오류·역할 보정).
    logger.log(req, "user.bulk_create", {
      // Keep the established email list for log consumers and record the new
      // service grants alongside it for a complete access audit.
      added,
      access: addedAccess,
      skipped,
      errors: errors.map((e) => ({ email: e.row?.email, reason: e.reason })),
    });
    if (added.length > 0) notifyNewUser(added);
    res.json({ added: added.length, skipped: skipped.length, errors });
  });

  // PATCH /api/users/bulk - 벌크 활성/비활성
  app.patch("/api/users/bulk", (req, res) => {
    const { ids, active } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).send("사용자를 선택하세요.");
    if (active === undefined) return res.status(400).send("active 값이 필요합니다.");

    const numIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (numIds.length === 0) return res.status(400).send("유효한 ID가 없습니다.");
    if (numIds.length !== ids.length) return res.status(400).send("일부 ID가 올바르지 않습니다.");

    // ADMIN_EMAIL 보호
    if (ADMIN_EMAIL && !active) {
      const protectedUser = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
      if (protectedUser && numIds.includes(protectedUser.id)) {
        logger.warn(
          req,
          "user.bulk_toggle",
          { reason: "protected_admin", id: protectedUser.id },
          ADMIN_EMAIL,
        );
        return res.status(400).send("기본 관리자는 비활성화할 수 없습니다.");
      }
    }

    // 마지막 활성 관리자 잠금 방지: 비활성화 대상이 현재 활성 admin 전부를 포함하면 거부.
    // (삭제·강등엔 이미 가드가 있으나 비활성화 경로엔 없었다. active=0 admin은 로그인·검증이
    // 불가하므로 활성 admin 기준으로 센다.)
    if (!active) {
      const activeAdminIds = db
        .prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1")
        .all()
        .map((r) => r.id);
      if (activeAdminIds.length > 0 && activeAdminIds.every((aid) => numIds.includes(aid))) {
        logger.warn(req, "user.bulk_toggle", { reason: "last_admin_deactivate" });
        return res.status(400).send("마지막 활성 관리자는 비활성화할 수 없습니다.");
      }
    }

    const placeholders = numIds.map(() => "?").join(",");
    const emails = db
      .prepare(`SELECT email FROM users WHERE id IN (${placeholders})`)
      .all(...numIds)
      .map((r) => r.email);
    const stmt = db.prepare(
      `UPDATE users SET active = ?, access_revision = access_revision + 1 WHERE id IN (${placeholders})`,
    );
    const run = db.transaction(() => stmt.run(active ? 1 : 0, ...numIds));

    const txResult = dbRun(() => run());
    if (!txResult.success) {
      logger.warn(req, "user.bulk_toggle", { error: txResult.internalError || txResult.error });
      return res.status(txResult.status).send(txResult.error);
    }

    logger.log(req, "user.bulk_toggle", { emails, active: !!active });
    res.json({ updated: txResult.result.changes });
  });

  // DELETE /api/users/bulk - 벌크 사용자 삭제
  app.delete("/api/users/bulk", (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).send("삭제할 사용자를 선택하세요.");

    const numIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (numIds.length === 0) return res.status(400).send("유효한 ID가 없습니다.");
    if (numIds.length !== ids.length) return res.status(400).send("일부 ID가 올바르지 않습니다.");

    // ADMIN_EMAIL 보호
    if (ADMIN_EMAIL) {
      const protectedUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get(ADMIN_EMAIL);
      if (protectedUser && numIds.includes(protectedUser.id)) {
        logger.warn(
          req,
          "user.bulk_delete",
          { reason: "protected_admin", id: protectedUser.id },
          ADMIN_EMAIL,
        );
        return res.status(400).send("기본 관리자는 삭제할 수 없습니다.");
      }
    }

    const placeholders = numIds.map(() => "?").join(",");

    let denyReason = null;
    const txResult = dbRun(() =>
      db.transaction(() => {
        // 마지막 활성 관리자 삭제 방지: 삭제 대상을 제외한 활성 admin이 0이 되면 거부한다
        // (비활성 admin까지 세면 활성 0 잠금을 못 막는다 — 단건 삭제·강등·비활성화와 동일 기준).
        const remainingActiveAdmins = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND active = 1 AND id NOT IN (${placeholders})`,
          )
          .get(...numIds).cnt;
        if (remainingActiveAdmins < 1) {
          denyReason = "last_admin";
          throw { status: 400, message: "마지막 관리자는 삭제할 수 없습니다." };
        }

        const emails = db
          .prepare(`SELECT email FROM users WHERE id IN (${placeholders})`)
          .all(...numIds)
          .map((r) => r.email);
        db.prepare(`DELETE FROM ops_display WHERE user_id IN (${placeholders})`).run(...numIds);
        const delResult = db
          .prepare(`DELETE FROM users WHERE id IN (${placeholders})`)
          .run(...numIds);
        return { changes: delResult.changes, emails };
      })(),
    );
    if (!txResult.success) {
      logger.warn(
        req,
        "user.bulk_delete",
        denyReason
          ? { error: txResult.internalError || txResult.error, reason: denyReason, ids: numIds }
          : { error: txResult.internalError || txResult.error },
      );
      return res.status(txResult.status).send(txResult.error);
    }

    logger.log(req, "user.bulk_delete", { emails: txResult.result.emails });
    res.json({ deleted: txResult.result.changes });
  });

  // PATCH /api/users/:id - 역할/실명/전화번호/활성 변경
  app.patch("/api/users/:id", (req, res) => {
    const id = Number(req.params.id);
    const { role, realname, phone, affiliation, active } = req.body;

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!user) return res.status(404).send("사용자를 찾을 수 없습니다.");
    const beforeAccess = userAccess(user);

    // 사전 검증
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) return res.status(400).send("올바르지 않은 역할입니다.");
      if (user.email === ADMIN_EMAIL && role !== "admin") {
        logger.warn(req, "user.update", { reason: "protected_admin", role }, user.email);
        return res.status(400).send("기본 관리자의 역할은 변경할 수 없습니다.");
      }
    }

    if (active !== undefined && user.email === ADMIN_EMAIL) {
      logger.warn(req, "user.update", { reason: "protected_admin", active }, user.email);
      return res.status(400).send("기본 관리자는 비활성화할 수 없습니다.");
    }

    // 트랜잭션으로 원자적 업데이트
    let denyReason = null;
    const result = dbRun(() => {
      db.transaction(() => {
        if (role !== undefined && user.role === "admin" && role !== "admin") {
          // 대상을 제외한 활성 admin이 0이 되면 거부(삭제·비활성화와 동일 기준).
          const remainingActiveAdmins = db
            .prepare(
              "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
            )
            .get(id).cnt;
          if (remainingActiveAdmins < 1) {
            denyReason = "last_admin_demote";
            throw { status: 400, message: "마지막 관리자는 강등할 수 없습니다." };
          }
        }
        // 마지막 활성 관리자 비활성화 잠금 방지(삭제·강등과 동일 정책). active=0 admin은
        // 로그인·검증이 불가하므로 활성 admin 기준으로 센다.
        if (active !== undefined && !active && user.role === "admin") {
          const activeAdmins = db
            .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND active = 1")
            .get().cnt;
          if (activeAdmins <= 1) {
            denyReason = "last_admin_deactivate";
            throw { status: 400, message: "마지막 활성 관리자는 비활성화할 수 없습니다." };
          }
        }
        const roleChanged = role !== undefined && role !== user.role;
        const activeChanged = active !== undefined && Number(!!active) !== Number(user.active);
        if (roleChanged) {
          db.prepare("DELETE FROM user_permission WHERE user_id = ?").run(id);
          db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
        }
        if (realname !== undefined)
          db.prepare("UPDATE users SET realname = ? WHERE id = ?").run(realname, id);
        if (phone !== undefined)
          db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, id);
        if (affiliation !== undefined)
          db.prepare("UPDATE users SET affiliation = ? WHERE id = ?").run(affiliation, id);
        if (activeChanged)
          db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
        if (roleChanged || activeChanged) {
          db.prepare("UPDATE users SET access_revision = access_revision + 1 WHERE id = ?").run(id);
        }
      })();
    });

    if (!result.success) {
      logger.warn(
        req,
        "user.update",
        denyReason
          ? { error: result.internalError || result.error, reason: denyReason, role }
          : { error: result.internalError || result.error },
        user.email,
      );
      return res.status(result.status).send(result.error);
    }

    const changes = {};
    if (role !== undefined) {
      changes.role = { from: user.role, to: role };
      if (role !== user.role) changes.clearedAccess = beforeAccess;
    }
    if (realname !== undefined) changes.realname = realname;
    if (phone !== undefined) changes.phone = phone;
    if (affiliation !== undefined) changes.affiliation = affiliation;
    if (active !== undefined) changes.active = !!active;
    logger.log(req, "user.update", changes, user.email);

    res.status(200).send();
  });

  // DELETE /api/users/:id - 사용자 삭제
  app.delete("/api/users/:id", (req, res) => {
    const id = Number(req.params.id);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!user) return res.status(404).send("사용자를 찾을 수 없습니다.");

    // ADMIN_EMAIL 보호
    if (user.email === ADMIN_EMAIL) {
      logger.warn(req, "user.delete", { reason: "protected_admin" }, user.email);
      return res.status(400).send("기본 관리자는 삭제할 수 없습니다.");
    }

    // 마지막 활성 admin 삭제 방지. 활성 admin만 로그인·검증 가능하므로, 대상을 제외한 활성
    // admin이 0이 되면 거부한다(비활성 admin까지 세면 활성 0 잠금을 못 막는다 — deactivate와 동일 기준).
    if (user.role === "admin") {
      const remainingActiveAdmins = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
        )
        .get(id).cnt;
      if (remainingActiveAdmins < 1) {
        logger.warn(req, "user.delete", { reason: "last_admin" }, user.email);
        return res.status(400).send("마지막 관리자는 삭제할 수 없습니다.");
      }
    }

    const result = dbRun(() =>
      db.transaction(() => {
        db.prepare("DELETE FROM ops_display WHERE user_id = ?").run(id);
        return db.prepare("DELETE FROM users WHERE id = ?").run(id);
      })(),
    );
    if (!result.success) {
      logger.warn(req, "user.delete", { error: result.internalError || result.error }, user.email);
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "user.delete", { role: user.role, name: user.name }, user.email);
    res.status(200).send();
  });
}
