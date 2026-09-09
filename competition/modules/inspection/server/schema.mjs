import { EMPTY_RULE_REFS } from "../lib/rule-refs.mjs";
import { runMigrationOnce } from "../../../../shared/server/db-setup.mjs";

export function initializeSchema({ db }) {
  // answer_type CHECK 제약조건에 새 입력 유형을 추가하는 마이그레이션
  // FK CASCADE 문제를 피하기 위해 트랜잭션 밖에서 foreign_keys OFF 상태로 실행
  {
    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sheet_template'")
      .get();
    if (schema && (!schema.sql.includes("'counter'") || !schema.sql.includes("'stopwatch'"))) {
      const existingColumns = new Set(
        db
          .prepare("PRAGMA table_info(sheet_template)")
          .all()
          .map((c) => c.name),
      );
      const unitExpr = existingColumns.has("unit") ? "unit" : "''";
      const pdfIncludeExpr = existingColumns.has("pdf_include") ? "pdf_include" : "1";
      const excludedTypesExpr = existingColumns.has("excluded_types") ? "excluded_types" : "''";
      const fieldKeyExpr = existingColumns.has("field_key") ? "field_key" : "''";
      const calculationExpr = existingColumns.has("calculation") ? "calculation" : "''";
      const ruleRefsExpr = existingColumns.has("rule_refs")
        ? "rule_refs"
        : `'${JSON.stringify(EMPTY_RULE_REFS)}'`;
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
          rule_refs TEXT NOT NULL DEFAULT '{"status":"needs_review","references":[]}' CHECK(json_valid(rule_refs)),
          FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
        )`);
          db.exec(`INSERT INTO sheet_template_new
          (id, year, level, parent_id, sort_order, name, answer_type, remarks, unit, pdf_include, excluded_types, field_key, calculation, rule_refs)
          SELECT id, year, level, parent_id, sort_order, name, answer_type, remarks,
                 ${unitExpr}, ${pdfIncludeExpr}, ${excludedTypesExpr}, ${fieldKeyExpr}, ${calculationExpr}, ${ruleRefsExpr}
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
    rule_refs TEXT NOT NULL DEFAULT '{"status":"needs_review","references":[]}' CHECK(json_valid(rule_refs)),
    FOREIGN KEY (parent_id) REFERENCES sheet_template(id) ON DELETE CASCADE
  );`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_st_year ON sheet_template(year);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_st_parent ON sheet_template(parent_id);`);

    // 컬럼 마이그레이션
    const cols = db.prepare("PRAGMA table_info(sheet_template)").all();
    if (!cols.find((c) => c.name === "unit")) {
      db.exec(`ALTER TABLE sheet_template ADD COLUMN unit TEXT DEFAULT ''`);
    }
    if (!cols.find((c) => c.name === "pdf_include")) {
      db.exec(`ALTER TABLE sheet_template ADD COLUMN pdf_include INTEGER DEFAULT 1`);
    }
    // 카테고리를 숨길 차량 유형 이름의 JSON 배열. 빈 값 = 모든 유형에 표시(기본).
    // 포함이 아니라 제외를 저장하므로 유형을 새로 추가하면 자동으로 표시되고,
    // entry 서비스에서 유형 이름이 바뀌어 매핑이 끊기면 숨김이 아니라 표시로 열린다.
    if (!cols.find((c) => c.name === "excluded_types")) {
      db.exec(`ALTER TABLE sheet_template ADD COLUMN excluded_types TEXT DEFAULT ''`);
    }
    if (!cols.find((c) => c.name === "field_key")) {
      db.exec(`ALTER TABLE sheet_template ADD COLUMN field_key TEXT DEFAULT ''`);
    }
    if (!cols.find((c) => c.name === "calculation")) {
      db.exec(`ALTER TABLE sheet_template ADD COLUMN calculation TEXT DEFAULT ''`);
    }
    if (!cols.find((c) => c.name === "rule_refs")) {
      db.exec(`ALTER TABLE sheet_template ADD COLUMN rule_refs TEXT NOT NULL
      DEFAULT '{"status":"needs_review","references":[]}' CHECK(json_valid(rule_refs))`);
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
      if (!answerCols.find((c) => c.name === name)) {
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
      const editors = db
        .prepare(
          `
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
    `,
        )
        .all();
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
}
