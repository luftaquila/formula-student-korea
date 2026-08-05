import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { validateEntryNum } from "../shared/validation.mjs";
import { VEHICLE_COLORS } from "../shared/constants.js";

const PORT = 9200;

export function createEntryApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/entry.db");

// 연도별 차량 유형 테이블 헬퍼
function getVtTableName(year) {
  // 잘못된 연도를 현재 연도로 대체하지 않는다(entry_ 테이블과 동일한 footgun 방지).
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2099) {
    throw new Error("올바르지 않은 연도입니다.");
  }
  return `vehicle_types_${y}`;
}

const _ensuredVtTables = new Set();
function ensureVtTable(year) {
  const tableName = getVtTableName(year);
  if (_ensuredVtTables.has(tableName)) return tableName;
  db.exec(`CREATE TABLE IF NOT EXISTS '${tableName}' (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT 'blue'
  )`);
  _ensuredVtTables.add(tableName);
  return tableName;
}

// 기존 전역 vehicle_types → 연도별 마이그레이션
const legacyVt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vehicle_types'").get();
if (legacyVt) {
  // color 컬럼이 없으면 먼저 추가
  const vtCols = db.prepare("PRAGMA table_info(vehicle_types)").all();
  if (!vtCols.some(c => c.name === "color")) {
    db.exec("ALTER TABLE vehicle_types ADD COLUMN color TEXT NOT NULL DEFAULT 'blue'");
  }
  const globalTypes = db.prepare("SELECT name, sort_order, color FROM vehicle_types").all();
  if (globalTypes.length > 0) {
    // 기존 엔트리가 있는 모든 연도 + 올해에 복사
    const years = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'entry_%'")
      .all().map(t => Number(t.name.replace("entry_", ""))).filter(y => !isNaN(y)));
    years.add(new Date().getFullYear());
    for (const y of years) {
      const vtTable = ensureVtTable(y);
      const insert = db.prepare(`INSERT OR IGNORE INTO '${vtTable}' (name, sort_order, color) VALUES (?, ?, ?)`);
      for (const t of globalTypes) insert.run(t.name, t.sort_order, t.color);
    }
  }
  db.exec("DROP TABLE vehicle_types");
}

// 기존 entry 테이블이 있으면 올해 테이블로 마이그레이션
const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entry'").get();
if (legacy) {
  db.exec(`ALTER TABLE entry RENAME TO entry_${new Date().getFullYear()}`);
}

// 연도별 테이블 헬퍼
function getTableName(year) {
  // 잘못된 연도를 조용히 현재 연도로 대체하지 않는다 — DELETE /api/entries?year=<garbage>가
  // 실수로 올해 엔트리 전체를 지우는 footgun을 막는다. 연도 미지정(absent)은 호출부
  // (withYearTable)가 현재 연도로 기본 처리하고, 여기 도달하는 값은 반드시 유효해야 한다.
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2099) {
    throw new Error("올바르지 않은 연도입니다.");
  }
  return `entry_${y}`;
}

