import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase, addColumn } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, createJWT, ensureDataDir, VALID_ROLES, isSecureConnection, formatCookieOpts } from "../shared/express-setup.mjs";
import { ROLE_LEVELS } from "../shared/constants.js";
import { createLogger } from "../shared/logger.mjs";

export function createAuthApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/auth.db");

db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'official')),
  memo TEXT DEFAULT '',
  created_at TEXT
)`);

// 마이그레이션: memo 컬럼 추가
addColumn(db, "users", "memo TEXT DEFAULT ''");

// 마이그레이션: active 컬럼 추가
addColumn(db, "users", "active INTEGER DEFAULT 1");

// 마이그레이션: created_at 기본값 제거 (최초 로그인 시점으로 변경)
// 아직 로그인하지 않은 사용자(name IS NULL)의 created_at 초기화
db.exec("UPDATE users SET created_at = NULL WHERE name IS NULL AND created_at IS NOT NULL");

// 마이그레이션: role CHECK 제약조건에 student, chief 추가
const roleCheck = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
if (roleCheck && !roleCheck.sql.includes("student")) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        role TEXT NOT NULL CHECK(role IN ('admin', 'chief', 'official', 'student')),
        memo TEXT DEFAULT '',
        created_at TEXT,
        active INTEGER DEFAULT 1
      );
      INSERT INTO users_new SELECT id, email, name, role, memo, created_at, active FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  })();
}

db.exec(`CREATE TABLE IF NOT EXISTS ops_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL
)`);

// Bootstrap: ADMIN_EMAIL이 DB에 없으면 admin으로 등록
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
if (ADMIN_EMAIL) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
  if (!existing) {
    db.prepare("INSERT INTO users (email, role) VALUES (?, 'admin')").run(ADMIN_EMAIL);
  }
}

/* ============================================
   Express 앱 설정
   ============================================ */
const validateUser = (email) => {
  const user = db.prepare("SELECT role FROM users WHERE email = ? AND active = 1").get(email);
  return user ? { valid: true, role: user.role } : { valid: false, role: null };
};

const logger = createLogger(db, "auth");

const app = createApp({ express, validateUser, db }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path === "/api/forward-auth") return null;
  if (req.path === "/api/session") return null;
  if (["/api/login", "/api/callback", "/api/logout"].includes(req.path)) return null;
  if (req.path.startsWith("/api/admin")) return "admin";
  if (req.path.startsWith("/api/users")) return "admin";
  if (req.path.startsWith("/api/ops-contacts") && req.method !== "GET") return "admin";
  if (req.path.startsWith("/api/ops-contacts")) return "official";
  if (req.path === "/api/logs") return "admin";
  if (req.path.startsWith("/api/")) return "admin"; // API 기본값: default-close
  return null; // SPA
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

// Session validation endpoint (landing page uses this to verify cookie state)
app.get("/api/session", (req, res) => {
  if (!req.user) return res.status(401).send();
  res.json({ name: req.user.name, role: req.user.role });
});

// Forward auth endpoint for Caddy forward_auth (FileBrowser etc.)
app.get("/api/forward-auth", (req, res) => {
  const key = req.headers["x-forward-auth-key"];
  const secret = process.env.INTERNAL_SECRET;
  if (!key || !secret) return res.status(403).send();
  const keyBuf = Buffer.from(key);
  const secretBuf = Buffer.from(secret);
  if (keyBuf.length !== secretBuf.length || !crypto.timingSafeEqual(keyBuf, secretBuf)) return res.status(403).send();
  const requiredRole = req.query.role || "official";
  if (!req.user) return res.status(401).send("인증이 필요합니다.");
  if ((ROLE_LEVELS[req.user.role] || 0) < (ROLE_LEVELS[requiredRole] || Infinity)) {
    logger.warn(req, "auth.forward_auth_denied", { required: requiredRole, actual: req.user.role }, req.user.email);
    return res.status(403).send("권한이 없습니다.");
  }
  res.setHeader("X-Forwarded-User", req.user.email);
  res.status(200).send();
});

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   OAuth Rate Limiter
   ============================================ */
const loginLimiter = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginLimiter) {
    if (now > entry.resetAt) loginLimiter.delete(ip);
  }
}, 60000);

function checkLoginRate(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const now = Date.now();
  const entry = loginLimiter.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  loginLimiter.set(ip, entry);
  if (entry.count > 20) {
    logger.warn(req, "auth.rate_limit", { count: entry.count, ip });
    res.redirect("/?login_error=rate_limit");
    return false;
  }
  return true;
}

/* ============================================
   Google OAuth 헬퍼
   ============================================ */
function getRedirectUri(req) {
  if (process.env.PUBLIC_URL) return `${process.env.PUBLIC_URL}/auth/api/callback`;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/auth/api/callback`;
}

