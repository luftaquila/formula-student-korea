import { masterTickDurationsMs } from "../lib/event-timing.mjs";

export function createTrafficStore({
  db,
  recordYearFromName,
  currentRecordYear,
  resolveCanonicalTeam,
  getRun,
}) {
  function getRecordFiles() {
    return db
      .prepare("SELECT DISTINCT name FROM record ORDER BY name")
      .all()
      .map((row) => row.name);
  }

  function getYearRecordFiles(year) {
    const startName = `FSK ${Number(year)} `;
    const endName = `FSK ${Number(year) + 1} `;
    return db
      .prepare("SELECT DISTINCT name FROM record WHERE name >= ? AND name < ? ORDER BY name")
      .all(startName, endName)
      .map((row) => row.name);
  }

  function getRecordRows(name) {
    const year = recordYearFromName(name);
    return db
      .prepare(
        `
    SELECT legacy_rowid AS rowid, time, num, univ, team, type, result, status, detail, cones, oc, scoreboard
    FROM record
    WHERE name = ?
      AND (? IS NULL OR NOT EXISTS (
        SELECT 1 FROM competition_inactive_team s
        WHERE s.year = ? AND s.team_num = record.num
      ))
    ORDER BY legacy_rowid
  `,
      )
      .all(name, year, year);
  }

  function getYearRecordGroups(year) {
    const startName = `FSK ${Number(year)} `;
    const endName = `FSK ${Number(year) + 1} `;
    const rows = db
      .prepare(
        `
    SELECT r.name, r.legacy_rowid AS rowid, r.time, r.num, r.univ, r.team, r.type,
           r.result, r.status, r.detail, r.cones, r.oc, r.scoreboard
    FROM record r
    LEFT JOIN record_visibility v ON v.name = r.name
    WHERE r.name >= ? AND r.name < ? AND COALESCE(v.visible, 1) != 0
      AND NOT EXISTS (
        SELECT 1 FROM competition_inactive_team s
        WHERE s.year = ? AND s.team_num = r.num
      )
    ORDER BY r.name, r.legacy_rowid
  `,
      )
      .all(startName, endName, Number(year));
    const groups = [];
    let current = null;
    for (const row of rows) {
      const { name, ...record } = row;
      if (!current || current.name !== name) {
        current = { name, records: [] };
        groups.push(current);
      }
      current.records.push(record);
    }
    return groups;
  }

  function getRecordRow(name, rowid) {
    return db
      .prepare(
        `
    SELECT legacy_rowid AS rowid, time, num, univ, team, type, result, status, detail, cones, oc, scoreboard
    FROM record
    WHERE name = ? AND legacy_rowid = ?
  `,
      )
      .get(name, rowid);
  }

  function recordFileExists(name) {
    return !!db.prepare("SELECT 1 FROM record WHERE name = ? LIMIT 1").get(name);
  }

  function insertRecordRow(name, data) {
    const year = recordYearFromName(name) ?? currentRecordYear();
    const resolved = resolveCanonicalTeam(data.entry, year);
    if (!resolved.valid) throw { status: resolved.status || 409, message: resolved.error };
    const entry = resolved.team;
    db.prepare("INSERT OR IGNORE INTO record_visibility (name, visible) VALUES (?, 1)").run(name);
    const nextRowid = db
      .prepare("SELECT COALESCE(MAX(legacy_rowid), 0) + 1 AS value FROM record WHERE name = ?")
      .get(name).value;
    db.prepare(
      `
    INSERT INTO record (name, legacy_rowid, time, num, univ, team, type, result, status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    ).run(
      name,
      nextRowid,
      data.time,
      entry.num,
      entry.univ,
      entry.team,
      data.type,
      data.result ?? null,
      data.status ?? null,
      data.detail ?? null,
    );
    return getRecordRow(name, nextRowid);
  }

  function getEventModes() {
    return db.prepare("SELECT event_type, enabled FROM event_mode").all();
  }

  function getRecordVisibility() {
    const rows = db.prepare("SELECT name, visible FROM record_visibility").all();
    const map = {};
    for (const row of rows) map[row.name] = !!row.visible;
    return map;
  }

  function getLightState() {
    return db
      .prepare("SELECT bridge_online, debounce_ms, updated_at FROM wireless_light WHERE id = 1")
      .get();
  }

  function getMapping() {
    return db
      .prepare(
        "SELECT node_id, event_type, role, label, enabled, updated_at FROM wireless_mapping ORDER BY event_type, role",
      )
      .all();
  }

  // 경기별 세션(arm + lease + bind-at-arm). 만료된 lease는 controller=null로 표기.
  const LEASE_TTL_MS = 30000;

  // heartbeat로 갱신. 제어 탭이 죽으면 이 시간 후 자동 해제.
  function getSessions() {
    const now = Date.now();
    return db
      .prepare(
        "SELECT event_type, armed, armed_at, run_id, saved_record_name, saved_record_rowid, team_json, event_name, controller, lease_expires_at, updated_at FROM wireless_session ORDER BY event_type",
      )
      .all()
      .map((r) => {
        const expired = r.lease_expires_at && Date.parse(r.lease_expires_at) <= now;
        let team = null;
        if (r.team_json) {
          try {
            team = JSON.parse(r.team_json);
          } catch {
            team = null;
          }
        }
        const run = getRun(r.event_type);
        return {
          verification: run?.verification ?? null,
          finished: run?.closed ?? false,
          result: run?.result ?? null,
          lap_times: (run?.lapTicks || []).map((value) => masterTickDurationsMs([value])),
          event_type: r.event_type,
          armed: !!r.armed,
          start_tick: run?.boundaryTick ?? null,
          master_boot_id: run?.masterBootId ?? null,
          armed_at: r.armed_at,
          run_id: r.run_id,
          saved_record_name: r.saved_record_name,
          saved_record_rowid: r.saved_record_rowid,
          team,
          event_name: r.event_name,
          controller: expired ? null : r.controller,
          lease_expires_at: expired ? null : r.lease_expires_at,
          updated_at: r.updated_at,
        };
      });
  }

  function getSession(eventType) {
    return getSessions().find((s) => s.event_type === eventType) || null;
  }

  function getDebounceMs() {
    const row = db.prepare("SELECT debounce_ms FROM wireless_light WHERE id = 1").get();
    return Number.isFinite(row?.debounce_ms) ? row.debounce_ms : 300;
  }

  // 최신 무선 이벤트 id. 클라이언트가 (재)연결 시 백필 기준점으로 사용.
  function getLastEventId() {
    const row = db.prepare("SELECT MAX(id) AS m FROM wireless_event").get();
    return row && row.m != null ? row.m : 0;
  }

  function tableExists(name) {
    return recordFileExists(name);
  }

  return {
    getRecordFiles,
    getRecordRows,
    getYearRecordGroups,
    getRecordRow,
    recordFileExists,
    insertRecordRow,
    getEventModes,
    getRecordVisibility,
    getLightState,
    getMapping,
    LEASE_TTL_MS,
    getSessions,
    getSession,
    getDebounceMs,
    getLastEventId,
    tableExists,
  };
}
