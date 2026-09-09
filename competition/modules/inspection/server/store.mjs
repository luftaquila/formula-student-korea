import { validateCalculationGraph, parseCalculationConfig } from "../lib/calculations.mjs";
import { getInspectionItemState } from "../lib/item-status.mjs";

export function createInspectionStore({ db, parseExcludedTypes }) {
  function parseInspectorNames(value) {
    try {
      const parsed = JSON.parse(value || "[]");
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.map((name) => String(name).trim()).filter(Boolean))];
    } catch {
      return [];
    }
  }

  function addInspectorForItemEdit({ year, teamNum, itemId, updatedBy }) {
    const category = db
      .prepare(
        `
    SELECT category.id
    FROM sheet_template item
    JOIN sheet_template item_group
      ON item_group.id = item.parent_id AND item_group.level = 'group'
    JOIN sheet_template subcategory
      ON subcategory.id = item_group.parent_id AND subcategory.level = 'subcategory'
    JOIN sheet_template category
      ON category.id = subcategory.parent_id AND category.level = 'category'
    WHERE item.id = ? AND item.year = ? AND item.level = 'item'
  `,
      )
      .get(itemId, year);
    if (!category) throw new Error(`inspection category not found for item ${itemId}`);

    const stored = db
      .prepare(
        `
    SELECT inspector FROM sheet_inspector
    WHERE year = ? AND team_num = ? AND category_id = ?
  `,
      )
      .get(year, teamNum, category.id);
    const inspectors = parseInspectorNames(stored?.inspector);
    const name = String(updatedBy || "").trim();
    if (!name || inspectors.includes(name)) {
      return { categoryId: category.id, inspectors, changed: false };
    }

    inspectors.push(name);
    db.prepare(
      `
    INSERT INTO sheet_inspector (year, team_num, category_id, inspector)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(year, team_num, category_id) DO UPDATE SET inspector = excluded.inspector
  `,
    ).run(year, teamNum, category.id, JSON.stringify(inspectors));
    return { categoryId: category.id, inspectors, changed: true };
  }

  function templateItemsForYear(year) {
    return db
      .prepare(
        `
    SELECT id, answer_type, field_key, calculation
    FROM sheet_template WHERE year = ? AND level = 'item'
  `,
      )
      .all(year);
  }

  function validateStoredCalculationGraph(year) {
    try {
      validateCalculationGraph(templateItemsForYear(year));
    } catch (e) {
      throw { status: 400, message: e.message };
    }
  }

  function getCategoryCompletion(year, teamNum, categoryId) {
    const rows = db
      .prepare(
        `
    SELECT item.answer_type, item.remarks, item.calculation, answer.value
    FROM sheet_template AS category
    JOIN sheet_template AS subcategory ON subcategory.parent_id = category.id
    JOIN sheet_template AS item_group ON item_group.parent_id = subcategory.id
    JOIN sheet_template AS item ON item.parent_id = item_group.id AND item.level = 'item'
    LEFT JOIN sheet_answer AS answer
      ON answer.year = ? AND answer.team_num = ? AND answer.item_id = item.id
    WHERE category.id = ? AND category.year = ? AND category.level = 'category'
  `,
      )
      .all(year, teamNum, categoryId, year);

    let total = 0;
    let completed = 0;
    for (const row of rows) {
      const state = getInspectionItemState(
        {
          answer_type: row.answer_type,
          remarks: row.remarks,
          calculation: parseCalculationConfig(row.calculation),
        },
        row.value ?? "",
      );
      if (!state) continue;
      total += 1;
      if (state !== "unanswered") completed += 1;
    }
    return { total, completed, complete: completed === total };
  }

  function getInspectionSummary(year) {
    // excluded_types를 함께 내려 목록·성적표가 팀 유형에 해당하지 않는 칸을 비울 수 있게 한다.
    const categories = db
      .prepare(
        "SELECT id, name, excluded_types FROM sheet_template WHERE year = ? AND level = 'category' ORDER BY sort_order",
      )
      .all(year)
      .map((c) => ({ ...c, excluded_types: parseExcludedTypes(c.excluded_types) }));

    const inspectors = db
      .prepare(
        `SELECT i.team_num, i.category_id, i.inspector FROM sheet_inspector i
     WHERE i.year = ? AND NOT EXISTS (
       SELECT 1 FROM competition_inactive_team s
       WHERE s.year = i.year AND s.team_num = i.team_num
     )`,
      )
      .all(year);

    const results = db
      .prepare(
        `SELECT r.team_num, r.category_id, r.result FROM sheet_category_result r
     WHERE r.year = ? AND NOT EXISTS (
       SELECT 1 FROM competition_inactive_team s
       WHERE s.year = r.year AND s.team_num = r.team_num
     )`,
      )
      .all(year);

    const teams = {};
    for (const row of inspectors) {
      if (!teams[row.team_num]) teams[row.team_num] = { inspectors: {}, results: {} };
      teams[row.team_num].inspectors[row.category_id] = parseInspectorNames(row.inspector);
    }
    for (const row of results) {
      if (!teams[row.team_num]) teams[row.team_num] = { inspectors: {}, results: {} };
      teams[row.team_num].results[row.category_id] = row.result;
    }

    return { categories, teams };
  }

  function getBulkAnswers(year, itemIds) {
    const placeholders = itemIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT a.team_num, a.item_id, a.value FROM sheet_answer a
     WHERE a.year = ? AND a.item_id IN (${placeholders}) AND a.value != ''
       AND NOT EXISTS (
         SELECT 1 FROM competition_inactive_team s
         WHERE s.year = a.year AND s.team_num = a.team_num
       )`,
      )
      .all(year, ...itemIds);

    const teams = {};
    for (const row of rows) {
      if (!teams[row.team_num]) teams[row.team_num] = {};
      teams[row.team_num][row.item_id] = row.value;
    }
    return teams;
  }

  return {
    parseInspectorNames,
    addInspectorForItemEdit,
    validateStoredCalculationGraph,
    getCategoryCompletion,
    getInspectionSummary,
    getBulkAnswers,
  };
}
