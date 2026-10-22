// Schema of the mission tables the Course server no longer uses. The rover's
// mission ledger moved to the rover hub (fsk-coursekeeper); FSK keeps these
// tables and their history, and still converges older databases to the
// validated layout, but nothing reads or writes missions anymore.
import crypto from "crypto";

const MISSION_PROTOCOL_VERSION = 2;
const ACTIVE_MISSION_STATES = [
  "ready", "starting", "running", "pausing", "paused", "interrupted", "resuming",
];

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(db, table, column, sql) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sql}`);
}

export function setupMissionV2Schema(db, logger = null) {
  const changed = [];
  db.transaction(() => {
    for (const [column, sql] of [
      ["created_at", "INTEGER"],
      ["activated_at", "INTEGER"],
      ["preset_id", "INTEGER"],
      ["lifecycle_state", "TEXT"],
      ["hold_reason", "TEXT"],
      ["finish_behavior", "TEXT NOT NULL DEFAULT 'stop'"],
      ["plan_hash", "TEXT"],
      ["start_lat", "REAL"],
      ["start_lng", "REAL"],
      ["start_alt", "REAL"],
      ["last_rover_boot_id", "TEXT"],
      ["active_command_id", "TEXT"],
      ["active_hold_id", "TEXT"],
      ["empty_plan_mode", "TEXT"],
      ["protocol_version", "INTEGER NOT NULL DEFAULT 1"],
    ]) {
      if (!hasColumn(db, "mission", column)) {
        addColumn(db, "mission", column, sql);
        changed.push(`mission.${column}`);
      }
    }

    if (changed.includes("mission.finish_behavior")) {
      // Every legacy navigator always returned to its start; preserve that fact
      // in history. New missions explicitly default to stopping at the last cone.
      db.prepare("UPDATE mission SET finish_behavior='return_to_start'").run();
    }

    db.exec(`CREATE TABLE IF NOT EXISTS mission_route_preset (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      finish_behavior TEXT NOT NULL CHECK(finish_behavior IN ('stop', 'return_to_start')) DEFAULT 'stop',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      actor TEXT,
      FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE,
      UNIQUE (course_id, name)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS mission_route_preset_item (
      id TEXT PRIMARY KEY,
      preset_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      cone_id INTEGER,
      cone_id_snapshot INTEGER NOT NULL,
      lat_snapshot REAL NOT NULL,
      lng_snapshot REAL NOT NULL,
      alt_snapshot REAL,
      side_snapshot TEXT,
      FOREIGN KEY (preset_id) REFERENCES mission_route_preset(id) ON DELETE CASCADE,
      FOREIGN KEY (cone_id) REFERENCES cone(id) ON DELETE SET NULL,
      UNIQUE (preset_id, position)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_preset_course
      ON mission_route_preset(course_id, updated_at DESC)`);

    db.exec(`CREATE TABLE IF NOT EXISTS mission_waypoint (
      id TEXT PRIMARY KEY,
      mission_id INTEGER NOT NULL,
      position INTEGER,
      cone_id INTEGER,
      cone_id_snapshot INTEGER,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      alt REAL,
      side TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'completed', 'skipped')) DEFAULT 'pending',
      outcome TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      skipped_at INTEGER,
      skip_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE,
      FOREIGN KEY (cone_id) REFERENCES cone(id) ON DELETE SET NULL,
      UNIQUE (mission_id, position)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_waypoint_state
      ON mission_waypoint(mission_id, state, position)`);

    db.exec(`CREATE TABLE IF NOT EXISTS mission_command (
      id TEXT PRIMARY KEY,
      mission_id INTEGER NOT NULL,
      command_seq INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('start', 'pause', 'resume', 'end')),
      plan_hash TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending', 'accepted', 'rejected', 'superseded')) DEFAULT 'pending',
      requested_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      actor TEXT,
      rover_boot_id TEXT,
      reject_reason TEXT,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE,
      UNIQUE (mission_id, command_seq)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_command_pending
      ON mission_command(state, requested_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS mission_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      t INTEGER NOT NULL,
      waypoint_id TEXT,
      command_id TEXT,
      rover_boot_id TEXT,
      actor TEXT,
      before_json TEXT,
      after_json TEXT,
      detail_json TEXT,
      FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_event_mission
      ON mission_event(mission_id, t, id)`);

    db.exec(`CREATE TABLE IF NOT EXISTS rover_boot_session (
      boot_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL UNIQUE,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_report_seq INTEGER NOT NULL DEFAULT -1
        CHECK(last_report_seq BETWEEN -1 AND 9007199254740991)
    )`);
    if (!hasColumn(db, "rover_boot_session", "last_report_seq")) {
      addColumn(db, "rover_boot_session", "last_report_seq",
        "INTEGER NOT NULL DEFAULT -1 CHECK(last_report_seq BETWEEN -1 AND 9007199254740991)");
      changed.push("rover_boot_session.last_report_seq");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rover_boot_session_generation
      ON rover_boot_session(generation DESC)`);

    db.prepare(`UPDATE mission SET
      created_at = COALESCE(created_at, started_at),
      lifecycle_state = COALESCE(lifecycle_state,
        CASE status
          WHEN 'running' THEN 'interrupted'
          WHEN 'paused' THEN 'interrupted'
          WHEN 'interrupted' THEN 'interrupted'
          WHEN 'completed' THEN 'completed'
          ELSE 'cancelled'
        END),
      finish_behavior = COALESCE(finish_behavior, 'return_to_start'),
      protocol_version = COALESCE(protocol_version, 1)
    WHERE created_at IS NULL OR lifecycle_state IS NULL`).run();

    const open = db.prepare(`SELECT id,lifecycle_state,status,hold_reason,
      active_command_id,active_hold_id FROM mission
      WHERE lifecycle_state IN (${ACTIVE_MISSION_STATES.map(() => "?").join(",")})
      ORDER BY id DESC`).all(...ACTIVE_MISSION_STATES);
    if (open.length > 1) {
      const now = Date.now();
      const close = db.prepare(`UPDATE mission SET lifecycle_state='cancelled', status='stopped',
        hold_reason='migration_superseded',active_command_id=NULL,active_hold_id=NULL,
        ended_at=COALESCE(ended_at, ?), updated_at=? WHERE id=?`);
      const selectPendingCommands = db.prepare(`SELECT id,command_seq,action FROM mission_command
        WHERE mission_id=? AND state='pending' ORDER BY command_seq,id`);
      const retirePendingCommand = db.prepare(`UPDATE mission_command SET state='superseded',
        acknowledged_at=?,reject_reason='migration_superseded' WHERE id=? AND state='pending'`);
      const auditClose = db.prepare(`INSERT INTO mission_event
        (mission_id,event_type,t,before_json,after_json,detail_json)
        VALUES (?,?,?,?,?,?)`);
      const auditCommand = db.prepare(`INSERT INTO mission_event
        (mission_id,event_type,t,command_id,before_json,after_json,detail_json)
        VALUES (?,?,?,?,?,?,?)`);
      for (const row of open.slice(1)) {
        const pendingCommands = selectPendingCommands.all(row.id);
        for (const command of pendingCommands) {
          retirePendingCommand.run(now, command.id);
          auditCommand.run(
            row.id, "command.superseded", now, command.id,
            JSON.stringify({ state: "pending", command_seq: command.command_seq, action: command.action }),
            JSON.stringify({ state: "superseded" }),
            JSON.stringify({ reason: "migration_superseded", kept_mission_id: open[0].id }),
          );
        }
        close.run(now, now, row.id);
        auditClose.run(
          row.id, "mission.migration_superseded", now,
          JSON.stringify({
            state: row.lifecycle_state, status: row.status, hold_reason: row.hold_reason,
            active_command_id: row.active_command_id, active_hold_id: row.active_hold_id,
          }),
          JSON.stringify({
            state: "cancelled", status: "stopped", hold_reason: "migration_superseded",
            active_command_id: null, active_hold_id: null,
          }),
          JSON.stringify({
            kept_mission_id: open[0].id,
            retired_pending_command_ids: pendingCommands.map((command) => command.id),
          }),
        );
      }
      changed.push({
        operation: "close_superseded_open_missions",
        kept_mission_id: open[0].id,
        closed_mission_ids: open.slice(1).map((row) => row.id),
      });
    }

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_one_active
      ON mission((1)) WHERE lifecycle_state IN
      ('ready','starting','running','pausing','paused','interrupted','resuming')`);

    const legacyMissions = db.prepare(`SELECT id, started_at, ended_at, status,
      waypoints_json, current_waypoint_idx, spray_results_json
      FROM mission WHERE NOT EXISTS (
        SELECT 1 FROM mission_waypoint w WHERE w.mission_id = mission.id
      ) ORDER BY id`).all();
    const insertWaypoint = db.prepare(`INSERT INTO mission_waypoint
      (id, mission_id, position, lat, lng, alt, state, outcome, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const mission of legacyMissions) {
      let waypoints = [];
      let sprays = {};
      try { waypoints = JSON.parse(mission.waypoints_json || "[]"); } catch { waypoints = []; }
      try { sprays = JSON.parse(mission.spray_results_json || "{}"); } catch { sprays = {}; }
      if (!Array.isArray(waypoints)) continue;
      const reached = Math.max(0, Number(mission.current_waypoint_idx) || 0);
      for (let i = 0; i < waypoints.length; i += 1) {
        const wp = waypoints[i];
        if (!wp || !Number.isFinite(wp.lat) || !Number.isFinite(wp.lng)) continue;
        const outcome = typeof sprays[i] === "string" ? sprays[i] : null;
        const completed = mission.status === "completed" || i < reached;
        insertWaypoint.run(
          `legacy-${mission.id}-${i}`, mission.id, i, wp.lat, wp.lng,
          Number.isFinite(wp.alt) ? wp.alt : null,
          completed ? "completed" : "pending", outcome,
          completed ? (mission.ended_at || mission.started_at) : null,
          mission.started_at, mission.ended_at || mission.started_at,
        );
      }
      if (waypoints.length > 0) changed.push(`backfilled mission ${mission.id}`);
    }

    // An open v1 row must not be exposed through the v2 active-mission API with
    // a NULL plan hash.  That hybrid cannot use the legacy endpoints (an active
    // v2-visible mission disables them), while the v2 navigator rejects its
    // malformed command envelope.  Promote resumable legacy plans completely;
    // fail closed by cancelling an empty/invalid open plan instead of publishing
    // an active mission that no rover can execute.
    const openLegacy = db.prepare(`SELECT id FROM mission
      WHERE protocol_version=1 AND lifecycle_state IN
      ('ready','starting','running','pausing','paused','interrupted','resuming')
      ORDER BY id`).all();
    const selectLegacyPlan = db.prepare(`SELECT * FROM mission_waypoint
      WHERE mission_id=? AND state <> 'skipped' ORDER BY position,created_at,id`);
    const promoteLegacy = db.prepare(`UPDATE mission SET protocol_version=?,plan_hash=?,
      lifecycle_state='interrupted',status='interrupted',hold_reason='legacy_migrated',
      active_command_id=NULL,updated_at=? WHERE id=?`);
    const cancelLegacy = db.prepare(`UPDATE mission SET lifecycle_state='cancelled',status='stopped',
      hold_reason='legacy_migration_empty_plan',active_command_id=NULL,
      ended_at=COALESCE(ended_at,?),updated_at=? WHERE id=?`);
    const insertMigrationEvent = db.prepare(`INSERT INTO mission_event
      (mission_id,event_type,t,before_json,after_json,detail_json)
      VALUES (?,?,?,?,?,?)`);
    for (const mission of openLegacy) {
      const planRows = selectLegacyPlan.all(mission.id);
      const pendingCount = planRows.filter((row) => row.state === "pending" || row.state === "active").length;
      const now = Date.now();
      if (pendingCount === 0) {
        cancelLegacy.run(now, now, mission.id);
        insertMigrationEvent.run(
          mission.id, "mission.legacy_cancelled", now,
          JSON.stringify({ protocol_version: 1, state: "interrupted" }),
          JSON.stringify({ protocol_version: 1, state: "cancelled" }),
          JSON.stringify({ reason: "empty_remaining_plan" }),
        );
        changed.push(`cancelled empty open legacy mission ${mission.id}`);
        continue;
      }
      const planHash = missionPlanHash("return_to_start", planRows);
      promoteLegacy.run(MISSION_PROTOCOL_VERSION, planHash, now, mission.id);
      insertMigrationEvent.run(
        mission.id, "mission.legacy_promoted", now,
        JSON.stringify({ protocol_version: 1, plan_hash: null }),
        JSON.stringify({ protocol_version: MISSION_PROTOCOL_VERSION, plan_hash: planHash, state: "interrupted" }),
        JSON.stringify({ pending_count: pendingCount }),
      );
      changed.push(`promoted open legacy mission ${mission.id}`);
    }
  })();

  const fkProblems = db.prepare("PRAGMA foreign_key_check").all();
  if (fkProblems.length > 0) {
    throw new Error(`mission v2 schema foreign_key_check failed: ${JSON.stringify(fkProblems.slice(0, 5))}`);
  }
  if (changed.length > 0 && logger) {
    logger.log(null, "mission.v2.migrate", { changes: changed }, "rover",
      { email: "system", name: "migration", role: "admin" });
  }
}

function canonicalPlan(finishBehavior, waypoints) {
  return JSON.stringify({
    finish_behavior: finishBehavior,
    waypoints: waypoints.map((w) => ({
      id: w.id,
      cone_id: w.cone_id_snapshot ?? w.cone_id ?? null,
      lat: Number(w.lat),
      lng: Number(w.lng),
      alt: Number.isFinite(w.alt) ? Number(w.alt) : null,
      side: w.side || null,
    })),
  });
}

function missionPlanHash(finishBehavior, waypoints) {
  return crypto.createHash("sha256").update(canonicalPlan(finishBehavior, waypoints)).digest("hex");
}
