import { runMigrationOnce } from "../../shared/server/db-setup.mjs";

export function initializeSchema({ db, normalizeDateTime }) {
  db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'official'
)`);

  // 범위 조회는 idx_events_all_day_end_start, 정렬 조회는 idx_events_role_start가 커버.
  // 단독 (start,end)/(end,start) 인덱스는 매칭되는 쿼리가 없어 제거(기존 배포본 정리 포함).
  db.exec("DROP INDEX IF EXISTS idx_events_start_end");

  db.exec("DROP INDEX IF EXISTS idx_events_end_start");

  db.exec("CREATE INDEX IF NOT EXISTS idx_events_role_start ON events(role, start)");

  db.exec("CREATE INDEX IF NOT EXISTS idx_events_all_day_end_start ON events(all_day, end, start)");

  runMigrationOnce(db, "calendar.event_timestamp_normalization.v1", () => {
    const update = db.prepare("UPDATE events SET start = ?, end = ? WHERE id = ?");
    for (const event of db.prepare("SELECT id, start, end, all_day FROM events").all()) {
      const allDay = !!event.all_day;
      const start = normalizeDateTime(event.start, { allDay, requireTime: !allDay });
      const end = normalizeDateTime(event.end, { allDay, requireTime: !allDay });
      if (start && end && (start !== event.start || end !== event.end)) {
        update.run(start, end, event.id);
      }
    }
  });

  runMigrationOnce(db, "calendar.event_audience.v2", () => {
    db.prepare(
      "UPDATE events SET role = 'official' WHERE role NOT IN ('public', 'student', 'official')",
    ).run();
  });
}