/* ============================================
   헬퍼
   ============================================ */
function sanitizeRedirect(url) {
  if (!url || typeof url !== "string") return "/";
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  return "/";
}

/* ============================================
   API 라우트
   ============================================ */

// GET /api/login - Google OAuth 리다이렉트
app.get("/api/login", (req, res) => {
  if (!checkLoginRate(req, res)) return;
  const redirect = sanitizeRedirect(req.query.redirect);
  const redirectUri = getRedirectUri(req);
  const nonce = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "email profile",
    access_type: "online",
    prompt: "select_account",
    state: JSON.stringify({ redirect, nonce }),
  });

  const secure = isSecureConnection(req);
  res.setHeader("Set-Cookie", `fsk_oauth_nonce=${nonce}; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`);
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/callback - OAuth 콜백
app.get("/api/callback", async (req, res) => {
  if (!checkLoginRate(req, res)) return;
  const { code, state } = req.query;

  // Parse state and verify CSRF nonce
  let redirectUrl = "/";
  let stateNonce = null;
  try {
    const parsed = JSON.parse(state);
    redirectUrl = sanitizeRedirect(parsed.redirect);
    stateNonce = parsed.nonce;
  } catch {
    redirectUrl = sanitizeRedirect(state);
  }

  const cookieNonce = req.cookies.fsk_oauth_nonce;
  const nonceMatch = stateNonce && cookieNonce
    && stateNonce.length === cookieNonce.length
    && crypto.timingSafeEqual(Buffer.from(stateNonce), Buffer.from(cookieNonce));
  if (!nonceMatch) {
    logger.warn(req, "auth.nonce_failed", { has_state: !!stateNonce, has_cookie: !!cookieNonce });
    return res.redirect("/?login_error=nonce");
  }

  // Clear nonce cookie helper
  const secureNonce = isSecureConnection(req);
  const clearNonceCookie = `fsk_oauth_nonce=; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=0${secureNonce ? "; Secure" : ""}`;

  if (!code) {
    res.setHeader("Set-Cookie", clearNonceCookie);
    return res.redirect("/?login_error=cancelled");
  }

  try {
    const redirectUri = getRedirectUri(req);

    // Exchange code for access token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      logger.warn(req, "auth.token_failed", { status: tokenRes.status });
      res.setHeader("Set-Cookie", clearNonceCookie);
      return res.redirect("/?login_error=token");
    }

    const tokenData = await tokenRes.json();

    // Get user info
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoRes.ok) {
      logger.warn(req, "auth.userinfo_failed", { status: userInfoRes.status });
      res.setHeader("Set-Cookie", clearNonceCookie);
      return res.redirect("/?login_error=userinfo");
    }

    const userInfo = await userInfoRes.json();
    const email = userInfo.email;
    const name = userInfo.name || email;

    // Check if user is registered and active
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !user.active) {
      const reason = !user ? "unregistered" : "deactivated";
      logger.warn(req, "user.login_failed", { reason }, email, { email, name });
      res.setHeader("Set-Cookie", clearNonceCookie);
      return res.redirect(`/?login_error=${reason}`);
    }

    // Update name from Google profile
    if (name && name !== user.name) {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, user.id);
    }

    // 최초 로그인 시 created_at 기록
    if (!user.created_at) {
      db.prepare("UPDATE users SET created_at = datetime('now') WHERE id = ?").run(user.id);
    }

    // Set JWT cookie
    const jwt = createJWT({ email, name, role: user.role }, process.env.JWT_SECRET);
    const cookieOpts = formatCookieOpts(7 * 24 * 3600, isSecureConnection(req));

    res.setHeader("Set-Cookie", [
      `fsk_session=${jwt}; HttpOnly; ${cookieOpts}`,
      `fsk_user=${encodeURIComponent(JSON.stringify({ name, role: user.role }))}; ${cookieOpts}`,
      clearNonceCookie,
    ]);

    logger.log(req, "user.login", { name, role: user.role }, email, { email, name, role: user.role });

    res.redirect(redirectUrl);
  } catch (e) {
    logger.warn(req, "auth.callback_error", { error: e.message || String(e) });
    console.error("OAuth callback error:", e);
    res.setHeader("Set-Cookie", clearNonceCookie);
    res.redirect("/?login_error=error");
  }
});

