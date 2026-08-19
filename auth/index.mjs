import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase, addColumn, runMigrationOnce, normalizeTimestampColumn } from "../shared/db-setup.mjs";
import { createApp, createDbRun, createJWT, verifyJWT, VALID_ROLES, isSecureConnection, formatCookieOpts, createSecretChecker, isEnvEnabled } from "../shared/express-setup.mjs";
import { ROLE_LEVELS } from "../shared/constants.js";
import { createLogger, buildLogFilter, parseLogCursor } from "../shared/logger.mjs";
import { serviceUrl, logAggregationTargets } from "../shared/services.mjs";
import { runIfDirect } from "../shared/service-bootstrap.mjs";

export function createAuthApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/auth.db");

db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'official')),
  memo TEXT DEFAULT '',
  realname TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  created_at TEXT
)`);

// 마이그레이션: memo 컬럼 추가
addColumn(db, "users", "memo TEXT DEFAULT ''");

// 마이그레이션: active 컬럼 추가
addColumn(db, "users", "active INTEGER DEFAULT 1");

// 마이그레이션: realname, phone 컬럼 추가 (memo → realname 전환)
addColumn(db, "users", "realname TEXT DEFAULT ''");
addColumn(db, "users", "phone TEXT DEFAULT ''");
db.exec("UPDATE users SET realname = memo WHERE (realname IS NULL OR realname = '') AND memo IS NOT NULL AND memo != ''");

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
        realname TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        created_at TEXT,
        active INTEGER DEFAULT 1
      );
      INSERT INTO users_new (id, email, name, role, memo, realname, phone, created_at, active) SELECT id, email, name, role, memo, realname, phone, created_at, active FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  })();
}

// 마이그레이션: affiliation(학교/팀) 컬럼 추가 (realname/phone과 동일하게 optional)
// users_new 재빌드(위)는 1회성이라 affiliation을 포함하지 않으므로 idempotent한 addColumn으로 보강
addColumn(db, "users", "affiliation TEXT DEFAULT ''");

// 관리자 토글 등 key/value 설정 저장소
db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);
// 계정 신청 접수 기본값: 닫힘
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('applications_open', '0')").run();

// 계정 신청 (승인 시 users로 이동 후 삭제). email UNIQUE로 1인 1신청 보장
db.exec(`CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  realname TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  affiliation TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);

// Preserve legacy free-form contacts instead of dropping production data.
// The new sidebar model uses ops_display(user_id), so old rows cannot be
// losslessly mapped without an explicit admin decision.
{
  const legacyOpsContacts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_contacts'").get();
  const preservedOpsContacts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_contacts_legacy'").get();
  if (legacyOpsContacts && !preservedOpsContacts) {
    db.exec("ALTER TABLE ops_contacts RENAME TO ops_contacts_legacy");
  }
}

db.exec(`CREATE TABLE IF NOT EXISTS ops_display (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
)`);
addColumn(db, "ops_display", "description TEXT NOT NULL DEFAULT ''");
addColumn(db, "ops_display", "sort_order INTEGER NOT NULL DEFAULT 0");
runMigrationOnce(db, "auth.ops_contact_sort_order.v1", () => {
  const rows = db.prepare("SELECT user_id FROM ops_display ORDER BY user_id").all();
  const update = db.prepare("UPDATE ops_display SET sort_order = ? WHERE user_id = ?");
  for (const [index, row] of rows.entries()) update.run(index, row.user_id);
});
db.exec("DELETE FROM ops_display WHERE user_id NOT IN (SELECT id FROM users)");
db.pragma("foreign_keys = ON");

runMigrationOnce(db, "auth.utc_timestamp_normalization.v1", () => {
  for (const [table, column] of [
    ["users", "created_at"],
    ["applications", "created_at"],
    ["applications", "updated_at"],
  ]) {
    normalizeTimestampColumn(db, table, column);
  }
});

// Bootstrap: ADMIN_EMAIL이 DB에 없으면 admin으로 등록
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
if (ADMIN_EMAIL) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
  if (!existing) {
    db.prepare("INSERT INTO users (email, role) VALUES (?, 'admin')").run(ADMIN_EMAIL);
  }
}

if (isEnvEnabled(process.env.TEST_SERVER)) {
  console.warn("[WARNING] TEST_SERVER mode enabled — all Google logins will be auto-registered as admin");
}

/* ============================================
   Express 앱 설정
   ============================================ */
const validateUser = (email) => {
  const user = db.prepare("SELECT role FROM users WHERE email = ? AND active = 1").get(email);
  return user ? { valid: true, role: user.role } : { valid: false, role: null };
};

const logger = createLogger(db, "auth");

