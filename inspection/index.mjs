import express from "express";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createDatabase, runMigrationOnce } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir, requireInternalRequest } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { registerTeamLifecycleRoutes } from "../shared/team-lifecycle.mjs";
import {
  parseCalculationConfig,
  serializeCalculationConfig,
  validateCalculationGraph,
} from "./lib/calculations.mjs";

const PORT = 9400;

export function createInspectionApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/sheet.db");

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
    answer_version INTEGER NOT NULL DEFAULT 0,
    answer_updated_at TEXT,
    answer_updated_by TEXT,
    memo_version INTEGER NOT NULL DEFAULT 0,
    memo_updated_at TEXT,
    memo_updated_by TEXT,
    PRIMARY KEY (year, team_num, item_id),
    FOREIGN KEY (item_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);
  const answerCols = db.prepare("PRAGMA table_info(sheet_answer)").all();
  const answerMigrations = [
    ["answer_version", "INTEGER NOT NULL DEFAULT 0"],
    ["answer_updated_at", "TEXT"],
    ["answer_updated_by", "TEXT"],
    ["memo_version", "INTEGER NOT NULL DEFAULT 0"],
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
})();

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

// 2026 축전지 검사지에 규정 기반 계산을 최초 한 번 연결한다. 라이브 DB를 별도
// 스크립트로 직접 편집하지 않고 애플리케이션 스키마 마이그레이션으로 멱등 적용한다.
runMigrationOnce(db, "inspection_2026_imd_tsmp_calculations_v1", () => {
  const group = db.prepare(`
    SELECT g.id
    FROM sheet_template g
    JOIN sheet_template s ON s.id = g.parent_id
    JOIN sheet_template c ON c.id = s.parent_id
    WHERE g.year = 2026 AND g.level = 'group' AND g.name = '기본정보'
      AND REPLACE(s.name, ' ', '') LIKE '축전지검사%'
      AND c.name = '축전지'
    ORDER BY g.id LIMIT 1
  `).get();
  if (!group) return;

  const imd = db.prepare("SELECT * FROM sheet_template WHERE parent_id = ? AND level = 'item' AND name = 'IMD 테스트 값'").get(group.id);
  const tsmp = db.prepare("SELECT * FROM sheet_template WHERE parent_id = ? AND level = 'item' AND name = 'TSMP 전류제한 저항값'").get(group.id);
  const maxVoltage = db.prepare(`
    SELECT i.*
    FROM sheet_template i
    JOIN sheet_template g ON g.id = i.parent_id
    JOIN sheet_template s ON s.id = g.parent_id
    JOIN sheet_template c ON c.id = s.parent_id
    WHERE i.year = 2026 AND i.level = 'item' AND i.name = 'TS Voltage (max)'
      AND g.name = '차량 제원' AND s.name = '기본사항' AND c.name = '축전지'
    ORDER BY i.id LIMIT 1
  `).get();
  if (!imd || !tsmp || !maxVoltage) return;

  const keys = {
    maxVoltage: "accumulator.ts-voltage-max",
    currentVoltage: "accumulator.ts-voltage-current",
    imd: "accumulator.imd-test-resistance",
    tsmp: "accumulator.tsmp-measured-resistance",
  };
  db.prepare("UPDATE sheet_template SET field_key = ? WHERE id = ?").run(keys.maxVoltage, maxVoltage.id);

  let currentVoltage = db.prepare(
    "SELECT * FROM sheet_template WHERE parent_id = ? AND level = 'item' AND name = '현재 TS 전압'"
  ).get(group.id);
  if (!currentVoltage) {
    db.prepare("UPDATE sheet_template SET sort_order = sort_order + 1 WHERE parent_id = ? AND sort_order >= ?")
      .run(group.id, imd.sort_order);
    const info = db.prepare(`
      INSERT INTO sheet_template
        (year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation)
      VALUES (2026, 'item', ?, ?, '현재 TS 전압', 'number', 'IMD 테스트 시점의 측정 전압', 'V', 1, '', ?, '')
    `).run(group.id, imd.sort_order, keys.currentVoltage);
    currentVoltage = { id: Number(info.lastInsertRowid) };
  } else {
    db.prepare("UPDATE sheet_template SET field_key = ?, answer_type = 'number', unit = 'V' WHERE id = ?")
      .run(keys.currentVoltage, currentVoltage.id);
  }

  const imdCalculation = serializeCalculationConfig({
    mode: "computed", operation: "multiply", sources: [keys.currentVoltage], factor: 0.25, precision: 2,
  });
  const tsmpCalculation = serializeCalculationConfig({
    mode: "suggestion", operation: "range_lookup", sources: [keys.maxVoltage], precision: 0,
    ranges: [{ max: 200, value: 5 }, { max: 400, value: 10 }, { max: 600, value: 15 }],
  });
  db.prepare("UPDATE sheet_template SET field_key = ?, calculation = ?, remarks = '(현재 TS 전압 × 0.25 kΩ/V)', unit = 'kΩ' WHERE id = ?")
    .run(keys.imd, imdCalculation, imd.id);
  db.prepare("UPDATE sheet_template SET field_key = ?, calculation = ? WHERE id = ?")
    .run(keys.tsmp, tsmpCalculation, tsmp.id);
  validateStoredCalculationGraph(2026);
});

