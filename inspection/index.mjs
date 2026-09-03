import express from "express";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createServiceSkeleton, addSpaFallback } from "../shared/service-bootstrap.mjs";
import { runMigrationOnce } from "../shared/db-setup.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { ensureInactiveTeamView, isTeamActive } from "../shared/team-status.mjs";
import { currentCompetitionYear } from "../shared/competition-year.mjs";
import {
  parseCalculationConfig,
  serializeCalculationConfig,
  validateCalculationGraph,
} from "./lib/calculations.mjs";
import { getInspectionItemState } from "./lib/item-status.mjs";
import { access } from "../shared/access-control.js";

export function createInspectionApp(options = {}) {

const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "inspection", express, Database, options, dbFile: "sheet.db",
  authRoleFn: (req) => {
    if (req.path === "/api/health") return null;
    if (req.path.startsWith("/api/internal/")) return access.internal;
    if (req.path.startsWith("/api/sheet/template") && req.method !== "GET") return access.permission("inspection.manage");
    if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
    if (req.path.startsWith("/api/")) return access.permission("inspection.operate");
    return access.permission("inspection.operate"); // SPA
  },
});
ensureInactiveTeamView(db);

function auditRejection(req, action, detail, target) {
  logger.warn(req, action, {
    error: detail.error,
    reason: detail.reason || detail.error,
    ...detail,
  }, target);
}

function teamPreflight(req, res, { action, year, teamNum, missingStatus = 409 }) {
  const result = dbRun(() => isTeamActive(db, year, teamNum));
  if (!result.success) {
    auditRejection(req, action, {
      error: result.internalError || result.error,
      phase: "canonical_team_lookup",
      year,
      team_num: teamNum,
    }, `#${teamNum}`);
    res.status(500).send("팀 활성 상태를 확인할 수 없습니다.");
    return false;
  }
  if (!result.result) {
    auditRejection(req, action, {
      error: "inactive_or_missing_team",
      phase: "canonical_team_lookup",
      year,
      team_num: teamNum,
    }, `#${teamNum}`);
    res.status(missingStatus).send(missingStatus === 404
      ? "엔트리를 찾을 수 없습니다."
      : "비활성화된 엔트리는 수정할 수 없습니다.");
    return false;
  }
  return true;
}

function templateNodePreflight(req, res, { action, id, columns }) {
  const result = dbRun(() => db.prepare(`SELECT ${columns} FROM sheet_template WHERE id = ?`).get(id));
  if (!result.success) {
    auditRejection(req, action, {
      error: result.internalError || result.error,
      phase: "template_lookup",
      template_id: id,
    }, `template:${id}`);
    res.status(500).send("템플릿을 확인할 수 없습니다.");
    return null;
  }
  if (!result.result) {
    auditRejection(req, action, {
      error: "template_not_found",
      phase: "template_lookup",
      template_id: id,
    }, `template:${id}`);
    res.status(404).send(action === "template.delete" ? "노드를 찾을 수 없습니다." : "항목을 찾을 수 없습니다.");
    return null;
  }
  return result.result;
}

function mutationTemplatePreflight(req, res, { action, id, year, level }) {
  const levelClause = level ? " AND level = ?" : "";
  const result = dbRun(() => db.prepare(
    `SELECT id, name, answer_type, calculation FROM sheet_template WHERE id = ? AND year = ?${levelClause}`,
  ).get(...(level ? [id, year, level] : [id, year])));
  if (!result.success) {
    auditRejection(req, action, {
      error: result.internalError || result.error,
      phase: "template_lookup",
      year,
      template_id: id,
    }, `template:${id}`);
    res.status(500).send("템플릿을 확인할 수 없습니다.");
    return null;
  }
  if (!result.result) {
    auditRejection(req, action, {
      error: "template_not_found",
      phase: "template_lookup",
      year,
      template_id: id,
      ...(level ? { expected_level: level } : {}),
    }, `template:${id}`);
    res.status(400).send(level === "category"
      ? "해당 연도에 존재하지 않는 카테고리입니다."
      : "해당 연도에 존재하지 않는 항목입니다.");
    return null;
  }
  return result.result;
}

