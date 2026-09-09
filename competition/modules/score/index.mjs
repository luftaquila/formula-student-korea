import { ENDURANCE_SQL } from "./server/store.mjs";
import { createScoreEvents } from "./server/services/events.mjs";
import { createScoreCache } from "./server/services/cache.mjs";
import { createScoreCalculation } from "./server/services/calculation.mjs";
import { createScorePreflight } from "./server/services/preflight.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerEventsRoutes } from "./server/routes/events.mjs";
import { registerEnduranceRoutes } from "./server/routes/endurance.mjs";
import { registerSettingsRoutes } from "./server/routes/settings.mjs";
import { registerScoresRoutes } from "./server/routes/scores.mjs";
import { registerPublicationRoutes } from "./server/routes/publication.mjs";
import { htmlPage } from "../../../shared/server/social-image.mjs";
import express from "express";
import Database from "better-sqlite3";
import {
  createServiceSkeleton,
  addSpaFallback,
} from "../../../shared/server/service-bootstrap.mjs";
import { ensureInactiveTeamView } from "../../lib/team-status.mjs";
import { access } from "../../../shared/common/access-control.js";

export function createScoreApp(options = {}) {
  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "score",
    express,
    Database,
    options,
    authRoleFn: (req) => {
      if (req.path === "/api/health") return null;
      if (/^\/api\/score\/public\/\d{4}(?:\/events)?$/.test(req.path)) return null;
      if (/^\/public\/\d{4}$/.test(req.path)) return null;
      // 공개 페이지가 인증 없이 부트스트랩될 수 있도록 Vite 정적 자산도 공개한다.
      if (req.path.startsWith("/assets/") || req.path === "/env-config.js") return null;
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (
        req.method !== "GET" &&
        ["/api/score/publication", "/api/score/penalty", "/api/score/setting"].includes(req.path)
      )
        return access.permission("score.manage");
      return access.permission("score.operate");
    },
  });

  ensureInactiveTeamView(db);

  const { scoreTeamPreflight, parseScoreYear, validateKey } = createScorePreflight({
    dbRun,
    db,
    logger,
  });

  initializeSchema({ db });

  const { warnThrottled, computeScore } = createScoreCalculation({ logger, options, db });

  const {
    publishedYears,
    isScorePublished,
    invalidatePublicScoreCache,
    invalidateInflightScore,
    getComputedScore,
    getPublicScorePayload,
  } = createScoreCache({ db, computeScore });

  const {
    broadcastAdminEvent,
    sseHandler,
    closeAdminSse,
    broadcastPublicEvent,
    closePublicSse,
    broadcastEvent,
    handlePublicSSE,
    sourceEvent,
  } = createScoreEvents({
    logger,
    parseScoreYear,
    invalidatePublicScoreCache,
    invalidateInflightScore,
    isScorePublished,
  });

  /* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
  const publicScoreHtml = htmlPage("index.html", app.locals.staticRoot);

  registerEventsRoutes({ app, sseHandler, parseScoreYear, isScorePublished, handlePublicSSE });

  registerScoresRoutes({ app, getComputedScore, logger });

  registerSettingsRoutes({
    app,
    validateKey,
    scoreTeamPreflight,
    dbRun,
    db,
    logger,
    broadcastEvent,
  });

  registerEnduranceRoutes({
    app,
    db,
    logger,
    scoreTeamPreflight,
    dbRun,
    ENDURANCE_SQL,
    broadcastEvent,
  });

  registerPublicationRoutes({
    app,
    parseScoreYear,
    isScorePublished,
    dbRun,
    db,
    logger,
    publishedYears,
    invalidatePublicScoreCache,
    broadcastAdminEvent,
    broadcastPublicEvent,
    getPublicScorePayload,
    warnThrottled,
    publicScoreHtml,
  });

  if (!options.skipSpaFallback) addSpaFallback(app);

  return {
    app,
    db,
    sourceEvent,
    closeSse: () => {
      closeAdminSse();
      closePublicSse();
    },
  };
}