// 이미 보장한 연도 테이블을 프로세스 내에 캐시 — 공개 GET(상태 페이지·키오스크가 상시
// 폴링)마다 CREATE TABLE/INDEX DDL을 재실행해 스키마 잠금·파싱 비용을 물지 않게 한다.
const _ensuredYearTables = new Set();
function ensureYearTable(year) {
  const tableName = getTableName(year);
  if (_ensuredYearTables.has(tableName)) return tableName;
  const y = Number(year);
  db.exec(`CREATE TABLE IF NOT EXISTS '${tableName}' (
    num INTEGER PRIMARY KEY,
    univ TEXT NOT NULL,
    team TEXT NOT NULL,
    type TEXT DEFAULT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    active_revision INTEGER NOT NULL DEFAULT 0
  )`);
  // CREATE TABLE IF NOT EXISTS는 기존 테이블의 스키마를 보강하지 않는다. 인덱스를
  // 만들기 전에 컬럼을 추가해야 운영 DB의 레거시 연도 테이블에서도 시작할 수 있다.
  try { db.exec(`ALTER TABLE '${tableName}' ADD COLUMN type TEXT DEFAULT NULL`); }
  catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE '${tableName}' ADD COLUMN active INTEGER NOT NULL DEFAULT 1`); }
  catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE '${tableName}' ADD COLUMN active_revision INTEGER NOT NULL DEFAULT 0`); }
  catch { /* column already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_${y}_type ON '${tableName}'(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_${y}_active ON '${tableName}'(active)`);
  _ensuredYearTables.add(tableName);
  return tableName;
}

function getAvailableYears() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'entry_%' ORDER BY name DESC")
    .all()
    .map(t => Number(t.name.replace('entry_', '')))
    .filter(y => !isNaN(y));
}

// 올해 테이블 보장
ensureYearTable(new Date().getFullYear());
ensureVtTable(new Date().getFullYear());

db.exec(`CREATE TABLE IF NOT EXISTS lifecycle_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  service TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS entry_active_revision (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  value INTEGER NOT NULL DEFAULT 0
)`);
db.prepare("INSERT OR IGNORE INTO entry_active_revision (id, value) VALUES (1, 0)").run();
try { db.exec("ALTER TABLE lifecycle_outbox ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE lifecycle_outbox ADD COLUMN locked_by TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
db.exec("CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_ready ON lifecycle_outbox(status, next_attempt_at, id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_service_id ON lifecycle_outbox(service, id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_service_status_id ON lifecycle_outbox(service, status, id)");

// 현재 연도 이외의 기존 테이블도 같은 순서로 마이그레이션한다.
for (const year of getAvailableYears()) {
  ensureYearTable(year);
}

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "entry");

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path === "/api/years") return null;
  if (req.path === "/api/entries" && req.method === "GET" && req.query.includeInactive !== "true") return null;
  if (req.path === "/api/vehicle-types" && req.method === "GET") return null;
  return "admin";
});
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

function broadcastEntries(year, change, detail = {}) {
  broadcastEvent("entries", { year: Number(year), change, ...detail });
}

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));
app.get("/api/events", sseHandler());

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateEntryData({ univ, team, type }, year) {
  if (typeof univ !== "string" || univ.trim() === "") {
    return { valid: false, error: "올바르지 않은 학교명입니다." };
  }
  if (typeof team !== "string" || team.trim() === "") {
    return { valid: false, error: "올바르지 않은 팀명입니다." };
  }
  const validatedType = type || null;
  if (validatedType) {
    const vtTable = ensureVtTable(year);
    const exists = db.prepare(`SELECT id FROM '${vtTable}' WHERE name = ?`).get(validatedType);
    if (!exists) {
      return { valid: false, error: "존재하지 않는 차량 유형입니다." };
    }
  }
  return { valid: true, univ: univ.trim(), team: team.trim(), type: validatedType };
}

function validateBulkData(data) {
  let parsed;

  try {
    parsed = typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    return { valid: false, error: `JSON 파일을 읽을 수 없습니다: ${e}` };
  }

  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    return { valid: false, error: "올바르지 않은 JSON 형식입니다." };
  }

  for (const key in parsed) {
    if (!/^\d+$/.test(key) || Number(key) < 1 || Number(key) >= LIFECYCLE_TEMP_NUM_START) {
      return { valid: false, error: "올바르지 않은 JSON 형식입니다." };
    }

    const value = parsed[key];
    if (typeof value !== "object" || value === null) {
      return { valid: false, error: "올바르지 않은 JSON 형식입니다." };
    }

    const keys = Object.keys(value);
    if (!keys.includes("univ") || !keys.includes("team")) {
      return { valid: false, error: "올바르지 않은 JSON 형식입니다." };
    }

    if (typeof value.univ !== "string" || !value.univ.trim()) {
      return { valid: false, error: `엔트리 ${key}: 올바르지 않은 학교명입니다.` };
    }
    if (typeof value.team !== "string" || !value.team.trim()) {
      return { valid: false, error: `엔트리 ${key}: 올바르지 않은 팀명입니다.` };
    }
    if (value.active !== undefined && typeof value.active !== "boolean") {
      return { valid: false, error: `엔트리 ${key}: active는 boolean이어야 합니다.` };
    }
  }

  return { valid: true, data: parsed };
}

function validateBulkRenumbers(data) {
  if (data === undefined || data === null) return { valid: true, renumbers: new Map() };
  if (typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, error: "올바르지 않은 번호 변경 매핑입니다." };
  }
  const renumbers = new Map();
  const targets = new Set();
  for (const [from, to] of Object.entries(data)) {
    if (!/^\d+$/.test(from)) return { valid: false, error: "올바르지 않은 번호 변경 매핑입니다." };
    const prevNum = Number(from);
    const newNum = Number(to);
    // self-map(from === to)은 explicit renumber로 취급되어 same-number identity
    // ambiguous 검사를 우회시키므로(downstream 데이터가 새 팀에 조용히 승계됨) 거부한다.
    if (!Number.isInteger(prevNum) || prevNum < 1 || prevNum >= LIFECYCLE_TEMP_NUM_START ||
        !Number.isInteger(newNum) || newNum < 1 || newNum >= LIFECYCLE_TEMP_NUM_START ||
        prevNum === newNum ||
        targets.has(newNum)) {
      return { valid: false, error: "올바르지 않은 번호 변경 매핑입니다." };
    }
    renumbers.set(prevNum, newNum);
    targets.add(newNum);
  }
  return { valid: true, renumbers };
}

// 동일 번호에서 팀 정체성(univ/team)이 바뀐 경우, 명칭 정정(retain)인지 팀
// 교체(replacement)인지 페이로드만으로는 구분할 수 없다. 운영자가 명시한 의도를
// 번호 배열로 받는다. 둘 다 양수 엔트리 번호여야 한다.
function validateBulkIntentList(data, label) {
  if (data === undefined || data === null) return { valid: true, nums: new Set() };
  if (!Array.isArray(data)) return { valid: false, error: `올바르지 않은 ${label} 목록입니다.` };
  const nums = new Set();
  for (const v of data) {
    if (!Number.isInteger(v) || v < 1 || v >= LIFECYCLE_TEMP_NUM_START) {
      return { valid: false, error: `올바르지 않은 ${label} 목록입니다.` };
    }
    nums.add(v);
  }
  return { valid: true, nums };
}

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

function nextActiveRevision() {
  db.prepare("UPDATE entry_active_revision SET value = value + 1 WHERE id = 1").run();
  return db.prepare("SELECT value FROM entry_active_revision WHERE id = 1").get().value;
}

/* ============================================
   서비스 간 알림 헬퍼
   ============================================ */
const LIFECYCLE_SERVICES = [
  { name: "queue", env: "QUEUE_SERVER", syncsActive: true },
  // Documents는 삭제/번호 변경만 동기화한다. 비활성 팀도 계정 할당과 제출이 가능하다.
  { name: "documents", env: "DOCUMENTS_SERVER", syncsActive: false },
  { name: "inspection", env: "INSPECTION_SERVER", syncsActive: true },
  { name: "score", env: "SCORE_SERVER", syncsActive: true },
  { name: "traffic", env: "TRAFFIC_SERVER", syncsActive: true },
];

let lifecycleOutboxTail = Promise.resolve();
let lifecycleOutboxRetryQueued = false;
const LIFECYCLE_LOCK_MS = 30_000;
// 이 횟수만큼 전달에 실패하면 행을 terminal 'dead' 상태로 전이시켜 무한 재시도와
// assertNoPendingLifecycleRefs의 영구 409 차단을 끊는다. dead 행은 관리자 재시도/폐기로만 해소.
const LIFECYCLE_MAX_ATTEMPTS = 24;
const LIFECYCLE_WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2)}`;
const LIFECYCLE_TEMP_NUM_START = 1_000_000_000;

function configuredLifecycleServices({ activeOnly = false } = {}) {
  return LIFECYCLE_SERVICES.filter((svc) => (!activeOnly || svc.syncsActive) && process.env[svc.env]);
}

// 라이프사이클 동기화 대상이지만 *_SERVER env가 빠진 서비스는 outbox row 자체가
// 생성되지 않아 재시도·dead-letter·admin recovery 대상에서 사라진다. 최소한 감사
// 추적이 가능하도록, 동기화가 필요한 작업이 발생했을 때 누락된 서비스를 경고로 남긴다.
function warnUnconfiguredLifecycleServices(req, context, { activeOnly = false } = {}) {
  const missing = LIFECYCLE_SERVICES
    .filter((svc) => (!activeOnly || svc.syncsActive) && !process.env[svc.env])
    .map((svc) => svc.name);
  if (missing.length > 0) {
    logger.warn(req, "entry.lifecycle_unconfigured", { ...context, missing });
  }
}

function lifecycleServer(service) {
  const svc = LIFECYCLE_SERVICES.find((s) => s.name === service);
  return svc ? process.env[svc.env] : null;
}

function lifecycleHeaders(hasBody = false) {
  const headers = {};
  if (process.env.INTERNAL_SECRET) headers["X-Internal-Service"] = process.env.INTERNAL_SECRET;
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

function insertLifecycleEvents(events) {
  if (events.length === 0) return [];
  const insert = db.prepare(`
    INSERT INTO lifecycle_outbox (event_type, service, method, path, body, next_attempt_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  return events.map((event) =>
    insert.run(event.eventType, event.service, event.method, event.path, event.body ? JSON.stringify(event.body) : null, now).lastInsertRowid,
  );
}

function markLifecycleDelivered(row) {
  db.prepare("DELETE FROM lifecycle_outbox WHERE id = ? AND locked_by = ?").run(row.id, row.locked_by || LIFECYCLE_WORKER_ID);
}

function markLifecycleFailed(row, error) {
  const attempts = row.attempts + 1;
  const dead = attempts >= LIFECYCLE_MAX_ATTEMPTS;
  const delayMs = Math.min(5 * 60_000, 1000 * 2 ** Math.min(attempts, 8));
  db.prepare(`
    UPDATE lifecycle_outbox
    SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?,
        locked_until = 0, locked_by = '', updated_at = strftime('%s','now') * 1000
    WHERE id = ? AND locked_by = ?
  `).run(dead ? "dead" : "pending", attempts, Date.now() + delayMs, String(error).slice(0, 500), row.id, row.locked_by || LIFECYCLE_WORKER_ID);
  return dead;
}

function lifecycleRowClaimable(row, now, { ignoreDelay = false } = {}) {
  if (row.status === "pending") return ignoreDelay || row.next_attempt_at <= now;
  return row.status === "processing" && row.locked_until <= now;
}

function claimLifecycleRow(row, { ignoreDelay = false } = {}) {
  const now = Date.now();
  if (!lifecycleRowClaimable(row, now, { ignoreDelay })) return null;
  const lockedUntil = now + LIFECYCLE_LOCK_MS;
  const result = db.prepare(`
    UPDATE lifecycle_outbox
    SET status = 'processing', locked_until = ?, locked_by = ?, updated_at = strftime('%s','now') * 1000
    WHERE id = ?
      AND (
        (status = 'pending' ${ignoreDelay ? "" : "AND next_attempt_at <= ?"})
        OR (status = 'processing' AND locked_until <= ?)
      )
  `).run(...(ignoreDelay
    ? [lockedUntil, LIFECYCLE_WORKER_ID, row.id, now]
    : [lockedUntil, LIFECYCLE_WORKER_ID, row.id, now, now]));
  if (result.changes === 0) return null;
  return { ...row, status: "processing", locked_until: lockedUntil, locked_by: LIFECYCLE_WORKER_ID };
}

