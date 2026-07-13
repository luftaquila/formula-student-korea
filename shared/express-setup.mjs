import fs from "fs";
import crypto from "crypto";

import { ROLE_LEVELS } from "./constants.js";
export const VALID_ROLES = Object.keys(ROLE_LEVELS);

// 불리언 환경변수 파싱. env 값은 항상 문자열이므로 "false"/"0"도 truthy가 되는
// 함정을 막는다. "1"/"true"/"yes"/"on"(대소문자 무시)만 활성으로 간주하고,
// 그 외("false", "0", "", undefined)는 모두 비활성.
export function isEnvEnabled(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function isSecureConnection(req) {
  return (req.headers["x-forwarded-proto"] || req.protocol) === "https";
}

export function formatCookieOpts(maxAge, isSecure) {
  return `Path=/; SameSite=Lax; Max-Age=${maxAge}${isSecure ? "; Secure" : ""}`;
}

export function ensureDataDir() {
  if (!fs.existsSync("./data")) {
    fs.mkdirSync("./data", { recursive: true });
  }
}

export function createJWT(payload, secret, expiresInSec = 7 * 24 * 3600) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const bodyB64 = Buffer.from(JSON.stringify(body)).toString("base64url");
  const data = `${headerB64}.${bodyB64}`;
  const signature = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

export function verifyJWT(token, secret) {
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error("Invalid token");
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
  if (header.alg !== "HS256") throw new Error("Invalid algorithm");
  const data = `${headerB64}.${payloadB64}`;
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureB64);
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error("Invalid signature");
  }
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  if (!payload.exp || Date.now() / 1000 > payload.exp) throw new Error("Expired");
  return payload;
}

// 시크릿 문자열 비교기 팩토리. SHA-256 해시 후 timingSafeEqual로 비교해 길이·내용
// 모두 타이밍 부채널 없이 검사한다. 시크릿 미설정 또는 문자열 아닌 입력은 항상 false.
export function createSecretChecker(secret) {
  const cachedHash = secret ? crypto.createHash("sha256").update(secret).digest() : null;
  return (value) => {
    if (!cachedHash || typeof value !== "string" || !value) return false;
    const valueHash = crypto.createHash("sha256").update(value).digest();
    // timingSafeEqual throws on length mismatch; with SHA-256 this is always
    // 32 bytes, but the explicit guard keeps the contract unambiguous.
    return valueHash.length === cachedHash.length && crypto.timingSafeEqual(cachedHash, valueHash);
  };
}

