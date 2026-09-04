function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map((column) => column.name));
}

function updateByTeamId(db, table, assignments, teamId) {
  if (!tableExists(db, table)) return 0;
  const available = columns(db, table);
  if (!available.has("team_id")) return 0;
  const selected = Object.entries(assignments).filter(([column]) => available.has(column));
  if (!selected.length) return 0;
  const sql = selected.map(([column]) => `${column} = ?`).join(", ");
  return db.prepare(`UPDATE ${table} SET ${sql} WHERE team_id = ?`)
    .run(...selected.map(([, value]) => value), teamId).changes;
}

export function updateCanonicalTeamProjections(db, before, after) {
  const changes = {};
  for (const [table, numberColumn] of [
    ["current_inspection", "num"], ["inspection_queue", "num"],
    ["inspection_history", "num"], ["team_priority", "num"],
    ["cancel_penalty", "num"], ["booth_log", "num"], ["queue_log", "num"],
    ["sheet_answer", "team_num"], ["sheet_category_result", "team_num"],
    ["sheet_inspector", "team_num"], ["score_manual", "team_num"],
    ["score_endurance", "team_num"], ["student_team", "team_num"],
    ["session_team", "team_num"], ["submission", "team_num"],
  ]) {
    const count = updateByTeamId(db, table, { [numberColumn]: after.number }, after.id);
    if (count) changes[table] = count;
  }

  const recordCount = updateByTeamId(db, "record", {
    num: after.number,
    univ: after.university,
    team: after.name,
  }, after.id);
  if (recordCount) changes.record = recordCount;

  if (tableExists(db, "booth") && columns(db, "booth").has("occupied_team_id")) {
    const count = db.prepare("UPDATE booth SET occupied_by = ? WHERE occupied_team_id = ?")
      .run(after.number, after.id).changes;
    if (count) changes.booth = count;
  }

  if (tableExists(db, "wireless_session") && columns(db, "wireless_session").has("team_id")) {
    const rows = db.prepare("SELECT event_type, team_json FROM wireless_session WHERE team_id = ?").all(after.id);
    const update = db.prepare(`
      UPDATE wireless_session
      SET team_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE event_type = ?
    `);
    for (const row of rows) {
      let snapshot = {};
      try { snapshot = row.team_json ? JSON.parse(row.team_json) : {}; } catch { snapshot = {}; }
      update.run(JSON.stringify({
        ...snapshot,
        id: after.id,
        teamId: after.id,
        num: after.number,
        univ: after.university,
        team: after.name,
        type: after.vehicleType,
      }), row.event_type);
    }
    if (rows.length) changes.wireless_session = rows.length;
  }

  return changes;
}

function deleteTransientRows(db, table, team, numberColumn = "team_num") {
  if (!tableExists(db, table)) return 0;
  const available = columns(db, table);
  if (available.has("team_id")) return db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(team.id).changes;
  if (available.has("year") && available.has(numberColumn)) {
    return db.prepare(`DELETE FROM ${table} WHERE year = ? AND ${numberColumn} = ?`)
      .run(team.year, team.number).changes;
  }
  return 0;
}

export function clearCanonicalTeamTransientState(db, team) {
  const changes = {};
  if (tableExists(db, "registration_queue") && columns(db, "registration_queue").has("team_id")) {
    const count = db.prepare(`
      UPDATE registration_queue
      SET status = 'canceled',
          finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE team_id = ? AND status = 'waiting'
    `).run(team.id).changes;
    if (count) changes.registration_queue = count;
  }
  for (const table of ["inspection_queue", "current_inspection", "team_priority", "cancel_penalty"]) {
    const count = deleteTransientRows(db, table, team, "num");
    if (count) changes[table] = count;
  }
  if (tableExists(db, "booth") && columns(db, "booth").has("occupied_team_id")) {
    const boothColumns = columns(db, "booth");
    const timerReset = boothColumns.has("timer_paused_at") && boothColumns.has("timer_paused_ms")
      ? ", timer_paused_at = NULL, timer_paused_ms = 0"
      : "";
    const count = db.prepare(`
      UPDATE booth
      SET occupied_by = NULL, occupied_team_id = NULL, entered_at = NULL${timerReset}
      WHERE occupied_team_id = ?
    `).run(team.id).changes;
    if (count) changes.booth = count;
  }
  if (tableExists(db, "booth_log") && columns(db, "booth_log").has("team_id")) {
    const count = db.prepare("DELETE FROM booth_log WHERE team_id = ? AND exited_at IS NULL")
      .run(team.id).changes;
    if (count) changes.booth_log = count;
  }
  if (tableExists(db, "wireless_session") && columns(db, "wireless_session").has("team_id")) {
    const count = db.prepare(`
      UPDATE wireless_session
      SET armed = 0, light_color = 'off', team_id = NULL, team_json = NULL, event_name = NULL,
          run_id = NULL, saved_record_name = NULL, saved_record_rowid = NULL,
          reset_pending = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE team_id = ?
    `).run(team.id).changes;
    if (count) changes.wireless_session = count;
  }
  return changes;
}

