import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createSSEManager } from "../shared/sse.mjs";

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
  if (req.path === "/api/rover/stream" || req.path === "/api/rover/position") {
    if (internalSecret && !isInternalRequest(req)) {
      return "admin";
    }
    return null;
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

// GET /api/rover/stream - 로버 SSE 연결 (로버가 호출)
app.get("/api/rover/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");

  roverClient = res;

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (roverClient === res) roverClient = null;
  });
});

// POST /api/rover/position - 로버가 현재 위치 전송 (로버가 호출)
app.post("/api/rover/position", (req, res) => {
  const { lat, lng } = req.body;
  const coordValidation = validateCoordinate(lat, lng);
  if (!coordValidation.valid) return res.status(400).send(coordValidation.error);

  while (roverPendingResolves.length > 0) {
    const resolve = roverPendingResolves.shift();
    resolve({ lat, lng });
  }

  broadcastEvent("rover", { lat, lng });
  res.json({ lat, lng });
});

// POST /api/rover/request - 관리자가 로버 좌표 요청 (프론트엔드가 호출)
app.post("/api/rover/request", async (req, res) => {
  if (!roverClient) {
    logger.warn(req, "rover.request", { error: "not_connected" }, "rover");
    return res.status(503).send("로버가 연결되어 있지 않습니다.");
  }

  try {
    roverClient.write("event: request-position\ndata: {}\n\n");
  } catch {
    roverClient = null;
    logger.warn(req, "rover.request", { error: "connection_lost" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  let removeFromQueue;
  const position = await Promise.race([
    new Promise((resolve) => {
      roverPendingResolves.push(resolve);
      removeFromQueue = () => {
        const idx = roverPendingResolves.indexOf(resolve);
        if (idx !== -1) roverPendingResolves.splice(idx, 1);
      };
    }),
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
    roverClient = null;
    return false;
  }
}

// POST /api/rover/execute - 경로 실행 (waypoint 전송)
app.post("/api/rover/execute", (req, res) => {
  const { waypoints } = req.body;
  if (!Array.isArray(waypoints) || waypoints.length === 0 || waypoints.length > 10000) {
    return res.status(400).send("올바르지 않은 waypoint 데이터입니다.");
  }

  for (const wp of waypoints) {
    const v = validateCoordinate(wp.lat, wp.lng);
    if (!v.valid) return res.status(400).send(v.error);
  }

  if (!roverClient) return res.status(503).send("로버가 연결되어 있지 않습니다.");

  if (!sendRoverEvent("execute-path", { waypoints })) {
    logger.warn(req, "rover.execute", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  logger.log(req, "rover.execute", { waypoint_count: waypoints.length }, "rover");
  res.json({ sent: waypoints.length });
});

// POST /api/rover/stop - 비상정지
app.post("/api/rover/stop", (req, res) => {
  if (!roverClient) return res.status(503).send("로버가 연결되어 있지 않습니다.");

  if (!sendRoverEvent("emergency-stop", {})) {
    logger.warn(req, "rover.stop", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  logger.log(req, "rover.stop", null, "rover");
  res.json({ stopped: true });
});

// POST /api/rover/control - 수동 제어
app.post("/api/rover/control", (req, res) => {
  const { throttle, steering } = req.body;
  if (typeof throttle !== "number" || typeof steering !== "number" || !Number.isFinite(throttle) || !Number.isFinite(steering)) {
    return res.status(400).send("올바르지 않은 제어 데이터입니다.");
  }

  if (!roverClient) return res.status(503).send("로버가 연결되어 있지 않습니다.");

  const t = Math.max(-100, Math.min(100, throttle));
  const s = Math.max(-100, Math.min(100, steering));

  if (!sendRoverEvent("manual-control", { throttle: t, steering: s })) {
    logger.warn(req, "rover.control", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  res.json({ throttle: t, steering: s });
});

/* ============================================
   SPA Fallback
   ============================================ */
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
