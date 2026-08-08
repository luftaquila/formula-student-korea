import express from "express";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { runMigrationOnce } from "../shared/db-setup.mjs";
import { createServiceSkeleton, addSpaFallback, runIfDirect } from "../shared/service-bootstrap.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { createTeamStateClient } from "../shared/team-state-client.mjs";
import {
  parseCalculationConfig,
  serializeCalculationConfig,
  validateCalculationGraph,
} from "./lib/calculations.mjs";

export function createInspectionApp(options = {}) {

const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "inspection", express, Database, options, dbFile: "sheet.db",
  authRoleFn: (req) => {
    if (req.path === "/api/health") return null;
    if (req.path.startsWith("/api/sheet/template") && req.method !== "GET") return "chief";
    if (req.path === "/api/logs") return "admin";
    if (req.path.startsWith("/api/")) return "official";
    return "official"; // SPA
  },
});

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
  // team_id = entry의 불변 팀 id(리넘버·개명에도 불변). 레거시 행은 NULL로 남았다가
  // team-state 백필이 (year, team_num) 매칭으로 채운다. team_num은 표시·레거시 키.
  // PK 대신 rowid 테이블 + 이중 UNIQUE 인덱스(아래, 마이그레이션 뒤에 생성).
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_answer (
    year INTEGER NOT NULL,
    team_id INTEGER,
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
  // 검차 시트 큰 카테고리별 결과 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_category_result (
    year INTEGER NOT NULL,
    team_id INTEGER,
    team_num INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    result TEXT DEFAULT '' CHECK(result IN ('PASS', 'FAIL', '')),
    FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);

  // 검차 시트 큰 카테고리별 검차관 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_inspector (
    year INTEGER NOT NULL,
    team_id INTEGER,
    team_num INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    inspector TEXT DEFAULT '',
    FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);

  // 기존 배포 DB의 (year, team_num, item_id|category_id) PK 테이블을 team_id 병기
  // 스키마로 재구축. PK 대신 rowid 테이블 + 이중 UNIQUE 인덱스(id 키 = 새 조인 키,
  // num 키 = 기존 불변식 "연도·번호·항목당 1행" 유지 + 백필 전 안전망). 테이블 RENAME은
  // 기존 인덱스를 _old 쪽에 남기므로(DROP과 함께 소멸) 모든 인덱스는 이 아래에서
  // 새 테이블에 다시 만든다. FK(sheet_template ON DELETE CASCADE)는 그대로 보존.
  runMigrationOnce(db, "inspection.team_id_rekey.v1", () => {
    const REBUILD = {
      sheet_answer: {
        create: `CREATE TABLE sheet_answer (
          year INTEGER NOT NULL, team_id INTEGER, team_num INTEGER NOT NULL,
          item_id INTEGER NOT NULL, value TEXT DEFAULT '', memo TEXT DEFAULT '',
          answer_version INTEGER NOT NULL DEFAULT 0, answer_updated_at TEXT, answer_updated_by TEXT,
          memo_version INTEGER NOT NULL DEFAULT 0, memo_updated_at TEXT, memo_updated_by TEXT,
          FOREIGN KEY (item_id) REFERENCES sheet_template(id) ON DELETE CASCADE
        )`,
        copyCols: "year, team_num, item_id, value, memo, answer_version, answer_updated_at, answer_updated_by, memo_version, memo_updated_at, memo_updated_by",
      },
      sheet_category_result: {
        create: `CREATE TABLE sheet_category_result (
          year INTEGER NOT NULL, team_id INTEGER, team_num INTEGER NOT NULL,
          category_id INTEGER NOT NULL, result TEXT DEFAULT '' CHECK(result IN ('PASS', 'FAIL', '')),
          FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
        )`,
        copyCols: "year, team_num, category_id, result",
      },
      sheet_inspector: {
        create: `CREATE TABLE sheet_inspector (
          year INTEGER NOT NULL, team_id INTEGER, team_num INTEGER NOT NULL,
          category_id INTEGER NOT NULL, inspector TEXT DEFAULT '',
          FOREIGN KEY (category_id) REFERENCES sheet_template(id) ON DELETE CASCADE
        )`,
        copyCols: "year, team_num, category_id, inspector",
      },
    };
    for (const [table, { create, copyCols }] of Object.entries(REBUILD)) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (cols.includes("team_id")) continue; // 신규 DB — 위 CREATE가 이미 새 스키마
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      db.exec(create);
      db.exec(`INSERT INTO ${table} (${copyCols}) SELECT ${copyCols} FROM ${table}_old`);
      db.exec(`DROP TABLE ${table}_old`);
    }
  }, { transaction: false });

  // 이중 UNIQUE 인덱스 + 보조 인덱스 — 마이그레이션 밖(멱등), 새 테이블 기준으로 생성
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_id_key ON sheet_answer(year, team_id, item_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_num_key ON sheet_answer(year, team_num, item_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_scr_id_key ON sheet_category_result(year, team_id, category_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_scr_num_key ON sheet_category_result(year, team_num, category_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_si_id_key ON sheet_inspector(year, team_id, category_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_si_num_key ON sheet_inspector(year, team_num, category_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sa_item ON sheet_answer(item_id)");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sa_year_item_team_value
    ON sheet_answer(year, item_id, team_num, value)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_scr_category ON sheet_category_result(category_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_si_category ON sheet_inspector(category_id)");
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

// 특정 연도나 문항을 기준으로 템플릿 내용을 시작 시 삽입·수정하지 않는다.
// 업무 템플릿은 관리 API 또는 명시적인 JSON 가져오기를 통해서만 변경한다.

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

// SSE 엔드포인트
app.get("/api/sheet/events", sseHandler());

/* ============================================
   Entry team-state (미러 대체 캐시 + 수렴형 강제)
   ============================================ */
const teamState = createTeamStateClient({ db, logger, service: "inspection" });

const SHEET_TABLES = ["sheet_answer", "sheet_category_result", "sheet_inspector"];

// 백필: 레거시 (year, team_num) 행에 team_id를 채운다 (연도별 1회, 첫 유효 스냅샷)
teamState.registerBackfill((year, state) => {
  const updates = SHEET_TABLES.map((t) =>
    db.prepare(`UPDATE ${t} SET team_id = ? WHERE year = ? AND team_num = ? AND team_id IS NULL`));
  for (const team of state.teams.values()) {
    for (const upd of updates) upd.run(team.id, year, team.num);
  }
  let orphans = 0;
  for (const t of SHEET_TABLES) {
    orphans += db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE year = ? AND team_id IS NULL`).get(year).c;
  }
  if (orphans > 0) {
    // entry가 모르는 팀의 행 — 삭제하지 않고 로그만 (기존 reconcile 철학)
    logger.warn(null, "inspection.team_id_backfill", { year, unmatched_rows: orphans });
  }
});

// 수렴형 강제: 스냅샷 version이 바뀔 때마다 멱등 실행
teamState.registerEnforcement((year, state) => {
  // ① tombstone cascade — 삭제·교체된 팀의 시트 데이터 삭제 (기존 DELETE /api/internal/team 시맨틱)
  const deleters = SHEET_TABLES.map((t) =>
    db.prepare(`DELETE FROM ${t} WHERE year = ? AND team_id = ?`));
  let deletedRows = 0;
  const deletedIds = [];
  for (const t of state.tombstones) {
    let n = 0;
    for (const del of deleters) n += del.run(year, t.id).changes;
    if (n > 0) {
      deletedRows += n;
      deletedIds.push(t.id);
    }
  }
  if (deletedRows > 0) {
    logger.log(null, "team.delete", { year, team_ids: deletedIds, rows: deletedRows });
  }

  // ② 비활성 정리 훅 없음 — inspection은 조회 필터로만 제외한다 (기존과 동일)

  // ③ 비정규화 갱신: 리넘버된 팀의 team_num을 id 기준으로 최신화
  const renumbers = SHEET_TABLES.map((t) =>
    db.prepare(`UPDATE ${t} SET team_num = ? WHERE year = ? AND team_id = ? AND team_num != ?`));
  let renumbered = 0;
  for (const team of state.teams.values()) {
    for (const upd of renumbers) renumbered += upd.run(team.num, year, team.id, team.num).changes;
  }
  if (renumbered > 0) logger.log(null, "team.renumber", { year, rows: renumbered });

  // ④ 모르는 팀(스냅샷·tombstone 어디에도 없는 team_id) — 로그만, 삭제 금지
  const knownIds = new Set([...state.teams.keys(), ...state.tombstones.map((t) => t.id)]);
  const localIds = db.prepare(`
    SELECT DISTINCT team_id FROM (
      SELECT team_id FROM sheet_answer WHERE year = ? AND team_id IS NOT NULL
      UNION SELECT team_id FROM sheet_category_result WHERE year = ? AND team_id IS NOT NULL
      UNION SELECT team_id FROM sheet_inspector WHERE year = ? AND team_id IS NOT NULL
    )`).all(year, year, year).map((r) => r.team_id);
  const unknown = localIds.filter((id) => !knownIds.has(id));
  if (unknown.length > 0 && teamState.throttled(`unknown:${year}`)) {
    logger.warn(null, "inspection.team_state_unknown", { year, team_ids: unknown });
  }

  if (deletedRows > 0 || renumbered > 0) {
    return () => {
      broadcastEvent("answer", { year });
      broadcastEvent("category-result", { year });
      broadcastEvent("inspector", { year });
    };
  }
});

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

  // 비활성 팀 제외 — 캐시의 비활성 번호 목록을 파라미터로 바인딩 (미로드 시 '[]' = 전원 노출,
  // 기존 absent-row-means-active와 동일한 fail-open)
  const { inactiveNumsJson } = teamState.getStateSync(year);

  const result = dbRun(() => {
    // excluded_types를 함께 내려 목록·성적표가 팀 유형에 해당하지 않는 칸을 비울 수 있게 한다.
    const categories = db.prepare(
      "SELECT id, name, excluded_types FROM sheet_template WHERE year = ? AND level = 'category' ORDER BY sort_order"
    ).all(year).map(c => ({ ...c, excluded_types: parseExcludedTypes(c.excluded_types) }));

    const inspectors = db.prepare(
      `SELECT i.team_num, i.category_id, i.inspector FROM sheet_inspector i
       WHERE i.year = ? AND i.team_num NOT IN (SELECT value FROM json_each(?))`
    ).all(year, inactiveNumsJson);

    const results = db.prepare(
      `SELECT r.team_num, r.category_id, r.result FROM sheet_category_result r
       WHERE r.year = ? AND r.team_num NOT IN (SELECT value FROM json_each(?))`
    ).all(year, inactiveNumsJson);

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

  // 비활성 팀 제외 — summary와 동일한 fail-open 필터
  const { inactiveNumsJson } = teamState.getStateSync(year);

  const result = dbRun(() => {
    const placeholders = itemIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT a.team_num, a.item_id, a.value FROM sheet_answer a
       WHERE a.year = ? AND a.item_id IN (${placeholders}) AND a.value != ''
         AND a.team_num NOT IN (SELECT value FROM json_each(?))`
    ).all(year, ...itemIds, inactiveNumsJson);

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
  if (!Number.isInteger(year) || !Number.isInteger(num) || num < 1) {
    return res.status(400).send("올바르지 않은 연도 또는 팀 번호입니다.");
  }
  if (!teamState.isActive(year, num)) return res.status(404).send("엔트리를 찾을 수 없습니다.");

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
  if (!teamState.isActive(year, team_num)) return res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");
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
  // 저장은 기존 num 키 upsert를 그대로 쓰되(엔트리 미가용 시에도 동작해야 한다 — 503 금지),
  // 캐시로 num→id가 풀리면 team_id를 함께 채워 레거시 행을 현재 팀에 귀속시킨다.
  // 캐시 미로드·미지의 팀이면 NULL — 백필/다음 쓰기가 채운다.
  const teamId = teamState.resolveTeamId(year, team_num);

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
         (year, team_id, team_num, item_id, value, answer_version, answer_updated_at, answer_updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, item_id) DO UPDATE SET
         value = excluded.value,
         answer_version = excluded.answer_version,
         answer_updated_at = excluded.answer_updated_at,
         answer_updated_by = excluded.answer_updated_by,
         team_id = COALESCE(excluded.team_id, sheet_answer.team_id)`
    ).run(year, teamId, team_num, item_id, newValue, nextVersion, updatedAt, updatedBy);

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
  if (!teamState.isActive(year, team_num)) return res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");
  if (year < new Date().getFullYear()) return res.status(400).send("이전 연도 데이터는 수정할 수 없습니다.");
  const templateItem = db.prepare("SELECT id, name FROM sheet_template WHERE id = ? AND year = ?").get(item_id, year);
  if (!templateItem) return res.status(400).send("해당 연도에 존재하지 않는 항목입니다.");
  if (base_version !== undefined && (!Number.isInteger(base_version) || base_version < 0)) {
    return res.status(400).send("올바르지 않은 메모 버전입니다.");
  }

  const newMemo = memo ?? "";
  const updatedAt = new Date().toISOString();
  const updatedBy = req.user?.name || req.user?.email || "";
  // answer와 동일: num 키 upsert + 해석되면 team_id 병기 (미해석 시 NULL 폴백)
  const teamId = teamState.resolveTeamId(year, team_num);
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
         (year, team_id, team_num, item_id, memo, memo_version, memo_updated_at, memo_updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, item_id) DO UPDATE SET
         memo = excluded.memo,
         memo_version = excluded.memo_version,
         memo_updated_at = excluded.memo_updated_at,
         memo_updated_by = excluded.memo_updated_by,
         team_id = COALESCE(excluded.team_id, sheet_answer.team_id)`
    ).run(year, teamId, team_num, item_id, newMemo, nextVersion, updatedAt, updatedBy);

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
  if (!teamState.isActive(year, team_num)) return res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");
  if (catResult !== undefined && catResult !== null && catResult !== "" && !["PASS", "FAIL"].includes(catResult)) {
    return res.status(400).send("결과는 PASS, FAIL 또는 비움이어야 합니다.");
  }
  if (year < new Date().getFullYear()) return res.status(400).send("이전 연도 데이터는 수정할 수 없습니다.");
  const templateCat = db.prepare("SELECT id, name FROM sheet_template WHERE id = ? AND year = ? AND level = 'category'").get(category_id, year);
  if (!templateCat) return res.status(400).send("해당 연도에 존재하지 않는 카테고리입니다.");

  // answer와 동일: num 키 upsert + 해석되면 team_id 병기 (미해석 시 NULL 폴백)
  const teamId = teamState.resolveTeamId(year, team_num);
  const r = dbRun(() =>
    db.prepare(
      `INSERT INTO sheet_category_result (year, team_id, team_num, category_id, result) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, category_id) DO UPDATE SET result = excluded.result,
         team_id = COALESCE(excluded.team_id, sheet_category_result.team_id)`
    ).run(year, teamId, team_num, category_id, catResult ?? "")
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
  if (!teamState.isActive(year, team_num)) return res.status(409).send("비활성화된 엔트리는 수정할 수 없습니다.");
  if (year < new Date().getFullYear()) return res.status(400).send("이전 연도 데이터는 수정할 수 없습니다.");
  const templateCat = db.prepare("SELECT id, name FROM sheet_template WHERE id = ? AND year = ? AND level = 'category'").get(category_id, year);
  if (!templateCat) return res.status(400).send("해당 연도에 존재하지 않는 카테고리입니다.");

  // answer와 동일: num 키 upsert + 해석되면 team_id 병기 (미해석 시 NULL 폴백)
  const teamId = teamState.resolveTeamId(year, team_num);
  const result = dbRun(() =>
    db.prepare(
      `INSERT INTO sheet_inspector (year, team_id, team_num, category_id, inspector) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(year, team_num, category_id) DO UPDATE SET inspector = excluded.inspector,
         team_id = COALESCE(excluded.team_id, sheet_inspector.team_id)`
    ).run(year, teamId, team_num, category_id, inspector ?? "")
  );

  if (!result.success) {
    logger.warn(req, "inspector.update", { error: result.error, year, category_id }, `#${team_num}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "inspector.update", { year, category_id, category_name: templateCat.name, inspector }, `#${team_num}`);
  broadcastEvent("inspector", { year, team_num, category_id, inspector: inspector ?? "" });

  res.status(200).send();
});

// entry 팀 상태 동기화 기동 (SSE 구독 + 부팅 fetch). 테스트는 skipTeamStateSync로
// 네트워크 구독을 끄고 teamState.refresh(year)를 직접 호출한다.
if (!options.skipTeamStateSync) teamState.start();

addSpaFallback(app);

return { app, db, teamState };
}

runIfDirect(import.meta, "inspection", createInspectionApp);
