import { currentCompetitionYear } from "../../../../shared/common/competition-year.mjs";

export function initializeSchema({ db, QUEUE_TABLE_SQL }) {
  db.pragma("foreign_keys = ON");

  db.transaction(() => {
    // 마이그레이션: 은퇴한 'called' 상태(그리고 called_at)를 가진 기존 DB를 재작성한다.
    // SQLite 는 CHECK 제약을 바꿀 수 없다. 스키마 계약은 새로 만든 DB의 DDL 문장을
    // 해시하므로, 재작성 후에도 같은 텍스트가 남도록 QUEUE_TABLE_SQL 을 그대로 쓴다
    // (score 의 내구 테이블 재작성과 같은 방식). 인덱스는 레거시 테이블과 함께 사라지고
    // 아래 CREATE INDEX IF NOT EXISTS 가 새 정의로 다시 만든다.
    const legacyColumns = db
      .prepare("PRAGMA table_info(registration_queue)")
      .all()
      .map((column) => column.name);
    if (legacyColumns.includes("called_at")) {
      db.exec("ALTER TABLE registration_queue RENAME TO registration_queue_with_called_status");
      db.exec(QUEUE_TABLE_SQL);
      db.exec(`
        INSERT INTO registration_queue
          (id, team_id, phone, status, notified, notify_claimed_at, registered_at, finished_at)
          SELECT id, team_id, phone,
                 CASE WHEN status = 'called' THEN 'waiting' ELSE status END,
                 notified, notify_claimed_at, registered_at, finished_at
          FROM registration_queue_with_called_status;
        DROP TABLE registration_queue_with_called_status;
      `);
    }

    db.exec(QUEUE_TABLE_SQL);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_registration_queue_status
      ON registration_queue(status, id);
    CREATE INDEX IF NOT EXISTS idx_registration_queue_team
      ON registration_queue(team_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_registration_queue_finished
      ON registration_queue(finished_at) WHERE finished_at IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_queue_active_team
      ON registration_queue(team_id) WHERE status = 'waiting';

    CREATE TABLE IF NOT EXISTS registration_settings (
      year INTEGER PRIMARY KEY CHECK(year BETWEEN 2000 AND 2099),
      open INTEGER NOT NULL DEFAULT 0 CHECK(open IN (0,1)),
      sms INTEGER NOT NULL DEFAULT 0 CHECK(sms IN (0,1)),
      notify_rank INTEGER NOT NULL DEFAULT 3 CHECK(notify_rank BETWEEN 0 AND 20),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );`);
    db.prepare(
      `
      INSERT OR IGNORE INTO registration_settings (year, open, sms, notify_rank)
      VALUES (?, 0, 0, 3)
    `,
    ).run(currentCompetitionYear());
  })();
}