// v1이 이미 적용된 환경의 IMD 표시 단위를 Ω에서 kΩ으로 환산한다.
runMigrationOnce(db, "inspection_2026_imd_kohm_v2", () => {
  const imd = db.prepare(`
    SELECT id, field_key FROM sheet_template
    WHERE year = 2026 AND level = 'item' AND name = 'IMD 테스트 값'
    ORDER BY CASE WHEN field_key = 'accumulator.imd-test-resistance' THEN 0 ELSE 1 END, id
    LIMIT 1
  `).get();
  if (!imd) return;
  const sourceKey = "accumulator.ts-voltage-current";
  const source = db.prepare(
    "SELECT 1 FROM sheet_template WHERE year = 2026 AND level = 'item' AND field_key = ?"
  ).get(sourceKey);
  if (!source) return;
  const calculation = serializeCalculationConfig({
    mode: "computed", operation: "multiply", sources: [sourceKey], factor: 0.25, precision: 2,
  });
  db.prepare(`
    UPDATE sheet_template
    SET field_key = 'accumulator.imd-test-resistance',
        calculation = ?, remarks = '(현재 TS 전압 × 0.25 kΩ/V)', unit = 'kΩ'
    WHERE id = ?
  `).run(calculation, imd.id);
  validateStoredCalculationGraph(2026);
});

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "inspection");

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path.startsWith("/api/internal/")) return "admin";
  if (req.path.startsWith("/api/sheet/template") && req.method !== "GET") return "chief";
  if (req.path === "/api/logs") return "admin";
  if (req.path.startsWith("/api/")) return "official";
  return "official"; // SPA
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

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

