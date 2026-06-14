import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { EVENT_TYPES } from "../shared/constants.js";

export function createTrafficApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/traffic.db");

// 동적 기록 테이블과 구분되는 예약 테이블 이름. 동적 테이블을 열거하는 모든
// 쿼리에서 제외해야 한다(아래 reservedSql).
const RESERVED_TABLES = [
  "controller", "event_mode", "record_visibility", "logs",
  "wireless_event", "wireless_mapping", "wireless_telemetry", "wireless_light",
];
const reservedSql = RESERVED_TABLES.map((n) => `'${n}'`).join(", ");

db.exec(`CREATE TABLE IF NOT EXISTS controller (
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL
);`);

db.exec(`CREATE TABLE IF NOT EXISTS event_mode (
  event_type TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1
);`);

db.exec(`CREATE TABLE IF NOT EXISTS record_visibility (
  name TEXT PRIMARY KEY,
  visible INTEGER NOT NULL DEFAULT 1
);`);

/* ============================================
   무선(LoRa) 계측 서브시스템 테이블
   - 마스터 노드에 연결된 브리지 PC가 모든 센서의 raw 이벤트·진단·신호등 상태를
     서버로 push, 나머지 클라이언트는 SSE로 수신. (DESIGN §9)
   ============================================ */

// 모든 센서의 raw 타이밍 이벤트(전부 영구 저장). master_tick은 64-bit라 TEXT로
// 저장(JS 정수 정밀도 손실 방지). (node_id, ev_seq) UNIQUE로 멱등 ingest.
db.exec(`CREATE TABLE IF NOT EXISTS wireless_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     TEXT NOT NULL,
  master_tick TEXT,
  ev_seq      INTEGER,
  server_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  rssi        REAL,
  snr         REAL,
  link_state  TEXT,
  raw         TEXT
);`);
db.exec("CREATE INDEX IF NOT EXISTS idx_wevent_server_time ON wireless_event(server_time)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wevent_dedupe ON wireless_event(node_id, ev_seq)");

// 센서 -> 경기·역할 매핑 (UI에서 설정, 서버 영구 저장).
db.exec(`CREATE TABLE IF NOT EXISTS wireless_mapping (
  node_id    TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  role       TEXT NOT NULL,
  label      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);`);

// 진단 스냅샷 이력(경량 — node당 throttle 저장). 실시간 값은 메모리 + SSE.
db.exec(`CREATE TABLE IF NOT EXISTS wireless_telemetry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     TEXT NOT NULL,
  server_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  rssi        REAL,
  snr         REAL,
  offset_us   INTEGER,
  skew_ppm    REAL,
  latency_ms  REAL,
  link_state  TEXT
);`);
db.exec("CREATE INDEX IF NOT EXISTS idx_wtel_node_time ON wireless_telemetry(node_id, server_time)");

// 신호등/콘솔 단일 상태(점유 잠금 + 현재 색 + green tick). 서버 재시작에도 유지.
db.exec(`CREATE TABLE IF NOT EXISTS wireless_light (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  owner_event   TEXT,
  owner_actor   TEXT,
  light_color   TEXT,
  green_tick    TEXT,
  bridge_online INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);`);
db.exec("INSERT OR IGNORE INTO wireless_light (id, light_color, bridge_online) VALUES (1, 'off', 0)");

// 기본 경기 모드 시딩
{
  const insert = db.prepare("INSERT OR IGNORE INTO event_mode (event_type, enabled) VALUES (?, 1)");
  for (const type of EVENT_TYPES) {
    insert.run(type);
  }
}

