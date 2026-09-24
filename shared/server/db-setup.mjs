export function createDatabase(Database, dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

// SQL에 보간되는 테이블/컬럼 식별자 가드. 현재 호출부는 전부 하드코딩 리터럴이지만,
// 미래의 호출자가 사용자 입력을 넘기는 실수를 인젝션이 아닌 즉시 예외로 만든다.
export function assertIdentifier(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`올바르지 않은 SQL 식별자입니다: ${name}`);
  }
  return name;
}

export function addColumn(db, table, columnDef) {
  assertIdentifier(table);
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) {
    if (e.message && e.message.includes("duplicate column")) return;
    throw e;
  }
}

// SQLite는 컬럼의 DEFAULT나 순서를 ALTER로 바꿀 수 없다. 스키마는 CREATE TABLE IF NOT
// EXISTS로 만들어지므로 이미 존재하는 DB는 처음 만들어진 시점의 정의를 그대로 유지한다.
// 따라서 코드의 정의를 고치면 새 DB와 운영 DB의 스키마가 갈라지고, 백업 아티팩트 검증이
// <table:columns>로 실패한다. 공식 12단계 ALTER 절차대로 테이블을 재구축해 양쪽을 맞춘다.
//
// 재구축 중 외래키는 반드시 꺼야 한다. 켜진 상태의 DROP TABLE은 암묵적 DELETE를 돌려
// ON DELETE CASCADE로 자식 행까지 지운다. PRAGMA foreign_keys는 트랜잭션 안에서 무시되므로
// 호출자는 runMigrationOnce에 { transaction: false }를 넘겨야 한다.
export function rebuildTable(db, table, bodySql) {
  assertIdentifier(table);
  if (db.inTransaction) {
    throw new Error(`${table} 재구축은 트랜잭션 밖에서 실행해야 합니다`);
  }
  const temp = assertIdentifier(`${table}__rebuild`);
  // 이미 정의가 일치하는 DB는 건드리지 않는다. 재구축은 sqlite_master에 저장된 DDL 원문을
  // 바꾸므로, 스키마 원문으로 다이제스트를 만드는 competition 계약이 멀쩡한 DB에서 깨진다.
  const layout = (name) => JSON.stringify(
    db.prepare(`PRAGMA table_info(${name})`).all().map((entry) => [
      entry.name,
      String(entry.type || "").toUpperCase(),
      Number(entry.notnull),
      Number(entry.pk),
      entry.dflt_value == null ? null : String(entry.dflt_value).toLowerCase().replace(/\s+/g, ""),
    ]),
  );
  // AUTOINCREMENT 카운터는 테이블과 함께 사라진다. 복원하지 않으면 재구축 시점에 최대
  // id보다 큰 값까지 쓰였던 DB에서 삭제된 id가 재사용된다.
  const hasSequence = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
    .get();
  const previousSeq = hasSequence
    ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq
    : undefined;
  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  if (foreignKeys) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${temp}`);
      db.exec(`CREATE TABLE ${temp} ${bodySql}`);
      if (layout(temp) === layout(table)) {
        db.exec(`DROP TABLE ${temp}`);
        return;
      }
      const next = db.prepare(`PRAGMA table_info(${temp})`).all().map((c) => c.name);
      const previous = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      // 새 정의에만 있는 컬럼은 DEFAULT로 채우고, 사라진 컬럼은 버린다.
      const carried = next.filter((name) => previous.has(name)).map((name) => `"${name}"`).join(", ");
      db.exec(`INSERT INTO ${temp} (${carried}) SELECT ${carried} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${temp} RENAME TO ${table}`);
      if (previousSeq != null) {
        // better-sqlite3는 평범한 JS 숫자를 REAL로 바인딩한다. seq가 실수로 남으면
        // AUTOINCREMENT가 정수 카운터를 실수와 비교하게 되므로 정수로 되돌린다.
        db.prepare(
          "UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = ? AND seq < ?",
        ).run(previousSeq, table, previousSeq);
      }
    })();
  } finally {
    if (foreignKeys) db.pragma("foreign_keys = ON");
  }
  const violations = db.pragma("foreign_key_check");
  if (violations.length) {
    throw new Error(`${table} 재구축 후 외래키 위반 ${violations.length}건이 남았습니다`);
  }
}

// 레거시 텍스트 타임스탬프를 UTC ISO 문자열로 정규화한다.
// 이미 `...Z` 또는 숫자 오프셋(`+09:00`)이 붙은 값은 그대로, 공백 구분
// `YYYY-MM-DD HH:MM:SS` 레거시 값은 UTC로 해석한다. 파싱 실패 시 null.
export function normalizeUtcTextTimestamp(value) {
  const s = String(value || "");
  if (!s) return null;
  const text = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// 레거시/사용자 입력 타임스탬프를 UTC ISO로 파싱한다. `YYYY-MM-DD[T ]HH:MM[:SS][.fff]`에
// 선택적 zone(`Z`/`+09:00`)을 허용하며, zone이 없으면 naiveOffset(기본 UTC `Z`)으로
// 해석한다. 형식이 맞지 않으면 null. 서비스별 naive 값 해석(UTC vs KST 등)만 naiveOffset로
// 주입하면 파싱 코어를 한 곳에서 공유할 수 있다.
export function parseLegacyTimestamp(value, { naiveOffset = "Z" } = {}) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const [, yy, mo, dd, hh, mi, ss = "00", fraction = "", zone] = m;
  const d = new Date(`${yy}-${mo}-${dd}T${hh}:${mi}:${ss}${fraction}${zone || naiveOffset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// 한 컬럼의 모든 행을 정규화해 in-place로 다시 쓴다. rowid 키셋 페이지네이션으로
// 대용량 테이블에서도 전체 결과를 메모리에 올리지 않는다. normalize는 값→ISO
// 문자열(또는 null) 변환 함수로, 서비스별로 더 엄격한 파서를 주입할 수 있다.
export function normalizeTimestampColumn(db, table, column, normalize = normalizeUtcTextTimestamp) {
  assertIdentifier(table);
  assertIdentifier(column);
  const batchSize = 1000;
  let lastRowid = 0;
  const select = db.prepare(`
    SELECT rowid AS _rowid, ${column} AS value
    FROM ${table}
    WHERE rowid > ? AND ${column} IS NOT NULL AND ${column} != ''
    ORDER BY rowid
    LIMIT ?
  `);
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  while (true) {
    const rows = select.all(lastRowid, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      lastRowid = row._rowid;
      const normalized = normalize(row.value);
      if (normalized && normalized !== row.value) update.run(normalized, row._rowid);
    }
  }
}

// 테이블을 "최신 maxRows행만 보존"하도록 강제한다. AFTER INSERT 트리거로 매 삽입마다
// 한도를 넘는 오래된 행을 즉시 정리하고, 기존 초과분도 한 번 정리한다. keyColumn은
// 단조 증가하는 정수 키(기본 "id"; rowid 테이블은 "rowid"). partitionColumn을
// 지정하면 각 파티션마다 최신 maxRows행을 독립적으로 보존한다. maxRows가 양의 정수가
// 아니면 보존 비활성화(트리거 미생성).
export function setupRowCapRetention(db, table, maxRows, { keyColumn = "id", partitionColumn = null } = {}) {
  if (!Number.isInteger(maxRows) || maxRows <= 0) return;
  assertIdentifier(table);
  assertIdentifier(keyColumn);
  if (partitionColumn != null) assertIdentifier(partitionColumn);
  const trigger = `trg_${table}_retention`;
  db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  if (partitionColumn) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger}
      AFTER INSERT ON ${table}
      BEGIN
        DELETE FROM ${table}
        WHERE ${partitionColumn} IS NEW.${partitionColumn}
          AND ${keyColumn} IN (
            SELECT ${keyColumn} FROM ${table}
            WHERE ${partitionColumn} IS NEW.${partitionColumn}
            ORDER BY ${keyColumn} DESC
            LIMIT -1 OFFSET ${maxRows}
          );
      END;`);
    db.exec(`DELETE FROM ${table} WHERE ${keyColumn} IN (
      SELECT ${keyColumn} FROM (
        SELECT ${keyColumn}, ROW_NUMBER() OVER (
          PARTITION BY ${partitionColumn} ORDER BY ${keyColumn} DESC
        ) AS retention_rank
        FROM ${table}
      ) WHERE retention_rank > ${maxRows}
    )`);
    return;
  }
  const condition = `${keyColumn} <= COALESCE((SELECT MAX(${keyColumn}) FROM ${table}), 0) - ${maxRows}`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger}
    AFTER INSERT ON ${table}
    BEGIN
      DELETE FROM ${table} WHERE ${condition};
    END;`);
  db.exec(`DELETE FROM ${table} WHERE ${condition}`);
}

export function runMigrationOnce(db, name, fn, { transaction = true } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)) return false;
  const apply = () => {
    fn();
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
  };
  if (transaction) db.transaction(apply)();
  else apply();
  return true;
}