function addTeamId(db, table) {
  if (!tableExists(db, table)) return false;
  if (!columns(db, table).has("team_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN team_id INTEGER`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_team_id ON ${table}(team_id)`);
  return true;
}

function installYearNumberBinding(db, table, numberColumn, { strict = true } = {}) {
  if (!addTeamId(db, table)) return;
  const cols = columns(db, table);
  if (!cols.has("year") || !cols.has(numberColumn)) return;
  db.exec(`
    UPDATE ${table}
    SET team_id = (
      SELECT id FROM competition_team t
      WHERE t.year = ${table}.year AND t.num = ${table}.${numberColumn}
    )
    WHERE team_id IS NULL;
    DROP TRIGGER IF EXISTS trg_${table}_bind_team_insert;
    CREATE TRIGGER trg_${table}_bind_team_insert
    AFTER INSERT ON ${table} WHEN NEW.team_id IS NULL
    BEGIN
      UPDATE ${table}
      SET team_id = (
        SELECT id FROM competition_team t
        WHERE t.year = NEW.year AND t.num = NEW.${numberColumn}
      )
      WHERE rowid = NEW.rowid;
      ${strict ? `SELECT RAISE(ABORT, 'unknown competition team')
        WHERE (SELECT team_id FROM ${table} WHERE rowid = NEW.rowid) IS NULL;` : ""}
    END;
    DROP TRIGGER IF EXISTS trg_${table}_validate_team_insert;
    ${strict ? `CREATE TRIGGER trg_${table}_validate_team_insert
    BEFORE INSERT ON ${table} WHEN NEW.team_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'mismatched competition team')
      WHERE NOT EXISTS (
        SELECT 1 FROM competition_team t
        WHERE t.id = NEW.team_id AND t.year = NEW.year
          AND t.num = NEW.${numberColumn}
      );
    END;` : ""}
  `);
}

function installDocumentBinding(db, table) {
  if (!addTeamId(db, table)) return;
  db.exec(`
    UPDATE ${table}
    SET team_id = (
      SELECT t.id
      FROM session s JOIN competition_team t ON t.year = s.year
      WHERE s.id = ${table}.session_id AND t.num = ${table}.team_num
    )
    WHERE team_id IS NULL;
    DROP TRIGGER IF EXISTS trg_${table}_bind_team_insert;
    CREATE TRIGGER trg_${table}_bind_team_insert
    AFTER INSERT ON ${table} WHEN NEW.team_id IS NULL
    BEGIN
      UPDATE ${table}
      SET team_id = (
        SELECT t.id
        FROM session s JOIN competition_team t ON t.year = s.year
        WHERE s.id = NEW.session_id AND t.num = NEW.team_num
      )
      WHERE rowid = NEW.rowid;
      SELECT RAISE(ABORT, 'unknown competition team')
      WHERE (SELECT team_id FROM ${table} WHERE rowid = NEW.rowid) IS NULL;
    END;
    DROP TRIGGER IF EXISTS trg_${table}_validate_team_insert;
    CREATE TRIGGER trg_${table}_validate_team_insert
    BEFORE INSERT ON ${table} WHEN NEW.team_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'mismatched competition team')
      WHERE NOT EXISTS (
        SELECT 1
        FROM session s JOIN competition_team t ON t.year = s.year
        WHERE s.id = NEW.session_id AND t.id = NEW.team_id
          AND t.num = NEW.team_num
      );
    END;
  `);
}

export function installCanonicalTeamReferences(db) {
  for (const [table, numberColumn, strict = true] of [
    ["current_inspection", "num"],
    ["inspection_queue", "num"],
    ["inspection_history", "num"],
    ["team_priority", "num"],
    ["cancel_penalty", "num"],
    ["booth_log", "num", false],
    ["queue_log", "num", false],
    ["sheet_answer", "team_num"],
    ["sheet_category_result", "team_num"],
    ["sheet_inspector", "team_num"],
    ["score_manual", "team_num"],
    ["score_endurance", "team_num"],
    ["student_team", "team_num"],
  ]) installYearNumberBinding(db, table, numberColumn, { strict });

  for (const table of ["session_team", "submission"]) installDocumentBinding(db, table);

  if (addTeamId(db, "record")) {
    db.exec(`
      UPDATE record
      SET team_id = (
        SELECT id FROM competition_team t
        WHERE t.year = CAST(substr(record.name, 5, 4) AS INTEGER)
          AND t.num = record.num
      )
      WHERE team_id IS NULL;
      DROP TRIGGER IF EXISTS trg_record_bind_team_insert;
      CREATE TRIGGER trg_record_bind_team_insert
      AFTER INSERT ON record WHEN NEW.team_id IS NULL
      BEGIN
        UPDATE record
        SET team_id = (
          SELECT id FROM competition_team t
          WHERE t.year = CAST(substr(NEW.name, 5, 4) AS INTEGER)
            AND t.num = NEW.num
        )
        WHERE rowid = NEW.rowid;
        SELECT RAISE(ABORT, 'unknown competition team')
        WHERE COALESCE(NEW.status, '') != 'DSQ'
          AND (SELECT team_id FROM record WHERE rowid = NEW.rowid) IS NULL;
      END;
      DROP TRIGGER IF EXISTS trg_record_validate_team_insert;
      CREATE TRIGGER trg_record_validate_team_insert
      BEFORE INSERT ON record WHEN NEW.team_id IS NOT NULL AND COALESCE(NEW.status, '') != 'DSQ'
      BEGIN
        SELECT RAISE(ABORT, 'mismatched competition team')
        WHERE NOT EXISTS (
          SELECT 1 FROM competition_team t
          WHERE t.id = NEW.team_id
            AND t.year = CAST(substr(NEW.name, 5, 4) AS INTEGER)
            AND t.num = NEW.num
        );
      END;
    `);
  }

  if (addTeamId(db, "wireless_session")) {
    db.exec(`
      UPDATE wireless_session
      SET team_id = (
        SELECT t.id FROM competition_team t
        WHERE t.num = CAST(json_extract(wireless_session.team_json, '$.num') AS INTEGER)
          AND (
            t.id = CAST(COALESCE(
              json_extract(wireless_session.team_json, '$.teamId'),
              json_extract(wireless_session.team_json, '$.id')
            ) AS INTEGER)
            OR (
              COALESCE(
                json_extract(wireless_session.team_json, '$.teamId'),
                json_extract(wireless_session.team_json, '$.id')
              ) IS NULL
              AND t.active = 1
              AND (SELECT COUNT(*) FROM competition_team candidate
                   WHERE candidate.num = t.num AND candidate.active = 1) = 1
            )
          )
        LIMIT 1
      )
      WHERE team_id IS NULL AND json_valid(team_json);
      DROP TRIGGER IF EXISTS trg_wireless_session_bind_team_update;
      CREATE TRIGGER trg_wireless_session_bind_team_update
      AFTER UPDATE OF team_json ON wireless_session
      BEGIN
        UPDATE wireless_session
        SET team_id = CASE
          WHEN NEW.team_json IS NULL OR NOT json_valid(NEW.team_json) THEN NULL
          ELSE (
            SELECT t.id FROM competition_team t
            WHERE t.num = CAST(json_extract(NEW.team_json, '$.num') AS INTEGER)
              AND (
                t.id = CAST(COALESCE(
                  json_extract(NEW.team_json, '$.teamId'),
                  json_extract(NEW.team_json, '$.id')
                ) AS INTEGER)
                OR (
                  COALESCE(
                    json_extract(NEW.team_json, '$.teamId'),
                    json_extract(NEW.team_json, '$.id')
                  ) IS NULL
                  AND t.active = 1
                  AND (SELECT COUNT(*) FROM competition_team candidate
                       WHERE candidate.num = t.num AND candidate.active = 1) = 1
                )
              )
            LIMIT 1
          )
        END
        WHERE event_type = NEW.event_type;
        SELECT RAISE(ABORT, 'unknown competition team')
        WHERE NEW.team_json IS NOT NULL
          AND (NOT json_valid(NEW.team_json)
            OR (SELECT team_id FROM wireless_session WHERE event_type = NEW.event_type) IS NULL);
      END;
    `);
  }

  if (tableExists(db, "booth")) {
    if (!columns(db, "booth").has("occupied_team_id")) db.exec("ALTER TABLE booth ADD COLUMN occupied_team_id INTEGER");
    const boothColumns = columns(db, "booth");
    const timerReset = boothColumns.has("timer_paused_at") && boothColumns.has("timer_paused_ms")
      ? ", timer_paused_at = NULL, timer_paused_ms = 0"
      : "";
    db.exec(`
      UPDATE booth
      SET occupied_team_id = COALESCE(
        (SELECT log.team_id
         FROM booth_log log
         JOIN competition_team t ON t.id = log.team_id
         WHERE log.inspection = booth.inspection
           AND log.booth_num = booth.booth_num
           AND log.num = booth.occupied_by
           AND log.exited_at IS NULL
         ORDER BY log.entered_at DESC, log.id DESC
         LIMIT 1),
        (SELECT t.id FROM competition_team t
         WHERE t.num = booth.occupied_by
           AND (SELECT COUNT(*) FROM competition_team candidate
                WHERE candidate.num = booth.occupied_by) = 1
         LIMIT 1)
      )
      WHERE occupied_team_id IS NULL AND occupied_by IS NOT NULL;
      DROP TRIGGER IF EXISTS trg_booth_bind_team_update;
      DROP TRIGGER IF EXISTS trg_booth_validate_team_update;
      CREATE TRIGGER trg_booth_validate_team_update
      BEFORE UPDATE OF occupied_by, occupied_team_id ON booth WHEN NEW.occupied_by IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'unknown competition team')
        WHERE NEW.occupied_team_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM competition_team t
          WHERE t.id = NEW.occupied_team_id
            AND t.num = NEW.occupied_by
        );
      END;
      DROP TRIGGER IF EXISTS trg_booth_clear_team_update;
      CREATE TRIGGER trg_booth_clear_team_update
      AFTER UPDATE OF occupied_by ON booth WHEN NEW.occupied_by IS NULL
      BEGIN
        UPDATE booth SET occupied_team_id = NULL${timerReset}
        WHERE inspection = NEW.inspection AND booth_num = NEW.booth_num;
      END;
    `);
  }
}

export function assertCanonicalTeamReferences(db) {
  const violations = [];
  if (tableExists(db, "competition_team") && tableExists(db, "competition_vehicle_type")) {
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM competition_team team
      LEFT JOIN competition_vehicle_type vehicle_type ON vehicle_type.id = team.vehicle_type_id
      WHERE team.vehicle_type_id IS NOT NULL
        AND (vehicle_type.id IS NULL OR vehicle_type.year != team.year)
    `).get().count;
    if (count) violations.push({ table: "competition_team.vehicle_type_id", count });
  }
  if (tableExists(db, "registration_queue") && columns(db, "registration_queue").has("team_id")) {
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM registration_queue source_row
      LEFT JOIN competition_team team ON team.id = source_row.team_id
      WHERE team.id IS NULL
    `).get().count;
    if (count) violations.push({ table: "registration_queue", count });
  }
  const yearNumberTables = [
    ["current_inspection", "num"], ["inspection_queue", "num"],
    ["inspection_history", "num"], ["team_priority", "num"], ["cancel_penalty", "num"],
    ["sheet_answer", "team_num"], ["sheet_category_result", "team_num"],
    ["sheet_inspector", "team_num"], ["score_manual", "team_num"],
    ["score_endurance", "team_num"], ["student_team", "team_num"],
  ];
  for (const [table, numberColumn] of yearNumberTables) {
    if (!tableExists(db, table) || !columns(db, table).has("team_id")) continue;
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${table} source_row
      LEFT JOIN competition_team team ON team.id = source_row.team_id
      WHERE team.id IS NULL OR team.year != source_row.year OR team.num != source_row.${numberColumn}
    `).get().count;
    if (count) violations.push({ table, count });
  }
  for (const table of ["session_team", "submission"]) {
    if (!tableExists(db, table) || !columns(db, table).has("team_id")) continue;
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${table} source_row
      LEFT JOIN session source_session ON source_session.id = source_row.session_id
      LEFT JOIN competition_team team ON team.id = source_row.team_id
      WHERE source_session.id IS NULL OR team.id IS NULL
         OR team.year != source_session.year OR team.num != source_row.team_num
    `).get().count;
    if (count) violations.push({ table, count });
  }
  if (tableExists(db, "record") && columns(db, "record").has("team_id")) {
    const recordColumns = columns(db, "record");
    const dsq = recordColumns.has("status")
      ? "COALESCE(source_row.status, '') != 'DSQ' AND"
      : recordColumns.has("invalidated")
        ? "COALESCE(source_row.invalidated, 0) = 0 AND"
        : "";
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM record source_row
      LEFT JOIN competition_team team ON team.id = source_row.team_id
      WHERE ${dsq} (team.id IS NULL
        OR team.year != CAST(substr(source_row.name, 5, 4) AS INTEGER)
        OR team.num != source_row.num)
    `).get().count;
    if (count) violations.push({ table: "record", count });
  }
  if (tableExists(db, "wireless_session") && columns(db, "wireless_session").has("team_id")) {
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM wireless_session source_row
      LEFT JOIN competition_team team ON team.id = source_row.team_id
      WHERE source_row.team_json IS NOT NULL
        AND (NOT json_valid(source_row.team_json)
          OR team.id IS NULL
          OR team.active != 1
          OR team.num != CAST(CASE WHEN json_valid(source_row.team_json)
            THEN json_extract(source_row.team_json, '$.num') END AS INTEGER)
          OR (COALESCE(
                CASE WHEN json_valid(source_row.team_json) THEN json_extract(source_row.team_json, '$.teamId') END,
                CASE WHEN json_valid(source_row.team_json) THEN json_extract(source_row.team_json, '$.id') END
              ) IS NOT NULL
            AND team.id != CAST(COALESCE(
              CASE WHEN json_valid(source_row.team_json) THEN json_extract(source_row.team_json, '$.teamId') END,
              CASE WHEN json_valid(source_row.team_json) THEN json_extract(source_row.team_json, '$.id') END
            ) AS INTEGER)))
    `).get().count;
    if (count) violations.push({ table: "wireless_session", count });
  }
  if (tableExists(db, "booth") && columns(db, "booth").has("occupied_team_id")) {
    const boothLogBinding = tableExists(db, "booth_log") && columns(db, "booth_log").has("team_id")
      ? `OR NOT EXISTS (
          SELECT 1 FROM booth_log log
          WHERE log.inspection = source_row.inspection
            AND log.booth_num = source_row.booth_num
            AND log.num = source_row.occupied_by
            AND log.team_id = source_row.occupied_team_id
            AND log.year = team.year
            AND log.exited_at IS NULL
        )`
      : "";
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM booth source_row
      LEFT JOIN competition_team team ON team.id = source_row.occupied_team_id
      WHERE source_row.occupied_by IS NOT NULL
        AND (team.id IS NULL
          OR team.active != 1
          OR team.num != source_row.occupied_by
          ${boothLogBinding})
    `).get().count;
    if (count) violations.push({ table: "booth", count });
  }
  if (violations.length) {
    throw new Error(`unbound canonical team references: ${violations.map(({ table, count }) => `${table}=${count}`).join(", ")}`);
  }
  return true;
}
