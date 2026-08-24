import express from "express";
import Database from "better-sqlite3";
import { runMigrationOnce, normalizeTimestampColumn, setupRowCapRetention } from "../shared/db-setup.mjs";
import { createSecretChecker } from "../shared/express-setup.mjs";
import { createServiceSkeleton, addSpaFallback, runIfDirect } from "../shared/service-bootstrap.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { ROLE_LEVELS } from "../shared/constants.js";
import { registerRoverRoutes } from "./lib/rover-routes.mjs";
import { setupMissionV2Schema } from "./lib/mission-v2.mjs";
import { seedOrientationMarkers } from "./lib/route-mode.mjs";

const parsedMissionTelemetryMaxRows = Number.parseInt(process.env.MISSION_TELEMETRY_MAX_ROWS || "500000", 10);
const MISSION_TELEMETRY_MAX_ROWS = Number.isInteger(parsedMissionTelemetryMaxRows) && parsedMissionTelemetryMaxRows > 0
  ? parsedMissionTelemetryMaxRows
  : 500000;

export function createCourseApp(options = {}) {

// roleFn은 아래 "Express 앱 설정" 섹션에 hoisted function으로 선언되어 있다.
// 게이트는 요청 시점에 호출되므로 골격 호출 뒤에 선언되어도 안전하다.
const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "course", express, Database, options,
  authRoleFn: roleFn,
});

db.pragma("foreign_keys = ON");

db.exec(`CREATE TABLE IF NOT EXISTS course (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

// 코스 진행 방향(reverse)과 시작 콘(start_cone_id)을 코스 행에 저장한다. 예전에는 웹 UI가
// localStorage에 코스별로 들고 있어 조작자·기기마다 값이 달랐다. 서버에 저장해 모든
// 클라이언트가 같은 진행 방향/시작점을 공유하도록 한다. SQLite에 boolean 타입이 없어
// reverse는 0/1 정수, start_cone_id는 cone.id 또는 null. 비파괴적 ADD COLUMN.
{
  const cols = db.prepare("PRAGMA table_info(course)").all().map((c) => c.name);
  if (!cols.includes("reverse")) db.exec("ALTER TABLE course ADD COLUMN reverse INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("start_cone_id")) db.exec("ALTER TABLE course ADD COLUMN start_cone_id INTEGER");
}

db.exec(`CREATE TABLE IF NOT EXISTS cone (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  alt REAL,
  side TEXT NOT NULL CHECK(side IN ('left', 'right', 'center')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_cone_course ON cone(course_id);`);

// 기존 DB 마이그레이션: cone에 alt(고도) 컬럼 추가. 로버 RTK fix의 MSL 고도(m)를
// lat/lng와 같은 fix에서 함께 받아 보존한다. 지도 클릭 등 수동으로 찍은 콘은 고도가
// 없으므로 nullable. 비파괴적 ADD COLUMN(테이블 재구축·FK 영향 없음).
{
  const cols = db.prepare("PRAGMA table_info(cone)").all().map((c) => c.name);
  if (!cols.includes("alt")) db.exec("ALTER TABLE cone ADD COLUMN alt REAL");
}

// 지도 위 메모 스티커. 코스에 붙는 자유 텍스트 주석으로, 중심 좌표(lat/lng)와
// 실측 크기(width/height, m)로 저장한다 — 콘처럼 지리 좌표에 고정돼 줌/회전에도
// 코스 위 같은 자리를 가리키며, 크기는 m로 저장돼 줌에 따라 함께 커지고 작아진다.
// course 삭제 시 CASCADE로 함께 지워진다.
db.exec(`CREATE TABLE IF NOT EXISTS memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  rotation REAL NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_memo_course ON memo(course_id);`);

// Ordered route guides are independent from cones: markers are physical map
// anchors, while route_step may reference the same marker repeatedly to express
// multi-lap or branched walks (for example a skidpad's left 2 + right 2 laps).
db.exec(`CREATE TABLE IF NOT EXISTS route_marker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_route_marker_course ON route_marker(course_id);`);
db.exec(`CREATE TABLE IF NOT EXISTS route_step (
  course_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  marker_id INTEGER NOT NULL,
  PRIMARY KEY (course_id, position),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE,
  FOREIGN KEY (marker_id) REFERENCES route_marker(id) ON DELETE CASCADE
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_route_step_marker ON route_step(marker_id);`);

// 기존 DB 마이그레이션: memo에 rotation(회전 각도, deg) 추가. 비파괴적 ADD COLUMN.
{
  const cols = db.prepare("PRAGMA table_info(memo)").all().map((c) => c.name);
  if (!cols.includes("rotation")) db.exec("ALTER TABLE memo ADD COLUMN rotation REAL NOT NULL DEFAULT 0");
}

function ensureUtcTimestampColumns(table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes("created_at")) db.exec(`ALTER TABLE ${table} ADD COLUMN created_at TEXT`);
  if (!cols.includes("updated_at")) db.exec(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT`);
  db.prepare(`UPDATE ${table} SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at IS NULL OR created_at = ''`).run();
  db.prepare(`UPDATE ${table} SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''`).run();
}

runMigrationOnce(db, "course.ensure_utc_timestamp_columns.v1", () => {
  ensureUtcTimestampColumns("course");
  ensureUtcTimestampColumns("cone");
});

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
  ntrip_connected INTEGER,
  corr_age_ms INTEGER,
  ntrip_fail_count INTEGER,
  h_acc_m REAL,
  altitude_m REAL,
  v_acc_m REAL,
  FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_telemetry ON mission_telemetry(mission_id, t);`);
setupRowCapRetention(db, "mission_telemetry", MISSION_TELEMETRY_MAX_ROWS);

// 기존 DB 마이그레이션: mission_telemetry에 NTRIP 링크 건강도 + 측위 정확도 컬럼
// 추가. fix_status/nav_state만으로는 "가다서다"(로버가 미션 중 정지 반복)의 원인을
// 구분할 수 없다 — 같은 'rtk_fixed→3d_fix' 추락이라도 (a) ntrip_connected=0이면
// 네트워크/Wi-Fi 끊김, (b) 연결됐는데 corr_age_ms가 치솟으면 캐스터/마운트포인트
// 침묵, (c) 연결·보정 정상인데 h_acc_m/fix_status만 나쁘면 marginal sky-view 다.
// nullable ADD COLUMN이라 비파괴적(테이블 재구축·FK 영향 없음).
{
  const cols = db.prepare("PRAGMA table_info(mission_telemetry)").all().map((c) => c.name);
  const addColumn = (name, type) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE mission_telemetry ADD COLUMN ${name} ${type}`);
  };
  addColumn("ntrip_connected", "INTEGER"); // 0/1: 로버↔NGII 캐스터 TCP 소켓 상태
  addColumn("corr_age_ms", "INTEGER");     // 마지막 RTCM 수신 후 경과(ms). 연결됐는데 크면 캐스터 침묵
  addColumn("ntrip_fail_count", "INTEGER");// 누적 재연결 실패 횟수
  addColumn("h_acc_m", "REAL");            // 수평 정확도(m). float 수용 게이트 판단 근거
  addColumn("altitude_m", "REAL");         // MSL 고도(m). 미션 경로의 표고 프로파일
  addColumn("v_acc_m", "REAL");            // 수직 정확도(m). 고도값 신뢰도
}