export function createApp(deps, authRoleFn) {
  const { express } = deps;
  ensureDataDir();

  if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
    console.error("FATAL: JWT_SECRET must be set in production. Exiting.");
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production" && !process.env.INTERNAL_SECRET) {
    console.error("FATAL: INTERNAL_SECRET must be set in production. Exiting.");
    process.exit(1);
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: true, limit: "100kb" }));

  // 1. Cookie parsing (no external dependency)
  app.use((req, res, next) => {
    req.cookies = {};
    const ch = req.headers.cookie;
    if (ch) {
      ch.split(";").forEach((c) => {
        const [n, ...r] = c.split("=");
        if (n) {
          try { req.cookies[n.trim()] = decodeURIComponent(r.join("=").trim()); }
          catch { /* malformed percent-encoding */ }
        }
      });
    }
    next();
  });

  // 2. CSRF 심층방어: 모던 브라우저가 보내는 Sec-Fetch-Site 헤더가 cross-site인 쓰기
  // 요청을 차단한다. 1차 방어는 fsk_session 쿠키의 SameSite=Lax이고 이 검사는 두 번째
  // 계층. 헤더가 없는 요청(내부 서비스 호출, rover, 구형 클라이언트)과
  // same-origin/same-site/none은 통과한다.
  const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  app.use((req, res, next) => {
    if (CSRF_SAFE_METHODS.has(req.method)) return next();
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return res.status(403).send("cross-site 요청은 허용되지 않습니다.");
    }
    next();
  });

  // 3. JWT user extraction
  // Build validateUser: direct function from deps, or auto HTTP via AUTH_SERVER
  let validateUser = deps.validateUser || null;
  if (!validateUser && process.env.AUTH_SERVER && process.env.INTERNAL_SECRET) {
    validateUser = async (email) => {
      try {
        const res = await fetch(`${process.env.AUTH_SERVER}/api/users/role/${encodeURIComponent(email)}`, {
          headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json();
          return { valid: true, role: data.role };
        }
        if (res.status === 404) return { valid: false, role: null };
        // 404(사용자 삭제/비활성)만 확정 무효다. 5xx/네트워크 오류는 auth 일시 장애이므로
        // transient로 표시 — 이 요청은 fail-close로 거부(req.user=null)하되 세션 쿠키는
        // 지우지 않아 복구 후 재-OAuth 없이 세션이 이어진다. 거부는 유지되므로 즉시 권한
        // 반영(캐싱 없음) 원칙과 충돌하지 않는다.
        console.warn(`[auth] fail-close: auth returned ${res.status} for ${email}`);
        return { valid: false, role: null, transient: true };
      } catch (e) {
        console.warn(`[auth] fail-close: auth unreachable for ${email}: ${e.message || e}`);
        return { valid: false, role: null, transient: true };
      }
    };
  }

  // Pre-compute INTERNAL_SECRET hash (immutable for process lifetime)
  const internalSecret = process.env.INTERNAL_SECRET;
  const isInternalSecret = createSecretChecker(internalSecret);

  app.use(async (req, res, next) => {
    // Internal service-to-service auth
    const header = req.headers["x-internal-service"];
    if (internalSecret && header) {
      if (isInternalSecret(header)) {
        req.user = { email: "internal", name: "Service", role: "admin" };
        return next();
      }
      return res.status(403).send("Forbidden");
    }
    const token = req.cookies.fsk_session;
    if (token && process.env.JWT_SECRET) {
      try {
        req.user = verifyJWT(token, process.env.JWT_SECRET);

        // Sliding session: 만료(발급 후 7일)까지 6일 미만 남으면, 즉 발급 후 하루가
        // 지난 첫 요청에서 토큰 자동 갱신 (role은 validateUser 블록에서 처리)
        const remaining = req.user.exp - Math.floor(Date.now() / 1000);
        const threshold = 6 * 24 * 3600; // 6일
        if (remaining < threshold) {
          const { email, name, role } = req.user;
          const newJwt = createJWT({ email, name, role }, process.env.JWT_SECRET);
          const cookieOpts = formatCookieOpts(7 * 24 * 3600, isSecureConnection(req));
          const userPayload = encodeURIComponent(JSON.stringify({ name, role }));
          res.setHeader("Set-Cookie", [
            `fsk_session=${newJwt}; HttpOnly; ${cookieOpts}`,
            `fsk_user=${userPayload}; ${cookieOpts}`,
          ]);
        }
      } catch { /* invalid token */ }
    }

    // Validate user still exists + sync role from auth
    if (req.user && validateUser) {
      const result = await validateUser(req.user.email);
      const valid = typeof result === "object" ? result.valid : result;
      const freshRole = typeof result === "object" ? result.role : null;
      if (!valid) {
        req.user = null;
        // 확정 무효(404)에서만 쿠키를 지운다. transient(auth 5xx/네트워크 장애)면 이 요청은
        // 거부하되 쿠키를 보존해 복구 후 재-OAuth 없이 세션이 이어지게 한다.
        if (!(result && typeof result === "object" && result.transient)) {
          const cookieOpts = formatCookieOpts(0, isSecureConnection(req));
          res.setHeader("Set-Cookie", [
            `fsk_session=; HttpOnly; ${cookieOpts}`,
            `fsk_user=; ${cookieOpts}`,
          ]);
        }
      } else if (freshRole && freshRole !== req.user.role && process.env.JWT_SECRET) {
        req.user.role = freshRole;
        const { email, name } = req.user;
        const newJwt = createJWT({ email, name, role: freshRole }, process.env.JWT_SECRET);
        const cookieOpts = formatCookieOpts(7 * 24 * 3600, isSecureConnection(req));
        const userPayload = encodeURIComponent(JSON.stringify({ name, role: freshRole }));
        res.setHeader("Set-Cookie", [
          `fsk_session=${newJwt}; HttpOnly; ${cookieOpts}`,
          `fsk_user=${userPayload}; ${cookieOpts}`,
        ]);
      }
    }

    next();
  });

  // 4. Auth middleware (when authRoleFn is provided)
  if (authRoleFn) {
    app.use((req, res, next) => {
      // Express 라우팅은 대소문자 무시 + 후행 슬래시 병합이라 `/API/users`·`/api/x/`가
      // 소문자·no-slash 핸들러에 매칭된다. 반면 authRoleFn 게이트는 req.path를 그대로
      // 비교하므로, 정규화하지 않으면 경로 변형으로 게이트를 우회할 수 있다(예: `/API/users`가
      // startsWith("/api/") 실패 → public으로 통과 후 핸들러 매칭). 라우터와 동일하게
      // 정규화한 경로를 게이트에 넘겨 우회를 차단한다. req.url/req.path 원본은 건드리지
      // 않으므로 라우팅·핸들러(대소문자 유지 파라미터 등)에는 영향이 없다.
      const gatePath = (req.path || "/").toLowerCase().replace(/\/+$/, "") || "/";
      const gateReq = gatePath === req.path ? req : new Proxy(req, {
        get(target, prop) {
          if (prop === "path") return gatePath;
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const role = authRoleFn(gateReq);
      if (!role) return next(); // public
      const isApi = gatePath.startsWith("/api/");
      if (!req.user) {
        if (!isApi) return res.redirect("/");
        return res.status(401).send("인증이 필요합니다.");
      }
      if (!VALID_ROLES.includes(req.user.role) || (ROLE_LEVELS[req.user.role] || 0) < (ROLE_LEVELS[role] || Infinity)) {
        if (!isApi) return res.redirect("/");
        return res.status(403).send("권한이 없습니다.");
      }
      next();
    });
  }

  // 5. Static files (after auth middleware)
  // Vite가 낸 해시 자산(/assets/*)은 파일명이 콘텐츠에 종속되므로 1년 immutable 캐시로
  // 매 페이지 로드의 재검증(304) 왕복을 없앤다. 그 외(index.html 등)는 no-cache라 재배포가
  // 즉시 반영된다.
  app.use(express.static("./web/dist", {
    setHeaders: (res, filePath) => {
      if (/[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));

  return app;
}

export function setupProcessHandlers(db) {
  process.on("exit", () => db.close());
  process.on("SIGHUP", () => process.exit(128 + 1));
  process.on("SIGINT", () => process.exit(128 + 2));
  process.on("SIGTERM", () => process.exit(128 + 15));
}

// 내부 서비스 호출만 허용하는 가드. createApp 미들웨어가 X-Internal-Service
// 헤더 검증에 성공하면 req.user = { email: "internal", role: "admin" }로 설정한다.
// 허용 시 true, 아니면 403 응답 후 false를 반환한다.
export function requireInternalRequest(req, res) {
  if (req.user?.email === "internal" && req.user?.role === "admin") return true;
  res.status(403).send("내부 서비스 호출만 허용됩니다.");
  return false;
}

export function createDbRun() {
  return function dbRun(fn) {
    try {
      return { success: true, result: fn() };
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { success: false, status: 400, error: "이미 존재하는 항목입니다." };
      }
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { success: false, status: 400, error: "UNIQUE 제약 조건 위반입니다." };
      }
      if (e.status && e.message) {
        return { success: false, status: e.status, error: e.message };
      }
      console.error("[DB]", e.message || e);
      return { success: false, status: 500, error: "서버 오류가 발생했습니다." };
    }
  };
}
