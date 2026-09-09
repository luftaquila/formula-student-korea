import { sessionPicture } from "./server/input.mjs";
import { LEGACY_PERMISSION_BUNDLES } from "./server/constants.mjs";
import { createLogAggregationService } from "./server/services/logs.mjs";
import { createNotificationService } from "./server/services/notifications.mjs";
import { createOAuthService } from "./server/services/oauth.mjs";
import { createPairingService } from "./server/services/pairing.mjs";
import { createAuthStore } from "./server/store.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerLogsRoutes } from "./server/routes/logs.mjs";
import { registerContactsRoutes } from "./server/routes/contacts.mjs";
import { registerUsersRoutes } from "./server/routes/users.mjs";
import { registerApplicationsRoutes } from "./server/routes/applications.mjs";
import { registerOauthRoutes } from "./server/routes/oauth.mjs";
import { registerDevicesRoutes } from "./server/routes/devices.mjs";
import { registerSessionRoutes } from "./server/routes/session.mjs";
import { htmlPage } from "../shared/server/social-image.mjs";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/server/db-setup.mjs";
import {
  createApp,
  createDbRun,
  createSecretChecker,
  isEnvEnabled,
} from "../shared/server/express-setup.mjs";
import { access } from "../shared/common/access-control.js";
import { createLogger } from "../shared/server/logger.mjs";
import { runIfDirect } from "../shared/server/service-bootstrap.mjs";

export { sessionPicture } from "./server/input.mjs";

export function createAuthApp(options = {}) {
  const db = createDatabase(Database, options.dbPath || "./data/auth.db");

  const { ADMIN_EMAIL } = initializeSchema({ db, LEGACY_PERMISSION_BUNDLES });

  if (isEnvEnabled(process.env.TEST_SERVER)) {
    console.warn(
      "[WARNING] TEST_SERVER mode enabled — all Google logins will be auto-registered as admin",
    );
  }

  const { userAccess, validateUser, tokenHash, validateDevice, isApplicationsOpen } =
    createAuthStore({ db });

  const logger = createLogger(db, "auth");

  const { warnAggThrottled, LOG_SERVICES, logFilterHash, encodeAggCursor, decodeAggCursor } =
    createLogAggregationService({ logger });

  const { notifyNewUser } = createNotificationService({ logger });

  // validateUserCacheTtl: 0 — auth의 검증기는 로컬 인덱스 SELECT라 캐시가 무익하고,
  // auth 자신의 사용자 관리 UI는 역할 변경이 즉시 반영되어야 한다.
  const app = createApp(
    {
      express,
      logger,
      validateUser,
      validateDevice,
      validateUserCacheTtl: 0,
      validateDeviceCacheTtl: 0,
    },
    (req) => {
      if (req.path === "/api/health") return null;
      if (req.path === "/api/forward-auth") return null;
      if (req.path === "/api/session") return null;
      if (req.path === "/api/device/session") return null;
      if (req.path === "/api/device/pair") return null;
      if (["/api/login", "/api/callback", "/api/logout"].includes(req.path)) return null;
      if (req.path === "/api/devices/validate") return access.internal;
      if (/^\/api\/users\/(?:exists|access)\//.test(req.path)) return access.internal;
      if (req.path.startsWith("/api/devices")) return access.admin;
      if (req.path === "/api/access/catalog") return access.admin;
      if (req.path === "/api/internal/users") return access.internal;
      if (req.path.startsWith("/api/admin")) return access.admin;
      if (req.path.startsWith("/api/users")) return access.admin;
      if (req.path.startsWith("/api/ops-contacts") && req.method !== "GET") return access.admin;
      if (req.path.startsWith("/api/ops-contacts")) return access.official;
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (req.path.startsWith("/api/applications")) return access.admin;
      if (req.path === "/api/apply/config") return null; // 신청 가능 여부: 공개
      if (req.path.startsWith("/api/apply")) return null; // 신청자 API: 공개(핸들러가 fsk_applicant 검증)
      if (req.path.startsWith("/api/")) return access.admin; // API 기본값: default-close
      return null; // SPA
    },
  );

  // Forward auth endpoint for Caddy forward_auth (FileBrowser etc.)
  const isForwardAuthKey = createSecretChecker(process.env.INTERNAL_SECRET);

  const {
    pairingLimiter,
    pairingLimiterTimer,
    requestIp,
    pairingCodeHash,
    issuePairingCode,
    deviceResponse,
  } = createPairingService({ db });

  pairingLimiterTimer.unref();

  /* ============================================
   DB 헬퍼
   ============================================ */
  const dbRun = createDbRun();

  const {
    getApplicant,
    loginLimiter,
    checkLoginRate,
    getRedirectUri,
    sanitizeRedirect,
    isApplyRedirect,
  } = createOAuthService({ logger });

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of loginLimiter) {
      if (now > entry.resetAt) loginLimiter.delete(ip);
    }
  }, 60000).unref();

  registerSessionRoutes({ app, logger, isForwardAuthKey });

  registerDevicesRoutes({
    app,
    dbRun,
    db,
    deviceResponse,
    logger,
    issuePairingCode,
    validateDevice,
    requestIp,
    pairingLimiter,
    pairingCodeHash,
    tokenHash,
  });

  registerOauthRoutes({
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
  });

  registerApplicationsRoutes({
    app,
    isApplicationsOpen,
    getApplicant,
    db,
    logger,
    dbRun,
    notifyNewUser,
  });

  registerUsersRoutes({ app, db, userAccess, dbRun, ADMIN_EMAIL, logger, notifyNewUser });

  registerContactsRoutes({ app, dbRun, db, logger });

  registerLogsRoutes({
    app,
    logFilterHash,
    decodeAggCursor,
    LOG_SERVICES,
    db,
    logger,
    warnAggThrottled,
    encodeAggCursor,
  });

  /* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
  app.get("/{*splat}", htmlPage("index.html", "./web/dist"));

  return { app, db };
}

// auth는 골격(createServiceSkeleton)을 쓰지 않는다 — 검증기를 자기 DB 함수로 주입하고
// (validateUserCacheTtl: 0) db가 검증기 클로저보다 먼저 만들어져야 해서 createApp 호출이
// 수동이다. 부팅 블록만 공용 runIfDirect를 쓴다.
runIfDirect(import.meta, "auth", createAuthApp);
