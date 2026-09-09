import express from "express";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { runMigrationOnce, normalizeUtcTextTimestamp, normalizeTimestampColumn, setupRowCapRetention } from "../shared/db-setup.mjs";
import { createServiceSkeleton, addSpaFallback } from "../shared/service-bootstrap.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { EVENT_TYPES, RESULT_STATUSES } from "../shared/constants.js";
import { ensureInactiveTeamView, isTeamActive } from "../shared/team-status.mjs";
import {
  formatEnduranceDetail,
  masterTickDelta,
  masterTickDeltaMs,
  masterTickDistanceBelowMs,
  masterTickDurationsMs,
} from "./lib/event-timing.mjs";
import { verifyCaptures, CAPTURE_CHECKPOINT, CAPTURE_LOSS, WIRELESS_PROTOCOL_VERSION } from "./lib/wireless-capture-integrity.mjs";
import { currentCompetitionYear } from "../shared/competition-year.mjs";
import { createWirelessClock } from "./lib/wireless-clock.mjs";
import { access, principalHasPermission } from "../shared/access-control.js";

const CONTROLLER_MAX_ROWS = 100000;
const RETAIN_EVENTS = 500000;
const WIRELESS_STATUS_MAX_AGE_MS = 12000;
const WIRELESS_SYNC_MAX_AGE_MS = 7000;
const WIRELESS_MAX_SKEW_PPM = 100;
const WIRELESS_REQUIRED_ROLES = Object.freeze({
  "가속": ["start", "finish"],
  "스키드패드": ["start"],
  "오토크로스": ["start", "finish"],
  "내구": ["start"],
});

export function createTrafficApp(options = {}) {


const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "traffic", express, Database, options,
  authRoleFn: (req) => {
    if (req.path === "/api/health" || req.path === "/api/time") return null;
    if (req.path === "/api/logs") return access.anyOf(access.admin, access.internal);
    if (req.method === "PUT" && /^\/api\/records\/[^/]+\/visibility$/.test(req.path)) return access.permission("traffic.manage");
    if (req.method === "DELETE" && /^\/api\/records\/[^/]+$/.test(req.path)) return access.permission("traffic.manage");
    if (req.method === "DELETE" && req.path === "/api/controllers") return access.permission("traffic.manage");
    if (req.method === "PUT" && req.path.startsWith("/api/event-modes/")) return access.permission("traffic.manage");
    if (["PUT", "DELETE"].includes(req.method) && req.path.startsWith("/api/wireless/mapping/")) return access.permission("traffic.manage");
    if (req.method === "PUT" && req.path === "/api/wireless/debounce") return access.permission("traffic.manage");
    return access.permission("traffic.operate");
  },
});
ensureInactiveTeamView(db);

// 동적 기록 테이블과 구분되는 예약 테이블 이름. 동적 테이블을 열거하는 모든
// 쿼리에서 제외해야 한다(아래 reservedSql).
const RESERVED_TABLES = [
  "controller", "event_mode", "record_visibility", "record", "logs",
  "wireless_event", "wireless_mapping", "wireless_telemetry", "wireless_light", "wireless_session",
];
const reservedSql = RESERVED_TABLES.map((n) => `'${n}'`).join(", ");

db.exec(`CREATE TABLE IF NOT EXISTS controller (
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL
);`);
db.exec("CREATE INDEX IF NOT EXISTS idx_controller_timestamp ON controller(timestamp)");
setupRowCapRetention(db, "controller", CONTROLLER_MAX_ROWS, { keyColumn: "rowid" });

db.exec(`CREATE TABLE IF NOT EXISTS event_mode (
  event_type TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1
);`);

db.exec(`CREATE TABLE IF NOT EXISTS record_visibility (
  name TEXT PRIMARY KEY,
  visible INTEGER NOT NULL DEFAULT 1
);`);

function createRecordTable(table = "record", { teamId = false } = {}) {
  db.exec(`CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    legacy_rowid INTEGER NOT NULL,
    time TEXT NOT NULL,
    num INTEGER NOT NULL,
    univ TEXT NOT NULL,
    team TEXT NOT NULL,
    type TEXT NOT NULL,
    result INTEGER,
    status TEXT CHECK(status IS NULL OR status IN ('DNS', 'DNF', 'DSQ')),
    detail TEXT,
    cones INTEGER DEFAULT 0,
    oc INTEGER DEFAULT 0,
    scoreboard INTEGER DEFAULT 1${teamId ? ",\n    team_id INTEGER" : ""},
    CHECK(result IS NULL OR (typeof(result) = 'integer' AND result >= 0)),
    CHECK(status IS NOT NULL OR result IS NOT NULL)
  );`);
}

const recordTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'record'").get();
if (!recordTable) {
  createRecordTable();
} else {
  const info = db.prepare("PRAGMA table_info(record)").all();
  const columns = new Set(info.map((column) => column.name));
  // status가 없거나 옛 invalidated/source result NOT NULL 제약이 남은 DB를 한 번에 최종
  // 스키마로 재구성한다. 예상 밖 결과값은 CHECK에 기대어 부분 게시하지 않고 transaction 전체를 중단한다.
  const resultColumn = info.find((column) => column.name === "result");
  if (!columns.has("status") || columns.has("invalidated") || resultColumn?.notnull
    || /result > 0/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'record'").get().sql)) {
    db.transaction(() => {
      if (!columns.has("legacy_rowid")) {
        db.exec("ALTER TABLE record ADD COLUMN legacy_rowid INTEGER");
        db.exec(`
          WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS rn
            FROM record
          )
          UPDATE record
          SET legacy_rowid = (SELECT rn FROM ranked WHERE ranked.id = record.id)
          WHERE legacy_rowid IS NULL
        `);
      }
      const migratedColumns = new Set(db.prepare("PRAGMA table_info(record)").all().map((column) => column.name));
      const invalidatedSql = migratedColumns.has("invalidated") ? "COALESCE(invalidated, 0)" : "0";
      const statusSql = migratedColumns.has("status")
        ? `CASE WHEN ${invalidatedSql} = 1 THEN 'DSQ' WHEN status IN ('DNS', 'DNF', 'DSQ') THEN status WHEN result = -1 THEN 'DNF' ELSE NULL END`
        : `CASE WHEN ${invalidatedSql} = 1 THEN 'DSQ' WHEN result = -1 THEN 'DNF' ELSE NULL END`;
      const teamId = migratedColumns.has("team_id");
      createRecordTable("record_status_v1", { teamId });
      db.exec(`
        INSERT INTO record_status_v1
          (id, name, legacy_rowid, time, num, univ, team, type, result, status,
           detail, cones, oc, scoreboard${teamId ? ", team_id" : ""})
        SELECT id, name, legacy_rowid, time, num, univ, team, type,
               CASE WHEN result = -1 THEN NULL ELSE result END,
               ${statusSql}, detail, COALESCE(cones, 0), COALESCE(oc, 0),
               COALESCE(scoreboard, CASE WHEN ${invalidatedSql} = 1 THEN 0 ELSE 1 END)
               ${teamId ? ", team_id" : ""}
        FROM record;
        DROP TABLE record;
        ALTER TABLE record_status_v1 RENAME TO record;
      `);
    })();
  }
}
// record 조회는 모두 legacy_rowid 또는 num 기준이라 (name, id) 인덱스는 미사용. 제거(기존 배포본 정리 포함).
db.exec("DROP INDEX IF EXISTS idx_record_name_id");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_record_name_legacy_rowid ON record(name, legacy_rowid)");
db.exec("CREATE INDEX IF NOT EXISTS idx_record_name_num ON record(name, num)");

/* ============================================
   무선(LoRa) 계측 서브시스템 테이블
   - 마스터 노드에 연결된 브리지 PC가 모든 센서의 타이밍 이벤트·진단·신호등 상태를
     서버로 push, 나머지 클라이언트는 SSE로 수신. (DESIGN §9)
   ============================================ */

// 모든 센서의 타이밍 이벤트(전부 영구 저장). master_tick은 64-bit라 TEXT로 저장(JS 정수
// 정밀도 손실 방지). (node_id, ev_seq, master_tick) UNIQUE로 멱등 ingest.
db.exec(`CREATE TABLE IF NOT EXISTS wireless_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     TEXT NOT NULL,
  master_tick TEXT,
  ev_seq      INTEGER,
  server_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rssi        REAL,
  snr         REAL,
  link_state  TEXT
);`);
db.exec("DROP INDEX IF EXISTS idx_wevent_server_time");
{
  const cols = db.prepare("PRAGMA table_info(wireless_event)").all().map((c) => c.name);
  if (cols.includes("raw")) {
    db.transaction(() => {
      db.exec("DROP INDEX IF EXISTS idx_wevent_dedupe");
      db.exec(`CREATE TABLE wireless_event_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id     TEXT NOT NULL,
        master_tick TEXT,
        ev_seq      INTEGER,
        server_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        rssi        REAL,
        snr         REAL,
        link_state  TEXT
      )`);
      db.exec(`INSERT INTO wireless_event_new (id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state)
        SELECT id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state FROM wireless_event`);
      db.exec("DROP TABLE wireless_event");
      db.exec("ALTER TABLE wireless_event_new RENAME TO wireless_event");
    })();
  }
}
// v9 evidence is retained with each raw event, including reliable checkpoints
// and loss ranges. Old rows remain readable but cannot certify a new run.
{
  const columns = new Set(db.prepare("PRAGMA table_info(wireless_event)").all().map(c => c.name));
  for (const [name, type] of Object.entries({master_boot_id: "INTEGER", sensor_boot_id: "INTEGER",
    capture_seq: "INTEGER", end_seq: "INTEGER", end_tick: "TEXT", flags: "INTEGER", sync_age_ms: "INTEGER"})) {
    if (!columns.has(name)) db.exec(`ALTER TABLE wireless_event ADD COLUMN ${name} ${type}`);
  }
  const index = db.prepare("SELECT name FROM pragma_index_info('idx_wevent_dedupe')").all();
  if (!index.some(c => c.name === "sensor_boot_id")) {
    db.exec("DROP INDEX IF EXISTS idx_wevent_dedupe");
    db.exec("CREATE UNIQUE INDEX idx_wevent_dedupe ON wireless_event(node_id, ev_seq, master_tick, master_boot_id, sensor_boot_id)");
  }
}

function pruneWirelessEvents() {
  const row = db.prepare("SELECT MAX(id) AS m FROM wireless_event").get();
  if (row && row.m > RETAIN_EVENTS) {
    const active = db.prepare("SELECT MIN(json_extract(engine_state, '$.cursorId')) AS id FROM wireless_session WHERE engine_state IS NOT NULL AND json_extract(engine_state, '$.closed') = 0").get();
    const cutoff = Math.min(row.m - RETAIN_EVENTS, active.id ?? Infinity);
    const removed = db.prepare("DELETE FROM wireless_event WHERE id <= ?").run(cutoff).changes;
    return { removed, cutoff };
  }
  return { removed: 0, cutoff: null };
}

