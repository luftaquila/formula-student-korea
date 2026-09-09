import {
  createRulesCatalog,
  DEFAULT_RULES_BASE_URL,
  validateRuleRefs,
  transitionRuleRefs,
  resolveRuleKeys,
  refsFromRules,
  EMPTY_RULE_REFS,
  parseStoredRuleRefs,
} from "../../lib/rule-refs.mjs";
import { serialize, serializeOuter } from "parse5";

export function createRuleReferenceService({ options, parseRuleDocument, logger, dbRun, db }) {
  const rulesFetch = options.rulesFetch || globalThis.fetch;

  const ruleDocumentParser = options.ruleDocumentParser || parseRuleDocument;

  const rulesCatalog = createRulesCatalog({
    baseUrl: options.rulesBaseUrl || process.env.RULES_BASE_URL || DEFAULT_RULES_BASE_URL,
    fetchImpl: rulesFetch,
    ...(options.rulesCatalogOptions || {}),
  });

  const rulePageCache = new Map();

  const RULE_PAGE_CACHE_LIMIT = 16;

  function ruleCatalogFailure(req, res, action, error, context = {}) {
    const detail = {
      error: error?.message || String(error),
      code: error?.code || "RULE_CATALOG_UNAVAILABLE",
      phase: "rule_catalog",
      ...context,
    };
    logger.warn(req, action, detail, context.year ? String(context.year) : "rules");
    return res.status(503).json({
      code: "RULE_CATALOG_UNAVAILABLE",
      message: "규정 카탈로그를 확인할 수 없습니다. 잠시 후 다시 시도하세요.",
    });
  }

  function invalidRuleRefs(req, res, action, error, context = {}) {
    logger.warn(
      req,
      action,
      {
        error: error?.message || String(error),
        phase: "rule_refs_validation",
        ...context,
      },
      context.item_id ? `template:${context.item_id}` : "rules",
    );
    return res
      .status(400)
      .json({ code: "INVALID_RULE_REFS", message: error?.message || String(error) });
  }

  // 감사 로그에 어떤 배포본·문서 Release를 기준으로 판단했는지 남긴다.
  function catalogRelease(catalog) {
    if (!catalog) return {};
    return {
      catalog_site_tag: catalog.deployment.site_tag,
      catalog_releases: catalog.documents.map((doc) => doc.release_tag),
    };
  }

  function ruleRefsForInput(value, catalog) {
    const parsed = validateRuleRefs(value);
    if (parsed.status === "no_direct_rule") return { status: "no_direct_rule", references: [] };
    if (!parsed.references.length) return { status: "needs_review", references: [] };
    if (parsed.status === "verified") {
      // Follow stable keys across both annual and same-edition revisions. An imported
      // verification remains valid only when every clause still has the reviewed text.
      const { reason, ...transitioned } = transitionRuleRefs(parsed, catalog);
      return transitioned;
    }
    const rules = resolveRuleKeys(
      catalog,
      parsed.references.map((ref) => ref.rule_key),
    );
    return refsFromRules("needs_review", rules);
  }

  function flattenTemplateRuleRefs(
    template,
    { requireFieldKeys = true, requireRuleRefs = true } = {},
  ) {
    if (!Array.isArray(template)) throw new Error("template 배열이 필요합니다.");
    const result = [];
    const list = (value) => (Array.isArray(value) ? value : []);
    for (const category of template) {
      for (const subcategory of list(category?.subcategories)) {
        for (const group of list(subcategory?.groups)) {
          for (const item of list(group?.items)) {
            if (
              requireFieldKeys &&
              (typeof item?.field_key !== "string" || !item.field_key.trim())
            ) {
              throw new Error("모든 문항에 field_key가 필요합니다.");
            }
            if (requireRuleRefs && item.rule_refs === undefined)
              throw new Error(`${item.field_key}: rule_refs가 필요합니다.`);
            if (typeof item?.field_key === "string" && item.field_key.trim()) {
              result.push({
                fieldKey: item.field_key.trim(),
                value: item.rule_refs ?? EMPTY_RULE_REFS,
              });
            }
          }
        }
      }
    }
    const keys = result.map((item) => item.fieldKey);
    if (new Set(keys).size !== keys.length)
      throw new Error("가져오기 파일에 중복 field_key가 있습니다.");
    return result;
  }

  // `원문` 링크는 새 탭으로 직접 열리므로, 브라우저 탐색에는 JSON 대신 읽을 수 있는
  // 안내 페이지를 준다. API 호출(Accept: */*, application/json)은 JSON을 유지한다.
  const RULE_LINK_MESSAGES = Object.freeze({
    INVALID_RULE_REFERENCE: "올바르지 않은 규정 연결 요청입니다.",
    ITEM_NOT_FOUND: "문항을 찾을 수 없습니다.",
    INVALID_STORED_RULE_REFS: "저장된 규정 연결을 읽을 수 없습니다. 관리자에게 알려주세요.",
    RULE_REFERENCE_NOT_VERIFIED: "이 문항의 규정 연결은 아직 검토 중입니다.",
    RULE_REFERENCE_MISSING: "연결된 규정 조항이 현재 규정집에서 사라졌습니다. 재검증이 필요합니다.",
    RULE_REFERENCE_CHANGED: "연결된 규정 조항의 내용이 바뀌었습니다. 재검증이 필요합니다.",
    RULE_CATALOG_UNAVAILABLE: "규정 카탈로그를 확인할 수 없습니다. 잠시 후 다시 시도하세요.",
    RULE_CONTENT_UNAVAILABLE: "규정 원문을 불러올 수 없습니다. 잠시 후 다시 시도하세요.",
  });

  function ruleLinkFailure(req, res, status, code) {
    const message = RULE_LINK_MESSAGES[code] || code;
    if (req.accepts(["json", "html"]) === "html") {
      const escaped = message.replace(
        /[&<>"]/g,
        (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
      );
      return res
        .status(status)
        .type("html")
        .send(
          `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>규정 연결</title></head><body><p>${escaped}</p></body></html>`,
        );
    }
    return res.status(status).json({ code, message });
  }

  async function resolveSheetRules(req, res, action, requestedReferenceIndex = null) {
    const itemId = Number(req.params.itemId);
    if (
      !Number.isInteger(itemId) ||
      (requestedReferenceIndex !== null &&
        (!Number.isInteger(requestedReferenceIndex) || requestedReferenceIndex < 0))
    ) {
      return ruleLinkFailure(req, res, 400, "INVALID_RULE_REFERENCE");
    }
    const lookup = dbRun(() =>
      db
        .prepare(
          "SELECT id, year, name, rule_refs FROM sheet_template WHERE id = ? AND level = 'item'",
        )
        .get(itemId),
    );
    if (!lookup.success) {
      logger.warn(
        req,
        action,
        { error: lookup.internalError || lookup.error, item_id: itemId, phase: "item_lookup" },
        `template:${itemId}`,
      );
      return res.status(lookup.status).send(lookup.error);
    }
    if (!lookup.result) {
      logger.warn(
        req,
        action,
        { error: "item_not_found", item_id: itemId, phase: "item_lookup" },
        `template:${itemId}`,
      );
      return ruleLinkFailure(req, res, 404, "ITEM_NOT_FOUND");
    }
    let stored;
    try {
      stored = parseStoredRuleRefs(lookup.result.rule_refs, lookup.result.year);
    } catch (error) {
      logger.warn(
        req,
        action,
        {
          error: error.message,
          item_id: itemId,
          year: lookup.result.year,
          phase: "stored_rule_refs",
        },
        lookup.result.name,
      );
      return ruleLinkFailure(req, res, 500, "INVALID_STORED_RULE_REFS");
    }
    const references =
      requestedReferenceIndex === null
        ? stored.references.map((reference, referenceIndex) => ({ reference, referenceIndex }))
        : [
            {
              reference: stored.references[requestedReferenceIndex],
              referenceIndex: requestedReferenceIndex,
            },
          ];
    if (
      stored.status !== "verified" ||
      references.length === 0 ||
      references.some(({ reference }) => !reference)
    ) {
      logger.warn(
        req,
        action,
        {
          error: "rule_reference_not_verified",
          item_id: itemId,
          year: lookup.result.year,
          reference_index: requestedReferenceIndex,
        },
        lookup.result.name,
      );
      return ruleLinkFailure(req, res, 409, "RULE_REFERENCE_NOT_VERIFIED");
    }
    try {
      const catalog = await rulesCatalog.load(lookup.result.year);
      const resolved = [];
      for (const { reference, referenceIndex } of references) {
        const current = catalog.byKey.get(reference.rule_key);
        if (!current) {
          logger.warn(
            req,
            action,
            {
              error: "rule_reference_missing",
              item_id: itemId,
              year: lookup.result.year,
              reference_index: referenceIndex,
              rule_key: reference.rule_key,
            },
            lookup.result.name,
          );
          return ruleLinkFailure(req, res, 409, "RULE_REFERENCE_MISSING");
        }
        if (current.content_hash !== reference.source_hash) {
          logger.warn(
            req,
            action,
            {
              error: "rule_reference_changed",
              item_id: itemId,
              year: lookup.result.year,
              reference_index: referenceIndex,
              rule_key: reference.rule_key,
            },
            lookup.result.name,
          );
          return ruleLinkFailure(req, res, 409, "RULE_REFERENCE_CHANGED");
        }
        resolved.push({ current, referenceIndex });
      }
      return { rules: resolved, itemId, itemName: lookup.result.name, year: lookup.result.year };
    } catch (error) {
      if (req.accepts(["json", "html"]) === "html") {
        logger.warn(
          req,
          action,
          {
            error: error?.message || String(error),
            code: error?.code || "RULE_CATALOG_UNAVAILABLE",
            phase: "rule_catalog",
            item_id: itemId,
            year: lookup.result.year,
          },
          lookup.result.name,
        );
        return ruleLinkFailure(req, res, 503, "RULE_CATALOG_UNAVAILABLE");
      }
      return ruleCatalogFailure(req, res, action, error, {
        item_id: itemId,
        year: lookup.result.year,
      });
    }
  }

  async function fetchRulePage(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const maxBytes = 2 * 1024 * 1024;
    try {
      const response = await rulesFetch(url, {
        headers: { accept: "text/html" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response?.ok)
        throw new Error(`규정 페이지가 HTTP ${response?.status ?? "오류"}를 반환했습니다.`);
      if (
        !String(response.headers?.get?.("content-type") || "")
          .toLowerCase()
          .startsWith("text/html")
      ) {
        throw new Error("규정 페이지가 HTML을 반환하지 않았습니다.");
      }
      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes)
        throw new Error("규정 페이지 응답이 너무 큽니다.");
      if (!response.body?.getReader) {
        const body = Buffer.from(await response.arrayBuffer());
        if (body.byteLength > maxBytes) throw new Error("규정 페이지 응답이 너무 큽니다.");
        return body.toString("utf8");
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("규정 페이지 응답이 너무 큽니다.");
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size).toString("utf8");
    } finally {
      clearTimeout(timeout);
    }
  }

  function cacheRulePage(document) {
    const key = `${document.releaseTag}:${document.url}`;
    const cached = rulePageCache.get(key);
    if (cached) {
      rulePageCache.delete(key);
      rulePageCache.set(key, cached);
      return cached;
    }

    const pending = fetchRulePage(document.url);
    rulePageCache.set(key, pending);
    while (rulePageCache.size > RULE_PAGE_CACHE_LIMIT) {
      rulePageCache.delete(rulePageCache.keys().next().value);
    }
    void pending.catch(() => {
      if (rulePageCache.get(key) === pending) rulePageCache.delete(key);
    });
    return pending;
  }

  function htmlNodeId(node) {
    return node.attrs?.find((attribute) => attribute.name === "id")?.value || "";
  }

  function findHtmlNodeById(node, id) {
    if (htmlNodeId(node) === id) return node;
    for (const child of node.childNodes || []) {
      const found = findHtmlNodeById(child, id);
      if (found) return found;
    }
    return null;
  }

  function extractRulePageClause(parsedDocument, clauseId) {
    const target = findHtmlNodeById(parsedDocument, clauseId);
    if (!target) return "";
    if (target.tagName !== "h2") return serialize(target).trim();

    const siblings = target.parentNode?.childNodes || [];
    const start = siblings.indexOf(target);
    const selected = [];
    for (let index = start; index >= 0 && index < siblings.length; index += 1) {
      const sibling = siblings[index];
      if (!sibling.tagName) continue;
      if (
        selected.length &&
        (["h1", "h2"].includes(sibling.tagName) || htmlNodeId(sibling) === "rules-index-end")
      )
        break;
      selected.push(serializeOuter(sibling));
    }
    return selected.join("").trim();
  }

  return {
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
  };
}
