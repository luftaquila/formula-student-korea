import express from "express";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { runMigrationOnce, normalizeUtcTextTimestamp, normalizeTimestampColumn, setupRowCapRetention } from "../shared/db-setup.mjs";
import { createServiceSkeleton, addSpaFallback } from "../shared/service-bootstrap.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { EVENT_TYPES } from "../shared/constants.js";
import { ensureInactiveTeamView, isTeamActive } from "../shared/team-status.mjs";
import { formatEnduranceDetail, enduranceTotal } from "./lib/event-timing.mjs";
import { currentCompetitionYear } from "../shared/competition-year.mjs";

const CONTROLLER_MAX_ROWS = 100000;
const RETAIN_EVENTS = 500000;

export function createTrafficApp(options = {}) {


const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "traffic", express, Database, options,
  authRoleFn: (req) => {
    if (req.path === "/api/health" || req.path === "/api/time") return null;
    return "admin";
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

db.exec(`CREATE TABLE IF NOT EXISTS record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  legacy_rowid INTEGER NOT NULL,
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
{
  const cols = db.prepare("PRAGMA table_info(record)").all().map((c) => c.name);
  if (!cols.includes("legacy_rowid")) {
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
// 멱등 dedup 키. ev_seq는 2바이트(DESIGN §9)라 65536에서 wrap하고 노드 재부팅 시 0부터
// 재시작하므로 (node_id, ev_seq)만으로는 재사용된 seq의 새 이벤트가 옛 행과 충돌해 조용히
// 버려졌다. master_tick(ev_master_t)은 재전송에도 보존되고 이벤트마다 고유(DESIGN §9)이므로
// 키에 포함하면 재전송 멱등성은 유지하면서 재부팅/wrap 충돌은 사라진다.
// 기존 2-컬럼 인덱스가 있으면 마이그레이션(컬럼이 다를 때만 재생성).
{
  const cols = db.prepare("SELECT name FROM pragma_index_info('idx_wevent_dedupe')").all().map((r) => r.name);
  if (cols.length && !cols.includes("master_tick")) {
    db.exec("DROP INDEX IF EXISTS idx_wevent_dedupe");
  }
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wevent_dedupe ON wireless_event(node_id, ev_seq, master_tick)");

function pruneWirelessEvents() {
  const row = db.prepare("SELECT MAX(id) AS m FROM wireless_event").get();
  if (row && row.m > RETAIN_EVENTS) {
    const cutoff = row.m - RETAIN_EVENTS;
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
    db.prepare(`
      INSERT OR IGNORE INTO record (name, legacy_rowid, time, num, univ, team, type, result, detail, cones, oc, invalidated, scoreboard)
      SELECT ?, rowid, time, num, univ, team, type, result, ${detailExpr},
             COALESCE(cones, 0), COALESCE(oc, 0), COALESCE(invalidated, 0), COALESCE(scoreboard, 1)
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
const { broadcast: broadcastSSEEvent, handler: sseHandler, close: closeSse } = createSSEManager();

function broadcastEvent(event, data) {
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
    SELECT legacy_rowid AS rowid, time, num, univ, team, type, result, detail, cones, oc, invalidated, scoreboard
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
           r.result, r.detail, r.cones, r.oc, r.invalidated, r.scoreboard
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
    SELECT legacy_rowid AS rowid, time, num, univ, team, type, result, detail, cones, oc, invalidated, scoreboard
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
    INSERT INTO record (name, legacy_rowid, time, num, univ, team, type, result, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, nextRowid, data.time, entry.num, entry.univ, entry.team, data.type, data.result, data.detail ?? null);
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
// node별 최신 진단(실시간, 미영속). _lastPersist는 throttle 저장용 내부 필드.
const liveTelemetry = new Map();
let bridgeOnline = false;
let lastBridgeSeen = 0;
let lastBridgeSeenIso = null;

function getLightState() {
  return db.prepare("SELECT owner_event, owner_actor, light_color, green_tick, bridge_online, debounce_ms, updated_at FROM wireless_light WHERE id = 1").get();
}
function getMapping() {
  return db.prepare("SELECT node_id, event_type, role, label, enabled, updated_at FROM wireless_mapping ORDER BY event_type, role").all();
}
function getLiveTelemetry() {
  const out = [];
  for (const [node_id, t] of liveTelemetry) {
    out.push({ node_id, rssi: t.rssi, snr: t.snr, offset_us: t.offset_us, skew_ppm: t.skew_ppm, latency_ms: t.latency_ms, rx_miss: t.rx_miss, beacon_gap: t.beacon_gap, temp_c10: t.temp_c10, batt_mv: t.batt_mv, link_state: t.link_state, last_seen: t.last_seen });
  }
  return out;
}
function getBridgeState() {
  return { online: bridgeOnline, last_seen: lastBridgeSeenIso };
}

// 경기별 세션(arm + lease + bind-at-arm). 만료된 lease는 controller=null로 표기.
const LEASE_TTL_MS = 30000; // heartbeat로 갱신. 제어 탭이 죽으면 이 시간 후 자동 해제.
function getSessions() {
  const now = Date.now();
  return db
    .prepare("SELECT event_type, armed, light_color, green_tick, armed_at, run_id, saved_record_name, saved_record_rowid, team_json, event_name, controller, lease_expires_at, updated_at FROM wireless_session ORDER BY event_type")
    .all()
    .map((r) => {
      const expired = r.lease_expires_at && Date.parse(r.lease_expires_at) <= now;
      let team = null;
      if (r.team_json) { try { team = JSON.parse(r.team_json); } catch { team = null; } }
      return {
        event_type: r.event_type,
        armed: !!r.armed,
        light_color: r.light_color,
        green_tick: r.green_tick,
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
 * 클라(StartFinishView/SkidpadView)의 onSensor 로직과 동일 의미: start/finish(accel·오토크로스),
 * skidpad lap2+lap4 합산. green=arm이라 t0는 출발 센서. 디바운스는 클라와 같은 tick 기준.
 * 세션에 team·event_name(선택 공유)이 있을 때만 persist — 없으면 표시만(클라가 라이브 계산).
 */
const WL_TICKS_PER_MS = 16000;
const tickToMsEngine = (t) => Math.round(Number(t || 0) / WL_TICKS_PER_MS);
function clockStr(ms) {
  if (ms < 0) ms = 0;
  const m = String(Math.floor(ms / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const ms3 = String(ms % 1000).padStart(3, "0");
  return `${m}:${s}.${ms3}`;
}
// 경기별 런 상태(메모리). arm(green)에서 리셋. 서버 재기동 중 진행 런은 유실(드문 엣지) — 멱등
// ingest라 재전송돼도 dedupe되어 중복 저장 없음.
const engineRun = new Map(); // event_type -> { debounce:{}, startTick, saved, lastTick, lapCount, lap2, bound }
// bound = arm 시점에 고정된 귀속 스냅샷 {team, event_name}|null. 가상 경기는 arm 본문으로
// atomic 바인딩되어 arm 후 세션 선택이 바뀌어도 기록은 arm 시점 팀에 귀속된다(bind-at-arm).
// null(물리 경기·서버 재기동 후 lazy 리셋)이면 저장 시 live 세션으로 폴백.
function resetEngineRun(eventType, bound = null, runId = null) {
  // laps/recordName/recordRowid: 내구는 랩을 기록 1건에 이어붙이므로 누적 랩과 그 기록 행을 추적.
  engineRun.set(eventType, { runId, debounce: {}, startTick: null, saved: false, lastTick: null, lapCount: 0, lap2: null, bound, laps: [], recordName: null, recordRowid: null });
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
// 동적 기록 테이블에 한 줄 저장 + records 브로드캐스트.
// binding = 귀속 정보 {team, event_name}: arm 스냅샷(run.bound) 또는 live 세션.
// 선택 정보(team·event_name) 자체가 없으면 = 테스트 모드 → 조용히 skip(경고 없음).
// 선택은 됐는데 검증 실패(잘못된 팀/이름) → warn 로그(유선의 POST /api/records와 동일 검증).
function engineSaveRecord(eventType, binding, result, detail, audit = null) {
  const SYS = { email: "system", name: "system", role: "admin" };
  const auditLog = (level, logDetail, target) => {
    if (audit?.req) logger[level](audit.req, "wireless.record", logDetail, target);
    else logger[level](null, "wireless.record", logDetail, target, SYS);
  };
  const t = binding?.team;
  if (!binding?.event_name || !t) return false; // 미선택 = 테스트 모드(조용히)
  const nv = validateRecordName(binding.event_name);
  if (!nv.valid) {
    auditLog("warn", { error: nv.error, event_name: binding.event_name }, "record");
    return false;
  }
  // 유선 저장과 동일 검증 재사용 — 무선이라고 약식 검증하지 않는다.
  const data = { time: new Date().toISOString(), type: eventType, entry: t, result, detail: detail ?? null };
  const dv = validateRecordData(data);
  if (!dv.valid) {
    auditLog("warn", { error: dv.error, event_type: eventType }, nv.value);
    return false;
  }
  const name = `FSK ${currentCompetitionYear()} ${nv.value}`;
  const run = engineRun.get(eventType);
  const r = dbRun(() => db.transaction(() => {
    const record = insertRecordRow(name, data);
    if (run?.runId) {
      db.prepare(`
        UPDATE wireless_session
        SET saved_record_name = ?, saved_record_rowid = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE event_type = ? AND run_id = ?
      `).run(name, record.rowid, eventType, run.runId);
    }
    return record;
  })());
  if (!r.success) {
    auditLog("warn", { error: r.internalError || r.error, event_type: eventType }, name);
    return false;
  }
  auditLog("log", { type: eventType, result, num: r.result.num }, name);
  if (run?.runId) broadcastEvent("wireless:session", getSession(eventType));
  broadcastEvent("records", { type: "add", name, recordFiles: getRecordFiles(), record: r.result, event_type: eventType, run_id: run?.runId ?? null });
  return true;
}
// 내구: 랩을 기록 1건에 이어붙인다. run.laps 전체로 result(총합)·detail(랩 목록)을 매 랩 갱신 —
// 첫 저장은 INSERT(rowid 보관), 이후는 같은 행 UPDATE. 귀속(team+event_name) 없으면 skip(테스트 모드).
function enduranceUpsertRecord(eventType, binding, run) {
  const SYS = { email: "system", name: "system", role: "admin" };
  const t = binding?.team;
  if (!binding?.event_name || !t) return; // 미선택 = 테스트 모드(표시만)
  const nv = validateRecordName(binding.event_name);
  if (!nv.valid) {
    logger.warn(null, "wireless.record", { error: nv.error, event_name: binding.event_name }, "record", SYS);
    return;
  }
  const total = enduranceTotal(run.laps);
  const detail = formatEnduranceDetail(run.laps);

  if (run.recordRowid == null) {
    // 첫 랩: 유선 저장과 동일 검증 후 INSERT, rowid/테이블명 보관.
    const name = `FSK ${currentCompetitionYear()} ${nv.value}`;
    const data = { time: new Date().toISOString(), type: eventType, entry: t, result: total, detail };
    const dv = validateRecordData(data);
    if (!dv.valid) {
      logger.warn(null, "wireless.record", { error: dv.error, event_type: eventType }, nv.value, SYS);
      return;
    }
    const r = dbRun(() => db.transaction(() => {
      const record = insertRecordRow(name, data);
      if (run.runId) {
        db.prepare(`
          UPDATE wireless_session
          SET saved_record_name = ?, saved_record_rowid = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE event_type = ? AND run_id = ?
        `).run(name, record.rowid, eventType, run.runId);
      }
      return record;
    })());
    if (!r.success) {
      logger.warn(null, "wireless.record", { error: r.error, event_type: eventType }, name, SYS);
      return;
    }
    run.recordName = name;
    run.recordRowid = r.result.rowid;
    logger.log(null, "wireless.record", { type: eventType, result: total, num: r.result.num, laps: run.laps.length }, name, SYS);
    if (run.runId) broadcastEvent("wireless:session", getSession(eventType));
    broadcastEvent("records", { type: "add", name, recordFiles: getRecordFiles(), record: r.result, event_type: eventType, run_id: run.runId ?? null });
  } else {
    // 이후 랩: 같은 행 UPDATE(총합·랩 목록).
    const r = dbRun(() => {
      const before = getRecordRow(run.recordName, run.recordRowid);
      if (!before) {
        const error = new Error("내구 기록을 찾을 수 없습니다.");
        error.status = 404;
        throw error;
      }
      const update = db.prepare("UPDATE record SET result = ?, detail = ? WHERE name = ? AND legacy_rowid = ?")
        .run(total, detail, run.recordName, run.recordRowid);
      if (update.changes !== 1) throw new Error("내구 기록 갱신 대상이 변경되었습니다.");
      return { before, after: getRecordRow(run.recordName, run.recordRowid) };
    });
    if (!r.success) {
      logger.warn(null, "wireless.record", {
        error: r.internalError || r.error,
        event_type: eventType,
        run_id: run.runId ?? null,
        rowid: run.recordRowid,
      }, run.recordName, SYS);
      return;
    }
    logger.log(null, "wireless.record", {
      type: eventType,
      run_id: run.runId ?? null,
      rowid: run.recordRowid,
      team_num: r.result.after.num,
      lap_count: run.laps.length,
      lap_detail: detail,
      before: { result: r.result.before.result, detail: r.result.before.detail },
      after: { result: r.result.after.result, detail: r.result.after.detail },
    }, run.recordName, SYS);
    broadcastEvent("records", { type: "update", name: run.recordName, field: "result", recordFiles: getRecordFiles(), record: r.result.after, event_type: eventType, run_id: run.runId ?? null });
  }
}
// 새로 삽입된 이벤트들을 라우팅해 기록 계산. (dedupe된 재전송은 inserted에 없으므로 재처리 안 됨.)
function processRecordEngine(rows) {
  if (!rows || !rows.length) return;
  const maps = getMapping();
  const windowMs = getDebounceMs();
  // 세션을 한 번만 읽어 맵으로(이전: 이벤트×매핑마다 getSession() 전체 스캔 + JSON.parse → 핫패스 낭비).
  const sessByType = new Map(getSessions().map((s) => [s.event_type, s]));
  for (const ev of rows) {
    const node = String(ev.node_id);
    const tickMs = tickToMsEngine(ev.master_tick);
    for (const m of maps) {
      if (m.node_id !== node || m.enabled === 0) continue;
      const et = m.event_type;
      const sess = sessByType.get(et);
      if (!sess || !sess.armed) continue;
      const sensor = m.role === "finish" ? 2 : 1;
      if (!engineRun.has(et)) resetEngineRun(et, null, sess.run_id);
      const run = engineRun.get(et);
      // 디바운스(tick 기준, 클라 acceptSensorTick과 동일): 한 통과의 다중 엣지 접기.
      const lastAcc = run.debounce[sensor];
      if (lastAcc != null && Math.abs(tickMs - lastAcc) < windowMs) continue;
      run.debounce[sensor] = tickMs;

      if (et === "스키드패드") {
        if (sensor !== 1) continue;
        if (run.lastTick == null) { run.lastTick = tickMs; continue; } // 첫 크로싱=출발선
        const lap = tickMs - run.lastTick;
        run.lastTick = tickMs;
        run.lapCount += 1;
        if (run.lapCount === 2) { run.lap2 = lap; continue; }
        if (run.lapCount === 4 && run.lap2 != null && !run.saved) {
          const total = run.lap2 + lap;
          // 음수/역순 가드: 재전송·재정렬로 lap2·lap4·합이 하나라도 음수면 저장하지 않는다.
          // 귀속은 arm 시점 스냅샷(run.bound) 우선, 없으면 live 세션 폴백(물리 경기 등).
          if (run.lap2 >= 0 && lap >= 0 && total >= 0 &&
              engineSaveRecord(et, run.bound || sess, total, `${clockStr(run.lap2)} / ${clockStr(lap)}`)) run.saved = true;
        }
      } else if (et === "내구") {
        // 단일 센서 멀티랩. 첫 통과=출발선(t0), 이후 통과마다 1랩을 기록 1건에 이어붙인다.
        if (sensor !== 1) continue;
        if (run.saved) continue; // DNF 등으로 확정된 런은 랩을 더 이어붙이지 않는다.
        if (run.lastTick == null) { run.lastTick = tickMs; continue; } // 첫 크로싱=출발선
        const lap = tickMs - run.lastTick;
        run.lastTick = tickMs;
        if (lap < 0) continue; // 음수/역순 가드(재전송·재정렬)
        run.laps.push(lap);
        run.lapCount += 1;
        // 귀속은 arm 시점 스냅샷(run.bound) 우선, 없으면 live 세션 폴백. 미선택이면 표시만(저장 skip).
        enduranceUpsertRecord(et, run.bound || sess, run);
      } else {
        // accel·오토크로스: 출발(1) 래치 → 도착(2) 기록.
        if (sensor === 1 && run.startTick == null) {
          run.startTick = tickMs;
        } else if (sensor === 2 && run.startTick != null && !run.saved) {
          const result = tickMs - run.startTick;
          // 음수/역순 가드: 도착이 출발보다 앞선 tick이면(재전송·재정렬) 저장하지 않는다.
          // 귀속은 arm 시점 스냅샷(run.bound) 우선, 없으면 live 세션 폴백(물리 경기 등).
          if (result >= 0 && engineSaveRecord(et, run.bound || sess, result, null)) run.saved = true;
        }
      }
    }
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
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) return v;
  return undefined;
}
const ALLOWED_ROLE = /^(start|finish|lane[1-9])$/;

// 브리지 오프라인 감지(15s 무수신). 백그라운드라 logger는 actorOverride 사용.
function runBridgeWatch() {
  if (bridgeOnline && Date.now() - lastBridgeSeen > 15000) {
    try {
      db.prepare("UPDATE wireless_light SET bridge_online = 0 WHERE id = 1").run();
      bridgeOnline = false;
      broadcastEvent("wireless:bridge", getBridgeState());
      logger.log(null, "wireless.bridge", { online: false, last_seen: lastBridgeSeenIso }, "bridge",
        { email: "system", name: "system", role: "admin" });
    } catch (e) {
      logger.warn(null, "wireless.bridge", { error: e.message || String(e), online: false }, "bridge", { email: "system", name: "system", role: "admin" });
      console.error("[wireless] bridge watch:", e.message || e);
    }
  }
  return { skipped: false };
}
const bridgeWatch = setInterval(runBridgeWatch, 5000);
bridgeWatch.unref?.();

// lease 만료 정리: 만료된 controller를 비우고 해당 경기 세션을 브로드캐스트(전 클라가 read-only 해제 인지).
function runLeaseWatch() {
  const SYS = { email: "system", name: "system", role: "admin" };
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
      }, before.event_type, SYS);
      broadcastEvent("wireless:session", getSession(before.event_type));
    }
    return { skipped: false, expired: expired.length };
  } catch (e) {
    logger.warn(null, "wireless.lease.watch", { error: e.message || String(e) }, "lease", { email: "system", name: "system", role: "admin" });
    console.error("[wireless] lease watch:", e.message || e);
  }
  return { skipped: false, expired: 0 };
}
const leaseWatch = setInterval(runLeaseWatch, 5000);
leaseWatch.unref?.();

// 무선 이벤트 보존 한도(약 50만 행). 백그라운드 트림.
function runEventRetention() {
  const SYS = { email: "system", name: "system", role: "admin" };
  try {
    const result = pruneWirelessEvents();
    if (result.removed > 0) {
      logger.log(null, "wireless.event.retention", {
        cutoff_id: result.cutoff,
        removed: result.removed,
        retained_limit: RETAIN_EVENTS,
      }, "wireless_event", SYS);
    }
    return { skipped: false, ...result };
  } catch (e) {
    logger.warn(null, "wireless.event.retention", { error: e.message || String(e) }, "wireless_event", { email: "system", name: "system", role: "admin" });
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
    sessions: getSessions(),
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
  // 유효 result는 양의 정수(ms 시간/누적 총합) 또는 -1(DNF)뿐. 0이 완주로 취급되면
  // 점수 계산에서 해당 종목 전 팀 점수가 평탄화되어 붕괴하므로 0·(-1 외 음수)를 거부.
  if (data.result !== -1 && data.result <= 0) {
    return { valid: false, error: "결과값은 양의 정수(ms) 또는 -1(DNF)이어야 합니다." };
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
    return res.status(400).send(nameValidation.error);
  }

  const dataValidation = validateRecordData(req.body.data);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const name = `FSK ${currentCompetitionYear()} ${nameValidation.value}`;
  const data = req.body.data;

  const result = dbRun(() => {
    return db.transaction(() => insertRecordRow(name, data))();
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

  // 생성된 테이블명 + 행(rowid 포함) 반환 — 내구처럼 같은 기록에 이어붙이는 클라가 PATCH에 쓸
  // 테이블명/rowid를 받는다. 기존 호출부는 본문을 무시하므로 하위호환.
  res.status(201).json({ name, record: result.result });
});

// PATCH /api/records/:name/:rowid - 기록 필드 업데이트
app.patch("/api/records/:name/:rowid", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
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
    return res.status(400).send("올바르지 않은 rowid입니다.");
  }
  const { field, value } = req.body;
  if (!["invalidated", "scoreboard", "detail", "cones", "oc", "result"].includes(field)) {
    return res.status(400).send("올바르지 않은 필드입니다.");
  }
  // result는 양의 정수(ms/누적 총합) 또는 -1(DNF)만. 0·(-1 외 음수)는 점수 붕괴 유발 → 거부.
  if (field === "result" && (!Number.isInteger(value) || (value !== -1 && value <= 0))) {
    return res.status(400).send("결과값은 양의 정수(ms) 또는 -1(DNF)이어야 합니다.");
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
        SELECT num, invalidated${hasTeamId ? ", team_id" : ""}
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
      if (field === "invalidated" && targetRecord.invalidated
        && !isRecordBoundToActiveTeam(recordYear, targetRecord)) {
        return {
          rejection: {
            status: 409,
            message: "팀 연결이 없는 레거시 기록은 다시 활성화할 수 없습니다.",
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

  const result = dbRun(() => {
    const row = db.prepare("SELECT num, invalidated, scoreboard, cones, oc FROM record WHERE name = ? AND legacy_rowid = ?").get(name, rowid);
    if (!row) {
      const err = new Error("기록을 찾을 수 없습니다.");
      err.status = 404;
      throw err;
    }

    if (field === "invalidated") {
      const newStatus = row.invalidated ? 0 : 1;
      if (newStatus === 1) {
        // 무효화 ON → 전광판도 자동 OFF
        db.prepare("UPDATE record SET invalidated = 1, scoreboard = 0 WHERE name = ? AND legacy_rowid = ?").run(name, rowid);
        return { num: row.num, invalidated: 1, scoreboard: 0 };
      } else {
        db.prepare("UPDATE record SET invalidated = 0, scoreboard = 1 WHERE name = ? AND legacy_rowid = ?").run(name, rowid);
        return { num: row.num, invalidated: 0, scoreboard: 1 };
      }
    } else if (field === "scoreboard") {
      const newStatus = row.scoreboard ? 0 : 1;
      // 무효화된 기록은 전광판에서 자동으로 내려가는데(invalidated ON 시 scoreboard=0),
      // scoreboard=0 상태를 토글하면 다시 1이 돼 무효 기록이 전광판에 재노출됐다. 차단.
      if (newStatus === 1 && row.invalidated) {
        const err = new Error("무효화된 기록은 전광판에 표시할 수 없습니다.");
        err.status = 400;
        throw err;
      }
      db.prepare("UPDATE record SET scoreboard = ? WHERE name = ? AND legacy_rowid = ?").run(newStatus, name, rowid);
      return { num: row.num, invalidated: row.invalidated, scoreboard: newStatus };
    } else if (field === "detail") {
      db.prepare("UPDATE record SET detail = ? WHERE name = ? AND legacy_rowid = ?").run(value ?? null, name, rowid);
      return { num: row.num, invalidated: row.invalidated, scoreboard: row.scoreboard, detail: value ?? null };
    } else if (field === "result") {
      db.prepare("UPDATE record SET result = ? WHERE name = ? AND legacy_rowid = ?").run(value, name, rowid);
      return { num: row.num, invalidated: row.invalidated, scoreboard: row.scoreboard, result: value };
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
    logger.warn(req, "record.update", { error: result.internalError || result.error }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.update", { entry_num: result.result.num, field, ...result.result }, name);

  // SSE 브로드캐스트 (업데이트된 전체 행 포함)
  try {
    const updatedRow = getRecordRow(name, rowid);
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

  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare("DELETE FROM record WHERE name = ?").run(name);
      const legacy = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? AND name NOT IN (${reservedSql})`).get(name);
      if (legacy) db.exec(`DROP TABLE IF EXISTS '${name}'`);
      db.prepare("DELETE FROM record_visibility WHERE name = ?").run(name);
    })();
  });

  if (!result.success) {
    logger.warn(req, "record.delete", { error: result.internalError || result.error }, name);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "record.delete", { dropped: true }, name);

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

// POST /api/wireless/ingest - 브리지가 모든 센서의 타이밍 이벤트 + 진단을 push.
// 성공은 로그하지 않음(텔레메트리 firehose); 실패·브리지 전환만 로그.
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

  const result = dbRun(() => db.transaction(() => {
    const bridge = stageBridgeSeen();
    const inserted = [];
    let deduped = 0;
    let rejected = 0;
    const reasons = {}; // 사유별 카운트(로깅용)
    const reject = (why) => { rejected++; reasons[why] = (reasons[why] || 0) + 1; };
    const ins = db.prepare("INSERT OR IGNORE INTO wireless_event (node_id, master_tick, ev_seq, rssi, snr, link_state) VALUES (?, ?, ?, ?, ?, ?)");
    const sel = db.prepare("SELECT id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state FROM wireless_event WHERE id = ?");
    // 불량 항목 하나가 배치 전체를 날리지 않도록 throw 대신 skip — 시리얼 라인 깨짐 등으로
    // 한 줄이 망가져도 같은 flush에 묶인 정상 이벤트는 저장·broadcast된다.
    for (const e of events) {
      if (!validateNodeId(String(e.node_id))) { reject("node_id"); continue; }
      const tick = tickToText(e.master_tick);
      // 타이밍 이벤트는 dedupe key 전체가 필수다. SQLite UNIQUE는 NULL을 서로 다른 값으로
      // 취급하므로 누락된 key를 저장하면 재전송 멱등성이 깨진다.
      if (tick === undefined || tick === null) { reject("master_tick"); continue; }
      if (!Number.isInteger(e.ev_seq)) { reject("ev_seq"); continue; }
      const evSeq = e.ev_seq;
      const rssi = typeof e.rssi === "number" ? e.rssi : null;
      const snr = typeof e.snr === "number" ? e.snr : null;
      const link = typeof e.link_state === "string" ? e.link_state : null;
      const info = ins.run(String(e.node_id), tick, evSeq, rssi, snr, link);
      if (info.changes > 0) { inserted.push(sel.get(Number(info.lastInsertRowid))); }
      else { deduped++; }
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
      const entry = { rssi, snr, offset_us: offset, skew_ppm: skew, latency_ms: lat, rx_miss: rxMiss, beacon_gap: gap, temp_c10: tempC10, batt_mv: battMv, sec_drop: secDrop, provisioned, link_state: link, last_seen: lastSeenIso, _provWarned: provWarned };
      stagedTelemetry.set(node, entry);
      tOut.push({ node_id: node, rssi, snr, offset_us: offset, skew_ppm: skew, latency_ms: lat, rx_miss: rxMiss, beacon_gap: gap, temp_c10: tempC10, batt_mv: battMv, sec_drop: secDrop, provisioned, link_state: link, last_seen: lastSeenIso });
    }
    return {
      bridge,
      inserted,
      deduped,
      rejected,
      reasons,
      telemetry: tOut,
      telemetryState: [...stagedTelemetry],
      security: secLog,
    };
  })());

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

  const transitioned = commitBridgeSeen(result.result.bridge);
  for (const [node, state] of result.result.telemetryState) liveTelemetry.set(node, state);
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
  if (result.result.inserted.length > 0) {
    broadcastEvent("wireless:event", { events: result.result.inserted });
    // 서버 권위 기록 엔진: 새 이벤트로 기록 계산·저장(세션에 선택 정보 있을 때만 persist).
    try { processRecordEngine(result.result.inserted); }
    catch (e) { logger.warn(req, "wireless.record.engine", { error: e.message || String(e) }, "engine"); }
  }
  if (result.result.telemetry.length > 0) {
    broadcastEvent("wireless:telemetry", { telemetry: result.result.telemetry });
  }
  res.json({ stored: result.result.inserted.length, deduped: result.result.deduped, rejected: result.result.rejected });
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

  const result = dbRun(() => db.transaction(() => {
    const bridge = stageBridgeSeen();
    db.prepare("UPDATE wireless_light SET light_color = ?, green_tick = COALESCE(?, green_tick), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1").run(color, gtParam);
    const light = getLightState();
    // 물리 지정 경기의 arm 상태를 세션에도 반영(green=arm). 전 클라가 wireless:session으로 공유.
    let session = null;
    let resetFinalized = false;
    let openedRun = null;
    if (light.owner_event) {
      const cur = db.prepare("SELECT armed, light_color, green_tick, reset_pending FROM wireless_session WHERE event_type = ?").get(light.owner_event);
      if (color === "green") {
        // 중복 L green 방어: 이미 같은 green(또는 tick 미동봉 재보고)으로 armed면 런을 리셋하지 않는다.
        // (마스터의 재전송/바운스가 진행 중 측정 런을 날리는 것을 막음.)
        const dup = cur && cur.armed && cur.light_color === "green" && (gtParam == null || cur.green_tick === gtParam);
        if (!dup) {
          const runId = crypto.randomUUID();
          db.prepare("UPDATE wireless_session SET armed = 1, light_color = 'green', green_tick = COALESCE(?, green_tick), armed_at = ?, run_id = ?, saved_record_name = NULL, saved_record_rowid = NULL, reset_pending = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
            .run(gtParam, new Date().toISOString(), runId, light.owner_event);
          openedRun = { eventType: light.owner_event, runId };
        }
      } else if (color === "off" && cur?.reset_pending) {
        // 물리 초기화는 마스터가 실제 OFF를 보고한 시점에만 확정한다. 이 세션 갱신이
        // 모든 관찰자와 재접속 클라이언트에서 이전 편집 카드를 폐기하는 권위 신호다.
        db.prepare("UPDATE wireless_session SET armed = 0, light_color = 'off', run_id = NULL, saved_record_name = NULL, saved_record_rowid = NULL, reset_pending = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
          .run(light.owner_event);
        resetFinalized = true;
      } else {
        db.prepare("UPDATE wireless_session SET armed = 0, light_color = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
          .run(color === "red" ? "red" : "off", light.owner_event);
      }
      session = getSession(light.owner_event);
    }
    return { bridge, light, session, resetFinalized, openedRun };
  })());
  if (!result.success) {
    logger.warn(req, "wireless.light", {
      error: result.internalError || result.error,
      color,
      phase: "database_mutation",
      requested_bridge_online: true,
    }, "light");
    return res.status(result.status).send(result.error);
  }
  if (commitBridgeSeen(result.result.bridge)) {
    logger.log(req, "wireless.bridge", { online: true, last_seen: lastBridgeSeenIso }, "bridge");
  }
  if (result.result.openedRun) {
    resetEngineRun(result.result.openedRun.eventType, null, result.result.openedRun.runId);
  }
  logger.log(req, "wireless.light", { color, green_tick: gtParam }, "light");
  if (result.result.resetFinalized && result.result.session) engineRun.delete(result.result.session.event_type);
  broadcastEvent("wireless:light", result.result.light);
  if (result.result.session) broadcastEvent("wireless:session", result.result.session);
  res.json(result.result.light);
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
  }
  res.json(getBridgeState());
});

// PUT /api/wireless/physical-event - 물리(실제) 신호등을 사용할 경기 지정. null = 없음.
// 기본은 모든 경기가 가상 신호등으로 동작하고, 지정된 경기만 마스터의 SSR을 실제 제어.
// owner_event = 지정된 경기(런타임 점유가 아니라 설정).
app.put("/api/wireless/physical-event", (req, res) => {
  const ev = req.body?.event_type;
  const value = ev == null ? null : ev;
  if (value !== null && !(typeof value === "string" && EVENT_TYPES.includes(value))) {
    return res.status(400).send("올바르지 않은 종목입니다.");
  }
  const result = dbRun(() => {
    const prev = db.prepare("SELECT owner_event FROM wireless_light WHERE id = 1").get();
    db.prepare(
      "UPDATE wireless_light SET owner_event = ?, owner_actor = ?, light_color = CASE WHEN ? IS NULL THEN 'off' ELSE light_color END, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
    ).run(value, req.user?.email || null, value);
    return { row: getLightState(), prev: prev?.owner_event || null };
  });
  if (!result.success) {
    logger.warn(req, "wireless.physical_event", { error: result.error, requested: value });
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.physical_event", { event_type: value, prev: result.result.prev });
  broadcastEvent("wireless:light", result.result.row);
  res.json(result.result.row);
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
    logger.warn(req, "wireless.debounce", { error: result.error, ms }, "settings");
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "wireless.debounce", { ms }, "settings");
  broadcastEvent("wireless:light", result.result);
  res.json(result.result);
});

// POST /api/wireless/arm - 경기 arm/disarm(green=arm). 가상 경기는 이걸로 전 클라 공유.
// (물리 지정 경기는 실제 SSR이 마스터 L 보고로 /api/wireless/light를 통해 세션에 반영된다.)
// body: { event_type, action: "green"|"red"|"off"|"reset", green_tick?, team?, event_name? }
app.post("/api/wireless/arm", (req, res) => {
  const { event_type, action } = req.body || {};
  if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.arm", status: 400, message: "올바르지 않은 종목입니다.",
      target: typeof event_type === "string" ? event_type : "wireless",
      operation: action ?? "arm", context: { event_type: event_type ?? null },
    });
  }
  if (!["green", "red", "off", "reset"].includes(action)) {
    return rejectMutation(req, res, {
      action: "wireless.arm", status: 400, message: "올바르지 않은 동작입니다.",
      target: event_type, operation: action ?? "arm", context: { event_type },
    });
  }
  // A안: 해당 경기를 점유한 controller만 제어. 점유자 없으면 허용(첫 제어).
  const sessionPreflight = runMutationPreflight(req, res, {
    action: "wireless.arm", operation: action, target: event_type,
    context: { event_type }, lookup: () => getSession(event_type),
    failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
  });
  if (!sessionPreflight.ok) return;
  const sess = sessionPreflight.value;
  const actor = wirelessActor(req);
  if (sess?.controller && sess.controller !== actor) {
    const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
    return rejectMutation(req, res, {
      action: "wireless.arm", status: 409, message, target: event_type, operation: action,
      context: { event_type, controller: controllerEmail(sess.controller), requested_actor: actor },
    });
  }
  let green_tick = null;
  if (action === "green") {
    green_tick = tickToText(req.body?.green_tick);
    if (green_tick === undefined) {
      return rejectMutation(req, res, {
        action: "wireless.arm", status: 400, message: "green_tick이 올바르지 않습니다.",
        target: event_type, operation: action, context: { event_type, green_tick: req.body?.green_tick ?? null },
      });
    }
  }
  // bind-at-arm: green 요청 본문에 team·event_name이 실려 오면 arm과 atomic하게 바인딩한다.
  // 본문에 없으면(구형 클라/기타 호출) 세션 선택을 건드리지 않고 live 세션으로 폴백(bound=null).
  // → /select POST와 /arm POST의 도착 순서 레이스와 무관하게 귀속이 정확하고, arm 후 선택이
  //   바뀌어도 기록은 arm 시점 팀에 귀속된다(엔진이 run.bound 우선 사용).
  const body = req.body || {};
  const hasSel = action === "green" && ("team" in body || "event_name" in body);
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
  const runId = action === "green" ? crypto.randomUUID() : null;
  const result = dbRun(() => {
    if (action === "green") {
      if (hasSel) {
        db.prepare("UPDATE wireless_session SET armed = 1, light_color = 'green', green_tick = ?, team_json = ?, event_name = ?, armed_at = ?, run_id = ?, saved_record_name = NULL, saved_record_rowid = NULL, reset_pending = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
          .run(green_tick, bound.team ? JSON.stringify(bound.team) : null, bound.event_name, new Date().toISOString(), runId, event_type);
      } else {
        db.prepare("UPDATE wireless_session SET armed = 1, light_color = 'green', green_tick = ?, armed_at = ?, run_id = ?, saved_record_name = NULL, saved_record_rowid = NULL, reset_pending = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
          .run(green_tick, new Date().toISOString(), runId, event_type);
      }
    } else if (action === "reset") {
      // 가상 경기 초기화는 한 번의 권위 세션 전환으로 OFF + 런 식별자 폐기를 확정한다.
      // 일반 OFF는 사용자가 계속 편집할 수 있도록 식별자를 보존한다.
      db.prepare("UPDATE wireless_session SET armed = 0, light_color = 'off', run_id = NULL, saved_record_name = NULL, saved_record_rowid = NULL, reset_pending = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
        .run(event_type);
    } else {
      // red = 정지(표시는 적색), off = 소등(grey). 둘 다 disarm.
      db.prepare("UPDATE wireless_session SET armed = 0, light_color = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
        .run(action === "red" ? "red" : "off", event_type);
    }
    return getSession(event_type);
  });
  if (!result.success) {
    logger.warn(req, "wireless.arm", { error: result.internalError || result.error, event_type, action }, event_type);
    return res.status(result.status).send(result.error);
  }
  // 세션 변경이 확정된 뒤에만 새 런을 연다. DB 실패 시 기존 엔진/편집 대상도 유지된다.
  if (action === "green") resetEngineRun(event_type, bound, runId);
  else if (action === "reset") engineRun.delete(event_type);
  logger.log(req, "wireless.arm", { action, green_tick, before: sess, after: result.result }, event_type);
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
  const result = dbRun(() => {
    db.prepare("UPDATE wireless_session SET team_json = ?, event_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?")
      .run(team, event_name, event_type);
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

// POST /api/wireless/dnf - 진행 경기 DNF 기록(result -1). 세션 선택 정보(team·event_name)로 귀속.
app.post("/api/wireless/dnf", (req, res) => {
  const { event_type } = req.body || {};
  if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.dnf", status: 400, message: "올바르지 않은 종목입니다.",
      target: typeof event_type === "string" ? event_type : "wireless", operation: "dnf",
      context: { event_type: event_type ?? null },
    });
  }
  const sessionPreflight = runMutationPreflight(req, res, {
    action: "wireless.dnf", operation: "dnf", target: event_type,
    context: { event_type }, lookup: () => getSession(event_type),
    failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
  });
  if (!sessionPreflight.ok) return;
  const sess = sessionPreflight.value;
  const actor = wirelessActor(req);
  if (sess?.controller && sess.controller !== actor) {
    const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
    return rejectMutation(req, res, {
      action: "wireless.dnf", status: 409, message, target: event_type, operation: "dnf",
      context: { event_type, controller: controllerEmail(sess.controller), requested_actor: actor, team: sess.team ?? null },
    });
  }
  if (!sess?.event_name || !sess?.team) {
    return rejectMutation(req, res, {
      action: "wireless.dnf", status: 400, message: "이벤트 이름과 팀을 먼저 선택하세요.",
      target: event_type, operation: "dnf", context: { event_type, team: sess?.team ?? null, event_name: sess?.event_name ?? null },
    });
  }
  if (!sess.armed) {
    return rejectMutation(req, res, {
      action: "wireless.dnf", status: 400, message: "arm(녹색등)되지 않은 경기는 DNF 기록할 수 없습니다.",
      target: event_type, operation: "dnf", context: { event_type, team: sess.team, event_name: sess.event_name },
    });
  }
  // 이미 그 런에서 결과가 저장됐으면 DNF 이중 기록 금지.
  let run = engineRun.get(event_type);
  if (run?.saved) {
    return rejectMutation(req, res, {
      action: "wireless.dnf", status: 409, message: "이미 기록이 저장된 경기입니다.",
      target: event_type, operation: "dnf", context: { event_type, run_id: run.runId ?? sess.run_id ?? null, team: run.bound?.team ?? sess.team },
    });
  }
  // 내구는 이미 랩을 이어붙인 누적 행(run.recordRowid)이 있으면 그 행의 result를 -1로 UPDATE한다
  // — 별도 DNF 행을 INSERT하면 누적 행과 공존해 이중 기록이 된다. 그 외 종목/누적 행 없으면 신규 -1.
  let ok;
  if (event_type === "내구" && run?.recordRowid != null && run?.recordName) {
    const r = dbRun(() => {
      db.prepare("UPDATE record SET result = ? WHERE name = ? AND legacy_rowid = ?").run(-1, run.recordName, run.recordRowid);
      return getRecordRow(run.recordName, run.recordRowid);
    });
    ok = r.success;
    if (ok) {
      logger.log(req, "wireless.record", { type: event_type, result: -1, dnf: true, num: r.result.num }, run.recordName);
      broadcastEvent("records", { type: "update", name: run.recordName, field: "result", recordFiles: getRecordFiles(), record: r.result, event_type, run_id: run.runId ?? null });
    } else {
      logger.warn(req, "wireless.record", { error: r.internalError || r.error, event_type }, run.recordName);
    }
  } else {
    // 귀속은 arm 스냅샷(run.bound) 우선, 없으면 live 세션.
    ok = engineSaveRecord(event_type, run?.bound || sess, -1, null, { req });
  }
  if (!ok) {
    return rejectMutation(req, res, {
      action: "wireless.dnf", status: 500, message: "DNF 기록 저장에 실패했습니다.",
      target: event_type, operation: "dnf", context: { event_type, team: run?.bound?.team ?? sess.team, event_name: run?.bound?.event_name ?? sess.event_name },
    });
  }
  // 늦게 도착하는 도착 센서가 이중 저장하지 않도록 런을 저장됨으로 표시.
  // 서버 재기동 등으로 런이 비어 있으면 생성 후 표시 — 안 하면 뒤이은 센서가 새 런을
  // 만들어 실기록을 추가 저장(DNF + 실기록 이중 저장)할 수 있다.
  if (!run) { resetEngineRun(event_type, null, sess.run_id); run = engineRun.get(event_type); }
  run.saved = true;
  logger.log(req, "wireless.dnf", {
    event_type,
    run_id: run.runId ?? sess.run_id ?? null,
    team: run.bound?.team ?? sess.team,
    event_name: run.bound?.event_name ?? sess.event_name,
  }, event_type);
  res.json({ ok: true });
});

// POST /api/wireless/command - 비-브리지 컨트롤러가 물리 신호등(SSR)을 원격 제어. 서버가 브리지로
// 내려보내고(wireless:command), 브리지가 시리얼로 마스터에 전달. 물리 지정 경기에만 허용.
// (가상 경기는 /api/wireless/arm으로 서버 상태만 바꾸면 되므로 다운링크 불필요.)
app.post("/api/wireless/command", (req, res) => {
  const { event_type, action } = req.body || {};
  if (typeof event_type !== "string" || !EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.command", status: 400, message: "올바르지 않은 종목입니다.",
      target: typeof event_type === "string" ? event_type : "wireless", operation: action ?? "command",
      context: { event_type: event_type ?? null },
    });
  }
  if (!["green", "red", "off", "reset"].includes(action)) {
    return rejectMutation(req, res, {
      action: "wireless.command", status: 400, message: "올바르지 않은 동작입니다.",
      target: event_type, operation: action ?? "command", context: { event_type },
    });
  }
  const statePreflight = runMutationPreflight(req, res, {
    action: "wireless.command", operation: action, target: event_type,
    context: { event_type },
    lookup: () => ({ session: getSession(event_type), light: getLightState() }),
    failureMessage: "무선 제어 상태를 확인할 수 없습니다.",
  });
  if (!statePreflight.ok) return;
  const sess = statePreflight.value.session;
  const actor = wirelessActor(req);
  if (sess?.controller && sess.controller !== actor) {
    const message = `다른 사용자가 제어 중입니다: ${controllerEmail(sess.controller)}`;
    return rejectMutation(req, res, {
      action: "wireless.command", status: 409, message, target: event_type, operation: action,
      context: { event_type, controller: controllerEmail(sess.controller), requested_actor: actor },
    });
  }
  const light = statePreflight.value.light;
  if (light.owner_event !== event_type) {
    return rejectMutation(req, res, {
      action: "wireless.command", status: 409, message: "물리 신호등 지정 경기가 아닙니다.",
      target: event_type, operation: action, context: { event_type, owner_event: light.owner_event ?? null },
    });
  }
  if (!bridgeOnline) {
    return rejectMutation(req, res, {
      action: "wireless.command", status: 409, message: "마스터에 연결된 브리지가 없습니다.",
      target: event_type, operation: action, context: { event_type, bridge_online: false },
    });
  }
  let resetAfter = null;
  if (action === "reset") {
    const pending = dbRun(() => {
      db.prepare("UPDATE wireless_session SET reset_pending = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ?").run(event_type);
      return getSession(event_type);
    });
    if (!pending.success) {
      logger.warn(req, "wireless.command", { error: pending.internalError || pending.error, event_type, action }, event_type);
      return res.status(pending.status).send(pending.error);
    }
    resetAfter = pending.result;
  }
  logger.log(req, "wireless.command", {
    action,
    ...(action === "reset" ? {
      before: { reset_pending: sess?.reset_pending ?? 0 },
      after: { reset_pending: resetAfter?.reset_pending ?? 1 },
    } : {}),
  }, event_type);
  // 브리지가 SSE로 받아 시리얼로 전달(실행 직전 isPhysical 재검사 — TOCTOU 방어).
  broadcastEvent("wireless:command", { event_type, action });
  res.json({ ok: true });
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

// DELETE /api/wireless/lease/:event - lease 해제(보유자 또는 admin 강제 회수).
app.delete("/api/wireless/lease/:event", (req, res) => {
  const event_type = decodeURIComponent(req.params.event);
  if (!EVENT_TYPES.includes(event_type)) {
    return rejectMutation(req, res, {
      action: "wireless.lease", status: 400, message: "올바르지 않은 종목입니다.",
      target: event_type || "wireless", operation: "release", context: { event_type },
    });
  }
  // release/takeover는 email 기준: 같은 계정은 자기 다른 세션(멈춘 탭 등)을 회수 가능,
  // 타 계정 회수는 admin만. (claim/제어는 세션 단위라 다른 세션이면 명시적 가로채기 필요.)
  const sessionPreflight = runMutationPreflight(req, res, {
    action: "wireless.lease", operation: "release", target: event_type,
    context: { event_type }, lookup: () => getSession(event_type),
    failureMessage: "무선 세션 상태를 확인할 수 없습니다.",
  });
  if (!sessionPreflight.ok) return;
  const sess = sessionPreflight.value;
  if (sess?.controller && controllerEmail(sess.controller) !== (req.user?.email || null) && req.user?.role !== "admin") {
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
    sessions: getSessions(),
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
    db.prepare("SELECT id, node_id, master_tick, ev_seq, server_time, rssi, snr, link_state FROM wireless_event WHERE id > ? ORDER BY id ASC LIMIT ?").all(sinceId, limit),
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
  timers: [bridgeWatch, leaseWatch, eventRetention, telemetryRetention],
  queries: { yearRecordGroups: getYearRecordGroups, eventModes: getEventModes },
  runBridgeWatch,
  runLeaseWatch,
  runEventRetention,
};
}
