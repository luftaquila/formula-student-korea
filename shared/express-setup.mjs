import fs from "fs";
import crypto from "crypto";

import {
  HUMAN_ROLES,
  authorizePrincipal,
  isHumanRole,
} from "./access-control.js";
import { serviceUrl } from "./services.mjs";
export const VALID_ROLES = HUMAN_ROLES;

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
export function createCachedValidator(inner, ttlMs = 5000, maxEntries = 10000, keyFn = (value) => value) {
  const cache = new Map();
  const inflight = new Map();
  async function validate(value, context) {
    const key = keyFn(value);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.result;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const result = await inner(value, context);
        if (result?.valid) {
          if (cache.size >= maxEntries) {
            const now = Date.now();
            for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
            // 만료분 청소로도 모자라면 최고령 삽입분부터 축출(Map은 삽입 순서 유지)
            if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
          }
          cache.set(key, { result: { ...result }, expires: Date.now() + ttlMs });
        }
        return result;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }
  validate.invalidate = (value) => (value == null ? cache.clear() : cache.delete(keyFn(value)));
  return validate;
}

export function createRemoteUserValidator() {
  return async (email) => {
    try {
      const res = await fetch(`${serviceUrl("auth")}/api/users/access/${encodeURIComponent(email)}`, {
        // 시크릿이 없으면 빈 헤더로 나간다. 빈 값은 falsy라 auth의 내부 인증 분기가
        // 아예 잡히지 않고 쿠키 경로로 흘러 401로 거부된다 → transient fail-close.
        headers: { "X-Internal-Service": process.env.INTERNAL_SECRET || "" },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        return {
          valid: true,
          id: data.id,
          role: data.role,
          permissions: Array.isArray(data.permissions) ? data.permissions : [],
          accessRevision: Number(data.accessRevision) || 0,
        };
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

export function createRemoteDeviceValidator() {
  return async (token) => {
    try {
      const res = await fetch(`${serviceUrl("auth")}/api/devices/validate`, {
        method: "POST",
        headers: {
          "X-Internal-Service": process.env.INTERNAL_SECRET || "",
          "X-Device-Token": token,
        },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return { valid: true, ...(await res.json()) };
      if (res.status === 404 || res.status === 401) return { valid: false };
      console.warn(`[auth] fail-close: auth returned ${res.status} for device validation`);
      return { valid: false, transient: true };
    } catch (e) {
      console.warn(`[auth] fail-close: auth unreachable for device validation: ${e.message || e}`);
      return { valid: false, transient: true };
    }
  };
}

export function createApp(deps, authRoleFn) {
  const { express } = deps;
  ensureDataDir();

  // 보안 차단은 공격자가 요청 속도로 반복할 수 있으므로 원인별로 60초에 한 번만
  // 기록한다. 키는 고정된 두 종류뿐이라 공격자가 경로나 IP를 바꿔도 상태가 무한히
  // 늘지 않는다. 다음 기록에는 그동안 억눌린 횟수를 포함한다.
  const SECURITY_WARN_INTERVAL_MS = 60 * 1000;
  const securityWarnState = new Map();
  const securityNow = deps.securityWarnNow || Date.now;
  function warnSecurity(req, key, action, detail, target, fallbackMessage) {
    const now = securityNow();
    const state = securityWarnState.get(key);
    if (state && now - state.at < SECURITY_WARN_INTERVAL_MS) {
      state.suppressed += 1;
      return;
    }
    const auditDetail = state?.suppressed ? { ...detail, suppressed: state.suppressed } : detail;
    securityWarnState.set(key, { at: now, suppressed: 0 });
    if (deps.logger?.warn) deps.logger.warn(req, action, auditDetail, target);
    else console.warn(`${fallbackMessage}${state?.suppressed ? ` (suppressed ${state.suppressed})` : ""}`);
  }

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

  // 정적 루트. 프로덕션은 항상 기본값 — override는 테스트 픽스처 격리용(dbPath와 동일 패턴).
  const staticRoot = deps.staticRoot || "./web/dist";

  // 0. 콘텐츠 해시 자산 공개 서빙. Vite가 낸 /assets/*는 파일명이 콘텐츠에 종속된
  // 불변 번들이라 인증·재검증보다 먼저 서빙해도 정보 노출이 없다 — 로그인한 브라우저의
  // 매 자산 요청이 auth 왕복(아래 3c)을 태우던 비용을 없앤다. index.html 등 나머지 정적
  // 파일은 기존대로 게이트 뒤(아래 5)에서 서빙한다. 미존재 자산은 fallthrough로 기존
  // 401/redirect 경로를 그대로 탄다.
  app.use("/assets", express.static(`${staticRoot}/assets`, {
    index: false,
    fallthrough: true,
    setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
  }));

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
      const path = req.originalUrl || req.url;
      warnSecurity(req, "csrf_cross_site", "auth.csrf_rejected", {
        reason: "cross_site_write",
        method: req.method,
        path,
      }, path, `[csrf] blocked cross-site ${req.method} ${path} from ${req.headers["x-real-ip"] || req.ip}`);
      return res.status(403).send("cross-site 요청은 허용되지 않습니다.");
    }
    next();
  });

  // 3. Human/device principal extraction and authoritative revalidation.
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
  let validateUser = deps.validateUser || createRemoteUserValidator();
  let validateDevice = deps.validateDevice || createRemoteDeviceValidator();

  // 유효 결과만 5초 캐시. N개 서비스 × 매 요청이 auth로 동기 왕복하던 비용을 없애되,
  // 삭제·강등 전파 지연 상한은 TTL로 유계된다(5초, 운영 승인값). 무효·transient는
  // 캐시하지 않으므로 fail-close 계약(위)은 그대로다. auth 자신은 로컬 DB 조회라
  // 캐시가 무익하고 자기 UI의 즉시 반영을 잃으므로 validateUserCacheTtl: 0으로 끈다.
  const cacheTtl = deps.validateUserCacheTtl ?? 5000;
  if (cacheTtl > 0) validateUser = createCachedValidator(validateUser, cacheTtl);
  // Device revocation/re-pairing is an emergency control and must take effect
  // on the next request. Kiosk traffic is sparse enough that caching valid
  // device tokens is not worth a revocation window.
  const deviceCacheTtl = deps.validateDeviceCacheTtl ?? 0;
  if (deviceCacheTtl > 0) {
    validateDevice = createCachedValidator(
      validateDevice,
      deviceCacheTtl,
      10000,
      (token) => crypto.createHash("sha256").update(String(token)).digest("base64url"),
    );
  }

  // Pre-compute INTERNAL_SECRET hash (immutable for process lifetime)
  const internalSecret = process.env.INTERNAL_SECRET;
  const isInternalSecret = createSecretChecker(internalSecret);

  app.use(async (req, res, next) => {
    // Internal service-to-service auth
    const header = req.headers["x-internal-service"];
    if (internalSecret && header) {
      if (isInternalSecret(header)) {
        req.user = { kind: "internal", email: "internal", name: "Service", role: "admin", permissions: [] };
        return next();
      }
      // Caddy가 외부의 이 헤더를 벗기므로, 불일치는 시크릿 로테이션 실수(장애급 설정
      // 오류)거나 내부망 탐색이다. 헤더 값 자체는 시크릿 후보이므로 기록하지 않는다.
      const path = req.originalUrl || req.url;
      warnSecurity(req, "internal_secret_mismatch", "auth.internal_secret_rejected", {
        reason: "secret_mismatch",
        method: req.method,
        path,
      }, path, `[auth] internal-secret mismatch on ${req.method} ${path} from ${req.headers["x-real-ip"] || req.ip}`);
      return res.status(403).send("Forbidden");
    }
    const humanToken = req.cookies.fsk_session;
    const deviceToken = req.cookies.fsk_device;
    if (humanToken && deviceToken) {
      req.authAmbiguous = true;
      return next();
    }

    const secure = isSecureConnection(req);
    const appendCookies = (...cookies) => {
      const current = res.getHeader("Set-Cookie");
      res.setHeader("Set-Cookie", [...(Array.isArray(current) ? current : current ? [current] : []), ...cookies]);
    };

    if (humanToken && process.env.JWT_SECRET) {
      let tokenUser = null;
      try { tokenUser = verifyJWT(humanToken, process.env.JWT_SECRET); }
      catch { /* invalid token */ }

      if (tokenUser?.email) {
        let result;
        try {
          result = await validateUser(tokenUser.email, tokenUser);
        } catch (e) {
          console.warn(`[auth] fail-close: validator threw for ${tokenUser.email}: ${e.message || e}`);
          result = { valid: false, transient: true };
        }
        const role = result?.role ?? tokenUser.role;
        if (result?.valid && isHumanRole(role)) {
          const permissions = Array.isArray(result.permissions)
            ? result.permissions
            : Array.isArray(tokenUser.permissions) ? tokenUser.permissions : [];
          const accessRevision = Number(result.accessRevision ?? tokenUser.accessRevision) || 0;
          req.user = {
            kind: "human",
            id: result.id,
            email: tokenUser.email,
            name: tokenUser.name,
            role,
            permissions,
            accessRevision,
          };
          const age = Math.floor(Date.now() / 1000) - (tokenUser.iat || 0);
          if (age > 24 * 3600 || role !== tokenUser.role || accessRevision !== Number(tokenUser.accessRevision || 0)) {
            const jwt = createJWT({ email: req.user.email, name: req.user.name, role, accessRevision }, process.env.JWT_SECRET);
            const cookieOpts = formatCookieOpts(7 * 24 * 3600, secure);
            const readable = encodeURIComponent(JSON.stringify({ name: req.user.name, role, permissions, accessRevision }));
            appendCookies(`fsk_session=${jwt}; HttpOnly; ${cookieOpts}`, `fsk_user=${readable}; ${cookieOpts}`);
          }
        } else if (!result?.transient) {
          const cookieOpts = formatCookieOpts(0, secure);
          appendCookies(`fsk_session=; HttpOnly; ${cookieOpts}`, `fsk_user=; ${cookieOpts}`);
        }
      }
    } else if (deviceToken) {
      let result;
      try {
        result = await validateDevice(deviceToken);
      } catch (e) {
        console.warn(`[auth] fail-close: device validator threw: ${e.message || e}`);
        result = { valid: false, transient: true };
      }
      if (result?.valid && result.id && result.scope) {
        req.user = {
          kind: "device",
          id: result.id,
          email: `device:${result.id}`,
          name: result.name || `Device ${result.id}`,
          role: "device",
          scope: result.scope,
        };
        const maxAge = 400 * 24 * 3600;
        const opts = `Path=/; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
        appendCookies(`fsk_device=${encodeURIComponent(deviceToken)}; HttpOnly; ${opts}`);
      } else if (!result?.transient) {
        const opts = `Path=/; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
        appendCookies(`fsk_device=; HttpOnly; ${opts}`);
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
      let requirement = authRoleFn(gateReq);
      if (!requirement) return next(); // public
      // Small compatibility surface for service factories while their callers
      // migrate from role strings. Operational authorization is never numeric.
      if (typeof requirement === "string") {
        requirement = requirement === "admin"
          ? { humanRoles: ["admin"] }
          : requirement === "official"
            ? { humanRoles: ["official", "admin"] }
            : requirement === "student"
              ? { humanRoles: ["student"] }
              : { deny: true };
      }
      // Nested module apps see `/years/...` here even when Express mounted
      // them below `/competition/api/v1/...`. Include baseUrl so versioned API
      // routes keep API-style 401/403 responses instead of UI redirects.
      const basePath = String(req.baseUrl || "").toLowerCase().replace(/\/+$/, "");
      const isApi = gatePath.startsWith("/api/") || basePath.startsWith("/competition/api/");
      if (!req.user || req.authAmbiguous) {
        if (!isApi) return res.redirect(requirement.unauthenticatedRedirect || "/");
        return res.status(401).json({
          code: req.authAmbiguous ? "AMBIGUOUS_PRINCIPAL" : "AUTH_REQUIRED",
          message: "인증이 필요합니다.",
        });
      }
      if (!authorizePrincipal(req.user, requirement)) {
        if (!isApi) return res.redirect("/");
        return res.status(403).json({ code: "ACCESS_DENIED", message: "권한이 없습니다." });
      }
      next();
    });
  }

  // 5. Static files (after auth middleware)
  // Vite가 낸 해시 자산(/assets/*)은 파일명이 콘텐츠에 종속되므로 1년 immutable 캐시로
  // 매 페이지 로드의 재검증(304) 왕복을 없앤다. 그 외(index.html 등)는 no-cache라 재배포가
  // 즉시 반영된다.
  app.use(express.static(staticRoot, {
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
  app.validateDevice = validateDevice;

  return app;
}

export function setupProcessHandlers(db) {
  process.on("exit", () => db.close());
  process.on("SIGHUP", () => process.exit(128 + 1));
  process.on("SIGINT", () => process.exit(128 + 2));
  process.on("SIGTERM", () => process.exit(128 + 15));
}

// 내부 서비스 호출만 허용하는 가드. createApp 미들웨어가 X-Internal-Service
// 헤더 검증에 성공하면 req.user = { kind: "internal", ... }로 설정한다.
// 허용 시 true, 아니면 403 응답 후 false를 반환한다.
export function requireInternalRequest(req, res) {
  if (req.user?.kind === "internal") return true;
  res.status(403).send("내부 서비스 호출만 허용됩니다.");
  return false;
}

export function createDbRun() {
  return function dbRun(fn) {
    try {
      return { success: true, result: fn() };
    } catch (e) {
      const internalError = e?.message || String(e);
      if (e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { success: false, status: 400, error: "이미 존재하는 항목입니다.", internalError };
      }
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { success: false, status: 400, error: "UNIQUE 제약 조건 위반입니다.", internalError };
      }
      if (e.status && e.message) {
        return { success: false, status: e.status, error: e.message, internalError };
      }
      // internalError는 로거 전용이다 — 클라이언트 응답에는 새니타이즈된 error만 내보낸다.
      // DB 자체가 실패 원인일 수 있어(SQLITE_BUSY/IOERR 등 로거 INSERT도 같이 실패하는
      // 상황) 콘솔 폴백을 유지한다.
      console.error("[DB]", e.message || e);
      return { success: false, status: 500, error: "서버 오류가 발생했습니다.", internalError };
    }
  };
}