// answer_type CHECK 제약조건에 새 입력 유형을 추가하는 마이그레이션
// FK CASCADE 문제를 피하기 위해 트랜잭션 밖에서 foreign_keys OFF 상태로 실행
{
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sheet_template'").get();
  if (schema && (!schema.sql.includes("'counter'") || !schema.sql.includes("'stopwatch'"))) {
    const existingColumns = new Set(db.prepare("PRAGMA table_info(sheet_template)").all().map(c => c.name));
    const unitExpr = existingColumns.has("unit") ? "unit" : "''";
    const pdfIncludeExpr = existingColumns.has("pdf_include") ? "pdf_include" : "1";
    const excludedTypesExpr = existingColumns.has("excluded_types") ? "excluded_types" : "''";
    const fieldKeyExpr = existingColumns.has("field_key") ? "field_key" : "''";
    const calculationExpr = existingColumns.has("calculation") ? "calculation" : "''";
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE sheet_template_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          year INTEGER NOT NULL,
          level TEXT NOT NULL CHECK(level IN ('category', 'subcategory', 'group', 'item')),
          parent_id INTEGER,
          sort_order INTEGER NOT NULL DEFAULT 0,
          name TEXT NOT NULL,
          answer_type TEXT CHECK(answer_type IN ('passfail', 'number', 'text', 'checktable', 'counter', 'stopwatch') OR answer_type IS NULL),
          remarks TEXT DEFAULT '',
          unit TEXT DEFAULT '',
          pdf_include INTEGER DEFAULT 1,
          excluded_types TEXT DEFAULT '',
          field_key TEXT DEFAULT '',
          calculation TEXT DEFAULT '',
          FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
        )`);
        db.exec(`INSERT INTO sheet_template_new
          (id, year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation)
          SELECT id, year, level, parent_id, sort_order, name, answer_type, remarks,
                 ${unitExpr}, ${pdfIncludeExpr}, ${excludedTypesExpr}, ${fieldKeyExpr}, ${calculationExpr}
          FROM sheet_template`);
        db.exec("DROP TABLE sheet_template");
        db.exec("ALTER TABLE sheet_template_new RENAME TO sheet_template");
        db.exec("CREATE INDEX IF NOT EXISTS idx_st_year ON sheet_template(year)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_st_parent ON sheet_template(parent_id)");
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
}

db.pragma("foreign_keys = ON");

db.transaction(() => {
  // 검차 시트 템플릿 테이블 (4단계 계층: category → subcategory → group → item)
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_template (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('category', 'subcategory', 'group', 'item')),
    parent_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    answer_type TEXT CHECK(answer_type IN ('passfail', 'number', 'text', 'checktable', 'counter', 'stopwatch') OR answer_type IS NULL),
    remarks TEXT DEFAULT '',
    unit TEXT DEFAULT '',
    pdf_include INTEGER DEFAULT 1,
    excluded_types TEXT DEFAULT '',
    field_key TEXT DEFAULT '',
    calculation TEXT DEFAULT '',
    FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_st_year ON sheet_template(year);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_st_parent ON sheet_template(parent_id);`);

  // 컬럼 마이그레이션
  const cols = db.prepare("PRAGMA table_info(sheet_template)").all();
  if (!cols.find(c => c.name === "unit")) {
    db.exec(`ALTER TABLE sheet_template ADD COLUMN unit TEXT DEFAULT ''`);
  }
  if (!cols.find(c => c.name === "pdf_include")) {
    db.exec(`ALTER TABLE sheet_template ADD COLUMN pdf_include INTEGER DEFAULT 1`);
  }
  // 카테고리를 숨길 차량 유형 이름의 JSON 배열. 빈 값 = 모든 유형에 표시(기본).
  // 포함이 아니라 제외를 저장하므로 유형을 새로 추가하면 자동으로 표시되고,
  // entry 서비스에서 유형 이름이 바뀌어 매핑이 끊기면 숨김이 아니라 표시로 열린다.
  if (!cols.find(c => c.name === "excluded_types")) {
    db.exec(`ALTER TABLE sheet_template ADD COLUMN excluded_types TEXT DEFAULT ''`);
  }
  if (!cols.find(c => c.name === "field_key")) {
    db.exec(`ALTER TABLE sheet_template ADD COLUMN field_key TEXT DEFAULT ''`);
  }
  if (!cols.find(c => c.name === "calculation")) {
    db.exec(`ALTER TABLE sheet_template ADD COLUMN calculation TEXT DEFAULT ''`);
  }
  // 기존 문항도 복사·내보내기 후 참조가 유지되는 안정적인 내부 키를 갖게 한다.
  db.exec(`UPDATE sheet_template
    SET field_key = 'item-' || year || '-' || id
    WHERE level = 'item' AND COALESCE(field_key, '') = ''`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_st_year_field_key
    ON sheet_template(year, field_key) WHERE field_key != ''`);

  // 검차 시트 답변 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_answer (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    value TEXT DEFAULT '',
    memo TEXT DEFAULT '',
    answer_updated_at TEXT,
    answer_updated_by TEXT,
    memo_updated_at TEXT,
    memo_updated_by TEXT,
    PRIMARY KEY (year, team_num, item_id),
    FOREIGN KEY (item_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);
  const answerCols = db.prepare("PRAGMA table_info(sheet_answer)").all();
  const answerMigrations = [
    ["answer_updated_at", "TEXT"],
    ["answer_updated_by", "TEXT"],
    ["memo_updated_at", "TEXT"],
    ["memo_updated_by", "TEXT"],
  ];
  for (const [name, type] of answerMigrations) {
    if (!answerCols.find(c => c.name === name)) {
      db.exec(`ALTER TABLE sheet_answer ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sa_item ON sheet_answer(item_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sa_year_item_team_value
    ON sheet_answer(year, item_id, team_num, value);`);

  // 검차 시트 큰 카테고리별 결과 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_category_result (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    result TEXT DEFAULT '' CHECK(result IN ('PASS', 'FAIL', '')),
    PRIMARY KEY (year, team_num, category_id),
    FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scr_category ON sheet_category_result(category_id);`);

  // 검차 시트 큰 카테고리별 검차관 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_inspector (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    inspector TEXT DEFAULT '',
    PRIMARY KEY (year, team_num, category_id),
    FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_si_category ON sheet_inspector(category_id);`);

  // 수기 검차관 문자열을 폐기하고, 보존돼 있는 답변/메모의 마지막 편집자부터
  // 자동 참여자 목록을 구성한다. 이후 편집자는 각 저장 트랜잭션에서 누적한다.
  runMigrationOnce(db, "inspection-automatic-inspectors-v1", () => {
    const editors = db.prepare(`
      SELECT year, team_num, category_id, inspector, MIN(updated_at) AS first_updated_at
      FROM (
        SELECT a.year, a.team_num, category.id AS category_id,
               TRIM(a.answer_updated_by) AS inspector, a.answer_updated_at AS updated_at
        FROM sheet_answer a
        JOIN sheet_template item
          ON item.id = a.item_id AND item.year = a.year AND item.level = 'item'
        JOIN sheet_template item_group
          ON item_group.id = item.parent_id AND item_group.level = 'group'
        JOIN sheet_template subcategory
          ON subcategory.id = item_group.parent_id AND subcategory.level = 'subcategory'
        JOIN sheet_template category
          ON category.id = subcategory.parent_id AND category.level = 'category'
        WHERE TRIM(COALESCE(a.answer_updated_by, '')) != ''
        UNION ALL
        SELECT a.year, a.team_num, category.id AS category_id,
               TRIM(a.memo_updated_by) AS inspector, a.memo_updated_at AS updated_at
        FROM sheet_answer a
        JOIN sheet_template item
          ON item.id = a.item_id AND item.year = a.year AND item.level = 'item'
        JOIN sheet_template item_group
          ON item_group.id = item.parent_id AND item_group.level = 'group'
        JOIN sheet_template subcategory
          ON subcategory.id = item_group.parent_id AND subcategory.level = 'subcategory'
        JOIN sheet_template category
          ON category.id = subcategory.parent_id AND category.level = 'category'
        WHERE TRIM(COALESCE(a.memo_updated_by, '')) != ''
        UNION ALL
        SELECT CAST(CASE WHEN json_valid(audit.detail)
                    THEN json_extract(audit.detail, '$.year') END AS INTEGER) AS year,
               CAST(SUBSTR(audit.target, 2) AS INTEGER) AS team_num,
               category.id AS category_id,
               TRIM(audit.actor_name) AS inspector,
               audit.timestamp AS updated_at
        FROM logs audit
        JOIN sheet_template item
          ON item.id = CAST(CASE WHEN json_valid(audit.detail)
                            THEN json_extract(audit.detail, '$.item_id') END AS INTEGER)
         AND item.year = CAST(CASE WHEN json_valid(audit.detail)
                              THEN json_extract(audit.detail, '$.year') END AS INTEGER)
         AND item.level = 'item'
        JOIN sheet_template item_group
          ON item_group.id = item.parent_id AND item_group.level = 'group'
        JOIN sheet_template subcategory
          ON subcategory.id = item_group.parent_id AND subcategory.level = 'subcategory'
        JOIN sheet_template category
          ON category.id = subcategory.parent_id AND category.level = 'category'
        WHERE audit.module = 'inspection'
          AND audit.level = 'info'
          AND audit.action IN ('answer.update', 'memo.update')
          AND json_valid(audit.detail)
          AND audit.target GLOB '#[0-9]*'
          AND TRIM(COALESCE(audit.actor_name, '')) != ''
      )
      GROUP BY year, team_num, category_id, inspector
      ORDER BY year, team_num, category_id, first_updated_at, inspector
    `).all();
    const grouped = new Map();
    for (const row of editors) {
      const key = `${row.year}:${row.team_num}:${row.category_id}`;
      if (!grouped.has(key)) grouped.set(key, { ...row, inspectors: [] });
      grouped.get(key).inspectors.push(row.inspector);
    }
    db.prepare("DELETE FROM sheet_inspector").run();
    const insert = db.prepare(`
      INSERT INTO sheet_inspector (year, team_num, category_id, inspector)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of grouped.values()) {
      insert.run(row.year, row.team_num, row.category_id, JSON.stringify(row.inspectors));
    }
  });
})();