async function deliverLifecycleRow(row, options = {}) {
  const claimed = claimLifecycleRow(row, options);
  if (!claimed) return false;
  const fail = (errMsg) => {
    const dead = markLifecycleFailed(claimed, errMsg);
    const detail = {
      id: row.id,
      event_type: row.event_type,
      service: row.service,
      path: row.path,
      attempts: row.attempts + 1,
      error: errMsg,
    };
    logger.warn(null, "entry.lifecycle_dispatch_fail", { ...detail, dead });
    // terminal 전이는 별도 액션으로 남겨 관리자가 재시도/폐기 대상을 찾을 수 있게 한다.
    if (dead) logger.warn(null, "entry.lifecycle_dead", detail);
    return false;
  };
  const server = lifecycleServer(row.service);
  if (!server) return fail(`missing server env for ${row.service}`);
  try {
    const res = await fetch(`${server}${row.path}`, {
      method: row.method,
      headers: lifecycleHeaders(!!row.body),
      body: row.body || undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    // 202 = downstream이 DB 변경은 커밋했으나 후속 작업(파일 이동 등)이 재시도 대기 중.
    // 파일까지 정합 상태가 될 때까지 renumber를 "미완료"로 보고 재시도한다 — 그 사이
    // assertNoPendingLifecycleRefs가 같은 번호의 추가 편집을 막아 일관성을 보장한다.
    if (res.status === 202) throw new Error("status 202 pending");
    markLifecycleDelivered(claimed);
    return true;
  } catch (e) {
    return fail(e.message || String(e));
  }
}

async function processLifecycleOutboxBatch({ ids = null, limit = 50 } = {}) {
  const now = Date.now();
  let rows;
  if (ids?.length) {
    const targetIds = ids.map(Number).filter(Number.isFinite);
    if (targetIds.length === 0) return;
    const placeholders = targetIds.map(() => "?").join(",");
    const targets = db.prepare(`
      SELECT service, MAX(id) AS max_id
      FROM lifecycle_outbox
      WHERE id IN (${placeholders})
      GROUP BY service
    `).all(...targetIds);
    rows = targets.flatMap((target) => db.prepare(`
      SELECT * FROM lifecycle_outbox
      WHERE status IN ('pending', 'processing') AND service = ? AND id <= ?
      ORDER BY id
    `).all(target.service, target.max_id));
    rows.sort((a, b) => a.id - b.id);
  } else {
    const blockedServices = new Set();
    let deliveredRows = 0;
    while (deliveredRows < limit) {
      const blocked = [...blockedServices];
      const blockedClause = blocked.length ? `AND service NOT IN (${blocked.map(() => "?").join(",")})` : "";
      rows = db.prepare(`
        WITH oldest AS (
          SELECT service, MIN(id) AS id
          FROM lifecycle_outbox
          WHERE status IN ('pending', 'processing') ${blockedClause}
          GROUP BY service
        )
        SELECT o.*
        FROM lifecycle_outbox o
        JOIN oldest ON oldest.id = o.id
        WHERE (o.status = 'pending' AND o.next_attempt_at <= ?)
           OR (o.status = 'processing' AND o.locked_until <= ?)
        ORDER BY o.id
        LIMIT ?
      `).all(...blocked, now, now, limit - deliveredRows);
      if (rows.length === 0) break;
      // 이 배치의 rows는 서비스별 oldest 1건씩(oldest CTE)이라 서비스 간 병렬 전달이 서비스 내
      // 순서를 깨지 않는다. downstream 다수가 느릴 때 응답 지연을 (서비스 수)×timeout이 아니라
      // max(timeout)으로 줄인다. 실패한 서비스는 blockedServices로 head-of-line을 유지.
      const results = await Promise.all(rows.map((row) => deliverLifecycleRow(row).then((ok) => ({ svc: row.service, ok }))));
      for (const { svc, ok } of results) {
        deliveredRows += 1;
        if (!ok) blockedServices.add(svc);
      }
    }
    return;
  }
  // 서비스별로 그룹화해 서비스 간에는 병렬로, 서비스 내에서는 id 오름차순 순서대로 전달한다.
  // 한 서비스의 이벤트가 실패/락되면 그 서비스의 나머지는 순서 보존을 위해 중단한다(head-of-line).
  // rows는 이미 id 오름차순 정렬돼 있어 그룹 내 순서가 보존된다.
  const byService = new Map();
  for (const row of rows) {
    if (!byService.has(row.service)) byService.set(row.service, []);
    byService.get(row.service).push(row);
  }
  await Promise.all([...byService.values()].map(async (svcRows) => {
    for (const row of svcRows) {
      if (row.status === "processing" && row.locked_until > now && row.locked_by !== LIFECYCLE_WORKER_ID) return;
      const delivered = await deliverLifecycleRow(row, { ignoreDelay: true });
      if (!delivered) return;
    }
  }));
}

function processLifecycleOutbox(options = {}) {
  const targeted = Array.isArray(options.ids) && options.ids.length > 0;
  if (!targeted && lifecycleOutboxRetryQueued) return lifecycleOutboxTail;
  if (!targeted) lifecycleOutboxRetryQueued = true;
  const run = lifecycleOutboxTail
    .then(
      () => processLifecycleOutboxBatch(options),
      () => processLifecycleOutboxBatch(options),
    )
    .finally(() => {
      if (!targeted) lifecycleOutboxRetryQueued = false;
    });
  lifecycleOutboxTail = run.catch(() => {});
  return run;
}

function startLifecycleOutboxRetry() {
  const timer = setInterval(() => {
    processLifecycleOutbox().catch((e) => logger.warn(null, "entry.lifecycle_retry_error", { error: e.message || String(e) }));
  }, 30_000);
  timer.unref?.();
  return timer;
}

function buildEntryDeletedEvents(nums, year) {
  return nums.flatMap((num) =>
    configuredLifecycleServices().map((svc) => ({
      eventType: "team.delete",
      service: svc.name,
      method: "DELETE",
      path: `/api/internal/team/${num}?year=${Number(year)}`,
    })),
  );
}

function buildEntryRenumberedEvents(prevNum, newNum, year, entry) {
  return configuredLifecycleServices().map((svc) => ({
    eventType: "team.renumber",
    service: svc.name,
    method: "PATCH",
    path: "/api/internal/team-num",
    body: { prevNum, newNum, year: Number(year), entry },
  }));
}

function buildEntryActiveEvents(num, year, active, revision) {
  return configuredLifecycleServices({ activeOnly: true }).map((svc) => ({
    eventType: "team.active",
    service: svc.name,
    method: "PATCH",
    path: "/api/internal/team-active",
    body: { num: Number(num), year: Number(year), active: active === true, revision: Number(revision) },
  }));
}

const lifecycleRetryTimer = startLifecycleOutboxRetry();

/* ============================================
   Admin: lifecycle outbox 운영 (조회/재시도/폐기)
   dead 상태는 LIFECYCLE_MAX_ATTEMPTS 초과로 자동 차단 해제된 행이며,
   downstream을 복구한 뒤 재시도하거나 해소 불가 시 폐기한다.
   ============================================ */
// GET /api/admin/lifecycle-outbox?status=dead|pending|all - 미해결 이벤트 조회
app.get("/api/admin/lifecycle-outbox", (req, res) => {
  let where = "";
  if (req.query.status === "dead") where = "WHERE status = 'dead'";
  else if (req.query.status === "pending") where = "WHERE status IN ('pending', 'processing')";
  const result = dbRun(() => db.prepare(`
    SELECT id, event_type, service, method, path, body, attempts, status,
           next_attempt_at, last_error, created_at, updated_at
    FROM lifecycle_outbox ${where}
    ORDER BY (status = 'dead') DESC, id
    LIMIT 500
  `).all());
  if (!result.success) {
    logger.warn(req, "entry.lifecycle_list", { error: result.error });
    return res.status(result.status).send(result.error);
  }
  res.json(result.result);
});

// POST /api/admin/lifecycle-outbox/:id/retry - 행을 즉시 재시도 대상으로 복구 후 1회 처리
app.post("/api/admin/lifecycle-outbox/:id/retry", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send("올바르지 않은 ID입니다.");

  // dead team.delete가 오래 방치된 사이 그 번호가 새 팀에게 재사용됐다면(assertNoPendingLifecycleRefs는
  // dead를 보지 않으므로 재사용이 허용됨), 재시도 시 삭제가 새 팀의 downstream을 파괴한다.
  // 대상 번호가 현재 entry 테이블에 존재하면(=재사용) 재시도를 거부한다 — 정상 삭제라면 그 번호는
  // 이미 entry에서 제거돼 있어야 한다. 운영자는 재시도 대신 이 이벤트를 폐기하면 된다.
  const row = db.prepare("SELECT event_type, path FROM lifecycle_outbox WHERE id = ?").get(id);
  if (!row) return res.status(404).send("이벤트를 찾을 수 없습니다.");
  if (row.event_type === "team.delete") {
    const m = /\/api\/internal\/team\/(\d+)\?year=(\d+)/.exec(row.path || "");
    if (m) {
      const dnum = Number(m[1]);
      const dyear = Number(m[2]);
      let reused = false;
      try { reused = !!db.prepare(`SELECT 1 FROM '${getTableName(dyear)}' WHERE num = ?`).get(dnum); }
      catch { reused = false; }
      if (reused) {
        logger.warn(req, "entry.lifecycle_retry", { error: "num_reused", id, num: dnum, year: dyear });
        return res.status(409).send(`#${dnum}번을 현재 다른 팀이 사용 중입니다. 이 삭제 이벤트를 재시도하면 그 팀의 데이터가 삭제됩니다. 재시도 대신 폐기하세요.`);
      }
    }
  }

  const result = dbRun(() => db.prepare(`
    UPDATE lifecycle_outbox
    SET status = 'pending', attempts = 0, next_attempt_at = 0, last_error = '',
        locked_until = 0, locked_by = '', updated_at = strftime('%s','now') * 1000
    WHERE id = ?
  `).run(id));
  if (!result.success) {
    logger.warn(req, "entry.lifecycle_retry", { error: result.error, id });
    return res.status(result.status).send(result.error);
  }
  if (result.result.changes === 0) {
    logger.warn(req, "entry.lifecycle_retry", { error: "not found", id });
    return res.status(404).send("이벤트를 찾을 수 없습니다.");
  }
  logger.log(req, "entry.lifecycle_retry", { id });
  await processLifecycleOutbox({ ids: [id] });
  res.status(200).json({ pending: countPendingLifecycleEvents([id]) });
});

// DELETE /api/admin/lifecycle-outbox/:id - 해소 불가능한 이벤트 폐기 (감사 로깅)
app.delete("/api/admin/lifecycle-outbox/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send("올바르지 않은 ID입니다.");
  const row = db.prepare("SELECT id, event_type, service, path, attempts, status, last_error FROM lifecycle_outbox WHERE id = ?").get(id);
  if (!row) return res.status(404).send("이벤트를 찾을 수 없습니다.");
  const result = dbRun(() => db.prepare("DELETE FROM lifecycle_outbox WHERE id = ?").run(id));
  if (!result.success) {
    logger.warn(req, "entry.lifecycle_discard", { error: result.error, id, event_type: row.event_type, service: row.service, path: row.path });
    return res.status(result.status).send(result.error);
  }
  // 파괴적 작업: downstream 동기화 이벤트를 영구 폐기하므로 감사 로그를 남긴다.
  logger.warn(req, "entry.lifecycle_discard", {
    id, event_type: row.event_type, service: row.service, path: row.path,
    attempts: row.attempts, status: row.status, last_error: row.last_error,
  });
  res.status(200).send();
});

