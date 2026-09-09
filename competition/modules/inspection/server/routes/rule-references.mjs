import { parseCompetitionYear } from "../../../../../shared/common/competition-year.mjs";
import {
  serializeRuleRefs,
  refsFromRules,
  resolveRuleKeys,
  validateRuleRefs,
  RuleCatalogError,
  parseStoredRuleRefs,
  transitionRuleRefs,
} from "../../lib/rule-refs.mjs";

export function registerRuleReferencesRoutes({
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
}) {
  app.get("/api/sheet/rules/search", async (req, res) => {
    let year;
    try {
      year = parseCompetitionYear(req.query.year, { defaultCurrent: false });
    } catch {
      return res.status(400).json({ code: "INVALID_YEAR", message: "올바른 year가 필요합니다." });
    }
    const document = req.query.document ? String(req.query.document) : "";
    const query = String(req.query.q || "")
      .trim()
      .toLocaleLowerCase("ko");
    if (document && !["formula-technical", "formula-competition"].includes(document)) {
      return res
        .status(400)
        .json({ code: "INVALID_DOCUMENT", message: "올바르지 않은 규정 문서입니다." });
    }
    if (query.length > 200)
      return res
        .status(400)
        .json({ code: "INVALID_QUERY", message: "검색어는 200자 이하여야 합니다." });
    try {
      const catalog = await rulesCatalog.load(year);
      const rules = catalog.rules
        .filter((rule) => !document || rule.document === document)
        .filter(
          (rule) =>
            !query ||
            `${rule.rule_key} ${rule.citation} ${rule.text}`
              .toLocaleLowerCase("ko")
              .includes(query),
        )
        .slice(0, 100)
        .map(
          ({
            edition,
            document: ruleDocument,
            rule_key,
            clause_id,
            citation,
            text,
            content_hash,
            release_tag,
          }) => ({
            edition,
            document: ruleDocument,
            rule_key,
            clause_id,
            citation,
            text,
            content_hash,
            release_tag,
          }),
        );
      return res.json({ year, rules });
    } catch (error) {
      return ruleCatalogFailure(req, res, "rule_refs.search", error, { year, document });
    }
  });

  app.put("/api/sheet/template/:id/rule-refs", async (req, res) => {
    const id = Number(req.params.id);
    const node = templateNodePreflight(req, res, {
      action: "template.rule_refs.update",
      id,
      columns: "id, year, level, name",
    });
    if (!node) return;
    if (node.level !== "item")
      return invalidRuleRefs(
        req,
        res,
        "template.rule_refs.update",
        new Error("문항에만 규정을 연결할 수 있습니다."),
        { item_id: id, year: node.year },
      );
    const expectedRuleRefs = req.body?.expected_rule_refs;
    const status = req.body?.status;
    const ruleKeys = req.body?.rule_keys;
    if (
      expectedRuleRefs === undefined ||
      !["verified", "needs_review", "no_direct_rule"].includes(status) ||
      !Array.isArray(ruleKeys)
    ) {
      return invalidRuleRefs(
        req,
        res,
        "template.rule_refs.update",
        new Error("expected_rule_refs, status와 rule_keys 배열이 필요합니다."),
        { item_id: id, year: node.year },
      );
    }
    if (status !== "verified" && ruleKeys.length) {
      return invalidRuleRefs(
        req,
        res,
        "template.rule_refs.update",
        new Error("검증 상태에서만 규정을 연결할 수 있습니다."),
        { item_id: id, year: node.year },
      );
    }
    let value;
    let expectedSerialized;
    try {
      expectedSerialized = serializeRuleRefs(expectedRuleRefs, node.year);
      if (status === "verified") {
        const catalog = await rulesCatalog.load(node.year);
        value = refsFromRules("verified", resolveRuleKeys(catalog, ruleKeys));
      } else {
        value = validateRuleRefs({ status, references: [] }, { edition: node.year });
      }
    } catch (error) {
      if (error instanceof RuleCatalogError)
        return ruleCatalogFailure(req, res, "template.rule_refs.update", error, {
          item_id: id,
          year: node.year,
        });
      return invalidRuleRefs(req, res, "template.rule_refs.update", error, {
        item_id: id,
        year: node.year,
      });
    }
    const serialized = serializeRuleRefs(value, node.year);
    const result = dbRun(() =>
      db.transaction(() => {
        const row = db
          .prepare("SELECT rule_refs FROM sheet_template WHERE id = ? AND level = 'item'")
          .get(id);
        if (!row) throw { status: 409, message: "문항이 동시에 변경되었습니다. 다시 시도하세요." };
        const current = parseStoredRuleRefs(row.rule_refs, node.year);
        if (serializeRuleRefs(current, node.year) !== expectedSerialized)
          return { conflict: true, current };
        if (serialized === expectedSerialized) return { changed: false, current };
        const info = db
          .prepare("UPDATE sheet_template SET rule_refs = ? WHERE id = ? AND level = 'item'")
          .run(serialized, id);
        if (info.changes !== 1)
          throw { status: 409, message: "문항이 동시에 변경되었습니다. 다시 시도하세요." };
        return { changed: true, current: value };
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "template.rule_refs.update",
        { error: result.internalError || result.error, item_id: id, year: node.year },
        node.name,
      );
      return res.status(result.status).send(result.error);
    }
    if (result.result.conflict) {
      logger.warn(
        req,
        "template.rule_refs.stale_write",
        {
          code: "INSPECTION_STALE_WRITE",
          item_id: id,
          year: node.year,
          expected_rule_refs: expectedRuleRefs,
          requested: value,
          current: result.result.current,
        },
        node.name,
      );
      return res.status(409).json({
        code: "INSPECTION_STALE_WRITE",
        message: "다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하세요.",
        current: { rule_refs: result.result.current },
      });
    }
    logger.log(
      req,
      "template.rule_refs.update",
      {
        item_id: id,
        year: node.year,
        status: value.status,
        changed: result.result.changed,
        rule_keys: value.references.map((ref) => ref.rule_key),
        release_tags: [...new Set(value.references.map((ref) => ref.release_tag))],
      },
      node.name,
    );
    return res.json(value);
  });

  app.get("/api/sheet/rule-link/:itemId/:referenceIndex", async (req, res) => {
    const resolved = await resolveSheetRules(
      req,
      res,
      "rule_link.resolve",
      Number(req.params.referenceIndex),
    );
    if (res.headersSent) return;
    return res.redirect(302, resolved.rules[0].current.url);
  });

  app.get("/api/sheet/rule-content/:itemId", async (req, res) => {
    const resolved = await resolveSheetRules(req, res, "rule_content.resolve");
    if (res.headersSent) return;

    const documents = [];
    const documentIndexes = new Map();
    const referenceDocumentIndexes = new Map();
    for (const { current, referenceIndex } of resolved.rules) {
      const sourceUrl = new URL(current.url);
      sourceUrl.hash = "";
      let documentIndex = documentIndexes.get(sourceUrl.href);
      if (documentIndex === undefined) {
        documentIndex = documents.length;
        documentIndexes.set(sourceUrl.href, documentIndex);
        documents.push({
          url: sourceUrl.href,
          document: current.document,
          edition: current.edition,
          releaseTag: current.release_tag,
        });
      }
      referenceDocumentIndexes.set(referenceIndex, documentIndex);
    }

    try {
      const parsedDocuments = await Promise.all(
        documents.map(async (document, documentIndex) => {
          let source;
          try {
            source = await cacheRulePage(document);
          } catch (error) {
            logger.warn(
              req,
              "rule_content.fetch",
              {
                error: error?.message || String(error),
                item_id: resolved.itemId,
                year: resolved.year,
                phase: "rule_document_fetch",
                document_index: documentIndex,
                document: document.document,
                edition: document.edition,
                release_tag: document.releaseTag,
              },
              resolved.itemName,
            );
            throw error;
          }
          try {
            return ruleDocumentParser(source);
          } catch (error) {
            logger.warn(
              req,
              "rule_content.parse",
              {
                error: error?.message || String(error),
                item_id: resolved.itemId,
                year: resolved.year,
                phase: "rule_document_parse",
                document_index: documentIndex,
                document: document.document,
                edition: document.edition,
                release_tag: document.releaseTag,
              },
              resolved.itemName,
            );
            throw error;
          }
        }),
      );
      const rules = resolved.rules.map(({ current, referenceIndex }) => {
        const documentIndex = referenceDocumentIndexes.get(referenceIndex);
        const contentHtml = extractRulePageClause(
          parsedDocuments[documentIndex],
          current.clause_id,
        );
        if (!contentHtml) {
          logger.warn(
            req,
            "rule_content.extract",
            {
              error: "rule_clause_missing",
              item_id: resolved.itemId,
              year: resolved.year,
              phase: "rule_clause_extract",
              reference_index: referenceIndex,
              rule_key: current.rule_key,
              clause_id: current.clause_id,
              document: current.document,
              edition: current.edition,
              release_tag: current.release_tag,
            },
            resolved.itemName,
          );
          throw new Error("규정 원문에서 연결된 조항을 찾을 수 없습니다.");
        }
        return {
          reference_index: referenceIndex,
          edition: current.edition,
          document: current.document,
          rule_key: current.rule_key,
          clause_id: current.clause_id,
          citation: current.citation,
          content_hash: current.content_hash,
          release_tag: current.release_tag,
          content_html: contentHtml,
        };
      });
      return res.json({ rules });
    } catch (error) {
      return ruleLinkFailure(req, res, 503, "RULE_CONTENT_UNAVAILABLE");
    }
  });

  // 기존 템플릿 구조와 답변은 건드리지 않고, 동일한 내보내기 JSON의 rule_refs만 반영한다.
  app.post("/api/sheet/template/rule-refs/import", async (req, res) => {
    const year = Number(req.body?.year);
    if (!Number.isInteger(year) || year < 2000) {
      return invalidRuleRefs(
        req,
        res,
        "template.rule_refs.import",
        new Error("올바른 year가 필요합니다."),
        { year },
      );
    }
    let flattened;
    try {
      flattened = flattenTemplateRuleRefs(req.body?.template);
    } catch (error) {
      return invalidRuleRefs(req, res, "template.rule_refs.import", error, { year });
    }

    const storedLookup = dbRun(() =>
      db
        .prepare(
          "SELECT id, field_key FROM sheet_template WHERE year = ? AND level = 'item' ORDER BY field_key",
        )
        .all(year),
    );
    if (!storedLookup.success) {
      logger.warn(
        req,
        "template.rule_refs.import",
        {
          error: storedLookup.internalError || storedLookup.error,
          year,
          phase: "template_lookup",
        },
        String(year),
      );
      return res.status(storedLookup.status).send(storedLookup.error);
    }
    const storedItems = storedLookup.result;
    const storedKeys = storedItems.map((item) => item.field_key).sort();
    const importedKeys = flattened.map((item) => item.fieldKey).sort();
    if (
      !storedItems.length ||
      storedKeys.length !== importedKeys.length ||
      storedKeys.some((key, index) => key !== importedKeys[index])
    ) {
      return invalidRuleRefs(
        req,
        res,
        "template.rule_refs.import",
        new Error("가져오기 파일의 field_key 집합이 현재 템플릿과 정확히 일치해야 합니다."),
        {
          year,
          stored_count: storedKeys.length,
          imported_count: importedKeys.length,
        },
      );
    }

    let normalized;
    let catalog = null;
    try {
      const needsCatalog = flattened.some(({ value }) => value?.references?.length);
      catalog = needsCatalog ? await rulesCatalog.load(year) : null;
      normalized = new Map(
        flattened.map(({ fieldKey, value }) => [
          fieldKey,
          catalog ? ruleRefsForInput(value, catalog) : validateRuleRefs(value, { edition: year }),
        ]),
      );
    } catch (error) {
      if (error instanceof RuleCatalogError)
        return ruleCatalogFailure(req, res, "template.rule_refs.import", error, { year });
      return invalidRuleRefs(req, res, "template.rule_refs.import", error, { year });
    }

    const result = dbRun(() =>
      db.transaction(() => {
        const currentItems = db
          .prepare(
            "SELECT id, field_key FROM sheet_template WHERE year = ? AND level = 'item' ORDER BY field_key",
          )
          .all(year);
        const currentKeys = currentItems.map((item) => item.field_key);
        if (
          !currentItems.length ||
          currentKeys.length !== importedKeys.length ||
          currentKeys.some((key, index) => key !== importedKeys[index])
        ) {
          throw { status: 409, message: "템플릿이 동시에 변경되었습니다. 다시 시도하세요." };
        }
        const update = db.prepare(
          "UPDATE sheet_template SET rule_refs = ? WHERE id = ? AND year = ? AND level = 'item'",
        );
        const counts = { verified: 0, needs_review: 0, no_direct_rule: 0 };
        for (const item of currentItems) {
          const value = normalized.get(item.field_key);
          const info = update.run(serializeRuleRefs(value, year), item.id, year);
          if (info.changes !== 1)
            throw { status: 409, message: "템플릿이 동시에 변경되었습니다. 다시 시도하세요." };
          counts[value.status] += 1;
        }
        return counts;
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "template.rule_refs.import",
        { error: result.internalError || result.error, year },
        String(year),
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "template.rule_refs.import",
      { year, counts: result.result, ...catalogRelease(catalog) },
      String(year),
    );
    return res.json({ year, counts: result.result });
  });

  app.post("/api/sheet/template/rule-refs/sync", async (req, res) => {
    const fromYear = Number(req.body?.from_year);
    const toYear = Number(req.body?.to_year);
    if (!Number.isInteger(fromYear) || !Number.isInteger(toYear))
      return res.status(400).send("from_year, to_year가 필요합니다.");
    let catalog;
    try {
      catalog = await rulesCatalog.load(toYear);
    } catch (error) {
      return ruleCatalogFailure(req, res, "template.rule_refs.sync", error, {
        from_year: fromYear,
        year: toYear,
      });
    }

    const result = dbRun(() =>
      db.transaction(() => {
        const sourceItems = db
          .prepare(
            "SELECT field_key, rule_refs FROM sheet_template WHERE year = ? AND level = 'item' AND field_key != ''",
          )
          .all(fromYear);
        const targetItems = db
          .prepare(
            "SELECT id, field_key, rule_refs FROM sheet_template WHERE year = ? AND level = 'item' AND field_key != ''",
          )
          .all(toYear);
        if (!sourceItems.length || !targetItems.length)
          throw { status: 400, message: "동기화할 원본 또는 대상 템플릿이 없습니다." };
        const sourceByKey = new Map(sourceItems.map((item) => [item.field_key, item]));
        const update = db.prepare("UPDATE sheet_template SET rule_refs = ? WHERE id = ?");
        const counts = {
          verified: 0,
          needs_review: 0,
          no_direct_rule: 0,
          skipped_verified: 0,
          missing_field_key: 0,
        };
        const reasons = {};
        for (const target of targetItems) {
          const current = parseStoredRuleRefs(target.rule_refs, toYear);
          if (current.status !== "needs_review") {
            counts.skipped_verified += 1;
            continue;
          }
          const source = sourceByKey.get(target.field_key);
          if (!source) {
            counts.missing_field_key += 1;
            continue;
          }
          const transitioned = transitionRuleRefs(
            parseStoredRuleRefs(source.rule_refs, fromYear),
            catalog,
          );
          const { reason, ...value } = transitioned;
          update.run(serializeRuleRefs(value, toYear), target.id);
          counts[value.status] += 1;
          reasons[reason] = (reasons[reason] || 0) + 1;
        }
        return { counts, reasons };
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "template.rule_refs.sync",
        { error: result.internalError || result.error, from_year: fromYear, to_year: toYear },
        `${fromYear}->${toYear}`,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "template.rule_refs.sync",
      { from_year: fromYear, to_year: toYear, ...result.result, ...catalogRelease(catalog) },
      `${fromYear}->${toYear}`,
    );
    return res.json({ from_year: fromYear, to_year: toYear, ...result.result });
  });

  app.post("/api/sheet/template/rule-refs/revalidate", async (req, res) => {
    const year = Number(req.body?.year);
    if (!Number.isInteger(year)) return res.status(400).send("year가 필요합니다.");
    let catalog;
    try {
      catalog = await rulesCatalog.load(year, { force: true });
    } catch (error) {
      return ruleCatalogFailure(req, res, "template.rule_refs.revalidate", error, { year });
    }

    const result = dbRun(() =>
      db.transaction(() => {
        const items = db
          .prepare("SELECT id, rule_refs FROM sheet_template WHERE year = ? AND level = 'item'")
          .all(year);
        const update = db.prepare("UPDATE sheet_template SET rule_refs = ? WHERE id = ?");
        const counts = { verified: 0, needs_review: 0, no_direct_rule: 0, changed: 0, missing: 0 };
        for (const item of items) {
          const source = parseStoredRuleRefs(item.rule_refs, year);
          let value = source;
          if (source.status === "verified") {
            const transitioned = transitionRuleRefs(source, catalog);
            const { reason, ...next } = transitioned;
            value = next;
            if (reason === "content_changed") counts.changed += 1;
            if (reason === "rule_key_missing") counts.missing += 1;
          } else if (source.status === "needs_review" && source.references.length) {
            const currentRules = source.references.map((ref) => catalog.byKey.get(ref.rule_key));
            if (currentRules.every(Boolean)) value = refsFromRules("needs_review", currentRules);
            else {
              value = { status: "needs_review", references: [] };
              counts.missing += 1;
            }
          }
          update.run(serializeRuleRefs(value, year), item.id);
          counts[value.status] += 1;
        }
        return counts;
      })(),
    );
    if (!result.success) {
      logger.warn(
        req,
        "template.rule_refs.revalidate",
        { error: result.internalError || result.error, year },
        String(year),
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(
      req,
      "template.rule_refs.revalidate",
      { year, counts: result.result, ...catalogRelease(catalog) },
      String(year),
    );
    return res.json({ year, counts: result.result });
  });
}