function parseInspectorNames(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(name => String(name).trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function addInspectorForItemEdit({ year, teamNum, itemId, updatedBy }) {
  const category = db.prepare(`
    SELECT category.id
    FROM sheet_template item
    JOIN sheet_template item_group
      ON item_group.id = item.parent_id AND item_group.level = 'group'
    JOIN sheet_template subcategory
      ON subcategory.id = item_group.parent_id AND subcategory.level = 'subcategory'
    JOIN sheet_template category
      ON category.id = subcategory.parent_id AND category.level = 'category'
    WHERE item.id = ? AND item.year = ? AND item.level = 'item'
  `).get(itemId, year);
  if (!category) throw new Error(`inspection category not found for item ${itemId}`);

  const stored = db.prepare(`
    SELECT inspector FROM sheet_inspector
    WHERE year = ? AND team_num = ? AND category_id = ?
  `).get(year, teamNum, category.id);
  const inspectors = parseInspectorNames(stored?.inspector);
  const name = String(updatedBy || "").trim();
  if (!name || inspectors.includes(name)) {
    return { categoryId: category.id, inspectors, changed: false };
  }

  inspectors.push(name);
  db.prepare(`
    INSERT INTO sheet_inspector (year, team_num, category_id, inspector)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(year, team_num, category_id) DO UPDATE SET inspector = excluded.inspector
  `).run(year, teamNum, category.id, JSON.stringify(inspectors));
  return { categoryId: category.id, inspectors, changed: true };
}

function templateItemsForYear(year) {
  return db.prepare(`
    SELECT id, answer_type, field_key, calculation
    FROM sheet_template WHERE year = ? AND level = 'item'
  `).all(year);
}

function validateStoredCalculationGraph(year) {
  try {
    validateCalculationGraph(templateItemsForYear(year));
  } catch (e) {
    throw { status: 400, message: e.message };
  }
}

function getCategoryCompletion(year, teamNum, categoryId) {
  const rows = db.prepare(`
    SELECT item.answer_type, item.remarks, item.calculation, answer.value
    FROM sheet_template AS category
    JOIN sheet_template AS subcategory ON subcategory.parent_id = category.id
    JOIN sheet_template AS item_group ON item_group.parent_id = subcategory.id
    JOIN sheet_template AS item ON item.parent_id = item_group.id AND item.level = 'item'
    LEFT JOIN sheet_answer AS answer
      ON answer.year = ? AND answer.team_num = ? AND answer.item_id = item.id
    WHERE category.id = ? AND category.year = ? AND category.level = 'category'
  `).all(year, teamNum, categoryId, year);

  let total = 0;
  let completed = 0;
  for (const row of rows) {
    const state = getInspectionItemState({
      answer_type: row.answer_type,
      remarks: row.remarks,
      calculation: parseCalculationConfig(row.calculation),
    }, row.value ?? "");
    if (!state) continue;
    total += 1;
    if (state !== "unanswered") completed += 1;
  }
  return { total, completed, complete: completed === total };
}

// 특정 연도나 문항을 기준으로 템플릿 내용을 시작 시 삽입·수정하지 않는다.
// 업무 템플릿은 관리 API 또는 명시적인 JSON 가져오기를 통해서만 변경한다.

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastSSEEvent, handler: sseHandler, close: closeSse } = createSSEManager(200, { logger });

function broadcastEvent(event, data) {
  broadcastSSEEvent(event, data);
  options.onEvent?.(event, data);
}

// SSE 엔드포인트
app.get("/api/sheet/events", sseHandler());

/* ============================================
   API 라우트: 검차 시트
   ============================================ */

// excluded_types는 DB에 JSON 문자열로 저장하고 API에서는 항상 배열로 주고받는다.
const MAX_EXCLUDED_TYPES = 50;

function parseExcludedTypes(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(t => typeof t === "string") : [];
  } catch {
    return []; // 손상된 값은 "제외 없음"으로 취급 — 카테고리가 조용히 사라지지 않게 한다.
  }
}