function entryIdentity(row) {
  return `${String(row.univ || "").trim()}\u0000${String(row.team || "").trim()}`;
}

function chooseTempNum(usedNums) {
  let candidate = LIFECYCLE_TEMP_NUM_START;
  while (usedNums.has(candidate)) candidate += 1;
  usedNums.add(candidate);
  return candidate;
}

function buildRenumberPlan(moves, reservedNums = []) {
  const remaining = new Map(moves.map((move) => [move.prevNum, { ...move }]));
  const usedNums = new Set([...reservedNums, ...moves.flatMap((move) => [move.prevNum, move.newNum])]);
  const plan = [];

  while (remaining.size > 0) {
    let progressed = false;
    for (const [prevNum, move] of [...remaining.entries()]) {
      if (!remaining.has(move.newNum)) {
        plan.push(move);
        remaining.delete(prevNum);
        progressed = true;
      }
    }
    if (progressed) continue;

    const [cyclePrev, cycleMove] = remaining.entries().next().value;
    const tempNum = chooseTempNum(usedNums);
    plan.push({
      prevNum: cyclePrev,
      newNum: tempNum,
      entry: {
        univ: cycleMove.oldEntry.univ,
        team: cycleMove.oldEntry.team,
        type: cycleMove.oldEntry.type || null,
        active: !!cycleMove.oldEntry.active,
        active_revision: cycleMove.oldEntry.active_revision || 0,
      },
    });
    remaining.delete(cyclePrev);
    remaining.set(tempNum, {
      prevNum: tempNum,
      newNum: cycleMove.newNum,
      entry: cycleMove.entry,
      oldEntry: cycleMove.oldEntry,
    });
  }

  return plan;
}

function lifecycleRowRefsNumber(row, num, year) {
  const targetNum = Number(num);
  const targetYear = Number(year);
  if (row.event_type === "team.delete") {
    const match = String(row.path || "").match(/^\/api\/internal\/team\/(\d+)\?year=(\d+)$/);
    return !!match && Number(match[1]) === targetNum && Number(match[2]) === targetYear;
  }
  if (row.event_type === "team.renumber" && row.body) {
    try {
      const body = JSON.parse(row.body);
      return Number(body.year) === targetYear
        && (Number(body.prevNum) === targetNum || Number(body.newNum) === targetNum);
    } catch {
      return false;
    }
  }
  if (row.event_type === "team.active" && row.body) {
    try {
      const body = JSON.parse(row.body);
      return Number(body.year) === targetYear && Number(body.num) === targetNum;
    } catch {
      return false;
    }
  }
  return false;
}

function pendingLifecycleRefsForNums(nums, year) {
  const targetNums = new Set([...nums].map(Number).filter((n) => Number.isInteger(n) && n > 0));
  if (targetNums.size === 0) return [];
  const pending = db.prepare("SELECT id, event_type, path, body FROM lifecycle_outbox WHERE status IN ('pending', 'processing') ORDER BY id").all();
  return pending.filter((row) => [...targetNums].some((num) => lifecycleRowRefsNumber(row, num, year)));
}

function assertNoPendingLifecycleRefs(nums, year) {
  const refs = pendingLifecycleRefsForNums(nums, year);
  if (refs.length > 0) {
    const ids = refs.slice(0, 5).map((row) => row.id).join(", ");
    throw {
      status: 409,
      message: `이전 엔트리 라이프사이클 동기화가 완료되지 않아 변경할 수 없습니다. 잠시 후 다시 시도하세요. (pending: ${ids})`,
    };
  }
}

