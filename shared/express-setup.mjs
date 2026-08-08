import fs from "fs";
import crypto from "crypto";

import { ROLE_LEVELS } from "./constants.js";
import { serviceUrl } from "./services.mjs";
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
  // payload가 마지막이므로 명시된 iat/exp가 기본값을 이긴다(테스트의 발급 시각 백데이트용).
  // 디코드한 토큰을 통째로 spread해 넘기면 낡은 iat/exp가 그대로 실려 가므로 금지 —
  // 호출자는 항상 필요한 클레임만 명시적으로 구성한다.
  const body = { iat: now, exp: now + expiresInSec, ...payload };
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

// 재검증 결과 캐시. **유효(valid:true) 결과만** TTL 동안 캐시한다 — 404(확정 무효)와
// transient 실패는 절대 캐시하지 않는다. 무효 응답을 캐시하면 일시 장애가 TTL만큼
// 고착되고, 반대로 유효 캐시는 삭제·강등 전파를 최대 TTL(기본 5초)만큼만 늦춘다.
// 같은 이메일의 동시 검증은 한 번의 inner 호출을 공유한다(동시 API 요청·SSE 재검증
// 루프의 중복 왕복 제거). inner의 예외는 그대로 전파한다 — 요청 미들웨어는 transient
// fail-close로, sse.mjs 재검증은 fail-open으로 각자의 계약대로 처리한다.
export function createCachedValidator(inner, ttlMs = 5000, maxEntries = 10000) {
  const cache = new Map();    // email -> { role, expires }
  const inflight = new Map(); // email -> Promise<result>
  async function validate(email) {
    const hit = cache.get(email);
    if (hit && hit.expires > Date.now()) return { valid: true, role: hit.role };
    if (inflight.has(email)) return inflight.get(email);
    const p = (async () => {
      try {
        const result = await inner(email);
        if (result?.valid) {
          if (cache.size >= maxEntries) {
            const now = Date.now();
            for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
            // 만료분 청소로도 모자라면 최고령 삽입분부터 축출(Map은 삽입 순서 유지)
            if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
          }
          cache.set(email, { role: result.role ?? null, expires: Date.now() + ttlMs });
        }
        return result;
      } finally {
        inflight.delete(email);
      }
    })();
    inflight.set(email, p);
    return p;
  }
  validate.invalidate = (email) => (email == null ? cache.clear() : cache.delete(email));
  return validate;
}

