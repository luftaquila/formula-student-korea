import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { haversine } from "../shared/geo.mjs";

const ROVER_MAX_WAYPOINT_DIST_M = Number(process.env.ROVER_MAX_WAYPOINT_DIST_M) || 200;
const ROVER_MAX_SEGMENT_DIST_M = Number(process.env.ROVER_MAX_SEGMENT_DIST_M) || 50;
const ROVER_MIN_SEGMENT_DIST_M = 0.05;
const ROVER_MAX_PENDING_REQUESTS = 32;
const ROVER_POSITION_STALE_MS = 30 * 1000;

export function createCourseApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/course.db");

db.pragma("foreign_keys = ON");

db.exec(`CREATE TABLE IF NOT EXISTS course (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

db.exec(`CREATE TABLE IF NOT EXISTS cone (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('left', 'right', 'center')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_cone_course ON cone(course_id);`);

db.exec(`CREATE TABLE IF NOT EXISTS course_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  taken_at INTEGER NOT NULL,
  actor TEXT,
  reason TEXT,
  cones_json TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_course_snapshot ON course_snapshot(course_id, taken_at);`);

db.exec(`CREATE TABLE IF NOT EXISTS mission (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'interrupted', 'completed', 'stopped', 'error')) DEFAULT 'running',
  waypoints_json TEXT NOT NULL,
  current_waypoint_idx INTEGER NOT NULL DEFAULT 0,
  spray_results_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER,
  actor TEXT,
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE SET NULL
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_started ON mission(started_at);`);

db.exec(`CREATE TABLE IF NOT EXISTS mission_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL,
  t INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  fix_status TEXT,
  nav_state TEXT,
  FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_telemetry ON mission_telemetry(mission_id, t);`);

// 기존 DB 마이그레이션: side CHECK 제약에 'center' 추가
{
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cone'").get();
  if (info && !info.sql.includes("center")) {
    db.transaction(() => {
      db.exec(`CREATE TABLE cone_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('left', 'right', 'center')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
      )`);
      db.exec(`INSERT INTO cone_new SELECT * FROM cone`);
      db.exec(`DROP TABLE cone`);
      db.exec(`ALTER TABLE cone_new RENAME TO cone`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cone_course ON cone(course_id)`);
    })();
  }
}

// 기존 DB 마이그레이션: mission에 paused/interrupted 상태 + 진행상황 영속 컬럼
// (current_waypoint_idx, spray_results_json, updated_at) 추가. 이전 버전은 진행
// 인덱스를 in-memory로만 들고 있어 로버 SSE 끊김 한 번에 미션 진행이 통째로
// 유실됐다. 이제 DB에 영속화해 끊김/새로고침/서버 재시작에도 재개 가능.
{
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mission'").get();
  if (info && (!info.sql.includes("current_waypoint_idx") || !info.sql.includes("'interrupted'"))) {
    // CRITICAL: disable FK enforcement around the table rebuild. mission_telemetry
    // has `FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE`, so
    // `DROP TABLE mission` under foreign_keys=ON would cascade-delete the ENTIRE
    // telemetry history before the rename. PRAGMA foreign_keys cannot be toggled
    // inside a transaction, so we toggle it around the whole block — this is
    // exactly the procedure SQLite's docs prescribe for a rename-based rebuild of
    // a table that other tables reference. (The cone migration above is safe
    // without this only because nothing FK-references cone.)
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE mission_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course_id INTEGER,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'interrupted', 'completed', 'stopped', 'error')) DEFAULT 'running',
          waypoints_json TEXT NOT NULL,
          current_waypoint_idx INTEGER NOT NULL DEFAULT 0,
          spray_results_json TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER,
          actor TEXT,
          FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE SET NULL
        )`);
        db.exec(`INSERT INTO mission_new
                   (id, course_id, started_at, ended_at, status, waypoints_json, actor)
                 SELECT id, course_id, started_at, ended_at, status, waypoints_json, actor FROM mission`);
        db.exec(`DROP TABLE mission`);
        db.exec(`ALTER TABLE mission_new RENAME TO mission`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_started ON mission(started_at)`);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
}

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "course");

// Pre-compute INTERNAL_SECRET hash for timing-safe comparison
const internalSecret = process.env.INTERNAL_SECRET;
const cachedSecretHash = internalSecret
  ? crypto.createHash("sha256").update(internalSecret).digest()
  : null;

function isInternalRequest(req) {
  const header = req.headers["x-internal-service"];
  if (!cachedSecretHash || !header) return false;
  const headerHash = crypto.createHash("sha256").update(header).digest();
  return headerHash.length === cachedSecretHash.length && crypto.timingSafeEqual(headerHash, cachedSecretHash);
}

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  // Rover-only endpoints. /api/rover/stream is internal-strict — falling
  // back to "admin" let any logged-in operator open the SSE in a browser
  // and clobber the single roverClient slot, which silently kicked the
  // real rover off and routed subsequent calibrate-* events to the
  // browser response. Symptom on the operator side: cal start button
  // does nothing despite RTK-fixed + IDLE. Internal-only closes the door.
  if (
    req.path === "/api/rover/stream" ||
    // Camera control SSE + frame upload are rover→server only. Internal-strict
    // (deny browsers) for the same reason as /stream: a browser must not be
    // able to occupy the single camera-control slot or inject frames.
    req.path === "/api/rover/camera/control" ||
    req.path === "/api/rover/camera"
  ) {
    return isInternalRequest(req) ? null : "deny";
  }
  if (
    req.path === "/api/rover/position" ||
    req.path === "/api/rover/telemetry" ||
    req.path === "/api/rover/waypoint_reached" ||
    req.path === "/api/rover/waypoint_skipped" ||
    req.path === "/api/rover/spray_result" ||
    req.path === "/api/rover/antenna_calibration_result" ||
    req.path === "/api/rover/wheel_calibration_result" ||
    req.path === "/api/rover/logs"
  ) {
    return isInternalRequest(req) ? null : "admin";
  }
  return "admin";
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

function getCourses() {
  return db.prepare(`
    SELECT c.id, c.name, c.created_at, c.updated_at,
           COUNT(cn.id) AS cone_count
    FROM course c
    LEFT JOIN cone cn ON cn.course_id = c.id
    GROUP BY c.id
    ORDER BY c.id
  `).all();
}

function getCones(courseId) {
  return db.prepare("SELECT * FROM cone WHERE course_id = ? ORDER BY id").all(courseId);
}

app.get("/api/events", sseHandler(() => ({ courses: getCourses() })));

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateCourseName(name) {
  if (name === undefined || name === null || typeof name !== "string" || name.trim() === "") {
    return { valid: false, error: "코스 이름이 비어 있습니다." };
  }
  const trimmed = name.trim();
  if (trimmed.length > 100) {
    return { valid: false, error: "코스 이름이 너무 깁니다. (최대 100자)" };
  }
  return { valid: true, value: trimmed };
}

function validateCoordinate(lat, lng) {
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { valid: false, error: "위도가 올바르지 않습니다. (-90 ~ 90)" };
  }
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { valid: false, error: "경도가 올바르지 않습니다. (-180 ~ 180)" };
  }
  return { valid: true };
}

function validateSide(side) {
  if (side !== "left" && side !== "right" && side !== "center") {
    return { valid: false, error: "콘 방향이 올바르지 않습니다. (left, right 또는 center)" };
  }
  return { valid: true };
}

function getCourseById(id) {
  return db.prepare("SELECT * FROM course WHERE id = ?").get(id);
}

function getConeById(id) {
  return db.prepare("SELECT * FROM cone WHERE id = ?").get(id);
}

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   API 라우트: /api/courses
   ============================================ */