// 유효한 배열이면 저장용 JSON 문자열, 아니면 null(= 400 처리 대상)을 반환한다.
function normalizeExcludedTypes(value) {
  if (!Array.isArray(value)) return null;
  const names = [...new Set(value.filter(t => typeof t === "string").map(t => t.trim()).filter(Boolean))];
  if (names.length > MAX_EXCLUDED_TYPES) return null;
  return JSON.stringify(names);
}

function getTemplateTree(year) {
  const rows = db.prepare("SELECT * FROM sheet_template WHERE year = ? ORDER BY sort_order").all(year);
  // 저장 형식(JSON 문자열)이 응답에 새지 않도록 모든 레벨에서 배열로 정규화한다.
  // 카테고리 외의 레벨은 항상 빈 배열이다.
  for (const r of rows) {
    r.excluded_types = parseExcludedTypes(r.excluded_types);
    r.calculation = parseCalculationConfig(r.calculation);
  }
  const nodeMap = {};
  const tree = [];

  // Pass 1: create all nodes
  for (const r of rows) {
    if (r.level === "category") {
      nodeMap[r.id] = { ...r, subcategories: [] };
    } else if (r.level === "subcategory") {
      nodeMap[r.id] = { ...r, groups: [] };
    } else if (r.level === "group") {
      nodeMap[r.id] = { ...r, items: [] };
    }
  }

  // Pass 2: link to parents (order-independent)
  for (const r of rows) {
    if (r.level === "category") {
      tree.push(nodeMap[r.id]);
    } else if (r.level === "subcategory") {
      const parent = nodeMap[r.parent_id];
      if (parent) parent.subcategories.push(nodeMap[r.id]);
    } else if (r.level === "group") {
      const parent = nodeMap[r.parent_id];
      if (parent) parent.groups.push(nodeMap[r.id]);
    } else if (r.level === "item") {
      const parent = nodeMap[r.parent_id];
      if (parent) parent.items.push(r);
    }
  }
  return tree;
}

