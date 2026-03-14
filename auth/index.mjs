import express from "express";
import pinoHttp from "pino-http";
import Database from "better-sqlite3";
import { createApp, setupProcessHandlers, createDbRun, createJWT, ensureDataDir } from "../shared/express-setup.mjs";

/* ============================================
   Database 초기화
   ============================================ */
ensureDataDir();

const db = new Database("./data/auth.db");

db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'official')),
  memo TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
)`);

// 마이그레이션: memo 컬럼 추가
try { db.exec("ALTER TABLE users ADD COLUMN memo TEXT DEFAULT ''"); }
catch { /* already exists */ }

// Bootstrap: ADMIN_EMAIL이 DB에 없으면 admin으로 등록
if (process.env.ADMIN_EMAIL) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(process.env.ADMIN_EMAIL);
  if (!existing) {
    db.prepare("INSERT INTO users (email, role) VALUES (?, 'admin')").run(process.env.ADMIN_EMAIL);
  }
}

setupProcessHandlers(db);

/* ============================================
   Express 앱 설정
   ============================================ */
const app = createApp("auth.log", { express, pinoHttp }, (req) => {
  if (["/api/login", "/api/callback", "/api/logout"].includes(req.path)) return null;
  if (req.path === "/api/me") return "official";
  if (req.path.startsWith("/api/users")) return "admin";
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

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "email profile",
    access_type: "online",
    prompt: "select_account",
    state: redirect,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/callback - OAuth 콜백
app.get("/api/callback", async (req, res) => {
  const { code, state } = req.query;
  const redirectUrl = sanitizeRedirect(state);

  if (!code) {
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

    // Check if user is registered
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      return res.redirect(`/auth/login?error=not_registered&redirect=${encodeURIComponent(redirectUrl)}`);
    }

    // Update name from Google profile
    if (name && name !== user.name) {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, user.id);
    }

    // Set JWT cookie
    const jwt = createJWT({ email, name, role: user.role }, process.env.JWT_SECRET);
    const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    const cookieOpts = `Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}${isSecure ? "; Secure" : ""}`;

    res.setHeader("Set-Cookie", [
      `fsk_session=${jwt}; HttpOnly; ${cookieOpts}`,
      `fsk_user=${encodeURIComponent(JSON.stringify({ name, role: user.role }))}; ${cookieOpts}`,
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

// GET /api/me - 현재 로그인 사용자 정보
app.get("/api/me", (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, role: req.user.role });
});

// GET /api/users - 전체 사용자 목록
app.get("/api/users", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT id, email, name, role, memo, created_at FROM users ORDER BY id").all());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/users - 사용자 추가
app.post("/api/users", (req, res) => {
  const { email, role } = req.body;
  if (!email || !email.trim()) return res.status(400).send("이메일을 입력하세요.");
  if (!["admin", "official"].includes(role)) return res.status(400).send("올바르지 않은 역할입니다.");

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

// PATCH /api/users/:id - 역할/메모 변경
app.patch("/api/users/:id", (req, res) => {
  const id = Number(req.params.id);
  const { role, memo } = req.body;

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).send("사용자를 찾을 수 없습니다.");

  // 역할 변경
  if (role !== undefined) {
    if (!["admin", "official"].includes(role)) return res.status(400).send("올바르지 않은 역할입니다.");

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

  res.status(200).send();
});

// DELETE /api/users/:id - 사용자 삭제
app.delete("/api/users/:id", (req, res) => {
  const id = Number(req.params.id);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).send("사용자를 찾을 수 없습니다.");

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
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

/* ============================================
   서버 시작
   ============================================ */
app.listen(9800);