// POST /api/logout - 쿠키 삭제
app.post("/api/logout", (req, res) => {
  if (!req.user) return res.status(401).send("인증이 필요합니다.");
  logger.log(req, "user.logout", null, req.user.email);

  const cookieOpts = formatCookieOpts(0, isSecureConnection(req));

  res.setHeader("Set-Cookie", [
    `fsk_session=; HttpOnly; ${cookieOpts}`,
    `fsk_user=; ${cookieOpts}`,
  ]);

  res.status(200).send();
});

// GET /api/users/exists/:email - 사용자 존재 + 활성 여부 (내부 서비스용)
app.get("/api/users/exists/:email", (req, res) => {
  const user = db.prepare("SELECT 1 FROM users WHERE email = ? AND active = 1").get(req.params.email);
  if (!user) return res.status(404).send();
  res.status(200).send();
});

// GET /api/users/role/:email - 사용자 역할 조회 (내부 서비스용, 슬라이딩 갱신)
app.get("/api/users/role/:email", (req, res) => {
  const user = db.prepare("SELECT role FROM users WHERE email = ? AND active = 1").get(req.params.email);
  if (!user) return res.status(404).send();
  res.json({ role: user.role });
});

// GET /api/users - 전체 사용자 목록
app.get("/api/users", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT id, email, name, role, memo, active, created_at FROM users ORDER BY id").all());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result.map((u) => ({ ...u, protected: u.email === ADMIN_EMAIL })));
});

// POST /api/users - 사용자 추가
app.post("/api/users", (req, res) => {
  const { email, role } = req.body;
  if (!email || !email.trim()) return res.status(400).send("이메일을 입력하세요.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).send("올바르지 않은 이메일 형식입니다.");
  if (!VALID_ROLES.includes(role)) return res.status(400).send("올바르지 않은 역할입니다.");

  const result = dbRun(() =>
    db.prepare("INSERT INTO users (email, role) VALUES (?, ?)").run(email.trim().toLowerCase(), role),
  );

  if (!result.success) {
    if (result.error.includes("UNIQUE")) {
      return res.status(400).send("이미 등록된 이메일입니다.");
    }
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "user.create", { role }, email.trim().toLowerCase());
  res.status(201).json({ id: result.result.lastInsertRowid, email: email.trim().toLowerCase(), role });
});

// POST /api/users/bulk - 벌크 사용자 추가
app.post("/api/users/bulk", (req, res) => {
  const { users: rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).send("추가할 사용자 목록이 비어있습니다.");

  const insert = db.prepare("INSERT OR IGNORE INTO users (email, role, memo) VALUES (?, ?, ?)");
  const added = [];
  const skipped = [];
  const errors = [];

  const run = db.transaction(() => {
    for (const row of rows) {
      const email = (row.email || "").trim().toLowerCase();
      if (!email) { errors.push({ row, reason: "이메일 없음" }); continue; }

      const role = VALID_ROLES.includes(row.role) ? row.role : "student";
      if (!VALID_ROLES.includes(row.role)) {
        errors.push({ row, reason: `알 수 없는 역할 "${row.role}", "student"로 설정됨` });
      }
      const memo = (row.memo || "").trim();

      const result = insert.run(email, role, memo);
      if (result.changes > 0) added.push(email);
      else skipped.push(email);
    }
  });

  const txResult = dbRun(() => run());
  if (!txResult.success) return res.status(txResult.status).send(txResult.error);

  logger.log(req, "user.create_bulk", { added, skipped });
  res.json({ added: added.length, skipped: skipped.length, errors });
});

// PATCH /api/users/bulk - 벌크 활성/비활성
app.patch("/api/users/bulk", (req, res) => {
  const { ids, active } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).send("사용자를 선택하세요.");
  if (active === undefined) return res.status(400).send("active 값이 필요합니다.");

  const numIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (numIds.length === 0) return res.status(400).send("유효한 ID가 없습니다.");
  if (numIds.length !== ids.length) return res.status(400).send("일부 ID가 올바르지 않습니다.");

  // ADMIN_EMAIL 보호
  if (ADMIN_EMAIL && !active) {
    const protectedUser = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
    if (protectedUser && numIds.includes(protectedUser.id)) return res.status(400).send("기본 관리자는 비활성화할 수 없습니다.");
  }

  const placeholders = numIds.map(() => "?").join(",");
  const emails = db.prepare(`SELECT email FROM users WHERE id IN (${placeholders})`).all(...numIds).map(r => r.email);
  const stmt = db.prepare(`UPDATE users SET active = ? WHERE id IN (${placeholders})`);
  const run = db.transaction(() => stmt.run(active ? 1 : 0, ...numIds));

  const txResult = dbRun(() => run());
  if (!txResult.success) return res.status(txResult.status).send(txResult.error);

  logger.log(req, "user.bulk_toggle", { emails, active: !!active });
  res.json({ updated: txResult.result.changes });
});

