import {
  runMigrationOnce,
  normalizeTimestampColumn,
  addColumn,
} from "../../../../shared/server/db-setup.mjs";

export function initializeSchema({ db }) {
  db.pragma("foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS student_team (
  email TEXT PRIMARY KEY,
  team_num INTEGER NOT NULL,
  year INTEGER NOT NULL,
  UNIQUE(team_num, year)
)`);

  // 마이그레이션: student_team PK를 (email, year)로 변경
  {
    const info = db.prepare("PRAGMA table_info(student_team)").all();
    const emailCol = info.find((c) => c.name === "email");
    const yearCol = info.find((c) => c.name === "year");
    if (emailCol && emailCol.pk === 1 && (!yearCol || yearCol.pk !== 2)) {
      // 기존 스키마: email이 단독 PK → (email, year) 복합 PK로 마이그레이션
      db.transaction(() => {
        db.exec(`CREATE TABLE student_team_new (
        email TEXT NOT NULL,
        team_num INTEGER NOT NULL,
        year INTEGER NOT NULL,
        PRIMARY KEY (email, year),
        UNIQUE(team_num, year)
      )`);
        db.exec(
          "INSERT OR IGNORE INTO student_team_new (email, team_num, year) SELECT email, team_num, year FROM student_team",
        );
        db.exec("DROP TABLE student_team");
        db.exec("ALTER TABLE student_team_new RENAME TO student_team");
      })();
    }
  }

  addColumn(db, "student_team", "team_id INTEGER");

  db.exec(`CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notice TEXT DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  late_end_at TEXT NOT NULL,
  max_file_size INTEGER NOT NULL DEFAULT 52428800,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  year INTEGER NOT NULL
)`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_session_year ON session(year)");

  db.exec(`CREATE TABLE IF NOT EXISTS session_team (
  session_id INTEGER NOT NULL,
  team_num INTEGER NOT NULL,
  PRIMARY KEY (session_id, team_num),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
)`);

  addColumn(db, "session_team", "team_id INTEGER");

  db.exec(`CREATE TABLE IF NOT EXISTS submission (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  team_num INTEGER NOT NULL,
  submitted_by TEXT NOT NULL,
  started_at TEXT DEFAULT '',
  submitted_at TEXT NOT NULL,
  total_size INTEGER NOT NULL DEFAULT 0,
  is_late INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
)`);

  // idx_sub_session_team_id(session_id, team_num, id DESC)가 (session_id, team_num) 조회도
  // 커버하므로 prefix 인덱스 idx_sub_session_team은 제거(기존 배포본 정리 포함).
  db.exec("DROP INDEX IF EXISTS idx_sub_session_team");

  db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_session_team_id
  ON submission(session_id, team_num, id DESC)`);

  db.exec(`CREATE TABLE IF NOT EXISTS submission_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT DEFAULT '',
  FOREIGN KEY (submission_id) REFERENCES submission(id) ON DELETE CASCADE
)`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_sf_submission
  ON submission_file(submission_id)`);

  addColumn(db, "submission_file", "text_charset TEXT DEFAULT ''");

  // 마이그레이션: allowed_extensions 컬럼 추가
  addColumn(db, "session", "allowed_extensions TEXT DEFAULT ''");

  // 마이그레이션: started_at 컬럼 추가 (업로드 시작 시간)
  addColumn(db, "submission", "started_at TEXT DEFAULT ''");

  // Competition stores a stable, team-ID-based relative directory here. The
  // one-shot migrator populates this for imported rows before runtime starts.
  addColumn(db, "submission", "storage_dir TEXT");

  // 마이그레이션: attempt_no 컬럼 추가 (제출 시도 누적 번호 — retention과 무관하게 유지)
  addColumn(db, "submission", "attempt_no INTEGER NOT NULL DEFAULT 0");

  addColumn(db, "submission", "team_id INTEGER");

  {
    const pending = db.prepare("SELECT 1 FROM submission WHERE attempt_no = 0 LIMIT 1").get();
    if (pending) {
      // 살아남은 row 그룹별로 logs(submission.create info)에서 실제 시도 횟수를 복원.
      // logs FIFO cap(50k, shared/server/logger.mjs)에 의해 잘려있을 경우 최소 하한은 현재 row 수.
      db.transaction(() => {
        const groups = db
          .prepare(
            `
        SELECT session_id, team_num, COUNT(*) AS rows
        FROM submission WHERE attempt_no = 0
        GROUP BY session_id, team_num
      `,
          )
          .all();
        const countLogs = db.prepare(`
        SELECT COUNT(*) AS c FROM logs
        WHERE action = 'submission.create' AND level = 'info'
          AND CAST(json_extract(detail, '$.session_id') AS INTEGER) = ?
          AND CAST(json_extract(detail, '$.team_num') AS INTEGER) = ?
      `);
        const zeroRowsStmt = db.prepare(`
        SELECT id FROM submission
        WHERE session_id = ? AND team_num = ? AND attempt_no = 0
        ORDER BY id DESC
      `);
        const setAttempt = db.prepare("UPDATE submission SET attempt_no = ? WHERE id = ?");
        for (const g of groups) {
          const logged = countLogs.get(g.session_id, g.team_num).c;
          // 로그가 잘려 있어도 최소 하한은 살아남은 row 수.
          const newest = Math.max(logged, g.rows);
          const rows = zeroRowsStmt.all(g.session_id, g.team_num);
          let n = newest;
          for (const r of rows) {
            setAttempt.run(n, r.id);
            n -= 1;
          }
        }
      })();
    }
  }

  // 예약 알림 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_notification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
)`);

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sn_pending ON scheduled_notification(sent, scheduled_at)",
  );

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sn_session_sent ON scheduled_notification(session_id, sent)",
  );

  // 부분 발송 재시도용: 성공적으로 보낸 수신자 이메일(JSON 배열). 다음 tick에서 이 목록을
  // 스킵해 실패 수신자만 재시도하고 이미 보낸 수신자에겐 중복 발송하지 않는다.
  addColumn(db, "scheduled_notification", "sent_recipients TEXT DEFAULT '[]'");

  // 부분 발송 재시도 횟수. 영구 실패(무효/바운스 주소 등)로 remaining이 계속 남으면 상한 도달 후
  // sent=1로 종료해 매 tick 무한 재시도 + partial_send warn firehose를 막는다.
  addColumn(db, "scheduled_notification", "attempts INTEGER NOT NULL DEFAULT 0");
}

export function normalizeDocumentTimestamps({ db, normalizeTimestamp }) {
  runMigrationOnce(db, "documents.utc_timestamp_normalization.v1", () => {
    for (const [table, column] of [
      ["session", "start_at"],
      ["session", "end_at"],
      ["session", "late_end_at"],
      ["session", "created_at"],
      ["submission", "started_at"],
      ["submission", "submitted_at"],
      ["scheduled_notification", "scheduled_at"],
    ]) {
      normalizeTimestampColumn(db, table, column, normalizeTimestamp);
    }
  });
}
