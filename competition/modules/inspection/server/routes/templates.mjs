import { serializeCalculationConfig } from "../../lib/calculations.mjs";
import { randomUUID } from "node:crypto";
import {
  EMPTY_RULE_REFS,
  parseStoredRuleRefs,
  transitionRuleRefs,
  serializeRuleRefs,
  validateRuleRefs,
  RuleCatalogError,
} from "../../lib/rule-refs.mjs";
import { isCompetitionPreparationYear } from "../../../../../shared/common/competition-year.mjs";

export function registerTemplatesRoutes({
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
}) {
  // GET /api/sheet/template - 연도별 템플릿 트리 반환
  app.get("/api/sheet/template", (req, res) => {
    const year = Number(req.query.year);
    if (!year) return res.status(400).send("연도를 지정해야 합니다.");

    const result = dbRun(() => getTemplateTree(year, req));

    if (!result.success) {
      logger.warn(
        req,
        "template.read",
        { error: result.internalError || result.error, year },
        String(year),
      );
      return res.status(result.status).send(result.error);
    }
    res.json(result.result);
  });

  // POST /api/sheet/template - 노드 생성
  app.post("/api/sheet/template", (req, res) => {
    const {
      year,
      level,
      parent_id,
      name,
      sort_order,
      answer_type,
      remarks,
      unit,
      pdf_include,
      excluded_types,
      calculation,
    } = req.body;
    if (!year || !level || !name) return res.status(400).send("필수 필드가 누락되었습니다.");
    if (!TEMPLATE_LEVELS.includes(level))
      return res.status(400).send("올바르지 않은 level 값입니다.");
    if (answer_type && !TEMPLATE_ANSWER_TYPES.includes(answer_type))
      return res.status(400).send("올바르지 않은 answer_type 값입니다.");
    const excluded = excluded_types === undefined ? "" : normalizeExcludedTypes(excluded_types);
    if (excluded === null) return res.status(400).send("올바르지 않은 excluded_types 값입니다.");
    if (calculation && (level !== "item" || answer_type !== "number")) {
      return res.status(400).send("숫자 문항에만 계산을 설정할 수 있습니다.");
    }
    let storedCalculation = "";
    try {
      storedCalculation = serializeCalculationConfig(calculation);
    } catch (e) {
      return res.status(400).send(e.message);
    }
    const fieldKey = level === "item" ? `item-${randomUUID()}` : "";

    const result = dbRun(() =>
      db.transaction(() => {
        const info = db
          .prepare(
            "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation, rule_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            year,
            level,
            parent_id || null,
            sort_order || 0,
            name,
            answer_type || null,
            remarks || "",
            unit || "",
            pdf_include ?? 1,
            excluded,
            fieldKey,
            storedCalculation,
            JSON.stringify(EMPTY_RULE_REFS),
          );
        validateStoredCalculationGraph(year);
        return info;
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "template.create",
        { error: result.internalError || result.error, year },
        name,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "template.create", { year, level }, name);
    res.json({ id: result.result.lastInsertRowid, field_key: fieldKey });
  });

  // PUT /api/sheet/template/:id - 노드 수정
  app.put("/api/sheet/template/:id", (req, res) => {
    const id = Number(req.params.id);
    // 수정 가능 필드는 아래 구조 분해로 고정된다 — body의 다른 키는 도달 불가
    const {
      name,
      sort_order,
      answer_type,
      remarks,
      unit,
      pdf_include,
      excluded_types,
      calculation,
    } = req.body;
    if (answer_type && !TEMPLATE_ANSWER_TYPES.includes(answer_type))
      return res.status(400).send("올바르지 않은 answer_type 값입니다.");

    const fields = [];
    const params = [];
    if (name !== undefined) {
      fields.push("name = ?");
      params.push(name);
    }
    if (sort_order !== undefined) {
      fields.push("sort_order = ?");
      params.push(sort_order);
    }
    if (answer_type !== undefined) {
      fields.push("answer_type = ?");
      params.push(answer_type || null);
    }
    if (remarks !== undefined) {
      fields.push("remarks = ?");
      params.push(remarks);
    }
    if (unit !== undefined) {
      fields.push("unit = ?");
      params.push(unit);
    }
    if (pdf_include !== undefined) {
      fields.push("pdf_include = ?");
      params.push(pdf_include ? 1 : 0);
    }
    if (excluded_types !== undefined) {
      const excluded = normalizeExcludedTypes(excluded_types);
      if (excluded === null) return res.status(400).send("올바르지 않은 excluded_types 값입니다.");
      fields.push("excluded_types = ?");
      params.push(excluded);
    }
    if (calculation !== undefined) {
      let storedCalculation;
      try {
        storedCalculation = serializeCalculationConfig(calculation);
      } catch (e) {
        return res.status(400).send(e.message);
      }
      fields.push("calculation = ?");
      params.push(storedCalculation);
    }

    if (!fields.length) return res.status(400).send("수정할 필드가 없습니다.");

    const node = templateNodePreflight(req, res, {
      action: "template.update",
      id,
      columns: "name, level, year, answer_type, calculation",
    });
    if (!node) return;
    const resultingAnswerType = answer_type === undefined ? node.answer_type : answer_type || null;
    if (calculation && (node.level !== "item" || resultingAnswerType !== "number")) {
      return res.status(400).send("숫자 문항에만 계산을 설정할 수 있습니다.");
    }
    if (
      answer_type !== undefined &&
      resultingAnswerType !== "number" &&
      calculation === undefined &&
      node.calculation
    ) {
      fields.push("calculation = ?");
      params.push("");
    }
    params.push(id);

    const result = dbRun(() =>
      db.transaction(() => {
        const update = db
          .prepare(`UPDATE sheet_template SET ${fields.join(", ")} WHERE id = ?`)
          .run(...params);
        validateStoredCalculationGraph(node.year);
        let normalizedAnswers = 0;
        const nextAnswerType = answer_type || null;

        if (
          answer_type !== undefined &&
          node.level === "item" &&
          ["counter", "stopwatch"].includes(nextAnswerType)
        ) {
          const rows = db
            .prepare("SELECT year, team_num, value FROM sheet_answer WHERE item_id = ?")
            .all(id);
          const normalizeAnswer = db.prepare(`
        UPDATE sheet_answer
        SET value = ?,
            answer_updated_at = ?,
            answer_updated_by = ?
        WHERE year = ? AND team_num = ? AND item_id = ?
      `);
          const updatedAt = new Date().toISOString();
          const updatedBy = req.user?.realname?.trim() || "";

          for (const row of rows) {
            const normalized =
              nextAnswerType === "stopwatch" ? "" : normalizeStoredCounterAnswer(row.value);
            if (row.value === normalized) continue;
            if (!updatedBy) {
              throw {
                status: 409,
                message: "계정 실명을 확인할 수 없어 저장할 수 없습니다. 다시 로그인하세요.",
              };
            }
            normalizedAnswers += normalizeAnswer.run(
              normalized,
              updatedAt,
              updatedBy,
              row.year,
              row.team_num,
              id,
            ).changes;
          }
        }

        return { changes: update.changes, normalizedAnswers };
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "template.update",
        { error: result.internalError || result.error },
        node.name,
      );
      return res.status(result.status).send(result.error);
    }
    if (!result.result.changes) {
      logger.warn(
        req,
        "template.update",
        { error: "항목을 찾을 수 없습니다 (동시 삭제 추정)", id, year: node.year },
        node.name,
      );
      return res.status(404).send("항목을 찾을 수 없습니다.");
    }
    logger.log(
      req,
      "template.update",
      {
        fields: Object.fromEntries(fields.map((f, i) => [f.split(" = ")[0], params[i]])),
        normalized_answers: result.result.normalizedAnswers,
      },
      node.name,
    );
    res.status(200).send();
  });

  // DELETE /api/sheet/template/:id - 노드 삭제 (CASCADE)
  app.delete("/api/sheet/template/:id", (req, res) => {
    const id = Number(req.params.id);
    const node = templateNodePreflight(req, res, {
      action: "template.delete",
      id,
      columns: "year, level, name",
    });
    if (!node) return;
    if (!isCompetitionPreparationYear(node.year)) {
      logger.warn(
        req,
        "template.delete",
        { error: "쓰기 허용 범위 밖 템플릿 삭제 거부", year: node.year },
        node.name,
      );
      return res.status(409).send("현재 또는 다음 연도 템플릿만 수정할 수 있습니다.");
    }

    const result = dbRun(() =>
      db.transaction(() => {
        const info = db.prepare("DELETE FROM sheet_template WHERE id = ?").run(id);
        validateStoredCalculationGraph(node.year);
        return info;
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "template.delete",
        { error: result.internalError || result.error },
        node.name,
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "template.delete", { year: node.year, level: node.level, id }, node.name);
    res.status(200).send();
  });

  // POST /api/sheet/template/reorder - 형제 노드 순서 변경
  app.post("/api/sheet/template/reorder", (req, res) => {
    const { items } = req.body;
    const rejectReorder = (status, message, context = {}) => {
      logger.warn(
        req,
        "template.reorder",
        {
          error: message,
          phase: "batch_preflight",
          ...context,
        },
        "batch",
      );
      return res.status(status).send(message);
    };
    if (!Array.isArray(items)) return rejectReorder(400, "items 배열이 필요합니다.");
    if (items.length === 0)
      return rejectReorder(400, "하나 이상의 항목이 필요합니다.", { count: 0 });
    if (items.length > 1000)
      return rejectReorder(400, "항목이 너무 많습니다.", { count: items.length });
    for (const item of items) {
      if (!Number.isInteger(item.id) || item.id < 1 || !Number.isInteger(item.sort_order)) {
        return rejectReorder(400, "각 항목에 유효한 id와 sort_order가 필요합니다.", {
          count: items.length,
          invalid_item: item,
        });
      }
    }
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      return rejectReorder(400, "중복된 항목 id가 있습니다.", {
        count: items.length,
        requested_ids: ids,
      });
    }

    let failureContext = {};
    const result = dbRun(() => {
      const stmt = db.prepare("UPDATE sheet_template SET sort_order = ? WHERE id = ?");
      return db.transaction(() => {
        const rows = db
          .prepare(
            `
        SELECT id, year, level, parent_id
        FROM sheet_template
        WHERE id IN (${ids.map(() => "?").join(",")})
      `,
          )
          .all(...ids);
        if (rows.length !== ids.length) {
          const found = new Set(rows.map((row) => row.id));
          failureContext = {
            reason_code: "missing_ids",
            missing_ids: ids.filter((id) => !found.has(id)),
          };
          throw { status: 404, message: "항목을 찾을 수 없습니다." };
        }
        const [first] = rows;
        const sameSiblings = rows.every(
          (row) =>
            row.year === first.year &&
            row.level === first.level &&
            row.parent_id === first.parent_id,
        );
        if (!sameSiblings) {
          failureContext = {
            reason_code: "mixed_siblings",
            nodes: rows.map(({ id, year, level, parent_id }) => ({ id, year, level, parent_id })),
          };
          throw { status: 400, message: "같은 연도와 부모의 형제 항목만 함께 정렬할 수 있습니다." };
        }
        if (!isCompetitionPreparationYear(first.year)) {
          failureContext = { reason_code: "read_only_year", year: first.year };
          throw { status: 409, message: "현재 또는 다음 연도 템플릿만 수정할 수 있습니다." };
        }
        let count = 0;
        for (const item of items) {
          const update = stmt.run(item.sort_order, item.id);
          if (update.changes !== 1) {
            failureContext = {
              reason_code: "update_count_mismatch",
              id: item.id,
              changes: update.changes,
            };
            throw { status: 409, message: "템플릿 순서가 동시에 변경되었습니다. 다시 시도하세요." };
          }
          count += update.changes;
        }
        return { count, year: first.year, level: first.level, parentId: first.parent_id };
      })();
    });

    if (!result.success) {
      logger.warn(
        req,
        "template.reorder",
        {
          error: result.internalError || result.error,
          phase: "batch_preflight",
          requested_count: items.length,
          requested_ids: ids,
          ...failureContext,
        },
        "batch",
      );
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "template.reorder", result.result, String(result.result.year));
    res.status(200).send();
  });

  // POST /api/sheet/template/copy - 연도간 템플릿 복사
  app.post("/api/sheet/template/copy", async (req, res) => {
    const { from_year, to_year } = req.body;
    if (!from_year || !to_year) return res.status(400).send("from_year, to_year가 필요합니다.");

    const preflight = dbRun(() => ({
      referencedCount: db
        .prepare(
          "SELECT COUNT(*) as cnt FROM sheet_template WHERE year = ? AND level = 'item' AND json_array_length(rule_refs, '$.references') > 0",
        )
        .get(from_year).cnt,
      targetCount: db
        .prepare("SELECT COUNT(*) as cnt FROM sheet_template WHERE year = ?")
        .get(to_year).cnt,
      sourceCount: db
        .prepare("SELECT COUNT(*) as cnt FROM sheet_template WHERE year = ?")
        .get(from_year).cnt,
    }));
    if (!preflight.success) {
      logger.warn(req, "template.copy", {
        error: preflight.internalError || preflight.error,
        from_year,
        to_year,
        phase: "preflight",
      });
      return res.status(preflight.status).send(preflight.error);
    }
    if (preflight.result.targetCount > 0 || preflight.result.sourceCount === 0) {
      const message =
        preflight.result.targetCount > 0
          ? "대상 연도에 이미 템플릿이 존재합니다."
          : "원본 연도에 템플릿이 없습니다.";
      logger.warn(req, "template.copy", { error: message, from_year, to_year, phase: "preflight" });
      return res.status(400).send(message);
    }

    let targetCatalog = null;
    let catalogError = null;
    const catalogRequired = preflight.result.referencedCount > 0;
    if (catalogRequired) {
      try {
        targetCatalog = await rulesCatalog.load(Number(to_year));
      } catch (error) {
        catalogError = error;
        logger.warn(
          req,
          "template.copy",
          {
            error: error?.message || String(error),
            code: error?.code,
            phase: "rule_catalog",
            from_year,
            to_year,
          },
          `${from_year}->${to_year}`,
        );
      }
    }

    const result = dbRun(() => {
      const existing = db
        .prepare("SELECT COUNT(*) as cnt FROM sheet_template WHERE year = ?")
        .get(to_year);
      if (existing.cnt > 0) throw { status: 400, message: "대상 연도에 이미 템플릿이 존재합니다." };

      const rows = db
        .prepare("SELECT * FROM sheet_template WHERE year = ? ORDER BY id")
        .all(from_year);
      if (!rows.length) throw { status: 400, message: "원본 연도에 템플릿이 없습니다." };

      return db.transaction(() => {
        const idMap = {};
        const stmt = db.prepare(
          "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation, rule_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const reasons = {};
        const statuses = { verified: 0, needs_review: 0, no_direct_rule: 0 };
        for (const r of rows) {
          const newParent = r.parent_id ? idMap[r.parent_id] : null;
          let nextRuleRefs = EMPTY_RULE_REFS;
          let reason = "not_item";
          if (r.level === "item") {
            const source = parseStoredRuleRefs(r.rule_refs, Number(from_year));
            if (source.status === "no_direct_rule") {
              nextRuleRefs = { status: "no_direct_rule", references: [] };
              reason = "no_direct_rule";
            } else if (targetCatalog) {
              const transitioned = transitionRuleRefs(source, targetCatalog);
              ({ reason, ...nextRuleRefs } = transitioned);
            } else {
              nextRuleRefs = { status: "needs_review", references: [] };
              reason = "catalog_unavailable";
            }
            statuses[nextRuleRefs.status] += 1;
            reasons[reason] = (reasons[reason] || 0) + 1;
          }
          // 유형 제외 설정은 이름 기준이므로 연도가 달라도 그대로 옮겨진다.
          const info = stmt.run(
            to_year,
            r.level,
            newParent,
            r.sort_order,
            r.name,
            r.answer_type,
            r.remarks,
            r.unit || "",
            r.pdf_include ?? 1,
            r.excluded_types || "",
            r.field_key || "",
            r.calculation || "",
            serializeRuleRefs(nextRuleRefs, r.level === "item" ? Number(to_year) : undefined),
          );
          idMap[r.id] = info.lastInsertRowid;
        }
        validateStoredCalculationGraph(to_year);
        return { statuses, reasons };
      })();
    });

    if (!result.success) {
      logger.warn(req, "template.copy", {
        error: result.internalError || result.error,
        from_year,
        to_year,
      });
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "template.copy", {
      from_year,
      to_year,
      ...result.result,
      catalog_required: catalogRequired,
      catalog_available: Boolean(targetCatalog),
      catalog_error: catalogError?.code,
    });
    res
      .status(201)
      .json({
        from_year,
        to_year,
        ...result.result,
        catalog_required: catalogRequired,
        catalog_available: Boolean(targetCatalog),
      });
  });

  // POST /api/sheet/template/import - JSON 파일로 템플릿 가져오기
  app.post("/api/sheet/template/import", async (req, res) => {
    const { year, template } = req.body;
    if (!year || !Array.isArray(template))
      return res.status(400).send("year, template 배열이 필요합니다.");

    let importedRuleRefs;
    try {
      const flattened = flattenTemplateRuleRefs(template, {
        requireFieldKeys: false,
        requireRuleRefs: false,
      });
      const needsCatalog = flattened.some(({ value }) => value?.references?.length);
      const catalog = needsCatalog ? await rulesCatalog.load(Number(year)) : null;
      importedRuleRefs = new Map(
        flattened.map(({ fieldKey, value }) => [
          fieldKey,
          catalog
            ? ruleRefsForInput(value, catalog)
            : validateRuleRefs(value, { edition: Number(year) }),
        ]),
      );
    } catch (error) {
      if (error instanceof RuleCatalogError)
        return ruleCatalogFailure(req, res, "template.import", error, { year });
      return invalidRuleRefs(req, res, "template.import", error, { year });
    }

    const result = dbRun(() => {
      const stmt = db.prepare(
        "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation, rule_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );

      return db.transaction(() => {
        const replaced = db
          .prepare("DELETE FROM sheet_template WHERE year = ? AND level = 'category'")
          .run(year).changes;
        for (let ci = 0; ci < template.length; ci++) {
          const cat = template[ci];
          // 다른 필드와 마찬가지로 잘못된 값은 기본값으로 흘려보낸다 — 가져오기 전체를 실패시키지 않는다.
          const excluded = normalizeExcludedTypes(cat.excluded_types) ?? "";
          const catInfo = stmt.run(
            year,
            "category",
            null,
            ci,
            cat.name,
            null,
            cat.remarks || "",
            "",
            cat.pdf_include ?? 1,
            excluded,
            "",
            "",
            JSON.stringify(EMPTY_RULE_REFS),
          );
          const catId = catInfo.lastInsertRowid;

          if (!Array.isArray(cat.subcategories)) continue;
          for (let si = 0; si < cat.subcategories.length; si++) {
            const sub = cat.subcategories[si];
            const subInfo = stmt.run(
              year,
              "subcategory",
              catId,
              si,
              sub.name,
              null,
              sub.remarks || "",
              "",
              1,
              "",
              "",
              "",
              JSON.stringify(EMPTY_RULE_REFS),
            );
            const subId = subInfo.lastInsertRowid;

            if (!Array.isArray(sub.groups)) continue;
            for (let gi = 0; gi < sub.groups.length; gi++) {
              const grp = sub.groups[gi];
              const grpInfo = stmt.run(
                year,
                "group",
                subId,
                gi,
                grp.name,
                null,
                grp.remarks || "",
                "",
                1,
                "",
                "",
                "",
                JSON.stringify(EMPTY_RULE_REFS),
              );
              const grpId = grpInfo.lastInsertRowid;

              if (!Array.isArray(grp.items)) continue;
              for (let ii = 0; ii < grp.items.length; ii++) {
                const item = grp.items[ii];
                let storedCalculation = "";
                try {
                  storedCalculation = serializeCalculationConfig(item.calculation);
                } catch (e) {
                  throw { status: 400, message: `${item.name || "이름 없는 문항"}: ${e.message}` };
                }
                const fieldKey = item.field_key || `item-${randomUUID()}`;
                const ruleRefs = importedRuleRefs.get(fieldKey) || EMPTY_RULE_REFS;
                stmt.run(
                  year,
                  "item",
                  grpId,
                  ii,
                  item.name,
                  item.answer_type || "passfail",
                  item.remarks || "",
                  item.unit || "",
                  1,
                  "",
                  fieldKey,
                  storedCalculation,
                  serializeRuleRefs(ruleRefs, Number(year)),
                );
              }
            }
          }
        }
        try {
          validateStoredCalculationGraph(year);
        } catch (e) {
          throw { status: 400, message: e.message };
        }
        return { replaced };
      })();
    });

    if (!result.success) {
      logger.warn(req, "template.import", { error: result.internalError || result.error, year });
      return res.status(result.status).send(result.error);
    }
    logger.log(req, "template.import", {
      year,
      replaced_categories: result.result.replaced,
      imported_categories: template.length,
    });
    res.status(201).send();
  });
}
