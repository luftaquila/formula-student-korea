import crypto from "crypto";

export const MISSION_PROTOCOL_VERSION = 2;
export const MISSION_MAX_OCCURRENCES = 1000;
export const MISSION_MAX_PRESETS_PER_COURSE = 20;
export const ACTIVE_MISSION_STATES = [
  "ready", "starting", "running", "pausing", "paused", "interrupted", "resuming",
];

const TERMINAL_MISSION_STATES = new Set(["completed", "cancelled"]);
const COMMAND_ACTIONS = new Set(["start", "pause", "resume", "end"]);
const FINISH_BEHAVIORS = new Set(["stop", "return_to_start"]);
const ROVER_CONFIRMED_HOLD_PREFIX = "rover_confirmed:";
const NETWORK_RECONCILE_REASONS = new Set([
  "sse_disconnect", "telemetry_stale", "command_delivery_failed",
]);
const REPORT_EVENTS = new Set([
  "command", "state", "waypoint_active", "waypoint_completed",
  "waypoint_failed", "held", "interrupted", "mission_completed",
]);
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(db, table, column, sql) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sql}`);
}

function legacyStatus(lifecycleState) {
  if (lifecycleState === "running") return "running";
  if (lifecycleState === "interrupted") return "interrupted";
  if (["ready", "starting", "pausing", "paused", "resuming"].includes(lifecycleState)) return "paused";
  if (lifecycleState === "completed") return "completed";
  return "stopped";
}

function legacyLifecycle(status) {
  if (status === "running") return "interrupted";
  if (status === "paused" || status === "interrupted") return "interrupted";
  if (status === "completed") return "completed";
  return "cancelled";
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
      last_seen_at INTEGER NOT NULL
    )`);
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

export function missionPlanHash(finishBehavior, waypoints) {
  return crypto.createHash("sha256").update(canonicalPlan(finishBehavior, waypoints)).digest("hex");
}