// 기존 DB 마이그레이션: side CHECK 제약에 'center' 추가
{
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cone'").get();
  if (info && !info.sql.includes("center")) {
    db.transaction(() => {
      // 위 alt ADD COLUMN 마이그레이션이 먼저 실행되므로 이 시점의 cone에는 항상
      // alt가 존재한다(8컬럼). cone_new에도 alt를 두고 컬럼을 명시적으로 나열해
      // 복사한다 — `SELECT *`는 cone(8) vs cone_new 컬럼 수가 어긋나면 기동 시
      // "N columns but M values were supplied"로 throw해 서비스가 뜨지 못한다.
      db.exec(`CREATE TABLE cone_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        alt REAL,
        side TEXT NOT NULL CHECK(side IN ('left', 'right', 'center')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
      )`);
      db.exec(`INSERT INTO cone_new (id, course_id, lat, lng, alt, side, created_at, updated_at)
               SELECT id, course_id, lat, lng, alt, side, created_at, updated_at FROM cone`);
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

runMigrationOnce(db, "course.utc_timestamp_normalization.v1", () => {
  for (const [table, column] of [
    ["course", "created_at"],
    ["course", "updated_at"],
    ["cone", "created_at"],
    ["cone", "updated_at"],
  ]) {
    normalizeTimestampColumn(db, table, column);
  }
});

// Durable mission protocol v2: stable waypoint identities, editable remaining
// routes, command acknowledgements, and named route presets. The migration is
// additive and backfills legacy coordinate arrays without deleting history.
setupMissionV2Schema(db, logger);

// 주행 마커가 코스의 유일한 방향 지정 수단이 되면서, 마커가 없는 기존 코스는 UI에서
// 방향을 바꿀 수단을 잃는다. 그래서 저장된 start_cone_id/reverse를 그대로 재현하는
// 마커 2개를 코스마다 심어 둔다. 두 번째 마커는 루프의 1/3 지점에 놓이므로
// resolveCourseRoute의 "첫 구간은 짧은 호" 규칙이 원래 방향을 되돌려 준다.
// 기하는 바뀌지 않는다 — 마커는 computeCenterline의 start/reverse 입력일 뿐이다.
runMigrationOnce(db, "course.seed_route_markers_from_direction.v1", () => {
  const courses = db.prepare("SELECT id, reverse, start_cone_id FROM course").all();
  const insertMarker = db.prepare("INSERT INTO route_marker (course_id, lat, lng, label) VALUES (?, ?, ?, ?)");
  const insertStep = db.prepare("INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)");
  let seeded = 0, skipped = 0;
  for (const course of courses) {
    // 이미 마커를 하나라도 놓은 코스는 건드리지 않는다. 방문 순서를 아직 만들지
    // 않았을 뿐 누군가 경로를 작성하는 중이며, 여기서 마커 2개를 더 심으면 그 작업을
    // 어지럽히고 의도하지 않은 2단계 순서로 코스를 oriented로 바꿔 버린다.
    if (db.prepare("SELECT 1 FROM route_marker WHERE course_id = ? LIMIT 1").get(course.id)) continue;
    const cones = db.prepare("SELECT id, lat, lng, side, alt FROM cone WHERE course_id = ? ORDER BY id").all(course.id);
    const startCone = course.start_cone_id != null
      ? cones.find((cone) => cone.id === course.start_cone_id)
      : null;
    const positions = seedOrientationMarkers(cones, {
      ...(startCone ? { start: { lat: startCone.lat, lng: startCone.lng } } : {}),
      reverse: !!course.reverse,
    });
    // 루프로 닫히지 않는 코스(콘 부족, 미완성 배치)는 건드리지 않는다. 마커가 없으면
    // 계속 저장된 start/reverse로 계산되므로 동작이 달라지지 않는다.
    if (!positions) { skipped++; continue; }
    positions.forEach((position, index) => {
      const markerId = insertMarker.run(course.id, position.lat, position.lng, index === 0 ? "시작" : "방향").lastInsertRowid;
      insertStep.run(course.id, index, markerId);
    });
    seeded++;
  }
  logger.log(null, "course.route.seed", { seeded, skipped, courses: courses.length }, null,
    { email: "system", name: "system", role: "admin" });
});

// GPS 소스/기준국 설정. 로버가 쓸 NTRIP 소스(NGII vs 수신기 base station)를 서버에
// 저장해 모든 클라이언트·로버 재연결 간에 공유한다. key-value 단순 저장:
//   ntrip_source          "ngii" | "base" (기본 ngii)
//   active_base_point_id  survey_point.id (base 소스일 때 사용할 기준점) | null
db.exec(`CREATE TABLE IF NOT EXISTS gps_config (
  key TEXT PRIMARY KEY,
  value TEXT
);`);

// 측량점: 수신기를 기준국으로 쓰기 위한 이름 붙은 지점. NGII RTK가 살아있을 때
// 수신기 위치를 일정 시간 평균내어(lat/lng/alt) 기록해 두고, 같은 자리에 두면
// 그 좌표로 수신기를 고정 기준국(F9P TMODE3 FIXED)으로 돌린다. lat/lng/alt는
// 미측량 시 NULL, double 정밀도로 TMODE3 LLH 재구성에 충분하다.
db.exec(`CREATE TABLE IF NOT EXISTS survey_point (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  lat REAL,
  lng REAL,
  alt REAL,
  h_acc_m REAL,
  samples INTEGER,
  surveyed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

/* ============================================
   Express 앱 설정
   ============================================ */
// Timing-safe internal secret check (shared helper)
const isInternalSecret = createSecretChecker(process.env.INTERNAL_SECRET);
// 로버 전용 시크릿(선택적). 설정되면 로버 라우트에서 X-Rover-Secret 헤더로도 인증할 수 있다.
// isInternalRequest는 로버 라우트 게이트에서만 사용되므로(course authRoleFn) 이 시크릿의 권한은
// 로버 엔드포인트로 자동 한정된다 — 필드 장비(pilot/perception/GPS)가 전 서비스 admin인
// INTERNAL_SECRET을 소지하지 않아도 되어, 물리 장비 탈취 시 유출 반경이 course 로버 경로로 좁혀진다.
// 미설정 시 checker가 항상 false라 기존 INTERNAL_SECRET 동작과 동일(하위 호환).
const isRoverSecret = createSecretChecker(process.env.ROVER_SECRET);

function isInternalRequest(req) {
  return isInternalSecret(req.headers["x-internal-service"]) || isRoverSecret(req.headers["x-rover-secret"]);
}

function roleFn(req) {
  // Normalize before matching: Express 5 routing is case-insensitive and
  // trailing-slash-insensitive by default, so `/API/rover/camera` and
  // `/api/rover/camera/` reach the same handlers. A raw `req.path ===` gate
  // would NOT match those variants and would fall through to "admin", letting
  // a logged-in admin browser bypass the internal-strict rover endpoints
  // (seize the rover/camera-control slot, inject frames). Canonicalize the
  // path the same way the router does so the gate can't be slipped.
  const p = (req.path || "/").toLowerCase().replace(/\/+$/, "") || "/";
  if (p === "/api/health") return null;
  // Rover-only endpoints. /api/rover/stream is internal-strict — falling
  // back to "admin" let any logged-in operator open the SSE in a browser
  // and clobber the single roverClient slot, which silently kicked the
  // real rover off and routed subsequent calibrate-* events to the
  // browser response. Symptom on the operator side: cal start button
  // does nothing despite RTK-fixed + IDLE. Internal-only closes the door.
  if (
    p === "/api/rover/stream" ||
    // Camera control SSE + frame upload are rover→server only. Internal-strict
    // (deny browsers) for the same reason as /stream: a browser must not be
    // able to occupy the single camera-control slot or inject frames.
    p === "/api/rover/camera/control" ||
    p === "/api/rover/camera" ||
    // Obstacle reports come from the perception node only. Internal-strict so a
    // browser can't spoof an obstacle to pause a running mission + raise a false
    // operator alarm.
    p === "/api/rover/obstacle" ||
    p === "/api/rover/mission-report" ||
    // Base-station RTCM relay + survey result come from the GPS receiver only.
    // Internal-strict so a browser can't inject fake RTCM corrections into the
    // rover or forge a surveyed base coordinate.
    p === "/api/rover/base/rtcm" ||
    p === "/api/rover/base/survey-result" ||
    // Calibration progress is reported by the perception node only.
    p === "/api/rover/calibration-progress"
  ) {
    return isInternalRequest(req) ? null : "deny";
  }
  if (
    p === "/api/rover/position" ||
    p === "/api/rover/telemetry" ||
    p === "/api/rover/waypoint_reached" ||
    p === "/api/rover/waypoint_skipped" ||
    p === "/api/rover/spray_result" ||
    p === "/api/rover/antenna_calibration_result" ||
    p === "/api/rover/wheel_calibration_result" ||
    p === "/api/rover/logs"
  ) {
    return isInternalRequest(req) ? null : "admin";
  }
  // Rover control, mission history, and system logs stay admin-only. Only
  // course/cone management — plus the SPA shell and the SSE it needs for live
  // cone sync — is exposed to chief. The frontend hides the 로버/기록 tabs from
  // non-admins; these gates are the enforcing backstop.
  if (p.startsWith("/api/rover")) return "admin";
  if (p.startsWith("/api/missions")) return "admin";
  // GPS(수신기 소스 선택 + base station 측량점) — admin 전용. 프론트에서도
  // GPS 탭을 admin에게만 노출하며, 이 게이트가 강제한다.
  if (p.startsWith("/api/gps")) return "admin";
  if (p === "/api/logs") return "admin";
  // Snapshots overwrite the whole course on restore (destructive) and can be
  // deleted — admin-only, above plain cone management. Covers list/create/
  // restore/delete. The frontend hides the 스냅샷 button from non-admins too.
  if (/^\/api\/courses\/\d+\/snapshots/.test(p)) return "admin";
  // Deleting a course cascade-wipes its cones AND every snapshot of it (both
  // FK to course(id) ON DELETE CASCADE) — irreversible, so admin-only, in line
  // with snapshot delete above. Create/rename and cone editing stay chief.
  if (req.method === "DELETE" && /^\/api\/courses\/\d+$/.test(p)) return "admin";
  return "chief";
}

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager(200, { logger });

function getCourses() {
  return db.prepare(`
    SELECT c.id, c.name, c.created_at, c.updated_at, c.reverse, c.start_cone_id,
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

function getMemos(courseId) {
  return db.prepare("SELECT * FROM memo WHERE course_id = ? ORDER BY id").all(courseId);
}

// 연결에 role을 태깅해 rover 텔레메트리를 admin 연결로만 좁힐 수 있게 한다(rover-routes의
// broadcast 래퍼가 filterFn으로 사용). courses/cones/memos는 chief+ 전체에 전송된다.
// meta.role은 연결 시점 스냅샷이므로, sse 매니저의 주기 재검증으로 강등을 반영한다(즉시-권한-반영):
// 최신 role로 meta를 갱신(→ admin 필터가 재평가)하거나, chief 미만/삭제 시 연결을 종료한다.
async function revalidateSseRole(meta) {
  const email = meta.email;
  if (!email) return meta; // 검증 불가 → 유지

  // 미들웨어가 쓰는 바로 그 검증기를 재사용한다. 여기서 HTTP 클라이언트를 다시 구현하면
  // 404-vs-non-ok 해석이 두 곳에 생기고 한쪽만 테스트로 덮인다(주입 여부 분기도 함께 사라진다).
  const result = await app.validateUser(email);
  if (!result?.valid) {
    if (result?.transient) throw new Error("transient"); // 일시 장애 → 연결 유지(fail-open)
    return null;                                         // 삭제/비활성 → 연결 종료
  }
  // `?? meta.role` 폴백은 **주입된 검증기 전용**이다. 내장 경로는 여기 닿지 않는다 —
  // auth는 활성 사용자가 없으면 404를 주고(위에서 종료), 있으면 role이 NOT NULL이다.
  // 주입 stub이 role을 생략하면 예전 코드가 끊었을 연결을 유지하게 되므로, 그 차이를
  // 모르고 stub을 쓰지 않도록 남긴다.
  const role = result.role ?? meta.role;
  if (!role || (ROLE_LEVELS[role] || 0) < ROLE_LEVELS.chief) return null; // chief 미만 → 종료
  return { ...meta, role };                    // 최신 role 반영
}
app.get("/api/events", sseHandler(() => ({ courses: getCourses() }), {
  meta: (req) => ({ role: req.user?.role, email: req.user?.email }),
  revalidate: revalidateSseRole,
}));

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

// 고도(MSL, m)는 선택값. 없으면(null/undefined) null로 저장하고, 있으면 지표면에서
// 로버가 닿을 수 있는 합리적 범위의 유한수만 허용한다. value에 정규화된 값을 담아
// 호출부가 그대로 저장하도록 한다.
function validateAltitude(alt) {
  if (alt === undefined || alt === null) return { valid: true, value: null };
  if (typeof alt !== "number" || !Number.isFinite(alt) || alt < -1000 || alt > 10000) {
    return { valid: false, error: "고도가 올바르지 않습니다. (-1000 ~ 10000 m)" };
  }
  return { valid: true, value: alt };
}

function validateSide(side) {
  if (side !== "left" && side !== "right" && side !== "center") {
    return { valid: false, error: "콘 방향이 올바르지 않습니다. (left, right 또는 center)" };
  }
  return { valid: true };
}

// 메모의 실측 가로/세로 크기(m). 드래그로 조절되는 값이라 양의 유한수만 허용하고,
// 코스 규모를 훌쩍 넘는 값(오조작·클라이언트 버그)은 거른다.
function validateMemoDimension(v, label) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100000) {
    return { valid: false, error: `메모 ${label}가 올바르지 않습니다. (0 초과 100000 m 이하)` };
  }
  return { valid: true, value: v };
}

// 메모 회전 각도(deg). 없으면 0, 있으면 유한수만 허용하고 [0,360)으로 정규화한다.
function validateMemoRotation(v) {
  if (v === undefined || v === null) return { valid: true, value: 0 };
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { valid: false, error: "메모 회전 각도가 올바르지 않습니다." };
  }
  return { valid: true, value: ((v % 360) + 360) % 360 };
}

// 메모 본문. 비어 있어도 되지만 무한정 커지지 않도록 상한을 둔다.
function validateMemoContent(content) {
  if (content === undefined || content === null) return { valid: true, value: "" };
  if (typeof content !== "string") return { valid: false, error: "메모 내용이 올바르지 않습니다." };
  if (content.length > 5000) return { valid: false, error: "메모 내용이 너무 깁니다. (최대 5000자)" };
  return { valid: true, value: content };
}

function validateRouteMarkerLabel(label) {
  if (label === undefined || label === null) return { valid: true, value: "" };
  if (typeof label !== "string") return { valid: false, error: "주행 마커 이름이 올바르지 않습니다." };
  const value = label.trim();
  if (value.length > 50) return { valid: false, error: "주행 마커 이름이 너무 깁니다. (최대 50자)" };
  return { valid: true, value };
}

function getCourseById(id) {
  return db.prepare("SELECT * FROM course WHERE id = ?").get(id);
}

function getConeById(id) {
  return db.prepare("SELECT * FROM cone WHERE id = ?").get(id);
}

function getMemoById(id) {
  return db.prepare("SELECT * FROM memo WHERE id = ?").get(id);
}

function getRouteMarkerById(id) {
  return db.prepare("SELECT * FROM route_marker WHERE id = ?").get(id);
}

function getCourseRoute(courseId) {
  return {
    markers: db.prepare("SELECT * FROM route_marker WHERE course_id = ? ORDER BY id").all(courseId),
    steps: db.prepare("SELECT marker_id FROM route_step WHERE course_id = ? ORDER BY position").all(courseId).map((row) => row.marker_id),
  };
}

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
    db.prepare("INSERT INTO course (name, created_at, updated_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(validation.value);
    return db.prepare("SELECT * FROM course WHERE id = last_insert_rowid()").get();
  });

  if (!result.success) {
    if (result.error?.includes("UNIQUE")) {
      logger.warn(req, "course.create", { error: result.internalError || result.error }, validation.value);
      return res.status(400).send("이미 존재하는 코스 이름입니다.");
    }
    logger.warn(req, "course.create", { error: result.internalError || result.error }, validation.value);
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
    db.prepare("UPDATE course SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(validation.value, id);
    return db.prepare("SELECT * FROM course WHERE id = ?").get(id);
  });

  if (!result.success) {
    if (result.error?.includes("UNIQUE")) {
      logger.warn(req, "course.rename", { error: result.internalError || result.error }, course.name);
      return res.status(400).send("이미 존재하는 코스 이름입니다.");
    }
    logger.warn(req, "course.rename", { error: result.internalError || result.error }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.rename", { before: course.name, after: validation.value }, course.name);
  broadcastEvent("courses", { type: "rename", course: result.result, courses: getCourses() });
  res.json(result.result);
});

// PATCH /api/courses/:id/direction - 코스 진행 방향/시작 콘 저장 (모든 클라이언트 공유).
// reverse·start_cone_id 중 요청에 담긴 것만 갱신한다. start_cone_id는 이 코스에 속한
// 콘이어야 하며 null이면 자동 시작 게이트로 되돌린다.
app.patch("/api/courses/:id/direction", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const sets = [];
  const params = [];
  const detail = {};

  if ("reverse" in req.body) {
    if (typeof req.body.reverse !== "boolean") {
      return res.status(400).send("진행 방향(reverse)은 true 또는 false여야 합니다.");
    }
    sets.push("reverse = ?");
    params.push(req.body.reverse ? 1 : 0);
    detail.reverse = req.body.reverse;
  }

  if ("start_cone_id" in req.body) {
    const sc = req.body.start_cone_id;
    if (sc !== null) {
      if (!Number.isInteger(sc)) return res.status(400).send("시작 콘 ID가 올바르지 않습니다.");
      const cone = getConeById(sc);
      if (!cone || cone.course_id !== id) {
        return res.status(400).send("시작 콘이 이 코스에 속하지 않습니다.");
      }
    }
    sets.push("start_cone_id = ?");
    params.push(sc);
    detail.start_cone_id = sc;
  }

  if (sets.length === 0) return res.status(400).send("변경할 항목이 없습니다.");

  const result = dbRun(() => {
    db.prepare(`UPDATE course SET ${sets.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(...params, id);
    return db.prepare("SELECT * FROM course WHERE id = ?").get(id);
  });

  if (!result.success) {
    logger.warn(req, "course.direction", { error: result.internalError || result.error, ...detail }, course.name);
    return res.status(result.status).send(result.error);
  }
  if (!result.result) {
    // The course was deleted between the existence check and the UPDATE, so the
    // UPDATE matched 0 rows and the follow-up SELECT returned nothing. Report it
    // as gone rather than sending an empty body the client can't parse.
    logger.warn(req, "course.direction", { error: "course removed mid-update", ...detail }, course.name);
    return res.status(404).send("코스를 찾을 수 없습니다.");
  }

  logger.log(req, "course.direction", detail, course.name);
  broadcastEvent("courses", { type: "direction", course: result.result, courses: getCourses() });
  res.json(result.result);
});

// GET /api/courses/:id/export - 코스 JSON 다운로드
app.get("/api/courses/:id/export", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const cones = getCones(id);
  // Preserve the now-canonical travel direction and start cone. The start cone is
  // exported by its position in the cones array (cone ids are reassigned on
  // import), so a re-import restores it to the same physical cone.
  const startIndex = course.start_cone_id != null
    ? cones.findIndex((c) => c.id === course.start_cone_id)
    : -1;
  const route = getCourseRoute(id);
  const routeMarkerIndex = new Map(route.markers.map((marker, index) => [marker.id, index]));
  const data = {
    name: course.name,
    reverse: !!course.reverse,
    start_cone_index: startIndex >= 0 ? startIndex : null,
    cones: cones.map((c) => ({ lat: c.lat, lng: c.lng, alt: c.alt, side: c.side })),
    memos: getMemos(id).map((m) => ({ lat: m.lat, lng: m.lng, width: m.width, height: m.height, rotation: m.rotation, content: m.content })),
    route_markers: route.markers.map((marker) => ({ lat: marker.lat, lng: marker.lng, label: marker.label })),
    route_steps: route.steps.map((markerId) => routeMarkerIndex.get(markerId)),
  };

  logger.log(req, "course.export", { cone_count: cones.length, route_marker_count: route.markers.length, route_step_count: route.steps.length }, course.name);

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
  const simplified = cones.map((c) => ({ lat: c.lat, lng: c.lng, alt: c.alt, side: c.side }));
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
    logger.warn(req, "course.snapshot.create", { error: result.internalError || result.error }, course.name);
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
      const insert = db.prepare("INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
      // 방어심층: 스냅샷은 서버가 검증된 콘에서 생성하지만, 손상/조작된 행이 그대로 복원되지
      // 않도록 좌표를 재검증하고 유효한 콘만 재삽입한다. 이전 버전 스냅샷엔 alt가 없어 null 보존.
      let skippedCones = 0;
      for (const c of cones) {
        if (!validateCoordinate(c.lat, c.lng).valid) { skippedCones++; continue; }
        insert.run(id, c.lat, c.lng, typeof c.alt === "number" ? c.alt : null, c.side);
      }
      if (skippedCones) logger.warn(req, "course.snapshot.restore", { skipped_invalid_cones: skippedCones, snapshot_id: sid }, course.name);
      // Cones were replaced with fresh ids, so the designated start cone no longer
      // exists — reset to the auto start gate (snapshots carry no cone identity).
      db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(id);
      return getCones(id);
    })();
  });
  if (!result.success) {
    logger.warn(req, "course.snapshot.restore", { error: result.internalError || result.error, snapshot_id: sid }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.snapshot.restore", { snapshot_id: sid, cone_count: cones.length }, course.name);
  broadcastEvent("cones", { type: "restore", courseId: id, cones: result.result });
  broadcastEvent("courses", { type: "start_reset", course: getCourseById(id), courses: getCourses() });
  res.json({ cones: result.result });
});

app.delete("/api/courses/:id/snapshots/:sid", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sid = parseInt(req.params.sid, 10);
  if (isNaN(id) || isNaN(sid)) return res.status(400).send("올바르지 않은 ID입니다.");
  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");
  const snap = selectSnapshotById.get(sid);
  if (!snap || snap.course_id !== id) return res.status(404).send("스냅샷을 찾을 수 없습니다.");

  const result = dbRun(() => db.prepare("DELETE FROM course_snapshot WHERE id = ?").run(sid));
  if (!result.success) {
    logger.warn(req, "course.snapshot.delete", { error: result.internalError || result.error, snapshot_id: sid }, course.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "course.snapshot.delete", { snapshot_id: sid }, course.name);
  res.status(204).end();
});

// POST /api/courses/import - JSON으로 코스 추가
app.post("/api/courses/import", (req, res) => {
  const { name, cones } = req.body;

  const nameValidation = validateCourseName(name);
  if (!nameValidation.valid) {
    logger.warn(req, "course.import", { error: nameValidation.error }, name);
    return res.status(400).send(nameValidation.error);
  }

  if (!Array.isArray(cones)) {
    logger.warn(req, "course.import", { error: "올바르지 않은 콘 데이터입니다." }, name);
    return res.status(400).send("올바르지 않은 콘 데이터입니다.");
  }

  for (const cone of cones) {
    const cv = validateCoordinate(cone.lat, cone.lng);
    if (!cv.valid) {
      logger.warn(req, "course.import", { error: cv.error }, name);
      return res.status(400).send(cv.error);
    }
    const sv = validateSide(cone.side);
    if (!sv.valid) {
      logger.warn(req, "course.import", { error: sv.error }, name);
      return res.status(400).send(sv.error);
    }
    const av = validateAltitude(cone.alt);
    if (!av.valid) {
      logger.warn(req, "course.import", { error: av.error }, name);
      return res.status(400).send(av.error);
    }
  }

  // 메모는 선택 항목(예전 파일엔 없음). 있으면 각 필드를 콘과 같은 방식으로 검증한다.
  const memos = Array.isArray(req.body.memos) ? req.body.memos : [];
  for (const memo of memos) {
    const cv = validateCoordinate(memo.lat, memo.lng);
    if (!cv.valid) { logger.warn(req, "course.import", { error: cv.error }, name); return res.status(400).send(cv.error); }
    const wv = validateMemoDimension(memo.width, "너비");
    if (!wv.valid) { logger.warn(req, "course.import", { error: wv.error }, name); return res.status(400).send(wv.error); }
    const hv = validateMemoDimension(memo.height, "높이");
    if (!hv.valid) { logger.warn(req, "course.import", { error: hv.error }, name); return res.status(400).send(hv.error); }
    const rv = validateMemoRotation(memo.rotation);
    if (!rv.valid) { logger.warn(req, "course.import", { error: rv.error }, name); return res.status(400).send(rv.error); }
    const cnv = validateMemoContent(memo.content);
    if (!cnv.valid) { logger.warn(req, "course.import", { error: cnv.error }, name); return res.status(400).send(cnv.error); }
  }

  const routeMarkers = req.body.route_markers === undefined ? [] : req.body.route_markers;
  const routeSteps = req.body.route_steps === undefined ? [] : req.body.route_steps;
  if (!Array.isArray(routeMarkers) || !Array.isArray(routeSteps) || routeMarkers.length > 200 || routeSteps.length > 500) {
    logger.warn(req, "course.import", { error: "올바르지 않은 주행 마커 데이터입니다." }, name);
    return res.status(400).send("올바르지 않은 주행 마커 데이터입니다.");
  }
  for (const marker of routeMarkers) {
    const cv = validateCoordinate(marker.lat, marker.lng);
    if (!cv.valid) { logger.warn(req, "course.import", { error: cv.error }, name); return res.status(400).send(cv.error); }
    const lv = validateRouteMarkerLabel(marker.label);
    if (!lv.valid) { logger.warn(req, "course.import", { error: lv.error }, name); return res.status(400).send(lv.error); }
  }
  if (routeSteps.some((index) => !Number.isInteger(index) || index < 0 || index >= routeMarkers.length)) {
    logger.warn(req, "course.import", { error: "주행 순서가 존재하지 않는 마커를 참조합니다." }, name);
    return res.status(400).send("주행 순서가 존재하지 않는 마커를 참조합니다.");
  }

  const reverse = req.body.reverse ? 1 : 0;
  const startIndex = req.body.start_cone_index;
  const result = dbRun(() => {
    return db.transaction(() => {
      db.prepare("INSERT INTO course (name, created_at, updated_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(nameValidation.value);
      const courseId = db.prepare("SELECT id FROM course WHERE id = last_insert_rowid()").get().id;
      const insert = db.prepare("INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
      const coneIds = [];
      for (const cone of cones) coneIds.push(insert.run(courseId, cone.lat, cone.lng, typeof cone.alt === "number" ? cone.alt : null, cone.side).lastInsertRowid);
      // Restore travel direction + start cone (array index → the newly-inserted cone id).
      const startId = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < coneIds.length
        ? coneIds[startIndex]
        : null;
      db.prepare("UPDATE course SET reverse = ?, start_cone_id = ? WHERE id = ?").run(reverse, startId, courseId);
      if (memos.length) {
        const memoInsert = db.prepare("INSERT INTO memo (course_id, lat, lng, width, height, rotation, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
        for (const memo of memos) {
          memoInsert.run(courseId, memo.lat, memo.lng, memo.width, memo.height, validateMemoRotation(memo.rotation).value, typeof memo.content === "string" ? memo.content : "");
        }
      }
      const markerIds = [];
      if (routeMarkers.length) {
        const markerInsert = db.prepare("INSERT INTO route_marker (course_id, lat, lng, label) VALUES (?, ?, ?, ?)");
        for (const marker of routeMarkers) {
          markerIds.push(Number(markerInsert.run(courseId, marker.lat, marker.lng, validateRouteMarkerLabel(marker.label).value).lastInsertRowid));
        }
        const stepInsert = db.prepare("INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)");
        routeSteps.forEach((markerIndex, position) => stepInsert.run(courseId, position, markerIds[markerIndex]));
      }
      return { course: db.prepare("SELECT * FROM course WHERE id = ?").get(courseId), cones: getCones(courseId), memos: getMemos(courseId), route: getCourseRoute(courseId) };
    })();
  });

  if (!result.success) {
    const msg = result.error?.includes("UNIQUE") ? "이미 존재하는 코스 이름입니다." : result.error;
    logger.warn(req, "course.import", { error: result.internalError || msg }, name);
    if (result.error?.includes("UNIQUE")) return res.status(400).send("이미 존재하는 코스 이름입니다.");
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.import", { cone_count: cones.length, memo_count: memos.length, route_marker_count: routeMarkers.length, route_step_count: routeSteps.length }, nameValidation.value);
  broadcastEvent("courses", { type: "create", course: result.result.course, courses: getCourses() });
  broadcastEvent("cones", { type: "add", courseId: result.result.course.id, cones: result.result.cones });
  if (result.result.memos.length) {
    broadcastEvent("memos", { type: "add", courseId: result.result.course.id, memos: result.result.memos });
  }
  if (result.result.route.markers.length) {
    broadcastEvent("route", { type: "import", courseId: result.result.course.id, ...result.result.route });
  }
  res.status(201).json(result.result.course);
});

// DELETE /api/courses/:id - 코스 삭제 (콘도 CASCADE 삭제)
app.delete("/api/courses/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const activeMission = db.prepare(`SELECT id,lifecycle_state,plan_hash FROM mission
    WHERE course_id=? AND lifecycle_state IN
    ('ready','starting','running','pausing','paused','interrupted','resuming')
    ORDER BY id DESC LIMIT 1`).get(id);
  if (activeMission) {
    logger.warn(req, "course.delete", {
      error: "active_mission_course",
      reason: "active_mission_course",
      course_id: id,
      mission_id: activeMission.id,
      mission_state: activeMission.lifecycle_state,
      plan_hash: activeMission.plan_hash,
    }, course.name);
    return res.status(409).json({
      message: "진행 중인 미션이 사용하는 코스는 삭제할 수 없습니다.",
      reason: "active_mission_course",
      mission_id: activeMission.id,
    });
  }

  const result = dbRun(() => db.transaction(() => {
    // course 삭제는 최신 스키마에서 여러 편집 자산을 cascade하고 완료된 미션 기록은
    // 보존한 채 연결만 끊는다. 삭제 전 범위를 같은 트랜잭션에서 세어 감사 로그가
    // 실제 적용 결과와 어긋나지 않게 한다.
    const cascade = {
      cones: db.prepare("SELECT COUNT(*) AS count FROM cone WHERE course_id = ?").get(id).count,
      memos: db.prepare("SELECT COUNT(*) AS count FROM memo WHERE course_id = ?").get(id).count,
      route_markers: db.prepare("SELECT COUNT(*) AS count FROM route_marker WHERE course_id = ?").get(id).count,
      route_steps: db.prepare("SELECT COUNT(*) AS count FROM route_step WHERE course_id = ?").get(id).count,
      snapshots: db.prepare("SELECT COUNT(*) AS count FROM course_snapshot WHERE course_id = ?").get(id).count,
      mission_presets: db.prepare("SELECT COUNT(*) AS count FROM mission_route_preset WHERE course_id = ?").get(id).count,
      mission_preset_items: db.prepare(`SELECT COUNT(*) AS count
        FROM mission_route_preset_item item
        JOIN mission_route_preset preset ON preset.id = item.preset_id
        WHERE preset.course_id = ?`).get(id).count,
    };
    const detached = {
      missions: db.prepare("SELECT COUNT(*) AS count FROM mission WHERE course_id = ?").get(id).count,
      mission_waypoints: db.prepare(`SELECT COUNT(*) AS count
        FROM mission_waypoint waypoint
        JOIN cone ON cone.id = waypoint.cone_id
        WHERE cone.course_id = ?`).get(id).count,
    };
    db.prepare("DELETE FROM course WHERE id = ?").run(id);
    return { cascade, detached };
  })());
  if (!result.success) {
    logger.warn(req, "course.delete", { error: result.internalError || result.error }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "course.delete", { course_id: id, ...result.result }, course.name);
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

  const { lat, lng, side, alt } = req.body;

  const coordValidation = validateCoordinate(lat, lng);
  if (!coordValidation.valid) return res.status(400).send(coordValidation.error);

  const altValidation = validateAltitude(alt);
  if (!altValidation.valid) return res.status(400).send(altValidation.error);

  const sideValidation = validateSide(side);
  if (!sideValidation.valid) return res.status(400).send(sideValidation.error);

  const result = dbRun(() => {
    db.prepare("INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(courseId, lat, lng, altValidation.value, side);
    return db.prepare("SELECT * FROM cone WHERE id = last_insert_rowid()").get();
  });

  if (!result.success) {
    logger.warn(req, "cone.create", { error: result.internalError || result.error }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "cone.create", { lat, lng, alt: altValidation.value, side }, course.name);
  broadcastEvent("cones", { type: "add", courseId, cone: result.result, cones: getCones(courseId) });
  res.status(201).json(result.result);
});

// DELETE /api/courses/:id/cones - 코스의 모든 콘 삭제 (전체 삭제).
// Destructive bulk wipe: a single audit entry (vs. N per-cone deletes) and one
// SSE broadcast. Chief-allowed, matching per-cone/multi-select delete — a chief
// can already clear every cone one by one.
app.delete("/api/courses/:id/cones", (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  if (isNaN(courseId)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(courseId);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const count = getCones(courseId).length;
  const hadStart = course.start_cone_id != null;
  const result = dbRun(() => db.transaction(() => {
    db.prepare("DELETE FROM cone WHERE course_id = ?").run(courseId);
    // Wiping every cone also invalidates the designated start cone.
    if (hadStart) db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(courseId);
  })());

  if (!result.success) {
    logger.warn(req, "cone.delete_all", { error: result.internalError || result.error, count }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "cone.delete_all", { count }, course.name);
  broadcastEvent("cones", { type: "clear", courseId, cones: [] });
  if (hadStart) broadcastEvent("courses", { type: "start_reset", course: getCourseById(courseId), courses: getCourses() });
  res.status(200).json({ deleted: count });
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

  if (req.body.alt !== undefined) {
    const altValidation = validateAltitude(req.body.alt);
    if (!altValidation.valid) return res.status(400).send(altValidation.error);
    setClauses.push("alt = ?"); values.push(altValidation.value);
  }

  if (req.body.side !== undefined) {
    const sideValidation = validateSide(req.body.side);
    if (!sideValidation.valid) return res.status(400).send(sideValidation.error);
    setClauses.push("side = ?"); values.push(req.body.side);
  }

  if (setClauses.length === 0) {
    return res.status(400).send("수정할 필드가 없습니다.");
  }

  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");

  const result = dbRun(() => {
    values.push(id);
    db.prepare(`UPDATE cone SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    return db.prepare("SELECT * FROM cone WHERE id = ?").get(id);
  });

  if (!result.success) {
    const updateCourse = getCourseById(cone.course_id);
    logger.warn(req, "cone.update", { error: result.internalError || result.error }, updateCourse?.name);
    return res.status(result.status).send(result.error);
  }

  const updateCourse = getCourseById(cone.course_id);
  logger.log(req, "cone.update", { before: { lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side }, after: { lat: result.result.lat, lng: result.result.lng, alt: result.result.alt, side: result.result.side } }, updateCourse?.name);
  broadcastEvent("cones", { type: "update", courseId: cone.course_id, cone: result.result, cones: getCones(cone.course_id) });
  res.json(result.result);
});

// DELETE /api/cones/:id - 콘 삭제
app.delete("/api/cones/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 콘 ID입니다.");

  const cone = getConeById(id);
  if (!cone) return res.status(404).send("콘을 찾을 수 없습니다.");

  // If this cone is its course's designated start, clear it in the same tx so the
  // shared start_cone_id never dangles at a now-deleted cone.
  const wasStart = getCourseById(cone.course_id)?.start_cone_id === id;
  const result = dbRun(() => db.transaction(() => {
    db.prepare("DELETE FROM cone WHERE id = ?").run(id);
    if (wasStart) db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(cone.course_id);
  })());
  if (!result.success) {
    const delCourse = getCourseById(cone.course_id);
    logger.warn(req, "cone.delete", { error: result.internalError || result.error }, delCourse?.name);
    return res.status(result.status).send(result.error);
  }

  const delCourse = getCourseById(cone.course_id);
  logger.log(req, "cone.delete", { lat: cone.lat, lng: cone.lng, side: cone.side }, delCourse?.name);
  broadcastEvent("cones", { type: "delete", courseId: cone.course_id, coneId: id, cones: getCones(cone.course_id) });
  if (wasStart) broadcastEvent("courses", { type: "start_reset", course: delCourse, courses: getCourses() });
  res.status(200).send();
});

