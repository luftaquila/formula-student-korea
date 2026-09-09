export function registerQueriesRoutes({
  app,
  dbRun,
  getInspectionSummary,
  getBulkAnswers,
  teamPreflight,
  db,
  parseInspectorNames,
}) {
  // GET /api/sheet/summary - 모든 팀의 카테고리별 요약
  app.get("/api/sheet/summary", (req, res) => {
    const year = Number(req.query.year);
    if (!year) return res.status(400).send("연도를 지정해야 합니다.");

    const result = dbRun(() => getInspectionSummary(year));

    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // GET /api/sheet/bulk-answers - 벌크 답변 조회 (특정 item_id들의 팀별 값)
  app.get("/api/sheet/bulk-answers", (req, res) => {
    const year = Number(req.query.year);
    const itemIdsParam = req.query.item_ids;
    if (!year || !itemIdsParam) return res.status(400).send("year, item_ids 필수");

    const itemIds = itemIdsParam
      .split(",")
      .map(Number)
      .filter((n) => !isNaN(n));
    if (!itemIds.length) return res.status(400).send("유효한 item_ids가 없습니다.");
    if (itemIds.length > 1000)
      return res.status(400).send("item_ids는 1000개를 초과할 수 없습니다.");

    const result = dbRun(() => getBulkAnswers(year, itemIds));

    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });

  // GET /api/sheet/data/:year/:num - 팀의 모든 시트 데이터 반환
  app.get("/api/sheet/data/:year/:num", (req, res) => {
    const year = Number(req.params.year);
    const num = Number(req.params.num);
    if (!Number.isInteger(year) || !Number.isInteger(num) || num < 1) {
      return res.status(400).send("올바르지 않은 연도 또는 팀 번호입니다.");
    }
    if (!teamPreflight(req, res, { action: "sheet.data", year, teamNum: num, missingStatus: 404 }))
      return;

    const result = dbRun(() => {
      const answers = db
        .prepare(
          `
      SELECT item_id, value, memo,
             answer_updated_at, answer_updated_by,
             memo_updated_at, memo_updated_by
      FROM sheet_answer
      WHERE year = ? AND team_num = ?
    `,
        )
        .all(year, num);

      const categoryResults = db
        .prepare(
          "SELECT category_id, result FROM sheet_category_result WHERE year = ? AND team_num = ?",
        )
        .all(year, num);

      const inspectors = db
        .prepare(
          "SELECT category_id, inspector FROM sheet_inspector WHERE year = ? AND team_num = ?",
        )
        .all(year, num);

      const answersMap = {};
      for (const a of answers) {
        answersMap[a.item_id] = {
          value: a.value,
          memo: a.memo,
          answer_updated_at: a.answer_updated_at,
          answer_updated_by: a.answer_updated_by,
          memo_updated_at: a.memo_updated_at,
          memo_updated_by: a.memo_updated_by,
        };
      }

      const resultsMap = {};
      for (const r of categoryResults) resultsMap[r.category_id] = r.result;

      const inspectorsMap = {};
      for (const i of inspectors) inspectorsMap[i.category_id] = parseInspectorNames(i.inspector);

      return { answers: answersMap, results: resultsMap, inspectors: inspectorsMap };
    });

    if (!result.success) return res.status(result.status).send(result.error);
    res.json(result.result);
  });
}