// 기존 동적 테이블들에 누락 컬럼 추가 (startup에서 1회 실행)
{
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${reservedSql})`)
    .all();
  for (const { name } of tables) {
    if (!/^[A-Za-z0-9가-힣 .\-_]+$/.test(name)) continue;
    const columns = db.prepare(`PRAGMA table_info('${name}')`).all();
    if (!columns.some((c) => c.name === "invalidated")) {
      db.exec(`ALTER TABLE '${name}' ADD COLUMN invalidated INTEGER DEFAULT 0`);
    }
    if (!columns.some((c) => c.name === "scoreboard")) {
      db.exec(`ALTER TABLE '${name}' ADD COLUMN scoreboard INTEGER DEFAULT 1`);
      db.exec(`UPDATE '${name}' SET scoreboard = 0 WHERE invalidated = 1`);
    }
    if (!columns.some((c) => c.name === "cones")) {
      db.exec(`ALTER TABLE '${name}' ADD COLUMN cones INTEGER DEFAULT 0`);
    }
    if (!columns.some((c) => c.name === "oc")) {
      db.exec(`ALTER TABLE '${name}' ADD COLUMN oc INTEGER DEFAULT 0`);
    }
  }
}

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "traffic");

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  return "admin";
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

function getRecordFiles() {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${reservedSql})`)
    .all();
  return tables.map((table) => table.name);
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

/* ============================================
   무선 계측: 실시간 상태(메모리) + 헬퍼
   ============================================ */
// node별 최신 진단(실시간, 미영속). _lastPersist는 throttle 저장용 내부 필드.
const liveTelemetry = new Map();
const TELEMETRY_PERSIST_MS = 10000;
let bridgeOnline = false;
let lastBridgeSeen = 0;
let lastBridgeSeenIso = null;

function getLightState() {
  return db.prepare("SELECT owner_event, owner_actor, light_color, green_tick, bridge_online, updated_at FROM wireless_light WHERE id = 1").get();
}
function getMapping() {
  return db.prepare("SELECT node_id, event_type, role, label, enabled, updated_at FROM wireless_mapping ORDER BY event_type, role").all();
}
function getLiveTelemetry() {
  const out = [];
  for (const [node_id, t] of liveTelemetry) {
    out.push({ node_id, rssi: t.rssi, snr: t.snr, offset_us: t.offset_us, skew_ppm: t.skew_ppm, latency_ms: t.latency_ms, link_state: t.link_state, last_seen: t.last_seen });
  }
  return out;
}
function getBridgeState() {
  return { online: bridgeOnline, last_seen: lastBridgeSeenIso };
}
// 브리지 ingest 도착 = heartbeat. 오프라인->온라인 전환 시 true 반환(SSE 발행됨).
function markBridgeSeen() {
  lastBridgeSeen = Date.now();
  lastBridgeSeenIso = new Date(lastBridgeSeen).toISOString();
  if (!bridgeOnline) {
    bridgeOnline = true;
    db.prepare("UPDATE wireless_light SET bridge_online = 1 WHERE id = 1").run();
    broadcastEvent("wireless:bridge", getBridgeState());
    return true;
  }
  return false;
}

function validateNodeId(s) {
  return typeof s === "string" && /^[A-Za-z0-9_\-:.]{1,64}$/.test(s);
}
// 64-bit tick: 숫자 문자열 또는 정수 number 허용 -> TEXT. 잘못된 값이면 undefined.
function tickToText(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) return v;
  return undefined;
}
const ALLOWED_ROLE = /^(start|finish|lane[1-9])$/;

// 브리지 오프라인 감지(15s 무수신). 백그라운드라 logger는 actorOverride 사용.
const bridgeWatch = setInterval(() => {
  if (bridgeOnline && Date.now() - lastBridgeSeen > 15000) {
    bridgeOnline = false;
    try {
      db.prepare("UPDATE wireless_light SET bridge_online = 0 WHERE id = 1").run();
      broadcastEvent("wireless:bridge", getBridgeState());
      logger.log(null, "wireless.bridge", { online: false, last_seen: lastBridgeSeenIso }, "bridge",
        { email: "system", name: "system", role: "admin" });
    } catch (e) { console.error("[wireless] bridge watch:", e.message || e); }
  }
}, 5000);
bridgeWatch.unref?.();