// 센서 -> 경기·역할 매핑 (UI에서 설정, 서버 영구 저장).
db.exec(`CREATE TABLE IF NOT EXISTS wireless_mapping (
  node_id    TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  role       TEXT NOT NULL,
  label      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

db.exec("DROP INDEX IF EXISTS idx_wtel_node_time");
db.exec("DROP TABLE IF EXISTS wireless_telemetry");

// 신호등/콘솔 단일 상태(점유 잠금 + 현재 색 + green tick) + 무선 공용 설정(센서 디바운스
// 창). 서버 재시작에도 유지. debounce_ms: 한 통과의 다중 엣지(바운스)를 접는 간격(ms).
db.exec(`CREATE TABLE IF NOT EXISTS wireless_light (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  owner_event   TEXT,
  owner_actor   TEXT,
  light_color   TEXT,
  green_tick    TEXT,
  bridge_online INTEGER NOT NULL DEFAULT 0,
  debounce_ms   INTEGER NOT NULL DEFAULT 300,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);
db.exec("INSERT OR IGNORE INTO wireless_light (id, light_color, bridge_online) VALUES (1, 'off', 0)");
// 기존 DB 마이그레이션: debounce_ms 컬럼 추가(기본 300ms).
if (!db.prepare("PRAGMA table_info('wireless_light')").all().some((c) => c.name === "debounce_ms")) {
  db.exec("ALTER TABLE wireless_light ADD COLUMN debounce_ms INTEGER NOT NULL DEFAULT 300");
}

// 기본 경기 모드 시딩 (내구 포함 — EVENT_TYPES). 탭 on/off 토글 대상.
{
  const insert = db.prepare("INSERT OR IGNORE INTO event_mode (event_type, enabled) VALUES (?, 1)");
  for (const type of EVENT_TYPES) {
    insert.run(type);
  }
  // 폐지된 경기(EVENT_TYPES에 없는) 모드행 정리 — idempotent. 과거 기록 테이블은 보존.
  db.prepare(
    `DELETE FROM event_mode WHERE event_type NOT IN (${EVENT_TYPES.map(() => "?").join(",")})`,
  ).run(...EVENT_TYPES);
}

// 경기별 세션 상태(서버 권위). green=arm이라 armed가 핵심 — 가상 경기 포함 모든 경기의
// arm 상태를 전 클라가 공유(SSE wireless:session). 물리 지정 경기는 추가로 SSR을 구동하지만
// arm 상태 자체는 여기서 단일 관리. controller/lease로 경기별 독점 제어(A안), bind-at-arm으로
// arm 시점 팀·이벤트명 스냅샷(선택 공유는 후속 단계).
db.exec(`CREATE TABLE IF NOT EXISTS wireless_session (
  event_type        TEXT PRIMARY KEY,
  armed             INTEGER NOT NULL DEFAULT 0,
  light_color       TEXT NOT NULL DEFAULT 'off',
  green_tick        TEXT,
  armed_at          TEXT,
  run_id            TEXT,
  saved_record_name TEXT,
  saved_record_rowid INTEGER,
  reset_pending     INTEGER NOT NULL DEFAULT 0,
  team_json         TEXT,
  event_name        TEXT,
  controller        TEXT,
  lease_expires_at  TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);
{
  const columns = new Set(db.prepare("PRAGMA table_info(wireless_session)").all().map((column) => column.name));
  if (!columns.has("run_id")) db.exec("ALTER TABLE wireless_session ADD COLUMN run_id TEXT");
  if (!columns.has("saved_record_name")) db.exec("ALTER TABLE wireless_session ADD COLUMN saved_record_name TEXT");
  if (!columns.has("saved_record_rowid")) db.exec("ALTER TABLE wireless_session ADD COLUMN saved_record_rowid INTEGER");
  if (!columns.has("reset_pending")) db.exec("ALTER TABLE wireless_session ADD COLUMN reset_pending INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("engine_state")) db.exec("ALTER TABLE wireless_session ADD COLUMN engine_state TEXT");
  const insert = db.prepare("INSERT OR IGNORE INTO wireless_session (event_type) VALUES (?)");
  for (const type of EVENT_TYPES) insert.run(type);
  // 폐지 경기 세션행 정리 — idempotent.
  db.prepare(
    `DELETE FROM wireless_session WHERE event_type NOT IN (${EVENT_TYPES.map(() => "?").join(",")})`,
  ).run(...EVENT_TYPES);
}

runMigrationOnce(db, "traffic.utc_timestamp_normalization.v1", () => {
  pruneWirelessEvents();
  for (const [table, column] of [
    ["controller", "timestamp"],
    ["wireless_event", "server_time"],
    ["wireless_mapping", "updated_at"],
    ["wireless_light", "updated_at"],
    ["wireless_session", "updated_at"],
    ["wireless_session", "armed_at"],
    ["wireless_session", "lease_expires_at"],
  ]) {
    normalizeTimestampColumn(db, table, column);
  }
}, { transaction: false });

// 기존 record별 동적 테이블을 단일 record 테이블로 흡수한 뒤 drop한다.
{
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${reservedSql})`)
    .all();
  for (const { name } of tables) {
    if (!/^[A-Za-z0-9가-힣 .\-_]+$/.test(name)) continue;
    const columns = db.prepare(`PRAGMA table_info('${name}')`).all();
    const hasColumn = (col) => columns.some((c) => c.name === col);
    const hasRequired = ["time", "num", "univ", "team", "type", "result"].every(hasColumn);
    if (!hasRequired) continue;
    const detailExpr = hasColumn("detail") ? "detail" : "NULL";
    const invalidatedExpr = hasColumn("invalidated") ? "COALESCE(invalidated, 0)" : "0";
    const statusExpr = hasColumn("status")
      ? `CASE WHEN ${invalidatedExpr} = 1 THEN 'DSQ' WHEN status IN ('DNS', 'DNF', 'DSQ') THEN status WHEN result = -1 THEN 'DNF' ELSE NULL END`
      : `CASE WHEN ${invalidatedExpr} = 1 THEN 'DSQ' WHEN result = -1 THEN 'DNF' ELSE NULL END`;
    const scoreboardExpr = hasColumn("scoreboard")
      ? "COALESCE(scoreboard, 1)"
      : `CASE WHEN ${invalidatedExpr} = 1 THEN 0 ELSE 1 END`;
    const conesExpr = hasColumn("cones") ? "COALESCE(cones, 0)" : "0";
    const ocExpr = hasColumn("oc") ? "COALESCE(oc, 0)" : "0";
    db.prepare(`
      INSERT OR IGNORE INTO record (name, legacy_rowid, time, num, univ, team, type, result, status, detail, cones, oc, scoreboard)
      SELECT ?, rowid, time, num, univ, team, type,
             CASE WHEN result = -1 THEN NULL ELSE result END, ${statusExpr}, ${detailExpr},
             ${conesExpr}, ${ocExpr}, ${scoreboardExpr}
      FROM '${name}'
      ORDER BY rowid
    `).run(name);
    db.prepare("INSERT OR IGNORE INTO record_visibility (name, visible) VALUES (?, 1)").run(name);
    db.exec(`DROP TABLE '${name}'`);
  }
}

/* ============================================
   Express 앱 설정
   ============================================ */
// 서버 시각(epoch ms). 클라가 자기 시계와의 오프셋을 추정해 라이브 클럭을 전 클라 동기화(공유 클럭).
app.get("/api/time", (req, res) => res.json({ now: Date.now() }));

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastSSEEvent, handler: sseHandler, close: closeSseStream } = createSSEManager(200, { logger });
const wirelessClock = createWirelessClock({ send: (command) => broadcastEvent("wireless:command", command) });
const pendingArmRequests = new Map();
const readWirelessClock = options.readWirelessClock || (() => wirelessClock.read());
function closeSse() {
  wirelessClock.close();
  closeSseStream();
}

let timingContext = null;
function broadcastEvent(event, data) {
  if (timingContext) {
    timingContext.notifications.push([event, structuredClone(data)]);
    return;
  }
  broadcastSSEEvent(event, data);
  options.onEvent?.(event, data);
}

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
  return db.prepare(`
    SELECT legacy_rowid AS rowid, time, num, univ, team, type, result, status, detail, cones, oc, scoreboard
    FROM record
    WHERE name = ?
      AND (? IS NULL OR NOT EXISTS (
        SELECT 1 FROM competition_inactive_team s
        WHERE s.year = ? AND s.team_num = record.num
      ))
    ORDER BY legacy_rowid
  `).all(name, year, year);
}

