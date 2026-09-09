import { parseRuleDocument } from "./server/input.mjs";
import { createInspectionEvents } from "./server/services/events.mjs";
import { createRuleReferenceService } from "./server/services/rules.mjs";
import { createTemplateService } from "./server/services/templates.mjs";
import { createInspectionStore } from "./server/store.mjs";
import { createInspectionPreflight } from "./server/services/preflight.mjs";
import { initializeSchema } from "./server/schema.mjs";
import { registerEventsRoutes } from "./server/routes/events.mjs";
import { registerQueriesRoutes } from "./server/routes/queries.mjs";
import { registerAnswersRoutes } from "./server/routes/answers.mjs";
import { registerRuleReferencesRoutes } from "./server/routes/rule-references.mjs";
import { registerTemplatesRoutes } from "./server/routes/templates.mjs";
import express from "express";
import Database from "better-sqlite3";
import {
  createServiceSkeleton,
  addSpaFallback,
} from "../../../shared/server/service-bootstrap.mjs";
import { ensureInactiveTeamView } from "../../lib/team-status.mjs";
import { access } from "../../../shared/common/access-control.js";

export { parseRuleDocument } from "./server/input.mjs";

export function createInspectionApp(options = {}) {
  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "inspection",
    express,
    Database,
    options: {
      ...options,
      // 템플릿 전체/규정 연결 가져오기 JSON은 수백 kB라 이 두 경로만 1mb를 허용한다.
      jsonLimit: options.jsonLimit || "1mb",
      jsonLimitPaths: options.jsonLimitPaths || [
        "/api/sheet/template/import",
        "/api/sheet/template/rule-refs/import",
      ],
    },
    dbFile: "sheet.db",
    authRoleFn: (req) => {
      if (req.path === "/api/health") return null;
      if (req.path.startsWith("/api/internal/")) return access.internal;
      if (req.path.startsWith("/api/sheet/template") && req.method !== "GET")
        return access.permission("inspection.manage");
      if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
      if (req.path.startsWith("/api/")) return access.permission("inspection.operate");
      return access.permission("inspection.operate"); // SPA
    },
  });

  const {
    ruleDocumentParser,
    rulesCatalog,
    ruleCatalogFailure,
    invalidRuleRefs,
    catalogRelease,
    ruleRefsForInput,
    flattenTemplateRuleRefs,
    ruleLinkFailure,
    resolveSheetRules,
    cacheRulePage,
    extractRulePageClause,
  } = createRuleReferenceService({ options, parseRuleDocument, logger, dbRun, db });

  ensureInactiveTeamView(db);

  const { teamPreflight, templateNodePreflight, mutationTemplatePreflight } =
    createInspectionPreflight({ logger, dbRun, db });

  initializeSchema({ db });

  const {
    parseInspectorNames,
    addInspectorForItemEdit,
    validateStoredCalculationGraph,
    getCategoryCompletion,
    getInspectionSummary,
    getBulkAnswers,
  } = createInspectionStore({ db, parseExcludedTypes: (...args) => parseExcludedTypes(...args) });

  const {
    broadcastSSEEvent,
    sseHandler,
    closeSse,
    revalidateSse,
    broadcastEvent,
    revalidateSsePermission,
  } = createInspectionEvents({ logger, options, app });

  const {
    parseExcludedTypes,
    normalizeExcludedTypes,
    getTemplateTree,
    TEMPLATE_LEVELS,
    TEMPLATE_ANSWER_TYPES,
    normalizeStoredCounterAnswer,
  } = createTemplateService({ db, logger });

  registerEventsRoutes({ app, sseHandler, revalidateSsePermission });

  registerRuleReferencesRoutes({
    app,
    rulesCatalog,
    ruleCatalogFailure,
    templateNodePreflight,
    invalidRuleRefs,
    dbRun,
    db,
    logger,
    resolveSheetRules,
    cacheRulePage,
    ruleDocumentParser,
    extractRulePageClause,
    ruleLinkFailure,
    flattenTemplateRuleRefs,
    ruleRefsForInput,
    catalogRelease,
  });

  registerTemplatesRoutes({
    app,
    dbRun,
    getTemplateTree,
    logger,
    TEMPLATE_LEVELS,
    TEMPLATE_ANSWER_TYPES,
    normalizeExcludedTypes,
    db,
    validateStoredCalculationGraph,
    templateNodePreflight,
    normalizeStoredCounterAnswer,
    rulesCatalog,
    flattenTemplateRuleRefs,
    ruleRefsForInput,
    ruleCatalogFailure,
    invalidRuleRefs,
  });

  registerQueriesRoutes({
    app,
    dbRun,
    getInspectionSummary,
    getBulkAnswers,
    teamPreflight,
    db,
    parseInspectorNames,
  });

  registerAnswersRoutes({
    app,
    teamPreflight,
    mutationTemplatePreflight,
    dbRun,
    db,
    addInspectorForItemEdit,
    logger,
    broadcastEvent,
    getCategoryCompletion,
  });

  if (!options.skipSpaFallback) addSpaFallback(app);

  return {
    app,
    db,
    closeSse,
    revalidateSse,
    sourceEvent: broadcastSSEEvent,
    queries: {
      templateTree: getTemplateTree,
      summary: getInspectionSummary,
      bulkAnswers: getBulkAnswers,
    },
  };
}