// 로그 집계 실패 폭주 방지: action+service별 최소 60초 간격 throttle
const _aggWarn = new Map();
function warnAggThrottled(action, detail, target) {
  const t = Date.now();
  const k = action + "|" + (target || "");
  const last = _aggWarn.get(k) || 0;
  if (t - last < 60000) return;
  _aggWarn.set(k, t);
  logger.warn(null, action, detail, target);
}

const EMAIL_SERVER = serviceUrl("email");

async function notifyNewUser(emails) {
  if (!process.env.INTERNAL_SECRET) return;
  try {
    const list = Array.isArray(emails) ? emails : [emails];
    const url = process.env.PUBLIC_URL || "https://fsk.luftaquila.io";
    await fetch(`${EMAIL_SERVER}/api/internal/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service": process.env.INTERNAL_SECRET,
      },
      body: JSON.stringify({
        subject: "[FSK] 계정 등록 완료",
        htmlContent:
          `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea Service Hub 계정이 등록되었습니다.</h2>` +
          `<p style="margin:0;font-size:14px;line-height:1.6">Google 계정으로 <a href="${url}">FSK Service Hub</a>에 로그인하여 서비스를 이용하세요.</p>`,
        recipients: list,
        source: "auth",
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    logger.warn(null, "email.notify", { error: e.message, emails });
  }
}

// validateUserCacheTtl: 0 — auth의 검증기는 로컬 인덱스 SELECT라 캐시가 무익하고,
// auth 자신의 사용자 관리 UI는 역할 변경이 즉시 반영되어야 한다.
const app = createApp({ express, validateUser, validateUserCacheTtl: 0 }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path === "/api/forward-auth") return null;
  if (req.path === "/api/session") return null;
  if (["/api/login", "/api/callback", "/api/logout"].includes(req.path)) return null;
  if (req.path.startsWith("/api/admin")) return "admin";
  if (req.path.startsWith("/api/users")) return "admin";
  if (req.path.startsWith("/api/ops-contacts") && req.method !== "GET") return "admin";
  if (req.path.startsWith("/api/ops-contacts")) return "official";
  if (req.path === "/api/logs") return "admin";
  if (req.path.startsWith("/api/applications")) return "admin"; // 신청 관리: 관리자 전용
  if (req.path === "/api/apply/config") return null;            // 신청 가능 여부: 공개
  if (req.path.startsWith("/api/apply")) return null;           // 신청자 API: 공개(핸들러가 fsk_applicant 검증)
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
const isForwardAuthKey = createSecretChecker(process.env.INTERNAL_SECRET);
app.get("/api/forward-auth", (req, res) => {
  const key = req.headers["x-forward-auth-key"];
  if (!key || !process.env.INTERNAL_SECRET) {
    logger.warn(req, "auth.forward_auth_denied", { reason: "missing_key_or_secret" });
    return res.status(403).send();
  }
  if (!isForwardAuthKey(key)) {
    logger.warn(req, "auth.forward_auth_denied", { reason: "key_mismatch" });
    return res.status(403).send();
  }
  const requiredRole = req.query.role || "official";
  if (!req.user) {
    logger.warn(req, "auth.forward_auth_denied", { reason: "no_user" });
    return res.status(401).send("인증이 필요합니다.");
  }
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
   계정 신청 헬퍼
   ============================================ */
// 신청 접수가 열려 있는지
const isApplicationsOpen = () =>
  db.prepare("SELECT value FROM settings WHERE key = 'applications_open'").get()?.value === "1";

// fsk_applicant 쿠키에서 구글 인증된 신청자 신원을 검증해 반환 (없거나 무효면 null).
// role이 없는 별도 토큰이므로 어떤 admin/user API도 통과하지 못한다.
function getApplicant(req) {
  const token = req.cookies.fsk_applicant;
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const p = verifyJWT(token, process.env.JWT_SECRET);
    if (!p.applicant || !p.email) return null;
    return { email: p.email, name: p.name };
  } catch {
    return null;
  }
}

/* ============================================
   OAuth Rate Limiter
   ============================================ */
const loginLimiter = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginLimiter) {
    if (now > entry.resetAt) loginLimiter.delete(ip);
  }
}, 60000).unref();

function checkLoginRate(req, res) {
  // Caddy가 세팅한 신뢰 X-Real-IP 우선(위조 불가), 없으면 X-Forwarded-For 최좌측 → req.ip 폴백.
  const ip = req.headers["x-real-ip"]?.trim() || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
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
  // same-origin 절대 경로만 허용한다. 브라우저는 Location 헤더의 백슬래시를 슬래시로
  // 정규화하므로 "/\\evil.com"은 protocol-relative URL이 되어 외부 오픈 리다이렉트가
  // 된다. 선두가 "/" 다음에 "/" 또는 "\\"가 오는 경우와, 개행·탭 등 제어문자(헤더 조작·
  // 정규화 트릭)를 모두 거부한다.
  if (url[0] !== "/") return "/";
  if (url[1] === "/" || url[1] === "\\") return "/";
  if (/[\u0000-\u001f]/.test(url)) return "/";
  return url;
}

function isApplyRedirect(url) {
  const path = String(url || "").split(/[?#]/)[0];
  return path === "/auth/apply" || path === "/apply";
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
  const secure = isSecureConnection(req);
  const clearNonceCookie = `fsk_oauth_nonce=; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  const clearCookieOpts = formatCookieOpts(0, secure);
  const clearSessionCookie = `fsk_session=; HttpOnly; ${clearCookieOpts}`;
  const clearUserCookie = `fsk_user=; ${clearCookieOpts}`;
  const clearApplicantCookie = `fsk_applicant=; HttpOnly; ${clearCookieOpts}`;

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
      signal: AbortSignal.timeout(5000),
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
      signal: AbortSignal.timeout(5000),
    });

    if (!userInfoRes.ok) {
      logger.warn(req, "auth.userinfo_failed", { status: userInfoRes.status });
      res.setHeader("Set-Cookie", clearNonceCookie);
      return res.redirect("/?login_error=userinfo");
    }

    const userInfo = await userInfoRes.json();
    const email = userInfo.email;
    const name = userInfo.name || email;

    // Google가 이메일 소유를 검증하지 못한 계정은 거부한다(이메일이 계정 primary key이므로
    // 미검증 이메일 클레임 방어). verified_email이 명시적 false일 때만 차단해, 필드가 없는
    // 정상 계정의 로그인은 막지 않는다.
    if (userInfo.verified_email === false) {
      logger.warn(req, "auth.email_unverified", {}, email, { email, name });
      res.setHeader("Set-Cookie", clearNonceCookie);
      return res.redirect("/?login_error=unverified");
    }

    // Check if user is registered and active
    let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    // TEST_SERVER 모드: 미등록 사용자 자동 admin 등록
    if (!user && isEnvEnabled(process.env.TEST_SERVER)) {
      db.prepare("INSERT INTO users (email, name, role, active, created_at) VALUES (?, ?, 'admin', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(email, name);
      user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
      logger.log(req, "user.auto_register", { name, role: "admin", test_server: true }, email, { email, name });
    }

    if (!user || !user.active) {
      // 비활성 계정: 항상 거부
      if (user && !user.active) {
        logger.warn(req, "user.login_failed", { reason: "deactivated" }, email, { email, name });
        res.setHeader("Set-Cookie", [clearNonceCookie, clearSessionCookie, clearUserCookie, clearApplicantCookie]);
        return res.redirect("/?login_error=deactivated");
      }
      // 미등록 계정: 신청 페이지에서 시작한 로그인만 신청 흐름으로 허용한다.
      // 일반 사이드바 로그인은 신청 링크 우회가 되지 않도록 기존처럼 거부한다.
      if (isApplicationsOpen() && isApplyRedirect(redirectUrl)) {
        const applicantJwt = createJWT({ email, name, applicant: true }, process.env.JWT_SECRET, 3600);
        const applicantOpts = formatCookieOpts(3600, isSecureConnection(req));
        res.setHeader("Set-Cookie", [
          `fsk_applicant=${applicantJwt}; HttpOnly; ${applicantOpts}`,
          clearNonceCookie,
          clearSessionCookie,
          clearUserCookie,
        ]);
        logger.log(req, "applicant.login", { name }, email, { email, name });
        // 브라우저는 Caddy의 /auth prefix 스트립을 모르므로 전체 경로로 리다이렉트
        return res.redirect("/auth/apply");
      }
      logger.warn(req, "user.login_failed", { reason: "unregistered" }, email, { email, name });
      res.setHeader("Set-Cookie", [clearNonceCookie, clearSessionCookie, clearUserCookie, clearApplicantCookie]);
      return res.redirect("/?login_error=unregistered");
    }

    // Update name from Google profile (best-effort: a sync failure must not block login)
    if (name && name !== user.name) {
      const r = dbRun(() => db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, user.id));
      if (!r.success) logger.warn(req, "user.name_sync", { error: r.error }, email, { email, name, role: user.role });
    }

    // 최초 로그인 시 created_at 기록
    if (!user.created_at) {
      const r = dbRun(() => db.prepare("UPDATE users SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(user.id));
      if (!r.success) logger.warn(req, "user.created_at_init", { error: r.error }, email, { email, name, role: user.role });
    }

    // Set JWT cookie
    const jwt = createJWT({ email, name, role: user.role }, process.env.JWT_SECRET);
    const cookieOpts = formatCookieOpts(7 * 24 * 3600, isSecureConnection(req));

    res.setHeader("Set-Cookie", [
      `fsk_session=${jwt}; HttpOnly; ${cookieOpts}`,
      `fsk_user=${encodeURIComponent(JSON.stringify({ name, role: user.role }))}; ${cookieOpts}`,
      clearNonceCookie,
      clearApplicantCookie,
    ]);

    logger.log(req, "user.login", { name, role: user.role }, email, { email, name, role: user.role });

    res.redirect(redirectUrl);
  } catch (e) {
    logger.warn(req, "auth.callback_error", { error: e.message || String(e) });
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
  const application = db.prepare(
    "SELECT realname, phone, affiliation, created_at, updated_at FROM applications WHERE email = ?",
  ).get(applicant.email) || null;
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
  if (!isApplicationsOpen()) return res.status(403).send("현재 신청이 마감되었습니다.");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(applicant.email)) {
    return res.status(409).send("이미 등록된 계정입니다.");
  }

  const realname = (req.body.realname || "").trim();
  const phone = (req.body.phone || "").trim();
  const affiliation = (req.body.affiliation || "").trim();
  if (!realname || !phone || !affiliation) {
    return res.status(400).send("실명, 전화번호, 학교/팀을 모두 입력하세요.");
  }

  const result = dbRun(() => db.prepare(
    "INSERT INTO applications (email, name, realname, phone, affiliation) VALUES (?, ?, ?, ?, ?)",
  ).run(applicant.email, applicant.name, realname, phone, affiliation));

  if (!result.success) {
    if (result.error.includes("UNIQUE")) {
      logger.warn(req, "applicant.apply", { error: "duplicate" }, applicant.email);
      return res.status(409).send("이미 신청서를 제출했습니다.");
    }
    logger.warn(req, "applicant.apply", { error: result.error }, applicant.email);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "applicant.apply", { realname, affiliation }, applicant.email, { email: applicant.email, name: applicant.name });
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

  const result = dbRun(() => db.prepare(
    "UPDATE applications SET realname = ?, phone = ?, affiliation = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email = ?",
  ).run(realname, phone, affiliation, applicant.email));

  if (!result.success) {
    logger.warn(req, "applicant.apply_edit", { error: result.error }, applicant.email);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "applicant.apply_edit", { realname, affiliation }, applicant.email, { email: applicant.email, name: applicant.name });
  res.status(200).send();
});

