import { ensureInactiveTeamView } from "../../../lib/team-status.mjs";
import {
  addColumn,
  runMigrationOnce,
  setupRowCapRetention,
} from "../../../../shared/server/db-setup.mjs";
import { currentCompetitionYear } from "../../../../shared/common/competition-year.mjs";

export function initializeSchema({
  db,
  INSPECTION_SETTING_FIELDS,
  normalizeInspectionSetting,
  INSPECTION_SETTING_DEFAULTS,
  inspectionSettingKey,
  inspections,
  INSPECTIONS,
}) {
  const QUEUE_LOG_MAX_ROWS = 100000;

  const BOOTH_LOG_MAX_ROWS = 100000;

  // This is the exact post-addColumn shape produced by main. Preview builds that
  // used inspection columns are folded back into this rollback-compatible DDL.
  const CANONICAL_INSPECTION_TABLE_SQL = `CREATE TABLE inspection (
  type TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  ignore_priority BOOLEAN NOT NULL DEFAULT FALSE,
  ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE
, hidden_from_register BOOLEAN NOT NULL DEFAULT FALSE)`;

  function primaryKeyColumns(db, table) {
    if (!tableExists(db, table)) return [];
    return db
      .prepare(`PRAGMA table_info('${table}')`)
      .all()
      .filter((col) => col.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((col) => col.name);
  }

  function tableExists(db, table) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  }

  function tableColumns(db, table) {
    if (!tableExists(db, table)) return new Set();
    return new Set(
      db
        .prepare(`PRAGMA table_info('${table}')`)
        .all()
        .map((column) => column.name),
    );
  }

  function assertRetiredCurrentTableShape(db) {
    if (!tableExists(db, "current_legacy")) return;
    const columns = [...tableColumns(db, "current_legacy")].sort();
    const primaryKey = primaryKeyColumns(db, "current_legacy").join(",");
    const expectedColumns =
      columns.join(",") === "inspection,num,phone" ||
      columns.join(",") === "inspection,num,phone,year";
    if (!expectedColumns || !["num", "num,year"].includes(primaryKey)) {
      throw new Error(
        `unsupported Queue current_legacy schema: columns=${columns.join(",")} primaryKey=${primaryKey || "none"}`,
      );
    }
  }

  // Reject an unknown same-name object before Queue-owned normalization can
  // consume any predecessor state. The one-shot migrator runs this on its
  // private staging copy, never on a source database.
  assertRetiredCurrentTableShape(db);

  ensureInactiveTeamView(db);

  db.transaction(() => {
    // 검차 종류 메타 테이블
    db.exec(`CREATE TABLE IF NOT EXISTS inspection (
    type TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    ignore_priority BOOLEAN NOT NULL DEFAULT FALSE,
    ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE
  );`);

    // 마이그레이션: 기존 테이블에 컬럼 추가
    addColumn(db, "inspection", "ignore_priority BOOLEAN NOT NULL DEFAULT FALSE");
    addColumn(db, "inspection", "ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE");
    addColumn(db, "inspection", "hidden_from_register BOOLEAN NOT NULL DEFAULT FALSE");
    const inspectionColumnsBeforeNormalization = tableColumns(db, "inspection");
    const previewSettingColumns = INSPECTION_SETTING_FIELDS.filter((field) =>
      inspectionColumnsBeforeNormalization.has(field),
    );
    // A previous PR preview persisted these settings as inspection columns. Hold
    // the rows in memory so the same transaction can restore the main-compatible
    // table and preserve every per-inspection value.
    const previewInspectionRows =
      previewSettingColumns.length > 0
        ? db.prepare("SELECT * FROM inspection ORDER BY rowid").all()
        : [];
    {
      if (inspectionColumnsBeforeNormalization.has("length")) {
        db.transaction(() => {
          db.exec(`CREATE TABLE inspection_new (
          type TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          ignore_priority BOOLEAN NOT NULL DEFAULT FALSE,
          ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE,
          hidden_from_register BOOLEAN NOT NULL DEFAULT FALSE
        )`);
          db.exec(`INSERT OR REPLACE INTO inspection_new (type, name, active, ignore_priority, ignore_reinspection, hidden_from_register)
          SELECT type, name, active, ignore_priority, ignore_reinspection, hidden_from_register FROM inspection`);
          db.exec("DROP TABLE inspection");
          db.exec("ALTER TABLE inspection_new RENAME TO inspection");
        })();
      }
    }

    // 팀별 검차별 우선순위 테이블 (0이 가장 높음, 숫자가 클수록 낮음)
    db.exec(`CREATE TABLE IF NOT EXISTS team_priority (
    num INTEGER NOT NULL,
    inspection TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 999,
    PRIMARY KEY (num, inspection)
  );`);

    // 검차 이력 테이블 (재검 여부 판단용)
    db.exec(`CREATE TABLE IF NOT EXISTS inspection_history (
    num INTEGER NOT NULL,
    inspection TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    year INTEGER NOT NULL,
    PRIMARY KEY (num, inspection, year, timestamp)
  );`);

    db.exec(`CREATE TABLE IF NOT EXISTS current_inspection (
    num INTEGER NOT NULL,
    inspection TEXT NOT NULL,
    phone TEXT NOT NULL,
    year INTEGER NOT NULL,
    PRIMARY KEY (num, inspection, year)
  );`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_year_num
    ON current_inspection(year, num, inspection)`);

    db.exec(`CREATE TABLE IF NOT EXISTS inspection_queue (
    inspection TEXT NOT NULL,
    num INTEGER NOT NULL,
    phone TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    year INTEGER NOT NULL,
    PRIMARY KEY (inspection, num, year)
  );`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_iq_year_insp_ts
    ON inspection_queue(year, inspection, timestamp, num)`);

    // Keep the exact main schema so its read-only deployment validator remains a
    // supported rollback path. Per-inspection values live under namespaced keys.
    const settingsTableExisted = tableExists(db, "settings");
    db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`);
    const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    const hadNamespacedSettings =
      db.prepare("SELECT 1 FROM settings WHERE key LIKE 'inspection:%' LIMIT 1").get() != null;

    // Recover the legacy global value from the earlier preview schema when every
    // inspection still agrees. Normal production rollout retains these rows, so
    // this compatibility path is only needed for already-created PR previews.
    for (const field of previewSettingColumns) {
      const values = new Set(
        previewInspectionRows.map((row) => normalizeInspectionSetting(field, row[field])),
      );
      if (values.size === 1) insertSetting.run(field, values.values().next().value);
    }
    for (const [field, fallback] of Object.entries(INSPECTION_SETTING_DEFAULTS)) {
      insertSetting.run(field, fallback);
    }
    const globalSettings = Object.fromEntries(
      INSPECTION_SETTING_FIELDS.map((field) => [
        field,
        normalizeInspectionSetting(
          field,
          db.prepare("SELECT value FROM settings WHERE key = ?").get(field)?.value,
        ),
      ]),
    );

    for (const row of previewInspectionRows) {
      for (const field of INSPECTION_SETTING_FIELDS) {
        const source = previewSettingColumns.includes(field) ? row[field] : globalSettings[field];
        insertSetting.run(
          inspectionSettingKey(row.type, field),
          normalizeInspectionSetting(field, source),
        );
      }
    }
    const seedFromGlobal =
      previewSettingColumns.length === 0 || (settingsTableExisted && !hadNamespacedSettings);
    runMigrationOnce(db, "queue-per-inspection-settings", () => {
      if (!seedFromGlobal) return;
      const setSetting = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
      for (const { type } of db.prepare("SELECT type FROM inspection").all()) {
        for (const field of INSPECTION_SETTING_FIELDS) {
          setSetting.run(inspectionSettingKey(type, field), globalSettings[field]);
        }
      }
    });
    if (previewInspectionRows.length > 0) {
      db.exec("DROP TABLE inspection");
      db.exec(CANONICAL_INSPECTION_TABLE_SQL);
      const insertInspection = db.prepare(`
      INSERT INTO inspection
        (type, name, active, ignore_priority, ignore_reinspection, hidden_from_register)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
      for (const row of previewInspectionRows)
        insertInspection.run(
          row.type,
          row.name,
          row.active,
          row.ignore_priority,
          row.ignore_reinspection,
          row.hidden_from_register,
        );
    }

    // 취소 페널티 테이블
    db.exec(`CREATE TABLE IF NOT EXISTS cancel_penalty (
    num INTEGER NOT NULL,
    inspection TEXT NOT NULL,
    until INTEGER NOT NULL,
    phone TEXT,
    queue_timestamp INTEGER,
    PRIMARY KEY (num, inspection)
  );`);

    // 부스 설정 테이블
    db.exec(`CREATE TABLE IF NOT EXISTS booth_config (
    inspection TEXT PRIMARY KEY,
    count INTEGER DEFAULT 1
  );`);

    // 부스 상태 테이블
    db.exec(`CREATE TABLE IF NOT EXISTS booth (
    inspection TEXT,
    booth_num INTEGER,
    active BOOLEAN DEFAULT TRUE,
    occupied_by INTEGER NULL,
    occupied_team_id INTEGER NULL,
    entered_at INTEGER NULL,
    PRIMARY KEY (inspection, booth_num)
  );`);
    addColumn(db, "booth", "occupied_team_id INTEGER");
    addColumn(db, "booth", "timer_paused_at INTEGER");
    addColumn(db, "booth", "timer_paused_ms INTEGER NOT NULL DEFAULT 0");

    // 부스 사용 로그 테이블
    db.exec(`CREATE TABLE IF NOT EXISTS booth_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    num INTEGER,
    inspection TEXT,
    booth_num INTEGER,
    entered_at INTEGER,
    exited_at INTEGER NULL,
    created_at INTEGER
  );`);

    // 대기열 이벤트 로그 테이블
    db.exec(`CREATE TABLE IF NOT EXISTS queue_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT,
    num INTEGER,
    inspection TEXT,
    timestamp INTEGER
  );`);

    // 검차 종류 메타 및 부스 기본 데이터 생성
    for (const [k, v] of Object.entries(inspections)) {
      db.prepare(`INSERT OR IGNORE INTO inspection (type, name) VALUES (?, ?)`).run(k, v);
      // 이름은 INSPECTIONS 가 유일한 출처다. 라우트가 name 을 수정하지 않으므로
      // 상수 변경(배터리 -> 축전지)이 기존 DB에도 반영되도록 매 부팅에 맞춘다.
      db.prepare(`UPDATE inspection SET name = ? WHERE type = ? AND name != ?`).run(v, k, v);

      // 부스 기본 설정: 검차 종류당 1개 부스
      db.prepare(`INSERT OR IGNORE INTO booth_config (inspection, count) VALUES (?, 1)`).run(k);
      db.prepare(`INSERT OR IGNORE INTO booth (inspection, booth_num) VALUES (?, 1)`).run(k);
      for (const field of INSPECTION_SETTING_FIELDS) {
        insertSetting.run(inspectionSettingKey(k, field), globalSettings[field]);
      }
    }

    // SMS 설정은 이메일 서비스에서 가져오거나 환경변수로 폴백
    // loadSmsConfig()에서 비동기로 확인 후 활성화

    // year-aware indexes are created after the year-column migration below.
    setupRowCapRetention(db, "queue_log", QUEUE_LOG_MAX_ROWS);
    setupRowCapRetention(db, "booth_log", BOOTH_LOG_MAX_ROWS);
  })();

  // 연도 컬럼 마이그레이션 (기존 스키마 생성과 분리)
  {
    const yr = currentCompetitionYear();

    // team_priority: year를 PK에 추가
    const tpInfo = db.prepare("PRAGMA table_info(team_priority)").all();
    if (!tpInfo.some((c) => c.name === "year")) {
      db.transaction(() => {
        db.exec(`CREATE TABLE team_priority_new (
        num INTEGER NOT NULL,
        inspection TEXT NOT NULL,
        year INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 999,
        PRIMARY KEY (num, inspection, year)
      )`);
        db.exec(
          `INSERT INTO team_priority_new SELECT num, inspection, ${yr}, priority FROM team_priority`,
        );
        db.exec(`DROP TABLE team_priority`);
        db.exec(`ALTER TABLE team_priority_new RENAME TO team_priority`);
        db.exec(`CREATE INDEX idx_tp_insp_prio ON team_priority(year, inspection, priority, num)`);
      })();
    }

    // 취소 전 순번 복구에 필요한 원본 전화번호·접수시각을 보존한다. 기존 페널티는
    // 두 값이 NULL이므로 해제는 가능하지만 원래 순번 복구는 제공하지 않는다.
    addColumn(db, "cancel_penalty", "phone TEXT");
    addColumn(db, "cancel_penalty", "queue_timestamp INTEGER");

    // cancel_penalty: year를 PK에 추가
    const cpInfo = db.prepare("PRAGMA table_info(cancel_penalty)").all();
    if (!cpInfo.some((c) => c.name === "year")) {
      db.transaction(() => {
        db.exec(`CREATE TABLE cancel_penalty_new (
        num INTEGER NOT NULL,
        inspection TEXT NOT NULL,
        year INTEGER NOT NULL,
        until INTEGER NOT NULL,
        phone TEXT,
        queue_timestamp INTEGER,
        PRIMARY KEY (num, inspection, year)
      )`);
        db.exec(`INSERT INTO cancel_penalty_new (num, inspection, year, until, phone, queue_timestamp)
        SELECT num, inspection, ${yr}, until, phone, queue_timestamp FROM cancel_penalty`);
        db.exec(`DROP TABLE cancel_penalty`);
        db.exec(`ALTER TABLE cancel_penalty_new RENAME TO cancel_penalty`);
        db.exec(`CREATE INDEX idx_cp_num_insp ON cancel_penalty(year, num, inspection)`);
      })();
    }

    // 나머지 테이블: year 컬럼 추가
    addColumn(db, "inspection_history", `year INTEGER NOT NULL DEFAULT ${yr}`);
    addColumn(db, "booth_log", `year INTEGER NOT NULL DEFAULT ${yr}`);
    addColumn(db, "queue_log", `year INTEGER NOT NULL DEFAULT ${yr}`);

    if (tableExists(db, "current")) {
      const currentCols = db
        .prepare("PRAGMA table_info('current')")
        .all()
        .map((c) => c.name);
      const yearExpr = currentCols.includes("year") ? "year" : `${yr} AS year`;
      const ciInsert = db.prepare(
        "INSERT OR IGNORE INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)",
      );
      for (const row of db
        .prepare(`SELECT num, phone, inspection, ${yearExpr} FROM current`)
        .all()) {
        for (const type of String(row.inspection || "")
          .split(",")
          .filter((t) => INSPECTIONS[t])) {
          ciInsert.run(row.num, type, row.phone, row.year);
        }
      }
      // The normalized tables are the only runtime model. Unknown inspection
      // names are intentionally not retained in a second compatibility table.
      db.exec("DROP TABLE current");
    }
    db.exec("DROP TABLE IF EXISTS current_legacy");

    if (primaryKeyColumns(db, "inspection_history").join(",") !== "num,inspection,year,timestamp") {
      db.transaction(() => {
        db.exec(`CREATE TABLE inspection_history_new (
        num INTEGER NOT NULL,
        inspection TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        year INTEGER NOT NULL,
        PRIMARY KEY (num, inspection, year, timestamp)
      )`);
        db.exec(`INSERT OR IGNORE INTO inspection_history_new (num, inspection, timestamp, year)
        SELECT num, inspection, timestamp, year FROM inspection_history`);
        db.exec(`DROP TABLE inspection_history`);
        db.exec(`ALTER TABLE inspection_history_new RENAME TO inspection_history`);
      })();
    }

    for (const k of Object.keys(INSPECTIONS)) {
      if (!tableExists(db, k)) continue;
      const cols = db
        .prepare(`PRAGMA table_info('${k}')`)
        .all()
        .map((c) => c.name);
      if (cols.includes("num") && cols.includes("phone") && cols.includes("timestamp")) {
        const yearExpr = cols.includes("year") ? "year" : `${yr} AS year`;
        db.prepare(
          `
        INSERT OR IGNORE INTO inspection_queue (inspection, num, phone, timestamp, year)
        SELECT ?, num, phone, timestamp, ${yearExpr} FROM '${k}'
      `,
        ).run(k);
      }
      db.exec(`DROP TRIGGER IF EXISTS trg_${k}_iq_insert`);
      db.exec(`DROP TRIGGER IF EXISTS trg_${k}_iq_update`);
      db.exec(`DROP TRIGGER IF EXISTS trg_${k}_iq_delete`);
      db.exec(`DROP TABLE '${k}'`);
    }

    db.exec(`DROP INDEX IF EXISTS idx_ih_num_insp`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_ih_year_num_insp ON inspection_history(year, num, inspection)`,
    );
    db.exec(`DROP INDEX IF EXISTS idx_tp_insp_prio`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tp_insp_prio ON team_priority(year, inspection, priority, num)`,
    );
    db.exec(`DROP INDEX IF EXISTS idx_cp_num_insp`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cp_num_insp ON cancel_penalty(year, num, inspection)`);
    db.exec(`DROP INDEX IF EXISTS idx_bl_active`);
    db.exec(`DROP INDEX IF EXISTS idx_ql_num`);
    db.exec(`DROP INDEX IF EXISTS idx_ql_insp_ts`);
    db.exec(`DROP INDEX IF EXISTS idx_ql_timestamp`);
    db.exec(`DROP INDEX IF EXISTS idx_bl_entered`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ql_year_num_ts ON queue_log(year, num, timestamp)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_ql_year_insp_ts ON queue_log(year, inspection, timestamp)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bl_year_entered ON booth_log(year, entered_at)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_bl_year_num_entered ON booth_log(year, num, entered_at)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_bl_year_open ON booth_log(year, num, inspection, booth_num, exited_at)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ql_year_ts ON queue_log(year, timestamp)`);
  }

  return { tableColumns };
}