function countPendingLifecycleEvents(ids) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`SELECT COUNT(*) AS count FROM lifecycle_outbox WHERE id IN (${placeholders})`).get(...ids).count;
}

function sendLifecyclePending(res, eventIds, message) {
  const pending = countPendingLifecycleEvents(eventIds);
  if (pending === 0) return false;
  res.status(202).json({ status: "pending_lifecycle", pending, message });
  return true;
}

function buildBulkLifecycleEvents(oldRows, newRowsByNum, year, explicitRenumbers = new Map(), replacements = new Set(), retains = new Set()) {
  const newNums = new Set(newRowsByNum.keys());
  const oldRowsByNum = new Map(oldRows.map((row) => [row.num, row]));
  const oldIdentityCounts = new Map();
  const newIdentityCounts = new Map();
  for (const row of oldRows) oldIdentityCounts.set(entryIdentity(row), (oldIdentityCounts.get(entryIdentity(row)) || 0) + 1);
  for (const row of newRowsByNum.values()) newIdentityCounts.set(entryIdentity(row), (newIdentityCounts.get(entryIdentity(row)) || 0) + 1);

  const uniqueNewByIdentity = new Map();
  for (const row of newRowsByNum.values()) {
    const identity = entryIdentity(row);
    if (newIdentityCounts.get(identity) === 1) uniqueNewByIdentity.set(identity, row);
  }

  const deletedNums = [];
  const moves = [];
  const retainedOldRowsByNewNum = new Map();
  const matchedOldNums = new Set();
  const movedTargetNums = new Set();
  const explicitTargets = new Set(explicitRenumbers.values());
  for (const [prevNum, newNum] of explicitRenumbers.entries()) {
    const oldRow = oldRowsByNum.get(prevNum);
    const newRow = newRowsByNum.get(newNum);
    if (!oldRow || !newRow) {
      throw { status: 400, message: "번호 변경 매핑이 기존/신규 엔트리와 일치하지 않습니다." };
    }
    matchedOldNums.add(prevNum);
    retainedOldRowsByNewNum.set(newNum, oldRow);
    if (prevNum !== newNum) {
      movedTargetNums.add(newNum);
      moves.push({
        prevNum,
        newNum,
        entry: {
          univ: newRow.univ,
          team: newRow.team,
          type: newRow.type || null,
          active: newRow.active,
          active_revision: newRow.active_revision,
        },
        oldEntry: oldRow,
      });
    }
  }
  for (const oldRow of oldRows) {
    if (matchedOldNums.has(oldRow.num)) continue;
    const identity = entryIdentity(oldRow);
    const matchedNew = oldIdentityCounts.get(identity) === 1 ? uniqueNewByIdentity.get(identity) : null;
    if (matchedNew && !explicitTargets.has(matchedNew.num)) {
      matchedOldNums.add(oldRow.num);
      retainedOldRowsByNewNum.set(matchedNew.num, oldRow);
      if (oldRow.num !== matchedNew.num) {
        movedTargetNums.add(matchedNew.num);
        moves.push({
          prevNum: oldRow.num,
          newNum: matchedNew.num,
          entry: {
            univ: matchedNew.univ,
            team: matchedNew.team,
            type: matchedNew.type || null,
            active: matchedNew.active,
            active_revision: matchedNew.active_revision,
          },
          oldEntry: oldRow,
        });
      }
    }
  }
  // 번호가 사라졌거나(삭제) 다른 팀이 그 번호로 이동(displaced)한 경우는 삭제.
  // 번호는 신규 목록에 그대로 있는데 identity 매칭에서 빠진 경우는 "동일 번호에서
  // 팀이 바뀜" — 명칭 정정인지 팀 교체인지 페이로드만으로 알 수 없으므로, 운영자가
  // replacements/retains로 명시하지 않으면 조용히 승계하지 않고 ambiguous로 보고한다.
  const ambiguous = [];
  for (const oldRow of oldRows) {
    if (matchedOldNums.has(oldRow.num)) continue;
    if (!newNums.has(oldRow.num) || movedTargetNums.has(oldRow.num)) {
      deletedNums.push(oldRow.num);
      continue;
    }
    const newRow = newRowsByNum.get(oldRow.num);
    if (entryIdentity(newRow) === entryIdentity(oldRow)) {
      // 동일 display identity가 여러 팀에 중복되어 unique identity 매칭에서 제외됐어도
      // 같은 번호를 유지했다면 이 old row가 정확한 상태 비교 대상이다.
      retainedOldRowsByNewNum.set(oldRow.num, oldRow);
      continue; // 동일 팀 유지 → 이벤트 없음
    }
    if (replacements.has(oldRow.num)) {
      deletedNums.push(oldRow.num); // 팀 교체 확정 → 기존 downstream 데이터 삭제
    } else if (retains.has(oldRow.num)) {
      retainedOldRowsByNewNum.set(oldRow.num, oldRow);
      continue; // 명칭 정정 확정 → 기존 데이터 유지(이벤트 없음)
    } else {
      ambiguous.push({
        num: oldRow.num,
        from: { univ: oldRow.univ, team: oldRow.team },
        to: { univ: newRow.univ, team: newRow.team },
      });
    }
  }
  if (ambiguous.length > 0) {
    return { events: [], deletedNums: [], renumberCount: 0, ambiguous, retainedOldRowsByNewNum };
  }

  const events = [
    ...buildEntryDeletedEvents(deletedNums, year),
  ];
  const reservedNums = [
    ...oldRows.map((row) => row.num),
    ...newRowsByNum.keys(),
  ];
  for (const move of buildRenumberPlan(moves, reservedNums)) {
    events.push(...buildEntryRenumberedEvents(move.prevNum, move.newNum, year, move.entry));
  }
  return { events, deletedNums, renumberCount: moves.length, ambiguous, retainedOldRowsByNewNum };
}

/* ============================================
   연도/테이블 미들웨어
   ============================================ */
function withYearTable(req, res, next) {
  const year = req.query.year || new Date().getFullYear();
  try {
    req.tableName = ensureYearTable(year);
    req.year = year;
    next();
  } catch (e) {
    return res.status(400).send(e.message);
  }
}

/* ============================================
   API 라우트: /api/years, /api/entries
   ============================================ */

// GET /api/years - 사용 가능한 연도 목록
app.get("/api/years", (req, res) => {
  res.json(getAvailableYears());
});