/* ============================================
   계정 신청 관리 (관리자)
   ============================================ */

// GET /api/applications - 대기 중인 신청 목록
app.get("/api/applications", (req, res) => {
  const result = dbRun(() => db.prepare(
    "SELECT id, email, name, realname, phone, affiliation, created_at, updated_at FROM applications ORDER BY id",
  ).all());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// PATCH /api/applications/config - 신청 접수 on/off
app.patch("/api/applications/config", (req, res) => {
  const { open } = req.body;
  if (typeof open !== "boolean") return res.status(400).send("open(boolean) 값이 필요합니다.");
  const result = dbRun(() => db.prepare(
    "INSERT INTO settings (key, value) VALUES ('applications_open', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(open ? "1" : "0"));
  if (!result.success) {
    logger.warn(req, "applications.config", { error: result.error });
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
  const txResult = dbRun(() => db.transaction(() => {
    const apps = db.prepare(
      `SELECT id, email, realname, phone, affiliation FROM applications WHERE id IN (${placeholders})`,
    ).all(...numIds);
    const added = [];
    const skipped = [];
    for (const a of apps) {
      const email = a.email.trim().toLowerCase();
      const r = insertUser.run(email, role, a.realname || "", a.phone || "", a.affiliation || "");
      if (r.changes > 0) added.push(email);
      else skipped.push(email);
    }
    db.prepare(`DELETE FROM applications WHERE id IN (${placeholders})`).run(...numIds);
    return { added, skipped };
  })());

  if (!txResult.success) {
    logger.warn(req, "applications.approve", { error: txResult.error });
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
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).send("삭제할 신청을 선택하세요.");

  const numIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (numIds.length === 0) return res.status(400).send("유효한 ID가 없습니다.");
  if (numIds.length !== ids.length) return res.status(400).send("일부 ID가 올바르지 않습니다.");

  const placeholders = numIds.map(() => "?").join(",");
  const txResult = dbRun(() => db.transaction(() => {
    const emails = db.prepare(`SELECT email FROM applications WHERE id IN (${placeholders})`).all(...numIds).map((r) => r.email);
    const del = db.prepare(`DELETE FROM applications WHERE id IN (${placeholders})`).run(...numIds);
    return { changes: del.changes, emails };
  })());

  if (!txResult.success) {
    logger.warn(req, "applications.delete", { error: txResult.error, ids: numIds });
    return res.status(txResult.status).send(txResult.error);
  }

  logger.log(req, "applications.delete", { emails: txResult.result.emails });
  res.json({ deleted: txResult.result.changes });
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
  const result = dbRun(() => db.prepare("SELECT id, email, name, role, realname, phone, affiliation, active, created_at FROM users ORDER BY id").all());
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
      logger.warn(req, "user.create", { error: "duplicate" }, email.trim().toLowerCase());
      return res.status(400).send("이미 등록된 이메일입니다.");
    }
    logger.warn(req, "user.create", { error: result.error }, email.trim().toLowerCase());
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "user.create", { role }, email.trim().toLowerCase());
  notifyNewUser(email.trim().toLowerCase());
  res.status(201).json({ id: result.result.lastInsertRowid, email: email.trim().toLowerCase(), role });
});

// POST /api/users/bulk - 벌크 사용자 추가
app.post("/api/users/bulk", (req, res) => {
  const { users: rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).send("추가할 사용자 목록이 비어있습니다.");

  const insert = db.prepare("INSERT OR IGNORE INTO users (email, role, realname, phone, affiliation) VALUES (?, ?, ?, ?, ?)");
  const added = [];
  const skipped = [];
  const errors = [];

  const run = db.transaction(() => {
    for (const row of rows) {
      const email = (row.email || "").trim().toLowerCase();
      if (!email) { errors.push({ row, reason: "이메일 없음" }); continue; }
      // 단건 추가(POST /api/users)와 동일한 형식 검증 — 벌크만 우회해 잘못된 주소가
      // 저장되면 이후 이메일 발송·로그인 매칭이 조용히 실패한다.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push({ row, reason: "올바르지 않은 이메일 형식" }); continue; }

      const role = VALID_ROLES.includes(row.role) ? row.role : "student";
      if (!VALID_ROLES.includes(row.role)) {
        errors.push({ row, reason: `알 수 없는 역할 "${row.role}", "student"로 설정됨` });
      }
      const realname = (row.realname || "").trim();
      const phone = (row.phone || "").trim();
      const affiliation = (row.affiliation || "").trim();

      const result = insert.run(email, role, realname, phone, affiliation);
      if (result.changes > 0) added.push(email);
      else skipped.push(email);
    }
  });

  const txResult = dbRun(() => run());
  if (!txResult.success) {
    logger.warn(req, "user.create_bulk", { error: txResult.error });
    return res.status(txResult.status).send(txResult.error);
  }

  logger.log(req, "user.create_bulk", { added, skipped });
  if (added.length > 0) notifyNewUser(added);
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
    if (protectedUser && numIds.includes(protectedUser.id)) {
      logger.warn(req, "user.bulk_toggle", { reason: "protected_admin", id: protectedUser.id });
      return res.status(400).send("기본 관리자는 비활성화할 수 없습니다.");
    }
  }

  // 마지막 활성 관리자 잠금 방지: 비활성화 대상이 현재 활성 admin 전부를 포함하면 거부.
  // (삭제·강등엔 이미 가드가 있으나 비활성화 경로엔 없었다. active=0 admin은 로그인·검증이
  // 불가하므로 활성 admin 기준으로 센다.)
  if (!active) {
    const activeAdminIds = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all().map(r => r.id);
    if (activeAdminIds.length > 0 && activeAdminIds.every(aid => numIds.includes(aid))) {
      logger.warn(req, "user.bulk_toggle", { reason: "last_admin_deactivate" });
      return res.status(400).send("마지막 활성 관리자는 비활성화할 수 없습니다.");
    }
  }

  const placeholders = numIds.map(() => "?").join(",");
  const emails = db.prepare(`SELECT email FROM users WHERE id IN (${placeholders})`).all(...numIds).map(r => r.email);
  const stmt = db.prepare(`UPDATE users SET active = ? WHERE id IN (${placeholders})`);
  const run = db.transaction(() => stmt.run(active ? 1 : 0, ...numIds));

  const txResult = dbRun(() => run());
  if (!txResult.success) {
    logger.warn(req, "user.bulk_toggle", { error: txResult.error });
    return res.status(txResult.status).send(txResult.error);
  }

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
    if (protectedUser && numIds.includes(protectedUser.id)) {
      logger.warn(req, "user.bulk_delete", { reason: "protected_admin", id: protectedUser.id });
      return res.status(400).send("기본 관리자는 삭제할 수 없습니다.");
    }
  }

  const placeholders = numIds.map(() => "?").join(",");

  let denyReason = null;
  const txResult = dbRun(() => db.transaction(() => {
    // 마지막 활성 관리자 삭제 방지: 삭제 대상을 제외한 활성 admin이 0이 되면 거부한다
    // (비활성 admin까지 세면 활성 0 잠금을 못 막는다 — 단건 삭제·강등·비활성화와 동일 기준).
    const remainingActiveAdmins = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND active = 1 AND id NOT IN (${placeholders})`).get(...numIds).cnt;
    if (remainingActiveAdmins < 1) {
      denyReason = "last_admin";
      throw { status: 400, message: "마지막 관리자는 삭제할 수 없습니다." };
    }

    const emails = db.prepare(`SELECT email FROM users WHERE id IN (${placeholders})`).all(...numIds).map(r => r.email);
    db.prepare(`DELETE FROM ops_display WHERE user_id IN (${placeholders})`).run(...numIds);
    const delResult = db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...numIds);
    return { changes: delResult.changes, emails };
  })());
  if (!txResult.success) {
    logger.warn(req, "user.bulk_delete", denyReason ? { error: txResult.error, reason: denyReason, ids: numIds } : { error: txResult.error });
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
        const remainingActiveAdmins = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(id).cnt;
        if (remainingActiveAdmins < 1) {
          denyReason = "last_admin_demote";
          throw { status: 400, message: "마지막 관리자는 강등할 수 없습니다." };
        }
      }
      // 마지막 활성 관리자 비활성화 잠금 방지(삭제·강등과 동일 정책). active=0 admin은
      // 로그인·검증이 불가하므로 활성 admin 기준으로 센다.
      if (active !== undefined && !active && user.role === "admin") {
        const activeAdmins = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND active = 1").get().cnt;
        if (activeAdmins <= 1) {
          denyReason = "last_admin_deactivate";
          throw { status: 400, message: "마지막 활성 관리자는 비활성화할 수 없습니다." };
        }
      }
      if (role !== undefined) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
      if (realname !== undefined) db.prepare("UPDATE users SET realname = ? WHERE id = ?").run(realname, id);
      if (phone !== undefined) db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, id);
      if (affiliation !== undefined) db.prepare("UPDATE users SET affiliation = ? WHERE id = ?").run(affiliation, id);
      if (active !== undefined) db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
    })();
  });

  if (!result.success) {
    logger.warn(req, "user.update", denyReason ? { error: result.error, reason: denyReason, role } : { error: result.error }, user.email);
    return res.status(result.status).send(result.error);
  }

  const changes = {};
  if (role !== undefined) changes.role = role;
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
    const remainingActiveAdmins = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(id).cnt;
    if (remainingActiveAdmins < 1) {
      logger.warn(req, "user.delete", { reason: "last_admin" }, user.email);
      return res.status(400).send("마지막 관리자는 삭제할 수 없습니다.");
    }
  }

  const result = dbRun(() => db.transaction(() => {
    db.prepare("DELETE FROM ops_display WHERE user_id = ?").run(id);
    return db.prepare("DELETE FROM users WHERE id = ?").run(id);
  })());
  if (!result.success) {
    logger.warn(req, "user.delete", { error: result.error }, user.email);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "user.delete", { role: user.role, name: user.name }, user.email);
  res.status(200).send();
});

/* ============================================
   운영 오피셜 연락처 (사이드바 표시)
   ============================================ */

// GET /api/ops-contacts - 사이드바에 표시할 사용자 목록
app.get("/api/ops-contacts", (req, res) => {
  const result = dbRun(() => db.prepare(`
    SELECT u.id, u.email, u.name, u.realname, u.phone, d.description, d.sort_order
    FROM ops_display d JOIN users u ON d.user_id = u.id
    WHERE u.active = 1
    ORDER BY d.sort_order, u.id
  `).all());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/ops-contacts - 사용자를 사이드바 표시 목록에 추가
app.post("/api/ops-contacts", (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).send("사용자 ID가 필요합니다.");

  const user = db.prepare("SELECT email, name, role FROM users WHERE id = ? AND active = 1").get(user_id);
  if (!user) return res.status(404).send("사용자를 찾을 수 없습니다.");
  if (!["official", "chief", "admin"].includes(user.role)) {
    logger.warn(req, "ops_contact.create", { reason: "insufficient_role", role: user.role }, user.email);
    return res.status(400).send("official 이상 권한 사용자만 추가할 수 있습니다.");
  }

  const result = dbRun(() => db.transaction(() => {
    const nextOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM ops_display").get().value;
    return db.prepare("INSERT OR IGNORE INTO ops_display (user_id, sort_order) VALUES (?, ?)").run(user_id, nextOrder);
  })());
  if (!result.success) {
    logger.warn(req, "ops_contact.create", { error: result.error }, user.email);
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
  if (userIds.some((id) => !Number.isInteger(id) || id <= 0) || requestedIds.size !== userIds.length) {
    return res.status(400).send("user_ids에는 중복되지 않은 유효한 사용자 ID가 필요합니다.");
  }

  const rows = db.prepare(`
    SELECT d.user_id, u.active
    FROM ops_display d JOIN users u ON d.user_id = u.id
    ORDER BY d.sort_order, d.user_id
  `).all();
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
    logger.warn(req, "ops_contact.reorder", { error: result.error, count: userIds.length });
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
  if (normalizedDescription.length > 30) return res.status(400).send("설명은 30자 이내로 입력하세요.");

  const row = db.prepare("SELECT d.user_id, u.email, u.name FROM ops_display d JOIN users u ON d.user_id = u.id WHERE d.user_id = ?").get(userId);
  if (!row) return res.status(404).send("표시 목록에 없는 사용자입니다.");

  const result = dbRun(() => db.prepare("UPDATE ops_display SET description = ? WHERE user_id = ?").run(normalizedDescription, userId));
  if (!result.success) {
    logger.warn(req, "ops_contact.update", { error: result.error }, row.email);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "ops_contact.update", { name: row.name, description: normalizedDescription }, row.email);
  res.json({ description: normalizedDescription });
});

// DELETE /api/ops-contacts/:userId - 사이드바 표시 목록에서 제거
app.delete("/api/ops-contacts/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  const row = db.prepare("SELECT d.user_id, u.email, u.name FROM ops_display d JOIN users u ON d.user_id = u.id WHERE d.user_id = ?").get(userId);
  if (!row) return res.status(404).send("표시 목록에 없는 사용자입니다.");
  const result = dbRun(() => db.prepare("DELETE FROM ops_display WHERE user_id = ?").run(userId));
  if (!result.success) {
    logger.warn(req, "ops_contact.delete", { error: result.error }, row.email);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "ops_contact.delete", { name: row.name }, row.email);
  res.status(200).send();
});

/* ============================================
   로그 집계 API
   ============================================ */
const LOG_SERVICES = logAggregationTargets();

// 집계 커서 토큰. 서비스별 keyset 커서("ts,id")를 하나의 opaque 문자열로 묶고,
// 필터 해시(f)를 동봉해 "필터 A로 만든 커서로 필터 B 페이지를 잇는" 오용을 막는다
// (프론트는 필터 변경 시 커서를 리셋하므로 이 400은 버그/수제 URL만 잡는다).
function logFilterHash(service, filters) {
  const canonical = JSON.stringify({
    service: service || "",
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b))),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function encodeAggCursor(filterHash, cursors) {
  return Buffer.from(JSON.stringify({ v: 1, f: filterHash, c: cursors })).toString("base64url");
}

function decodeAggCursor(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString());
    if (parsed?.v !== 1 || typeof parsed.f !== "string" || typeof parsed.c !== "object" || parsed.c === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

// GET /api/admin/logs - 전체 서비스 로그 집계 (keyset 커서 k-way 병합)
// 예전 offset 방식은 서비스당 fetch 상한(2000행) 너머에서 빈 페이지를 돌려주면서
// total은 더 있다고 말했고, 원격 정렬 키(id)와 병합 정렬 키(timestamp)가 달라 페이지
// 경계에서 행이 어긋날 수 있었다. 커서는 페이지 깊이와 무관하게 서비스당 limit행만
// 가져오고, 정렬 키를 (timestamp, id)로 양쪽에서 통일한다.
app.get("/api/admin/logs", async (req, res) => {
  const { service, limit: qLimit, cursor: qCursor, offset: _qOffset, ...filters } = req.query;
  const limit = Math.max(1, Math.min(Number(qLimit) || 100, 500));
  const filterHash = logFilterHash(service, filters);

  let cursors = {};
  if (qCursor) {
    const token = decodeAggCursor(qCursor);
    if (!token) return res.status(400).send("올바르지 않은 cursor입니다.");
    if (token.f !== filterHash) return res.status(400).send("cursor가 현재 필터와 일치하지 않습니다.");
    cursors = token.c;
  }

  // Determine which services to query
  const targetServices = service
    ? Object.fromEntries(
        service.split(",").map(s => s.trim()).filter(Boolean)
          // 모르는 이름을 거른다. 안 거르면 url이 undefined인 채로 아래 템플릿에 들어가
          // "undefined/api/logs"로 fetch 한다(documents에서 고친 것과 같은 패턴).
          .filter(name => name === "auth" || LOG_SERVICES[name])
          .map(name => [name, name === "auth" ? null : LOG_SERVICES[name]])
      )
    : { auth: null, ...LOG_SERVICES };

  const fetches = Object.entries(targetServices).map(async ([name, url]) => {
    const before = typeof cursors[name] === "string" ? cursors[name] : null;
    if (name === "auth") {
      // Local query (no HTTP) — 원격 queryHandler와 동일한 keyset SQL.
      // limit+1행으로 hasMore를 판정한다(정확히 limit개 매칭 ≠ 다음 페이지 있음).
      try {
        const { where, params } = buildLogFilter(filters);
        const total = db.prepare(`SELECT COUNT(*) as cnt FROM logs ${where}`).get(...params).cnt;
        const parsed = parseLogCursor(before);
        let logs;
        if (parsed) {
          const cond = `${where ? `${where} AND` : "WHERE"} (timestamp, id) < (?, ?)`;
          logs = db.prepare(`SELECT * FROM logs ${cond} ORDER BY timestamp DESC, id DESC LIMIT ?`)
            .all(...params, parsed.ts, parsed.id, limit + 1);
        } else {
          logs = db.prepare(`SELECT * FROM logs ${where} ORDER BY timestamp DESC, id DESC LIMIT ?`)
            .all(...params, limit + 1);
        }
        const hasMore = logs.length > limit;
        if (hasMore) logs.length = limit;
        return { name, logs: logs.map(l => ({ ...l, _service: name })), total, hasMore };
      } catch (e) {
        logger.warn(null, "logs.query_failed", { error: e.message }, "auth");
        return { name, logs: [], total: 0, hasMore: false, failed: true };
      }
    }

    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      if (before) qs.set("before", before);
      for (const [k, v] of Object.entries(filters)) {
        if (v) qs.set(k, v);
      }
      const fetchRes = await fetch(`${url}?${qs}`, {
        headers: { "X-Internal-Service": process.env.INTERNAL_SECRET || "" },
        signal: AbortSignal.timeout(5000),
      });
      if (!fetchRes.ok) {
        warnAggThrottled("logs.aggregate_failed", { service: name, status: fetchRes.status }, name);
        return { name, logs: [], total: 0, hasMore: false, failed: true };
      }
      const data = await fetchRes.json();
      return {
        name,
        logs: (data.logs || []).map(l => ({ ...l, _service: name })),
        total: data.total || 0,
        hasMore: !!data.hasMore,
      };
    } catch (e) {
      warnAggThrottled("logs.aggregate_failed", { service: name, error: e.message }, name);
      return { name, logs: [], total: 0, hasMore: false, failed: true };
    }
  });

  const allResults = await Promise.all(fetches);

  // k-way 병합: (timestamp DESC, id DESC, service ASC) — 서비스 간 (ts,id) 충돌까지
  // 결정적으로 갈라야 커서 재개가 안정적이다.
  const merged = [];
  let totalSum = 0;
  for (const r of allResults) {
    merged.push(...r.logs);
    totalSum += r.total;
  }
  merged.sort((a, b) =>
    (b.timestamp || "").localeCompare(a.timestamp || "")
    || (b.id || 0) - (a.id || 0)
    || (a._service || "").localeCompare(b._service || ""));

  const paged = merged.slice(0, limit);

  // 서비스별 다음 커서: 이번 페이지에서 소비된 마지막 행의 키. 하나도 소비되지 않았거나
  // 실패한 서비스는 이전 커서를 그대로 물려받아, 그 행들이 다음 페이지(또는 복구 후)에
  // 다시 표면화된다.
  const nextCursors = { ...cursors };
  const consumedCount = new Map();
  for (const row of paged) {
    nextCursors[row._service] = `${row.timestamp},${row.id}`;
    consumedCount.set(row._service, (consumedCount.get(row._service) || 0) + 1);
  }
  const hasMore = merged.length > limit
    || allResults.some(r => r.hasMore && (consumedCount.get(r.name) || 0) === r.logs.length);

  res.json({
    logs: paged,
    total: totalSum,
    nextCursor: hasMore ? encodeAggCursor(filterHash, nextCursors) : null,
    hasMore,
    services: Object.keys(targetServices),
  });
});

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db };
}

// auth는 골격(createServiceSkeleton)을 쓰지 않는다 — 검증기를 자기 DB 함수로 주입하고
// (validateUserCacheTtl: 0) db가 검증기 클로저보다 먼저 만들어져야 해서 createApp 호출이
// 수동이다. 부팅 블록만 공용 runIfDirect를 쓴다.
runIfDirect(import.meta, "auth", createAuthApp);