// GET /api/sheet/template - 연도별 템플릿 트리 반환
app.get("/api/sheet/template", (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  const result = dbRun(() => getTemplateTree(year));

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// sheet_template CHECK 제약과 동기화된 허용값 — 라우트에서 미리 걸러 CHECK 위반 500 대신
// 사람이 읽을 수 있는 400을 반환한다(DDL 변경 시 이 목록도 함께 갱신).
const TEMPLATE_LEVELS = ["category", "subcategory", "group", "item"];
const TEMPLATE_ANSWER_TYPES = ["passfail", "number", "text", "checktable", "counter", "stopwatch"];

function normalizeStoredCounterAnswer(value) {
  const match = String(value ?? "").match(/^(\d+)(?:\.0+)?$/);
  if (!match) return "";
  return match[1].replace(/^0+(?=\d)/, "");
}

// POST /api/sheet/template - 노드 생성
app.post("/api/sheet/template", (req, res) => {
  const { year, level, parent_id, name, sort_order, answer_type, remarks, unit, pdf_include, excluded_types, calculation } = req.body;
  if (!year || !level || !name) return res.status(400).send("필수 필드가 누락되었습니다.");
  if (!TEMPLATE_LEVELS.includes(level)) return res.status(400).send("올바르지 않은 level 값입니다.");
  if (answer_type && !TEMPLATE_ANSWER_TYPES.includes(answer_type)) return res.status(400).send("올바르지 않은 answer_type 값입니다.");
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

  const result = dbRun(() => db.transaction(() => {
    const info = db.prepare(
      "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(year, level, parent_id || null, sort_order || 0, name, answer_type || null, remarks || "", unit || "", pdf_include ?? 1, excluded, fieldKey, storedCalculation);
    validateStoredCalculationGraph(year);
    return info;
  })());

  if (!result.success) {
    logger.warn(req, "template.create", { error: result.internalError || result.error, year }, name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "template.create", { year, level }, name);
  res.json({ id: result.result.lastInsertRowid, field_key: fieldKey });
});

// PUT /api/sheet/template/:id - 노드 수정
app.put("/api/sheet/template/:id", (req, res) => {
  const id = Number(req.params.id);
  // 수정 가능 필드는 아래 구조 분해로 고정된다 — body의 다른 키는 도달 불가
  const { name, sort_order, answer_type, remarks, unit, pdf_include, excluded_types, calculation } = req.body;
  if (answer_type && !TEMPLATE_ANSWER_TYPES.includes(answer_type)) return res.status(400).send("올바르지 않은 answer_type 값입니다.");

  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push("name = ?"); params.push(name); }
  if (sort_order !== undefined) { fields.push("sort_order = ?"); params.push(sort_order); }
  if (answer_type !== undefined) { fields.push("answer_type = ?"); params.push(answer_type || null); }
  if (remarks !== undefined) { fields.push("remarks = ?"); params.push(remarks); }
  if (unit !== undefined) { fields.push("unit = ?"); params.push(unit); }
  if (pdf_include !== undefined) { fields.push("pdf_include = ?"); params.push(pdf_include ? 1 : 0); }
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
    action: "template.update", id, columns: "name, level, year, answer_type, calculation",
  });
  if (!node) return;
  const resultingAnswerType = answer_type === undefined ? node.answer_type : (answer_type || null);
  if (calculation && (node.level !== "item" || resultingAnswerType !== "number")) {
    return res.status(400).send("숫자 문항에만 계산을 설정할 수 있습니다.");
  }
  if (answer_type !== undefined && resultingAnswerType !== "number" && calculation === undefined && node.calculation) {
    fields.push("calculation = ?");
    params.push("");
  }
  params.push(id);

  const result = dbRun(() => db.transaction(() => {
    const update = db.prepare(`UPDATE sheet_template SET ${fields.join(", ")} WHERE id = ?`).run(...params);
    validateStoredCalculationGraph(node.year);
    let normalizedAnswers = 0;
    const nextAnswerType = answer_type || null;

    if (answer_type !== undefined && node.level === "item" && ["counter", "stopwatch"].includes(nextAnswerType)) {
      const rows = db.prepare(
        "SELECT year, team_num, value FROM sheet_answer WHERE item_id = ?"
      ).all(id);
      const normalizeAnswer = db.prepare(`
        UPDATE sheet_answer
        SET value = ?,
            answer_updated_at = ?,
            answer_updated_by = ?
        WHERE year = ? AND team_num = ? AND item_id = ?
      `);
      const updatedAt = new Date().toISOString();
      const updatedBy = req.user?.name || req.user?.email || "";

      for (const row of rows) {
        const normalized = nextAnswerType === "stopwatch" ? "" : normalizeStoredCounterAnswer(row.value);
        if (row.value === normalized) continue;
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
  })());

  if (!result.success) {
    logger.warn(req, "template.update", { error: result.internalError || result.error }, node.name);
    return res.status(result.status).send(result.error);
  }
  if (!result.result.changes) {
    logger.warn(req, "template.update", { error: "항목을 찾을 수 없습니다 (동시 삭제 추정)", id, year: node.year }, node.name);
    return res.status(404).send("항목을 찾을 수 없습니다.");
  }
  logger.log(req, "template.update", {
    fields: Object.fromEntries(fields.map((f, i) => [f.split(" = ")[0], params[i]])),
    normalized_answers: result.result.normalizedAnswers,
  }, node.name);
  res.status(200).send();
});

// DELETE /api/sheet/template/:id - 노드 삭제 (CASCADE)
app.delete("/api/sheet/template/:id", (req, res) => {
  const id = Number(req.params.id);
  const node = templateNodePreflight(req, res, {
    action: "template.delete", id, columns: "year, level, name",
  });
  if (!node) return;
  if (node.year !== currentCompetitionYear()) {
    logger.warn(req, "template.delete", { error: "이전 연도 템플릿 삭제 거부", year: node.year }, node.name);
    return res.status(409).send("현재 연도 템플릿만 수정할 수 있습니다.");
  }

  const result = dbRun(() => db.transaction(() => {
    const info = db.prepare("DELETE FROM sheet_template WHERE id = ?").run(id);
    validateStoredCalculationGraph(node.year);
    return info;
  })());

  if (!result.success) {
    logger.warn(req, "template.delete", { error: result.internalError || result.error }, node.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "template.delete", { year: node.year, level: node.level, id }, node.name);
  res.status(200).send();
});

// POST /api/sheet/template/reorder - 형제 노드 순서 변경
app.post("/api/sheet/template/reorder", (req, res) => {
  const { items } = req.body;
  const rejectReorder = (status, message, context = {}) => {
    logger.warn(req, "template.reorder", {
      error: message,
      phase: "batch_preflight",
      ...context,
    }, "batch");
    return res.status(status).send(message);
  };
  if (!Array.isArray(items)) return rejectReorder(400, "items 배열이 필요합니다.");
  if (items.length === 0) return rejectReorder(400, "하나 이상의 항목이 필요합니다.", { count: 0 });
  if (items.length > 1000) return rejectReorder(400, "항목이 너무 많습니다.", { count: items.length });
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
    return rejectReorder(400, "중복된 항목 id가 있습니다.", { count: items.length, requested_ids: ids });
  }

  let failureContext = {};
  const result = dbRun(() => {
    const stmt = db.prepare("UPDATE sheet_template SET sort_order = ? WHERE id = ?");
    return db.transaction(() => {
      const rows = db.prepare(`
        SELECT id, year, level, parent_id
        FROM sheet_template
        WHERE id IN (${ids.map(() => "?").join(",")})
      `).all(...ids);
      if (rows.length !== ids.length) {
        const found = new Set(rows.map((row) => row.id));
        failureContext = { reason_code: "missing_ids", missing_ids: ids.filter((id) => !found.has(id)) };
        throw { status: 404, message: "항목을 찾을 수 없습니다." };
      }
      const [first] = rows;
      const sameSiblings = rows.every((row) => row.year === first.year
        && row.level === first.level
        && row.parent_id === first.parent_id);
      if (!sameSiblings) {
        failureContext = {
          reason_code: "mixed_siblings",
          nodes: rows.map(({ id, year, level, parent_id }) => ({ id, year, level, parent_id })),
        };
        throw { status: 400, message: "같은 연도와 부모의 형제 항목만 함께 정렬할 수 있습니다." };
      }
      if (first.year !== currentCompetitionYear()) {
        failureContext = { reason_code: "historical_year", year: first.year };
        throw { status: 409, message: "현재 연도 템플릿만 수정할 수 있습니다." };
      }
      let count = 0;
      for (const item of items) {
        const update = stmt.run(item.sort_order, item.id);
        if (update.changes !== 1) {
          failureContext = { reason_code: "update_count_mismatch", id: item.id, changes: update.changes };
          throw { status: 409, message: "템플릿 순서가 동시에 변경되었습니다. 다시 시도하세요." };
        }
        count += update.changes;
      }
      return { count, year: first.year, level: first.level, parentId: first.parent_id };
    })();
  });

  if (!result.success) {
    logger.warn(req, "template.reorder", {
      error: result.internalError || result.error,
      phase: "batch_preflight",
      requested_count: items.length,
      requested_ids: ids,
      ...failureContext,
    }, "batch");
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "template.reorder", result.result, String(result.result.year));
  res.status(200).send();
});

// POST /api/sheet/template/copy - 연도간 템플릿 복사
app.post("/api/sheet/template/copy", (req, res) => {
  const { from_year, to_year } = req.body;
  if (!from_year || !to_year) return res.status(400).send("from_year, to_year가 필요합니다.");

  const result = dbRun(() => {
    const existing = db.prepare("SELECT COUNT(*) as cnt FROM sheet_template WHERE year = ?").get(to_year);
    if (existing.cnt > 0) throw { status: 400, message: "대상 연도에 이미 템플릿이 존재합니다." };

    const rows = db.prepare("SELECT * FROM sheet_template WHERE year = ? ORDER BY id").all(from_year);
    if (!rows.length) throw { status: 400, message: "원본 연도에 템플릿이 없습니다." };

    db.transaction(() => {
      const idMap = {};
      const stmt = db.prepare(
        "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const r of rows) {
        const newParent = r.parent_id ? idMap[r.parent_id] : null;
        // 유형 제외 설정은 이름 기준이므로 연도가 달라도 그대로 옮겨진다.
        const info = stmt.run(to_year, r.level, newParent, r.sort_order, r.name, r.answer_type, r.remarks, r.unit || "", r.pdf_include ?? 1, r.excluded_types || "", r.field_key || "", r.calculation || "");
        idMap[r.id] = info.lastInsertRowid;
      }
      validateStoredCalculationGraph(to_year);
    })();
  });

  if (!result.success) {
    logger.warn(req, "template.copy", { error: result.internalError || result.error, from_year, to_year });
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "template.copy", { from_year, to_year });
  res.status(201).send();
});

// POST /api/sheet/template/import - JSON 파일로 템플릿 가져오기
app.post("/api/sheet/template/import", (req, res) => {
  const { year, template } = req.body;
  if (!year || !Array.isArray(template)) return res.status(400).send("year, template 배열이 필요합니다.");

  const result = dbRun(() => {
    const stmt = db.prepare(
      "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    return db.transaction(() => {
      const replaced = db.prepare("DELETE FROM sheet_template WHERE year = ? AND level = 'category'").run(year).changes;
      for (let ci = 0; ci < template.length; ci++) {
        const cat = template[ci];
        // 다른 필드와 마찬가지로 잘못된 값은 기본값으로 흘려보낸다 — 가져오기 전체를 실패시키지 않는다.
        const excluded = normalizeExcludedTypes(cat.excluded_types) ?? "";
        const catInfo = stmt.run(year, "category", null, ci, cat.name, null, cat.remarks || "", "", cat.pdf_include ?? 1, excluded, "", "");
        const catId = catInfo.lastInsertRowid;

        if (!Array.isArray(cat.subcategories)) continue;
        for (let si = 0; si < cat.subcategories.length; si++) {
          const sub = cat.subcategories[si];
          const subInfo = stmt.run(year, "subcategory", catId, si, sub.name, null, sub.remarks || "", "", 1, "", "", "");
          const subId = subInfo.lastInsertRowid;

          if (!Array.isArray(sub.groups)) continue;
          for (let gi = 0; gi < sub.groups.length; gi++) {
            const grp = sub.groups[gi];
            const grpInfo = stmt.run(year, "group", subId, gi, grp.name, null, grp.remarks || "", "", 1, "", "", "");
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
              stmt.run(year, "item", grpId, ii, item.name, item.answer_type || "passfail", item.remarks || "", item.unit || "", 1, "", fieldKey, storedCalculation);
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
  logger.log(req, "template.import", { year, replaced_categories: result.result.replaced, imported_categories: template.length });
  res.status(201).send();
});

function getInspectionSummary(year) {
  // excluded_types를 함께 내려 목록·성적표가 팀 유형에 해당하지 않는 칸을 비울 수 있게 한다.
  const categories = db.prepare(
    "SELECT id, name, excluded_types FROM sheet_template WHERE year = ? AND level = 'category' ORDER BY sort_order"
  ).all(year).map(c => ({ ...c, excluded_types: parseExcludedTypes(c.excluded_types) }));

  const inspectors = db.prepare(
    `SELECT i.team_num, i.category_id, i.inspector FROM sheet_inspector i
     WHERE i.year = ? AND NOT EXISTS (
       SELECT 1 FROM competition_inactive_team s
       WHERE s.year = i.year AND s.team_num = i.team_num
     )`
  ).all(year);

  const results = db.prepare(
    `SELECT r.team_num, r.category_id, r.result FROM sheet_category_result r
     WHERE r.year = ? AND NOT EXISTS (
       SELECT 1 FROM competition_inactive_team s
       WHERE s.year = r.year AND s.team_num = r.team_num
     )`
  ).all(year);

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

// GET /api/sheet/summary - 모든 팀의 카테고리별 요약
app.get("/api/sheet/summary", (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  const result = dbRun(() => getInspectionSummary(year));

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

function getBulkAnswers(year, itemIds) {
  const placeholders = itemIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT a.team_num, a.item_id, a.value FROM sheet_answer a
     WHERE a.year = ? AND a.item_id IN (${placeholders}) AND a.value != ''
       AND NOT EXISTS (
         SELECT 1 FROM competition_inactive_team s
         WHERE s.year = a.year AND s.team_num = a.team_num
       )`
  ).all(year, ...itemIds);

  const teams = {};
  for (const row of rows) {
    if (!teams[row.team_num]) teams[row.team_num] = {};
    teams[row.team_num][row.item_id] = row.value;
  }
  return teams;
}

// GET /api/sheet/bulk-answers - 벌크 답변 조회 (특정 item_id들의 팀별 값)
app.get("/api/sheet/bulk-answers", (req, res) => {
  const year = Number(req.query.year);
  const itemIdsParam = req.query.item_ids;
  if (!year || !itemIdsParam) return res.status(400).send("year, item_ids 필수");

  const itemIds = itemIdsParam.split(",").map(Number).filter(n => !isNaN(n));
  if (!itemIds.length) return res.status(400).send("유효한 item_ids가 없습니다.");
  if (itemIds.length > 1000) return res.status(400).send("item_ids는 1000개를 초과할 수 없습니다.");

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
  if (!teamPreflight(req, res, { action: "sheet.data", year, teamNum: num, missingStatus: 404 })) return;

  const result = dbRun(() => {
    const answers = db.prepare(`
      SELECT item_id, value, memo,
             answer_updated_at, answer_updated_by,
             memo_updated_at, memo_updated_by
      FROM sheet_answer
      WHERE year = ? AND team_num = ?
    `).all(year, num);

    const categoryResults = db.prepare(
      "SELECT category_id, result FROM sheet_category_result WHERE year = ? AND team_num = ?"
    ).all(year, num);

    const inspectors = db.prepare(
      "SELECT category_id, inspector FROM sheet_inspector WHERE year = ? AND team_num = ?"
    ).all(year, num);

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

// PUT /api/sheet/answer - 답변 upsert
app.put("/api/sheet/answer", (req, res) => {
  const { year, team_num, item_id, value, expectedValue, mutation_id } = req.body;
  if (!year || team_num == null || !item_id) return res.status(400).send("필수 필드가 누락되었습니다.");
  if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(item_id)) {
    return res.status(400).send("필수 필드가 올바르지 않습니다.");
  }
  if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (!teamPreflight(req, res, { action: "answer.update", year, teamNum: team_num })) return;
  if (year !== currentCompetitionYear()) return res.status(409).send("현재 연도 데이터만 수정할 수 있습니다.");
  const templateItem = mutationTemplatePreflight(req, res, {
    action: "answer.update", id: item_id, year,
  });
  if (!templateItem) return;
  const newValue = value ?? "";
  if (templateItem.answer_type === "passfail" && !["", "PASS", "FAIL", "N/A"].includes(newValue)) {
    return res.status(400).send("PASS, FAIL 또는 N/A만 입력할 수 있습니다.");
  }
  if (templateItem.answer_type === "counter" && newValue !== "" && !/^(0|[1-9]\d*)$/.test(String(newValue))) {
    return res.status(400).send("증감 숫자는 0 이상의 정수만 입력할 수 있습니다.");
  }
  if (templateItem.answer_type === "stopwatch") {
    return res.status(400).send("스톱워치 항목은 응답을 저장하지 않습니다.");
  }
  if (parseCalculationConfig(templateItem.calculation)?.mode === "computed") {
    return res.status(400).send("자동 계산 문항에는 값을 직접 저장할 수 없습니다.");
  }
  const expectedValueProvided = Object.hasOwn(req.body, "expectedValue") && typeof expectedValue === "string";

  const updatedAt = new Date().toISOString();
  const updatedBy = req.user?.name?.trim() || "";

  const result = dbRun(() => db.transaction(() => {
    const prev = db.prepare(
      `SELECT value, answer_updated_at, answer_updated_by
       FROM sheet_answer WHERE year = ? AND team_num = ? AND item_id = ?`
    ).get(year, team_num, item_id);
    const current = {
      value: prev?.value ?? "",
      updated_at: prev?.answer_updated_at ?? null,
      updated_by: prev?.answer_updated_by ?? "",
    };

    if ((!expectedValueProvided && current.value !== "")
      || (expectedValueProvided && current.value !== expectedValue)) return { conflict: true, current };

    if (current.value === newValue) {
      return { changed: false, current };
    }
    if (!updatedBy) {
      throw { status: 409, message: "계정 실명을 확인할 수 없어 저장할 수 없습니다. 다시 로그인하세요." };
    }

    db.prepare(
      `INSERT INTO sheet_answer
         (year, team_num, item_id, value, answer_updated_at, answer_updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, item_id) DO UPDATE SET
         value = excluded.value,
         answer_updated_at = excluded.answer_updated_at,
         answer_updated_by = excluded.answer_updated_by`
    ).run(year, team_num, item_id, newValue, updatedAt, updatedBy);

    const inspector = addInspectorForItemEdit({
      year, teamNum: team_num, itemId: item_id, updatedBy,
    });

    return {
      changed: true,
      current: { value: newValue, updated_at: updatedAt, updated_by: updatedBy },
      inspector,
    };
  })());

  if (!result.success) {
    logger.warn(req, "answer.update", { error: result.internalError || result.error, year, item_id }, `#${team_num}`);
    return res.status(result.status).send(result.error);
  }

  if (result.result.conflict) {
    logger.warn(req, "answer.stale_write", {
      code: "INSPECTION_STALE_WRITE", year, item_id, expectedValue, requested: newValue,
      current: result.result.current,
    }, `#${team_num}`);
    return res.status(409).json({
      code: "INSPECTION_STALE_WRITE",
      message: "다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 작성하세요.",
      current: result.result.current,
    });
  }

  if (result.result.changed) {
    logger.log(req, "answer.update", {
      year, item_id, item_name: templateItem.name, value: newValue,
      updated_by: updatedBy,
      inspector_added: result.result.inspector.changed,
      inspectors: result.result.inspector.inspectors,
    }, `#${team_num}`);
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
  if (!year || team_num == null || !item_id) return res.status(400).send("필수 필드가 누락되었습니다.");
  if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(item_id)) {
    return res.status(400).send("필수 필드가 올바르지 않습니다.");
  }
  if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (!teamPreflight(req, res, { action: "memo.update", year, teamNum: team_num })) return;
  if (year !== currentCompetitionYear()) return res.status(409).send("현재 연도 데이터만 수정할 수 있습니다.");
  const templateItem = mutationTemplatePreflight(req, res, {
    action: "memo.update", id: item_id, year,
  });
  if (!templateItem) return;
  const expectedMemoProvided = Object.hasOwn(req.body, "expectedMemo") && typeof expectedMemo === "string";

  const newMemo = memo ?? "";
  const updatedAt = new Date().toISOString();
  const updatedBy = req.user?.name?.trim() || "";
  const result = dbRun(() => db.transaction(() => {
    const prev = db.prepare(
      `SELECT memo, memo_updated_at, memo_updated_by
       FROM sheet_answer WHERE year = ? AND team_num = ? AND item_id = ?`
    ).get(year, team_num, item_id);
    const current = {
      memo: prev?.memo ?? "",
      updated_at: prev?.memo_updated_at ?? null,
      updated_by: prev?.memo_updated_by ?? "",
    };

    if ((!expectedMemoProvided && current.memo !== "")
      || (expectedMemoProvided && current.memo !== expectedMemo)) return { conflict: true, current };

    if (current.memo === newMemo) {
      return { changed: false, current };
    }
    if (!updatedBy) {
      throw { status: 409, message: "계정 실명을 확인할 수 없어 저장할 수 없습니다. 다시 로그인하세요." };
    }

    db.prepare(
      `INSERT INTO sheet_answer
         (year, team_num, item_id, memo, memo_updated_at, memo_updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, item_id) DO UPDATE SET
         memo = excluded.memo,
         memo_updated_at = excluded.memo_updated_at,
         memo_updated_by = excluded.memo_updated_by`
    ).run(year, team_num, item_id, newMemo, updatedAt, updatedBy);

    const inspector = addInspectorForItemEdit({
      year, teamNum: team_num, itemId: item_id, updatedBy,
    });

    return {
      changed: true,
      current: { memo: newMemo, updated_at: updatedAt, updated_by: updatedBy },
      inspector,
    };
  })());

  if (!result.success) {
    logger.warn(req, "memo.update", { error: result.internalError || result.error, year, item_id }, `#${team_num}`);
    return res.status(result.status).send(result.error);
  }

  if (result.result.conflict) {
    logger.warn(req, "memo.stale_write", {
      code: "INSPECTION_STALE_WRITE", year, item_id, expectedMemo, requested: newMemo,
      current: result.result.current,
    }, `#${team_num}`);
    return res.status(409).json({
      code: "INSPECTION_STALE_WRITE",
      message: "다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 작성하세요.",
      current: result.result.current,
    });
  }

  if (result.result.changed) {
    logger.log(req, "memo.update", {
      year, item_id, item_name: templateItem.name, memo: newMemo,
      updated_by: updatedBy,
      inspector_added: result.result.inspector.changed,
      inspectors: result.result.inspector.inspectors,
    }, `#${team_num}`);
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
  if (!year || team_num == null || !category_id) return res.status(400).send("필수 필드가 누락되었습니다.");
  if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(category_id)) {
    return res.status(400).send("필수 필드가 올바르지 않습니다.");
  }
  if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (!teamPreflight(req, res, { action: "category_result.update", year, teamNum: team_num })) return;
  if (catResult !== undefined && catResult !== null && catResult !== "" && !["PASS", "FAIL"].includes(catResult)) {
    return res.status(400).send("결과는 PASS, FAIL 또는 비움이어야 합니다.");
  }
  if (year !== currentCompetitionYear()) return res.status(409).send("현재 연도 데이터만 수정할 수 있습니다.");
  const templateCat = mutationTemplatePreflight(req, res, {
    action: "category_result.update", id: category_id, year, level: "category",
  });
  if (!templateCat) return;

  if (catResult === "PASS") {
    const completion = dbRun(() => getCategoryCompletion(year, team_num, category_id));
    if (!completion.success) {
      logger.warn(req, "category_result.update", {
        error: completion.internalError || completion.error,
        phase: "category_completion_lookup",
        year,
        category_id,
      }, `#${team_num}`);
      return res.status(completion.status).send(completion.error);
    }
    if (!completion.result.complete) {
      logger.warn(req, "category_result.update", {
        error: "category_incomplete",
        reason: "category_pass_requires_complete_responses",
        year,
        category_id,
        completed: completion.result.completed,
        total: completion.result.total,
        requested_result: catResult,
      }, `#${team_num}`);
      return res.status(409).send("모든 문항을 입력한 뒤 PASS할 수 있습니다.");
    }
  }

  const r = dbRun(() =>
    db.prepare(
      "INSERT INTO sheet_category_result (year, team_num, category_id, result) VALUES (?, ?, ?, ?) ON CONFLICT(year, team_num, category_id) DO UPDATE SET result = excluded.result"
    ).run(year, team_num, category_id, catResult ?? "")
  );

  if (!r.success) {
    logger.warn(req, "category_result.update", { error: r.internalError || r.error, year, category_id }, `#${team_num}`);
    return res.status(r.status).send(r.error);
  }

  logger.log(req, "category_result.update", { year, category_id, category_name: templateCat.name, result: catResult }, `#${team_num}`);
  broadcastEvent("category-result", { year, team_num, category_id, result: catResult ?? "" });

  res.status(200).send();
});

if (!options.skipSpaFallback) addSpaFallback(app);

return {
  app,
  db,
  closeSse,
  sourceEvent: broadcastSSEEvent,
  queries: { templateTree: getTemplateTree, summary: getInspectionSummary, bulkAnswers: getBulkAnswers },
};
}
