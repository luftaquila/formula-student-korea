export function createDatabase(Database, dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

export function addColumn(db, table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); }
  catch (e) {
    if (e.message && e.message.includes("duplicate column")) return;
    throw e;
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

// 한 컬럼의 모든 행을 정규화해 in-place로 다시 쓴다. rowid 키셋 페이지네이션으로
// 대용량 테이블에서도 전체 결과를 메모리에 올리지 않는다. normalize는 값→ISO
// 문자열(또는 null) 변환 함수로, 서비스별로 더 엄격한 파서를 주입할 수 있다.
export function normalizeTimestampColumn(db, table, column, normalize = normalizeUtcTextTimestamp) {
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
