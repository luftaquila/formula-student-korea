import crypto from "crypto";
import express from "express";
import pinoHttp from "pino-http";
import Database from "better-sqlite3";
import { createApp, setupProcessHandlers, createDbRun, createJWT, ensureDataDir, VALID_ROLES } from "../shared/express-setup.mjs";

/* ============================================
   Database 초기화
   ============================================ */
ensureDataDir();

const db = new Database("./data/auth.db");
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'official')),
  memo TEXT DEFAULT '',
  created_at TEXT
)`);

// 마이그레이션: memo 컬럼 추가
try { db.exec("ALTER TABLE users ADD COLUMN memo TEXT DEFAULT ''"); }
catch { /* already exists */ }

// 마이그레이션: active 컬럼 추가
try { db.exec("ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1"); }
catch { /* already exists */ }

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

setupProcessHandlers(db);

/* ============================================
   Express 앱 설정
   ============================================ */
const validateUser = (email) => !!db.prepare("SELECT 1 FROM users WHERE email = ? AND active = 1").get(email);

const app = createApp("auth.log", { express, pinoHttp, validateUser }, (req) => {
  if (["/api/login", "/api/callback", "/api/logout"].includes(req.path)) return null;
  if (req.path.startsWith("/api/users")) return "admin";
  if (req.path.startsWith("/api/ops-contacts") && req.method !== "GET") return "admin";
  return null; // SPA
});

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   Google OAuth 헬퍼
   ============================================ */
function getRedirectUri(req) {
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

  const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
  res.setHeader("Set-Cookie", `fsk_oauth_nonce=${nonce}; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=600${isSecure ? "; Secure" : ""}`);
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/callback - OAuth 콜백
app.get("/api/callback", async (req, res) => {
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
    return res.redirect(`/auth/login?error=csrf_failed&redirect=${encodeURIComponent(redirectUrl)}`);
  }

  // Clear nonce cookie helper
  const isSecureNonce = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
  const clearNonceCookie = `fsk_oauth_nonce=; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=0${isSecureNonce ? "; Secure" : ""}`;

  if (!code) {
    res.setHeader("Set-Cookie", clearNonceCookie);
    return res.redirect(`/auth/login?error=no_code&redirect=${encodeURIComponent(redirectUrl)}`);
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
      return res.redirect(`/auth/login?error=token_failed&redirect=${encodeURIComponent(redirectUrl)}`);
    }

    const tokenData = await tokenRes.json();

    // Get user info
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoRes.ok) {
      return res.redirect(`/auth/login?error=userinfo_failed&redirect=${encodeURIComponent(redirectUrl)}`);
    }

    const userInfo = await userInfoRes.json();
    const email = userInfo.email;
    const name = userInfo.name || email;

    // Check if user is registered and active
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !user.active) {
      return res.redirect(`/auth/login?error=access_denied&redirect=${encodeURIComponent(redirectUrl)}`);
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
    const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    const cookieOpts = `Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}${isSecure ? "; Secure" : ""}`;

    res.setHeader("Set-Cookie", [
      `fsk_session=${jwt}; HttpOnly; ${cookieOpts}`,
      `fsk_user=${encodeURIComponent(JSON.stringify({ name, role: user.role }))}; ${cookieOpts}`,
      clearNonceCookie,
    ]);

    res.redirect(redirectUrl);
  } catch (e) {
    console.error("OAuth callback error:", e);
    res.redirect(`/auth/login?error=server_error&redirect=${encodeURIComponent(redirectUrl)}`);
  }
});

// POST /api/logout - 쿠키 삭제
app.post("/api/logout", (req, res) => {
  const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
  const cookieOpts = `Path=/; SameSite=Lax; Max-Age=0${isSecure ? "; Secure" : ""}`;

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

      const role = VALID_ROLES.includes(row.role) ? row.role : "official";
      const memo = (row.memo || "").trim();

      const result = insert.run(email, role, memo);
      if (result.changes > 0) added.push(email);
      else skipped.push(email);
    }
  });

  const txResult = dbRun(() => run());
  if (!txResult.success) return res.status(txResult.status).send(txResult.error);

  res.json({ added: added.length, skipped: skipped.length, errors });
});

// PATCH /api/users/bulk - 벌크 활성/비활성
app.patch("/api/users/bulk", (req, res) => {
  const { ids, active } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).send("사용자를 선택하세요.");
  if (active === undefined) return res.status(400).send("active 값이 필요합니다.");

  // ADMIN_EMAIL 보호
  if (ADMIN_EMAIL && !active) {
    const protectedUser = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
    if (protectedUser && ids.includes(protectedUser.id)) return res.status(400).send("기본 관리자는 비활성화할 수 없습니다.");
  }

  const placeholders = ids.map(() => "?").join(",");
  const stmt = db.prepare(`UPDATE users SET active = ? WHERE id IN (${placeholders})`);
  const run = db.transaction(() => stmt.run(active ? 1 : 0, ...ids));

  const txResult = dbRun(() => run());
  if (!txResult.success) return res.status(txResult.status).send(txResult.error);

  res.json({ updated: txResult.result.changes });
});

// DELETE /api/users/bulk - 벌크 사용자 삭제
app.delete("/api/users/bulk", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).send("삭제할 사용자를 선택하세요.");

  // ADMIN_EMAIL 보호
  if (ADMIN_EMAIL) {
    const protectedUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get(ADMIN_EMAIL);
    if (protectedUser && ids.includes(protectedUser.id)) return res.status(400).send("기본 관리자는 삭제할 수 없습니다.");
  }

  // 마지막 관리자 삭제 방지
  const totalAdmins = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").get().cnt;
  const placeholders = ids.map(() => "?").join(",");
  const adminsToDelete = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND id IN (${placeholders})`).get(...ids).cnt;
  if (totalAdmins - adminsToDelete < 1) return res.status(400).send("마지막 관리자는 삭제할 수 없습니다.");

  const del = db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`);
  const run = db.transaction(() => del.run(...ids));

  const txResult = dbRun(() => run());
  if (!txResult.success) return res.status(txResult.status).send(txResult.error);

  res.json({ deleted: txResult.result.changes });
});

// PATCH /api/users/:id - 역할/메모/활성 변경
app.patch("/api/users/:id", (req, res) => {
  const id = Number(req.params.id);
  const { role, memo, active } = req.body;

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).send("사용자를 찾을 수 없습니다.");

  // 역할 변경
  if (role !== undefined) {
    if (!VALID_ROLES.includes(role)) return res.status(400).send("올바르지 않은 역할입니다.");

    // ADMIN_EMAIL 보호
    if (user.email === ADMIN_EMAIL && role !== "admin") return res.status(400).send("기본 관리자의 역할은 변경할 수 없습니다.");

    // 마지막 admin 강등 방지
    if (user.role === "admin" && role !== "admin") {
      const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").get().cnt;
      if (adminCount <= 1) return res.status(400).send("마지막 관리자는 강등할 수 없습니다.");
    }

    const result = dbRun(() => db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id));
    if (!result.success) return res.status(result.status).send(result.error);
  }

  // 메모 변경
  if (memo !== undefined) {
    const result = dbRun(() => db.prepare("UPDATE users SET memo = ? WHERE id = ?").run(memo, id));
    if (!result.success) return res.status(result.status).send(result.error);
  }

  // 활성/비활성 변경
  if (active !== undefined) {
    if (user.email === ADMIN_EMAIL) return res.status(400).send("기본 관리자는 비활성화할 수 없습니다.");
    const result = dbRun(() => db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id));
    if (!result.success) return res.status(result.status).send(result.error);
  }

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
  res.status(201).json({ id: result.result.lastInsertRowid, name: name.trim(), phone: phone.trim() });
});

// DELETE /api/ops-contacts/:id - 연락처 삭제
app.delete("/api/ops-contacts/:id", (req, res) => {
  const result = dbRun(() => db.prepare("DELETE FROM ops_contacts WHERE id = ?").run(Number(req.params.id)));
  if (!result.success) return res.status(result.status).send(result.error);
  res.status(200).send();
});

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

/* ============================================
   서버 시작
   ============================================ */
app.listen(9800);
