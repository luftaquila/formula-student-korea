import { verifyJWT } from "../../../shared/server/express-setup.mjs";

export function createOAuthService({ logger }) {
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

  function checkLoginRate(req, res) {
    // Caddy가 세팅한 신뢰 X-Real-IP 우선(위조 불가), 없으면 X-Forwarded-For 최좌측 → req.ip 폴백.
    const ip =
      req.headers["x-real-ip"]?.trim() ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip;
    const now = Date.now();
    const entry = loginLimiter.get(ip) || { count: 0, resetAt: now + 60000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60000;
    }
    entry.count++;
    loginLimiter.set(ip, entry);
    if (entry.count > 20) {
      // 무차별 대입 중 매 요청 warn을 남기면 초당 수십 행으로 뷰어가 침수된다 — 윈도우당 첫 위반만 기록.
      if (entry.count === 21) logger.warn(req, "auth.rate_limit", { count: entry.count, ip });
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

  return {
    getApplicant,
    loginLimiter,
    checkLoginRate,
    getRedirectUri,
    sanitizeRedirect,
    isApplyRedirect,
  };
}