// GET /api/courses - 코스 목록 조회
app.get("/api/courses", (req, res) => {
  const result = dbRun(() => getCourses());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/courses - 코스 생성
app.post("/api/courses", (req, res) => {
  const validation = validateCourseName(req.body.name);
  if (!validation.valid) return res.status(400).send(validation.error);

  const result = dbRun(() => {
    db.prepare("INSERT INTO course (name) VALUES (?)").run(validation.value);
    return db.prepare("SELECT * FROM course WHERE id = last_insert_rowid()").get();
  });

  if (!result.success) {
    if (result.error?.includes("UNIQUE")) {
      logger.warn(req, "course.create", { error: result.error }, validation.value);
      return res.status(400).send("이미 존재하는 코스 이름입니다.");
    }
    logger.warn(req, "course.create", { error: result.error }, validation.value);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.create", null, validation.value);
  broadcastEvent("courses", { type: "create", course: result.result, courses: getCourses() });
  res.status(201).json(result.result);
});

// PATCH /api/courses/:id - 코스 이름 수정
app.patch("/api/courses/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const validation = validateCourseName(req.body.name);
  if (!validation.valid) return res.status(400).send(validation.error);

  const result = dbRun(() => {
    db.prepare("UPDATE course SET name = ?, updated_at = datetime('now') WHERE id = ?").run(validation.value, id);
    return db.prepare("SELECT * FROM course WHERE id = ?").get(id);
  });

  if (!result.success) {
    if (result.error?.includes("UNIQUE")) {
      logger.warn(req, "course.rename", { error: result.error }, course.name);
      return res.status(400).send("이미 존재하는 코스 이름입니다.");
    }
    logger.warn(req, "course.rename", { error: result.error }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.rename", { before: course.name, after: validation.value }, course.name);
  broadcastEvent("courses", { type: "rename", course: result.result, courses: getCourses() });
  res.json(result.result);
});

// GET /api/courses/:id/export - 코스 JSON 다운로드
app.get("/api/courses/:id/export", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const cones = getCones(id);
  const data = {
    name: course.name,
    cones: cones.map((c) => ({ lat: c.lat, lng: c.lng, side: c.side })),
  };

  logger.log(req, "course.export", { cone_count: cones.length }, course.name);

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(course.name)}.json"`);
  res.json(data);
});

/* ============================================
   API 라우트: /api/courses/:id/snapshots
   ============================================ */

const insertSnapshot = db.prepare(
  "INSERT INTO course_snapshot (course_id, taken_at, actor, reason, cones_json) VALUES (?, ?, ?, ?, ?)"
);
const selectSnapshotsForCourse = db.prepare(
  `SELECT id, course_id, taken_at, actor, reason,
          json_array_length(cones_json) AS cone_count
   FROM course_snapshot WHERE course_id = ? ORDER BY taken_at DESC LIMIT 100`
);
const selectSnapshotById = db.prepare(
  "SELECT id, course_id, taken_at, actor, reason, cones_json FROM course_snapshot WHERE id = ?"
);

function takeCourseSnapshot(courseId, actor, reason) {
  const cones = getCones(courseId);
  if (cones.length === 0) return null;
  const simplified = cones.map((c) => ({ lat: c.lat, lng: c.lng, side: c.side }));
  const info = insertSnapshot.run(courseId, Date.now(), actor || null, reason || null, JSON.stringify(simplified));
  return Number(info.lastInsertRowid);
}

app.get("/api/courses/:id/snapshots", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");
  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");
  res.json({ snapshots: selectSnapshotsForCourse.all(id) });
});

app.post("/api/courses/:id/snapshots", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");
  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");
  const cones = getCones(id);
  if (cones.length === 0) return res.status(400).send("콘이 없는 코스는 스냅샷할 수 없습니다.");

  const actor = req.user ? `${req.user.name || ""} <${req.user.email || ""}>` : null;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : null;

  const result = dbRun(() => takeCourseSnapshot(id, actor, reason));
  if (!result.success) {
    logger.warn(req, "course.snapshot.create", { error: result.error }, course.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "course.snapshot.create", { snapshot_id: result.result, cone_count: cones.length, reason }, course.name);
  res.status(201).json({ id: result.result });
});

app.post("/api/courses/:id/snapshots/:sid/restore", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sid = parseInt(req.params.sid, 10);
  if (isNaN(id) || isNaN(sid)) return res.status(400).send("올바르지 않은 ID입니다.");
  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");
  const snap = selectSnapshotById.get(sid);
  if (!snap || snap.course_id !== id) return res.status(404).send("스냅샷을 찾을 수 없습니다.");

  let cones;
  try { cones = JSON.parse(snap.cones_json); }
  catch { return res.status(500).send("스냅샷 데이터가 손상되었습니다."); }
  if (!Array.isArray(cones)) return res.status(500).send("스냅샷 데이터가 손상되었습니다.");

  const actor = req.user ? `${req.user.name || ""} <${req.user.email || ""}>` : null;
  // Auto-snapshot current state as a safety net before overwriting.
  const safetyReason = `pre-restore of #${sid}`;
  const result = dbRun(() => {
    return db.transaction(() => {
      takeCourseSnapshot(id, actor, safetyReason);
      db.prepare("DELETE FROM cone WHERE course_id = ?").run(id);
      const insert = db.prepare("INSERT INTO cone (course_id, lat, lng, side) VALUES (?, ?, ?, ?)");
      for (const c of cones) insert.run(id, c.lat, c.lng, c.side);
      return getCones(id);
    })();
  });
  if (!result.success) {
    logger.warn(req, "course.snapshot.restore", { error: result.error, snapshot_id: sid }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.snapshot.restore", { snapshot_id: sid, cone_count: cones.length }, course.name);
  broadcastEvent("cones", { type: "restore", courseId: id, cones: result.result });
  res.json({ cones: result.result });
});

// POST /api/courses/import - JSON으로 코스 추가
app.post("/api/courses/import", (req, res) => {
  const { name, cones } = req.body;

  const nameValidation = validateCourseName(name);
  if (!nameValidation.valid) {
    logger.warn(req, "course.import", nameValidation.error, name);
    return res.status(400).send(nameValidation.error);
  }

  if (!Array.isArray(cones)) {
    logger.warn(req, "course.import", "올바르지 않은 콘 데이터입니다.", name);
    return res.status(400).send("올바르지 않은 콘 데이터입니다.");
  }

  for (const cone of cones) {
    const cv = validateCoordinate(cone.lat, cone.lng);
    if (!cv.valid) {
      logger.warn(req, "course.import", cv.error, name);
      return res.status(400).send(cv.error);
    }
    const sv = validateSide(cone.side);
    if (!sv.valid) {
      logger.warn(req, "course.import", sv.error, name);
      return res.status(400).send(sv.error);
    }
  }

  const result = dbRun(() => {
    return db.transaction(() => {
      db.prepare("INSERT INTO course (name) VALUES (?)").run(nameValidation.value);
      const courseId = db.prepare("SELECT id FROM course WHERE id = last_insert_rowid()").get().id;
      const insert = db.prepare("INSERT INTO cone (course_id, lat, lng, side) VALUES (?, ?, ?, ?)");
      for (const cone of cones) insert.run(courseId, cone.lat, cone.lng, cone.side);
      return { course: db.prepare("SELECT * FROM course WHERE id = ?").get(courseId), cones: getCones(courseId) };
    })();
  });

  if (!result.success) {
    const msg = result.error?.includes("UNIQUE") ? "이미 존재하는 코스 이름입니다." : result.error;
    logger.warn(req, "course.import", msg, name);
    if (result.error?.includes("UNIQUE")) return res.status(400).send("이미 존재하는 코스 이름입니다.");
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.import", { cone_count: cones.length }, nameValidation.value);
  broadcastEvent("courses", { type: "create", course: result.result.course, courses: getCourses() });
  broadcastEvent("cones", { type: "add", courseId: result.result.course.id, cones: result.result.cones });
  res.status(201).json(result.result.course);
});

// DELETE /api/courses/:id - 코스 삭제 (콘도 CASCADE 삭제)
app.delete("/api/courses/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const result = dbRun(() => db.prepare("DELETE FROM course WHERE id = ?").run(id));
  if (!result.success) {
    logger.warn(req, "course.delete", { error: result.error }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.delete", null, course.name);
  broadcastEvent("courses", { type: "delete", courseId: id, courses: getCourses() });
  res.status(200).send();
});

/* ============================================
   API 라우트: /api/courses/:id/cones
   ============================================ */

// GET /api/courses/:id/cones - 코스의 콘 목록 조회
app.get("/api/courses/:id/cones", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const result = dbRun(() => getCones(id));
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/courses/:id/cones - 콘 추가
app.post("/api/courses/:id/cones", (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  if (isNaN(courseId)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(courseId);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const { lat, lng, side } = req.body;

  const coordValidation = validateCoordinate(lat, lng);
  if (!coordValidation.valid) return res.status(400).send(coordValidation.error);

  const sideValidation = validateSide(side);
  if (!sideValidation.valid) return res.status(400).send(sideValidation.error);

  const result = dbRun(() => {
    db.prepare("INSERT INTO cone (course_id, lat, lng, side) VALUES (?, ?, ?, ?)").run(courseId, lat, lng, side);
    return db.prepare("SELECT * FROM cone WHERE id = last_insert_rowid()").get();
  });

  if (!result.success) {
    logger.warn(req, "cone.create", { error: result.error }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "cone.create", { lat, lng, side }, course.name);
  broadcastEvent("cones", { type: "add", courseId, cone: result.result, cones: getCones(courseId) });
  res.status(201).json(result.result);
});

/* ============================================
   API 라우트: /api/cones/:id
   ============================================ */

// PATCH /api/cones/:id - 콘 수정 (위치, 방향)
app.patch("/api/cones/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 콘 ID입니다.");

  const cone = getConeById(id);
  if (!cone) return res.status(404).send("콘을 찾을 수 없습니다.");

  const setClauses = [];
  const values = [];

  if (req.body.lat !== undefined || req.body.lng !== undefined) {
    const lat = req.body.lat !== undefined ? req.body.lat : cone.lat;
    const lng = req.body.lng !== undefined ? req.body.lng : cone.lng;
    const coordValidation = validateCoordinate(lat, lng);
    if (!coordValidation.valid) return res.status(400).send(coordValidation.error);
    if (req.body.lat !== undefined) { setClauses.push("lat = ?"); values.push(lat); }
    if (req.body.lng !== undefined) { setClauses.push("lng = ?"); values.push(lng); }
  }

  if (req.body.side !== undefined) {
    const sideValidation = validateSide(req.body.side);
    if (!sideValidation.valid) return res.status(400).send(sideValidation.error);
    setClauses.push("side = ?"); values.push(req.body.side);
  }

  if (setClauses.length === 0) {
    return res.status(400).send("수정할 필드가 없습니다.");
  }

  setClauses.push("updated_at = datetime('now')");

  const result = dbRun(() => {
    values.push(id);
    db.prepare(`UPDATE cone SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    return db.prepare("SELECT * FROM cone WHERE id = ?").get(id);
  });

  if (!result.success) {
    const updateCourse = getCourseById(cone.course_id);
    logger.warn(req, "cone.update", { error: result.error }, updateCourse?.name);
    return res.status(result.status).send(result.error);
  }

  const updateCourse = getCourseById(cone.course_id);
  logger.log(req, "cone.update", { before: { lat: cone.lat, lng: cone.lng, side: cone.side }, after: { lat: result.result.lat, lng: result.result.lng, side: result.result.side } }, updateCourse?.name);
  broadcastEvent("cones", { type: "update", courseId: cone.course_id, cone: result.result, cones: getCones(cone.course_id) });
  res.json(result.result);
});

// DELETE /api/cones/:id - 콘 삭제
app.delete("/api/cones/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 콘 ID입니다.");

  const cone = getConeById(id);
  if (!cone) return res.status(404).send("콘을 찾을 수 없습니다.");

  const result = dbRun(() => db.prepare("DELETE FROM cone WHERE id = ?").run(id));
  if (!result.success) {
    const delCourse = getCourseById(cone.course_id);
    logger.warn(req, "cone.delete", { error: result.error }, delCourse?.name);
    return res.status(result.status).send(result.error);
  }

  const delCourse = getCourseById(cone.course_id);
  logger.log(req, "cone.delete", { lat: cone.lat, lng: cone.lng, side: cone.side }, delCourse?.name);
  broadcastEvent("cones", { type: "delete", courseId: cone.course_id, coneId: id, cones: getCones(cone.course_id) });
  res.status(200).send();
});

/* ============================================
   API 라우트: /api/rover
   ============================================ */

let roverClient = null;
const roverPendingResolves = [];
let lastRoverPosition = null; // { lat, lng, at: epoch ms }

// Nav states in which the rover OWNS the velocity stream (actively executing a
// mission). Mirrors navigator_node's State enum and the web ACTIVE_NAV_STATES.
// Used to tell "rover is still driving the mission" from "rover went idle".
const ACTIVE_NAV_STATES = new Set([
  "CALIBRATING", "CAL_ANTENNA", "CAL_WHEELS", "NAVIGATING", "SETTLING", "SPRAYING",
]);

// Active mission tracking
const insertMission = db.prepare(
  "INSERT INTO mission (course_id, started_at, waypoints_json, actor) VALUES (?, ?, ?, ?)"
);
// Terminal transition. Allowed from any non-terminal state (running/paused/
// interrupted) so an operator can end a paused/interrupted mission, and a
// superseding execute can close a still-open prior one.
const finishMission = db.prepare(
  "UPDATE mission SET ended_at = ?, status = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'paused', 'interrupted')"
);
// Non-terminal status change (running ⇄ paused ⇄ interrupted), no ended_at.
const setMissionStatus = db.prepare(
  "UPDATE mission SET status = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'paused', 'interrupted')"
);
// Persist in-flight progress so a disconnect / reload / server restart can
// rebuild the executing view and resume from the right waypoint.
const persistMissionProgress = db.prepare(
  "UPDATE mission SET current_waypoint_idx = ?, spray_results_json = ?, updated_at = ? WHERE id = ?"
);
const insertTelemetry = db.prepare(
  "INSERT INTO mission_telemetry (mission_id, t, lat, lng, fix_status, nav_state) VALUES (?, ?, ?, ?, ?, ?)"
);

let currentMissionId = null;

// Recover from unclean shutdowns: a row left 'running' means the server died
// mid-mission. The rover keeps driving on its own (it already has the
// waypoints) and will reconnect, so the mission is NOT lost — mark it
// 'interrupted' (resumable) rather than terminal 'error'. The persisted
// current_waypoint_idx lets the operator resume, and the boot re-adopt below
// reloads it into memory so the reconnecting rover stays attached to it.
const orphanRecoveryResult = db.prepare(
  `UPDATE mission SET status = 'interrupted', updated_at = ? WHERE status = 'running'`
).run(Date.now());
if (orphanRecoveryResult.changes > 0) {
  logger.log(null, "mission.orphan_recovery", { count: orphanRecoveryResult.changes }, "rover",
    { email: "system", name: "boot", role: "admin" });
}

function startMission(waypoints, actor, courseId) {
  // Close any still-open prior mission as stopped.
  if (currentMissionId != null) {
    logger.warn(null, "mission.end.superseded", { mission_id: currentMissionId }, "rover");
    finishMission.run(Date.now(), "stopped", Date.now(), currentMissionId);
  }
  const info = insertMission.run(
    courseId || null,
    Date.now(),
    JSON.stringify(waypoints),
    actor || null,
  );
  currentMissionId = Number(info.lastInsertRowid);
  roverState.mission_progress = {
    mission_id: currentMissionId,
    waypoints,
    current_waypoint_idx: 0,
    spray_results: {},
    status: "running",
  };
}

function endMission(status) {
  if (currentMissionId == null) return;
  finishMission.run(Date.now(), status, Date.now(), currentMissionId);
  currentMissionId = null;
  roverState.mission_progress = {
    mission_id: null,
    waypoints: [],
    current_waypoint_idx: 0,
    spray_results: {},
    status: null,
  };
}

// Persist the in-flight waypoint index + spray results to the DB so a rover
// disconnect, a UI reload, or a server restart can rebuild the executing view
// and resume from the right place. Cheap; called on every progress event.
function persistProgress() {
  if (currentMissionId == null) return;
  const mp = roverState.mission_progress;
  persistMissionProgress.run(
    mp.current_waypoint_idx || 0,
    JSON.stringify(mp.spray_results || {}),
    Date.now(),
    currentMissionId,
  );
}

// The rover SSE dropped (or the server is shutting down) mid-mission. The rover
// keeps driving autonomously and will reconnect, so we do NOT end the mission —
// we flag it 'interrupted' (resumable) and keep currentMissionId +
// mission_progress in memory. The next telemetry showing an active nav_state
// flips it back to 'running' (see /api/rover/telemetry).
//
// A mission that was operator-'paused' stays 'paused' across the drop: the rover
// is holding in PAUSED and is still resumable in place via /api/rover/resume, so
// we must not downgrade it to 'interrupted' (that would make the UI's 재개 button
// 409 against the paused-only resume guard). Only a 'running' mission interrupts.
function interruptMission() {
  if (currentMissionId == null) return;
  persistProgress();
  if (roverState.mission_progress.status === "running") {
    setMissionStatus.run("interrupted", Date.now(), currentMissionId);
    roverState.mission_progress.status = "interrupted";
  }
}

function recordTelemetrySample() {
  if (currentMissionId == null) return;
  const pos = roverState.last_position;
  insertTelemetry.run(
    currentMissionId,
    Date.now(),
    pos ? pos.lat : null,
    pos ? pos.lng : null,
    roverState.fix_status,
    roverState.nav_state,
  );
}
const roverState = {
  connected: false,
  last_position: null,
  last_position_at: 0,
  fix_status: null,
  fix_status_at: 0,
  nav_state: null,
  ntrip_connected: null,
  // Nav-light pattern: 0=off 1=steady 2=double-strobe 3=single-strobe 4=50% blink.
  // Operator-selected; persisted here and re-sent to the rover on (re)connect.
  nav_lights_mode: 2,
  // Status-LED (WS2812) global brightness scale 0-255. Same persist/re-send.
  led_brightness: 255,
  last_disconnect_reason: null, // "sse_closed" | "write_failed" | "replaced"
  last_disconnect_at: 0,
  last_spray_result: null, // { waypoint, outcome, at }
  // Most recent antenna offset calibration outcome — surfaced in the UI so
  // the chief can see whether the persisted offset on the rover matches
  // what they just measured / whether a recent attempt failed (and why).
  // { ok, a_x, a_y, rms_residual_m, samples, drive_distance_m, calibrated_at, reason }
  antenna_calibration: null,
  // Most recent wheel scale calibration outcome.
  // { ok, scale_l, scale_r, gps_distance_m, encoder_left_m, encoder_right_m, samples, calibrated_at, reason }
  wheel_calibration: null,
  battery: null, // { voltage, percent, source }
  ntrip: null, // { host, port, mountpoint, fail_count, last_error, last_correction_at, bytes_received }
  gps: null, // { h_acc, v_acc, altitude, speed, heading, num_sv, pdop, tdop } from rover GPS metrics
  // Session-scoped per-mission progress used for tab-close recovery — the
  // server acts as the source of truth so reloading the UI rebuilds the
  // executing/stopped view exactly.
  mission_progress: {
    mission_id: null,
    waypoints: [],          // last waypoint set broadcast to the rover
    current_waypoint_idx: 0, // 1-based: count of waypoints reached so far
    spray_results: {},      // { [waypointIndex]: outcome }
    // running | paused | interrupted | null. Lets the UI distinguish an
    // operator pause from a connection interruption, and gates auto-complete.
    status: null,
  },
  updated_at: 0,
};

// Boot re-adopt: if a mission was left open (interrupted by an unclean shutdown,
// or paused) reload it into memory. The rover keeps driving and reconnects, so
// the server must stay attached to the same mission_id; and the UI rebuilds the
// in-flight overlay from mission_progress on first status fetch. Newest wins.
{
  const open = db.prepare(
    `SELECT id, waypoints_json, current_waypoint_idx, spray_results_json, status
     FROM mission WHERE status IN ('interrupted', 'paused') ORDER BY id DESC LIMIT 1`
  ).get();
  if (open) {
    let waypoints = [];
    let spray = {};
    try { waypoints = JSON.parse(open.waypoints_json); } catch { /* leave [] */ }
    try { spray = JSON.parse(open.spray_results_json); } catch { /* leave {} */ }
    currentMissionId = open.id;
    roverState.mission_progress = {
      mission_id: open.id,
      waypoints: Array.isArray(waypoints) ? waypoints : [],
      current_waypoint_idx: open.current_waypoint_idx || 0,
      spray_results: spray && typeof spray === "object" ? spray : {},
      status: open.status,
    };
  }
}

function broadcastRoverStatus() {
  roverState.updated_at = Date.now();
  broadcastEvent("rover:status", { ...roverState });
}

function markRoverDisconnected(reason) {
  if (roverState.connected) {
    roverState.last_disconnect_reason = reason;
    roverState.last_disconnect_at = Date.now();
  }
  roverState.connected = false;
}

function rejectNoRover(req, res, action, extra = {}) {
  logger.warn(req, action, { error: "not_connected", ...extra }, "rover");
  return res.status(503).send("로버가 연결되어 있지 않습니다.");
}

// GET /api/rover/stream - 로버 SSE 연결 (로버가 호출)
app.get("/api/rover/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");

  // 기존 연결이 있으면 종료(중복 스트림 방지). 진행 중이던 미션은 폐기하지
  // 않는다 — 로버는 끊겼다 재연결하는 동안에도 받은 waypoint로 자율 주행을
  // 계속하므로, 새 세션이 같은 미션을 그대로 이어받는다. (이전 동작은 여기서
  // endMission('error')로 미션을 통째로 버려, wifi 블립/pilot 재시작 한 번에
  // 진행상황이 사라지는 원인이었다.)
  if (roverClient && roverClient !== res) {
    // Session takeover — leave an audit trail (the old endMission path used to
    // log this; the mission itself is intentionally preserved for the new
    // session to inherit). The replaced connection's own req.on('close') can't
    // log it: roverClient has already been reassigned by then, so its
    // `roverClient === res` guard is false.
    logger.warn(req, "rover.stream.replaced", { mission_id: currentMissionId }, "rover");
    markRoverDisconnected("replaced");
    try { roverClient.end(); } catch {}
  }
  roverClient = res;
  roverState.connected = true;
  roverState.last_disconnect_reason = null;
  roverState.last_disconnect_at = 0;
  broadcastRoverStatus();

  // Re-apply the operator's nav-light choice so it survives a pilot restart.
  if (roverState.nav_lights_mode != null) {
    sendRoverEvent("nav-lights", { mode: roverState.nav_lights_mode });
  }
  if (roverState.led_brightness != null) {
    sendRoverEvent("led-brightness", { brightness: roverState.led_brightness });
  }

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch {}
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (roverClient === res) {
      roverClient = null;
      markRoverDisconnected("sse_closed");
      // The rover dropped off mid-mission. It keeps driving on its own and
      // will reconnect, so DON'T end the mission — flag it 'interrupted'
      // (resumable) and keep the persisted progress. The reconnecting rover's
      // first active telemetry flips it back to 'running'. This is what makes
      // the mission survive a wifi blip / pilot auto-update restart / reload.
      if (currentMissionId != null) {
        interruptMission();
        logger.warn(req, "mission.interrupted", { mission_id: currentMissionId, reason: "sse_disconnect" }, "rover");
      }
      broadcastRoverStatus();
    }
  });
});

// POST /api/rover/position - 로버가 현재 위치 전송 (로버가 호출)
app.post("/api/rover/position", (req, res) => {
  const { lat, lng, request_id, request_ids } = req.body;
  const coordValidation = validateCoordinate(lat, lng);
  if (!coordValidation.valid) return res.status(400).send(coordValidation.error);

  lastRoverPosition = { lat, lng, at: Date.now() };
  roverState.last_position = { lat, lng };
  roverState.last_position_at = lastRoverPosition.at;

  // Resolve only the matching explicit admin request. Periodic rover
  // position POSTs intentionally do not drain this queue.
  const ids = Array.isArray(request_ids) ? request_ids : [request_id];
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue;
    const idx = roverPendingResolves.findIndex((entry) => entry.request_id === id);
    if (idx !== -1) {
      const [{ resolve }] = roverPendingResolves.splice(idx, 1);
      resolve({ lat, lng });
    }
  }

  // Telemetry sample for active mission
  if (currentMissionId != null) recordTelemetrySample();

  broadcastEvent("rover", { lat, lng });
  broadcastRoverStatus();
  res.json({ lat, lng });
});

// POST /api/rover/telemetry - 로버 상태 텔레메트리 (internal)
app.post("/api/rover/telemetry", (req, res) => {
  const { nav_state, fix_status, ntrip_connected, battery, ntrip, gps } = req.body || {};
  const now = Date.now();
  const prevNav = roverState.nav_state;
  if (typeof nav_state === "string") roverState.nav_state = nav_state;
  if (typeof fix_status === "string") {
    roverState.fix_status = fix_status;
    roverState.fix_status_at = now;
  }
  // Distinguish "not reported" (null/undefined) from "reported disconnected" (false).
  // When the rover explicitly says it's not connected, drop the cached detail
  // too — otherwise a previous boot's mountpoint + last_correction_at lingers
  // forever in memory and the UI keeps rendering it as a stale "보정 N s 전".
  if (typeof ntrip_connected === "boolean") {
    roverState.ntrip_connected = ntrip_connected;
    if (ntrip_connected === false) roverState.ntrip = null;
  }
  if (battery && typeof battery === "object") {
    roverState.battery = {
      voltage: typeof battery.voltage === "number" ? battery.voltage : null,
      voltage_raw: typeof battery.voltage_raw === "number" ? battery.voltage_raw : null,
      percent: Number.isInteger(battery.percent) ? battery.percent : null,
      source: typeof battery.source === "string" ? battery.source : null,
      gain: typeof battery.gain === "number" ? battery.gain : null,
      measured_v: typeof battery.measured_v === "number" ? battery.measured_v : null,
      calibrated_at: Number.isInteger(battery.calibrated_at) ? battery.calibrated_at : null,
      // Raw MCU status flag bitfield (T-frame flags 7). Lets the UI decode the
      // exact fault behind an ERROR / EMERGENCY_STOP chip — e-stop source,
      // undervolt, heartbeat timeout, nav-GPS-lost — the same conditions the
      // MCU status LED encodes by colour.
      flags: Number.isInteger(battery.flags) ? battery.flags : null,
    };
  }
  if (gps && typeof gps === "object" && !Array.isArray(gps)) {
    roverState.gps = {
      h_acc: typeof gps.h_acc === "number" ? gps.h_acc : null,
      v_acc: typeof gps.v_acc === "number" ? gps.v_acc : null,
      altitude: typeof gps.altitude === "number" ? gps.altitude : null,
      speed: typeof gps.speed === "number" ? gps.speed : null,
      heading: typeof gps.heading === "number" ? gps.heading : null,
      num_sv: Number.isInteger(gps.num_sv) ? gps.num_sv : null,
      pdop: typeof gps.pdop === "number" ? gps.pdop : null,
      tdop: typeof gps.tdop === "number" ? gps.tdop : null,
    };
  }
  if (ntrip && typeof ntrip === "object" && !Array.isArray(ntrip)) {
    roverState.ntrip = {
      host: typeof ntrip.host === "string" ? ntrip.host.slice(0, 128) : null,
      port: Number.isInteger(ntrip.port) ? ntrip.port : null,
      mountpoint: typeof ntrip.mountpoint === "string" ? ntrip.mountpoint.slice(0, 64) : null,
      fail_count: Number.isInteger(ntrip.fail_count) ? ntrip.fail_count : null,
      last_error: typeof ntrip.last_error === "string" ? ntrip.last_error.slice(0, 256) : null,
      last_correction_at: typeof ntrip.last_correction_at === "number" ? ntrip.last_correction_at : null,
      bytes_received: Number.isInteger(ntrip.bytes_received) ? ntrip.bytes_received : null,
    };
  }

  // Mission auto-resumed from an INTERRUPTED state: a rover that dropped mid-
  // mission and is reporting an active nav state again has clearly resumed
  // driving on its own — flip it back to 'running'. This also guards the
  // natural-completion check below: a rover that reconnected IDLE after a
  // reboot must NOT be auto-completed.
  //
  // 'paused' is deliberately NOT auto-flipped here: an operator pause is only
  // released by /api/rover/resume (which also commands the rover). A stray
  // active-nav telemetry frame arriving in the gap between the pause command
  // and the rover actually leaving NAVIGATING must not silently un-pause it.
  if (currentMissionId != null
      && roverState.mission_progress.status === "interrupted"
      && ACTIVE_NAV_STATES.has(nav_state)) {
    setMissionStatus.run("running", Date.now(), currentMissionId);
    roverState.mission_progress.status = "running";
    logger.log(req, "mission.resumed", { mission_id: currentMissionId, nav_state }, "rover");
  }

  // Mission lifecycle: end on natural completion (driving → IDLE) or rover ERROR.
  // EMERGENCY_STOP is operator-acknowledged and *preserves* the mission across
  // the clear-emergency → IDLE transition so "이어서 실행" remains available.
  // Only auto-end a mission we believe is actively 'running' — an 'interrupted'
  // mission going IDLE (e.g. rover rebooted) stays resumable instead of being
  // falsely marked completed/error from a stale prevNav.
  // Operator must explicitly abandon via /api/rover/end-mission to commit.
  if (prevNav && prevNav !== "IDLE" && prevNav !== "EMERGENCY_STOP"
      && nav_state === "IDLE" && currentMissionId != null
      && roverState.mission_progress.status === "running") {
    const endStatus = prevNav === "ERROR" ? "error" : "completed";
    const endedId = currentMissionId;
    endMission(endStatus);
    if (endStatus === "completed") {
      logger.log(req, "mission.end.completed", { mission_id: endedId, prevNav }, "rover");
    } else {
      logger.warn(req, "mission.end.error", { mission_id: endedId, prevNav }, "rover");
    }
  }
  if (currentMissionId != null) recordTelemetrySample();

  broadcastRoverStatus();
  res.json({ ok: true });
});

// GET /api/rover/status - 로버 상태 스냅샷 (admin)
app.get("/api/rover/status", (req, res) => {
  res.json({ ...roverState });
});

// POST /api/rover/waypoint_reached - 로버가 웨이포인트 도달 알림 (internal)
app.post("/api/rover/waypoint_reached", (req, res) => {
  const index = Number(req.body?.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).send("올바르지 않은 waypoint index입니다.");
  }
  // 미션 자동 종료(driving→IDLE) 직후 늦게 도착할 수 있다. 진행 인덱스만
  // 전진시키는 이벤트라 종료 후엔 의미가 없으므로 에러 대신 no-op 처리한다.
  if (currentMissionId == null) {
    return res.json({ ok: true });
  }
  if (index >= roverState.mission_progress.waypoints.length) {
    logger.warn(req, "rover.waypoint_reached", { index, error: "index_out_of_range" }, "rover");
    return res.status(400).send("waypoint index가 현재 미션 범위를 벗어났습니다.");
  }
  // Monotonic: never regress current_waypoint_idx so late or duplicate events
  // from SSE reconnects can't walk progress backwards.
  if (index + 1 > roverState.mission_progress.current_waypoint_idx) {
    roverState.mission_progress.current_waypoint_idx = index + 1;
  }
  persistProgress();
  broadcastEvent("rover:waypoint", { index });
  res.json({ ok: true });
});

/* ============================================
   API 라우트: /api/missions (미션 이력)
   ============================================ */

const MISSION_LIST_MAX_LIMIT = 500;
const MISSION_LIST_DEFAULT_LIMIT = 50;
const selectMissions = db.prepare(
  `SELECT m.id, m.course_id, c.name AS course_name, m.started_at, m.ended_at, m.status, m.actor,
          (SELECT COUNT(*) FROM mission_telemetry t WHERE t.mission_id = m.id) AS sample_count
   FROM mission m LEFT JOIN course c ON c.id = m.course_id
   ORDER BY m.started_at DESC LIMIT ? OFFSET ?`
);
const countMissions = db.prepare("SELECT COUNT(*) AS cnt FROM mission");
const selectMissionById = db.prepare(
  `SELECT m.id, m.course_id, c.name AS course_name, m.started_at, m.ended_at, m.status,
          m.waypoints_json, m.actor
   FROM mission m LEFT JOIN course c ON c.id = m.course_id WHERE m.id = ?`
);
const selectMissionTelemetry = db.prepare(
  "SELECT t, lat, lng, fix_status, nav_state FROM mission_telemetry WHERE mission_id = ? ORDER BY t"
);

app.get("/api/missions", (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || MISSION_LIST_DEFAULT_LIMIT, MISSION_LIST_MAX_LIMIT));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = selectMissions.all(limit, offset);
  const total = countMissions.get().cnt;
  res.json({ missions: rows, total, limit, offset });
});

app.get("/api/missions/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send("올바르지 않은 id입니다.");
  const mission = selectMissionById.get(id);
  if (!mission) return res.status(404).send("미션을 찾을 수 없습니다.");
  let waypoints = [];
  try { waypoints = JSON.parse(mission.waypoints_json); } catch { /* ignore */ }
  res.json({
    id: mission.id,
    course_id: mission.course_id,
    course_name: mission.course_name,
    started_at: mission.started_at,
    ended_at: mission.ended_at,
    status: mission.status,
    actor: mission.actor,
    waypoints,
  });
});

app.get("/api/missions/:id/telemetry", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send("올바르지 않은 id입니다.");
  const mission = selectMissionById.get(id);
  if (!mission) return res.status(404).send("미션을 찾을 수 없습니다.");
  const samples = selectMissionTelemetry.all(id);
  res.json({ samples });
});

// Rover log cache — in-memory only. Filled by rover POST, drained by admin GET.
const MAX_ROVER_LOG_ENTRIES = 1000;
let roverLogCache = { entries: [], uploaded_at: 0 };

// POST /api/rover/logs - 로버 로그 업로드 (internal)
app.post("/api/rover/logs", (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!entries) return res.status(400).send("올바르지 않은 로그 데이터입니다.");
  const sanitized = entries
    .filter((e) => e && typeof e === "object")
    .slice(-MAX_ROVER_LOG_ENTRIES)
    .map((e) => ({
      t: Number(e.t) || 0,
      level: typeof e.level === "string" ? e.level.slice(0, 10) : "",
      node: typeof e.node === "string" ? e.node.slice(0, 64) : "",
      msg: typeof e.msg === "string" ? e.msg.slice(0, 2000) : "",
    }));
  roverLogCache = { entries: sanitized, uploaded_at: Date.now() };
  broadcastEvent("rover:logs", { count: sanitized.length, uploaded_at: roverLogCache.uploaded_at });
  res.json({ ok: true, stored: sanitized.length });
});

// GET /api/rover/logs - 최근 업로드된 로그 조회 (admin)
app.get("/api/rover/logs", (req, res) => {
  res.json(roverLogCache);
});

// POST /api/rover/logs/fetch - 로버에 로그 업로드 요청 (admin → SSE)
app.post("/api/rover/logs/fetch", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.logs.fetch");
  if (!sendRoverEvent("fetch-logs", {})) {
    logger.warn(req, "rover.logs.fetch", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.logs.fetch", null, "rover");
  res.json({ ok: true });
});

// POST /api/rover/spray_result - 로버가 스프레이 결과 보고 (internal)
const SPRAY_OUTCOMES = new Set(["success", "cancelled", "timeout"]);
app.post("/api/rover/spray_result", (req, res) => {
  const index = Number(req.body?.waypoint);
  const outcome = req.body?.outcome;
  if (!Number.isInteger(index) || index < 0 || !SPRAY_OUTCOMES.has(outcome)) {
    return res.status(400).send("올바르지 않은 spray_result 데이터입니다.");
  }
  // 마지막 waypoint의 spray_result는 미션이 driving→IDLE로 자동 종료된 직후에
  // 도착할 수 있다(로버의 spray-post 스레드와 telemetry 스레드가 별도라 순서
  // 보장 없음). 그 경우에도 live 결과(last_spray_result + 브로드캐스트)는
  // 기록해 마지막 콘 결과가 유실되지 않게 하고, mission_progress는 미션이
  // 활성일 때만 변경한다.
  if (currentMissionId != null) {
    if (index >= roverState.mission_progress.waypoints.length) {
      logger.warn(req, "rover.spray_result", { index, outcome, error: "index_out_of_range" }, "rover");
      return res.status(400).send("waypoint index가 현재 미션 범위를 벗어났습니다.");
    }
    roverState.mission_progress.spray_results[String(index)] = outcome;
    persistProgress();
  }
  roverState.last_spray_result = { waypoint: index, outcome, at: Date.now() };
  broadcastEvent("rover:spray", { waypoint: index, outcome, at: roverState.last_spray_result.at });
  broadcastRoverStatus();
  res.json({ ok: true });
});

// POST /api/rover/request - 관리자가 로버 좌표 요청 (프론트엔드가 호출)
app.post("/api/rover/request", async (req, res) => {
  if (!roverClient) {
    return rejectNoRover(req, res, "rover.request");
  }

  if (roverPendingResolves.length >= ROVER_MAX_PENDING_REQUESTS) {
    logger.warn(req, "rover.request", { error: "queue_full", pending: roverPendingResolves.length }, "rover");
    return res.status(503).send("위치 요청이 많아 대기 중입니다.");
  }

  const request_id = crypto.randomUUID();
  let removeFromQueue;
  const pending = new Promise((resolve) => {
    const entry = { request_id, resolve, createdAt: Date.now() };
    roverPendingResolves.push(entry);
    removeFromQueue = () => {
      const idx = roverPendingResolves.indexOf(entry);
      if (idx !== -1) roverPendingResolves.splice(idx, 1);
    };
  });

  if (!sendRoverEvent("request-position", { request_id })) {
    if (removeFromQueue) removeFromQueue();
    logger.warn(req, "rover.request", { error: "connection_lost" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  const position = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
  ]).catch(() => null);

  if (removeFromQueue) removeFromQueue();

  if (!position) {
    logger.warn(req, "rover.request", { result: "timeout" }, "rover");
    return res.status(504).send("로버 응답 시간 초과");
  }
  logger.log(req, "rover.request", { lat: position.lat, lng: position.lng }, "rover");
  res.json(position);
});

function sendRoverEvent(event, data) {
  if (!roverClient) return false;
  try {
    roverClient.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    try { roverClient.end(); } catch {}
    roverClient = null;
    markRoverDisconnected("write_failed");
    broadcastRoverStatus();
    return false;
  }
}

function validateWaypointDistances(waypoints) {
  // 첫 waypoint와 최신 rover 위치 간 거리 검증
  if (lastRoverPosition && Date.now() - lastRoverPosition.at < ROVER_POSITION_STALE_MS) {
    const d0 = haversine(lastRoverPosition, waypoints[0]);
    if (d0 > ROVER_MAX_WAYPOINT_DIST_M) {
      return { valid: false, reason: "first_waypoint_far", distance: d0 };
    }
  }
  // 인접 세그먼트 거리 검증 + 중복(<5cm) 제거
  const cleaned = [waypoints[0]];
  for (let i = 1; i < waypoints.length; i++) {
    const d = haversine(cleaned[cleaned.length - 1], waypoints[i]);
    if (d < ROVER_MIN_SEGMENT_DIST_M) continue; // 중복 제거
    if (d > ROVER_MAX_SEGMENT_DIST_M) {
      return { valid: false, reason: "segment_too_long", distance: d, index: i };
    }
    cleaned.push(waypoints[i]);
  }
  if (waypoints.length > 1 && cleaned.length < 2) {
    return { valid: false, reason: "path_degenerate", distance: 0 };
  }
  return { valid: true, waypoints: cleaned };
}

// POST /api/rover/execute - 경로 실행 (waypoint 전송)
app.post("/api/rover/execute", (req, res) => {
  const { waypoints, force } = req.body;
  if (!Array.isArray(waypoints) || waypoints.length === 0 || waypoints.length > 10000) {
    return res.status(400).send("올바르지 않은 waypoint 데이터입니다.");
  }
  if (force === true) {
    logger.warn(req, "rover.execute.force", {
      fix_status: roverState.fix_status,
      ntrip_connected: roverState.ntrip_connected,
      waypoint_count: waypoints.length,
    }, "rover");
  }

  for (const wp of waypoints) {
    const v = validateCoordinate(wp.lat, wp.lng);
    if (!v.valid) return res.status(400).send(v.error);
  }

  const distCheck = validateWaypointDistances(waypoints);
  if (!distCheck.valid) {
    const msg = distCheck.reason === "first_waypoint_far"
      ? `로버 현재 위치에서 첫 웨이포인트까지 ${distCheck.distance.toFixed(1)}m로 너무 멉니다 (최대 ${ROVER_MAX_WAYPOINT_DIST_M}m).`
      : distCheck.reason === "path_degenerate"
        ? `웨이포인트가 모두 ${ROVER_MIN_SEGMENT_DIST_M * 100}cm 이내로 겹쳐 실행할 경로가 없습니다.`
        : `${distCheck.index}번 웨이포인트 인접 거리가 ${distCheck.distance.toFixed(1)}m로 너무 큽니다 (최대 ${ROVER_MAX_SEGMENT_DIST_M}m).`;
    logger.warn(req, "rover.execute", { error: msg, reason: distCheck.reason, distance: distCheck.distance }, "rover");
    return res.status(400).send(msg);
  }
  const finalWaypoints = distCheck.waypoints;

  if (!roverClient) return rejectNoRover(req, res, "rover.execute");

  // 비상정지 래치가 걸린 상태에서는 새 경로 송신을 거부한다. 운영자가 먼저
  // "비상정지 해제"를 눌러 명시적으로 인지·해제한 뒤에만 다음 동작을 허용해
  // 이중 운영자 시나리오에서 우회 출발이 발생하지 않도록 한다.
  if (roverState.nav_state === "EMERGENCY_STOP") {
    logger.warn(req, "rover.execute", { error: "in_emergency_stop" }, "rover");
    return res.status(409).send("비상정지 상태입니다. 먼저 해제 후 실행하세요.");
  }

  if (!sendRoverEvent("execute-path", { waypoints: finalWaypoints })) {
    logger.warn(req, "rover.execute", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  const actor = req.user ? `${req.user.name || ""} <${req.user.email || ""}>` : null;
  const courseId = Number.isInteger(req.body?.course_id) ? req.body.course_id : null;
  const course = courseId != null ? getCourseById(courseId) : null;
  if (courseId != null && course) {
    try {
      const snapshotId = takeCourseSnapshot(courseId, actor, `auto: execute mission`);
      if (snapshotId != null) {
        logger.log(req, "course.snapshot.auto", { snapshot_id: snapshotId, course_id: courseId }, course?.name);
      }
    }
    catch (err) { logger.warn(req, "course.snapshot.auto", { error: String(err) }, `course#${courseId}`); }
  }
  startMission(finalWaypoints, actor, courseId);

  logger.log(req, "rover.execute", {
    waypoint_count: finalWaypoints.length,
    dropped: waypoints.length - finalWaypoints.length,
    mission_id: currentMissionId,
  }, "rover");
  res.json({ sent: finalWaypoints.length, waypoints: finalWaypoints, mission_id: currentMissionId });
});

// POST /api/rover/stop - 비상정지
app.post("/api/rover/stop", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.stop");

  if (!sendRoverEvent("emergency-stop", {})) {
    logger.warn(req, "rover.stop", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  logger.log(req, "rover.stop", null, "rover");
  res.json({ stopped: true });
});

// POST /api/rover/pause - 미션 소프트 일시정지 (E-Stop 아님)
// 자율 주행을 멈추되 MCU 래치를 걸지 않아 수동 제어가 가능하다. 진행상황은
// 보존되고 /api/rover/resume 로 현재 waypoint부터 이어서 주행한다. 장애물
// 발견 시 운영자가 멈추고 수동으로 비켜 운전한 뒤 재개하는 흐름의 핵심.
app.post("/api/rover/pause", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.pause");
  if (currentMissionId == null || roverState.mission_progress.status !== "running") {
    logger.warn(req, "rover.pause",
      { error: "no_running_mission", status: roverState.mission_progress.status }, "rover");
    return res.status(409).send("일시정지할 진행 중인 미션이 없습니다.");
  }
  if (!sendRoverEvent("pause-mission", {})) {
    logger.warn(req, "rover.pause", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  setMissionStatus.run("paused", Date.now(), currentMissionId);
  roverState.mission_progress.status = "paused";
  broadcastRoverStatus();
  logger.log(req, "rover.pause", { mission_id: currentMissionId }, "rover");
  res.json({ paused: true });
});

// POST /api/rover/resume - 일시정지된 미션 재개 (현재 waypoint부터 이어 주행)
app.post("/api/rover/resume", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.resume");
  if (currentMissionId == null || roverState.mission_progress.status !== "paused") {
    logger.warn(req, "rover.resume",
      { error: "not_paused", status: roverState.mission_progress.status }, "rover");
    return res.status(409).send("재개할 일시정지된 미션이 없습니다.");
  }
  if (!sendRoverEvent("resume-mission", {})) {
    logger.warn(req, "rover.resume", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  setMissionStatus.run("running", Date.now(), currentMissionId);
  roverState.mission_progress.status = "running";
  broadcastRoverStatus();
  logger.log(req, "rover.resume", { mission_id: currentMissionId }, "rover");
  res.json({ resumed: true });
});

// POST /api/rover/calibrate-battery - 배터리 전압 1점 게인 보정 (admin)
// 운영자가 멀티미터로 측정한 실제 전압을 입력하면, 로버가 같은 시점의 ADC raw
// 값과 비교해 V_real = V_raw × gain 의 게인 하나를 갱신·영구 저장한다.
// 환경 온도가 바뀔 때마다 다시 누르면 그 자리에서 보정.
app.post("/api/rover/calibrate-battery", (req, res) => {
  const measured_v = Number(req.body?.measured_v);
  if (!Number.isFinite(measured_v) || measured_v < 15 || measured_v > 32) {
    return res.status(400).send("측정값은 15~32 V 범위 안의 숫자여야 합니다.");
  }
  if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_battery", { measured_v });

  if (!sendRoverEvent("calibrate-battery", { measured_v })) {
    logger.warn(req, "rover.calibrate_battery", { error: "write_failed", measured_v }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  logger.log(req, "rover.calibrate_battery", { measured_v }, "rover");
  res.json({ ok: true, measured_v });
});

// POST /api/rover/calibrate-antenna - 안테나 오프셋 자동 캘리브레이션 시작 (admin)
// 로버가 직진 → S-curve(8s) 패턴을 자동 주행하면서 인코더로 적분한
// chassis pose와 GPS 안테나 위치를 비교해 (a_x, a_y) 오프셋을 LSQ로 적합한다.
// 결과는 로버 측 /var/lib/pilot/antenna_offset.json에 영속화되고
// /api/rover/antenna_calibration_result로 회신된다.
app.post("/api/rover/calibrate-antenna", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_antenna");
  if (roverState.nav_state && roverState.nav_state !== "IDLE") {
    logger.warn(req, "rover.calibrate_antenna", { error: "not_idle", nav_state: roverState.nav_state }, "rover");
    return res.status(409).send(
      `로버가 IDLE이 아닙니다 (현재: ${roverState.nav_state}). 먼저 미션을 종료하세요.`
    );
  }
  if (!sendRoverEvent("calibrate-antenna", {})) {
    logger.warn(req, "rover.calibrate_antenna", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.calibrate_antenna", null, "rover");
  res.json({ ok: true });
});

// POST /api/rover/set-antenna-offset - 운영자가 줄자로 잰 안테나 오프셋 직접 입력 (admin)
// auto-cal은 PID 튜닝이 안 된 상태에서는 SCURVE 동안 chassis pose 적분 오차가
// 누적되어 m 단위 오차가 나오기 쉬우므로, 운영 환경에서는 한 번 측정한 값을
// 직접 입력하는 게 가장 확실하다. 결과는 동일한 antenna_offset.json에
// source='manual' 태그로 영속화된다.
app.post("/api/rover/set-antenna-offset", (req, res) => {
  const body = req.body || {};
  const a_x = typeof body.a_x === "number" ? body.a_x : null;
  const a_y = typeof body.a_y === "number" ? body.a_y : null;
  if (a_x === null || a_y === null) {
    return res.status(400).send("a_x, a_y는 숫자여야 합니다.");
  }
  if (a_x < 0.05 || a_x > 1.0 || Math.abs(a_y) > 1.0) {
    return res.status(400).send("a_x는 0.05~1 m, a_y는 ±1 m 이내여야 합니다.");
  }
  if (!roverClient) return rejectNoRover(req, res, "rover.set_antenna_offset", { a_x, a_y });
  if (!sendRoverEvent("set-antenna-offset", { a_x, a_y })) {
    logger.warn(req, "rover.set_antenna_offset", { error: "write_failed", a_x, a_y }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.set_antenna_offset", { a_x, a_y }, "rover");
  res.json({ ok: true, a_x, a_y });
});

// POST /api/rover/antenna_calibration_result - 로버가 캘리브레이션 결과 보고 (internal)
app.post("/api/rover/antenna_calibration_result", (req, res) => {
  const body = req.body || {};
  const ok = !!body.ok;
  // We log everything the rover sent so post-mortem of a failed calibration
  // (residual too high / not enough samples) tells the operator exactly
  // which gate tripped without needing SSH.
  const stored = {
    ok,
    a_x: typeof body.a_x === "number" ? body.a_x : null,
    a_y: typeof body.a_y === "number" ? body.a_y : null,
    rms_residual_m: typeof body.rms_residual_m === "number" ? body.rms_residual_m : null,
    samples: Number.isInteger(body.samples) ? body.samples : null,
    drive_distance_m: typeof body.drive_distance_m === "number" ? body.drive_distance_m : null,
    calibrated_at: Number.isInteger(body.calibrated_at) ? body.calibrated_at : Date.now(),
    reason: typeof body.reason === "string" ? body.reason : null,
    // 'auto' (auto-cal SCURVE drive) or 'manual' (operator typed the value).
    // Lets the UI label which method produced the persisted offset.
    source: body.source === "manual" ? "manual" : (body.source === "auto" ? "auto" : null),
  };
  roverState.antenna_calibration = stored;
  broadcastEvent("rover:antenna_calibration", stored);
  broadcastRoverStatus();
  if (ok) {
    logger.log(req, "rover.antenna_calibration", stored, "rover");
  } else {
    logger.warn(req, "rover.antenna_calibration", stored, "rover");
  }
  res.json({ ok: true });
});

// POST /api/rover/calibrate-wheels - 휠 인코더 스케일 자동 캘리브레이션 시작 (admin)
// 로버가 직진 10 m 주행 후 GPS chord 거리와 좌·우 인코더 적분 거리의 비율로
// 좌·우 휠 스케일을 추정한다. 결과는 /var/lib/pilot/wheel_cal.json에 영속화되고
// mcu_bridge가 텔레메트리 vl/vr에 곱해 적용한다. /api/rover/wheel_calibration_result로 회신.
app.post("/api/rover/calibrate-wheels", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_wheels");
  if (roverState.nav_state && roverState.nav_state !== "IDLE") {
    logger.warn(req, "rover.calibrate_wheels", { error: "not_idle", nav_state: roverState.nav_state }, "rover");
    return res.status(409).send(
      `로버가 IDLE이 아닙니다 (현재: ${roverState.nav_state}). 먼저 미션을 종료하세요.`
    );
  }
  if (!sendRoverEvent("calibrate-wheels", {})) {
    logger.warn(req, "rover.calibrate_wheels", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.calibrate_wheels", null, "rover");
  res.json({ ok: true });
});

// POST /api/rover/wheel_calibration_result - 로버가 휠 캘리브레이션 결과 보고 (internal)
app.post("/api/rover/wheel_calibration_result", (req, res) => {
  const body = req.body || {};
  const ok = !!body.ok;
  const stored = {
    ok,
    scale_l: typeof body.scale_l === "number" ? body.scale_l : null,
    scale_r: typeof body.scale_r === "number" ? body.scale_r : null,
    gps_distance_m: typeof body.gps_distance_m === "number" ? body.gps_distance_m : null,
    encoder_left_m: typeof body.encoder_left_m === "number" ? body.encoder_left_m : null,
    encoder_right_m: typeof body.encoder_right_m === "number" ? body.encoder_right_m : null,
    samples: Number.isInteger(body.samples) ? body.samples : null,
    // Steering-trim auto-cal piggy-backs on the same drive (rover/pilot/lib/steering_calibration.py).
    // null radius_m means the path was straight enough that we report 0 µs trim;
    // null trim_us with a steering_reason means the trim solve failed but wheel scales still applied.
    trim_us: typeof body.trim_us === "number" ? body.trim_us : null,
    radius_m: typeof body.radius_m === "number" ? body.radius_m : null,
    steering_rms_m: typeof body.steering_rms_m === "number" ? body.steering_rms_m : null,
    steering_reason: typeof body.steering_reason === "string" ? body.steering_reason : null,
    // Rover doesn't stamp calibrated_at in the result payload — we stamp on receipt
    // since that's within ~100 ms of the rover's solve completion.
    calibrated_at: Date.now(),
    reason: typeof body.reason === "string" ? body.reason : null,
  };
  roverState.wheel_calibration = stored;
  broadcastRoverStatus();
  if (ok) {
    logger.log(req, "rover.wheel_calibration", stored, "rover");
  } else {
    logger.warn(req, "rover.wheel_calibration", stored, "rover");
  }
  res.json({ ok: true });
});

// POST /api/rover/reset-wheel-cal - 휠 스케일/조향 트림을 공장 기본값으로 되돌림 (admin)
// 휠 cal은 매 실행에서 scale_l/r을 새로 덮어쓰지만 조향 트림은 누적되므로,
// 비정상 누적값이 적용된 상태를 한 번에 해소하는 escape hatch.
app.post("/api/rover/reset-wheel-cal", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.reset_wheel_cal");
  if (roverState.nav_state && roverState.nav_state !== "IDLE") {
    logger.warn(req, "rover.reset_wheel_cal", { error: "not_idle", nav_state: roverState.nav_state }, "rover");
    return res.status(409).send(
      `로버가 IDLE이 아닙니다 (현재: ${roverState.nav_state}). 먼저 미션을 종료하세요.`
    );
  }
  if (!sendRoverEvent("reset-wheel-cal", {})) {
    logger.warn(req, "rover.reset_wheel_cal", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  roverState.wheel_calibration = null;
  broadcastRoverStatus();
  logger.log(req, "rover.reset_wheel_cal", null, "rover");
  res.json({ ok: true });
});

// POST /api/rover/waypoint_skipped - 로버가 stuck-skip으로 웨이포인트 건너뜀 (internal)
// waypoint_reached와 동일하게 current_waypoint_idx를 monotonically 전진시켜
// 새로고침 후에도 스킵된 콘이 다음 목표로 다시 잡히지 않도록 한다.
app.post("/api/rover/waypoint_skipped", (req, res) => {
  const index = Number(req.body?.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).send("올바르지 않은 waypoint index입니다.");
  }
  // 미션 자동 종료 직후 늦게 도착할 수 있다. 종료 후엔 의미가 없으므로 no-op.
  if (currentMissionId == null) {
    return res.json({ ok: true });
  }
  if (index >= roverState.mission_progress.waypoints.length) {
    logger.warn(req, "rover.waypoint_skipped", { index, error: "index_out_of_range" }, "rover");
    return res.status(400).send("waypoint index가 현재 미션 범위를 벗어났습니다.");
  }
  if (index + 1 > roverState.mission_progress.current_waypoint_idx) {
    roverState.mission_progress.current_waypoint_idx = index + 1;
  }
  persistProgress();
  broadcastEvent("rover:skipped", { index });
  logger.warn(req, "rover.waypoint_skipped", { index, mission_id: currentMissionId }, "rover");
  res.json({ ok: true });
});

// POST /api/rover/clear-emergency - 비상정지 해제 (operator-acknowledged)
app.post("/api/rover/clear-emergency", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.clear_emergency");

  if (!sendRoverEvent("clear-emergency", {})) {
    logger.warn(req, "rover.clear_emergency", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  logger.log(req, "rover.clear_emergency", null, "rover");
  res.json({ cleared: true });
});

// POST /api/rover/end-mission - 운영자가 보존된 미션을 명시적으로 종료
// EMERGENCY_STOP 동안은 미션이 자동으로 끝나지 않으므로, 운영자가 "이어서
// 실행" 대신 path 자체를 폐기할 때 호출되어 미션 레코드를 마감한다.
app.post("/api/rover/end-mission", (req, res) => {
  if (currentMissionId == null) return res.json({ ended: false });
  const endedId = currentMissionId;
  endMission("stopped");
  broadcastRoverStatus();
  logger.log(req, "rover.end_mission", { mission_id: endedId }, "rover");
  res.json({ ended: true, mission_id: endedId });
});

// POST /api/rover/dispenser - 분필 디스펜서 수동 위치 (load/dump)
app.post("/api/rover/dispenser", (req, res) => {
  const { position } = req.body;
  if (position !== "load" && position !== "dump") {
    return res.status(400).send("position must be 'load' or 'dump'.");
  }
  if (!roverClient) return rejectNoRover(req, res, "rover.dispenser", { position });
  if (!sendRoverEvent("dispenser-set-position", { position })) {
    logger.warn(req, "rover.dispenser", { error: "write_failed", position }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.dispenser", { position }, "rover");
  res.json({ position });
});

// POST /api/rover/control - 수동 제어
app.post("/api/rover/control", (req, res) => {
  const { throttle, steering } = req.body;
  if (typeof throttle !== "number" || typeof steering !== "number" || !Number.isFinite(throttle) || !Number.isFinite(steering)) {
    return res.status(400).send("올바르지 않은 제어 데이터입니다.");
  }

  const t = Math.max(-100, Math.min(100, throttle));
  const s = Math.max(-100, Math.min(100, steering));
  if (!roverClient) return rejectNoRover(req, res, "rover.control", { throttle: t, steering: s });

  if (!sendRoverEvent("manual-control", { throttle: t, steering: s })) {
    logger.warn(req, "rover.control", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  res.json({ throttle: t, steering: s });
});

// POST /api/rover/nav-lights - 항공기식 nav 라이트 모드 설정 (admin → SSE)
// mode: 0=off 1=steady 2=double-strobe 3=single-strobe 4=50% blink
app.post("/api/rover/nav-lights", (req, res) => {
  const mode = Number(req.body?.mode);
  if (!Number.isInteger(mode) || mode < 0 || mode > 4) {
    logger.warn(req, "rover.nav_lights", { error: "invalid_mode", mode: req.body?.mode }, "rover");
    return res.status(400).send("mode는 0~4여야 합니다.");
  }
  // 선택은 항상 저장한다 — 로버 재연결 시 재전송돼 고착된다. 연결돼 있으면 즉시 전송.
  roverState.nav_lights_mode = mode;
  if (roverClient) sendRoverEvent("nav-lights", { mode });
  logger.log(req, "rover.nav_lights", { mode, connected: !!roverClient }, "rover");
  broadcastRoverStatus();
  res.json({ ok: true });
});

// POST /api/rover/led-brightness - status LED(WS2812) 전역 밝기 0-255 (admin → SSE)
app.post("/api/rover/led-brightness", (req, res) => {
  const brightness = Number(req.body?.brightness);
  if (!Number.isInteger(brightness) || brightness < 0 || brightness > 255) {
    logger.warn(req, "rover.led_brightness", { error: "invalid_brightness", brightness: req.body?.brightness }, "rover");
    return res.status(400).send("brightness는 0~255여야 합니다.");
  }
  roverState.led_brightness = brightness;
  if (roverClient) sendRoverEvent("led-brightness", { brightness });
  logger.log(req, "rover.led_brightness", { brightness, connected: !!roverClient }, "rover");
  broadcastRoverStatus();
  res.json({ ok: true });
});

/* ============================================
   Camera relay (rover → server → browser, MJPEG)
   ============================================
   In-memory only — frames are ephemeral, never touch the DB. Tailscale-free:
   the rover's perception container pushes JPEG frames OUT to this server, and
   admin browsers pull them from the same server as multipart/x-mixed-replace
   (native <img> rendering). The rover only captures while someone is watching:
   a viewer connecting/leaving toggles a camera-start/stop event on the rover's
   control SSE. Separate from the pilot's /api/rover/stream so streaming load
   never interferes with the mission command channel. */
let cameraControlClient = null;   // perception container's control SSE (res)
const cameraViewers = new Set();  // browser multipart responses
let cameraLatestFrame = null;     // { buf, at } — last JPEG, replayed to new viewers
const CAMERA_FRAME_FRESH_MS = 2000;

function sendCameraControl(event) {
  if (!cameraControlClient) return;
  try {
    cameraControlClient.write(`event: ${event}\ndata: {}\n\n`);
  } catch {
    try { cameraControlClient.end(); } catch {}
    cameraControlClient = null;
  }
}

// Capture only while at least one browser is watching.
function syncCameraCapture() {
  sendCameraControl(cameraViewers.size > 0 ? "camera-start" : "camera-stop");
}

// GET /api/rover/camera/control - perception container SSE (internal-strict).
// Receives camera-start / camera-stop so it captures only on demand.
app.get("/api/rover/camera/control", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");
  if (cameraControlClient && cameraControlClient !== res) {
    try { cameraControlClient.end(); } catch {}
  }
  cameraControlClient = res;
  // If viewers are already waiting, start capturing immediately.
  if (cameraViewers.size > 0) sendCameraControl("camera-start");
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch {}
  }, 30000);
  req.on("close", () => {
    clearInterval(heartbeat);
    if (cameraControlClient === res) cameraControlClient = null;
  });
});

// POST /api/rover/camera - JPEG frame upload (internal-strict, raw body).
// express.raw only consumes image/jpeg; the global express.json skips it.
app.post("/api/rover/camera", express.raw({ type: "image/jpeg", limit: "3mb" }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).send("empty frame");
  }
  cameraLatestFrame = { buf, at: Date.now() };
  const header = Buffer.from(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`
  );
  for (const viewer of cameraViewers) {
    try {
      viewer.write(header);
      viewer.write(buf);
      viewer.write("\r\n");
    } catch { /* viewer cleaned up on its own 'close' */ }
  }
  res.status(204).end();
});

// GET /api/rover/camera/stream - browser MJPEG viewer (admin).
app.get("/api/rover/camera/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "keep-alive",
  });
  // Flush headers now: with no Content-Length, Node would otherwise hold the
  // headers until the first body write, so a viewer that connects before any
  // frame is pushed would see the request hang instead of an open MJPEG stream.
  res.flushHeaders();
  cameraViewers.add(res);
  // Replay the most recent frame so a joining viewer sees something at once.
  if (cameraLatestFrame && Date.now() - cameraLatestFrame.at < CAMERA_FRAME_FRESH_MS) {
    try {
      res.write(Buffer.from(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${cameraLatestFrame.buf.length}\r\n\r\n`
      ));
      res.write(cameraLatestFrame.buf);
      res.write("\r\n");
    } catch { /* ignore */ }
  }
  if (cameraViewers.size === 1) syncCameraCapture(); // first viewer → start
  logger.log(req, "rover.camera.view", { viewers: cameraViewers.size }, "rover");
  req.on("close", () => {
    cameraViewers.delete(res);
    if (cameraViewers.size === 0) syncCameraCapture(); // last viewer → stop
  });
});

// GET /api/rover/camera/status - camera availability for the UI (admin).
app.get("/api/rover/camera/status", (req, res) => {
  res.json({
    camera_connected: !!cameraControlClient,
    viewers: cameraViewers.size,
    last_frame_at: cameraLatestFrame ? cameraLatestFrame.at : null,
  });
});

/* ============================================
   SPA Fallback
   ============================================ */
app.use("/api", (req, res) => {
  res.status(404).send("API endpoint not found.");
});

app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createCourseApp();
  setupProcessHandlers(db);
  app.listen(10000);
}