function getYearRecordGroups(year) {
  const startName = `FSK ${Number(year)} `;
  const endName = `FSK ${Number(year) + 1} `;
  const rows = db.prepare(`
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
  `).all(startName, endName, Number(year));
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
  return db.prepare(`
    SELECT legacy_rowid AS rowid, time, num, univ, team, type, result, status, detail, cones, oc, scoreboard
    FROM record
    WHERE name = ? AND legacy_rowid = ?
  `).get(name, rowid);
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
  const nextRowid = db.prepare("SELECT COALESCE(MAX(legacy_rowid), 0) + 1 AS value FROM record WHERE name = ?").get(name).value;
  db.prepare(`
    INSERT INTO record (name, legacy_rowid, time, num, univ, team, type, result, status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, nextRowid, data.time, entry.num, entry.univ, entry.team, data.type,
    data.result ?? null, data.status ?? null, data.detail ?? null,
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

/* ============================================
   무선 계측: 실시간 상태(메모리) + 헬퍼
   ============================================ */
// Latest diagnostics; active runs checkpoint their relevant nodes for recovery.
// _provWarned suppresses duplicate provisioning warnings.
const liveTelemetry = new Map();
// 경기 중 자동 중단 사유. 프로세스 생존 중 SSE 재연결/화면 이동으로 경고가
// 사라지지 않게 init/state에도 포함하고, 품질을 통과한 다음 START에서만 해제한다.
const liveAttempts = new Map();
let bridgeOnline = false;
let lastBridgeSeen = 0;
let lastBridgeSeenIso = null;

function getLightState() {
  return db.prepare("SELECT bridge_online, debounce_ms, updated_at FROM wireless_light WHERE id = 1").get();
}
function getMapping() {
  return db.prepare("SELECT node_id, event_type, role, label, enabled, updated_at FROM wireless_mapping ORDER BY event_type, role").all();
}
function getLiveTelemetry() {
  const out = [];
  for (const [node_id, t] of liveTelemetry) {
    const { _provWarned, ...publicTelemetry } = t;
    out.push({ node_id, ...publicTelemetry });
  }
  return out;
}
function getBridgeState() {
  return { online: bridgeOnline, last_seen: lastBridgeSeenIso };
}
function getLiveQualityFaults() {
  return getSessions().map(session => getRun(session.event_type)?.fault).filter(Boolean);
}

function liveAttemptPayload(attempt, now = Date.now()) {
  return {
    active: true,
    attempt_id: attempt.attempt_id,
    event_type: attempt.event_type,
    event_name: attempt.event_name,
    team: attempt.team,
    started_at: attempt.started_at,
    elapsed_ms: Math.max(0, now - attempt.started_at_ms),
  };
}

function getLiveAttempts(now = Date.now()) {
  return [...liveAttempts.values()].map((attempt) => liveAttemptPayload(attempt, now));
}

function publishWirelessQualityFault(eventType, runId, reasons, kind = "quality") {
  const fault = {
    fault_id: crypto.randomUUID(),
    event_type: eventType,
    run_id: runId ?? null,
    kind,
    occurred_at: new Date().toISOString(),
    reasons: Array.isArray(reasons) ? reasons : [],
  };
  const run = getRun(eventType);
  if (run) run.fault = fault;
  broadcastEvent("wireless:quality-fault", fault);
  return fault;
}

function clearWirelessQualityFault(eventType) {
  const run = getRun(eventType);
  if (run) delete run.fault;
  broadcastEvent("wireless:quality-fault", { event_type: eventType, cleared: true });
}

function telemetryAgeMs(telemetry, now = Date.now()) {
  const seen = Date.parse(telemetry?.last_seen || "");
  return Number.isFinite(seen) ? Math.max(0, now - seen) : Infinity;
}

function wirelessQuality(eventType) {
  const reasons = [];
  const now = Date.now();
  if (!timingContext?.bridge && (!bridgeOnline || now - lastBridgeSeen > WIRELESS_STATUS_MAX_AGE_MS)) {
    reasons.push({ node_id: "0", reason: "마스터 브리지가 연결되어 있지 않습니다." });
  }

  const master = timingContext?.telemetry.get("0") || liveTelemetry.get("0");
  if (!master || telemetryAgeMs(master, now) > WIRELESS_STATUS_MAX_AGE_MS) {
    reasons.push({ node_id: "0", reason: "마스터 상태 보고가 없거나 오래되었습니다." });
  } else {
    if (master.link_state !== "online") reasons.push({ node_id: "0", reason: "마스터 계측기가 정상 상태가 아닙니다." });
    if (master.clock_source !== "xtal") reasons.push({ node_id: "0", reason: "마스터 HFXO가 확인되지 않았습니다." });
    if (master.provisioned !== 1) reasons.push({ node_id: "0", reason: "마스터 무선 키가 준비되지 않았습니다." });

  }

  const mappings = getMapping().filter((row) => row.enabled !== 0 && row.event_type === eventType);
  const requiredRoles = WIRELESS_REQUIRED_ROLES[eventType] || [];
  for (const role of requiredRoles) {
    if (!mappings.some((row) => row.role === role)) {
      reasons.push({ node_id: null, role, reason: `${role} 센서가 매핑되지 않았습니다.` });
    }
  }

  for (const mapping of mappings) {
    const telemetry = timingContext?.telemetry.get(String(mapping.node_id)) || liveTelemetry.get(String(mapping.node_id));
    const node = String(mapping.node_id);
    if (!telemetry || telemetryAgeMs(telemetry, now) > WIRELESS_STATUS_MAX_AGE_MS) {
      reasons.push({ node_id: node, role: mapping.role, reason: `${node} 센서 상태 보고가 없거나 오래되었습니다.` });
      continue;
    }
    if (telemetry.link_state !== "online") reasons.push({ node_id: node, role: mapping.role, reason: `${node} 센서 링크가 정상이 아닙니다.` });
    if (telemetry.provisioned !== 1) reasons.push({ node_id: node, role: mapping.role, reason: `${node} 센서 무선 키가 준비되지 않았습니다.` });
    if (telemetry.clock_source !== "xtal") reasons.push({ node_id: node, role: mapping.role, reason: `${node} 센서 HFXO가 확인되지 않았습니다.` });
    if (telemetry.sync_valid !== 1 || !Number.isFinite(telemetry.sync_age_ms) || telemetry.sync_age_ms > WIRELESS_SYNC_MAX_AGE_MS) {
      reasons.push({ node_id: node, role: mapping.role, reason: `${node} 센서 동기가 유효하지 않습니다.` });
    }
    if (telemetry.skew_valid !== 1 || !Number.isFinite(telemetry.skew_ppm)
      || Math.abs(telemetry.skew_ppm) > WIRELESS_MAX_SKEW_PPM) {
      reasons.push({ node_id: node, role: mapping.role, reason: `${node} 센서 skew가 유효하지 않습니다.` });
    }

  }
  return { ok: reasons.length === 0, reasons, mappings };
}

function rejectWirelessQuality(req, res, action, eventType) {
  const quality = wirelessQuality(eventType);
  if (quality.ok) return false;
  const message = `계측 품질 확인 실패: ${quality.reasons[0]?.reason || "상태를 확인할 수 없습니다."}`;
  rejectMutation(req, res, {
    action,
    status: 409,
    message,
    target: eventType,
    operation: "green",
    context: { event_type: eventType, quality_reasons: quality.reasons },
  });
  return true;
}

function enforceArmedWirelessQuality(req) {
  // Missing diagnostics are uncertainty, not evidence that a capture was lost.
  for (const session of getSessions()) {
    if (!session.armed) continue;
    const run = getRun(session.event_type);
    if (!run || run.closed || wirelessQuality(session.event_type).ok) continue;
    if (run.verification !== "pending") {
      run.verification = "pending";
      broadcastEvent("wireless:session", getSession(session.event_type));
    }
  }
}

// 경기별 세션(arm + lease + bind-at-arm). 만료된 lease는 controller=null로 표기.
const LEASE_TTL_MS = 30000; // heartbeat로 갱신. 제어 탭이 죽으면 이 시간 후 자동 해제.
function getSessions() {
  const now = Date.now();
  return db
    .prepare("SELECT event_type, armed, armed_at, run_id, saved_record_name, saved_record_rowid, team_json, event_name, controller, lease_expires_at, updated_at FROM wireless_session ORDER BY event_type")
    .all()
    .map((r) => {
      const expired = r.lease_expires_at && Date.parse(r.lease_expires_at) <= now;
      let team = null;
      if (r.team_json) { try { team = JSON.parse(r.team_json); } catch { team = null; } }
      const run = getRun(r.event_type);
      return {
        verification: run?.verification ?? null,
        finished: run?.closed ?? false,
        result: run?.result ?? null,
        lap_times: (run?.lapTicks || []).map(value => masterTickDurationsMs([value])),
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
// 제어권 식별자: 같은 계정이라도 브라우저 탭(세션)별로 구분돼야 한 탭의 claim/takeover가
// 다른 탭에 잘못 반영되지 않는다. 클라가 보내는 X-Session-Id로 email#sid 합성(헤더 없으면 email).
function wirelessActor(req) {
  const email = req.user?.email || null;
  if (!email) return null;
  const sid = req.get("X-Session-Id");
  return sid ? `${email}#${sid}` : email;
}
// 표시·계정 게이팅용: controller에서 email 부분만(세션 접미 #sid 제거).
function controllerEmail(c) {
  if (!c) return c;
  const i = c.indexOf("#");
  return i === -1 ? c : c.slice(0, i);
}

function rejectMutation(req, res, {
  action, status, message, target, operation, context = {},
}) {
  logger.warn(req, action, {
    error: message,
    reason: message,
    operation,
    ...context,
  }, target);
  return res.status(status).send(message);
}

function runRecordPreflight(req, res, { action, operation, target, lookup }) {
  const result = dbRun(lookup);
  if (!result.success) {
    const error = result.internalError || result.error;
    logger.warn(req, action, {
      error,
      reason: error,
      operation,
      phase: "record_preflight",
    }, target);
    res.status(500).send("기록 정보를 확인할 수 없습니다.");
    return { ok: false, value: null };
  }
  if (result.result?.rejection) {
    const rejection = result.result.rejection;
    rejectMutation(req, res, {
      action,
      status: rejection.status,
      message: rejection.message,
      target,
      operation,
      context: rejection.context,
    });
    return { ok: false, value: null };
  }
  return { ok: true, value: result.result?.value };
}

function runMutationPreflight(req, res, {
  action, operation, target, context = {}, lookup, failureMessage = "현재 상태를 확인할 수 없습니다.",
}) {
  const result = dbRun(lookup);
  if (result.success) return { ok: true, value: result.result };
  const error = result.internalError || result.error;
  logger.warn(req, action, {
    error,
    reason: error,
    operation,
    phase: "mutation_preflight",
    ...context,
  }, target);
  res.status(500).send(failureMessage);
  return { ok: false, value: null };
}

/* ── 서버 권위 기록 엔진 ──────────────────────────────────────────────
 * ingest로 들어온 타이밍 이벤트를 매핑·세션으로 라우팅해 서버가 직접 기록을 계산·저장한다.
 * 가속·오토크로스는 출발→도착, 스키드패드는 lap2+lap4. 원시 tick 기준으로 검증한다.
 * 팀·이벤트가 선택되지 않은 테스트 계측도 같은 서버 결과를 표시하되 기록 행은 저장하지 않는다.
 */
function clockStr(ms) {
  if (ms < 0) ms = 0;
  const m = String(Math.floor(ms / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const ms3 = String(ms % 1000).padStart(3, "0");
  return `${m}:${s}.${ms3}`;
}
// SQLite owns run state. A request edits only its local drafts; failed writes
// discard them without restoring caches or attempting another database write.
function encodeRun(run) {
  return JSON.stringify(run, (_key, value) => typeof value === "bigint" ? String(value) : value);
}
function getRun(eventType) {
  if (timingContext?.runs.has(eventType)) return timingContext.runs.get(eventType);
  const row = db.prepare("SELECT run_id, engine_state FROM wireless_session WHERE event_type = ?").get(eventType);
  let run = row?.engine_state ? JSON.parse(row.engine_state) : null;
  if (run?.runId !== row?.run_id) run = null;
  if (run) {
    run.lapTicks = (run.lapTicks || []).map(BigInt);
  }
  if (timingContext) timingContext.runs.set(eventType, run);
  return run;
}
function setRun(eventType, run) {
  if (!timingContext) throw new Error("Run changes require a timing transaction");
  timingContext.runs.set(eventType, run);
}
function timingTransaction(work) {
  if (timingContext) throw new Error("Nested timing transaction");
  const context = { runs: new Map(), telemetry: new Map(), bridge: null, notifications: [] };
  timingContext = context;
  const result = dbRun(() => db.transaction(() => {
    const value = work();
    const update = db.prepare("UPDATE wireless_session SET engine_state = ? WHERE event_type = ? AND engine_state IS NOT ?");
    for (const [eventType, run] of context.runs) {
      const encoded = run ? encodeRun(run) : null;
      update.run(encoded, eventType, encoded);
    }
    return value;
  })());
  timingContext = null;
  if (result.success) {
    for (const [node, state] of context.telemetry) liveTelemetry.set(node, state);
    if (context.bridge) commitBridgeSeen(context.bridge);
    for (const [event, data] of context.notifications) broadcastEvent(event, data);
  }
  return result;
}
function resetEngineRun(eventType, bound = null, runId = null, clock = null) {
  const nodes = {};
  let cursorId = getLastEventId();
  if (clock) {
    for (const mapping of getMapping().filter(row => row.event_type === eventType && row.enabled !== 0)) {
      const checkpoints = db.prepare("SELECT * FROM wireless_event WHERE node_id = ? AND master_boot_id = ? AND (flags & ?) != 0 ORDER BY id DESC")
        .all(mapping.node_id, clock.master_boot_id, CAPTURE_CHECKPOINT);
      const checkpoint = checkpoints.find(row => BigInt(row.master_tick) <= BigInt(clock.master_tick));
      const currentBoot = liveTelemetry.get(String(mapping.node_id))?.sensor_boot_id;
      if (!checkpoint || (currentBoot != null && checkpoint.sensor_boot_id !== currentBoot) || (checkpoint.flags & 15) !== 15 || telemetryAgeMs({ last_seen: checkpoint.server_time }) > WIRELESS_STATUS_MAX_AGE_MS) {
        const error = new Error(`${mapping.node_id} 센서의 최신 캡처 확인을 기다린 뒤 다시 시작하세요.`);
        error.status = 409;
        throw error;
      }
      nodes[mapping.node_id] = { boot: checkpoint.sensor_boot_id, seq: checkpoint.capture_seq, role: mapping.role };
      cursorId = Math.min(cursorId, checkpoint.id);
    }
  }
  setRun(eventType, {
    version: WIRELESS_PROTOCOL_VERSION, runId, boundaryTick: clock?.master_tick ?? null,
    masterBootId: clock?.master_boot_id ?? null, nodes, cursorId, bound,
    closed: false, verification: "pending", lapTicks: [], result: null,
    recordName: null, recordRowid: null,
  });
}

// An older in-flight run has no v9 source frontier. Preserve official records,
// but do not join new captures onto unverifiable pre-upgrade state.
const interruptedRuns = db.prepare("SELECT event_type, run_id FROM wireless_session WHERE armed = 1 AND (engine_state IS NULL OR json_extract(engine_state, '$.version') IS NOT ?)").all(WIRELESS_PROTOCOL_VERSION);
if (interruptedRuns.length) {
  db.prepare("UPDATE wireless_session SET armed = 0, engine_state = NULL WHERE armed = 1 AND (engine_state IS NULL OR json_extract(engine_state, '$.version') IS NOT ?)").run(WIRELESS_PROTOCOL_VERSION);
  logger.warn(null, "wireless.run.recovery", { error: "기존 계측에 캡처 검증 정보가 없어 중단했습니다.", runs: interruptedRuns }, "wireless");
}

function currentRecordYear() {
  return currentCompetitionYear();
}

function resolveCanonicalTeam(team, year = currentRecordYear()) {
  if (!options.teamStore) {
    if (!isTeamActive(db, year, team?.num)) {
      return { valid: false, status: 409, error: "비활성화된 엔트리에는 기록을 저장할 수 없습니다." };
    }
    return { valid: true, team };
  }

  const teamId = Number(team?.teamId ?? team?.id);
  if (!Number.isInteger(teamId) || teamId < 1) {
    return { valid: false, status: 409, error: "팀 정보가 변경되었습니다. 새로고침 후 다시 선택하세요." };
  }
  const canonical = options.teamStore.getById(teamId);
  if (!canonical || canonical.year !== year || !canonical.active) {
    return { valid: false, status: 409, error: "현재 연도의 활성 팀이 아닙니다. 새로고침 후 다시 선택하세요." };
  }
  return {
    valid: true,
    team: {
      id: canonical.id,
      teamId: canonical.id,
      num: canonical.number,
      univ: canonical.university,
      team: canonical.name,
      type: canonical.vehicleType,
      active: canonical.active,
    },
  };
}
function getDebounceMs() {
  const row = db.prepare("SELECT debounce_ms FROM wireless_light WHERE id = 1").get();
  return Number.isFinite(row?.debounce_ms) ? row.debounce_ms : 300;
}
// 백그라운드(기록 엔진·워치독) 로그의 actorOverride. 사용자 요청 경로에서는 쓰지 않는다.
const SYS_ACTOR = { email: "system", name: "system", role: "admin" };
// 동적 기록 테이블에 한 줄 저장 + records 브로드캐스트.
// binding = 귀속 정보 {team, event_name}: arm 스냅샷(run.bound) 또는 live 세션.
// 선택 정보(team·event_name) 자체가 없으면 = 테스트 모드 → 조용히 skip(경고 없음).
// 선택은 됐는데 검증 실패(잘못된 팀/이름) → warn 로그(유선의 POST /api/records와 동일 검증).
function engineSaveRecord(eventType, binding, result, detail, audit = null, status = null) {
  if (!binding?.event_name || !binding?.team) return false;
  const nameCheck = validateRecordName(binding.event_name);
  if (!nameCheck.valid) throw new Error(nameCheck.error);
  const data = { time: new Date().toISOString(), type: eventType, entry: binding.team, result, status, detail };
  const valid = validateRecordData(data, { allowRoundedZero: true });
  if (!valid.valid) throw new Error(valid.error);
  const name = `FSK ${currentCompetitionYear()} ${nameCheck.value}`;
  const run = getRun(eventType);
  const record = insertRecordRow(name, data);
  run.recordName = name;
  run.recordRowid = record.rowid;
  db.prepare("UPDATE wireless_session SET saved_record_name = ?, saved_record_rowid = ? WHERE event_type = ? AND run_id = ?")
    .run(name, record.rowid, eventType, run.runId);
  logger.log(audit?.req ?? null, "wireless.record", { type: eventType, run_id: run.runId, after: record }, name, audit?.req ? undefined : SYS_ACTOR);
  broadcastEvent("records", { type: "add", name, recordFiles: getRecordFiles(), record, event_type: eventType, run_id: run.runId });
  return { name, record };
}
function enduranceUpsertRecord(eventType, binding, run) {
  if (!binding?.event_name || !binding?.team || !run.lapTicks.length) return;
  const total = masterTickDurationsMs(run.lapTicks);
  const detail = formatEnduranceDetail(run.lapTicks.map(ticks => masterTickDurationsMs([ticks])));
  const before = run.recordName && getRecordRow(run.recordName, run.recordRowid);
  if (!before) { engineSaveRecord(eventType, binding, total, detail); return; }
  if (before.result === total && before.detail === detail) return;
  db.prepare("UPDATE record SET result = ?, detail = ? WHERE name = ? AND legacy_rowid = ?").run(total, detail, run.recordName, run.recordRowid);
  const after = getRecordRow(run.recordName, run.recordRowid);
  logger.log(null, "wireless.record", { event_type: eventType, run_id: run.runId, before, after }, run.recordName, SYS_ACTOR);
  broadcastEvent("records", { type: "update", name: run.recordName, field: "result", recordFiles: getRecordFiles(), record: after, event_type: eventType, run_id: run.runId });
}

function invalidateRun(eventType, run, reasons, { awaitEvidence = false } = {}) {
  // Disarming blocks a new interval; closing also prevents late proof recovery.
  run.closed = !awaitEvidence;
  run.verification = "invalid";
  db.prepare("UPDATE wireless_session SET armed = 0 WHERE event_type = ? AND armed != 0").run(eventType);
  if (!run.fault) {
    publishWirelessQualityFault(eventType, run.runId, reasons);
    logger.warn(null, "wireless.quality_fault", { error: reasons[0]?.reason, event_type: eventType, run_id: run.runId, reasons }, eventType, SYS_ACTOR);
  }
}
function processRecordEngine(rows, onlyEventType = null) {
  if (!rows.length) return;
  for (const session of getSessions()) {
    const et = session.event_type;
    if (onlyEventType && et !== onlyEventType) continue;
    const run = getRun(et);
    if (!run) {
      if (session.armed) throw new Error("진행 중인 계측의 영속 상태가 없습니다.");
      continue;
    }
    if (run.closed || !rows.some(row => run.nodes[row.node_id] || row.node_id === "0")) continue;
    const evidence = db.prepare("SELECT * FROM wireless_event WHERE id > ? ORDER BY id").all(run.cursorId);
    const verified = verifyCaptures(run, evidence);
    const debounce = {};
    const accepted = verified.events.filter(ev => {
      const last = debounce[ev.node_id];
      if (last != null && masterTickDistanceBelowMs(ev.master_tick, last, getDebounceMs())) return false;
      debounce[ev.node_id] = ev.master_tick;
      return true;
    });
    let result = null;
    let detail = null;
    let complete = false;
    let invalidDuration = false;
    const laps = [];
    if (et === "내구" || et === "스키드패드") {
      const crossings = accepted.filter(ev => ev.role === "start");
      for (let i = 1; i < crossings.length; i++) {
        const duration = masterTickDelta(crossings[i].master_tick, crossings[i - 1].master_tick);
        if (duration <= 0n) { invalidDuration = true; break; }
        laps.push(duration);
      }
      if (et === "내구" && laps.length) result = masterTickDurationsMs(laps);
      if (et === "스키드패드" && laps.length >= 4) {
        result = masterTickDurationsMs([laps[1], laps[3]]);
        detail = `${clockStr(masterTickDurationsMs([laps[1]]))} / ${clockStr(masterTickDurationsMs([laps[3]]))}`;
        complete = true;
      }
    } else {
      const start = accepted.find(ev => ev.role === "start");
      const finish = accepted.find(ev => ev.role === "finish");
      if (start && finish) {
        const duration = masterTickDelta(finish.master_tick, start.master_tick);
        invalidDuration = duration <= 0n;
        if (!invalidDuration) { result = masterTickDeltaMs(finish.master_tick, start.master_tick); complete = true; }
      }
    }
    run.lapTicks = laps;
    run.result = result;
    run.verification = !complete && run.fault ? "invalid" : result == null ? "pending" : "verified";
    if (result != null && !invalidDuration) {
      if (et === "내구") enduranceUpsertRecord(et, run.bound, run);
      else if (complete) engineSaveRecord(et, run.bound, result, detail);
    }
    if (complete) {
      run.closed = true;
      if (run.fault) clearWirelessQualityFault(et);
    }
    // A completed, verified interval before a later fault stays official.
    if (!complete && (verified.fault || invalidDuration)) {
      invalidateRun(et, run, [verified.fault || { node_id: null, reason: "출발·도착의 원시 시간차가 양수가 아닙니다." }], { awaitEvidence: !!verified.fault && !invalidDuration });
    }
    broadcastEvent("wireless:session", getSession(et));
  }
}
// 최신 무선 이벤트 id. 클라이언트가 (재)연결 시 백필 기준점으로 사용.
function getLastEventId() {
  const row = db.prepare("SELECT MAX(id) AS m FROM wireless_event").get();
  return row && row.m != null ? row.m : 0;
}
// 브리지 ingest 도착 = heartbeat. 오프라인->온라인 전환 시 true 반환(SSE 발행됨).
function stageBridgeSeen() {
  const seenAt = Date.now();
  const seenIso = new Date(seenAt).toISOString();
  const transitioned = !bridgeOnline;
  if (transitioned) {
    db.prepare("UPDATE wireless_light SET bridge_online = 1 WHERE id = 1").run();
  }
  return { seenAt, seenIso, transitioned };
}

function commitBridgeSeen(staged) {
  lastBridgeSeen = staged.seenAt;
  lastBridgeSeenIso = staged.seenIso;
  if (staged.transitioned) {
    bridgeOnline = true;
    broadcastEvent("wireless:bridge", getBridgeState());
  }
  return staged.transitioned;
}

function validateNodeId(s) {
  return typeof s === "string" && /^[A-Za-z0-9_\-:.]{1,64}$/.test(s);
}
// 64-bit tick: 숫자 문자열 또는 정수 number 허용 -> TEXT. 잘못된 값이면 undefined.
function tickToText(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && /^\d{1,20}$/.test(v)
    && BigInt(v) <= ((1n << 64n) - 1n)) return v;
  return undefined;
}
function validBootId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
const ALLOWED_ROLE = /^(start|finish|lane[1-9])$/;

// 브리지 오프라인 감지(15s 무수신). 백그라운드라 logger는 actorOverride 사용.
function runBridgeWatch() {
  if (bridgeOnline && Date.now() - lastBridgeSeen > 15000) {
    try {
      db.prepare("UPDATE wireless_light SET bridge_online = 0 WHERE id = 1").run();
      bridgeOnline = false;
      broadcastEvent("wireless:bridge", getBridgeState());
      // 명시적 offline 신고(POST /bridge/offline)와 달리 워치독 감지는 브리지가 예기치 않게
      // 죽었다는 뜻 — 운영자가 레벨 필터로 찾아야 하므로 warn.
      logger.warn(null, "wireless.bridge", { online: false, watchdog: true, last_seen: lastBridgeSeenIso }, "bridge", SYS_ACTOR);
      const quality = timingTransaction(() => enforceArmedWirelessQuality(null));
      if (!quality.success) throw new Error(quality.error);
    } catch (e) {
      logger.warn(null, "wireless.bridge", { error: e.message || String(e), online: false }, "bridge", SYS_ACTOR);
      // try 본문이 DB 작업이라 위 logger INSERT도 같이 실패했을 수 있다 — 콘솔 폴백 유지(정책 예외).
      console.error("[wireless] bridge watch:", e.message || e);
    }
  }
  return { skipped: false };
}
const bridgeWatch = setInterval(runBridgeWatch, 5000);
bridgeWatch.unref?.();

// lease 만료 정리: 만료된 controller를 비우고 해당 경기 세션을 브로드캐스트(전 클라가 read-only 해제 인지).
function runLeaseWatch() {
  try {
    const expired = db
      .prepare("SELECT event_type, controller, lease_expires_at FROM wireless_session WHERE controller IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?")
      .all(new Date().toISOString());
    for (const before of expired) {
      const update = db.prepare("UPDATE wireless_session SET controller = NULL, lease_expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ? AND controller = ? AND lease_expires_at = ?")
        .run(before.event_type, before.controller, before.lease_expires_at);
      if (update.changes !== 1) continue;
      logger.log(null, "wireless.lease.expire", {
        event_type: before.event_type,
        before: { controller: before.controller, lease_expires_at: before.lease_expires_at },
        after: { controller: null, lease_expires_at: null },
      }, before.event_type, SYS_ACTOR);
      broadcastEvent("wireless:session", getSession(before.event_type));
    }
    return { skipped: false, expired: expired.length };
  } catch (e) {
    logger.warn(null, "wireless.lease.watch", { error: e.message || String(e) }, "lease", SYS_ACTOR);
    // try 본문이 DB 작업이라 위 logger INSERT도 같이 실패했을 수 있다 — 콘솔 폴백 유지(정책 예외).
    console.error("[wireless] lease watch:", e.message || e);
  }
  return { skipped: false, expired: 0 };
}
const leaseWatch = setInterval(runLeaseWatch, 5000);
leaseWatch.unref?.();

// 무선 이벤트 보존 한도(약 50만 행). 백그라운드 트림.
function runEventRetention() {
  try {
    const result = pruneWirelessEvents();
    if (result.removed > 0) {
      logger.log(null, "wireless.event.retention", {
        cutoff_id: result.cutoff,
        removed: result.removed,
        retained_limit: RETAIN_EVENTS,
      }, "wireless_event", SYS_ACTOR);
    }
    return { skipped: false, ...result };
  } catch (e) {
    logger.warn(null, "wireless.event.retention", { error: e.message || String(e) }, "wireless_event", SYS_ACTOR);
    // try 본문이 DB 작업이라 위 logger INSERT도 같이 실패했을 수 있다 — 콘솔 폴백 유지(정책 예외).
    console.error("[wireless] event retention:", e.message || e);
  }
  return { skipped: false, removed: 0, cutoff: null };
}
const eventRetention = setInterval(runEventRetention, 60000);
eventRetention.unref?.();

// liveTelemetry TTL 정리: 오래 안 보인 node 항목을 제거해 무한 성장(임의 node_id 유입)과
// SSE init 페이로드 비대를 막는다. wireless_event와 달리 실시간 상태라 짧게 유지.
const LIVE_TELEMETRY_TTL_MS = 10 * 60 * 1000;
const telemetryRetention = setInterval(() => {
  const cutoff = Date.now() - LIVE_TELEMETRY_TTL_MS;
  for (const [node, t] of liveTelemetry) {
    const seen = Date.parse(t.last_seen || "");
    if (!Number.isFinite(seen) || seen < cutoff) liveTelemetry.delete(node);
  }
}, 60000);
telemetryRetention.unref?.();

const LIVE_ATTEMPT_TTL_MS = 10 * 60 * 1000;
function runLiveAttemptWatch(now = Date.now()) {
  for (const [eventType, attempt] of liveAttempts) {
    if (now - attempt.started_at_ms <= LIVE_ATTEMPT_TTL_MS) continue;
    try {
      logger.log(null, "live_attempt.expire", {
        event_type: eventType,
        attempt_id: attempt.attempt_id,
      }, eventType, SYS_ACTOR);
      liveAttempts.delete(eventType);
      broadcastEvent("live-attempt", {
        active: false,
        event_type: eventType,
        attempt_id: attempt.attempt_id,
        reason: "timeout",
      });
    } catch (error) {
      console.error("[traffic] live attempt expiry:", error?.message || error);
    }
  }
}
const liveAttemptWatch = setInterval(runLiveAttemptWatch, 1000);
liveAttemptWatch.unref?.();

// SSE 엔드포인트
app.get("/api/events", sseHandler(() => ({
  recordFiles: getRecordFiles(),
  eventModes: getEventModes(),
  recordVisibility: getRecordVisibility(),
  liveAttempts: getLiveAttempts(),
  wireless: {
    light: getLightState(),
    mapping: getMapping(),
    telemetry: getLiveTelemetry(),
    bridge: getBridgeState(),
    sessions: getSessions(),
    qualityFaults: getLiveQualityFaults(),
    lastEventId: getLastEventId(),
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

function recordYearFromName(name) {
  const match = String(name || "").match(/^FSK (\d{4}) /);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2099 ? year : null;
}

function isRecordBoundToActiveTeam(year, record) {
  const hasCanonicalTeams = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'competition_team'",
  ).get();
  // Isolated Traffic tests do not install the canonical Competition schema.
  if (!hasCanonicalTeams) return true;
  if (!Number.isInteger(record.team_id)) return false;
  return !!db.prepare(`
    SELECT 1 FROM competition_team
    WHERE id = ? AND year = ? AND num = ? AND active = 1
  `).get(record.team_id, year, record.num);
}

function tableExists(name) {
  return recordFileExists(name);
}

function validateRecordData(data, { allowRoundedZero = false } = {}) {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "올바르지 않은 기록 데이터입니다." };
  }

  const required = ["time", "type", "entry"];
  for (const field of required) {
    if (data[field] === undefined) {
      return { valid: false, error: `필수 필드가 누락되었습니다: ${field}` };
    }
  }

  if (!data.entry || typeof data.entry !== "object") {
    return { valid: false, error: "올바르지 않은 엔트리 데이터입니다." };
  }

  const status = data.status == null ? null : data.status;
  if (status !== null && !RESULT_STATUSES.includes(status)) {
    return { valid: false, error: "판정은 DNS, DNF, DSQ 또는 비움이어야 합니다." };
  }
  const result = data.result == null ? null : data.result;
  if (result !== null && (!Number.isInteger(result) || result < 0 || (result === 0 && !allowRoundedZero))) {
    return { valid: false, error: "측정시간은 양의 정수(ms) 또는 비움이어야 합니다." };
  }
  if (status === null && result === null) {
    return { valid: false, error: "정상 기록에는 측정시간이 필요합니다." };
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

// 팀·이벤트명 선택값 검증(빈/누락 허용 → null). /api/wireless/select와 arm green이 공유.
// 반환: { valid, error?, team(object|null), event_name(string|null) }.
function validateSelection(body) {
  const teamRaw = body?.team;
  let team = null;
  if (teamRaw != null) {
    if (typeof teamRaw !== "object" || !Number.isInteger(teamRaw.num) || teamRaw.num < 1 ||
        typeof teamRaw.univ !== "string" || !teamRaw.univ ||
        typeof teamRaw.team !== "string" || !teamRaw.team) {
      return { valid: false, error: "올바르지 않은 팀 정보입니다." };
    }
    const resolved = resolveCanonicalTeam(teamRaw);
    if (!resolved.valid) return resolved;
    team = resolved.team;
  }
  let event_name = typeof body?.event_name === "string" ? body.event_name.trim() : null;
  if (event_name === "") event_name = null;
  if (event_name != null) {
    const nv = validateRecordName(event_name);
    if (!nv.valid) return { valid: false, error: nv.error };
    event_name = nv.value;
  }
  return { valid: true, team, event_name };
}

function validateSelectionRequest(req, res, action, eventType, body = req.body) {
  try {
    return validateSelection(body);
  } catch (error) {
    const teamId = Number(body?.team?.teamId ?? body?.team?.id);
    logger.warn(req, action, {
      error: error?.message || String(error),
      phase: "canonical_team_lookup",
      event_type: eventType,
      year: currentRecordYear(),
      team_id: Number.isInteger(teamId) && teamId > 0 ? teamId : null,
    }, eventType);
    res.status(500).send("팀 기준 정보를 확인할 수 없습니다.");
    return null;
  }
}

function validateControllerData({ timestamp, data }) {
  if (timestamp === undefined || timestamp === null) {
    return { valid: false, error: "타임스탬프가 누락되었습니다." };
  }
  if (typeof timestamp !== "string") {
    return { valid: false, error: "타임스탬프 형식이 올바르지 않습니다." };
  }
  const normalizedTimestamp = normalizeUtcTextTimestamp(timestamp);
  if (!normalizedTimestamp) {
    return { valid: false, error: "타임스탬프 형식이 올바르지 않습니다." };
  }
  if (data === undefined || data === null) {
    return { valid: false, error: "데이터가 누락되었습니다." };
  }
  if (typeof data !== "string") {
    return { valid: false, error: "데이터 형식이 올바르지 않습니다." };
  }
  return { valid: true, timestamp: normalizedTimestamp };
}

// 유선 컨트롤러와 유선 매뉴얼 모드는 같은 센서 처리 경로를 사용한다. 출발 센서가
// 래치된 시점만 서버에 공유하고, 전광판 클라이언트는 SSE 수신 시점부터 로컬로 시간을 증가시킨다.
app.post("/api/live-attempts", (req, res) => {
  const { action, event_type, attempt_id } = req.body || {};
  const reject = (message) => rejectMutation(req, res, {
    action: "live_attempt.publish",
    status: 400,
    message,
    target: typeof event_type === "string" ? event_type : "live_attempt",
    operation: typeof action === "string" ? action : "publish",
    context: { event_type: event_type ?? null, attempt_id: attempt_id ?? null },
  });

  if (!EVENT_TYPES.includes(event_type)) return reject("올바르지 않은 종목입니다.");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(attempt_id || "")) return reject("올바르지 않은 계측 시도 ID입니다.");

  if (action === "start") {
    const selection = validateSelectionRequest(req, res, "live_attempt.start", event_type);
    if (!selection) return;
    if (!selection.valid) {
      return rejectMutation(req, res, {
        action: "live_attempt.start",
        status: selection.status || 400,
        message: selection.error,
        target: event_type,
        operation: "start",
        context: { event_type, attempt_id },
      });
    }
    if (!selection.team || !selection.event_name) return reject("경기 이름과 참가팀을 선택해야 합니다.");

    const startedAtMs = Date.now();
    const attempt = {
      attempt_id,
      event_type,
      event_name: selection.event_name,
      team: selection.team,
      started_at: new Date(startedAtMs).toISOString(),
      started_at_ms: startedAtMs,
    };
    const payload = liveAttemptPayload(attempt, startedAtMs);
    logger.log(req, "live_attempt.start", {
      event_type,
      attempt_id,
      event_name: selection.event_name,
      team_id: selection.team.id ?? selection.team.teamId ?? null,
      team_num: selection.team.num,
    }, event_type);
    liveAttempts.set(event_type, attempt);
    broadcastEvent("live-attempt", payload);
    return res.status(201).json(payload);
  }

  if (action === "stop") {
    const current = liveAttempts.get(event_type);
    const cleared = current?.attempt_id === attempt_id;
    logger.log(req, "live_attempt.stop", { event_type, attempt_id, cleared }, event_type);
    if (cleared) {
      liveAttempts.delete(event_type);
      broadcastEvent("live-attempt", { active: false, event_type, attempt_id });
    }
    return res.json({ cleared });
  }

  return reject("올바르지 않은 계측 상태 작업입니다.");
});

/* ============================================
   API 라우트: /api/records
   ============================================ */

// GET /api/records - 모든 기록 테이블 목록 조회
app.get("/api/records", (req, res) => {
  const result = dbRun(() => {
    return getRecordFiles();
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

// GET /api/records/year/:year - score 집계용 연도별 기록 일괄 조회
app.get("/api/records/year/:year", (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return res.status(400).send("올바르지 않은 연도입니다.");

  const result = dbRun(() => getYearRecordGroups(year));

  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// PUT /api/records/:name/visibility - 기록 파일 성적 반영 토글
app.put("/api/records/:name/visibility", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    logger.warn(req, "record.visibility", { error: validation.error }, req.params.name);
    return res.status(400).send(validation.error);
  }

  const name = validation.value;
  const preflight = runRecordPreflight(req, res, {
    action: "record.visibility",
    operation: "visibility_toggle",
    target: name,
    lookup: () => tableExists(name)
      ? { value: true }
      : {
          rejection: {
            status: 404,
            message: "기록을 찾을 수 없습니다.",
            context: { reason_code: "record_not_found", record_name: name },
          },
        },
  });
  if (!preflight.ok) return;

  const result = dbRun(() => {
    const row = db.prepare("SELECT visible FROM record_visibility WHERE name = ?").get(name);
    const newVisible = row ? (row.visible ? 0 : 1) : 0;
    db.prepare("INSERT INTO record_visibility (name, visible) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET visible = excluded.visible").run(name, newVisible);
    return { name, visible: newVisible };
  });

  if (!result.success) {
    logger.warn(req, "record.visibility", { error: result.internalError || result.error }, name);
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

  const result = dbRun(() => getRecordRows(name));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/records - 새 기록 추가
app.post("/api/records", (req, res) => {
  const nameValidation = validateRecordName(req.body.name);
  if (!nameValidation.valid) {
    return rejectMutation(req, res, {
      action: "record.create", status: 400, message: nameValidation.error,
      target: "record", operation: "create",
      context: { requested_name: req.body?.name ?? null },
    });
  }

  const dataValidation = validateRecordData(req.body.data);
  if (!dataValidation.valid) {
    return rejectMutation(req, res, {
      action: "record.create", status: 400, message: dataValidation.error,
      target: nameValidation.value, operation: "create",
      context: {
        entry_num: req.body?.data?.entry?.num ?? null,
        result: req.body?.data?.result ?? null,
        status: req.body?.data?.status ?? null,
      },
    });
  }

  const name = `FSK ${currentCompetitionYear()} ${nameValidation.value}`;
  const data = req.body.data;

  const result = dbRun(() => {
    return db.transaction(() => insertRecordRow(name, data))();
  });

  if (!result.success) {
    logger.warn(req, "record.create", { error: result.internalError || result.error, entry_num: data.entry.num }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.create", {
    entry_num: data.entry.num,
    type: data.type,
    result: data.result ?? null,
    status: data.status ?? null,
  }, name);

  // SSE 브로드캐스트
  broadcastEvent("records", {
    type: "add", name, recordFiles: getRecordFiles(),
    record: result.result,
  });

  // 생성된 테이블명 + 행(rowid 포함) 반환 — 내구처럼 같은 기록에 이어붙이는 클라가 PATCH에 쓸
  // 테이블명/rowid를 받는다. 기존 호출부는 본문을 무시하므로 하위호환.
  res.status(201).json({ name, record: result.result });
});

// PATCH /api/records/:name/:rowid - 기록 필드 업데이트
app.patch("/api/records/:name/:rowid", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return rejectMutation(req, res, {
      action: "record.update", status: 400, message: validation.error,
      target: "record", operation: "update",
      context: { requested_name: req.params.name ?? null, rowid: req.params.rowid ?? null },
    });
  }

  const name = validation.value;
  const recordYear = recordYearFromName(name);
  if (recordYear == null) {
    logger.warn(req, "record.update", { error: "unparseable competition year" }, name);
    return res.status(400).send("기록 이름에서 대회 연도를 확인할 수 없습니다.");
  }
  if (recordYear !== currentRecordYear()) {
    logger.warn(req, "record.update", { error: "historical record is read-only", recordYear }, name);
    return res.status(409).send("현재 연도의 기록만 수정할 수 있습니다.");
  }

  const rowid = parseInt(req.params.rowid, 10);

  if (isNaN(rowid)) {
    return rejectMutation(req, res, {
      action: "record.update", status: 400, message: "올바르지 않은 rowid입니다.",
      target: name, operation: "update", context: { rowid: req.params.rowid ?? null },
    });
  }
  const { field, value } = req.body;
  if (!["status", "scoreboard", "detail", "cones", "oc", "result"].includes(field)) {
    return rejectMutation(req, res, {
      action: "record.update", status: 400, message: "올바르지 않은 필드입니다.",
      target: name, operation: "update", context: { rowid, field: field ?? null },
    });
  }
  if (field === "status" && value !== null && !RESULT_STATUSES.includes(value)) {
    return rejectMutation(req, res, {
      action: "record.update", status: 400, message: "판정은 DNS, DNF, DSQ 또는 비움이어야 합니다.",
      target: name, operation: "update", context: { rowid, field, requested_status: value ?? null },
    });
  }
  if (field === "result" && value !== null && (!Number.isInteger(value) || value <= 0)) {
    return rejectMutation(req, res, {
      action: "record.update", status: 400, message: "측정시간은 양의 정수(ms) 또는 비움이어야 합니다.",
      target: name, operation: "update", context: { rowid, field, requested_result: value ?? null },
    });
  }

  const preflight = runRecordPreflight(req, res, {
    action: "record.update",
    operation: "update",
    target: name,
    lookup: () => {
      if (!tableExists(name)) {
        return {
          rejection: {
            status: 404,
            message: "기록을 찾을 수 없습니다.",
            context: { reason_code: "record_not_found", record_name: name, rowid, field },
          },
        };
      }
      const hasTeamId = db.prepare("PRAGMA table_info(record)").all().some((column) => column.name === "team_id");
      const targetRecord = db.prepare(`
        SELECT num, result, status${hasTeamId ? ", team_id" : ""}
        FROM record WHERE name = ? AND legacy_rowid = ?
      `).get(name, rowid);
      if (!targetRecord) {
        return {
          rejection: {
            status: 404,
            message: "기록을 찾을 수 없습니다.",
            context: { reason_code: "record_row_not_found", record_name: name, rowid, field },
          },
        };
      }
      if (!isTeamActive(db, recordYear, targetRecord.num)) {
        return {
          rejection: {
            status: 409,
            message: "비활성화된 엔트리의 기록은 수정할 수 없습니다.",
            context: {
              reason_code: "inactive_or_missing_team",
              record_name: name,
              rowid,
              field,
              year: recordYear,
              team_num: targetRecord.num,
            },
          },
        };
      }
      if (field === "status" && targetRecord.status === "DSQ" && value !== "DSQ"
        && !isRecordBoundToActiveTeam(recordYear, targetRecord)) {
        return {
          rejection: {
            status: 409,
            message: "팀 연결이 없는 레거시 DSQ 기록은 판정을 변경할 수 없습니다.",
            context: {
              reason_code: "missing_active_canonical_team_binding",
              record_name: name,
              rowid,
              field,
              year: recordYear,
              team_num: targetRecord.num,
              team_id: targetRecord.team_id ?? null,
            },
          },
        };
      }
      return { value: targetRecord };
    },
  });
  if (!preflight.ok) return;

  const execute = field === "status" ? timingTransaction : dbRun;
  const result = execute(() => {
    const row = db.prepare(`
      SELECT num, result, status, scoreboard, detail, cones, oc
      FROM record WHERE name = ? AND legacy_rowid = ?
    `).get(name, rowid);
    if (!row) {
      const err = new Error("기록을 찾을 수 없습니다.");
      err.status = 404;
      throw err;
    }

    if (field === "status") {
      if (value === null && row.result == null) {
        const err = new Error("측정시간이 없는 판정 기록은 정상으로 복원할 수 없습니다. 판정 취소를 사용하세요.");
        err.status = 400;
        throw err;
      }
      db.prepare("UPDATE record SET status = ? WHERE name = ? AND legacy_rowid = ?").run(value, name, rowid);
      const sessions = db.prepare(`SELECT event_type, run_id FROM wireless_session
        WHERE saved_record_name = ? AND saved_record_rowid = ?`).all(name, rowid);
      for (const session of sessions) {
        const run = getRun(session.event_type);
        if (run?.runId === session.run_id) run.closed = true;
      }
      return { num: row.num, result: row.result, status: value, scoreboard: row.scoreboard };
    } else if (field === "scoreboard") {
      const newStatus = row.scoreboard ? 0 : 1;
      db.prepare("UPDATE record SET scoreboard = ? WHERE name = ? AND legacy_rowid = ?").run(newStatus, name, rowid);
      return { num: row.num, result: row.result, status: row.status, scoreboard: newStatus };
    } else if (field === "detail") {
      db.prepare("UPDATE record SET detail = ? WHERE name = ? AND legacy_rowid = ?").run(value ?? null, name, rowid);
      return { num: row.num, result: row.result, status: row.status, scoreboard: row.scoreboard, detail: value ?? null };
    } else if (field === "result") {
      if (value === null && row.status === null) {
        const err = new Error("정상 기록의 측정시간은 비울 수 없습니다.");
        err.status = 400;
        throw err;
      }
      db.prepare("UPDATE record SET result = ? WHERE name = ? AND legacy_rowid = ?").run(value, name, rowid);
      return { num: row.num, result: value, status: row.status, scoreboard: row.scoreboard };
    } else if (field === "cones") {
      const numValue = Math.max(0, parseInt(value, 10) || 0);
      db.prepare("UPDATE record SET cones = ? WHERE name = ? AND legacy_rowid = ?").run(numValue, name, rowid);
      return { num: row.num, cones: numValue };
    } else if (field === "oc") {
      const numValue = Math.max(0, parseInt(value, 10) || 0);
      db.prepare("UPDATE record SET oc = ? WHERE name = ? AND legacy_rowid = ?").run(numValue, name, rowid);
      return { num: row.num, oc: numValue };
    }
  });

  if (!result.success) {
    logger.warn(req, "record.update", {
      error: result.internalError || result.error,
      rowid,
      field,
      requested_value: value ?? null,
    }, name);
    return res.status(result.status).send(result.error);
  }

  const updateAudit = { entry_num: result.result.num, rowid, field, ...result.result };
  if (field === "status") {
    updateAudit.before = { result: preflight.value.result, status: preflight.value.status };
    updateAudit.after = { result: result.result.result, status: result.result.status };
  }
  logger.log(req, "record.update", updateAudit, name);

  // SSE 브로드캐스트 (업데이트된 전체 행 포함)
  try {
    const updatedRow = getRecordRow(name, rowid);
    broadcastEvent("records", { type: "update", name, field, recordFiles: getRecordFiles(), record: updatedRow });
  } catch (e) {
    logger.warn(req, "record.update", { error: e.message, phase: "sse_broadcast" }, name);
  }

  res.json(result.result);
});

// DELETE /api/records/:name/:rowid - 시간 없는 판정 전용 행 취소.
// 측정 원시값이 있는 행은 상태로 보존해야 하므로 이 경로에서 삭제하지 않는다.
app.delete("/api/records/:name/:rowid", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return rejectMutation(req, res, {
      action: "record.row_delete", status: 400, message: validation.error,
      target: "record", operation: "delete_status_only_row",
      context: { requested_name: req.params.name ?? null, rowid: req.params.rowid ?? null },
    });
  }
  const name = validation.value;
  const recordYear = recordYearFromName(name);
  if (recordYear == null) {
    return rejectMutation(req, res, {
      action: "record.row_delete", status: 400, message: "기록 이름에서 대회 연도를 확인할 수 없습니다.",
      target: name, operation: "delete_status_only_row",
    });
  }
  if (recordYear !== currentRecordYear()) {
    return rejectMutation(req, res, {
      action: "record.row_delete", status: 409, message: "현재 연도의 기록만 수정할 수 있습니다.",
      target: name, operation: "delete_status_only_row", context: { record_year: recordYear },
    });
  }
  const rowid = Number.parseInt(req.params.rowid, 10);
  if (!Number.isInteger(rowid)) {
    return rejectMutation(req, res, {
      action: "record.row_delete", status: 400, message: "올바르지 않은 rowid입니다.",
      target: name, operation: "delete_status_only_row", context: { rowid: req.params.rowid ?? null },
    });
  }

  const hasTeamId = db.prepare("PRAGMA table_info(record)").all().some((column) => column.name === "team_id");
  const preflight = runRecordPreflight(req, res, {
    action: "record.row_delete",
    operation: "delete_status_only_row",
    target: name,
    lookup: () => {
      const row = db.prepare(`
        SELECT num, result, status${hasTeamId ? ", team_id" : ""}
        FROM record WHERE name = ? AND legacy_rowid = ?
      `).get(name, rowid);
      if (!row) return { rejection: { status: 404, message: "기록을 찾을 수 없습니다.", context: { rowid } } };
      if (!isTeamActive(db, recordYear, row.num)) {
        return { rejection: { status: 409, message: "비활성화된 엔트리의 기록은 수정할 수 없습니다.", context: { year: recordYear, team_num: row.num, rowid } } };
      }
      if (row.result != null) {
        return { rejection: { status: 409, message: "측정시간이 있는 기록은 삭제할 수 없습니다. 판정을 변경하세요.", context: { rowid, result: row.result, status: row.status } } };
      }
      return { value: row };
    },
  });
  if (!preflight.ok) return;

  const result = dbRun(() => db.transaction(() => {
    const before = getRecordRow(name, rowid);
    if (!before) {
      const error = new Error("기록을 찾을 수 없습니다.");
      error.status = 404;
      throw error;
    }
    const affectedSessions = db.prepare(`
      SELECT event_type, run_id FROM wireless_session
      WHERE saved_record_name = ? AND saved_record_rowid = ?
    `).all(name, rowid);
    const deleted = db.prepare("DELETE FROM record WHERE name = ? AND legacy_rowid = ?").run(name, rowid).changes;
    if (deleted !== 1) throw new Error("기록 삭제 대상이 변경되었습니다.");
    db.prepare(`
      UPDATE wireless_session
      SET saved_record_name = NULL, saved_record_rowid = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE saved_record_name = ? AND saved_record_rowid = ?
    `).run(name, rowid);
    if (!recordFileExists(name)) db.prepare("DELETE FROM record_visibility WHERE name = ?").run(name);
    return { before, affectedSessions };
  })());
  if (!result.success) {
    logger.warn(req, "record.row_delete", { error: result.internalError || result.error, rowid }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.row_delete", { rowid, before: result.result.before }, name);
  for (const { event_type: eventType, run_id: runId } of result.result.affectedSessions) {
    broadcastEvent("wireless:session", getSession(eventType));
  }
  broadcastEvent("records", {
    type: "remove", name, rowid, recordFiles: getRecordFiles(), record: result.result.before,
  });
  res.json({ name, rowid, deleted: true });
});

// DELETE /api/records/:name - 기록 테이블 삭제
app.delete("/api/records/:name", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = validation.value;
  const preflight = runRecordPreflight(req, res, {
    action: "record.delete",
    operation: "delete",
    target: name,
    lookup: () => tableExists(name)
      ? { value: true }
      : {
          rejection: {
            status: 404,
            message: "기록을 찾을 수 없습니다.",
            context: { reason_code: "record_not_found", record_name: name },
          },
        },
  });
  if (!preflight.ok) return;

  const result = dbRun(() =>
    db.transaction(() => {
      const deleted = db.prepare("DELETE FROM record WHERE name = ?").run(name).changes;
      const legacy = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? AND name NOT IN (${reservedSql})`).get(name);
      if (legacy) db.exec(`DROP TABLE IF EXISTS '${name}'`);
      db.prepare("DELETE FROM record_visibility WHERE name = ?").run(name);
      return deleted;
    })(),
  );

  if (!result.success) {
    logger.warn(req, "record.delete", { error: result.internalError || result.error }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.delete", { deleted: result.result }, name);

  // SSE 브로드캐스트
  broadcastEvent("records", { type: "delete", name, recordFiles: getRecordFiles() });

  res.status(200).send();
});

/* ============================================
   API 라우트: /api/controllers
   ============================================ */

// GET /api/controllers - 모든 컨트롤러 로그 조회
app.get("/api/controllers", (req, res) => {
  // 최근 N건만(기본·최대 5000). controller 테이블은 최대 10만 행까지 커질 수 있어 무제한
  // 조회는 수십 MB 응답 + 동기 직렬화로 이벤트 루프를 블로킹한다. limit/offset로 페이지네이션.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5000, 1), 5000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const result = dbRun(() => db.prepare("SELECT * FROM controller ORDER BY timestamp DESC LIMIT ? OFFSET ?").all(limit, offset));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/controllers - 컨트롤러 로그 추가
app.post("/api/controllers", (req, res) => {
  const validation = validateControllerData(req.body);
  if (!validation.valid) {
    return rejectMutation(req, res, {
      action: "controller.upload",
      status: 400,
      message: validation.error,
      target: "controller",
      operation: "upload",
      context: {
        timestamp: req.body?.timestamp ?? null,
        data_type: typeof req.body?.data,
      },
    });
  }

  const result = dbRun(() =>
    db.prepare("INSERT INTO controller (timestamp, data) VALUES (?, ?)").run(validation.timestamp, req.body.data),
  );

  if (!result.success) {
    logger.warn(req, "controller.upload", { error: result.internalError || result.error });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "controller.upload", {
    rowid: Number(result.result.lastInsertRowid),
    timestamp: validation.timestamp,
    bytes: Buffer.byteLength(req.body.data),
  }, "controller");
  res.status(201).send();
});

// DELETE /api/controllers - 모든 컨트롤러 로그 삭제
app.delete("/api/controllers", (req, res) => {
  const result = dbRun(() => db.prepare("DELETE FROM controller").run());

  if (!result.success) {
    logger.warn(req, "controller.clear", { error: result.internalError || result.error });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "controller.clear", { deleted: result.result.changes });
  res.status(200).send();
});

/* ============================================
   API 라우트: /api/event-modes
   ============================================ */

// GET /api/event-modes - 경기 모드 목록 및 활성화 상태 조회
app.get("/api/event-modes", (req, res) => {
  const result = dbRun(() => getEventModes());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// PUT /api/event-modes/:type - 경기 모드 활성화/비활성화 토글
app.put("/api/event-modes/:type", (req, res) => {
  const eventType = req.params.type;
  const preflight = runMutationPreflight(req, res, {
    action: "event_mode.toggle",
    operation: "toggle",
    target: eventType,
    context: { event_type: eventType },
    lookup: () => db.prepare("SELECT enabled FROM event_mode WHERE event_type = ?").get(eventType),
    failureMessage: "경기 모드 상태를 확인할 수 없습니다.",
  });
  if (!preflight.ok) return;
  const row = preflight.value;
  if (!row) {
    logger.warn(req, "event_mode.toggle", { error: "not_found" }, eventType);
    return res.status(404).send("경기 모드를 찾을 수 없습니다.");
  }

  const newEnabled = row.enabled ? 0 : 1;
  const result = dbRun(() =>
    db.prepare("UPDATE event_mode SET enabled = ? WHERE event_type = ?").run(newEnabled, eventType),
  );
  if (!result.success) {
    logger.warn(req, "event_mode.toggle", { error: result.internalError || result.error }, eventType);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "event_mode.toggle", { enabled: !!newEnabled }, eventType);

  broadcastEvent("event-mode", { event_type: eventType, enabled: newEnabled });
  res.json({ event_type: eventType, enabled: newEnabled });
});

/* ============================================
   API 라우트: /api/wireless (무선 LoRa 계측)
   ============================================ */

// POST /api/wireless/ingest - 브리지가 모든 센서의 타이밍 이벤트 + 진단을 push.
// 성공은 로그하지 않음(텔레메트리 firehose); 실패·브리지 전환만 로그.
app.post("/api/wireless/clock", (req, res) => {
  const { request_id, master_boot_id } = req.body || {};
  const master_tick = tickToText(req.body?.master_tick);
  if (typeof request_id !== "string" || !/^[a-f0-9]{32}$/.test(request_id)
    || master_tick == null || !validBootId(master_boot_id)) {
    return rejectMutation(req, res, {
      action: "wireless.clock", status: 400, message: "마스터 시각 응답이 올바르지 않습니다.",
      target: "bridge", operation: "clock", context: { request_id, master_boot_id },
    });
  }
  if (!wirelessClock.accept({ request_id, master_tick, master_boot_id })) {
    return rejectMutation(req, res, {
      action: "wireless.clock", status: 409, message: "만료되었거나 처리된 마스터 시각 응답입니다.",
      target: "bridge", operation: "clock", context: { request_id, master_boot_id },
    });
  }
  logger.log(req, "wireless.clock", { request_id, master_boot_id, master_tick }, "bridge");
  res.json({ ok: true });
});

app.post("/api/wireless/ingest", (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events : [];
  const telemetry = Array.isArray(body.telemetry) ? body.telemetry : [];
  if (events.length > 200 || telemetry.length > 200) {
    return rejectMutation(req, res, {
      action: "wireless.ingest",
      status: 400,
      message: "ingest 배치가 너무 큽니다.",
      target: "bridge",
      operation: "ingest",
      context: { counts: { events: events.length, telemetry: telemetry.length }, limit: 200 },
    });
  }

  const result = timingTransaction(() => {
    const bridge = stageBridgeSeen();
    const inserted = [];
    const acknowledged = [];
    let deduped = 0;
    let rejected = 0;
    const reasons = {}; // 사유별 카운트(로깅용)
    const reject = (why) => { rejected++; reasons[why] = (reasons[why] || 0) + 1; };
    const ins = db.prepare("INSERT OR IGNORE INTO wireless_event (node_id, master_tick, ev_seq, rssi, snr, link_state, master_boot_id, sensor_boot_id, capture_seq, end_seq, end_tick, flags, sync_age_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const sel = db.prepare("SELECT * FROM wireless_event WHERE id = ?");
    // 불량 항목 하나가 배치 전체를 날리지 않도록 throw 대신 skip — 시리얼 라인 깨짐 등으로
    // 한 줄이 망가져도 같은 flush에 묶인 정상 이벤트는 저장·broadcast된다.
    for (const e of events) {
      if (!validateNodeId(String(e.node_id))) { reject("node_id"); continue; }
      const tick = tickToText(e.master_tick);
      // 타이밍 이벤트는 dedupe key 전체가 필수다. SQLite UNIQUE는 NULL을 서로 다른 값으로
      // 취급하므로 누락된 key를 저장하면 재전송 멱등성이 깨진다.
      if (tick === undefined || tick === null) { reject("master_tick"); continue; }
      if (!Number.isInteger(e.ev_seq) || e.ev_seq < 0 || e.ev_seq > 0xffff) { reject("ev_seq"); continue; }
      if (!validBootId(e.master_boot_id)) { reject("master_boot_id"); continue; }
      if (!validBootId(e.sensor_boot_id) || !validBootId(e.capture_seq) || !validBootId(e.end_seq)
        || tickToText(e.end_tick) == null || !Number.isInteger(e.flags) || e.flags < 0 || e.flags > 127
        || !Number.isInteger(e.sync_age_ms) || e.sync_age_ms < 0 || e.sync_age_ms > 65535
        || ((e.end_seq - e.capture_seq) >>> 0) >= 0x80000000
        || (!(e.flags & CAPTURE_LOSS) && (e.end_seq !== e.capture_seq || e.end_tick !== tick))
        || ((e.flags & CAPTURE_LOSS) && (e.flags & CAPTURE_CHECKPOINT))) {
        reject("capture_evidence"); continue;
      }
      const evSeq = e.ev_seq;
      const rssi = typeof e.rssi === "number" ? e.rssi : null;
      const snr = typeof e.snr === "number" ? e.snr : null;
      const link = typeof e.link_state === "string" ? e.link_state : null;
      const info = ins.run(String(e.node_id), tick, evSeq, rssi, snr, link, e.master_boot_id, e.sensor_boot_id, e.capture_seq, e.end_seq, e.end_tick, e.flags, e.sync_age_ms);
      if (info.changes > 0) { inserted.push(sel.get(Number(info.lastInsertRowid))); }
      else if (!(e.flags & CAPTURE_CHECKPOINT)) { deduped++; }
      acknowledged.push({ node_id: String(e.node_id), master_tick: tick, ev_seq: evSeq, master_boot_id: e.master_boot_id, sensor_boot_id: e.sensor_boot_id });
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const tOut = [];
    const stagedTelemetry = new Map();
    const secLog = []; // 보안 관측(인증 실패 증가/미프로비저닝) — 트랜잭션 밖에서 logger.warn
    for (const t of telemetry) {
      if (!validateNodeId(String(t.node_id))) { reject("tel.node_id"); continue; }
      const node = String(t.node_id);
      const rssi = typeof t.rssi === "number" ? t.rssi : null;
      const snr = typeof t.snr === "number" ? t.snr : null;
      const offset = Number.isFinite(t.offset_us) ? Math.trunc(t.offset_us) : null;
      const skew = typeof t.skew_ppm === "number" ? t.skew_ppm : null;
      const lat = typeof t.latency_ms === "number" ? t.latency_ms : null;
      const link = typeof t.link_state === "string" ? t.link_state : null;
      const rxMiss = Number.isFinite(t.rx_miss) ? Math.trunc(t.rx_miss) : null;
      const gap = Number.isFinite(t.beacon_gap) ? Math.trunc(t.beacon_gap) : null;
      // 다이 온도(deci-°C)와 배터리/충전레일(mV). 마스터(node 0)는 충전 레일 전압.
      const tempC10 = Number.isFinite(t.temp_c10) ? Math.trunc(t.temp_c10) : null;
      const battMv = Number.isFinite(t.batt_mv) ? Math.trunc(t.batt_mv) : null;
      // 보안 관측 필드(펌웨어 D 라인 신규): 인증 거부 카운터 + 프로비저닝 여부.
      const secDrop = Number.isFinite(t.sec_drop) ? Math.trunc(t.sec_drop) : null;
      const provisioned = (t.provisioned === 0 || t.provisioned === 1) ? t.provisioned
                        : (typeof t.provisioned === "boolean" ? (t.provisioned ? 1 : 0) : null);
      const syncValid = (t.sync_valid === 0 || t.sync_valid === 1) ? t.sync_valid
                      : (typeof t.sync_valid === "boolean" ? (t.sync_valid ? 1 : 0) : null);
      const skewValid = (t.skew_valid === 0 || t.skew_valid === 1) ? t.skew_valid
                      : (typeof t.skew_valid === "boolean" ? (t.skew_valid ? 1 : 0) : null);
      const clockSource = ["xtal", "rc"].includes(t.clock_source) ? t.clock_source : null;
      const syncAgeMs = Number.isFinite(t.sync_age_ms) ? Math.max(0, Math.trunc(t.sync_age_ms)) : null;
      const captureOverflow = Number.isFinite(t.capture_overflow) ? Math.max(0, Math.trunc(t.capture_overflow)) : null;
      const eventDrop = Number.isFinite(t.event_drop) ? Math.max(0, Math.trunc(t.event_drop)) : null;
      const queueDepth = Number.isFinite(t.queue_depth) ? Math.max(0, Math.trunc(t.queue_depth)) : null;
      const queueOverflow = Number.isFinite(t.queue_overflow) ? Math.max(0, Math.trunc(t.queue_overflow)) : null;
      const usbRefValid = (t.usb_ref_valid === 0 || t.usb_ref_valid === 1) ? t.usb_ref_valid
                        : (typeof t.usb_ref_valid === "boolean" ? (t.usb_ref_valid ? 1 : 0) : null);
      const usbRefPpm = Number.isFinite(t.usb_ref_ppm) ? Math.trunc(t.usb_ref_ppm) : null;
      const prev = stagedTelemetry.get(node) || liveTelemetry.get(node) || {};
      // "수신"은 마스터가 그 센서를 마지막으로 들은 시각이어야 한다. 펌웨어가 진단 라인으로
      // 보내는 last_seen_ms(들은 뒤 경과 ms)를 절대시각으로 환산 — 이렇게 해야 끊김/지연을
      // 보고하는 줄이 도착해도 "수신"이 방금으로 리셋되지 않는다. 누락 시 ingest 시각으로 폴백.
      const heardAgeMs = Number.isFinite(t.last_seen_ms) && t.last_seen_ms >= 0 ? Math.trunc(t.last_seen_ms) : null;
      const lastSeenIso = heardAgeMs === null ? nowIso : new Date(now - heardAgeMs).toISOString();
      // rx_miss/beacon_gap/sec_drop/provisioned는 실시간(SSE)으로만 — 스냅샷 테이블 스키마는 그대로.
      // 보안 이벤트 수집(인증거부 증가분 + 미프로비저닝 전이). 카운터는 보드 재부팅 시 0 리셋이라
      // 증가(secDrop>prev)일 때만 로깅 → 재부팅 후 리셋이 거짓 알림을 내지 않음.
      // baseline(prev.sec_drop)이 실재할 때만 증가를 경고한다. prev가 비었으면(첫 관측
      // 또는 liveTelemetry TTL prune 후 재등장) 없는 0 기준과 비교하지 않고 조용히
      // baseline만 세운다 — 재부팅 안 한 노드가 침묵 후 재등장할 때의 거짓 경고 방지.
      const prevHadDrop = Number.isFinite(prev.sec_drop);
      if (secDrop !== null && prevHadDrop && secDrop > prev.sec_drop) {
        secLog.push({ node, sec_drop: secDrop, delta: secDrop - prev.sec_drop });
      }
      let provWarned = prev._provWarned || false;
      if (provisioned === 0 && !provWarned) { secLog.push({ node, unprovisioned: true }); provWarned = true; }
      else if (provisioned === 1) { provWarned = false; }
      const health = {
        sensor_boot_id: validBootId(t.sensor_boot_id) ? t.sensor_boot_id : null,
        master_boot_id: validBootId(t.master_boot_id) ? t.master_boot_id : null,
        sync_valid: syncValid,
        skew_valid: skewValid,
        clock_source: clockSource,
        sync_age_ms: syncAgeMs,
        capture_overflow: captureOverflow,
        event_drop: eventDrop,
        queue_depth: queueDepth,
        queue_overflow: queueOverflow,
        usb_ref_valid: usbRefValid,
        usb_ref_ppm: usbRefPpm,
      };
      const entry = { rssi, snr, offset_us: offset, skew_ppm: skew, latency_ms: lat, rx_miss: rxMiss, beacon_gap: gap, temp_c10: tempC10, batt_mv: battMv, sec_drop: secDrop, provisioned, ...health, link_state: link, last_seen: lastSeenIso, _provWarned: provWarned };
      stagedTelemetry.set(node, entry);
      tOut.push({ node_id: node, rssi, snr, offset_us: offset, skew_ppm: skew, latency_ms: lat, rx_miss: rxMiss, beacon_gap: gap, temp_c10: tempC10, batt_mv: battMv, sec_drop: secDrop, provisioned, ...health, link_state: link, last_seen: lastSeenIso });
    }
    timingContext.bridge = bridge;
    timingContext.telemetry = stagedTelemetry;
    if (tOut.length) broadcastEvent("wireless:telemetry", { telemetry: tOut });
    enforceArmedWirelessQuality(req);
    if (inserted.length) {
      broadcastEvent("wireless:event", { events: inserted });
      processRecordEngine(inserted);
    }
    const masterBoot = stagedTelemetry.get("0")?.master_boot_id;
    if (masterBoot != null) {
      for (const session of getSessions()) {
        const run = getRun(session.event_type);
        if (session.armed && run && !run.closed && run.masterBootId !== masterBoot) {
          invalidateRun(session.event_type, run, [{ node_id: "0", reason: "마스터가 계측 중 재부팅되었습니다." }], { awaitEvidence: true });
          broadcastEvent("wireless:session", getSession(session.event_type));
        }
      }
    }
    return {
      bridge,
      inserted,
      acknowledged,
      deduped,
      rejected,
      reasons,
      telemetry: tOut,
      telemetryState: [...stagedTelemetry],
      security: secLog,
    };
  });

  if (!result.success) {
    const error = result.internalError || result.error;
    logger.warn(req, "wireless.ingest", {
      error,
      reason: error,
      operation: "ingest",
      phase: "database_mutation",
      requested_bridge_online: true,
      counts: { events: events.length, telemetry: telemetry.length },
    }, "bridge");
    return res.status(result.status).send(result.error);
  }

  const transitioned = result.result.bridge.transitioned;
  if (transitioned) {
    logger.log(req, "wireless.bridge", { online: true, last_seen: lastBridgeSeenIso }, "bridge");
  }
  // 부분 거부는 데이터 손실 가능성이라 반드시 로깅(어떤 사유로 몇 건이 버려졌는지).
  if (result.result.rejected > 0) {
    logger.warn(req, "wireless.ingest", { rejected: result.result.rejected, reasons: result.result.reasons, counts: { events: events.length, telemetry: telemetry.length } });
  }
  const insertedIds = result.result.inserted.map((event) => Number(event.id));
  logger.log(req, "wireless.ingest", {
    counts: {
      events: events.length,
      telemetry: telemetry.length,
      stored: insertedIds.length,
      deduped: result.result.deduped,
      rejected: result.result.rejected,
    },
    event_id_range: insertedIds.length > 0
      ? { first: Math.min(...insertedIds), last: Math.max(...insertedIds) }
      : null,
    source_nodes: [...new Set([...events, ...telemetry].map((item) => String(item?.node_id)))].sort(),
  }, "bridge");
  // 보안 관측: 인증거부(위조/키불일치/replay 등) 증가 또는 미프로비저닝을 /api/logs로 가시화.
  // node 0 = 마스터의 AEAD 검증 실패(귀속 불가), node 1..6 = 그 센서의 인증후 거부.
  for (const s of (result.result.security || [])) {
    logger.warn(req, "wireless.security",
      s.unprovisioned ? { node: s.node, unprovisioned: true }
                      : { node: s.node, sec_drop: s.sec_drop, delta: s.delta },
      `node ${s.node}`);
  }
  res.json({
    stored: result.result.inserted.filter(event => !(event.flags & CAPTURE_CHECKPOINT)).length,
    deduped: result.result.deduped,
    rejected: result.result.rejected,
    acknowledged: result.result.acknowledged,
  });
});

// POST /api/wireless/bridge/offline - 브리지(콘솔)가 연결 해제 시 즉시 오프라인 보고.
// 이게 없으면 15s 워치독이 풀어줄 때까지 bridge.online이 남아 "마스터 연결" 버튼이
// 비활성으로 묶인다(새로고침해도 동일). lastBridgeSeen=0으로 둬서 실제 브리지가 아직
// 살아있으면 다음 ingest가 바로 다시 online으로 돌린다(오인 시 self-heal).
app.post("/api/wireless/bridge/offline", (req, res) => {
  if (bridgeOnline) {
    const result = dbRun(() => db.prepare("UPDATE wireless_light SET bridge_online = 0 WHERE id = 1").run());
    if (!result.success) {
      const error = result.internalError || result.error;
      logger.warn(req, "wireless.bridge", {
        error,
        reason: error,
        operation: "offline",
        phase: "bridge_transition",
        requested_online: false,
      }, "bridge");
      return res.status(500).send("브리지 상태를 저장할 수 없습니다.");
    }
    bridgeOnline = false;
    lastBridgeSeen = 0;
    broadcastEvent("wireless:bridge", getBridgeState());
    logger.log(req, "wireless.bridge", { online: false, last_seen: lastBridgeSeenIso }, "bridge");
    const quality = timingTransaction(() => enforceArmedWirelessQuality(req));
    if (!quality.success) return res.status(quality.status).send(quality.error);
  }
  res.json(getBridgeState());
});

// PUT /api/wireless/debounce - 센서 디바운스 창(ms) 설정. 무선 공용 설정이라 wireless_light에
// 저장하고 wireless:light로 브로드캐스트(모든 화면 공유). 0이면 디바운스 끔.
app.put("/api/wireless/debounce", (req, res) => {
  const ms = req.body?.ms;
  if (!Number.isInteger(ms) || ms < 0 || ms > 5000) {
    return res.status(400).send("올바르지 않은 디바운스 값입니다(0~5000ms 정수).");
  }
  const result = dbRun(() => {
    db.prepare("UPDATE wireless_light SET debounce_ms = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1").run(ms);
    return getLightState();
  });
  if (!result.success) {
    logger.warn(req, "wireless.debounce", { error: result.internalError || result.error, ms }, "settings");
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.debounce", { ms }, "settings");
  broadcastEvent("wireless:light", result.result);
  res.json(result.result);
});

// Wireless timing control. The master only supplies captures and clock responses.
app.post("/api/wireless/arm", async (req, res) => {
  const { event_type, action } = req.body || {};
  if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.arm", status: 400, message: "올바르지 않은 종목입니다.",
      target: typeof event_type === "string" ? event_type : "wireless",
      operation: action ?? "arm", context: { event_type: event_type ?? null },
    });
  }
  if (!["start", "stop", "reset"].includes(action)) {
    return rejectMutation(req, res, {
      action: "wireless.arm", status: 400, message: "올바르지 않은 동작입니다.",
      target: event_type, operation: action ?? "arm", context: { event_type },
    });
  }
  // A안: 해당 경기를 점유한 controller만 제어. 점유자 없으면 허용(첫 제어).
  const sessionPreflight = runMutationPreflight(req, res, {
    action: "wireless.arm", operation: action, target: event_type,
    context: { event_type },
    lookup: () => ({ session: getSession(event_type) }),
    failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
  });
  if (!sessionPreflight.ok) return;
  const sess = sessionPreflight.value.session;
  const actor = wirelessActor(req);
  if (sess?.controller && sess.controller !== actor) {
    const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
    return rejectMutation(req, res, {
      action: "wireless.arm", status: 409, message, target: event_type, operation: action,
      context: { event_type, controller: controllerEmail(sess.controller), requested_actor: actor },
    });
  }
  if (action === "start" && sess?.armed) {
    return rejectMutation(req, res, {
      action: "wireless.arm", status: 409,
      message: "진행 중인 경기를 정지하거나 초기화한 뒤 다시 시작하세요.",
      target: event_type, operation: action,
      context: { event_type, run_id: sess.run_id, armed: true },
    });
  }
  let start_tick = null;
  if (action === "start") {
    start_tick = tickToText(req.body?.start_tick);
    if (start_tick === undefined) {
      return rejectMutation(req, res, {
        action: "wireless.arm", status: 400, message: "start_tick이 올바르지 않습니다.",
        target: event_type, operation: action, context: { event_type, start_tick: req.body?.start_tick ?? null },
      });
    }
  }
  // START 본문의 선택 또는 현재 세션의 선택을 런에 고정한다.
  const body = req.body || {};
  const hasSel = action === "start" && ("team" in body || "event_name" in body);
  let bound = null;
  if (hasSel) {
    const v = validateSelectionRequest(req, res, "wireless.arm", event_type, body);
    if (!v) return;
    if (!v.valid) {
      return rejectMutation(req, res, {
        action: "wireless.arm", status: v.status || 400, message: v.error,
        target: event_type, operation: action,
        context: { event_type, requested_team: body.team ?? null, requested_event_name: body.event_name ?? null },
      });
    }
    bound = { team: v.team, event_name: v.event_name };
  }
  let clock = null;
  let clockEventCursor = null;
  if (action === "start") {
    if (rejectWirelessQuality(req, res, "wireless.arm", event_type)) return;
    bound ||= { team: sess.team, event_name: sess.event_name };
    clockEventCursor = getLastEventId();
    const request = {};
    pendingArmRequests.set(event_type, request);
    try {
      clock = await readWirelessClock({ event_type, start_tick });
      if (pendingArmRequests.get(event_type) !== request) {
        throw new Error("시각 확인 중 경기 제어 요청이 변경되었습니다. 다시 시작하세요.");
      }
      if (tickToText(clock?.master_tick) == null || !validBootId(clock?.master_boot_id)) {
        throw new Error("마스터 시각 응답이 올바르지 않습니다.");
      }
    } catch (error) {
      return rejectMutation(req, res, {
        action: "wireless.arm", status: 409, message: error.message,
        target: event_type, operation: action, context: { event_type, quality_reasons: request.qualityFailure },
      });
    } finally {
      if (pendingArmRequests.get(event_type) === request) pendingArmRequests.delete(event_type);
    }
    const current = getSession(event_type);
    if (current.armed || current.run_id !== sess.run_id
      || (current.controller && current.controller !== actor)) {
      return rejectMutation(req, res, {
        action: "wireless.arm", status: 409, message: "시각 확인 중 경기 상태가 변경되었습니다. 다시 시작하세요.",
        target: event_type, operation: action, context: { event_type },
      });
    }
    if (rejectWirelessQuality(req, res, "wireless.arm", event_type)) return;
    start_tick = clock.master_tick;
  }
  const runId = action === "start" ? crypto.randomUUID() : null;
  const result = timingTransaction(() => {
    if (action === "start") {
      db.prepare("UPDATE wireless_session SET armed = 1, team_json = ?, event_name = ?, armed_at = ?, run_id = ?, saved_record_name = NULL, saved_record_rowid = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
        .run(bound.team ? JSON.stringify(bound.team) : null, bound.event_name, new Date().toISOString(), runId, event_type);
    } else if (action === "reset") {
      db.prepare("UPDATE wireless_session SET armed = 0, run_id = NULL, saved_record_name = NULL, saved_record_rowid = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
        .run(event_type);
    } else {
      db.prepare("UPDATE wireless_session SET armed = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?").run(event_type);
      const run = getRun(event_type);
      if (run) run.closed = true;
    }
    if (action === "start") {
      resetEngineRun(event_type, bound, runId, clock);
      clearWirelessQualityFault(event_type);
      // A bridge may ingest an edge after the hardware capture but before its
      // clock HTTP response. Apply that committed edge to this new run once.
      const duringClock = db.prepare("SELECT * FROM wireless_event WHERE id > ? ORDER BY id").all(clockEventCursor);
      processRecordEngine(duringClock, event_type);
    } else if (action === "reset") setRun(event_type, null);
    return getSession(event_type);
  });
  if (!result.success) {
    logger.warn(req, "wireless.arm", { error: result.internalError || result.error, event_type, action }, event_type);
    return res.status(result.status).send(result.error);
  }
  pendingArmRequests.delete(event_type);
  logger.log(req, "wireless.arm", { action, start_tick, before: sess, after: result.result }, event_type);
  broadcastEvent("wireless:session", result.result);
  res.json(result.result);
});

// POST /api/wireless/select - 경기의 선택(팀·이벤트명)을 세션에 공유. 전 클라가 동일하게 본다.
// 서버 권위 기록 엔진이 이 값으로 기록을 귀속(bind-at-arm은 arm 시 점등 스냅샷, 여기선 라이브 공유).
// body: { event_type, team?: {num,univ,team}|null, event_name?: string|null }
app.post("/api/wireless/select", (req, res) => {
  const { event_type } = req.body || {};
  if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.select", status: 400, message: "올바르지 않은 종목입니다.",
      target: typeof event_type === "string" ? event_type : "wireless", operation: "select",
      context: { event_type: event_type ?? null, requested_team: req.body?.team ?? null },
    });
  }
  const sessionPreflight = runMutationPreflight(req, res, {
    action: "wireless.select", operation: "select", target: event_type,
    context: { event_type }, lookup: () => getSession(event_type),
    failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
  });
  if (!sessionPreflight.ok) return;
  const sess = sessionPreflight.value;
  const actor = wirelessActor(req);
  if (sess?.controller && sess.controller !== actor) {
    const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
    return rejectMutation(req, res, {
      action: "wireless.select", status: 409, message, target: event_type, operation: "select",
      context: { event_type, controller: controllerEmail(sess.controller), requested_actor: actor, requested_team: req.body?.team ?? null },
    });
  }
  // 선택 시점 검증(유선 POST /api/records와 동일 기준) — 잘못된 팀/이름은 여기서 400 → 즉시 토스트.
  // null은 선택 해제로 허용. (arm green의 bind-at-arm과 동일 검증을 공유.)
  const v = validateSelectionRequest(req, res, "wireless.select", event_type);
  if (!v) return;
  if (!v.valid) {
    return rejectMutation(req, res, {
      action: "wireless.select", status: v.status || 400, message: v.error,
      target: event_type, operation: "select",
      context: { event_type, requested_team: req.body?.team ?? null, requested_event_name: req.body?.event_name ?? null },
    });
  }
  const team = v.team != null ? JSON.stringify(v.team) : null;
  const event_name = v.event_name;
  const selectionChanged = (sess?.event_name ?? null) !== event_name
    || Number(sess?.team?.teamId ?? sess?.team?.id ?? 0) !== Number(v.team?.teamId ?? v.team?.id ?? 0)
    || Number(sess?.team?.num ?? 0) !== Number(v.team?.num ?? 0);
  const result = dbRun(() => {
    if (selectionChanged && !sess?.armed) {
      db.prepare(`
        UPDATE wireless_session
        SET team_json = ?, event_name = ?, run_id = NULL, engine_state = NULL,
            saved_record_name = NULL, saved_record_rowid = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE event_type = ?
      `).run(team, event_name, event_type);
    } else {
      db.prepare("UPDATE wireless_session SET team_json = ?, event_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
        .run(team, event_name, event_type);
    }
    return getSession(event_type);
  });
  if (!result.success) {
    logger.warn(req, "wireless.select", { error: result.internalError || result.error, event_type }, event_type);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.select", {
    event_type,
    before: { team: sess?.team ?? null, event_name: sess?.event_name ?? null },
    after: { team: result.result?.team ?? null, event_name: result.result?.event_name ?? null },
  }, event_type);
  broadcastEvent("wireless:session", result.result);
  res.json(result.result);
});

// POST /api/wireless/status - 현재 선택/런을 DNS·DNF·DSQ로 확정한다.
// arm 단계와 무관하게 허용하되, 저장된/부분 행이 있으면 같은 행을 갱신해 중복 시도를 만들지 않는다.
app.post("/api/wireless/status", (req, res) => {
  const { event_type, status } = req.body || {};
  if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.status", status: 400, message: "올바르지 않은 종목입니다.",
      target: typeof event_type === "string" ? event_type : "wireless", operation: "classify",
      context: { event_type: event_type ?? null, requested_status: status ?? null },
    });
  }
  if (!RESULT_STATUSES.includes(status)) {
    return rejectMutation(req, res, {
      action: "wireless.status", status: 400, message: "판정은 DNS, DNF, DSQ 중 하나여야 합니다.",
      target: typeof event_type === "string" ? event_type : "wireless", operation: "classify",
      context: { event_type: event_type ?? null, requested_status: status ?? null },
    });
  }
  const sessionPreflight = runMutationPreflight(req, res, {
    action: "wireless.status", operation: "classify", target: event_type,
    context: { event_type, requested_status: status }, lookup: () => getSession(event_type),
    failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
  });
  if (!sessionPreflight.ok) return;
  const sess = sessionPreflight.value;
  const actor = wirelessActor(req);
  if (sess?.controller && sess.controller !== actor) {
    const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
    return rejectMutation(req, res, {
      action: "wireless.status", status: 409, message, target: event_type, operation: "classify",
      context: { event_type, controller: controllerEmail(sess.controller), requested_actor: actor, team: sess.team ?? null, requested_status: status },
    });
  }
  if (!sess?.event_name || !sess?.team) {
    return rejectMutation(req, res, {
      action: "wireless.status", status: 400, message: "이벤트 이름과 팀을 먼저 선택하세요.",
      target: event_type, operation: "classify", context: { event_type, team: sess?.team ?? null, event_name: sess?.event_name ?? null, requested_status: status },
    });
  }
  const result = timingTransaction(() => {
    let run = getRun(event_type);
    const changed = run && !sess.armed && (
      run.bound?.event_name !== sess.event_name
      || Number(run.bound?.team?.teamId ?? run.bound?.team?.id ?? run.bound?.team?.num)
        !== Number(sess.team?.teamId ?? sess.team?.id ?? sess.team?.num));
    if (changed) run = null;
    if (!run) {
      const runId = crypto.randomUUID();
      db.prepare("UPDATE wireless_session SET run_id = ?, saved_record_name = NULL, saved_record_rowid = NULL WHERE event_type = ?")
        .run(runId, event_type);
      resetEngineRun(event_type, { team: sess.team, event_name: sess.event_name }, runId);
      run = getRun(event_type);
    }
    const name = run.recordName ?? (changed ? null : sess.saved_record_name);
    const rowid = run.recordRowid ?? (changed ? null : sess.saved_record_rowid);
    const before = name && rowid != null ? getRecordRow(name, rowid) : null;
    let saved;
    if (before) {
      const year = recordYearFromName(name);
      if (year !== currentRecordYear() || !isTeamActive(db, year, before.num)) {
        const error = new Error("현재 연도의 활성 팀 기록만 판정할 수 있습니다.");
        error.status = 409;
        throw error;
      }
      db.prepare("UPDATE record SET status = ? WHERE name = ? AND legacy_rowid = ?").run(status, name, rowid);
      saved = { name, record: getRecordRow(name, rowid) };
      broadcastEvent("records", { type: "update", name, field: "status", recordFiles: getRecordFiles(), record: saved.record, event_type, run_id: run.runId });
    } else {
      saved = engineSaveRecord(event_type, run.bound, null, null, { req }, status);
      if (!saved) throw new Error("판정 저장에 필요한 선택 정보가 없습니다.");
    }
    run.recordName = saved.name;
    run.recordRowid = saved.record.rowid;
    run.closed = true;
    db.prepare("UPDATE wireless_session SET saved_record_name = ?, saved_record_rowid = ? WHERE event_type = ?")
      .run(saved.name, saved.record.rowid, event_type);
    logger.log(req, "wireless.status", { event_type, status, run_id: run.runId, before, after: saved.record }, saved.name);
    return { ...saved, session: getSession(event_type) };
  });
  if (!result.success) {
    logger.warn(req, "wireless.status", { error: result.internalError || result.error, event_type, status }, event_type);
    return res.status(result.status).send(result.error);
  }
  broadcastEvent("wireless:session", result.result.session);
  res.json(result.result);
});

// POST /api/wireless/lease/:event - 경기 독점 제어 lease 획득/갱신(heartbeat). A안.
app.post("/api/wireless/lease/:event", (req, res) => {
  const event_type = decodeURIComponent(req.params.event);
  if (!EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.lease", status: 400, message: "올바르지 않은 종목입니다.",
      target: event_type || "wireless", operation: "claim", context: { event_type },
    });
  }
  const actor = wirelessActor(req);
  if (!actor) {
    return rejectMutation(req, res, {
      action: "wireless.lease", status: 401, message: "인증이 필요합니다.",
      target: event_type, operation: "claim", context: { event_type },
    });
  }
  const sessionPreflight = runMutationPreflight(req, res, {
    action: "wireless.lease", operation: "claim", target: event_type,
    context: { event_type }, lookup: () => getSession(event_type),
    failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
  });
  if (!sessionPreflight.ok) return;
  const sess = sessionPreflight.value;
  if (sess?.controller && sess.controller !== actor) {
    const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
    return rejectMutation(req, res, {
      action: "wireless.lease", status: 409, message, target: event_type, operation: "claim",
      context: { event_type, controller: controllerEmail(sess.controller), requested_actor: actor },
    });
  }
  // heartbeat(이미 내가 점유) vs 신규 점유 구분: heartbeat는 만료만 연장하고 broadcast 생략
  // (12초마다 전 클라에 불필요 fan-out 방지). 점유자 변화가 있을 때만 broadcast.
  const isHeartbeat = sess?.controller === actor;
  const expires = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const result = dbRun(() => {
    db.prepare("UPDATE wireless_session SET controller = ?, lease_expires_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?").run(actor, expires, event_type);
    return getSession(event_type);
  });
  if (!result.success) {
    logger.warn(req, "wireless.lease", { error: result.internalError || result.error, operation: isHeartbeat ? "heartbeat" : "claim", event_type }, event_type);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.lease", {
    operation: isHeartbeat ? "heartbeat" : "claim",
    before: { controller: sess?.controller ?? null, lease_expires_at: sess?.lease_expires_at ?? null },
    after: { controller: result.result?.controller ?? null, lease_expires_at: result.result?.lease_expires_at ?? null },
  }, event_type);
  if (!isHeartbeat) broadcastEvent("wireless:session", result.result);
  res.json(result.result);
});

// DELETE /api/wireless/lease/:event - lease 해제(보유자 또는 계측 관리 권한의 강제 회수).
app.delete("/api/wireless/lease/:event", (req, res) => {
  const event_type = decodeURIComponent(req.params.event);
  if (!EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.lease", status: 400, message: "올바르지 않은 종목입니다.",
      target: event_type || "wireless", operation: "release", context: { event_type },
    });
  }
  // release/takeover는 email 기준: 같은 계정은 자기 다른 세션(멈춘 탭 등)을 회수 가능,
  // 타 계정 회수는 traffic.manage(설정·전체 삭제와 같은 관리 권한)만. admin은 이를 포함한다.
  // (claim/제어는 세션 단위라 다른 세션이면 명시적 가로채기 필요.)
  const sessionPreflight = runMutationPreflight(req, res, {
    action: "wireless.lease", operation: "release", target: event_type,
    context: { event_type }, lookup: () => getSession(event_type),
    failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
  });
  if (!sessionPreflight.ok) return;
  const sess = sessionPreflight.value;
  if (sess?.controller && controllerEmail(sess.controller) !== (req.user?.email || null)
    && !principalHasPermission(req.user, "traffic.manage")) {
    return rejectMutation(req, res, {
      action: "wireless.lease", status: 409, message: "다른 사용자의 제어를 해제할 수 없습니다.",
      target: event_type, operation: "release",
      context: { event_type, controller: controllerEmail(sess.controller), requested_actor: req.user?.email ?? null },
    });
  }
  const result = dbRun(() => {
    db.prepare("UPDATE wireless_session SET controller = NULL, lease_expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?").run(event_type);
    return getSession(event_type);
  });
  if (!result.success) {
    logger.warn(req, "wireless.lease", { error: result.internalError || result.error, operation: "release", event_type }, event_type);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.lease", {
    operation: "release",
    before: { controller: sess?.controller ?? null, lease_expires_at: sess?.lease_expires_at ?? null },
    after: { controller: null, lease_expires_at: null },
  }, event_type);
  broadcastEvent("wireless:session", result.result);
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
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(node_id) DO UPDATE SET event_type=excluded.event_type, role=excluded.role, label=excluded.label, enabled=excluded.enabled, updated_at=excluded.updated_at`).run(node, event_type, role, label, enabled);
    return { row: db.prepare("SELECT node_id, event_type, role, label, enabled, updated_at FROM wireless_mapping WHERE node_id = ?").get(node), prev };
  });
  if (!result.success) {
    logger.warn(req, "wireless.mapping", { error: result.internalError || result.error, event_type, role }, node);
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
    logger.warn(req, "wireless.mapping.delete", { error: result.internalError || result.error }, node);
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
    sessions: getSessions(),
    qualityFaults: getLiveQualityFaults(),
    lastEventId: getLastEventId(),
  }));
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// GET /api/wireless/events?since=&limit= - 늦게 합류한 클라이언트의 이벤트 백필.
app.get("/api/wireless/events", (req, res) => {
  const since = Number.parseInt(req.query.since, 10);
  const sinceId = Number.isFinite(since) ? since : 0;
  let limit = Number.parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit)) limit = 200;
  limit = Math.max(1, Math.min(limit, 1000));
  const result = dbRun(() =>
    db.prepare("SELECT * FROM wireless_event WHERE id > ? ORDER BY id ASC LIMIT ?").all(sinceId, limit),
  );
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

/* ============================================
   SPA Fallback
   ============================================ */
if (!options.skipSpaFallback) addSpaFallback(app);

return {
  app,
  db,
  closeSse,
  sourceEvent: broadcastSSEEvent,
  timers: [bridgeWatch, leaseWatch, eventRetention, telemetryRetention, liveAttemptWatch],
  queries: { yearRecordGroups: getYearRecordGroups, eventModes: getEventModes },
  runBridgeWatch,
  runLeaseWatch,
  runEventRetention,
  runLiveAttemptWatch,
};
}
