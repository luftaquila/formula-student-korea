import crypto from "crypto";
import {
  isSecureConnection,
  formatCookieOpts,
  isEnvEnabled,
  createJWT,
} from "../../../shared/server/express-setup.mjs";

export function registerOauthRoutes({
  app,
  checkLoginRate,
  sanitizeRedirect,
  getRedirectUri,
  logger,
  sessionPicture,
  db,
  isApplicationsOpen,
  isApplyRedirect,
  dbRun,
  userAccess,
}) {
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
    res.setHeader(
      "Set-Cookie",
      `fsk_oauth_nonce=${nonce}; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`,
    );
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
    const nonceMatch =
      stateNonce &&
      cookieNonce &&
      stateNonce.length === cookieNonce.length &&
      crypto.timingSafeEqual(Buffer.from(stateNonce), Buffer.from(cookieNonce));
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
      const picture = sessionPicture(userInfo.picture);

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
        db.prepare(
          "INSERT INTO users (email, name, role, active, created_at) VALUES (?, ?, 'admin', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        ).run(email, name);
        user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
        logger.log(req, "user.auto_register", { name, role: "admin", test_server: true }, email, {
          email,
          name,
        });
      }

      if (!user || !user.active) {
        // 비활성 계정: 항상 거부
        if (user && !user.active) {
          logger.warn(req, "user.login_failed", { reason: "deactivated" }, email, { email, name });
          res.setHeader("Set-Cookie", [
            clearNonceCookie,
            clearSessionCookie,
            clearUserCookie,
            clearApplicantCookie,
          ]);
          return res.redirect("/?login_error=deactivated");
        }
        // 미등록 계정: 신청 페이지에서 시작한 로그인만 신청 흐름으로 허용한다.
        // 일반 사이드바 로그인은 신청 링크 우회가 되지 않도록 기존처럼 거부한다.
        if (isApplicationsOpen() && isApplyRedirect(redirectUrl)) {
          const applicantJwt = createJWT(
            { email, name, applicant: true },
            process.env.JWT_SECRET,
            3600,
          );
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
        res.setHeader("Set-Cookie", [
          clearNonceCookie,
          clearSessionCookie,
          clearUserCookie,
          clearApplicantCookie,
        ]);
        return res.redirect("/?login_error=unregistered");
      }

      // Update name from Google profile (best-effort: a sync failure must not block login)
      if (name && name !== user.name) {
        const r = dbRun(() =>
          db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, user.id),
        );
        if (!r.success)
          logger.warn(req, "user.name_sync", { error: r.internalError || r.error }, email, {
            email,
            name,
            role: user.role,
          });
      }

      // 최초 로그인 시 created_at 기록
      if (!user.created_at) {
        const r = dbRun(() =>
          db
            .prepare(
              "UPDATE users SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            )
            .run(user.id),
        );
        if (!r.success)
          logger.warn(req, "user.created_at_init", { error: r.internalError || r.error }, email, {
            email,
            name,
            role: user.role,
          });
      }

      // Set JWT cookie. Permissions stay authoritative in Auth; the readable
      // cookie is only a navigation hint and every service revalidates it.
      const snapshot = userAccess(user);
      const jwt = createJWT(
        { email, name, picture, role: user.role, accessRevision: snapshot.accessRevision },
        process.env.JWT_SECRET,
      );
      const cookieOpts = formatCookieOpts(7 * 24 * 3600, isSecureConnection(req));
      const deviceCookieOpts = `Path=/; SameSite=Strict; Max-Age=0${isSecureConnection(req) ? "; Secure" : ""}`;

      res.setHeader("Set-Cookie", [
        `fsk_session=${jwt}; HttpOnly; ${cookieOpts}`,
        `fsk_user=${encodeURIComponent(JSON.stringify({ name, picture, role: user.role, permissions: snapshot.permissions, accessRevision: snapshot.accessRevision }))}; ${cookieOpts}`,
        `fsk_device=; HttpOnly; ${deviceCookieOpts}`,
        clearNonceCookie,
        clearApplicantCookie,
      ]);

      logger.log(req, "user.login", { name, role: user.role }, email, {
        email,
        name,
        role: user.role,
      });

      res.redirect(redirectUrl);
    } catch (e) {
      logger.warn(req, "auth.callback_error", { error: e.message || String(e) });
      res.setHeader("Set-Cookie", clearNonceCookie);
      res.redirect("/?login_error=error");
    }
  });

  // POST /api/logout - 쿠키 삭제
  // Logout is principal-agnostic: it always clears the human and device cookies so a
  // browser holding both (AMBIGUOUS_PRINCIPAL everywhere else) can get out without
  // a fresh OAuth round trip.
  app.post("/api/logout", (req, res) => {
    const actor =
      req.user?.kind === "human"
        ? req.user.email
        : req.user?.kind === "device"
          ? `device:${req.user.id}`
          : null;
    logger.log(
      req,
      "user.logout",
      req.authAmbiguous ? { reason: "ambiguous_principal" } : null,
      actor,
    );

    const cookieOpts = formatCookieOpts(0, isSecureConnection(req));
    const deviceCookieOpts = `Path=/; SameSite=Strict; Max-Age=0${isSecureConnection(req) ? "; Secure" : ""}`;

    res.setHeader("Set-Cookie", [
      `fsk_session=; HttpOnly; ${cookieOpts}`,
      `fsk_user=; ${cookieOpts}`,
      `fsk_device=; HttpOnly; ${deviceCookieOpts}`,
    ]);

    res.status(200).send();
  });
}
