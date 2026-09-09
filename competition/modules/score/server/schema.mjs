import { addColumn } from "../../../../shared/server/db-setup.mjs";

export function initializeSchema({ db }) {
  const ENDURANCE_COLUMNS = Object.freeze([
    "year",
    "team_num",
    "status",
    "driver1_time",
    "driver1_start_delay",
    "driver1_cones",
    "driver1_oc",
    "driver1_penalty",
    "driver_change_time",
    "driver2_time",
    "driver2_start_delay",
    "driver2_cones",
    "driver2_oc",
    "driver2_penalty",
    "fuel_consumed",
    "fuel_extra",
    "electric_net_energy",
    "energy_dsq",
    "team_id",
    "qualified",
    "driver1_name",
    "driver2_name",
  ]);

  function createEnduranceTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS score_endurance (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    status TEXT,
    driver1_time INTEGER,
    driver1_start_delay INTEGER DEFAULT 0,
    driver1_cones INTEGER DEFAULT 0,
    driver1_oc INTEGER DEFAULT 0,
    driver1_penalty REAL DEFAULT 0,
    driver_change_time INTEGER,
    driver2_time INTEGER,
    driver2_start_delay INTEGER DEFAULT 0,
    driver2_cones INTEGER DEFAULT 0,
    driver2_oc INTEGER DEFAULT 0,
    driver2_penalty REAL DEFAULT 0,
    fuel_consumed REAL,
    fuel_extra REAL,
    electric_net_energy REAL,
    energy_dsq INTEGER NOT NULL DEFAULT 0,
    team_id INTEGER,
    qualified INTEGER NOT NULL DEFAULT 0 CHECK(qualified IN (0, 1)),
    driver1_name TEXT,
    driver2_name TEXT,
    PRIMARY KEY (year, team_num)
  )`);
  }

  function ensureEnduranceQualifiedConstraint(db) {
    const tableSql =
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'score_endurance'")
        .get()?.sql || "";
    if (
      /\bqualified\b[^,]*\bCHECK\s*\(\s*qualified\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(tableSql)
    )
      return;

    const actualColumns = db.pragma("table_info('score_endurance')").map(({ name }) => name);
    if (!actualColumns.includes("qualified")) return;
    if (
      actualColumns.length !== ENDURANCE_COLUMNS.length ||
      ENDURANCE_COLUMNS.some((name, index) => actualColumns[index] !== name)
    ) {
      throw new Error(
        "score_endurance 스키마가 예상과 달라 qualified 제약을 안전하게 추가할 수 없습니다.",
      );
    }
    const invalid = db
      .prepare(
        "SELECT year, team_num, qualified FROM score_endurance WHERE qualified IS NULL OR qualified NOT IN (0, 1) LIMIT 1",
      )
      .get();
    if (invalid) {
      throw new Error(
        `score_endurance qualified 값이 올바르지 않습니다: ${invalid.year}/#${invalid.team_num}`,
      );
    }

    const dependentObjects = db
      .prepare(
        `
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'score_endurance' AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `,
      )
      .all()
      .map(({ sql }) => sql);
    db.exec("ALTER TABLE score_endurance RENAME TO score_endurance_without_qualified_check");
    createEnduranceTable(db);
    db.exec(`
    INSERT INTO score_endurance (${ENDURANCE_COLUMNS.join(", ")})
    SELECT ${ENDURANCE_COLUMNS.join(", ")} FROM score_endurance_without_qualified_check;
    DROP TABLE score_endurance_without_qualified_check;
  `);
    for (const sql of dependentObjects) db.exec(sql);
  }

  db.transaction(() => {
    // 레거시 테이블 정리
    const legacyTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('score_event', 'score_record')",
      )
      .all();
    if (legacyTables.length > 0) {
      console.log(`[score] Dropping legacy tables: ${legacyTables.map((t) => t.name).join(", ")}`);
      db.exec(`DROP TABLE IF EXISTS score_event`);
      db.exec(`DROP TABLE IF EXISTS score_record`);
    }

    // 수동 입력 점수 (보고서, 가점, 감점). 기존 energy 행은 호환성을 위해 보존만 한다.
    db.exec(`CREATE TABLE IF NOT EXISTS score_manual (
    year INTEGER NOT NULL,
    team_num INTEGER NOT NULL,
    score_type TEXT NOT NULL,
    value REAL,
    PRIMARY KEY (year, team_num, score_type)
  )`);

    // 경기 종목별 페널티 설정 (콘터치/코스이탈/출발지연 초)
    db.exec(`CREATE TABLE IF NOT EXISTS score_penalty (
    year INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    cone_penalty REAL NOT NULL DEFAULT 0,
    oc_penalty REAL NOT NULL DEFAULT 0,
    start_delay REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (year, event_type)
  )`);

    // 마이그레이션: start_delay 컬럼 추가
    addColumn(db, "score_penalty", "start_delay REAL NOT NULL DEFAULT 0");

    // 경기 종목별 점수 설정 (총점/완주점수/컷오프)
    db.exec(`CREATE TABLE IF NOT EXISTS score_setting (
    year INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    value REAL,
    PRIMARY KEY (year, event_type, setting_key)
  )`);

    // 연도별 공개 성적표 활성화 여부
    db.exec(`CREATE TABLE IF NOT EXISTS score_publication (
    year INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
  )`);

    // 내구 기록 입력
    createEnduranceTable(db);
    addColumn(db, "score_endurance", "fuel_consumed REAL");
    addColumn(db, "score_endurance", "fuel_extra REAL");
    addColumn(db, "score_endurance", "electric_net_energy REAL");
    addColumn(db, "score_endurance", "energy_dsq INTEGER NOT NULL DEFAULT 0");
    addColumn(
      db,
      "score_endurance",
      "qualified INTEGER NOT NULL DEFAULT 0 CHECK(qualified IN (0, 1))",
    );
    addColumn(db, "score_endurance", "driver1_name TEXT");
    addColumn(db, "score_endurance", "driver2_name TEXT");
    ensureEnduranceQualifiedConstraint(db);
  })();
}