// raw 이벤트 보존 한도(약 50만 행). 백그라운드 트림.
const RETAIN_EVENTS = 500000;
const eventRetention = setInterval(() => {
  try {
    const row = db.prepare("SELECT MAX(id) AS m FROM wireless_event").get();
    if (row && row.m > RETAIN_EVENTS) {
      db.prepare("DELETE FROM wireless_event WHERE id <= ?").run(row.m - RETAIN_EVENTS);
    }
  } catch (e) { console.error("[wireless] event retention:", e.message || e); }
}, 60000);
eventRetention.unref?.();

// SSE 엔드포인트
app.get("/api/events", sseHandler(() => ({
  recordFiles: getRecordFiles(),
  eventModes: getEventModes(),
  recordVisibility: getRecordVisibility(),
  wireless: {
    light: getLightState(),
    mapping: getMapping(),
    telemetry: getLiveTelemetry(),
    bridge: getBridgeState(),
  },
})));

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateRecordName(name) {
  if (name === undefined || name === null || typeof name !== "string" || name.trim() === "") {
    return { valid: false, error: "올바르지 않은 기록 이름입니다." };
  }
  // 파일 경로에 사용할 수 없는 문자들을 .으로 치환
  const sanitized = name.trim().replace(/[/\\:*?"<>|']/g, ".");
  if (!/^[A-Za-z0-9가-힣 .\-_]+$/.test(sanitized)) {
    return { valid: false, error: "올바르지 않은 기록 이름입니다." };
  }
  return { valid: true, value: sanitized };
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function validateRecordData(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "올바르지 않은 기록 데이터입니다." };
  }

  const required = ["time", "type", "entry", "result"];
  for (const field of required) {
    if (data[field] === undefined) {
      return { valid: false, error: `필수 필드가 누락되었습니다: ${field}` };
    }
  }

  if (!data.entry || typeof data.entry !== "object") {
    return { valid: false, error: "올바르지 않은 엔트리 데이터입니다." };
  }

  if (typeof data.result !== "number" || !Number.isInteger(data.result)) {
    return { valid: false, error: "결과값이 올바르지 않습니다." };
  }
  if (data.detail !== undefined && data.detail !== null && typeof data.detail !== "string") {
    return { valid: false, error: "상세 정보가 올바르지 않습니다." };
  }
  if (!data.entry.num || typeof data.entry.num !== "number" || !Number.isInteger(data.entry.num) || data.entry.num < 1) {
    return { valid: false, error: "엔트리 번호가 올바르지 않습니다." };
  }
  if (!data.entry.univ || typeof data.entry.univ !== "string") {
    return { valid: false, error: "올바르지 않은 엔트리 데이터입니다." };
  }
  if (!data.entry.team || typeof data.entry.team !== "string") {
    return { valid: false, error: "올바르지 않은 엔트리 데이터입니다." };
  }

  return { valid: true };
}

function validateControllerData({ timestamp, data }) {
  if (timestamp === undefined || timestamp === null) {
    return { valid: false, error: "타임스탬프가 누락되었습니다." };
  }
  if (typeof timestamp !== "string") {
    return { valid: false, error: "타임스탬프 형식이 올바르지 않습니다." };
  }
  if (data === undefined || data === null) {
    return { valid: false, error: "데이터가 누락되었습니다." };
  }
  if (typeof data !== "string") {
    return { valid: false, error: "데이터 형식이 올바르지 않습니다." };
  }
  return { valid: true };
}

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   API 라우트: /api/records
   ============================================ */

// GET /api/records - 모든 기록 테이블 목록 조회
app.get("/api/records", (req, res) => {
  const result = dbRun(() => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${reservedSql})`,
      )
      .all();
    return tables.map((table) => table.name);
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// GET /api/records/visibility - 기록 파일별 성적 반영 상태 조회
app.get("/api/records/visibility", (req, res) => {
  res.json(getRecordVisibility());
});

// PUT /api/records/:name/visibility - 기록 파일 성적 반영 토글
app.put("/api/records/:name/visibility", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = validation.value;

  if (!tableExists(name)) {
    return res.status(404).send("기록을 찾을 수 없습니다.");
  }

  const result = dbRun(() => {
    const row = db.prepare("SELECT visible FROM record_visibility WHERE name = ?").get(name);
    const newVisible = row ? (row.visible ? 0 : 1) : 0;
    db.prepare("INSERT INTO record_visibility (name, visible) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET visible = excluded.visible").run(name, newVisible);
    return { name, visible: newVisible };
  });

  if (!result.success) {
    logger.warn(req, "record.visibility", { error: result.error }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.visibility", { visible: !!result.result.visible }, name);

  broadcastEvent("record-visibility", result.result);

  res.json(result.result);
});

// GET /api/records/:name - 특정 기록 조회
app.get("/api/records/:name", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = validation.value;

  if (!tableExists(name)) {
    return res.status(404).send("기록을 찾을 수 없습니다.");
  }

  const result = dbRun(() => {
    return db.prepare(`SELECT rowid, * FROM '${name}'`).all();
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/records - 새 기록 추가
app.post("/api/records", (req, res) => {
  const nameValidation = validateRecordName(req.body.name);
  if (!nameValidation.valid) {
    return res.status(400).send(nameValidation.error);
  }

  const dataValidation = validateRecordData(req.body.data);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const name = `FSK ${new Date().getFullYear()} ${nameValidation.value}`;
  const data = req.body.data;

  const result = dbRun(() => {
    return db.transaction(() => {
      const table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);

      if (!table) {
        db.exec(`CREATE TABLE IF NOT EXISTS '${name}' (
          time TEXT NOT NULL,
          num INTEGER NOT NULL,
          univ TEXT NOT NULL,
          team TEXT NOT NULL,
          type TEXT NOT NULL,
          result INTEGER NOT NULL,
          detail TEXT,
          cones INTEGER DEFAULT 0,
          oc INTEGER DEFAULT 0,
          invalidated INTEGER DEFAULT 0,
          scoreboard INTEGER DEFAULT 1
        );`);
        db.prepare("INSERT OR IGNORE INTO record_visibility (name, visible) VALUES (?, 1)").run(name);
      }

      db.prepare(
        `INSERT INTO '${name}' (time, num, univ, team, type, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(data.time, data.entry.num, data.entry.univ, data.entry.team, data.type, data.result, data.detail);
      return db.prepare(`SELECT rowid, * FROM '${name}' WHERE rowid = last_insert_rowid()`).get();
    })();
  });

  if (!result.success) {
    logger.warn(req, "record.create", { error: result.error, entry_num: data.entry.num }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.create", { entry_num: data.entry.num, type: data.type, result: data.result }, name);

  // SSE 브로드캐스트
  broadcastEvent("records", {
    type: "add", name, recordFiles: getRecordFiles(),
    record: result.result,
  });

  res.status(201).send();
});