// GET /api/sheet/template - 연도별 템플릿 트리 반환
app.get("/api/sheet/template", (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  const result = dbRun(() => {
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
  });

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
    logger.warn(req, "template.create", { error: result.error, year }, name);
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

  const node = db.prepare("SELECT name, level, year, answer_type, calculation FROM sheet_template WHERE id = ?").get(id);
  if (!node) return res.status(404).send("항목을 찾을 수 없습니다.");
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
            answer_version = answer_version + 1,
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
    logger.warn(req, "template.update", { error: result.error }, node.name);
    return res.status(result.status).send(result.error);
  }
  if (!result.result.changes) {
    logger.warn(req, "template.update", { changes: 0 }, node.name);
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
  const node = db.prepare("SELECT year, name FROM sheet_template WHERE id = ?").get(id);
  if (!node) return res.status(404).send("노드를 찾을 수 없습니다.");
  if (node.year < new Date().getFullYear()) {
    logger.warn(req, "template.delete", { error: "이전 연도 템플릿 삭제 거부", year: node.year }, node.name);
    return res.status(400).send("이전 연도 템플릿은 수정할 수 없습니다.");
  }

  const result = dbRun(() => db.transaction(() => {
    const info = db.prepare("DELETE FROM sheet_template WHERE id = ?").run(id);
    validateStoredCalculationGraph(node.year);
    return info;
  })());

  if (!result.success) {
    logger.warn(req, "template.delete", { error: result.error }, node.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "template.delete", { year: node.year }, node.name);
  res.status(200).send();
});

// POST /api/sheet/template/reorder - 형제 노드 순서 변경
app.post("/api/sheet/template/reorder", (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).send("items 배열이 필요합니다.");
  if (items.length > 1000) return res.status(400).send("항목이 너무 많습니다.");
  for (const item of items) {
    if (!Number.isInteger(item.id) || !Number.isInteger(item.sort_order)) {
      return res.status(400).send("각 항목에 유효한 id와 sort_order가 필요합니다.");
    }
  }
  const result = dbRun(() => {
    const stmt = db.prepare("UPDATE sheet_template SET sort_order = ? WHERE id = ?");
    db.transaction(() => {
      for (const item of items) {
        stmt.run(item.sort_order, item.id);
      }
    })();
  });

  if (!result.success) {
    logger.warn(req, "template.reorder", { error: result.error, count: items.length });
    return res.status(result.status).send(result.error);
  }
  const firstItem = db.prepare("SELECT year FROM sheet_template WHERE id = ?").get(items[0].id);
  logger.log(req, "template.reorder", { count: items.length, year: firstItem?.year });
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
    logger.warn(req, "template.copy", { error: result.error, from_year, to_year });
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

    db.transaction(() => {
      db.prepare("DELETE FROM sheet_template WHERE year = ? AND level = 'category'").run(year);
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
    })();
  });

  if (!result.success) {
    logger.warn(req, "template.import", { error: result.error, year });
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "template.import", { year });
  res.status(201).send();
});

