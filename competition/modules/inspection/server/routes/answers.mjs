import { isCompetitionPreparationYear } from "../../../../../shared/common/competition-year.mjs";
import { parseCalculationConfig } from "../../lib/calculations.mjs";

export function registerAnswersRoutes({
  app,
  teamPreflight,
  mutationTemplatePreflight,
  dbRun,
  db,
  addInspectorForItemEdit,
  logger,
  broadcastEvent,
  getCategoryCompletion,
}) {
  // PUT /api/sheet/answer - 답변 upsert
  app.put("/api/sheet/answer", (req, res) => {
    const { year, team_num, item_id, value, expectedValue, mutation_id } = req.body;
    if (!year || team_num == null || !item_id)
      return res.status(400).send("필수 필드가 누락되었습니다.");
    if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(item_id)) {
      return res.status(400).send("필수 필드가 올바르지 않습니다.");
    }
    if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
    if (!teamPreflight(req, res, { action: "answer.update", year, teamNum: team_num })) return;
    if (!isCompetitionPreparationYear(year))
      return res.status(409).send("현재 또는 다음 연도 데이터만 수정할 수 있습니다.");
    const templateItem = mutationTemplatePreflight(req, res, {
      action: "answer.update",
      id: item_id,
      year,
    });
    if (!templateItem) return;
    const newValue = value ?? "";
    if (
      templateItem.answer_type === "passfail" &&
      !["", "PASS", "FAIL", "N/A"].includes(newValue)
    ) {
      return res.status(400).send("PASS, FAIL 또는 N/A만 입력할 수 있습니다.");
    }
    if (
      templateItem.answer_type === "counter" &&
      newValue !== "" &&
      !/^(0|[1-9]\d*)$/.test(String(newValue))
    ) {
      return res.status(400).send("증감 숫자는 0 이상의 정수만 입력할 수 있습니다.");
    }
    if (templateItem.answer_type === "stopwatch") {
      return res.status(400).send("스톱워치 항목은 응답을 저장하지 않습니다.");
    }
    if (parseCalculationConfig(templateItem.calculation)?.mode === "computed") {
      return res.status(400).send("자동 계산 문항에는 값을 직접 저장할 수 없습니다.");
    }
    const expectedValueProvided =
      Object.hasOwn(req.body, "expectedValue") && typeof expectedValue === "string";

    const updatedAt = new Date().toISOString();
    const updatedBy = req.user?.realname?.trim() || "";

    const result = dbRun(() =>
      db.transaction(() => {
        const prev = db
          .prepare(
            `SELECT value, answer_updated_at, answer_updated_by
       FROM sheet_answer WHERE year = ? AND team_num = ? AND item_id = ?`,
          )
          .get(year, team_num, item_id);
        const current = {
          value: prev?.value ?? "",
          updated_at: prev?.answer_updated_at ?? null,
          updated_by: prev?.answer_updated_by ?? "",
        };

        if (
          (!expectedValueProvided && current.value !== "") ||
          (expectedValueProvided && current.value !== expectedValue)
        )
          return { conflict: true, current };

        if (current.value === newValue) {
          return { changed: false, current };
        }
        if (!updatedBy) {
          throw {
            status: 409,
            message: "계정 실명을 확인할 수 없어 저장할 수 없습니다. 다시 로그인하세요.",
          };
        }

        db.prepare(
          `INSERT INTO sheet_answer
         (year, team_num, item_id, value, answer_updated_at, answer_updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, item_id) DO UPDATE SET
         value = excluded.value,
         answer_updated_at = excluded.answer_updated_at,
         answer_updated_by = excluded.answer_updated_by`,
        ).run(year, team_num, item_id, newValue, updatedAt, updatedBy);

        const inspector = addInspectorForItemEdit({
          year,
          teamNum: team_num,
          itemId: item_id,
          updatedBy,
        });

        return {
          changed: true,
          current: { value: newValue, updated_at: updatedAt, updated_by: updatedBy },
          inspector,
        };
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "answer.update",
        { error: result.internalError || result.error, year, item_id },
        `#${team_num}`,
      );
      return res.status(result.status).send(result.error);
    }

    if (result.result.conflict) {
      logger.warn(
        req,
        "answer.stale_write",
        {
          code: "INSPECTION_STALE_WRITE",
          year,
          item_id,
          expectedValue,
          requested: newValue,
          current: result.result.current,
        },
        `#${team_num}`,
      );
      return res.status(409).json({
        code: "INSPECTION_STALE_WRITE",
        message: "다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 작성하세요.",
        current: result.result.current,
      });
    }

    if (result.result.changed) {
      logger.log(
        req,
        "answer.update",
        {
          year,
          item_id,
          item_name: templateItem.name,
          value: newValue,
          updated_by: updatedBy,
          inspector_added: result.result.inspector.changed,
          inspectors: result.result.inspector.inspectors,
        },
        `#${team_num}`,
      );
      broadcastEvent("answer", {
        year,
        team_num,
        item_id,
        value: newValue,
        updated_at: result.result.current.updated_at,
        updated_by: result.result.current.updated_by,
        mutation_id: typeof mutation_id === "string" ? mutation_id : undefined,
      });
      if (result.result.inspector.changed) {
        broadcastEvent("inspector", {
          year,
          team_num,
          category_id: result.result.inspector.categoryId,
          inspectors: result.result.inspector.inspectors,
        });
      }
    }

    res.status(200).json({
      ...result.result.current,
      mutation_id: typeof mutation_id === "string" ? mutation_id : undefined,
    });
  });

  // PUT /api/sheet/memo - 메모 upsert
  app.put("/api/sheet/memo", (req, res) => {
    const { year, team_num, item_id, memo, expectedMemo, mutation_id } = req.body;
    if (!year || team_num == null || !item_id)
      return res.status(400).send("필수 필드가 누락되었습니다.");
    if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(item_id)) {
      return res.status(400).send("필수 필드가 올바르지 않습니다.");
    }
    if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
    if (!teamPreflight(req, res, { action: "memo.update", year, teamNum: team_num })) return;
    if (!isCompetitionPreparationYear(year))
      return res.status(409).send("현재 또는 다음 연도 데이터만 수정할 수 있습니다.");
    const templateItem = mutationTemplatePreflight(req, res, {
      action: "memo.update",
      id: item_id,
      year,
    });
    if (!templateItem) return;
    const expectedMemoProvided =
      Object.hasOwn(req.body, "expectedMemo") && typeof expectedMemo === "string";

    const newMemo = memo ?? "";
    const updatedAt = new Date().toISOString();
    const updatedBy = req.user?.realname?.trim() || "";
    const result = dbRun(() =>
      db.transaction(() => {
        const prev = db
          .prepare(
            `SELECT memo, memo_updated_at, memo_updated_by
       FROM sheet_answer WHERE year = ? AND team_num = ? AND item_id = ?`,
          )
          .get(year, team_num, item_id);
        const current = {
          memo: prev?.memo ?? "",
          updated_at: prev?.memo_updated_at ?? null,
          updated_by: prev?.memo_updated_by ?? "",
        };

        if (
          (!expectedMemoProvided && current.memo !== "") ||
          (expectedMemoProvided && current.memo !== expectedMemo)
        )
          return { conflict: true, current };

        if (current.memo === newMemo) {
          return { changed: false, current };
        }
        if (!updatedBy) {
          throw {
            status: 409,
            message: "계정 실명을 확인할 수 없어 저장할 수 없습니다. 다시 로그인하세요.",
          };
        }

        db.prepare(
          `INSERT INTO sheet_answer
         (year, team_num, item_id, memo, memo_updated_at, memo_updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, item_id) DO UPDATE SET
         memo = excluded.memo,
         memo_updated_at = excluded.memo_updated_at,
         memo_updated_by = excluded.memo_updated_by`,
        ).run(year, team_num, item_id, newMemo, updatedAt, updatedBy);

        const inspector = addInspectorForItemEdit({
          year,
          teamNum: team_num,
          itemId: item_id,
          updatedBy,
        });

        return {
          changed: true,
          current: { memo: newMemo, updated_at: updatedAt, updated_by: updatedBy },
          inspector,
        };
      })(),
    );

    if (!result.success) {
      logger.warn(
        req,
        "memo.update",
        { error: result.internalError || result.error, year, item_id },
        `#${team_num}`,
      );
      return res.status(result.status).send(result.error);
    }

    if (result.result.conflict) {
      logger.warn(
        req,
        "memo.stale_write",
        {
          code: "INSPECTION_STALE_WRITE",
          year,
          item_id,
          expectedMemo,
          requested: newMemo,
          current: result.result.current,
        },
        `#${team_num}`,
      );
      return res.status(409).json({
        code: "INSPECTION_STALE_WRITE",
        message: "다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 작성하세요.",
        current: result.result.current,
      });
    }

    if (result.result.changed) {
      logger.log(
        req,
        "memo.update",
        {
          year,
          item_id,
          item_name: templateItem.name,
          memo: newMemo,
          updated_by: updatedBy,
          inspector_added: result.result.inspector.changed,
          inspectors: result.result.inspector.inspectors,
        },
        `#${team_num}`,
      );
      broadcastEvent("memo", {
        year,
        team_num,
        item_id,
        memo: newMemo,
        updated_at: result.result.current.updated_at,
        updated_by: result.result.current.updated_by,
        mutation_id: typeof mutation_id === "string" ? mutation_id : undefined,
      });
      if (result.result.inspector.changed) {
        broadcastEvent("inspector", {
          year,
          team_num,
          category_id: result.result.inspector.categoryId,
          inspectors: result.result.inspector.inspectors,
        });
      }
    }

    res.status(200).json({
      ...result.result.current,
      mutation_id: typeof mutation_id === "string" ? mutation_id : undefined,
    });
  });

  // PUT /api/sheet/category-result - 카테고리 결과 upsert
  app.put("/api/sheet/category-result", (req, res) => {
    const { year, team_num, category_id, result: catResult } = req.body;
    if (!year || team_num == null || !category_id)
      return res.status(400).send("필수 필드가 누락되었습니다.");
    if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(category_id)) {
      return res.status(400).send("필수 필드가 올바르지 않습니다.");
    }
    if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
    if (!teamPreflight(req, res, { action: "category_result.update", year, teamNum: team_num }))
      return;
    if (
      catResult !== undefined &&
      catResult !== null &&
      catResult !== "" &&
      !["PASS", "FAIL"].includes(catResult)
    ) {
      return res.status(400).send("결과는 PASS, FAIL 또는 비움이어야 합니다.");
    }
    if (!isCompetitionPreparationYear(year))
      return res.status(409).send("현재 또는 다음 연도 데이터만 수정할 수 있습니다.");
    const templateCat = mutationTemplatePreflight(req, res, {
      action: "category_result.update",
      id: category_id,
      year,
      level: "category",
    });
    if (!templateCat) return;

    if (catResult === "PASS") {
      const completion = dbRun(() => getCategoryCompletion(year, team_num, category_id));
      if (!completion.success) {
        logger.warn(
          req,
          "category_result.update",
          {
            error: completion.internalError || completion.error,
            phase: "category_completion_lookup",
            year,
            category_id,
          },
          `#${team_num}`,
        );
        return res.status(completion.status).send(completion.error);
      }
      if (!completion.result.complete) {
        logger.warn(
          req,
          "category_result.update",
          {
            error: "category_incomplete",
            reason: "category_pass_requires_complete_responses",
            year,
            category_id,
            completed: completion.result.completed,
            total: completion.result.total,
            requested_result: catResult,
          },
          `#${team_num}`,
        );
        return res.status(409).send("모든 문항을 입력한 뒤 PASS할 수 있습니다.");
      }
    }

    const r = dbRun(() =>
      db
        .prepare(
          "INSERT INTO sheet_category_result (year, team_num, category_id, result) VALUES (?, ?, ?, ?) ON CONFLICT(year, team_num, category_id) DO UPDATE SET result = excluded.result",
        )
        .run(year, team_num, category_id, catResult ?? ""),
    );

    if (!r.success) {
      logger.warn(
        req,
        "category_result.update",
        { error: r.internalError || r.error, year, category_id },
        `#${team_num}`,
      );
      return res.status(r.status).send(r.error);
    }

    logger.log(
      req,
      "category_result.update",
      { year, category_id, category_name: templateCat.name, result: catResult },
      `#${team_num}`,
    );
    broadcastEvent("category-result", { year, team_num, category_id, result: catResult ?? "" });

    res.status(200).send();
  });
}