// PATCH /api/records/:name/:rowid - 기록 필드 업데이트
app.patch("/api/records/:name/:rowid", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = validation.value;

  if (!tableExists(name)) {
    return res.status(404).send("기록을 찾을 수 없습니다.");
  }

  const rowid = parseInt(req.params.rowid, 10);

  if (isNaN(rowid)) {
    return res.status(400).send("올바르지 않은 rowid입니다.");
  }

  const { field, value } = req.body;
  if (!["invalidated", "scoreboard", "detail", "cones", "oc"].includes(field)) {
    return res.status(400).send("올바르지 않은 필드입니다.");
  }

  const result = dbRun(() => {
    const row = db.prepare(`SELECT num, invalidated, scoreboard, cones, oc FROM '${name}' WHERE rowid = ?`).get(rowid);
    if (!row) {
      const err = new Error("기록을 찾을 수 없습니다.");
      err.status = 404;
      throw err;
    }

    if (field === "invalidated") {
      const newStatus = row.invalidated ? 0 : 1;
      if (newStatus === 1) {
        // 무효화 ON → 전광판도 자동 OFF
        db.prepare(`UPDATE '${name}' SET invalidated = 1, scoreboard = 0 WHERE rowid = ?`).run(rowid);
        return { num: row.num, invalidated: 1, scoreboard: 0 };
      } else {
        db.prepare(`UPDATE '${name}' SET invalidated = 0, scoreboard = 1 WHERE rowid = ?`).run(rowid);
        return { num: row.num, invalidated: 0, scoreboard: 1 };
      }
    } else if (field === "scoreboard") {
      const newStatus = row.scoreboard ? 0 : 1;
      db.prepare(`UPDATE '${name}' SET scoreboard = ? WHERE rowid = ?`).run(newStatus, rowid);
      return { num: row.num, invalidated: row.invalidated, scoreboard: newStatus };
    } else if (field === "detail") {
      db.prepare(`UPDATE '${name}' SET detail = ? WHERE rowid = ?`).run(value ?? null, rowid);
      return { num: row.num, invalidated: row.invalidated, scoreboard: row.scoreboard, detail: value ?? null };
    } else if (field === "cones") {
      const numValue = Math.max(0, parseInt(value, 10) || 0);
      db.prepare(`UPDATE '${name}' SET cones = ? WHERE rowid = ?`).run(numValue, rowid);
      return { num: row.num, cones: numValue };
    } else if (field === "oc") {
      const numValue = Math.max(0, parseInt(value, 10) || 0);
      db.prepare(`UPDATE '${name}' SET oc = ? WHERE rowid = ?`).run(numValue, rowid);
      return { num: row.num, oc: numValue };
    }
  });

  if (!result.success) {
    logger.warn(req, "record.update", { error: result.error }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.update", { entry_num: result.result.num, field, ...result.result }, name);

  // SSE 브로드캐스트 (업데이트된 전체 행 포함)
  try {
    const updatedRow = db.prepare(`SELECT rowid, * FROM '${name}' WHERE rowid = ?`).get(rowid);
    broadcastEvent("records", { type: "update", name, field, recordFiles: getRecordFiles(), record: updatedRow });
  } catch (e) {
    logger.warn(req, "record.update", { error: e.message, phase: "sse_broadcast" }, name);
  }

  res.json(result.result);
});

// DELETE /api/records/:name - 기록 테이블 삭제
app.delete("/api/records/:name", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = validation.value;

  if (!tableExists(name)) {
    return res.status(404).send("기록을 찾을 수 없습니다.");
  }

  const result = dbRun(() => {
    db.exec(`DROP TABLE IF EXISTS '${name}'`);
    db.prepare("DELETE FROM record_visibility WHERE name = ?").run(name);
  });

  if (!result.success) {
    logger.warn(req, "record.delete", { error: result.error }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.delete", null, name);

  // SSE 브로드캐스트
  broadcastEvent("records", { type: "delete", name, recordFiles: getRecordFiles() });

  res.status(200).send();
});

/* ============================================
   API 라우트: /api/controllers
   ============================================ */

// GET /api/controllers - 모든 컨트롤러 로그 조회
app.get("/api/controllers", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT * FROM controller ORDER BY timestamp DESC").all());

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/controllers - 컨트롤러 로그 추가
app.post("/api/controllers", (req, res) => {
  const validation = validateControllerData(req.body);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const result = dbRun(() =>
    db.prepare("INSERT INTO controller (timestamp, data) VALUES (?, ?)").run(req.body.timestamp, req.body.data),
  );

  if (!result.success) {
    logger.warn(req, "controller.upload", { error: result.error });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "controller.upload", { timestamp: req.body.timestamp });
  res.status(201).send();
});

// DELETE /api/controllers - 모든 컨트롤러 로그 삭제
app.delete("/api/controllers", (req, res) => {
  const result = dbRun(() => db.prepare("DELETE FROM controller").run());

  if (!result.success) {
    logger.warn(req, "controller.clear", { error: result.error });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "controller.clear");
  res.status(200).send();
});

/* ============================================
   API 라우트: /api/event-modes
   ============================================ */

// GET /api/event-modes - 경기 모드 목록 및 활성화 상태 조회
app.get("/api/event-modes", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT event_type, enabled FROM event_mode").all());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// PUT /api/event-modes/:type - 경기 모드 활성화/비활성화 토글
app.put("/api/event-modes/:type", (req, res) => {
  const eventType = req.params.type;
  const row = db.prepare("SELECT enabled FROM event_mode WHERE event_type = ?").get(eventType);
  if (!row) return res.status(404).send("경기 모드를 찾을 수 없습니다.");

  const newEnabled = row.enabled ? 0 : 1;
  const result = dbRun(() =>
    db.prepare("UPDATE event_mode SET enabled = ? WHERE event_type = ?").run(newEnabled, eventType),
  );
  if (!result.success) {
    logger.warn(req, "event_mode.toggle", { error: result.error }, eventType);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "event_mode.toggle", { enabled: !!newEnabled }, eventType);

  broadcastEvent("event-mode", { event_type: eventType, enabled: newEnabled });
  res.json({ event_type: eventType, enabled: newEnabled });
});

/* ============================================
   API 라우트: /api/wireless (무선 LoRa 계측)
   ============================================ */

// POST /api/wireless/ingest - 브리지가 모든 센서의 raw 이벤트 + 진단을 push.
// 성공은 로그하지 않음(텔레메트리 firehose); 실패·브리지 전환만 로그.
app.post("/api/wireless/ingest", (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events : [];
  const telemetry = Array.isArray(body.telemetry) ? body.telemetry : [];
  if (events.length > 200 || telemetry.length > 200) {
    return res.status(400).send("ingest 배치가 너무 큽니다.");
  }

  const transitioned = markBridgeSeen();

  const result = dbRun(() => db.transaction(() => {
    const inserted = [];
    let deduped = 0;
    const ins = db.prepare("INSERT OR IGNORE INTO wireless_event (node_id, master_tick, ev_seq, rssi, snr, link_state, raw) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const sel = db.prepare("SELECT id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state FROM wireless_event WHERE id = ?");
    for (const e of events) {
      if (!validateNodeId(String(e.node_id))) { const err = new Error("node_id가 올바르지 않습니다."); err.status = 400; throw err; }
      const tick = tickToText(e.master_tick);
      if (tick === undefined) { const err = new Error("master_tick이 올바르지 않습니다."); err.status = 400; throw err; }
      const evSeq = Number.isInteger(e.ev_seq) ? e.ev_seq : null;
      const rssi = typeof e.rssi === "number" ? e.rssi : null;
      const snr = typeof e.snr === "number" ? e.snr : null;
      const link = typeof e.link_state === "string" ? e.link_state : null;
      const info = ins.run(String(e.node_id), tick, evSeq, rssi, snr, link, JSON.stringify(e));
      if (info.changes > 0) { inserted.push(sel.get(Number(info.lastInsertRowid))); }
      else { deduped++; }
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const tOut = [];
    const tins = db.prepare("INSERT INTO wireless_telemetry (node_id, rssi, snr, offset_us, skew_ppm, latency_ms, link_state) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const t of telemetry) {
      if (!validateNodeId(String(t.node_id))) { const err = new Error("node_id가 올바르지 않습니다."); err.status = 400; throw err; }
      const node = String(t.node_id);
      const rssi = typeof t.rssi === "number" ? t.rssi : null;
      const snr = typeof t.snr === "number" ? t.snr : null;
      const offset = Number.isFinite(t.offset_us) ? Math.trunc(t.offset_us) : null;
      const skew = typeof t.skew_ppm === "number" ? t.skew_ppm : null;
      const lat = typeof t.latency_ms === "number" ? t.latency_ms : null;
      const link = typeof t.link_state === "string" ? t.link_state : null;
      const prev = liveTelemetry.get(node) || {};
      const entry = { rssi, snr, offset_us: offset, skew_ppm: skew, latency_ms: lat, link_state: link, last_seen: nowIso, _lastPersist: prev._lastPersist || 0 };
      if (now - entry._lastPersist >= TELEMETRY_PERSIST_MS) {
        tins.run(node, rssi, snr, offset, skew, lat, link);
        entry._lastPersist = now;
      }
      liveTelemetry.set(node, entry);
      tOut.push({ node_id: node, rssi, snr, offset_us: offset, skew_ppm: skew, latency_ms: lat, link_state: link, last_seen: nowIso });
    }
    return { inserted, deduped, telemetry: tOut };
  })());

  if (!result.success) {
    logger.warn(req, "wireless.ingest", { error: result.error, counts: { events: events.length, telemetry: telemetry.length } });
    return res.status(result.status).send(result.error);
  }

  if (transitioned) {
    logger.log(req, "wireless.bridge", { online: true, last_seen: lastBridgeSeenIso }, "bridge");
  }
  if (result.result.inserted.length > 0) {
    broadcastEvent("wireless:event", { events: result.result.inserted });
  }
  if (result.result.telemetry.length > 0) {
    broadcastEvent("wireless:telemetry", { telemetry: result.result.telemetry });
  }
  res.json({ stored: result.result.inserted.length, deduped: result.result.deduped });
});

// POST /api/wireless/light - 브리지(콘솔)가 현재 신호등 색 + green tick 보고.
app.post("/api/wireless/light", (req, res) => {
  const { color } = req.body || {};
  const allowed = ["red", "green", "yellow", "off"];
  if (typeof color !== "string" || !allowed.includes(color)) {
    return res.status(400).send("올바르지 않은 신호등 색입니다.");
  }
  const gt = tickToText(req.body?.green_tick);
  if (gt === undefined) return res.status(400).send("green_tick이 올바르지 않습니다.");
  const gtParam = color === "green" ? gt : null; // green tick은 green일 때만 갱신

  markBridgeSeen();
  const result = dbRun(() => {
    db.prepare("UPDATE wireless_light SET light_color = ?, green_tick = COALESCE(?, green_tick), updated_at = strftime('%Y-%m-%dT%H:%M:%f','now') WHERE id = 1").run(color, gtParam);
    return getLightState();
  });
  if (!result.success) {
    logger.warn(req, "wireless.light", { error: result.error, color }, "light");
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.light", { color, green_tick: gtParam }, "light");
  broadcastEvent("wireless:light", result.result);
  res.json(result.result);
});

// POST /api/wireless/light/claim - 종목이 신호등 점유(서버 권위 배타).
app.post("/api/wireless/light/claim", (req, res) => {
  const eventType = req.body?.event_type;
  if (typeof eventType !== "string" || !EVENT_TYPES.includes(eventType)) {
    return res.status(400).send("올바르지 않은 종목입니다.");
  }
  const result = dbRun(() => {
    const cur = db.prepare("SELECT owner_event FROM wireless_light WHERE id = 1").get();
    if (cur.owner_event && cur.owner_event !== eventType) {
      const err = new Error("다른 종목이 신호등을 점유 중입니다."); err.status = 409; throw err;
    }
    db.prepare("UPDATE wireless_light SET owner_event = ?, owner_actor = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f','now') WHERE id = 1").run(eventType, req.user?.email || null);
    return { row: getLightState(), prev: cur.owner_event || null };
  });
  if (!result.success) {
    logger.warn(req, "wireless.light.claim", { error: result.error, requested: eventType }, eventType);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.light.claim", { event_type: eventType, prev_owner: result.result.prev }, eventType);
  broadcastEvent("wireless:light", result.result.row);
  res.json(result.result.row);
});

// POST /api/wireless/light/release - 점유 해제(점유자 또는 force).
app.post("/api/wireless/light/release", (req, res) => {
  const eventType = req.body?.event_type;
  const force = !!req.body?.force;
  if (typeof eventType !== "string" || !EVENT_TYPES.includes(eventType)) {
    return res.status(400).send("올바르지 않은 종목입니다.");
  }
  const result = dbRun(() => {
    const cur = db.prepare("SELECT owner_event FROM wireless_light WHERE id = 1").get();
    if (cur.owner_event && cur.owner_event !== eventType && !force) {
      const err = new Error("점유자만 해제할 수 있습니다."); err.status = 409; throw err;
    }
    db.prepare("UPDATE wireless_light SET owner_event = NULL, owner_actor = NULL, light_color = 'off', updated_at = strftime('%Y-%m-%dT%H:%M:%f','now') WHERE id = 1").run();
    return getLightState();
  });
  if (!result.success) {
    logger.warn(req, "wireless.light.release", { error: result.error, requested: eventType, forced: force }, eventType);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.light.release", { event_type: eventType, forced: force }, eventType);
  broadcastEvent("wireless:light", result.result);
  res.json(result.result);
});

// GET /api/wireless/mapping - 센서->경기·역할 매핑 전체 조회.
app.get("/api/wireless/mapping", (req, res) => {
  const result = dbRun(() => getMapping());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// PUT /api/wireless/mapping/:node_id - 매핑 upsert.
app.put("/api/wireless/mapping/:node_id", (req, res) => {
  const node = req.params.node_id;
  if (!validateNodeId(node)) return res.status(400).send("node_id가 올바르지 않습니다.");
  const { event_type, role } = req.body || {};
  const label = typeof req.body?.label === "string" ? req.body.label : null;
  const enabled = req.body?.enabled === undefined ? 1 : (req.body.enabled ? 1 : 0);
  if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
    return res.status(400).send("올바르지 않은 종목입니다.");
  }
  if (typeof role !== "string" || !ALLOWED_ROLE.test(role)) {
    return res.status(400).send("올바르지 않은 역할입니다.");
  }
  const result = dbRun(() => {
    const prev = db.prepare("SELECT event_type, role, label, enabled FROM wireless_mapping WHERE node_id = ?").get(node) || null;
    db.prepare(`INSERT INTO wireless_mapping (node_id, event_type, role, label, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f','now'))
      ON CONFLICT(node_id) DO UPDATE SET event_type=excluded.event_type, role=excluded.role, label=excluded.label, enabled=excluded.enabled, updated_at=excluded.updated_at`).run(node, event_type, role, label, enabled);
    return { row: db.prepare("SELECT node_id, event_type, role, label, enabled, updated_at FROM wireless_mapping WHERE node_id = ?").get(node), prev };
  });
  if (!result.success) {
    logger.warn(req, "wireless.mapping", { error: result.error, event_type, role }, node);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.mapping", { event_type, role, label, enabled, prev: result.result.prev }, node);
  broadcastEvent("wireless:mapping", result.result.row);
  res.json(result.result.row);
});

// DELETE /api/wireless/mapping/:node_id - 매핑 삭제(감사 로그).
app.delete("/api/wireless/mapping/:node_id", (req, res) => {
  const node = req.params.node_id;
  if (!validateNodeId(node)) return res.status(400).send("node_id가 올바르지 않습니다.");
  const result = dbRun(() => {
    const prev = db.prepare("SELECT event_type, role FROM wireless_mapping WHERE node_id = ?").get(node) || null;
    db.prepare("DELETE FROM wireless_mapping WHERE node_id = ?").run(node);
    return prev;
  });
  if (!result.success) {
    logger.warn(req, "wireless.mapping.delete", { error: result.error }, node);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.mapping.delete", { prev: result.result }, node);
  broadcastEvent("wireless:mapping", { node_id: node, deleted: true });
  res.status(200).send();
});

// GET /api/wireless/state - 신선 로드용 종합 스냅샷.
app.get("/api/wireless/state", (req, res) => {
  const result = dbRun(() => ({
    light: getLightState(),
    mapping: getMapping(),
    telemetry: getLiveTelemetry(),
    bridge: getBridgeState(),
  }));
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// GET /api/wireless/events?since=&limit= - 늦게 합류한 클라이언트의 raw 이벤트 백필.
app.get("/api/wireless/events", (req, res) => {
  const since = Number.parseInt(req.query.since, 10);
  const sinceId = Number.isFinite(since) ? since : 0;
  let limit = Number.parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit)) limit = 200;
  limit = Math.max(1, Math.min(limit, 1000));
  const result = dbRun(() =>
    db.prepare("SELECT id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state, raw FROM wireless_event WHERE id > ? ORDER BY id ASC LIMIT ?").all(sinceId, limit),
  );
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
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
  const { app, db } = createTrafficApp();
  setupProcessHandlers(db);
  app.listen(9500);
}