// DELETE /api/users/bulk - 벌크 사용자 삭제
app.delete("/api/users/bulk", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).send("삭제할 사용자를 선택하세요.");

  const numIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (numIds.length === 0) return res.status(400).send("유효한 ID가 없습니다.");
  if (numIds.length !== ids.length) return res.status(400).send("일부 ID가 올바르지 않습니다.");

  // ADMIN_EMAIL 보호
  if (ADMIN_EMAIL) {
    const protectedUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get(ADMIN_EMAIL);
    if (protectedUser && numIds.includes(protectedUser.id)) return res.status(400).send("기본 관리자는 삭제할 수 없습니다.");
  }

  // 마지막 관리자 삭제 방지
  const totalAdmins = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").get().cnt;
  const placeholders = numIds.map(() => "?").join(",");
  const adminsToDelete = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND id IN (${placeholders})`).get(...numIds).cnt;
  if (totalAdmins - adminsToDelete < 1) return res.status(400).send("마지막 관리자는 삭제할 수 없습니다.");

  const emails = db.prepare(`SELECT email FROM users WHERE id IN (${placeholders})`).all(...numIds).map(r => r.email);
  const del = db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`);
  const run = db.transaction(() => del.run(...numIds));

  const txResult = dbRun(() => run());
  if (!txResult.success) return res.status(txResult.status).send(txResult.error);

  logger.log(req, "user.bulk_delete", { emails });
  res.json({ deleted: txResult.result.changes });
});

// PATCH /api/users/:id - 역할/메모/활성 변경
app.patch("/api/users/:id", (req, res) => {
  const id = Number(req.params.id);
  const { role, memo, active } = req.body;

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).send("사용자를 찾을 수 없습니다.");

  // 사전 검증
  if (role !== undefined) {
    if (!VALID_ROLES.includes(role)) return res.status(400).send("올바르지 않은 역할입니다.");
    if (user.email === ADMIN_EMAIL && role !== "admin") return res.status(400).send("기본 관리자의 역할은 변경할 수 없습니다.");
    if (user.role === "admin" && role !== "admin") {
      const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").get().cnt;
      if (adminCount <= 1) return res.status(400).send("마지막 관리자는 강등할 수 없습니다.");
    }
  }

  if (active !== undefined && user.email === ADMIN_EMAIL) {
    return res.status(400).send("기본 관리자는 비활성화할 수 없습니다.");
  }

  // 트랜잭션으로 원자적 업데이트
  const result = dbRun(() => {
    db.transaction(() => {
      if (role !== undefined) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
      if (memo !== undefined) db.prepare("UPDATE users SET memo = ? WHERE id = ?").run(memo, id);
      if (active !== undefined) db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
    })();
  });

  if (!result.success) return res.status(result.status).send(result.error);

  const changes = {};
  if (role !== undefined) changes.role = role;
  if (memo !== undefined) changes.memo = memo;
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
  if (user.email === ADMIN_EMAIL) return res.status(400).send("기본 관리자는 삭제할 수 없습니다.");

  // 마지막 admin 삭제 방지
  if (user.role === "admin") {
    const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").get().cnt;
    if (adminCount <= 1) return res.status(400).send("마지막 관리자는 삭제할 수 없습니다.");
  }

  const result = dbRun(() => db.prepare("DELETE FROM users WHERE id = ?").run(id));
  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "user.delete", { role: user.role, name: user.name }, user.email);
  res.status(200).send();
});

/* ============================================
   운영 오피셜 연락처
   ============================================ */