// GET /api/entries - 모든 엔트리 조회
app.get("/api/entries", withYearTable, (req, res) => {
  const { tableName, year } = req;
  const includeInactive = req.query.includeInactive === "true";

  const result = dbRun(() => {
    const data = {};
    const rows = db.prepare(`
      SELECT num, univ, team, type, active
      FROM '${tableName}'
      ${includeInactive ? "" : "WHERE active = 1"}
    `).all();
    for (const row of rows) {
      data[row.num] = { univ: row.univ, team: row.team, type: row.type, active: !!row.active };
    }
    return data;
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  if (req.query.download !== undefined) {
    res.setHeader("Content-Disposition", `attachment; filename="entry_${year}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(result.result, null, 2));
  } else {
    res.json(result.result);
  }
});

// POST /api/entries - 새 엔트리 추가
app.post("/api/entries", withYearTable, (req, res) => {
  const { tableName, year } = req;

  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }
  if (numValidation.value >= LIFECYCLE_TEMP_NUM_START) {
    return res.status(400).send(numValidation.error);
  }

  const dataValidation = validateEntryData(req.body, year);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const result = dbRun(() =>
    db.transaction(() => {
      assertNoPendingLifecycleRefs([numValidation.value], year);
      const revision = nextActiveRevision();
      return db
        .prepare(`INSERT INTO '${tableName}' (num, univ, team, type, active, active_revision) VALUES (?, ?, ?, ?, 1, ?)`)
        .run(numValidation.value, dataValidation.univ, dataValidation.team, dataValidation.type, revision);
    })(),
  );

  if (!result.success) {
    logger.warn(req, "entry.create", { error: result.error, year }, `#${numValidation.value}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.create", { year, univ: dataValidation.univ, team: dataValidation.team, type: dataValidation.type }, `#${numValidation.value}`);
  broadcastEntries(year, "create", { num: numValidation.value });
  res.status(201).send();
});

// PATCH /api/entries/:num - 엔트리 수정
app.patch("/api/entries/:num", withYearTable, async (req, res) => {
  const { tableName, year } = req;

  const prevNumValidation = validateEntryNum(req.params.num);
  if (!prevNumValidation.valid) {
    return res.status(400).send(prevNumValidation.error);
  }

  const newNumValidation = validateEntryNum(req.body.num);
  if (!newNumValidation.valid) {
    return res.status(400).send(newNumValidation.error);
  }
  if (newNumValidation.value >= LIFECYCLE_TEMP_NUM_START) {
    return res.status(400).send(newNumValidation.error);
  }

  const dataValidation = validateEntryData(req.body, year);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const prevNum = prevNumValidation.value;
  const newNum = newNumValidation.value;
  const numChanged = prevNum !== newNum;
  // 같은 번호를 유지한 채 팀 정체성(학교/팀명)이 바뀌는 경우 retain/replacement intent.
  const intent = req.body.intent;

  const result = dbRun(() => {
    return db.transaction(() => {
      let events = [];
      if (numChanged) {
        // 번호 변경과 팀 정체성(학교/팀명) 변경이 한 요청에 함께 오면 순수 renumber로 처리돼
        // prevNum의 downstream(검차·대기열 등)이 newNum의 다른 팀에게 조용히 승계된다. same-num
        // 경로와 동일하게, 정체성이 바뀌면 명시적 intent="retain"(명칭 정정 후 이동)일 때만
        // 허용하고, 아니면 409로 거부한다(팀 교체는 삭제 후 재등록으로 처리).
        const existingPrev = db.prepare(`SELECT univ, team, active, active_revision FROM '${tableName}' WHERE num = ?`).get(prevNum);
        if (!existingPrev) {
          throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
        }
        if (entryIdentity(existingPrev) !== entryIdentity(dataValidation) && intent !== "retain") {
          throw { status: 409, message: "번호와 팀 정보를 동시에 변경할 수 없습니다. 팀 정보를 유지한 채 번호만 옮기거나, 팀 교체는 삭제 후 재등록하세요." };
        }
        assertNoPendingLifecycleRefs([prevNum, newNum], year);
        const numResult = db.prepare(`UPDATE '${tableName}' SET num = ? WHERE num = ?`).run(newNum, prevNum);
        if (!numResult.changes) {
          throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
        }
      } else {
        // 번호가 그대로일 때 identity 변경 여부를 확인한다. 명칭 정정인지 팀 교체인지
        // 페이로드만으로 알 수 없으므로, intent 미선언이면 bulk와 동일하게 ambiguous(409)로 보고하고
        // 아무것도 쓰지 않는다(읽기 전용 트랜잭션). 다른 팀이 downstream을 조용히 승계하지 못하게 막는다.
        const existing = db.prepare(`SELECT univ, team FROM '${tableName}' WHERE num = ?`).get(newNum);
        if (!existing) {
          throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
        }
        if (entryIdentity(existing) !== entryIdentity(dataValidation)) {
          if (intent === "replacement") {
            assertNoPendingLifecycleRefs([newNum], year);
            events = buildEntryDeletedEvents([newNum], year); // 팀 교체 확정 → 기존 downstream 삭제
          } else if (intent !== "retain") {
            return {
              ambiguous: [{
                num: newNum,
                from: { univ: existing.univ, team: existing.team },
                to: { univ: dataValidation.univ, team: dataValidation.team },
              }],
            };
          }
          // intent === "retain" → 명칭 정정 확정 → downstream 유지(이벤트 없음)
        }
      }

      const updateResult = db.prepare(`UPDATE '${tableName}' SET univ = ?, team = ?, type = ? WHERE num = ?`)
        .run(dataValidation.univ, dataValidation.team, dataValidation.type, newNum);

      if (!updateResult.changes) {
        throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
      }

      if (numChanged) {
        // 번호 재사용 목적지에 dead-letter된 과거 팀의 status snapshot이 남아 있을 수
        // 있으므로, 단순 renumber에도 새 revision을 발급해 현재 활성 상태를 뒤이어
        // fan-out한다. renumber가 먼저 적용된 뒤 snapshot이 목적지를 수렴시킨다.
        const revision = nextActiveRevision();
        db.prepare(`UPDATE '${tableName}' SET active_revision = ? WHERE num = ?`).run(revision, newNum);
        const status = db.prepare(`SELECT active FROM '${tableName}' WHERE num = ?`).get(newNum);
        const entry = {
          univ: dataValidation.univ,
          team: dataValidation.team,
          type: dataValidation.type,
          active: !!status.active,
          active_revision: revision,
        };
        events = [
          ...buildEntryRenumberedEvents(prevNum, newNum, year, entry),
          ...buildEntryActiveEvents(newNum, year, entry.active, revision),
        ];
      }

      return { eventIds: insertLifecycleEvents(events) };
    })();
  });

  if (!result.success) {
    logger.warn(req, "entry.update", { error: result.error, year }, `#${newNum}`);
    return res.status(result.status).send(result.error);
  }

  if (result.result.ambiguous) {
    const ambiguous = result.result.ambiguous;
    logger.warn(req, "entry.update_ambiguous", { year, nums: ambiguous.map((a) => a.num) });
    return res.status(409).json({
      message: "동일 번호에서 팀이 변경되었습니다. 명칭 정정(데이터 유지)인지 팀 교체(데이터 삭제)인지 선택해 주세요.",
      ambiguous,
    });
  }

  if (numChanged || intent === "replacement") {
    warnUnconfiguredLifecycleServices(req, { op: numChanged ? "renumber" : "replacement", year, prevNum, newNum });
  }

  broadcastEntries(year, "update", { num: newNum, prevNum });

  const eventIds = result.result.eventIds;
  if (eventIds.length > 0) {
    await processLifecycleOutbox({ ids: eventIds });
    logger.log(req, numChanged ? "entry.notify_renumber" : "entry.notify_replacement",
      { year, prevNum, newNum, events: eventIds.length }, `#${newNum}`);
    if (sendLifecyclePending(res, eventIds, numChanged
      ? "엔트리 번호 변경은 반영되었고 일부 서비스 동기화는 재시도 대기 중입니다."
      : "엔트리 팀 교체는 반영되었고 일부 서비스 동기화는 재시도 대기 중입니다.")) return;
  }

  logger.log(req, "entry.update", { year, univ: dataValidation.univ, team: dataValidation.team, type: dataValidation.type }, `#${newNum}`);
  res.status(200).send();
});

// PATCH /api/entries/:num/active - 엔트리 활성/비활성 상태 변경
app.patch("/api/entries/:num/active", withYearTable, async (req, res) => {
  const { tableName, year } = req;
  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) return res.status(400).send(numValidation.error);
  if (typeof req.body.active !== "boolean") return res.status(400).send("active는 boolean이어야 합니다.");

  const num = numValidation.value;
  const active = req.body.active;
  const result = dbRun(() => db.transaction(() => {
    const existing = db.prepare(`SELECT active, active_revision FROM '${tableName}' WHERE num = ?`).get(num);
    if (!existing) throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
    if (!!existing.active === active) return { changed: false, revision: existing.active_revision, eventIds: [] };

    assertNoPendingLifecycleRefs([num], year);
    const revision = nextActiveRevision();
    db.prepare(`UPDATE '${tableName}' SET active = ?, active_revision = ? WHERE num = ?`)
      .run(active ? 1 : 0, revision, num);
    const eventIds = insertLifecycleEvents(buildEntryActiveEvents(num, year, active, revision));
    return { changed: true, revision, eventIds };
  })());

  if (!result.success) {
    logger.warn(req, "entry.active", { error: result.error, year, active }, `#${num}`);
    return res.status(result.status).send(result.error);
  }
  if (!result.result.changed) return res.status(200).send();

  logger.log(req, active ? "entry.activate" : "entry.deactivate", { year, revision: result.result.revision }, `#${num}`);
  broadcastEntries(year, "active", { num, active, revision: result.result.revision });
  warnUnconfiguredLifecycleServices(
    req,
    { op: active ? "activate" : "deactivate", year, nums: [num] },
    { activeOnly: true },
  );

  await processLifecycleOutbox({ ids: result.result.eventIds });
  if (sendLifecyclePending(
    res,
    result.result.eventIds,
    active
      ? "엔트리 재활성화는 반영되었고 일부 서비스 동기화는 재시도 대기 중입니다."
      : "엔트리 비활성화는 반영되었고 일부 서비스 동기화는 재시도 대기 중입니다.",
  )) return;
  res.status(200).send();
});

// DELETE /api/entries/:num - 엔트리 삭제
app.delete("/api/entries/:num", withYearTable, async (req, res) => {
  const { tableName, year } = req;

  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const result = dbRun(() => db.transaction(() => {
    const entry = db.prepare(`SELECT univ, team FROM '${tableName}' WHERE num = ?`).get(numValidation.value);
    if (entry) assertNoPendingLifecycleRefs([numValidation.value], year);
    const deleteResult = db.prepare(`DELETE FROM '${tableName}' WHERE num = ?`).run(numValidation.value);
    const eventIds = deleteResult.changes
      ? insertLifecycleEvents(buildEntryDeletedEvents([numValidation.value], year))
      : [];
    return { deleteResult, entry, eventIds };
  })());

  if (!result.success) {
    logger.warn(req, "entry.delete", { error: result.error, year }, `#${numValidation.value}`);
    return res.status(result.status).send(result.error);
  }

  if (!result.result.deleteResult.changes) {
    logger.warn(req, "entry.delete", { year, reason: "not_found" }, `#${numValidation.value}`);
    return res.status(404).send("존재하지 않는 엔트리 번호입니다.");
  }

  const { entry, eventIds } = result.result;
  logger.log(req, "entry.delete", { year, univ: entry?.univ, team: entry?.team }, `#${numValidation.value}`);
  broadcastEntries(year, "delete", { num: numValidation.value });

  warnUnconfiguredLifecycleServices(req, { op: "delete", year, nums: [numValidation.value] });
  await processLifecycleOutbox({ ids: eventIds });
  logger.log(req, "entry.notify_delete", { year, nums: [numValidation.value] }, `#${numValidation.value}`);
  if (sendLifecyclePending(res, eventIds, "엔트리 삭제는 반영되었고 일부 서비스 동기화는 재시도 대기 중입니다.")) return;
  res.status(200).send();
});

// DELETE /api/entries - 모든 엔트리 삭제
app.delete("/api/entries", withYearTable, async (req, res) => {
  const { tableName, year } = req;

  const result = dbRun(() => db.transaction(() => {
    const existingNums = db.prepare(`SELECT num FROM '${tableName}'`).all().map(r => r.num);
    assertNoPendingLifecycleRefs(existingNums, year);
    const deleteResult = db.prepare(`DELETE FROM '${tableName}'`).run();
    const eventIds = existingNums.length > 0
      ? insertLifecycleEvents(buildEntryDeletedEvents(existingNums, year))
      : [];
    return { existingNums, deleteResult, eventIds };
  })());

  if (!result.success) {
    logger.warn(req, "entry.clear", { error: result.error, year });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.clear", { year });

  const { existingNums, eventIds } = result.result;
  if (existingNums.length > 0) broadcastEntries(year, "clear");
  if (existingNums.length > 0) {
    warnUnconfiguredLifecycleServices(req, { op: "clear", year, count: existingNums.length });
    await processLifecycleOutbox({ ids: eventIds });
    logger.log(req, "entry.notify_delete", { year, count: existingNums.length });
    if (sendLifecyclePending(res, eventIds, "엔트리 전체 삭제는 반영되었고 일부 서비스 동기화는 재시도 대기 중입니다.")) return;
  }
  res.status(200).send();
});

// POST /api/entries/bulk - 엔트리 일괄 업로드 (DB 교체)
app.post("/api/entries/bulk", withYearTable, async (req, res) => {
  const { tableName, year } = req;

  const validation = validateBulkData(req.body.data);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }
  const renumberValidation = validateBulkRenumbers(req.body.renumbers);
  if (!renumberValidation.valid) {
    return res.status(400).send(renumberValidation.error);
  }
  const replacementsValidation = validateBulkIntentList(req.body.replacements, "팀 교체");
  if (!replacementsValidation.valid) {
    return res.status(400).send(replacementsValidation.error);
  }
  const retainsValidation = validateBulkIntentList(req.body.retains, "명칭 정정");
  if (!retainsValidation.valid) {
    return res.status(400).send(retainsValidation.error);
  }

  const result = dbRun(() => {
    return db.transaction(() => {
      const oldRows = db.prepare(`SELECT num, univ, team, type, active, active_revision FROM '${tableName}'`).all();
      const vtTable = ensureVtTable(year);
      const validTypes = new Set(db.prepare(`SELECT name FROM '${vtTable}'`).all().map(t => t.name));
      const newRowsByNum = new Map();
      const query = db.prepare(`INSERT INTO '${tableName}' (num, univ, team, type, active, active_revision) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const [k, v] of Object.entries(validation.data)) {
        const validatedType = v.type || null;
        if (validatedType && !validTypes.has(validatedType)) {
          throw { status: 400, message: `엔트리 ${k}: 존재하지 않는 차량 유형 '${validatedType}'` };
        }
        newRowsByNum.set(Number(k), {
          num: Number(k),
          univ: v.univ.trim(),
          team: v.team.trim(),
          type: validatedType,
          active: v.active !== false,
          active_revision: nextActiveRevision(),
        });
      }

      assertNoPendingLifecycleRefs([
        ...oldRows.map((row) => row.num),
        ...newRowsByNum.keys(),
      ], year);
      const { events, deletedNums, renumberCount, ambiguous, retainedOldRowsByNewNum } = buildBulkLifecycleEvents(
        oldRows, newRowsByNum, year, renumberValidation.renumbers, replacementsValidation.nums, retainsValidation.nums,
      );
      // 동일 번호의 팀 변경이 미선언 상태면 아무것도 쓰지 않고(읽기 전용 트랜잭션)
      // 운영자에게 의도 확인을 요청한다.
      if (ambiguous.length > 0) {
        return { ambiguous };
      }

      db.prepare(`DELETE FROM '${tableName}'`).run();
      for (const row of newRowsByNum.values()) {
        query.run(row.num, row.univ, row.team, row.type, row.active ? 1 : 0, row.active_revision);
      }
      const activeEvents = [...newRowsByNum.values()].flatMap((row) => {
        const oldRow = retainedOldRowsByNewNum.get(row.num) || null;
        // 번호가 바뀐 retained 팀에는 활성 상태가 같아도 snapshot 이벤트를 보낸다.
        // 기본 활성 팀은 소비자에 team_status 행이 없을 수 있고, dead-letter 처리된
        // 과거 삭제 때문에 목적지 번호에 다른 팀의 stale snapshot이 남아 있을 수 있다.
        // renumber 뒤의 새 revision 이벤트가 그 목적지를 현재 Entry 상태로 수렴시킨다.
        if (oldRow && oldRow.num === row.num && !!oldRow.active === row.active) return [];
        // 신규/교체 엔트리의 활성 기본값은 true다. 기존 팀은 번호가 바뀌었더라도
        // 항상 현재 상태를 fan-out하고, 신규/교체 비활성 팀도 명시적으로 전파한다.
        if (!oldRow && row.active) return [];
        return buildEntryActiveEvents(row.num, year, row.active, row.active_revision);
      });
      const eventIds = insertLifecycleEvents([...events, ...activeEvents]);
      return { deletedNums, renumberCount, eventIds };
    })();
  });

  if (!result.success) {
    logger.warn(req, "entry.bulk_upload", { error: result.error, year });
    return res.status(result.status).send(result.error);
  }

  if (result.result.ambiguous) {
    const ambiguous = result.result.ambiguous;
    logger.warn(req, "entry.bulk_upload_ambiguous", { year, nums: ambiguous.map((a) => a.num) });
    return res.status(409).json({
      message: "동일 번호에서 팀이 변경되었습니다. 명칭 정정(데이터 유지)인지 팀 교체(데이터 삭제)인지 선택해 주세요.",
      ambiguous,
    });
  }

  logger.log(req, "entry.bulk_upload", { year, count: Object.keys(validation.data).length });
  broadcastEntries(year, "bulk");

  const { deletedNums, renumberCount, eventIds } = result.result;
  if (deletedNums.length > 0 || renumberCount > 0) {
    warnUnconfiguredLifecycleServices(req, { op: "bulk", year, deleted: deletedNums.length, renumbered: renumberCount });
  }
  if (eventIds.length > 0) {
    await processLifecycleOutbox({ ids: eventIds });
    logger.log(req, "entry.notify_bulk_lifecycle", { year, deleted: deletedNums.length, renumbered: renumberCount, events: eventIds.length, nums: deletedNums });
    if (sendLifecyclePending(res, eventIds, "엔트리 일괄 업로드는 반영되었고 일부 서비스 동기화는 재시도 대기 중입니다.")) return;
  }
  res.status(200).send();
});

/* ============================================
   API 라우트: /api/vehicle-types
   ============================================ */

function withYearVtTable(req, res, next) {
  const year = req.query.year || new Date().getFullYear();
  try {
    req.vtTableName = ensureVtTable(year);
    req.vtYear = year;
    next();
  } catch (e) {
    return res.status(400).send(e.message);
  }
}

// GET /api/vehicle-types - 차량 유형 목록
app.get("/api/vehicle-types", withYearVtTable, (req, res) => {
  const result = dbRun(() => db.prepare(`SELECT * FROM '${req.vtTableName}' ORDER BY sort_order, id`).all());
  if (!result.success) return res.status(result.status).send(result.error);
  res.json(result.result);
});

// POST /api/vehicle-types - 차량 유형 추가
app.post("/api/vehicle-types", withYearVtTable, (req, res) => {
  const { vtTableName, vtYear } = req;
  const { name, color } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).send("유형 이름을 입력하세요.");
  }

  const safeColor = VEHICLE_COLORS.includes(color) ? color : "blue";
  const maxOrder = db.prepare(`SELECT MAX(sort_order) as max FROM '${vtTableName}'`).get();
  const nextOrder = (maxOrder?.max ?? -1) + 1;
  const result = dbRun(() =>
    db.prepare(`INSERT INTO '${vtTableName}' (name, sort_order, color) VALUES (?, ?, ?)`).run(name.trim(), nextOrder, safeColor),
  );
  if (!result.success) {
    if (result.error.includes("UNIQUE")) {
      logger.warn(req, "vehicle_type.create", { error: "duplicate" }, name.trim());
      return res.status(400).send("이미 존재하는 차량 유형입니다.");
    }
    logger.warn(req, "vehicle_type.create", { error: result.error }, name.trim());
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "vehicle_type.create", { color: safeColor }, name.trim());
  broadcastEntries(vtYear, "vehicle-type");
  res.status(201).json({ id: result.result.lastInsertRowid, name: name.trim(), sort_order: nextOrder, color: safeColor });
});

// PATCH /api/vehicle-types/:id - 차량 유형 수정 (이름, 색상)
app.patch("/api/vehicle-types/:id", withYearVtTable, (req, res) => {
  const { vtTableName, vtYear } = req;
  const id = Number(req.params.id);
  if (!id) return res.status(400).send("올바르지 않은 ID입니다.");

  const type = db.prepare(`SELECT name, color FROM '${vtTableName}' WHERE id = ?`).get(id);
  if (!type) {
    logger.warn(req, "vehicle_type.update", { id, reason: "not_found" });
    return res.status(404).send("존재하지 않는 차량 유형입니다.");
  }

  const { name, color } = req.body;
  const updates = [];
  const params = [];

  if (color !== undefined) {
    if (!VEHICLE_COLORS.includes(color)) return res.status(400).send("올바르지 않은 색상입니다.");
    updates.push("color = ?");
    params.push(color);
  }

  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).send("유형 이름을 입력하세요.");
    if (trimmed !== type.name) {
      const dup = db.prepare(`SELECT id FROM '${vtTableName}' WHERE name = ? AND id != ?`).get(trimmed, id);
      if (dup) return res.status(400).send("이미 존재하는 차량 유형입니다.");
      updates.push("name = ?");
      params.push(trimmed);
    }
  }

  if (updates.length === 0) return res.status(200).send();

  params.push(id);
  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare(`UPDATE '${vtTableName}' SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      // 이름 변경 시 해당 연도 엔트리의 type도 갱신
      const newName = name?.trim();
      if (newName && newName !== type.name) {
        const entryTable = getTableName(vtYear);
        db.prepare(`UPDATE '${entryTable}' SET type = ? WHERE type = ?`).run(newName, type.name);
      }
    })();
  });

  if (!result.success) {
    logger.warn(req, "vehicle_type.update", { error: result.error }, type.name);
    return res.status(result.status).send(result.error);
  }
  const detail = {};
  if (color !== undefined) detail.color = color;
  if (name?.trim() && name.trim() !== type.name) detail.name = { from: type.name, to: name.trim() };
  logger.log(req, "vehicle_type.update", detail, type.name);
  broadcastEntries(vtYear, "vehicle-type");
  res.status(200).send();
});

// DELETE /api/vehicle-types/:id - 차량 유형 삭제
app.delete("/api/vehicle-types/:id", withYearVtTable, (req, res) => {
  const { vtTableName, vtYear } = req;
  const id = Number(req.params.id);
  if (!id) return res.status(400).send("올바르지 않은 ID입니다.");

  const type = db.prepare(`SELECT name FROM '${vtTableName}' WHERE id = ?`).get(id);
  if (!type) return res.status(404).send("존재하지 않는 차량 유형입니다.");

  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare(`DELETE FROM '${vtTableName}' WHERE id = ?`).run(id);
      const entryTable = getTableName(vtYear);
      db.prepare(`UPDATE '${entryTable}' SET type = NULL WHERE type = ?`).run(type.name);
    })();
  });

  if (!result.success) {
    logger.warn(req, "vehicle_type.delete", { error: result.error }, type.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "vehicle_type.delete", null, type.name);
  broadcastEntries(vtYear, "vehicle-type");
  res.status(200).send();
});

return { app, db, stopLifecycleOutboxRetry: () => clearInterval(lifecycleRetryTimer) };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createEntryApp();
  setupProcessHandlers(db);
  app.listen(PORT, () => console.log(`Entry service running on port ${PORT}`));
}
