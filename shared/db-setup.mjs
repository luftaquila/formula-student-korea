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
