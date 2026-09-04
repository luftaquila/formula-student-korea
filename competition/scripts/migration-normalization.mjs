function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map((column) => column.name));
}

function deleteTeamRows(db, table, team, numberColumn = "team_num") {
  const cols = columns(db, table);
  if (!cols.has(numberColumn)) return;
  if (cols.has("team_id")) db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(team.id);
  else if (cols.has("year")) db.prepare(`DELETE FROM ${table} WHERE year = ? AND ${numberColumn} = ?`).run(team.year, team.num);
  else db.prepare(`DELETE FROM ${table} WHERE ${numberColumn} = ?`).run(team.num);
}

// Legacy sources could contain an inactive team that was still queued,
// occupying a booth, or armed for timing. Normalize only that transient state
// during cutover; completed inspection and timing history remains immutable.
export function clearInactiveTeamLiveState(db, team) {
  for (const table of ["inspection_queue", "current_inspection", "team_priority", "cancel_penalty"]) {
    deleteTeamRows(db, table, team, "num");
  }
  if (tableExists(db, "booth")) {
    const boothColumns = columns(db, "booth");
    if (boothColumns.has("occupied_team_id")) {
      const timerReset = boothColumns.has("timer_paused_at") && boothColumns.has("timer_paused_ms")
        ? ", timer_paused_at = NULL, timer_paused_ms = 0"
        : "";
      db.prepare(`
        UPDATE booth SET occupied_by = NULL, entered_at = NULL${timerReset}
        WHERE occupied_team_id = ?
      `).run(team.id);
    }
  }
  if (tableExists(db, "booth_log")) {
    const logColumns = columns(db, "booth_log");
    if (logColumns.has("team_id")) {
      db.prepare("DELETE FROM booth_log WHERE team_id = ? AND exited_at IS NULL").run(team.id);
    } else {
      db.prepare("DELETE FROM booth_log WHERE num = ? AND exited_at IS NULL").run(team.num);
    }
  }
  if (!tableExists(db, "wireless_session")) return;
  const sessionColumns = columns(db, "wireless_session");
  for (const row of db.prepare("SELECT event_type, team_id, team_json FROM wireless_session").all()) {
    let bound = null;
    try { bound = row.team_json ? JSON.parse(row.team_json) : null; } catch { bound = null; }
    const matches = sessionColumns.has("team_id")
      ? Number(row.team_id) === team.id || Number(bound?.id ?? bound?.teamId) === team.id
      : Number(bound?.num) === team.num && team.year === currentCompetitionYear();
    if (!matches) continue;
    db.prepare(`
      UPDATE wireless_session
      SET armed = 0, light_color = 'off', team_json = NULL, event_name = NULL,
          run_id = NULL, saved_record_name = NULL, saved_record_rowid = NULL,
          reset_pending = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE event_type = ?
    `).run(row.event_type);
  }
}
import { currentCompetitionYear } from "../../shared/competition-year.mjs";