export function createApp(deps, authRoleFn) {
  const { express } = deps;
  ensureDataDir();

  if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
    console.error("FATAL: JWT_SECRET must be set in production. Exiting.");
    process.exit(1);
  }

  // INTERNAL_SECRET이 없으면 auth 재검증 요청이 인증 헤더 없이 나가 거부된다(fail-close).
  // 프로덕션은 부팅을 막고, 그 외에서는 경고만 남긴다 — 조용히 재검증을 건너뛰는 대신
  // 시끄럽게 실패시키는 쪽이 이 파일이 지키려는 원칙이다.
  if (!process.env.INTERNAL_SECRET) {
    if (process.env.NODE_ENV === "production") {
      console.error("FATAL: INTERNAL_SECRET must be set in production. Exiting.");
      process.exit(1);
    }
    console.warn("WARN: INTERNAL_SECRET is not set — inter-service calls and user revalidation will be rejected.");
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
  // Build validateUser: direct function from deps, or auto HTTP to the auth service.
  // 재검증은 기본 동작이다. 예전에는 AUTH_SERVER env가 있을 때만 켜져서, 배포 설정에서
  // URL을 빠뜨리면 JWT가 무검증으로 신뢰됐다 — 삭제·강등된 사용자가 세션 만료(최대 7일)
  // 까지 권한을 유지하는 구멍이었다. URL은 이제 레지스트리 상수로 오므로 누락될 수 없다.
  // 재검증을 끄는 유일한 방법은 검증기를 직접 주입하는 것뿐이다(auth는 자기 DB 함수를,
  // 테스트는 stub을 넘긴다). 런타임 스위치를 두지 않으므로 프로덕션에는 끌 방법 자체가
  // 없다 — 설정 하나로 삭제·강등 전파가 멈추는 경로를 만들지 않는다.
  //
  // INTERNAL_SECRET 누락도 위 부팅 검사가 담당한다. 여기서 다시 검사하면 "설정이 없으면
  // 조용히 재검증을 끈다"는 이 PR이 없애려는 실패 모드가 한 칸 옆에서 되살아난다.
  let validateUser = deps.validateUser || null;
  if (!validateUser) {
    validateUser = async (email) => {
      try {
        const res = await fetch(`${serviceUrl("auth")}/api/users/role/${encodeURIComponent(email)}`, {
          // 시크릿이 없으면 빈 헤더로 나간다. 빈 값은 falsy라 auth의 내부 인증 분기가
          // 아예 잡히지 않고 쿠키 경로로 흘러 401로 거부된다 → transient fail-close.
          headers: { "X-Internal-Service": process.env.INTERNAL_SECRET || "" },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json();
          return { valid: true, role: data.role };
        }
        if (res.status === 404) return { valid: false, role: null };
        // 404(사용자 삭제/비활성)만 확정 무효다. 5xx/네트워크 오류는 auth 일시 장애이므로
        // transient로 표시 — 이 요청은 fail-close로 거부(req.user=null)하되 세션 쿠키는
        // 지우지 않아 복구 후 재-OAuth 없이 세션이 이어진다.
        console.warn(`[auth] fail-close: auth returned ${res.status} for ${email}`);
        return { valid: false, role: null, transient: true };
      } catch (e) {
        console.warn(`[auth] fail-close: auth unreachable for ${email}: ${e.message || e}`);
        return { valid: false, role: null, transient: true };
      }
    };
  }

  // 유효 결과만 5초 캐시. N개 서비스 × 매 요청이 auth로 동기 왕복하던 비용을 없애되,
  // 삭제·강등 전파 지연 상한은 TTL로 유계된다(5초, 운영 승인값). 무효·transient는
  // 캐시하지 않으므로 fail-close 계약(위)은 그대로다. auth 자신은 로컬 DB 조회라
  // 캐시가 무익하고 자기 UI의 즉시 반영을 잃으므로 validateUserCacheTtl: 0으로 끈다.
  const cacheTtl = deps.validateUserCacheTtl ?? 5000;
  if (cacheTtl > 0) validateUser = createCachedValidator(validateUser, cacheTtl);

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

        // Sliding session: 발급(iat) 후 하루가 지난 첫 요청에서만 토큰 자동 갱신 —
        // 재서명·Set-Cookie를 하루 최대 1회로 제한한다. 잔여기간 기준(만료까지 6일 미만)
        // 이었을 때는 발급 하루 뒤부터 "매 요청"이 재서명이었다. iat 없는 외부 토큰은
        // age가 커져 갱신 경로를 타므로 안전하다. (role은 validateUser 블록에서 처리)
        const age = Math.floor(Date.now() / 1000) - (req.user.iat || 0);
        if (age > 24 * 3600) {
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

    // Validate user still exists + sync role from auth. validateUser는 위에서 항상
    // 채워지므로(주입 아니면 내장 HTTP) 존재 여부를 다시 보지 않는다.
    if (req.user) {
      // 계약은 `{ valid, role, transient? }` 하나뿐이다. 예전에는 bare boolean도 받았지만,
      // validateUser가 10개 팩토리의 공개 주입 지점이 된 지금은 두 형태를 허용하면
      // 소비자마다 해석이 갈린다 — course의 SSE 재검증은 `result?.valid`를 보므로
      // `true`를 반환하는 stub이 거기서만 연결을 끊는다.
      //
      // 예외도 같은 이유로 계약에 넣는다. 내장 HTTP 검증기는 네트워크 오류를 자체 catch로
      // `{ valid: false, transient: true }`로 바꾸지만, 주입된 검증기는 그대로 던진다
      // (auth의 것은 db.prepare().get()을 무방비로 호출한다). 감싸지 않으면 같은 예외가
      // 여기서는 500이 되고 sse.mjs에서는 fail-open이 된다. 내장 경로와 동일하게 일시 장애로
      // 취급해 쿠키를 보존한 채 fail-close 한다.
      // 내장 경로가 두 실패 분기 모두 로그를 남기므로 여기도 남긴다. 조용히 삼키면 auth의
      // 검증기가 DB 오류로 던졌을 때 전 요청이 401이 되면서 아무 흔적도 남지 않는다.
      //
      // logger.warn이 아니라 console.warn인 이유는 이 계층에 logger가 없어서가 아니라,
      // logger의 저장소가 방금 실패한 바로 그것이기 때문이다 — createLogger(db)는 검증기가
      // 조회하던 같은 DB에 INSERT 하고, 로그 뷰어도 그 DB를 읽는다. 이 분기를 타게 만드는
      // 대표적 원인(auth의 SQLITE_BUSY/IOERR)에서는 DB 로깅이 정확히 무용하다. 프로세스
      // stderr는 그 상황에서도 남는 유일한 채널이다. CLAUDE.md 로깅 정책의 예외 항목 참고.
      let result;
      try {
        result = await validateUser(req.user.email);
      } catch (e) {
        console.warn(`[auth] fail-close: validator threw for ${req.user.email}: ${e.message || e}`);
        result = { valid: false, transient: true };
      }
      const valid = result?.valid;
      const freshRole = result?.role ?? null;
      if (!valid) {
        req.user = null;
        // 확정 무효(404)에서만 쿠키를 지운다. transient(auth 5xx/네트워크 장애)면 이 요청은
        // 거부하되 쿠키를 보존해 복구 후 재-OAuth 없이 세션이 이어지게 한다.
        if (!result?.transient) {
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

  // 확정된 검증기를 노출한다. course의 SSE 주기 재검증처럼 미들웨어 밖에서 같은 판단을
  // 해야 하는 곳이 자체 HTTP 클라이언트를 다시 구현하면, 404-vs-non-ok 해석이 두 곳에
  // 생기고 그중 한쪽만 테스트로 덮인다.
  app.validateUser = validateUser;

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
