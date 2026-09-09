// 대기열에 남아 있는 유일한 상태. 'called' 는 운영 흐름에서 제거됐다(완료/취소만 쓴다).
export const ACTIVE_STATUS = "waiting";

// 신규 생성과 레거시 재작성이 같은 문장을 쓰도록 한 곳에 둔다 — 스키마 계약은 이
// DDL 텍스트를 해시하므로 두 경로가 갈리면 배포 검증이 실패한다.
export const QUEUE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS registration_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES competition_team(id),
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK(status IN ('waiting','done','canceled')),
      notified INTEGER NOT NULL DEFAULT 0 CHECK(notified IN (0,1,2)),
      notify_claimed_at TEXT,
      registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      finished_at TEXT
    );`;

export const DEFAULT_SETTINGS = Object.freeze({ open: false, sms: false, notifyRank: 3 });