// GET /api/ops-contacts - 연락처 목록
app.get("/api/ops-contacts", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT id, name, phone FROM ops_contacts ORDER BY id").all());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/ops-contacts - 연락처 추가
app.post("/api/ops-contacts", (req, res) => {
  const { name, phone } = req.body;
  if (!name?.trim()) return res.status(400).send("이름을 입력하세요.");
  if (!phone?.trim()) return res.status(400).send("전화번호를 입력하세요.");

  const result = dbRun(() => db.prepare("INSERT INTO ops_contacts (name, phone) VALUES (?, ?)").run(name.trim(), phone.trim()));
  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "ops_contact.create", { phone: phone.trim() }, name.trim());
  res.status(201).json({ id: result.result.lastInsertRowid, name: name.trim(), phone: phone.trim() });
});

// DELETE /api/ops-contacts/:id - 연락처 삭제
app.delete("/api/ops-contacts/:id", (req, res) => {
  const contact = db.prepare("SELECT name, phone FROM ops_contacts WHERE id = ?").get(Number(req.params.id));
  if (!contact) return res.status(404).send("연락처를 찾을 수 없습니다.");
  const result = dbRun(() => db.prepare("DELETE FROM ops_contacts WHERE id = ?").run(Number(req.params.id)));
  if (!result.success) return res.status(result.status).send(result.error);
  logger.log(req, "ops_contact.delete", { phone: contact.phone }, contact.name);
  res.status(200).send();
});

/* ============================================
   로그 집계 API
   ============================================ */
const LOG_SERVICES = (() => {
  const env = process.env.LOG_SERVICES || "";
  const map = {};
  for (const part of env.split(",").filter(Boolean)) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const url = part.slice(idx + 1).trim();
    if (name && url) map[name] = url;
  }
  return map;
})();

// GET /api/admin/logs - 전체 서비스 로그 집계
app.get("/api/admin/logs", async (req, res) => {
  const { service, limit: qLimit, offset: qOffset, ...filters } = req.query;
  const limit = Math.min(Number(qLimit) || 100, 500);
  const offset = Number(qOffset) || 0;

  // Build query string for forwarding
  const qs = new URLSearchParams();
  const fetchLimit = Math.min(offset + limit + 100, 2000);
  qs.set("limit", String(fetchLimit));
  for (const [k, v] of Object.entries(filters)) {
    if (v) qs.set(k, v);
  }

  const results = [];

  // Determine which services to query
  const targetServices = service
    ? (service === "auth" ? { auth: null } : { [service]: LOG_SERVICES[service] })
    : { auth: null, ...LOG_SERVICES };

  const fetches = Object.entries(targetServices).map(async ([name, url]) => {
    if (name === "auth") {
      // Local query (no HTTP)
      try {
        const conditions = [];
        const params = [];
        if (filters.level) { conditions.push("level = ?"); params.push(filters.level); }
        if (filters.action) { conditions.push("action LIKE ?"); params.push(filters.action + "%"); }
        if (filters.actor) { conditions.push("(actor_email LIKE ? OR actor_name LIKE ?)"); params.push(`%${filters.actor}%`, `%${filters.actor}%`); }
        if (filters.from) { conditions.push("timestamp >= ?"); params.push(filters.from); }
        if (filters.to) { conditions.push("timestamp <= ?"); params.push(filters.to); }
        if (filters.search) { conditions.push("(action LIKE ? OR target LIKE ? OR detail LIKE ?)"); params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`); }
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const total = db.prepare(`SELECT COUNT(*) as cnt FROM logs ${where}`).get(...params).cnt;
        const logs = db.prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT 500`).all(...params);
        return { name, logs: logs.map(l => ({ ...l, _service: name })), total };
      } catch { return { name, logs: [], total: 0 }; }
    }

    try {
      const fetchRes = await fetch(`${url}/api/logs?${qs}`, {
        headers: { "X-Internal-Service": process.env.INTERNAL_SECRET || "" },
        signal: AbortSignal.timeout(5000),
      });
      if (!fetchRes.ok) return { name, logs: [], total: 0 };
      const data = await fetchRes.json();
      return { name, logs: (data.logs || []).map(l => ({ ...l, _service: name })), total: data.total || 0 };
    } catch {
      return { name, logs: [], total: 0 };
    }
  });

  const allResults = await Promise.all(fetches);

  // Merge all logs by timestamp descending
  let merged = [];
  let totalSum = 0;
  for (const r of allResults) {
    merged.push(...r.logs);
    totalSum += r.total;
  }
  merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Apply offset/limit on merged result
  const paged = merged.slice(offset, offset + limit);

  res.json({ logs: paged, total: totalSum, services: Object.keys(targetServices) });
});

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createAuthApp();
  setupProcessHandlers(db);
  app.listen(9100);
}