// GET /api/sheet/summary - 모든 팀의 카테고리별 요약
app.get("/api/sheet/summary", (req, res) => {
  const year = Number(req.query.year);
  if (!year) return res.status(400).send("연도를 지정해야 합니다.");

  const result = dbRun(() => {
    // excluded_types를 함께 내려 목록·성적표가 팀 유형에 해당하지 않는 칸을 비울 수 있게 한다.
    const categories = db.prepare(
      "SELECT id, name, excluded_types FROM sheet_template WHERE year = ? AND level = 'category' ORDER BY sort_order"
    ).all(year).map(c => ({ ...c, excluded_types: parseExcludedTypes(c.excluded_types) }));

    const inspectors = db.prepare(
      "SELECT team_num, category_id, inspector FROM sheet_inspector WHERE year = ?"
    ).all(year);

    const results = db.prepare(
      "SELECT team_num, category_id, result FROM sheet_category_result WHERE year = ?"
    ).all(year);

    const teams = {};
    for (const row of inspectors) {
      if (!teams[row.team_num]) teams[row.team_num] = { inspectors: {}, results: {} };
      teams[row.team_num].inspectors[row.category_id] = row.inspector;
    }
    for (const row of results) {
      if (!teams[row.team_num]) teams[row.team_num] = { inspectors: {}, results: {} };
      teams[row.team_num].results[row.category_id] = row.result;
    }

    return { categories, teams };
  });

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// GET /api/sheet/bulk-answers - 벌크 답변 조회 (특정 item_id들의 팀별 값)
app.get("/api/sheet/bulk-answers", (req, res) => {
  const year = Number(req.query.year);
  const itemIdsParam = req.query.item_ids;
  if (!year || !itemIdsParam) return res.status(400).send("year, item_ids 필수");

  const itemIds = itemIdsParam.split(",").map(Number).filter(n => !isNaN(n));
  if (!itemIds.length) return res.status(400).send("유효한 item_ids가 없습니다.");
  if (itemIds.length > 1000) return res.status(400).send("item_ids는 1000개를 초과할 수 없습니다.");

  const result = dbRun(() => {
    const placeholders = itemIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT team_num, item_id, value FROM sheet_answer WHERE year = ? AND item_id IN (${placeholders}) AND value != ''`
    ).all(year, ...itemIds);

    const teams = {};
    for (const row of rows) {
      if (!teams[row.team_num]) teams[row.team_num] = {};
      teams[row.team_num][row.item_id] = row.value;
    }
    return teams;
  });

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// GET /api/sheet/data/:year/:num - 팀의 모든 시트 데이터 반환
app.get("/api/sheet/data/:year/:num", (req, res) => {
  const year = Number(req.params.year);
  const num = Number(req.params.num);

  const result = dbRun(() => {
    const answers = db.prepare(`
      SELECT item_id, value, memo,
             answer_version, answer_updated_at, answer_updated_by,
             memo_version, memo_updated_at, memo_updated_by
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
        answer_version: a.answer_version,
        answer_updated_at: a.answer_updated_at,
        answer_updated_by: a.answer_updated_by,
        memo_version: a.memo_version,
        memo_updated_at: a.memo_updated_at,
        memo_updated_by: a.memo_updated_by,
      };
    }

    const resultsMap = {};
    for (const r of categoryResults) resultsMap[r.category_id] = r.result;

    const inspectorsMap = {};
    for (const i of inspectors) inspectorsMap[i.category_id] = i.inspector;

    return { answers: answersMap, results: resultsMap, inspectors: inspectorsMap };
  });

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// PUT /api/sheet/answer - 답변 upsert
app.put("/api/sheet/answer", (req, res) => {
  const { year, team_num, item_id, value, base_version, mutation_id } = req.body;
  if (!year || team_num == null || !item_id) return res.status(400).send("필수 필드가 누락되었습니다.");
  if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(item_id)) {
    return res.status(400).send("필수 필드가 올바르지 않습니다.");
  }
  if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (year < new Date().getFullYear()) return res.status(400).send("이전 연도 데이터는 수정할 수 없습니다.");
  const templateItem = db.prepare("SELECT id, name, answer_type, calculation FROM sheet_template WHERE id = ? AND year = ?").get(item_id, year);
  if (!templateItem) return res.status(400).send("해당 연도에 존재하지 않는 항목입니다.");
  const newValue = value ?? "";
  if (templateItem.answer_type === "passfail" && !["", "PASS", "FAIL"].includes(newValue)) {
    return res.status(400).send("PASS 또는 FAIL만 입력할 수 있습니다.");
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
  if (base_version !== undefined && (!Number.isInteger(base_version) || base_version < 0)) {
    return res.status(400).send("올바르지 않은 답변 버전입니다.");
  }

  const updatedAt = new Date().toISOString();
  const updatedBy = req.user?.name || req.user?.email || "";

  const result = dbRun(() => {
    const prev = db.prepare(
      `SELECT value, answer_version, answer_updated_at, answer_updated_by
       FROM sheet_answer WHERE year = ? AND team_num = ? AND item_id = ?`
    ).get(year, team_num, item_id);
    const current = {
      value: prev?.value ?? "",
      version: prev?.answer_version ?? 0,
      updated_at: prev?.answer_updated_at ?? null,
      updated_by: prev?.answer_updated_by ?? "",
    };

    if (base_version !== undefined && base_version !== current.version) {
      return { conflict: true, current };
    }

    if (current.value === newValue) {
      return { changed: false, current };
    }

    const nextVersion = current.version + 1;

    db.prepare(
      `INSERT INTO sheet_answer
         (year, team_num, item_id, value, answer_version, answer_updated_at, answer_updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, item_id) DO UPDATE SET
         value = excluded.value,
         answer_version = excluded.answer_version,
         answer_updated_at = excluded.answer_updated_at,
         answer_updated_by = excluded.answer_updated_by`
    ).run(year, team_num, item_id, newValue, nextVersion, updatedAt, updatedBy);

    return {
      changed: true,
      current: { value: newValue, version: nextVersion, updated_at: updatedAt, updated_by: updatedBy },
    };
  });

  if (!result.success) {
    logger.warn(req, "answer.update", { error: result.error, year, item_id }, `#${team_num}`);
    return res.status(result.status).send(result.error);
  }

  if (result.result.conflict) {
    return res.status(409).json({
      error: "다른 사용자가 이 답변을 먼저 수정했습니다.",
      current: result.result.current,
    });
  }

  if (result.result.changed) {
    logger.log(req, "answer.update", { year, item_id, item_name: templateItem.name, value: newValue }, `#${team_num}`);
    broadcastEvent("answer", {
      year,
      team_num,
      item_id,
      value: newValue,
      version: result.result.current.version,
      updated_at: result.result.current.updated_at,
      updated_by: result.result.current.updated_by,
      mutation_id: typeof mutation_id === "string" ? mutation_id : undefined,
    });
  }

  res.status(200).json({
    ...result.result.current,
    mutation_id: typeof mutation_id === "string" ? mutation_id : undefined,
  });
});

// PUT /api/sheet/memo - 메모 upsert
app.put("/api/sheet/memo", (req, res) => {
  const { year, team_num, item_id, memo, base_version, mutation_id } = req.body;
  if (!year || team_num == null || !item_id) return res.status(400).send("필수 필드가 누락되었습니다.");
  if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(item_id)) {
    return res.status(400).send("필수 필드가 올바르지 않습니다.");
  }
  if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (year < new Date().getFullYear()) return res.status(400).send("이전 연도 데이터는 수정할 수 없습니다.");
  const templateItem = db.prepare("SELECT id, name FROM sheet_template WHERE id = ? AND year = ?").get(item_id, year);
  if (!templateItem) return res.status(400).send("해당 연도에 존재하지 않는 항목입니다.");
  if (base_version !== undefined && (!Number.isInteger(base_version) || base_version < 0)) {
    return res.status(400).send("올바르지 않은 메모 버전입니다.");
  }

  const newMemo = memo ?? "";
  const updatedAt = new Date().toISOString();
  const updatedBy = req.user?.name || req.user?.email || "";
  const result = dbRun(() => {
    const prev = db.prepare(
      `SELECT memo, memo_version, memo_updated_at, memo_updated_by
       FROM sheet_answer WHERE year = ? AND team_num = ? AND item_id = ?`
    ).get(year, team_num, item_id);
    const current = {
      memo: prev?.memo ?? "",
      version: prev?.memo_version ?? 0,
      updated_at: prev?.memo_updated_at ?? null,
      updated_by: prev?.memo_updated_by ?? "",
    };

    if (base_version !== undefined && base_version !== current.version) {
      return { conflict: true, current };
    }

    if (current.memo === newMemo) {
      return { changed: false, current };
    }

    const nextVersion = current.version + 1;
    db.prepare(
      `INSERT INTO sheet_answer
         (year, team_num, item_id, memo, memo_version, memo_updated_at, memo_updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, item_id) DO UPDATE SET
         memo = excluded.memo,
         memo_version = excluded.memo_version,
         memo_updated_at = excluded.memo_updated_at,
         memo_updated_by = excluded.memo_updated_by`
    ).run(year, team_num, item_id, newMemo, nextVersion, updatedAt, updatedBy);

    return {
      changed: true,
      current: { memo: newMemo, version: nextVersion, updated_at: updatedAt, updated_by: updatedBy },
    };
  });

  if (!result.success) {
    logger.warn(req, "memo.update", { error: result.error, year, item_id }, `#${team_num}`);
    return res.status(result.status).send(result.error);
  }

  if (result.result.conflict) {
    return res.status(409).json({
      error: "다른 사용자가 이 메모를 먼저 수정했습니다.",
      current: result.result.current,
    });
  }

  if (result.result.changed) {
    logger.log(req, "memo.update", { year, item_id, item_name: templateItem.name, memo: newMemo }, `#${team_num}`);
    broadcastEvent("memo", {
      year,
      team_num,
      item_id,
      memo: newMemo,
      version: result.result.current.version,
      updated_at: result.result.current.updated_at,
      updated_by: result.result.current.updated_by,
      mutation_id: typeof mutation_id === "string" ? mutation_id : undefined,
    });
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
  if (catResult !== undefined && catResult !== null && catResult !== "" && !["PASS", "FAIL"].includes(catResult)) {
    return res.status(400).send("결과는 PASS, FAIL 또는 비움이어야 합니다.");
  }
  if (year < new Date().getFullYear()) return res.status(400).send("이전 연도 데이터는 수정할 수 없습니다.");
  const templateCat = db.prepare("SELECT id, name FROM sheet_template WHERE id = ? AND year = ? AND level = 'category'").get(category_id, year);
  if (!templateCat) return res.status(400).send("해당 연도에 존재하지 않는 카테고리입니다.");

  const r = dbRun(() =>
    db.prepare(
      "INSERT INTO sheet_category_result (year, team_num, category_id, result) VALUES (?, ?, ?, ?) ON CONFLICT(year, team_num, category_id) DO UPDATE SET result = excluded.result"
    ).run(year, team_num, category_id, catResult ?? "")
  );

  if (!r.success) {
    logger.warn(req, "category_result.update", { error: r.error, year, category_id }, `#${team_num}`);
    return res.status(r.status).send(r.error);
  }

  logger.log(req, "category_result.update", { year, category_id, category_name: templateCat.name, result: catResult }, `#${team_num}`);
  broadcastEvent("category-result", { year, team_num, category_id, result: catResult ?? "" });

  res.status(200).send();
});

// PUT /api/sheet/inspector - 검차관 upsert
app.put("/api/sheet/inspector", (req, res) => {
  const { year, team_num, category_id, inspector } = req.body;
  if (!year || team_num == null || !category_id) return res.status(400).send("필수 필드가 누락되었습니다.");
  if (!Number.isInteger(year) || !Number.isInteger(team_num) || !Number.isInteger(category_id)) {
    return res.status(400).send("필수 필드가 올바르지 않습니다.");
  }
  if (team_num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (year < new Date().getFullYear()) return res.status(400).send("이전 연도 데이터는 수정할 수 없습니다.");
  const templateCat = db.prepare("SELECT id, name FROM sheet_template WHERE id = ? AND year = ? AND level = 'category'").get(category_id, year);
  if (!templateCat) return res.status(400).send("해당 연도에 존재하지 않는 카테고리입니다.");

  const result = dbRun(() =>
    db.prepare(
      "INSERT INTO sheet_inspector (year, team_num, category_id, inspector) VALUES (?, ?, ?, ?) ON CONFLICT(year, team_num, category_id) DO UPDATE SET inspector = excluded.inspector"
    ).run(year, team_num, category_id, inspector ?? "")
  );

  if (!result.success) {
    logger.warn(req, "inspector.update", { error: result.error, year, category_id }, `#${team_num}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "inspector.update", { year, category_id, category_name: templateCat.name, inspector }, `#${team_num}`);
  broadcastEvent("inspector", { year, team_num, category_id, inspector: inspector ?? "" });

  res.status(200).send();
});

/* ============================================
   Internal API: 엔트리 라이프사이클 연동
   ============================================ */

registerTeamLifecycleRoutes(app, {
  db, dbRun, logger, requireInternalRequest, broadcastEvent,
  tables: ["sheet_answer", "sheet_category_result", "sheet_inspector"],
  channels: ["answer", "category-result", "inspector"],
});

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createInspectionApp();
  setupProcessHandlers(db);
  app.listen(PORT, () => console.log(`Inspection service running on port ${PORT}`));
}
