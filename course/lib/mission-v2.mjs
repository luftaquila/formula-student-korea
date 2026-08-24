import crypto from "crypto";

export const MISSION_PROTOCOL_VERSION = 2;
export const ACTIVE_MISSION_STATES = [
  "ready", "starting", "running", "pausing", "paused", "interrupted", "resuming",
];

const TERMINAL_MISSION_STATES = new Set(["completed", "cancelled"]);
const HELD_MISSION_STATES = new Set(["ready", "paused", "interrupted"]);
const COMMAND_ACTIONS = new Set(["start", "pause", "resume", "end"]);
const FINISH_BEHAVIORS = new Set(["stop", "return_to_start"]);
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

    const open = db.prepare(`SELECT id FROM mission
      WHERE lifecycle_state IN (${ACTIVE_MISSION_STATES.map(() => "?").join(",")})
      ORDER BY id DESC`).all(...ACTIVE_MISSION_STATES);
    if (open.length > 1) {
      const now = Date.now();
      const close = db.prepare(`UPDATE mission SET lifecycle_state='cancelled', status='stopped',
        hold_reason='migration_superseded', ended_at=COALESCE(ended_at, ?), updated_at=? WHERE id=?`);
      for (const row of open.slice(1)) close.run(now, now, row.id);
      changed.push(`closed ${open.length - 1} superseded open mission(s)`);
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

  function missionPublic(id, { events = false } = {}) {
    const row = missionRow(id);
    if (!row) return null;
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
      hold_reason: row.hold_reason,
      finish_behavior: row.finish_behavior || "return_to_start",
      plan_hash: row.plan_hash,
      start_position: row.start_lat == null ? null : {
        lat: row.start_lat, lng: row.start_lng, alt: row.start_alt,
      },
      actor: row.actor,
      protocol_version: row.protocol_version,
      active_command_id: row.active_command_id,
      waypoints: waypointRows(id).map(publicWaypoint),
    };
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
    return row ? missionPublic(row.id) : null;
  }

  function resolveConeItems(courseId, items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 10000) {
      throw Object.assign(new Error("콘 경로는 1개 이상 10,000개 이하여야 합니다."), { status: 400 });
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
      const items = selectItems.all(preset.id).map((item) => {
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
      return { ...preset, stale, items };
    });
  }

  function savePreset({ id = null, courseId, name, finishBehavior = "stop", items, actor = null }) {
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
        db.prepare(`UPDATE mission_route_preset SET name=?,finish_behavior=?,updated_at=?,actor=? WHERE id=?`)
          .run(trimmedName, finishBehavior, now, actor, id);
        db.prepare("DELETE FROM mission_route_preset_item WHERE preset_id=?").run(id);
      } else {
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

  function deletePreset(id) {
    const preset = db.prepare("SELECT * FROM mission_route_preset WHERE id=?").get(id);
    if (!preset) throw Object.assign(new Error("프리셋을 찾을 수 없습니다."), { status: 404 });
    const before = listPresets(preset.course_id).find((p) => p.id === id);
    db.prepare("DELETE FROM mission_route_preset WHERE id=?").run(id);
    return before;
  }

  function createMission({ courseId, presetId = null, finishBehavior = "stop", items, actor = null }) {
    if (!FINISH_BEHAVIORS.has(finishBehavior)) {
      throw Object.assign(new Error("올바르지 않은 종료 동작입니다."), { status: 400 });
    }
    if (activeMission()) {
      throw Object.assign(new Error("종료되지 않은 미션이 이미 있습니다."), { status: 409, reason: "active_mission" });
    }
    const cones = resolveConeItems(courseId, items);
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

  function editRemaining({ missionId, expectedPlanHash, finishBehavior, items, actor = null }) {
    const mission = missionRow(missionId);
    if (!mission) throw Object.assign(new Error("미션을 찾을 수 없습니다."), { status: 404 });
    if (!HELD_MISSION_STATES.has(mission.lifecycle_state)) {
      throw Object.assign(new Error("정지된 미션에서만 남은 경로를 편집할 수 있습니다."), { status: 409 });
    }
    if (mission.active_command_id) {
      throw Object.assign(new Error("처리 중인 로버 명령이 있습니다."), { status: 409 });
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
    if (!Array.isArray(items) || items.length > 10000) {
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
    const before = missionPublic(missionId);
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
      db.prepare(`UPDATE mission SET finish_behavior=?,plan_hash=?,updated_at=?,hold_reason='route_edited' WHERE id=?`)
        .run(nextFinish, planHash, now, missionId);
      const after = missionPublic(missionId);
      recordEvent(missionId, "mission.remaining_edited", {
        actor,
        before: { plan_hash: before.plan_hash, pending: before.waypoints.filter((w) => w.state === "pending").map((w) => w.id), finish_behavior: before.finish_behavior },
        after: { plan_hash: planHash, pending: after.waypoints.filter((w) => w.state === "pending").map((w) => w.id), finish_behavior: nextFinish },
      });
      return after;
    })();
  }

  function issueCommand({ missionId, action, actor = null, force = false, targetBootId = null }) {
    if (!COMMAND_ACTIONS.has(action)) throw Object.assign(new Error("올바르지 않은 미션 명령입니다."), { status: 400 });
    const mission = missionRow(missionId);
    if (!mission) throw Object.assign(new Error("미션을 찾을 수 없습니다."), { status: 404 });
    if (TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) {
      throw Object.assign(new Error("이미 종료된 미션입니다."), { status: 409 });
    }
    if (mission.active_command_id) {
      const pending = db.prepare("SELECT * FROM mission_command WHERE id=?").get(mission.active_command_id);
      if (pending?.state === "pending") return { command: pending, mission: missionPublic(missionId), replay: true };
    }
    const allowed = action === "start" ? mission.lifecycle_state === "ready"
      : action === "resume" ? ["paused", "interrupted"].includes(mission.lifecycle_state)
        : action === "pause" ? mission.lifecycle_state === "running"
          : true;
    if (!allowed) throw Object.assign(new Error(`현재 미션 상태(${mission.lifecycle_state})에서 ${action}할 수 없습니다.`), { status: 409 });
    const pending = pendingWaypoints(missionId).map(publicWaypoint);
    if ((action === "start" || action === "resume") && pending.length === 0
        && mission.finish_behavior !== "return_to_start") {
      throw Object.assign(new Error("실행할 남은 웨이포인트가 없습니다."), { status: 409 });
    }
    const now = Date.now();
    return db.transaction(() => {
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
        finish_behavior: mission.finish_behavior,
        mission_start: mission.start_lat == null ? null : { lat: mission.start_lat, lng: mission.start_lng, alt: mission.start_alt },
        waypoints: (action === "start" || action === "resume") ? pending : undefined,
        force: force === true,
        target_boot_id: targetBootId,
        previous_state: mission.lifecycle_state,
      };
      db.prepare(`INSERT INTO mission_command
        (id,mission_id,command_seq,action,plan_hash,state,requested_at,actor,rover_boot_id,payload_json)
        VALUES (?,?,?,?,?,'pending',?,?,?,?)`)
        .run(commandId, missionId, seq, action, mission.plan_hash, now, actor, targetBootId, JSON.stringify(payload));
      if (action === "end") {
        db.prepare(`UPDATE mission SET lifecycle_state='cancelled',status='stopped',ended_at=?,updated_at=?,
          active_command_id=?,hold_reason='operator_ended' WHERE id=?`).run(now, now, commandId, missionId);
      } else {
        db.prepare(`UPDATE mission SET lifecycle_state=?,status=?,updated_at=?,active_command_id=?,hold_reason=NULL WHERE id=?`)
          .run(nextState, legacyStatus(nextState), now, commandId, missionId);
      }
      recordEvent(missionId, `command.${action}.requested`, {
        commandId, actor, before: { state: mission.lifecycle_state }, after: { state: action === "end" ? "cancelled" : nextState },
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
          || !["accepted", "rejected"].includes(report.command_result))) {
      throw Object.assign(new Error("미션 명령 응답의 상관관계 정보가 올바르지 않습니다."), { status: 400, reason: "invalid_command_report" });
    }
    if (report.event === "state" && !["running", "held"].includes(report.motion_state)) {
      throw Object.assign(new Error("올바르지 않은 로버 미션 상태입니다."), { status: 400, reason: "invalid_motion_state" });
    }
    if (["waypoint_active", "waypoint_completed", "waypoint_failed"].includes(report.event)
        && (typeof report.waypoint_id !== "string" || !report.waypoint_id)) {
      throw Object.assign(new Error("웨이포인트 보고에 ID가 없습니다."), { status: 400, reason: "missing_waypoint_id" });
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
      let command = null;
      if (report.command_id) command = db.prepare("SELECT * FROM mission_command WHERE id=? AND mission_id=?").get(report.command_id, missionId);
      if (report.command_id && !command) {
        throw Object.assign(new Error("알 수 없는 명령 ID입니다."), { status: 409, reason: "unknown_command" });
      }
      if (command && report.event === "command" && report.command_seq !== command.command_seq) {
        throw Object.assign(new Error("명령 순번이 요청과 일치하지 않습니다."), { status: 409, reason: "command_seq_mismatch" });
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
        let nextState = mission.lifecycle_state;
        let nextLegacy = mission.status;
        let endedAt = mission.ended_at;
        if (accepted) {
          if (command.action === "start" || command.action === "resume") {
            nextState = "running";
            nextLegacy = "running";
          } else if (command.action === "pause") {
            nextState = "paused";
            nextLegacy = "paused";
          } else if (command.action === "end") {
            nextState = "cancelled";
            nextLegacy = "stopped";
            endedAt = endedAt || now;
          }
        } else {
          const payload = parseJson(command.payload_json, {});
          nextState = payload.previous_state || "interrupted";
          nextLegacy = legacyStatus(nextState);
        }
        db.prepare(`UPDATE mission SET lifecycle_state=?,status=?,updated_at=?,ended_at=?,
          active_command_id=NULL,last_rover_boot_id=?,activated_at=CASE WHEN ?='running' THEN COALESCE(activated_at,?) ELSE activated_at END,
          hold_reason=? WHERE id=?`)
          .run(nextState, nextLegacy, now, endedAt, report.boot_id, nextState, now,
            accepted ? null : `command_rejected:${report.reason || "unknown"}`, missionId);
        recordEvent(missionId, `command.${command.action}.${accepted ? "accepted" : "rejected"}`, {
          commandId: command.id, roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state }, after: { state: nextState }, detail: { reason: report.reason || null },
        });
      }

      if (report.event === "state") {
        const completedIds = Array.isArray(report.completed_waypoint_ids)
          ? [...new Set(report.completed_waypoint_ids.filter((id) => typeof id === "string"))]
          : [];
        const selectWaypoint = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?");
        const completeWaypoint = db.prepare(`UPDATE mission_waypoint SET state='completed',outcome='success',
          completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=? AND mission_id=? AND state IN ('pending','active')`);
        for (const waypointId of completedIds) {
          const wp = selectWaypoint.get(waypointId, missionId);
          if (!wp) throw Object.assign(new Error("체크포인트에 현재 미션 소속이 아닌 웨이포인트가 있습니다."), { status: 409 });
          const changed = completeWaypoint.run(now, now, waypointId, missionId).changes;
          if (changed) recordEvent(missionId, "waypoint.reconciled_completed", {
            waypointId, roverBootId: report.boot_id, actor, before: { state: wp.state }, after: { state: "completed", outcome: "success" },
          });
        }
        let reconciledState;
        if (report.motion_state === "running") {
          const sameBoot = !mission.last_rover_boot_id || mission.last_rover_boot_id === report.boot_id;
          // A new boot is held explicitly by reconcileRoverBoot. Even if a
          // faulty/stale navigator claims it is moving under that new boot ID,
          // only an operator resume command may release the reboot hold. A
          // same-process network reconnect uses a different hold reason and may
          // legitimately re-adopt motion already in progress.
          const mayAdoptMotion = sameBoot && mission.hold_reason !== "rover_rebooted";
          if (mayAdoptMotion) {
            reconciledState = "running";
            db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',hold_reason=NULL,
              updated_at=?,last_rover_boot_id=?,activated_at=COALESCE(activated_at,?) WHERE id=?`)
              .run(now, report.boot_id, now, missionId);
          } else {
            reconciledState = "interrupted";
            db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason='rover_rebooted',
              updated_at=?,last_rover_boot_id=? WHERE id=?`).run(now, report.boot_id, missionId);
          }
        } else if (report.motion_state === "held") {
          reconciledState = "paused";
          db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
          db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',hold_reason=?,updated_at=?,last_rover_boot_id=? WHERE id=?`)
            .run(report.reason || "checkpoint_restored", now, report.boot_id, missionId);
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
      if (report.event === "held") {
        db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
        db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',hold_reason=?,updated_at=?,last_rover_boot_id=? WHERE id=?`)
          .run(report.reason || "rover_held", now, report.boot_id, missionId);
        recordEvent(missionId, "mission.held", { roverBootId: report.boot_id, actor, before: { state: mission.lifecycle_state }, after: { state: "paused", reason: report.reason || "rover_held" } });
      }
      if (report.event === "interrupted") {
        db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
        db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason=?,updated_at=?,last_rover_boot_id=? WHERE id=?`)
          .run(report.reason || "rover_interrupted", now, report.boot_id, missionId);
        recordEvent(missionId, "mission.interrupted", { roverBootId: report.boot_id, actor, before: { state: mission.lifecycle_state }, after: { state: "interrupted", reason: report.reason || "rover_interrupted" } });
      }
      if (report.event === "mission_completed") {
        const completedIds = Array.isArray(report.completed_waypoint_ids)
          ? [...new Set(report.completed_waypoint_ids.filter((id) => typeof id === "string"))]
          : [];
        const completeWaypoint = db.prepare(`UPDATE mission_waypoint SET state='completed',outcome='success',
          completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=? AND mission_id=? AND state IN ('pending','active')`);
        for (const waypointId of completedIds) {
          const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?").get(waypointId, missionId);
          if (!wp) throw Object.assign(new Error("완료 체크포인트에 현재 미션 소속이 아닌 웨이포인트가 있습니다."), { status: 409 });
          const changed = completeWaypoint.run(now, now, waypointId, missionId).changes;
          if (changed) recordEvent(missionId, "waypoint.reconciled_completed", {
            waypointId, roverBootId: report.boot_id, actor, before: { state: wp.state }, after: { state: "completed", outcome: "success" },
          });
        }
        const remaining = db.prepare(`SELECT COUNT(*) AS n FROM mission_waypoint WHERE mission_id=? AND state IN ('pending','active')`).get(missionId).n;
        if (remaining > 0) {
          throw Object.assign(new Error(`미완료 웨이포인트 ${remaining}개가 있어 미션을 완료할 수 없습니다.`), { status: 409, reason: "pending_waypoints" });
        }
        db.prepare(`UPDATE mission SET lifecycle_state='completed',status='completed',ended_at=?,updated_at=?,
          active_command_id=NULL,hold_reason=NULL,last_rover_boot_id=? WHERE id=?`).run(now, now, report.boot_id, missionId);
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

  function markInterrupted(missionId, reason, roverBootId = null) {
    const mission = missionRow(missionId);
    if (!mission || TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) return null;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
      db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason=?,updated_at=?,active_command_id=NULL,
        last_rover_boot_id=COALESCE(?,last_rover_boot_id) WHERE id=?`).run(reason, now, roverBootId, missionId);
      if (mission.active_command_id) {
        db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason=? WHERE id=? AND state='pending'`)
          .run(now, reason, mission.active_command_id);
      }
      recordEvent(missionId, "mission.interrupted", { roverBootId, before: { state: mission.lifecycle_state }, after: { state: "interrupted", reason } });
    })();
    return missionPublic(missionId);
  }

  function pendingCommands() {
    return db.prepare("SELECT * FROM mission_command WHERE state='pending' ORDER BY requested_at,id").all();
  }

  function reconcileRoverBoot(bootId) {
    const now = Date.now();
    const mismatched = db.prepare(`SELECT * FROM mission_command
      WHERE state='pending' AND action <> 'end' AND rover_boot_id IS NOT NULL AND rover_boot_id <> ?`).all(bootId);
    const activeRow = db.prepare(`SELECT * FROM mission WHERE lifecycle_state IN
      ('ready','starting','running','pausing','paused','interrupted','resuming')
      ORDER BY id DESC LIMIT 1`).get();
    const movingMissionRebooted = activeRow
      && ["starting", "running", "pausing", "resuming"].includes(activeRow.lifecycle_state)
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
          db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason='rover_rebooted',
            active_command_id=NULL,updated_at=?,last_rover_boot_id=? WHERE id=?`).run(now, bootId, mission.id);
          recordEvent(mission.id, "command.superseded", {
            commandId: command.id, roverBootId: bootId,
            before: { state: mission.lifecycle_state }, after: { state: "interrupted" },
            detail: { reason: "rover_rebooted" },
          });
          interruptedIds.add(mission.id);
        }
      }
      if (movingMissionRebooted && !interruptedIds.has(activeRow.id)) {
        db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason='rover_rebooted',
          active_command_id=NULL,updated_at=?,last_rover_boot_id=? WHERE id=?`).run(now, bootId, activeRow.id);
        recordEvent(activeRow.id, "mission.interrupted", {
          roverBootId: bootId,
          before: { state: activeRow.lifecycle_state, rover_boot_id: activeRow.last_rover_boot_id },
          after: { state: "interrupted", rover_boot_id: bootId },
          detail: { reason: "rover_rebooted" },
        });
      }
      return activeMission();
    })();
  }

  return {
    actorLabel,
    activeMission,
    applyReport,
    createMission,
    deletePreset,
    editRemaining,
    issueCommand,
    listPresets,
    markInterrupted,
    missionPublic,
    missionRow,
    pendingCommands,
    pendingWaypoints,
    reconcileRoverBoot,
    recordEvent,
    savePreset,
    waypointRows,
  };
}