function opaqueRevision(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function occurrenceRevision(mission, waypoints) {
  return opaqueRevision({
    plan_hash: mission.plan_hash,
    lifecycle_state: mission.lifecycle_state,
    hold_reason: mission.hold_reason,
    active_command_id: mission.active_command_id,
    active_hold_id: mission.active_hold_id,
    empty_plan_mode: mission.empty_plan_mode,
    waypoints: waypoints.map((waypoint) => ({
      id: waypoint.id,
      position: waypoint.position,
      state: waypoint.state,
      outcome: waypoint.outcome,
      skipped_at: waypoint.skipped_at,
      skip_reason: waypoint.skip_reason,
    })),
  });
}

function presetRevision(preset, items) {
  return opaqueRevision({
    id: preset.id,
    course_id: preset.course_id,
    name: preset.name,
    finish_behavior: preset.finish_behavior,
    items: items.map((item) => ({
      id: item.id,
      position: item.position,
      cone_id: item.cone_id,
      cone_id_snapshot: item.cone_id_snapshot,
      lat_snapshot: item.lat_snapshot,
      lng_snapshot: item.lng_snapshot,
      alt_snapshot: item.alt_snapshot,
      side_snapshot: item.side_snapshot,
    })),
  });
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function actorLabel(req) {
  return req?.user ? `${req.user.name || ""} <${req.user.email || ""}>` : null;
}

function publicWaypoint(row) {
  return {
    id: row.id,
    position: row.position,
    cone_id: row.cone_id,
    cone_id_snapshot: row.cone_id_snapshot,
    lat: row.lat,
    lng: row.lng,
    alt: row.alt,
    side: row.side,
    state: row.state,
    outcome: row.outcome,
    attempt_count: row.attempt_count,
    completed_at: row.completed_at,
    skipped_at: row.skipped_at,
    skip_reason: row.skip_reason,
  };
}

export function createMissionV2Store(db) {
  let activeSummaryHydrated = false;
  let activeSummaryCache = null;
  const insertEvent = db.prepare(`INSERT INTO mission_event
    (mission_id, event_type, t, waypoint_id, command_id, rover_boot_id, actor,
     before_json, after_json, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function recordEvent(missionId, eventType, {
    waypointId = null, commandId = null, roverBootId = null, actor = null,
    before = null, after = null, detail = null, t = Date.now(),
  } = {}) {
    insertEvent.run(
      missionId, eventType, t, waypointId, commandId, roverBootId, actor,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      detail == null ? null : JSON.stringify(detail),
    );
  }

  function waypointRows(missionId, { includeSkipped = true } = {}) {
    return db.prepare(`SELECT * FROM mission_waypoint WHERE mission_id=?
      ${includeSkipped ? "" : "AND state <> 'skipped'"}
      ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END, position, created_at, id`).all(missionId);
  }

  function pendingWaypoints(missionId) {
    return db.prepare(`SELECT * FROM mission_waypoint
      WHERE mission_id=? AND state IN ('pending','active') ORDER BY position, created_at, id`).all(missionId);
  }

  function missionRow(id) {
    return db.prepare(`SELECT m.*, c.name AS course_name, p.name AS preset_name
      FROM mission m
      LEFT JOIN course c ON c.id=m.course_id
      LEFT JOIN mission_route_preset p ON p.id=m.preset_id
      WHERE m.id=?`).get(id);
  }

  function motionConfirmedHeld(missionOrId) {
    const row = typeof missionOrId === "object" && missionOrId != null
      ? missionOrId : missionRow(missionOrId);
    if (!row) return false;
    if (row.active_hold_id) return false;
    const state = row.lifecycle_state || row.status;
    if (state === "ready" || state === "paused") return true;
    return state === "interrupted"
      && typeof row.hold_reason === "string"
      && row.hold_reason.startsWith(ROVER_CONFIRMED_HOLD_PREFIX);
  }

  function publicHoldReason(reason) {
    return typeof reason === "string" && reason.startsWith(ROVER_CONFIRMED_HOLD_PREFIX)
      ? reason.slice(ROVER_CONFIRMED_HOLD_PREFIX.length) : reason;
  }

  function missionPublic(id, { events = false } = {}) {
    const row = missionRow(id);
    if (!row) return null;
    const waypoints = waypointRows(id);
    const result = {
      id: row.id,
      course_id: row.course_id,
      course_name: row.course_name,
      preset_id: row.preset_id,
      preset_name: row.preset_name,
      created_at: row.created_at || row.started_at,
      started_at: row.activated_at || row.started_at,
      ended_at: row.ended_at,
      status: row.lifecycle_state || legacyLifecycle(row.status),
      hold_reason: publicHoldReason(row.hold_reason),
      motion_confirmed_held: motionConfirmedHeld(row),
      finish_behavior: row.finish_behavior || "return_to_start",
      plan_hash: row.plan_hash,
      start_position: row.start_lat == null ? null : {
        lat: row.start_lat, lng: row.start_lng, alt: row.start_alt,
      },
      actor: row.actor,
      protocol_version: row.protocol_version,
      active_command_id: row.active_command_id,
      active_hold_id: row.active_hold_id,
      empty_plan_mode: row.empty_plan_mode,
      occurrence_revision: occurrenceRevision(row, waypoints),
      waypoints: waypoints.map(publicWaypoint),
    };
    if (ACTIVE_MISSION_STATES.includes(result.status)) {
      activeSummaryHydrated = true;
      activeSummaryCache = missionSummary(result);
    } else if (activeSummaryCache?.id === result.id) {
      activeSummaryHydrated = true;
      activeSummaryCache = null;
    }
    if (events) {
      result.events = db.prepare(`SELECT * FROM mission_event WHERE mission_id=? ORDER BY t,id`).all(id)
        .map((event) => ({
          ...event,
          before: parseJson(event.before_json, null),
          after: parseJson(event.after_json, null),
          detail: parseJson(event.detail_json, null),
          before_json: undefined,
          after_json: undefined,
          detail_json: undefined,
        }));
    }
    return result;
  }

  function activeMission() {
    const row = db.prepare(`SELECT id FROM mission WHERE lifecycle_state IN
      ('ready','starting','running','pausing','paused','interrupted','resuming')
      ORDER BY id DESC LIMIT 1`).get();
    if (row) return missionPublic(row.id);
    activeSummaryHydrated = true;
    activeSummaryCache = null;
    return null;
  }

  function missionSummary(mission) {
    if (!mission) return null;
    return {
      id: mission.id,
      status: mission.status,
      motion_confirmed_held: mission.motion_confirmed_held,
      course_id: mission.course_id,
      course_name: mission.course_name,
      plan_hash: mission.plan_hash,
      occurrence_revision: mission.occurrence_revision,
      active_command_id: mission.active_command_id,
      active_hold_id: mission.active_hold_id,
      hold_reason: mission.hold_reason,
      finish_behavior: mission.finish_behavior,
      empty_plan_mode: mission.empty_plan_mode,
      protocol_version: mission.protocol_version,
    };
  }

  function activeMissionSummary() {
    if (!activeSummaryHydrated) activeMission();
    return activeSummaryCache == null ? null : { ...activeSummaryCache };
  }

  function resolveConeItems(courseId, items, { requireSnapshots = false } = {}) {
    if (!Array.isArray(items) || items.length === 0 || items.length > MISSION_MAX_OCCURRENCES) {
      throw Object.assign(new Error(`콘 경로는 1개 이상 ${MISSION_MAX_OCCURRENCES.toLocaleString()}개 이하여야 합니다.`), { status: 400 });
    }
    const course = db.prepare("SELECT id FROM course WHERE id=?").get(courseId);
    if (!course) throw Object.assign(new Error("코스를 찾을 수 없습니다."), { status: 404 });
    const cones = new Map(db.prepare("SELECT * FROM cone WHERE course_id=?").all(courseId).map((c) => [c.id, c]));
    return items.map((item, position) => {
      const coneId = Number(item?.cone_id ?? item);
      const cone = cones.get(coneId);
      if (!Number.isInteger(coneId) || !cone) {
        throw Object.assign(new Error(`${position + 1}번 항목의 콘이 현재 코스에 없습니다.`), {
          status: 409, reason: "missing_cone", position, cone_id: coneId,
        });
      }
      if (requireSnapshots) {
        const hasSnapshot = item && typeof item === "object" && !Array.isArray(item)
          && Object.hasOwn(item, "lat") && Object.hasOwn(item, "lng")
          && Object.hasOwn(item, "alt") && Object.hasOwn(item, "side");
        const expectedAlt = item?.alt == null ? null : Number(item.alt);
        const currentAlt = cone.alt == null ? null : Number(cone.alt);
        const snapshotMatches = hasSnapshot
          && Number.isFinite(item.lat) && Number(item.lat) === Number(cone.lat)
          && Number.isFinite(item.lng) && Number(item.lng) === Number(cone.lng)
          && (expectedAlt == null || Number.isFinite(expectedAlt))
          && expectedAlt === currentAlt
          && item.side === cone.side;
        if (!snapshotMatches) {
          throw Object.assign(new Error(`${position + 1}번 콘이 사전 점검 이후 변경되었습니다. 최신 경로를 다시 확인하세요.`), {
            status: 409,
            reason: "cone_snapshot_mismatch",
            position,
            cone_id: coneId,
            current_cone: {
              cone_id: cone.id,
              lat: cone.lat,
              lng: cone.lng,
              alt: cone.alt,
              side: cone.side,
            },
          });
        }
      }
      return cone;
    });
  }

  function listPresets(courseId) {
    const presets = db.prepare(`SELECT * FROM mission_route_preset WHERE course_id=? ORDER BY name,id`).all(courseId);
    const selectItems = db.prepare(`SELECT i.*, c.lat AS live_lat, c.lng AS live_lng,
      c.alt AS live_alt, c.side AS live_side, c.course_id AS live_course_id
      FROM mission_route_preset_item i LEFT JOIN cone c ON c.id=i.cone_id
      WHERE i.preset_id=? ORDER BY i.position`);
    return presets.map((preset) => {
      let stale = false;
      const storedItems = selectItems.all(preset.id);
      const items = storedItems.map((item) => {
        const isStale = item.cone_id == null || item.live_course_id !== preset.course_id;
        if (isStale) stale = true;
        return {
          id: item.id,
          position: item.position,
          cone_id: item.cone_id,
          cone_id_snapshot: item.cone_id_snapshot,
          lat: isStale ? item.lat_snapshot : item.live_lat,
          lng: isStale ? item.lng_snapshot : item.live_lng,
          alt: isStale ? item.alt_snapshot : item.live_alt,
          side: isStale ? item.side_snapshot : item.live_side,
          stale: isStale,
        };
      });
      return {
        ...preset,
        preset_revision: presetRevision(preset, storedItems),
        stale,
        items,
      };
    });
  }

  function savePreset({
    id = null, courseId, name, finishBehavior = "stop", items,
    expectedPresetRevision = null, actor = null,
  }) {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!trimmedName || trimmedName.length > 100) {
      throw Object.assign(new Error("프리셋 이름은 1~100자여야 합니다."), { status: 400 });
    }
    if (!FINISH_BEHAVIORS.has(finishBehavior)) {
      throw Object.assign(new Error("올바르지 않은 종료 동작입니다."), { status: 400 });
    }
    const cones = resolveConeItems(courseId, items);
    const conflictingName = db.prepare(`SELECT id FROM mission_route_preset
      WHERE course_id=? AND name=? COLLATE NOCASE`).get(courseId, trimmedName);
    if (conflictingName && conflictingName.id !== id) {
      throw Object.assign(new Error("같은 이름의 미션 프리셋이 이미 있습니다."), { status: 409, reason: "duplicate_preset_name" });
    }
    const now = Date.now();
    return db.transaction(() => {
      let presetId = id;
      let before = null;
      if (id != null) {
        const existing = db.prepare("SELECT * FROM mission_route_preset WHERE id=?").get(id);
        if (!existing) throw Object.assign(new Error("프리셋을 찾을 수 없습니다."), { status: 404 });
        if (existing.course_id !== courseId) {
          throw Object.assign(new Error("프리셋의 코스는 변경할 수 없습니다."), { status: 409 });
        }
        before = listPresets(courseId).find((p) => p.id === id) || existing;
        if (typeof expectedPresetRevision !== "string"
            || expectedPresetRevision !== before.preset_revision) {
          throw Object.assign(new Error("다른 운영자가 프리셋을 변경했습니다. 최신 프리셋을 다시 불러오세요."), {
            status: 409,
            reason: "preset_revision_mismatch",
            current_preset_revision: before.preset_revision,
          });
        }
        db.prepare(`UPDATE mission_route_preset SET name=?,finish_behavior=?,updated_at=?,actor=? WHERE id=?`)
          .run(trimmedName, finishBehavior, now, actor, id);
        db.prepare("DELETE FROM mission_route_preset_item WHERE preset_id=?").run(id);
      } else {
        const presetCount = db.prepare("SELECT COUNT(*) AS count FROM mission_route_preset WHERE course_id=?")
          .get(courseId).count;
        if (presetCount >= MISSION_MAX_PRESETS_PER_COURSE) {
          throw Object.assign(new Error(`코스별 미션 프리셋은 ${MISSION_MAX_PRESETS_PER_COURSE}개까지 저장할 수 있습니다.`), {
            status: 409,
            reason: "preset_limit",
          });
        }
        const result = db.prepare(`INSERT INTO mission_route_preset
          (course_id,name,finish_behavior,created_at,updated_at,actor) VALUES (?,?,?,?,?,?)`)
          .run(courseId, trimmedName, finishBehavior, now, now, actor);
        presetId = Number(result.lastInsertRowid);
      }
      const insert = db.prepare(`INSERT INTO mission_route_preset_item
        (id,preset_id,position,cone_id,cone_id_snapshot,lat_snapshot,lng_snapshot,alt_snapshot,side_snapshot)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      cones.forEach((cone, position) => insert.run(
        crypto.randomUUID(), presetId, position, cone.id, cone.id,
        cone.lat, cone.lng, cone.alt, cone.side,
      ));
      const after = listPresets(courseId).find((p) => p.id === presetId);
      return { before, after };
    })();
  }

  function deletePreset(id, expectedPresetRevision) {
    const preset = db.prepare("SELECT * FROM mission_route_preset WHERE id=?").get(id);
    if (!preset) throw Object.assign(new Error("프리셋을 찾을 수 없습니다."), { status: 404 });
    const before = listPresets(preset.course_id).find((p) => p.id === id);
    if (typeof expectedPresetRevision !== "string"
        || expectedPresetRevision !== before?.preset_revision) {
      throw Object.assign(new Error("다른 운영자가 프리셋을 변경했습니다. 최신 프리셋을 다시 불러오세요."), {
        status: 409,
        reason: "preset_revision_mismatch",
        current_preset_revision: before?.preset_revision || null,
      });
    }
    return db.transaction(() => {
      db.prepare("DELETE FROM mission_route_preset WHERE id=?").run(id);
      return before;
    })();
  }

  function createMission({ courseId, presetId = null, finishBehavior = "stop", items, actor = null }) {
    if (!FINISH_BEHAVIORS.has(finishBehavior)) {
      throw Object.assign(new Error("올바르지 않은 종료 동작입니다."), { status: 400 });
    }
    if (activeMission()) {
      throw Object.assign(new Error("종료되지 않은 미션이 이미 있습니다."), { status: 409, reason: "active_mission" });
    }
    const cones = resolveConeItems(courseId, items, { requireSnapshots: true });
    if (presetId != null) {
      const preset = db.prepare("SELECT * FROM mission_route_preset WHERE id=? AND course_id=?").get(presetId, courseId);
      if (!preset) throw Object.assign(new Error("해당 코스의 프리셋을 찾을 수 없습니다."), { status: 404 });
    }
    const now = Date.now();
    const waypoints = cones.map((cone, position) => ({
      id: crypto.randomUUID(), position, cone_id: cone.id, cone_id_snapshot: cone.id,
      lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side,
    }));
    const planHash = missionPlanHash(finishBehavior, waypoints);
    const missionId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO mission
        (course_id,preset_id,started_at,status,waypoints_json,current_waypoint_idx,
         spray_results_json,updated_at,actor,created_at,lifecycle_state,finish_behavior,
         plan_hash,protocol_version)
        VALUES (?,?,?,'paused',?,0,'{}',?,?,?,?,?,?,?)`)
        .run(
          courseId, presetId, now,
          JSON.stringify(waypoints.map(({ lat, lng, alt }) => ({ lat, lng, alt }))),
          now, actor, now, "ready", finishBehavior, planHash, MISSION_PROTOCOL_VERSION,
        );
      const id = Number(result.lastInsertRowid);
      const insert = db.prepare(`INSERT INTO mission_waypoint
        (id,mission_id,position,cone_id,cone_id_snapshot,lat,lng,alt,side,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`);
      for (const wp of waypoints) insert.run(
        wp.id, id, wp.position, wp.cone_id, wp.cone_id_snapshot,
        wp.lat, wp.lng, wp.alt, wp.side, now, now,
      );
      recordEvent(id, "mission.created", { actor, after: { course_id: courseId, preset_id: presetId, finish_behavior: finishBehavior, plan_hash: planHash, waypoint_count: waypoints.length } });
      return id;
    })();
    return missionPublic(missionId);
  }

  function editRemaining({
    missionId, expectedPlanHash, expectedOccurrenceRevision,
    finishBehavior, items, actor = null,
  }) {
    const mission = missionRow(missionId);
    if (!mission) throw Object.assign(new Error("미션을 찾을 수 없습니다."), { status: 404 });
    if (!motionConfirmedHeld(mission)) {
      throw Object.assign(new Error("로버가 정지 상태를 확인한 미션에서만 남은 경로를 편집할 수 있습니다."), {
        status: 409, reason: "motion_not_confirmed_held",
      });
    }
    if (mission.active_command_id) {
      throw Object.assign(new Error("처리 중인 로버 명령이 있습니다."), { status: 409 });
    }
    const before = missionPublic(missionId);
    if (typeof expectedOccurrenceRevision !== "string"
        || expectedOccurrenceRevision !== before.occurrence_revision) {
      throw Object.assign(new Error("미션 진행 상태가 변경되었습니다. 최신 미션을 다시 불러오세요."), {
        status: 409,
        reason: "occurrence_revision_mismatch",
        current_occurrence_revision: before.occurrence_revision,
      });
    }
    if (expectedPlanHash !== mission.plan_hash) {
      throw Object.assign(new Error("다른 운영자가 경로를 변경했습니다. 최신 미션을 다시 불러오세요."), {
        status: 409, reason: "plan_hash_mismatch", current_plan_hash: mission.plan_hash,
      });
    }
    const nextFinish = finishBehavior ?? mission.finish_behavior;
    if (!FINISH_BEHAVIORS.has(nextFinish)) {
      throw Object.assign(new Error("올바르지 않은 종료 동작입니다."), { status: 400 });
    }
    if (!Array.isArray(items) || items.length > MISSION_MAX_OCCURRENCES) {
      throw Object.assign(new Error("남은 경로 형식이 올바르지 않습니다."), { status: 400 });
    }
    const currentPending = pendingWaypoints(missionId);
    const pendingById = new Map(currentPending.map((w) => [w.id, w]));
    const used = new Set();
    const newConeItems = items.filter((item) => !item?.waypoint_id);
    const newCones = newConeItems.length > 0 ? resolveConeItems(mission.course_id, newConeItems) : [];
    let newConeIndex = 0;
    const nextPending = items.map((item, position) => {
      if (item?.waypoint_id) {
        const existing = pendingById.get(item.waypoint_id);
        if (!existing || used.has(existing.id)) {
          throw Object.assign(new Error(`${position + 1}번 남은 웨이포인트가 유효하지 않습니다.`), { status: 409 });
        }
        used.add(existing.id);
        return existing;
      }
      const cone = newCones[newConeIndex++];
      return {
        id: crypto.randomUUID(), mission_id: missionId, cone_id: cone.id,
        cone_id_snapshot: cone.id, lat: cone.lat, lng: cone.lng, alt: cone.alt,
        side: cone.side, state: "pending", attempt_count: 0,
      };
    });
    const completedCount = before.waypoints.filter((waypoint) => waypoint.state === "completed").length;
    if (completedCount + nextPending.length > MISSION_MAX_OCCURRENCES) {
      throw Object.assign(new Error(`완료 항목과 남은 경로를 합쳐 ${MISSION_MAX_OCCURRENCES.toLocaleString()}개를 넘을 수 없습니다.`), {
        status: 409,
        reason: "mission_occurrence_limit",
      });
    }
    let emptyPlanMode = null;
    if (nextPending.length === 0) {
      const removedOnlyUncertain = currentPending.length > 0
        && currentPending.every((row) =>
          row.outcome === "dispense_outcome_uncertain" && !used.has(row.id));
      if (nextFinish === "return_to_start") {
        if (!Number.isFinite(mission.start_lat) || !Number.isFinite(mission.start_lng)) {
          throw Object.assign(new Error("영구 저장된 미션 시작점이 없어 복귀 전용 경로로 변경할 수 없습니다."), {
            status: 409, reason: "return_start_unavailable",
          });
        }
        emptyPlanMode = "return_only";
      }
      else if (removedOnlyUncertain) emptyPlanMode = "uncertainty_resolved";
      else {
        throw Object.assign(new Error("일반 일시정지 미션의 남은 경로는 비워 둘 수 없습니다."), {
          status: 409, reason: "empty_remaining_plan",
        });
      }
    }
    const now = Date.now();
    return db.transaction(() => {
      db.prepare(`UPDATE mission_waypoint SET position=position+1000000
        WHERE mission_id=? AND state IN ('pending','active') AND position IS NOT NULL`).run(missionId);
      const skip = db.prepare(`UPDATE mission_waypoint SET state='skipped',position=NULL,
        skipped_at=?,skip_reason='operator_removed',updated_at=? WHERE id=? AND mission_id=?`);
      for (const row of currentPending) {
        if (!used.has(row.id)) {
          skip.run(now, now, row.id, missionId);
          recordEvent(missionId, "waypoint.skipped", { waypointId: row.id, actor, before: publicWaypoint(row), after: { state: "skipped", skip_reason: "operator_removed" } });
        }
      }
      const completedMax = db.prepare(`SELECT COALESCE(MAX(position),-1) AS p FROM mission_waypoint
        WHERE mission_id=? AND state='completed'`).get(missionId).p;
      const update = db.prepare(`UPDATE mission_waypoint SET position=?,state='pending',updated_at=? WHERE id=? AND mission_id=?`);
      const insert = db.prepare(`INSERT INTO mission_waypoint
        (id,mission_id,position,cone_id,cone_id_snapshot,lat,lng,alt,side,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`);
      nextPending.forEach((row, index) => {
        const position = completedMax + 1 + index;
        if (pendingById.has(row.id)) update.run(position, now, row.id, missionId);
        else insert.run(row.id, missionId, position, row.cone_id, row.cone_id_snapshot, row.lat, row.lng, row.alt, row.side, now, now);
      });
      const planRows = db.prepare(`SELECT * FROM mission_waypoint WHERE mission_id=? AND state <> 'skipped'
        ORDER BY position,created_at,id`).all(missionId);
      const planHash = missionPlanHash(nextFinish, planRows);
      const nextHoldReason = mission.lifecycle_state === "interrupted"
        ? `${ROVER_CONFIRMED_HOLD_PREFIX}route_edited` : "route_edited";
      db.prepare(`UPDATE mission SET finish_behavior=?,plan_hash=?,updated_at=?,hold_reason=?,empty_plan_mode=? WHERE id=?`)
        .run(nextFinish, planHash, now, nextHoldReason, emptyPlanMode, missionId);
      const after = missionPublic(missionId);
      recordEvent(missionId, "mission.remaining_edited", {
        actor,
        before: { plan_hash: before.plan_hash, pending: before.waypoints.filter((w) => w.state === "pending").map((w) => w.id), finish_behavior: before.finish_behavior },
        after: {
          plan_hash: planHash,
          occurrence_revision: after.occurrence_revision,
          pending: after.waypoints.filter((w) => w.state === "pending").map((w) => w.id),
          finish_behavior: nextFinish,
          empty_plan_mode: emptyPlanMode,
        },
      });
      return after;
    })();
  }

  function issueCommand({
    missionId, action, expectedPlanHash = null, expectedOccurrenceRevision = null, actor = null,
    force = false, targetBootId = null,
  }) {
    if (!COMMAND_ACTIONS.has(action)) throw Object.assign(new Error("올바르지 않은 미션 명령입니다."), { status: 400 });
    const mission = missionRow(missionId);
    if (!mission) throw Object.assign(new Error("미션을 찾을 수 없습니다."), { status: 404 });
    if ((action === "start" || action === "resume")
        && (typeof expectedPlanHash !== "string" || expectedPlanHash !== mission.plan_hash)) {
      throw Object.assign(new Error("미션 경로가 변경되었습니다. 최신 미션으로 다시 시도하세요."), {
        status: 409,
        reason: "plan_hash_mismatch",
        current_plan_hash: mission.plan_hash,
      });
    }
    let pendingToSupersede = null;
    if (mission.active_command_id) {
      const pending = db.prepare("SELECT * FROM mission_command WHERE id=?").get(mission.active_command_id);
      if (pending?.state === "pending") {
        if (pending.action === action) {
          const pendingPayload = parseJson(pending.payload_json, {});
          const replayRevisionMatches = !["start", "resume"].includes(action)
            || pendingPayload.expected_occurrence_revision === expectedOccurrenceRevision;
          if (replayRevisionMatches) {
            return { command: pending, mission: missionPublic(missionId), replay: true };
          }
          throw Object.assign(new Error("미션 진행 상태가 변경되었습니다. 최신 미션을 다시 불러오세요."), {
            status: 409,
            reason: "occurrence_revision_mismatch",
            current_occurrence_revision: missionPublic(missionId).occurrence_revision,
          });
        }
        if (action !== "end") {
          throw Object.assign(new Error(`${pending.action} 명령이 처리 중입니다.`), {
            status: 409, reason: "command_in_progress", pending_action: pending.action,
          });
        }
        pendingToSupersede = pending;
      }
    }
    if ((action === "start" || action === "resume")) {
      const currentOccurrenceRevision = missionPublic(missionId).occurrence_revision;
      if (typeof expectedOccurrenceRevision !== "string"
          || expectedOccurrenceRevision !== currentOccurrenceRevision) {
        throw Object.assign(new Error("미션 진행 상태가 변경되었습니다. 최신 미션을 다시 불러오세요."), {
          status: 409,
          reason: "occurrence_revision_mismatch",
          current_occurrence_revision: currentOccurrenceRevision,
        });
      }
    }
    if (mission.active_hold_id && action !== "end") {
      throw Object.assign(new Error("재부팅 안전 정지가 아직 로버에서 확인되지 않았습니다."), {
        status: 409, reason: "safety_hold_pending",
      });
    }
    if (TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) {
      throw Object.assign(new Error("이미 종료된 미션입니다."), { status: 409 });
    }
    if (action === "resume" && !motionConfirmedHeld(mission)) {
      throw Object.assign(new Error("로버의 정지가 확인된 미션만 재개할 수 없습니다."), {
        status: 409, reason: "motion_not_confirmed_held",
      });
    }
    const allowed = action === "start" ? mission.lifecycle_state === "ready"
      : action === "resume" ? ["paused", "interrupted"].includes(mission.lifecycle_state)
        : action === "pause" ? mission.lifecycle_state === "running"
          : true;
    if (!allowed) throw Object.assign(new Error(`현재 미션 상태(${mission.lifecycle_state})에서 ${action}할 수 없습니다.`), { status: 409 });
    const pending = pendingWaypoints(missionId).map(publicWaypoint);
    if ((action === "start" || action === "resume") && pending.length === 0
        && !["return_only", "uncertainty_resolved"].includes(mission.empty_plan_mode)) {
      throw Object.assign(new Error("실행할 남은 웨이포인트가 없습니다."), { status: 409 });
    }
    if ((action === "start" || action === "resume")
        && pending.length === 0 && mission.empty_plan_mode === "return_only"
        && (!Number.isFinite(mission.start_lat) || !Number.isFinite(mission.start_lng))) {
      throw Object.assign(new Error("영구 저장된 미션 시작점이 없어 복귀 전용 경로를 실행할 수 없습니다."), {
        status: 409, reason: "return_start_unavailable",
      });
    }
    const now = Date.now();
    return db.transaction(() => {
      if (pendingToSupersede) {
        db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,
          reject_reason='operator_end' WHERE id=? AND state='pending'`)
          .run(now, pendingToSupersede.id);
        recordEvent(missionId, "command.superseded", {
          commandId: pendingToSupersede.id, actor,
          before: { state: "pending", action: pendingToSupersede.action },
          after: { state: "superseded" }, detail: { reason: "operator_end" },
        });
      }
      const seq = db.prepare("SELECT COALESCE(MAX(command_seq),0)+1 AS seq FROM mission_command WHERE mission_id=?").get(missionId).seq;
      const commandId = crypto.randomUUID();
      const nextState = action === "start" ? "starting"
        : action === "resume" ? "resuming"
          : action === "pause" ? "pausing" : mission.lifecycle_state;
      const payload = {
        protocol_version: MISSION_PROTOCOL_VERSION,
        command_id: commandId,
        command_seq: seq,
        mission_id: missionId,
        action,
        plan_hash: mission.plan_hash,
        expected_occurrence_revision: (action === "start" || action === "resume")
          ? expectedOccurrenceRevision : null,
        finish_behavior: mission.finish_behavior,
        mission_start: mission.start_lat == null ? null : { lat: mission.start_lat, lng: mission.start_lng, alt: mission.start_alt },
        waypoints: (action === "start" || action === "resume") ? pending : undefined,
        empty_plan_mode: mission.empty_plan_mode,
        force: force === true,
        target_boot_id: targetBootId,
        previous_state: mission.lifecycle_state,
      };
      db.prepare(`INSERT INTO mission_command
        (id,mission_id,command_seq,action,plan_hash,state,requested_at,actor,rover_boot_id,payload_json)
        VALUES (?,?,?,?,?,'pending',?,?,?,?)`)
        .run(commandId, missionId, seq, action, mission.plan_hash, now, actor, targetBootId, JSON.stringify(payload));
      if (action === "end") {
        // Keep the mission active until the rover durably acknowledges the end.
        // This preserves the motion fence and prevents a successor mission from
        // being created while the previous navigator may still be driving.
        db.prepare(`UPDATE mission SET updated_at=?,active_command_id=?,
          hold_reason=CASE WHEN active_hold_id IS NULL THEN 'operator_end_requested' ELSE hold_reason END
          WHERE id=?`).run(now, commandId, missionId);
      } else {
        db.prepare(`UPDATE mission SET lifecycle_state=?,status=?,updated_at=?,active_command_id=?,hold_reason=NULL WHERE id=?`)
          .run(nextState, legacyStatus(nextState), now, commandId, missionId);
      }
      recordEvent(missionId, `command.${action}.requested`, {
        commandId, actor, before: { state: mission.lifecycle_state },
        after: { state: action === "end" ? mission.lifecycle_state : nextState },
        detail: { command_seq: seq, plan_hash: mission.plan_hash, waypoint_count: pending.length, force: force === true },
      });
      return { command: { id: commandId, mission_id: missionId, command_seq: seq, action, state: "pending", payload_json: JSON.stringify(payload) }, mission: missionPublic(missionId), replay: false };
    })();
  }

  function applyReport(report, actor = "rover") {
    const missionId = Number(report.mission_id);
    if (!REPORT_EVENTS.has(report.event)) {
      throw Object.assign(new Error("올바르지 않은 미션 보고 이벤트입니다."), { status: 400, reason: "unknown_report_event" });
    }
    if (report.event === "command"
        && (typeof report.command_id !== "string"
          || !Number.isInteger(report.command_seq)
          || !["accepted", "rejected"].includes(report.command_result)
          || !["running", "held"].includes(report.motion_state))) {
      throw Object.assign(new Error("미션 명령 응답의 상관관계 정보가 올바르지 않습니다."), { status: 400, reason: "invalid_command_report" });
    }
    if (report.event === "state" && !["running", "held"].includes(report.motion_state)) {
      throw Object.assign(new Error("올바르지 않은 로버 미션 상태입니다."), { status: 400, reason: "invalid_motion_state" });
    }
    if (["waypoint_active", "waypoint_completed", "waypoint_failed"].includes(report.event)
        && (typeof report.waypoint_id !== "string" || !report.waypoint_id)) {
      throw Object.assign(new Error("웨이포인트 보고에 ID가 없습니다."), { status: 400, reason: "missing_waypoint_id" });
    }
    if (report.completed_waypoint_ids !== undefined
        && (!Array.isArray(report.completed_waypoint_ids)
          || report.completed_waypoint_ids.some((id) => typeof id !== "string" || !id))) {
      throw Object.assign(new Error("완료 웨이포인트 체크포인트 형식이 올바르지 않습니다."), {
        status: 400, reason: "invalid_completed_waypoint_ids",
      });
    }
    const mission = missionRow(missionId);
    if (!mission) throw Object.assign(new Error("보고된 미션을 찾을 수 없습니다."), { status: 404, reason: "unknown_mission" });
    if (report.plan_hash !== mission.plan_hash) {
      throw Object.assign(new Error("로버 계획 해시가 서버와 다릅니다."), { status: 409, reason: "plan_hash_mismatch" });
    }
    if (TERMINAL_MISSION_STATES.has(mission.lifecycle_state) && report.event !== "command") {
      throw Object.assign(new Error("이미 종료된 미션의 상태는 변경할 수 없습니다."), { status: 409, reason: "terminal_mission" });
    }
    const now = Date.now();
    return db.transaction(() => {
      const terminalAtReport = TERMINAL_MISSION_STATES.has(mission.lifecycle_state);
      let pendingEndDuringSafetyAck = null;
      if (mission.active_hold_id && ["held", "interrupted"].includes(report.event)) {
        if (report.hold_id !== mission.active_hold_id) {
          throw Object.assign(new Error("재부팅 안전 정지 ID가 현재 요청과 일치하지 않습니다."), {
            status: 409, reason: "hold_id_mismatch",
          });
        }
        if (report.checkpoint_persisted !== true) {
          throw Object.assign(new Error("로버의 정지 체크포인트가 아직 영구 저장되지 않았습니다."), {
            status: 409, reason: "checkpoint_not_persisted",
          });
        }
        if (mission.active_command_id) {
          const activeCommand = db.prepare(`SELECT id,action,state FROM mission_command
            WHERE id=? AND mission_id=?`).get(mission.active_command_id, missionId);
          if (activeCommand?.state === "pending" && activeCommand.action === "end") {
            pendingEndDuringSafetyAck = activeCommand;
          }
        }
      }
      if (mission.active_hold_id
          && ["waypoint_active", "waypoint_failed", "mission_completed"].includes(report.event)) {
        throw Object.assign(new Error("재부팅 안전 정지가 확인되기 전에는 해당 보고로 미션 상태를 변경할 수 없습니다."), {
          status: 409, reason: "safety_hold_pending",
        });
      }
      const completedIds = Array.isArray(report.completed_waypoint_ids)
        ? [...new Set(report.completed_waypoint_ids)] : [];
      if (!terminalAtReport) {
        const selectWaypoint = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?");
        const completeWaypoint = db.prepare(`UPDATE mission_waypoint SET state='completed',outcome='success',
          completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=? AND mission_id=? AND state IN ('pending','active')`);
        for (const waypointId of completedIds) {
          const wp = selectWaypoint.get(waypointId, missionId);
          if (!wp) {
            throw Object.assign(new Error("체크포인트에 현재 미션 소속이 아닌 웨이포인트가 있습니다."), {
              status: 409, reason: "unknown_completed_waypoint",
            });
          }
          if (wp.state === "skipped") {
            throw Object.assign(new Error("건너뛴 웨이포인트를 완료 체크포인트로 처리할 수 없습니다."), {
              status: 409, reason: "skipped_completed_waypoint",
            });
          }
          if (report.event === "waypoint_completed" && waypointId === report.waypoint_id) continue;
          const changed = completeWaypoint.run(now, now, waypointId, missionId).changes;
          if (changed) recordEvent(missionId, "waypoint.reconciled_completed", {
            waypointId, roverBootId: report.boot_id, actor,
            before: { state: wp.state }, after: { state: "completed", outcome: "success" },
          });
        }
      }
      let command = null;
      if (report.command_id) command = db.prepare("SELECT * FROM mission_command WHERE id=? AND mission_id=?").get(report.command_id, missionId);
      if (report.command_id && !command) {
        throw Object.assign(new Error("알 수 없는 명령 ID입니다."), { status: 409, reason: "unknown_command" });
      }
      if (command && report.event === "command" && report.command_seq !== command.command_seq) {
        throw Object.assign(new Error("명령 순번이 요청과 일치하지 않습니다."), { status: 409, reason: "command_seq_mismatch" });
      }
      if (command && report.event === "command" && command.action === "end"
          && report.command_result === "accepted" && report.motion_state !== "held") {
        throw Object.assign(new Error("로버의 정지가 확인되기 전에는 미션을 종료할 수 없습니다."), {
          status: 409, reason: "end_motion_not_held",
        });
      }
      if (command && report.event === "command" && command.action === "pause"
          && report.command_result === "accepted" && report.motion_state !== "held") {
        throw Object.assign(new Error("로버의 정지가 확인되기 전에는 일시정지를 확정할 수 없습니다."), {
          status: 409, reason: "pause_motion_not_held",
        });
      }
      if (command && report.event === "command" && command.state === "superseded") {
        recordEvent(missionId, `command.${command.action}.late_result_ignored`, {
          commandId: command.id, roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state, command_state: "superseded" },
          after: { state: mission.lifecycle_state, command_state: "superseded" },
          detail: { reported_result: report.command_result, motion_state: report.motion_state },
        });
        return missionPublic(missionId);
      }
      if (command && report.event === "command" && command.state !== "pending"
          && command.state !== report.command_result) {
        throw Object.assign(new Error("이미 확정된 명령 결과와 상충합니다."), { status: 409, reason: "command_result_conflict" });
      }
      if (command && report.command_result && command.state === "pending") {
        const accepted = report.command_result === "accepted";
        if (!accepted && report.command_result !== "rejected") {
          throw Object.assign(new Error("올바르지 않은 명령 결과입니다."), { status: 400 });
        }
        db.prepare(`UPDATE mission_command SET state=?,acknowledged_at=?,rover_boot_id=?,reject_reason=? WHERE id=?`)
          .run(accepted ? "accepted" : "rejected", now, report.boot_id, accepted ? null : (report.reason || "rejected"), command.id);
        if (terminalAtReport || mission.active_command_id !== command.id) {
          recordEvent(missionId, `command.${command.action}.${accepted ? "accepted" : "rejected"}`, {
            commandId: command.id, roverBootId: report.boot_id, actor,
            before: { state: mission.lifecycle_state, command_state: "pending" },
            after: { state: mission.lifecycle_state, command_state: accepted ? "accepted" : "rejected" },
            detail: { reason: report.reason || null, lifecycle_unchanged: true },
          });
          return missionPublic(missionId);
        }
        let nextState = mission.lifecycle_state;
        let nextLegacy = mission.status;
        let endedAt = mission.ended_at;
        if (accepted) {
          if (command.action === "start" || command.action === "resume") {
            nextState = report.motion_state === "running"
              ? "running" : (command.action === "start" ? "ready" : "paused");
            nextLegacy = legacyStatus(nextState);
          } else if (command.action === "pause") {
            nextState = report.motion_state === "held" ? "paused" : mission.lifecycle_state;
            nextLegacy = legacyStatus(nextState);
          } else if (command.action === "end") {
            nextState = "cancelled";
            nextLegacy = "stopped";
            endedAt = endedAt || now;
          }
        } else {
          const payload = parseJson(command.payload_json, {});
          const previousState = payload.previous_state || "interrupted";
          nextState = report.motion_state === "held"
            ? (previousState === "ready" ? "ready" : "paused")
            : (previousState === "running" ? "running" : "interrupted");
          nextLegacy = legacyStatus(nextState);
        }
        const preserveSafetyHold = mission.active_hold_id != null && nextState !== "cancelled";
        if (preserveSafetyHold) {
          nextState = "interrupted";
          nextLegacy = "interrupted";
          endedAt = mission.ended_at;
        }
        db.prepare(`UPDATE mission SET lifecycle_state=?,status=?,updated_at=?,ended_at=?,
          active_command_id=NULL,last_rover_boot_id=?,activated_at=CASE WHEN ?='running' THEN COALESCE(activated_at,?) ELSE activated_at END,
          hold_reason=?,active_hold_id=CASE WHEN ? IN ('running','cancelled') THEN NULL ELSE active_hold_id END WHERE id=?`)
          .run(nextState, nextLegacy, now, endedAt, report.boot_id, nextState, now,
            preserveSafetyHold
              ? "rover_rebooted"
              : nextState === "running" || nextState === "cancelled"
              ? null
              : (report.reason || (accepted ? "command_accepted_held" : `command_rejected:${report.reason || "unknown"}`)),
            nextState, missionId);
        recordEvent(missionId, `command.${command.action}.${accepted ? "accepted" : "rejected"}`, {
          commandId: command.id, roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state }, after: { state: nextState }, detail: { reason: report.reason || null },
        });
      }

      if (report.event === "state") {
        let reconciledState;
        if (report.motion_state === "running") {
          const sameBoot = !mission.last_rover_boot_id || mission.last_rover_boot_id === report.boot_id;
          // A new boot is held explicitly by reconcileRoverBoot. Even if a
          // faulty/stale navigator claims it is moving under that new boot ID,
          // only an operator resume command may release the reboot hold. A
          // same-process network reconnect uses a different hold reason and may
          // legitimately re-adopt motion already in progress.
          const mayAdoptMotion = sameBoot && (
            mission.lifecycle_state === "running"
            || (mission.lifecycle_state === "interrupted"
              && NETWORK_RECONCILE_REASONS.has(mission.hold_reason))
          );
          if (mayAdoptMotion) {
            reconciledState = "running";
            db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',hold_reason=NULL,
              updated_at=?,last_rover_boot_id=?,activated_at=COALESCE(activated_at,?) WHERE id=?`)
              .run(now, report.boot_id, now, missionId);
          } else {
            // A state report is observational, not an authorization to release a
            // confirmed hold. Preserve pause/reboot/operator state verbatim; the
            // only path back to running is a correlated resume acceptance (or the
            // narrow network-reconciliation cases above).
            reconciledState = mission.lifecycle_state;
          }
        } else if (report.motion_state === "held") {
          if (mission.active_hold_id) {
            reconciledState = mission.lifecycle_state;
          } else if (mission.active_command_id) {
            const pendingCommand = db.prepare(`SELECT id,command_seq,action,state FROM mission_command
              WHERE id=? AND mission_id=?`).get(mission.active_command_id, missionId);
            const checkpointSeq = Number.isInteger(report.command_seq) ? report.command_seq : null;
            const checkpointCommandId = typeof report.last_command_id === "string"
              ? report.last_command_id : null;
            const checkpointResult = ["accepted", "rejected"].includes(report.last_command_result)
              ? report.last_command_result : null;
            const resolvesPending = pendingCommand?.state === "pending"
              && checkpointSeq === pendingCommand.command_seq
              && checkpointCommandId === pendingCommand.id
              && checkpointResult != null;
            const supersedesPending = pendingCommand?.state === "pending"
              && checkpointSeq != null && checkpointSeq > pendingCommand.command_seq;
            if (resolvesPending || supersedesPending) {
              const pendingPayload = parseJson(
                db.prepare("SELECT payload_json FROM mission_command WHERE id=?")
                  .get(mission.active_command_id)?.payload_json,
                {},
              );
              if (resolvesPending && checkpointResult === "accepted") {
                reconciledState = pendingCommand.action === "end" ? "cancelled"
                  : pendingCommand.action === "start" ? "ready" : "paused";
              } else if (resolvesPending) {
                reconciledState = pendingPayload.previous_state === "ready" ? "ready" : "paused";
              } else {
                reconciledState = "paused";
              }
              const acceptedEnd = reconciledState === "cancelled";
              db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=?
                WHERE mission_id=? AND state='active'`).run(now, missionId);
              db.prepare(`UPDATE mission SET lifecycle_state=?,status=?,hold_reason=?,updated_at=?,
                ended_at=CASE WHEN ?='cancelled' THEN COALESCE(ended_at,?) ELSE ended_at END,
                last_rover_boot_id=?,active_command_id=NULL,
                active_hold_id=CASE WHEN ?='cancelled' THEN NULL ELSE active_hold_id END WHERE id=?`)
                .run(
                  reconciledState, legacyStatus(reconciledState),
                  acceptedEnd ? null : (report.last_command_reason || report.reason || "checkpoint_restored"),
                  now, reconciledState, now, report.boot_id, reconciledState, missionId,
                );
              if (resolvesPending) {
                db.prepare(`UPDATE mission_command SET state=?,acknowledged_at=?,reject_reason=?
                  WHERE id=? AND state='pending'`).run(
                  checkpointResult,
                  now,
                  checkpointResult === "rejected"
                    ? (report.last_command_reason || report.reason || "checkpoint_rejected") : null,
                  mission.active_command_id,
                );
              } else {
                db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,
                  reject_reason='newer_held_checkpoint' WHERE id=? AND state='pending'`)
                  .run(now, mission.active_command_id);
              }
            } else {
              // A state request is sent before pending-command replay on server
              // recovery. A held checkpoint whose durable command sequence is
              // older than (or equal to) that pending command is pre-command
              // evidence, not authority to retire the command that follows it.
              // Keep the transition fenced until the correlated command result.
              reconciledState = mission.lifecycle_state;
              db.prepare(`UPDATE mission SET last_rover_boot_id=?,updated_at=? WHERE id=?`)
                .run(report.boot_id, now, missionId);
              recordEvent(missionId, "command.checkpoint_observed", {
                commandId: mission.active_command_id, roverBootId: report.boot_id, actor,
                before: { state: mission.lifecycle_state, command_state: pendingCommand?.state || null },
                after: { state: mission.lifecycle_state, command_state: pendingCommand?.state || null },
                detail: {
                  checkpoint_command_seq: checkpointSeq,
                  checkpoint_command_id: checkpointCommandId,
                  checkpoint_command_result: checkpointResult,
                  checkpoint_command_reason: report.last_command_reason || null,
                },
              });
            }
          } else {
            reconciledState = "paused";
            db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
            db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',hold_reason=?,updated_at=?,
              last_rover_boot_id=?,active_command_id=NULL WHERE id=?`)
              .run(report.reason || "checkpoint_restored", now, report.boot_id, missionId);
            if (mission.active_command_id) {
              db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason='newer_held_report'
                WHERE id=? AND state='pending'`).run(now, mission.active_command_id);
            }
          }
        }
        recordEvent(missionId, "mission.reconciled", {
          roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state, rover_boot_id: mission.last_rover_boot_id },
          after: { state: reconciledState, rover_boot_id: report.boot_id },
          detail: { completed_count: completedIds.length, reason: report.reason || null },
        });
      }

      if (report.event === "waypoint_active" && report.waypoint_id) {
        const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?").get(report.waypoint_id, missionId);
        if (!wp || !["pending", "active"].includes(wp.state)) {
          throw Object.assign(new Error("활성 웨이포인트가 현재 미션의 미완료 항목이 아닙니다."), { status: 409 });
        }
        db.prepare(`UPDATE mission_waypoint SET state='active',attempt_count=attempt_count+CASE WHEN state='pending' THEN 1 ELSE 0 END,
          updated_at=? WHERE id=?`).run(now, wp.id);
        recordEvent(missionId, "waypoint.active", { waypointId: wp.id, roverBootId: report.boot_id, actor, before: { state: wp.state }, after: { state: "active" } });
      }
      if (report.event === "waypoint_completed" && report.waypoint_id) {
        const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?").get(report.waypoint_id, missionId);
        if (!wp) {
          throw Object.assign(new Error("완료 웨이포인트가 현재 미션의 미완료 항목이 아닙니다."), { status: 409 });
        }
        if (["pending", "active"].includes(wp.state)) {
          db.prepare(`UPDATE mission_waypoint SET state='completed',outcome='success',completed_at=?,updated_at=? WHERE id=?`)
            .run(now, now, wp.id);
          recordEvent(missionId, "waypoint.completed", { waypointId: wp.id, roverBootId: report.boot_id, actor, before: publicWaypoint(wp), after: { state: "completed", outcome: "success" } });
        } else if (wp.state !== "completed") {
          throw Object.assign(new Error("건너뛴 웨이포인트는 완료 처리할 수 없습니다."), { status: 409 });
        }
      }
      if (report.event === "waypoint_failed" && report.waypoint_id) {
        const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?").get(report.waypoint_id, missionId);
        if (!wp || !["pending", "active"].includes(wp.state)) {
          throw Object.assign(new Error("실패 웨이포인트가 현재 미션의 미완료 항목이 아닙니다."), { status: 409 });
        }
        db.prepare(`UPDATE mission_waypoint SET state='pending',outcome=?,updated_at=? WHERE id=?`)
          .run(report.outcome || "failed", now, wp.id);
        db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',hold_reason='waypoint_failed',updated_at=? WHERE id=?`)
          .run(now, missionId);
        recordEvent(missionId, "waypoint.failed", { waypointId: wp.id, roverBootId: report.boot_id, actor, before: publicWaypoint(wp), after: { state: "pending", outcome: report.outcome || "failed" } });
      }
      if (["held", "interrupted"].includes(report.event)
          && (report.reason === "dispense_outcome_uncertain"
            || report.outcome === "dispense_outcome_uncertain"
            || report.motion_state === "dispense_uncertain")
          && typeof report.active_waypoint_id === "string") {
        const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?")
          .get(report.active_waypoint_id, missionId);
        if (!wp || !["pending", "active"].includes(wp.state)) {
          throw Object.assign(new Error("분사 결과가 불확실한 웨이포인트가 현재 미션의 미완료 항목이 아닙니다."), {
            status: 409, reason: "invalid_uncertain_waypoint",
          });
        }
        db.prepare(`UPDATE mission_waypoint SET state='pending',outcome='dispense_outcome_uncertain',updated_at=?
          WHERE id=? AND mission_id=?`).run(now, wp.id, missionId);
        recordEvent(missionId, "waypoint.dispense_uncertain", {
          waypointId: wp.id, roverBootId: report.boot_id, actor,
          before: publicWaypoint(wp),
          after: { state: "pending", outcome: "dispense_outcome_uncertain" },
        });
      }
      if (report.event === "held") {
        db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
        if (pendingEndDuringSafetyAck) {
          const confirmedReason = `${ROVER_CONFIRMED_HOLD_PREFIX}${report.reason || "rover_held"}`;
          db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason=?,updated_at=?,
            last_rover_boot_id=?,active_hold_id=NULL WHERE id=?`)
            .run(confirmedReason, now, report.boot_id, missionId);
        } else {
          db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',hold_reason=?,updated_at=?,
            last_rover_boot_id=?,active_hold_id=NULL,active_command_id=NULL WHERE id=?`)
            .run(report.reason || "rover_held", now, report.boot_id, missionId);
        }
        if (mission.active_command_id && !pendingEndDuringSafetyAck) {
          db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason='newer_held_report'
            WHERE id=? AND state='pending'`).run(now, mission.active_command_id);
        }
        recordEvent(missionId, "mission.held", {
          roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state, active_hold_id: mission.active_hold_id },
          after: {
            state: pendingEndDuringSafetyAck ? "interrupted" : "paused",
            reason: report.reason || "rover_held",
            active_hold_id: null,
            active_command_id: pendingEndDuringSafetyAck?.id || null,
          },
          detail: {
            hold_id: report.hold_id || null,
            checkpoint_persisted: report.checkpoint_persisted === true,
            pending_end_preserved: !!pendingEndDuringSafetyAck,
          },
        });
      }
      if (report.event === "interrupted") {
        db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
        const confirmedReason = `${ROVER_CONFIRMED_HOLD_PREFIX}${report.reason || "rover_interrupted"}`;
        db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason=?,updated_at=?,
          last_rover_boot_id=?,active_hold_id=NULL,
          active_command_id=CASE WHEN ? THEN active_command_id ELSE NULL END WHERE id=?`)
          .run(confirmedReason, now, report.boot_id, pendingEndDuringSafetyAck ? 1 : 0, missionId);
        if (mission.active_command_id && !pendingEndDuringSafetyAck) {
          db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason='newer_interrupted_report'
            WHERE id=? AND state='pending'`).run(now, mission.active_command_id);
        }
        recordEvent(missionId, "mission.interrupted", {
          roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state, active_hold_id: mission.active_hold_id },
          after: {
            state: "interrupted",
            reason: report.reason || "rover_interrupted",
            active_hold_id: null,
            active_command_id: pendingEndDuringSafetyAck?.id || null,
          },
          detail: {
            hold_id: report.hold_id || null,
            checkpoint_persisted: report.checkpoint_persisted === true,
            pending_end_preserved: !!pendingEndDuringSafetyAck,
          },
        });
      }
      if (report.event === "mission_completed") {
        const remaining = db.prepare(`SELECT COUNT(*) AS n FROM mission_waypoint WHERE mission_id=? AND state IN ('pending','active')`).get(missionId).n;
        if (remaining > 0) {
          throw Object.assign(new Error(`미완료 웨이포인트 ${remaining}개가 있어 미션을 완료할 수 없습니다.`), { status: 409, reason: "pending_waypoints" });
        }
        if (mission.active_command_id) {
          const retired = db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,
            reject_reason='mission_completed' WHERE id=? AND mission_id=? AND state='pending'`)
            .run(now, mission.active_command_id, missionId).changes;
          if (retired) recordEvent(missionId, "command.superseded", {
            commandId: mission.active_command_id,
            roverBootId: report.boot_id,
            actor,
            before: { state: "pending" },
            after: { state: "superseded" },
            detail: { reason: "mission_completed" },
          });
        }
        db.prepare(`UPDATE mission SET lifecycle_state='completed',status='completed',ended_at=?,updated_at=?,
          active_command_id=NULL,active_hold_id=NULL,hold_reason=NULL,last_rover_boot_id=? WHERE id=?`)
          .run(now, now, report.boot_id, missionId);
        recordEvent(missionId, "mission.completed", { roverBootId: report.boot_id, actor, before: { state: mission.lifecycle_state }, after: { state: "completed" } });
      }
      if (report.start_position && mission.start_lat == null
          && Number.isFinite(report.start_position.lat) && Number.isFinite(report.start_position.lng)) {
        db.prepare(`UPDATE mission SET start_lat=?,start_lng=?,start_alt=?,updated_at=? WHERE id=? AND start_lat IS NULL`)
          .run(report.start_position.lat, report.start_position.lng,
            Number.isFinite(report.start_position.alt) ? report.start_position.alt : null, now, missionId);
      }
      return missionPublic(missionId);
    })();
  }

  function markInterrupted(missionId, reason, roverBootId = null, { confirmed = false } = {}) {
    const mission = missionRow(missionId);
    if (!mission || TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) return null;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
      const persistedReason = confirmed
        ? `${ROVER_CONFIRMED_HOLD_PREFIX}${reason}`
        : (mission.active_hold_id ? "rover_rebooted" : reason);
      db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason=?,updated_at=?,active_command_id=NULL,
        active_hold_id=CASE WHEN ? THEN NULL ELSE active_hold_id END,
        last_rover_boot_id=COALESCE(?,last_rover_boot_id) WHERE id=?`)
        .run(persistedReason, now, confirmed ? 1 : 0, roverBootId, missionId);
      if (mission.active_command_id) {
        db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason=? WHERE id=? AND state='pending'`)
          .run(now, reason, mission.active_command_id);
      }
      recordEvent(missionId, "mission.interrupted", {
        roverBootId,
        before: { state: mission.lifecycle_state, active_hold_id: mission.active_hold_id },
        after: {
          state: "interrupted",
          reason: persistedReason,
          active_hold_id: confirmed ? null : mission.active_hold_id,
        },
        detail: { confirmed },
      });
    })();
    return missionPublic(missionId);
  }

  function markCommandDeliveryFailed(missionId, commandId, roverBootId = null) {
    const mission = missionRow(missionId);
    const command = db.prepare(`SELECT * FROM mission_command
      WHERE id=? AND mission_id=?`).get(commandId, missionId);
    if (!mission || !command || command.state !== "pending"
        || mission.active_command_id !== commandId
        || TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) {
      return mission ? missionPublic(missionId) : null;
    }
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=?
        WHERE mission_id=? AND state='active'`).run(now, missionId);
      db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,
        reject_reason='command_delivery_failed' WHERE id=?`).run(now, commandId);
      db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',
        hold_reason=CASE WHEN active_hold_id IS NULL THEN 'command_delivery_failed' ELSE 'rover_rebooted' END,
        active_command_id=NULL,updated_at=?,
        last_rover_boot_id=COALESCE(?,last_rover_boot_id) WHERE id=?`)
        .run(now, roverBootId, missionId);
      recordEvent(missionId, "command.delivery_failed", {
        commandId, roverBootId,
        before: { state: mission.lifecycle_state, command_state: "pending" },
        after: { state: "interrupted", command_state: "superseded" },
        detail: { action: command.action, reason: "command_delivery_failed" },
      });
    })();
    return missionPublic(missionId);
  }

  function pendingCommands() {
    return db.prepare("SELECT * FROM mission_command WHERE state='pending' ORDER BY requested_at,id").all();
  }

  function claimRoverBootSession(bootId) {
    if (typeof bootId !== "string" || !bootId || bootId.length > 128) {
      return { accepted: false, reason: "invalid_boot_id" };
    }
    const now = Date.now();
    return db.transaction(() => {
      const latest = db.prepare("SELECT COALESCE(MAX(generation),0) AS generation FROM rover_boot_session").get().generation;
      const existing = db.prepare("SELECT * FROM rover_boot_session WHERE boot_id=?").get(bootId);
      if (existing) {
        if (existing.generation !== latest) {
          return {
            accepted: false,
            reason: "stale_boot_session",
            generation: existing.generation,
            current_generation: latest,
          };
        }
        db.prepare("UPDATE rover_boot_session SET last_seen_at=? WHERE boot_id=?").run(now, bootId);
        return { accepted: true, generation: existing.generation, replay: true };
      }
      const generation = latest + 1;
      db.prepare(`INSERT INTO rover_boot_session
        (boot_id,generation,first_seen_at,last_seen_at) VALUES (?,?,?,?)`)
        .run(bootId, generation, now, now);
      return { accepted: true, generation, replay: false };
    })();
  }

  function reconcileRoverBoot(bootId) {
    const now = Date.now();
    const mismatched = db.prepare(`SELECT * FROM mission_command
      WHERE state='pending' AND rover_boot_id IS NOT NULL AND rover_boot_id <> ?`).all(bootId);
    const activeRow = db.prepare(`SELECT * FROM mission WHERE lifecycle_state IN
      ('ready','starting','running','pausing','paused','interrupted','resuming')
      ORDER BY id DESC LIMIT 1`).get();
    const motionMayStillBeActive = activeRow && (
      ["starting", "running", "pausing", "resuming"].includes(activeRow.lifecycle_state)
      || (activeRow.lifecycle_state === "interrupted"
        && NETWORK_RECONCILE_REASONS.has(activeRow.hold_reason))
    );
    const movingMissionRebooted = motionMayStillBeActive
      && activeRow.last_rover_boot_id
      && activeRow.last_rover_boot_id !== bootId;
    if (mismatched.length === 0 && !movingMissionRebooted) return activeMission();
    return db.transaction(() => {
      const interruptedIds = new Set();
      for (const command of mismatched) {
        db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason='rover_rebooted' WHERE id=?`)
          .run(now, command.id);
        const mission = missionRow(command.mission_id);
        if (mission && !TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) {
          const holdId = crypto.randomUUID();
          db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason='rover_rebooted',
            active_command_id=NULL,active_hold_id=?,updated_at=?,last_rover_boot_id=? WHERE id=?`)
            .run(holdId, now, bootId, mission.id);
          recordEvent(mission.id, "command.superseded", {
            commandId: command.id, roverBootId: bootId,
            before: { state: mission.lifecycle_state }, after: { state: "interrupted" },
            detail: { reason: "rover_rebooted", hold_id: holdId },
          });
          interruptedIds.add(mission.id);
        } else if (mission) {
          recordEvent(mission.id, "command.superseded", {
            commandId: command.id, roverBootId: bootId,
            before: { state: mission.lifecycle_state, command_state: "pending" },
            after: { state: mission.lifecycle_state, command_state: "superseded" },
            detail: { reason: "rover_rebooted", lifecycle_unchanged: true },
          });
        }
      }
      if (movingMissionRebooted && !interruptedIds.has(activeRow.id)) {
        const holdId = crypto.randomUUID();
        db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason='rover_rebooted',
          active_command_id=NULL,active_hold_id=?,updated_at=?,last_rover_boot_id=? WHERE id=?`)
          .run(holdId, now, bootId, activeRow.id);
        recordEvent(activeRow.id, "mission.interrupted", {
          roverBootId: bootId,
          before: { state: activeRow.lifecycle_state, rover_boot_id: activeRow.last_rover_boot_id },
          after: { state: "interrupted", rover_boot_id: bootId },
          detail: { reason: "rover_rebooted", hold_id: holdId },
        });
      }
      return activeMission();
    })();
  }

  return {
    actorLabel,
    activeMission,
    activeMissionSummary,
    applyReport,
    claimRoverBootSession,
    createMission,
    deletePreset,
    editRemaining,
    issueCommand,
    listPresets,
    markCommandDeliveryFailed,
    markInterrupted,
    missionPublic,
    missionRow,
    motionConfirmedHeld,
    pendingCommands,
    pendingWaypoints,
    reconcileRoverBoot,
    recordEvent,
    savePreset,
    waypointRows,
  };
}
