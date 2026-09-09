import {
  parseLegacyTimestamp,
  runMigrationOnce,
  setupRowCapRetention,
} from "../../shared/server/db-setup.mjs";

export function initializeSchema({ db, CONFIG_KEYS }) {
  const EMAIL_LOG_MAX_ROWS = Number.parseInt(process.env.EMAIL_LOG_MAX_ROWS || "50000", 10);

  db.exec(`CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`);

  db.exec(`CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  recipient TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  message_id TEXT,
  html_content TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_by TEXT
)`);

  // Migration: add html_content column if missing
  try {
    db.exec("ALTER TABLE email_log ADD COLUMN html_content TEXT");
  } catch {
    /* already exists */
  }

  // Migration: recipients JSON array → recipient single string, drop legacy columns
  {
    const columns = () =>
      db
        .prepare("PRAGMA table_info(email_log)")
        .all()
        .map((c) => c.name);
    let cols = columns();
    if (!cols.includes("recipient")) {
      db.exec("ALTER TABLE email_log ADD COLUMN recipient TEXT NOT NULL DEFAULT ''");
      cols = columns();
    }
    if (cols.includes("recipients")) {
      db.prepare(
        `
      UPDATE email_log
      SET recipient = COALESCE(NULLIF(json_extract(recipients, '$[0]'), ''), recipient, '')
      WHERE (recipient IS NULL OR recipient = '') AND recipients LIKE '[%' AND json_valid(recipients)
    `,
      ).run();
      db.exec("ALTER TABLE email_log DROP COLUMN recipients");
      cols = columns();
    }
    if (cols.includes("recipient_count")) {
      db.exec("ALTER TABLE email_log DROP COLUMN recipient_count");
    }
  }

  // 레거시 sent_at은 zone 없는 KST 로컬 값으로 저장됐으므로 +09:00으로 해석한다.
  const normalizeEmailSentAt = (value) => parseLegacyTimestamp(value, { naiveOffset: "+09:00" });

  runMigrationOnce(db, "email.sent_at_utc_normalization.v1", () => {
    const rows = db
      .prepare("SELECT id, sent_at FROM email_log WHERE sent_at IS NOT NULL AND sent_at != ''")
      .all();
    const update = db.prepare("UPDATE email_log SET sent_at = ? WHERE id = ?");
    for (const row of rows) {
      const normalized = normalizeEmailSentAt(row.sent_at);
      if (normalized && normalized !== row.sent_at) update.run(normalized, row.id);
    }
  });

  db.exec(`CREATE INDEX IF NOT EXISTS idx_el_sent_at ON email_log(sent_at)`);

  db.exec("DROP INDEX IF EXISTS idx_el_status");

  db.exec(`CREATE INDEX IF NOT EXISTS idx_el_status_sent_at ON email_log(status, sent_at)`);

  // Seed config keys
  const insertConfig = db.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, '')");

  for (const key of CONFIG_KEYS) insertConfig.run(key);

  // AFTER INSERT 트리거로 매 발송 로그 삽입마다 최신 N행만 보존한다(인터벌 prune과 달리
  // 한도를 초과하는 구간이 생기지 않음).
  setupRowCapRetention(db, "email_log", EMAIL_LOG_MAX_ROWS);
}