/* ============================================
   API 라우트: 주행 순서 마커
   ============================================ */

function rejectRouteRequest(req, res, status, action, message, course = null, context = {}) {
  logger.warn(req, action, { error: message, ...context }, course?.name);
  return res.status(status).send(message);
}

app.get("/api/courses/:id/route", (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  if (isNaN(courseId)) return rejectRouteRequest(req, res, 400, "course_route.read", "올바르지 않은 코스 ID입니다.");
  const course = getCourseById(courseId);
  if (!course) return rejectRouteRequest(req, res, 404, "course_route.read", "코스를 찾을 수 없습니다.", null, { course_id: courseId });
  const result = dbRun(() => getCourseRoute(courseId));
  if (!result.success) {
    logger.warn(req, "course_route.read", {
      error: result.internalError || result.error,
      course_id: courseId,
    }, course.name);
    return res.status(result.status).send(result.error);
  }
  res.json(result.result);
});

app.post("/api/courses/:id/route/markers", (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  if (isNaN(courseId)) return rejectRouteRequest(req, res, 400, "route_marker.create", "올바르지 않은 코스 ID입니다.");
  const course = getCourseById(courseId);
  if (!course) return rejectRouteRequest(req, res, 404, "route_marker.create", "코스를 찾을 수 없습니다.", null, { course_id: courseId });
  const body = req.body || {};
  const coord = validateCoordinate(body.lat, body.lng);
  if (!coord.valid) return rejectRouteRequest(req, res, 400, "route_marker.create", coord.error, course, { lat: body.lat, lng: body.lng });
  const label = validateRouteMarkerLabel(body.label);
  if (!label.valid) return rejectRouteRequest(req, res, 400, "route_marker.create", label.error, course);
  const markerCount = db.prepare("SELECT COUNT(*) AS n FROM route_marker WHERE course_id = ?").get(courseId).n;
  if (markerCount >= 200) return rejectRouteRequest(req, res, 400, "route_marker.create", "주행 마커는 코스당 최대 200개까지 만들 수 있습니다.", course, { marker_count: markerCount });
  const result = dbRun(() => {
    const info = db.prepare("INSERT INTO route_marker (course_id, lat, lng, label) VALUES (?, ?, ?, ?)")
      .run(courseId, body.lat, body.lng, label.value);
    const marker = db.prepare("SELECT * FROM route_marker WHERE id = ?").get(info.lastInsertRowid);
    return { marker, route: getCourseRoute(courseId) };
  });
  if (!result.success) {
    logger.warn(req, "route_marker.create", { error: result.internalError || result.error, lat: body.lat, lng: body.lng }, course.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "route_marker.create", { marker_id: result.result.marker.id, lat: body.lat, lng: body.lng, label: label.value }, course.name);
  broadcastEvent("route", { type: "marker_add", courseId, ...result.result.route });
  res.status(201).json(result.result.marker);
});

app.patch("/api/route/markers/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return rejectRouteRequest(req, res, 400, "route_marker.update", "올바르지 않은 주행 마커 ID입니다.");
  const marker = getRouteMarkerById(id);
  if (!marker) return rejectRouteRequest(req, res, 404, "route_marker.update", "주행 마커를 찾을 수 없습니다.", null, { marker_id: id });
  const course = getCourseById(marker.course_id);
  const body = req.body || {};
  const sets = [], values = [];
  if (body.lat !== undefined || body.lng !== undefined) {
    const lat = body.lat ?? marker.lat, lng = body.lng ?? marker.lng;
    const coord = validateCoordinate(lat, lng);
    if (!coord.valid) return rejectRouteRequest(req, res, 400, "route_marker.update", coord.error, course, { marker_id: id, lat, lng });
    if (body.lat !== undefined) { sets.push("lat = ?"); values.push(body.lat); }
    if (body.lng !== undefined) { sets.push("lng = ?"); values.push(body.lng); }
  }
  if (body.label !== undefined) {
    const label = validateRouteMarkerLabel(body.label);
    if (!label.valid) return rejectRouteRequest(req, res, 400, "route_marker.update", label.error, course, { marker_id: id });
    sets.push("label = ?"); values.push(label.value);
  }
  if (!sets.length) return rejectRouteRequest(req, res, 400, "route_marker.update", "수정할 필드가 없습니다.", course, { marker_id: id });
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const result = dbRun(() => {
    db.prepare(`UPDATE route_marker SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return { marker: getRouteMarkerById(id), route: getCourseRoute(marker.course_id) };
  });
  if (!result.success) {
    logger.warn(req, "route_marker.update", { error: result.internalError || result.error, marker_id: id }, course?.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "route_marker.update", {
    marker_id: id,
    before: { lat: marker.lat, lng: marker.lng, label: marker.label },
    after: { lat: result.result.marker.lat, lng: result.result.marker.lng, label: result.result.marker.label },
  }, course?.name);
  broadcastEvent("route", { type: "marker_update", courseId: marker.course_id, ...result.result.route });
  res.json(result.result.marker);
});

app.delete("/api/route/markers/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return rejectRouteRequest(req, res, 400, "route_marker.delete", "올바르지 않은 주행 마커 ID입니다.");
  const marker = getRouteMarkerById(id);
  if (!marker) return rejectRouteRequest(req, res, 404, "route_marker.delete", "주행 마커를 찾을 수 없습니다.", null, { marker_id: id });
  const course = getCourseById(marker.course_id);
  const before = getCourseRoute(marker.course_id);
  const result = dbRun(() => db.transaction(() => {
    db.prepare("DELETE FROM route_marker WHERE id = ?").run(id);
    // ON DELETE CASCADE removes visits; compact positions to keep exports stable.
    const steps = db.prepare("SELECT marker_id FROM route_step WHERE course_id = ? ORDER BY position").all(marker.course_id);
    db.prepare("DELETE FROM route_step WHERE course_id = ?").run(marker.course_id);
    const insert = db.prepare("INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)");
    steps.forEach((row, position) => insert.run(marker.course_id, position, row.marker_id));
    return getCourseRoute(marker.course_id);
  })());
  if (!result.success) {
    logger.warn(req, "route_marker.delete", { error: result.internalError || result.error, marker_id: id, visit_count: before.steps.filter((x) => x === id).length }, course?.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "route_marker.delete", { marker_id: id, lat: marker.lat, lng: marker.lng, label: marker.label, removed_visits: before.steps.filter((x) => x === id).length }, course?.name);
  broadcastEvent("route", { type: "marker_delete", courseId: marker.course_id, ...result.result });
  res.status(200).json(result.result);
});

app.put("/api/courses/:id/route/steps", (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  if (isNaN(courseId)) return rejectRouteRequest(req, res, 400, "course_route.update", "올바르지 않은 코스 ID입니다.");
  const course = getCourseById(courseId);
  if (!course) return rejectRouteRequest(req, res, 404, "course_route.update", "코스를 찾을 수 없습니다.", null, { course_id: courseId });
  const steps = req.body?.steps;
  if (!Array.isArray(steps) || steps.length > 500 || steps.some((id) => !Number.isInteger(id))) {
    return rejectRouteRequest(req, res, 400, "course_route.update", "주행 순서가 올바르지 않습니다. (정수 마커 ID, 최대 500단계)", course, { requested: steps });
  }
  const markers = db.prepare("SELECT id FROM route_marker WHERE course_id = ?").all(courseId);
  const allowed = new Set(markers.map((row) => row.id));
  if (steps.some((id) => !allowed.has(id))) return rejectRouteRequest(req, res, 400, "course_route.update", "다른 코스이거나 존재하지 않는 주행 마커가 포함되어 있습니다.", course, { requested: steps });
  const before = getCourseRoute(courseId).steps;
  const result = dbRun(() => db.transaction(() => {
    db.prepare("DELETE FROM route_step WHERE course_id = ?").run(courseId);
    const insert = db.prepare("INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)");
    steps.forEach((markerId, position) => insert.run(courseId, position, markerId));
    return getCourseRoute(courseId);
  })());
  if (!result.success) {
    logger.warn(req, "course_route.update", { error: result.internalError || result.error, before, requested: steps }, course.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "course_route.update", { before, after: steps }, course.name);
  broadcastEvent("route", { type: "steps", courseId, ...result.result });
  res.json(result.result);
});

/* ============================================
   API 라우트: 메모 스티커
   ============================================ */

// GET /api/courses/:id/memos - 코스의 메모 목록 조회
app.get("/api/courses/:id/memos", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(id);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const result = dbRun(() => getMemos(id));
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/courses/:id/memos - 메모 추가
app.post("/api/courses/:id/memos", (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  if (isNaN(courseId)) return res.status(400).send("올바르지 않은 코스 ID입니다.");

  const course = getCourseById(courseId);
  if (!course) return res.status(404).send("코스를 찾을 수 없습니다.");

  const { lat, lng, width, height, rotation, content } = req.body;

  const coordValidation = validateCoordinate(lat, lng);
  if (!coordValidation.valid) return res.status(400).send(coordValidation.error);
  const wV = validateMemoDimension(width, "너비");
  if (!wV.valid) return res.status(400).send(wV.error);
  const hV = validateMemoDimension(height, "높이");
  if (!hV.valid) return res.status(400).send(hV.error);
  const rV = validateMemoRotation(rotation);
  if (!rV.valid) return res.status(400).send(rV.error);
  const cV = validateMemoContent(content);
  if (!cV.valid) return res.status(400).send(cV.error);

  const result = dbRun(() => {
    db.prepare("INSERT INTO memo (course_id, lat, lng, width, height, rotation, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(courseId, lat, lng, wV.value, hV.value, rV.value, cV.value);
    return db.prepare("SELECT * FROM memo WHERE id = last_insert_rowid()").get();
  });

  if (!result.success) {
    logger.warn(req, "memo.create", { error: result.internalError || result.error }, course.name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "memo.create", { lat, lng, width: wV.value, height: hV.value, rotation: rV.value }, course.name);
  broadcastEvent("memos", { type: "add", courseId, memo: result.result, memos: getMemos(courseId) });
  res.status(201).json(result.result);
});

// PATCH /api/memos/:id - 메모 수정 (위치, 크기, 내용)
app.patch("/api/memos/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 메모 ID입니다.");

  const memo = getMemoById(id);
  if (!memo) return res.status(404).send("메모를 찾을 수 없습니다.");

  const setClauses = [];
  const values = [];

  if (req.body.lat !== undefined || req.body.lng !== undefined) {
    const lat = req.body.lat !== undefined ? req.body.lat : memo.lat;
    const lng = req.body.lng !== undefined ? req.body.lng : memo.lng;
    const coordValidation = validateCoordinate(lat, lng);
    if (!coordValidation.valid) return res.status(400).send(coordValidation.error);
    if (req.body.lat !== undefined) { setClauses.push("lat = ?"); values.push(lat); }
    if (req.body.lng !== undefined) { setClauses.push("lng = ?"); values.push(lng); }
  }

  if (req.body.width !== undefined) {
    const wV = validateMemoDimension(req.body.width, "너비");
    if (!wV.valid) return res.status(400).send(wV.error);
    setClauses.push("width = ?"); values.push(wV.value);
  }

  if (req.body.height !== undefined) {
    const hV = validateMemoDimension(req.body.height, "높이");
    if (!hV.valid) return res.status(400).send(hV.error);
    setClauses.push("height = ?"); values.push(hV.value);
  }

  if (req.body.rotation !== undefined) {
    const rV = validateMemoRotation(req.body.rotation);
    if (!rV.valid) return res.status(400).send(rV.error);
    setClauses.push("rotation = ?"); values.push(rV.value);
  }

  if (req.body.content !== undefined) {
    const cV = validateMemoContent(req.body.content);
    if (!cV.valid) return res.status(400).send(cV.error);
    setClauses.push("content = ?"); values.push(cV.value);
  }

  if (setClauses.length === 0) {
    return res.status(400).send("수정할 필드가 없습니다.");
  }

  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");

  const result = dbRun(() => {
    values.push(id);
    db.prepare(`UPDATE memo SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    return db.prepare("SELECT * FROM memo WHERE id = ?").get(id);
  });

  if (!result.success) {
    const memoCourse = getCourseById(memo.course_id);
    logger.warn(req, "memo.update", { error: result.internalError || result.error }, memoCourse?.name);
    return res.status(result.status).send(result.error);
  }

  const memoCourse = getCourseById(memo.course_id);
  // 변경된 필드만 before/after로 기록한다. content는 길 수 있으므로 100자로 자른다.
  const changes = {};
  for (const field of ["lat", "lng", "width", "height", "rotation", "content"]) {
    if (memo[field] !== result.result[field]) {
      const truncate = (v) => field === "content" && typeof v === "string" ? v.slice(0, 100) : v;
      changes[field] = { from: truncate(memo[field]), to: truncate(result.result[field]) };
    }
  }
  logger.log(req, "memo.update", { changes }, memoCourse?.name);
  broadcastEvent("memos", { type: "update", courseId: memo.course_id, memo: result.result, memos: getMemos(memo.course_id) });
  res.json(result.result);
});

// DELETE /api/memos/:id - 메모 삭제
app.delete("/api/memos/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send("올바르지 않은 메모 ID입니다.");

  const memo = getMemoById(id);
  if (!memo) return res.status(404).send("메모를 찾을 수 없습니다.");

  const result = dbRun(() => db.prepare("DELETE FROM memo WHERE id = ?").run(id));
  if (!result.success) {
    const delCourse = getCourseById(memo.course_id);
    logger.warn(req, "memo.delete", { error: result.internalError || result.error }, delCourse?.name);
    return res.status(result.status).send(result.error);
  }

  const delCourse = getCourseById(memo.course_id);
  logger.log(req, "memo.delete", { lat: memo.lat, lng: memo.lng }, delCourse?.name);
  broadcastEvent("memos", { type: "delete", courseId: memo.course_id, memoId: id, memos: getMemos(memo.course_id) });
  res.status(200).send();
});

registerRoverRoutes(app, {
  express,
  db,
  dbRun,
  logger,
  broadcastEvent,
  getCourseById,
  getCones,
  takeCourseSnapshot,
  validateCoordinate,
  validateAltitude,
  deviceStaleMs: options.deviceStaleMs,
  deviceWatchdogTickMs: options.deviceWatchdogTickMs,
});

/* ============================================
   SPA Fallback
   ============================================ */
app.use("/api", (req, res) => {
  res.status(404).send("API endpoint not found.");
});

addSpaFallback(app);

return { app, db };
}

runIfDirect(import.meta, "course", createCourseApp);
