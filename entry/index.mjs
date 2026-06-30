import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { validateEntryNum } from "../shared/validation.mjs";
import { VEHICLE_COLORS } from "../shared/constants.js";

export function createEntryApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/entry.db");

// 연도별 차량 유형 테이블 헬퍼
function getVtTableName(year) {
  const y = Number(year) || new Date().getFullYear();
  if (!/^\d{4}$/.test(String(y)) || y < 2000 || y > 2099) {
    throw new Error("올바르지 않은 연도입니다.");
  }
  return `vehicle_types_${y}`;
}

function ensureVtTable(year) {
  const tableName = getVtTableName(year);
  db.exec(`CREATE TABLE IF NOT EXISTS '${tableName}' (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT 'blue'
  )`);
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
  const y = Number(year) || new Date().getFullYear();
  if (!/^\d{4}$/.test(String(y)) || y < 2000 || y > 2099) {
    throw new Error("올바르지 않은 연도입니다.");
  }
  return `entry_${y}`;
}

function ensureYearTable(year) {
  const tableName = getTableName(year);
  const y = Number(year) || new Date().getFullYear();
  db.exec(`CREATE TABLE IF NOT EXISTS '${tableName}' (
    num INTEGER PRIMARY KEY, univ TEXT NOT NULL, team TEXT NOT NULL, type TEXT DEFAULT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_${y}_type ON '${tableName}'(type)`);
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
try { db.exec("ALTER TABLE lifecycle_outbox ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE lifecycle_outbox ADD COLUMN locked_by TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
db.exec("CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_ready ON lifecycle_outbox(status, next_attempt_at, id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_service_id ON lifecycle_outbox(service, id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_service_status_id ON lifecycle_outbox(service, status, id)");

// 기존 테이블에 type 컬럼 마이그레이션
for (const year of getAvailableYears()) {
  const tableName = getTableName(year);
  try { db.exec(`ALTER TABLE '${tableName}' ADD COLUMN type TEXT DEFAULT NULL`); }
  catch (e) { /* column already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_${Number(year)}_type ON '${tableName}'(type)`);
}

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "entry");

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path === "/api/years") return null;
  if (req.path === "/api/entries" && req.method === "GET") return null;
  if (req.path === "/api/vehicle-types" && req.method === "GET") return null;
  return "admin";
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

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
    if (!Number.isInteger(prevNum) || prevNum < 1 || prevNum >= LIFECYCLE_TEMP_NUM_START ||
        !Number.isInteger(newNum) || newNum < 1 || newNum >= LIFECYCLE_TEMP_NUM_START ||
        targets.has(newNum)) {
      return { valid: false, error: "올바르지 않은 번호 변경 매핑입니다." };
    }
    renumbers.set(prevNum, newNum);
    targets.add(newNum);
  }
  return { valid: true, renumbers };
}

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   서비스 간 알림 헬퍼
   ============================================ */
const LIFECYCLE_SERVICES = [
  { name: "queue", env: "QUEUE_SERVER" },
  { name: "documents", env: "DOCUMENTS_SERVER" },
  { name: "inspection", env: "INSPECTION_SERVER" },
  { name: "score", env: "SCORE_SERVER" },
  { name: "traffic", env: "TRAFFIC_SERVER" },
];

let lifecycleOutboxTail = Promise.resolve();
let lifecycleOutboxRetryQueued = false;
const LIFECYCLE_LOCK_MS = 30_000;
const LIFECYCLE_WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2)}`;
const LIFECYCLE_TEMP_NUM_START = 1_000_000_000;

function configuredLifecycleServices() {
  return LIFECYCLE_SERVICES.filter((svc) => process.env[svc.env]);
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
  const delayMs = Math.min(5 * 60_000, 1000 * 2 ** Math.min(attempts, 8));
  db.prepare(`
    UPDATE lifecycle_outbox
    SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?,
        locked_until = 0, locked_by = '', updated_at = strftime('%s','now') * 1000
    WHERE id = ? AND locked_by = ?
  `).run(attempts, Date.now() + delayMs, String(error).slice(0, 500), row.id, row.locked_by || LIFECYCLE_WORKER_ID);
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
  const server = lifecycleServer(row.service);
  if (!server) {
    markLifecycleFailed(claimed, `missing server env for ${row.service}`);
    return false;
  }
  try {
    const res = await fetch(`${server}${row.path}`, {
      method: row.method,
      headers: lifecycleHeaders(!!row.body),
      body: row.body || undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    if (res.status === 202) throw new Error("status 202 pending");
    markLifecycleDelivered(claimed);
    return true;
  } catch (e) {
    markLifecycleFailed(claimed, e.message || e);
    logger.warn(null, "entry.lifecycle_dispatch_fail", {
      id: row.id,
      event_type: row.event_type,
      service: row.service,
      path: row.path,
      attempts: row.attempts + 1,
      error: e.message || String(e),
    });
    return false;
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
      for (const row of rows) {
        const delivered = await deliverLifecycleRow(row);
        deliveredRows += 1;
        if (!delivered) blockedServices.add(row.service);
      }
    }
    return;
  }
  const blockedServices = new Set();
  for (const row of rows) {
    if (blockedServices.has(row.service)) continue;
    if (row.status === "processing" && row.locked_until > now && row.locked_by !== LIFECYCLE_WORKER_ID) {
      blockedServices.add(row.service);
      continue;
    }
    const delivered = await deliverLifecycleRow(row, { ignoreDelay: true });
    if (!delivered) blockedServices.add(row.service);
  }
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

startLifecycleOutboxRetry();

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

function buildBulkLifecycleEvents(oldRows, newRowsByNum, year, explicitRenumbers = new Map()) {
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
    if (prevNum !== newNum) {
      movedTargetNums.add(newNum);
      moves.push({
        prevNum,
        newNum,
        entry: {
          univ: newRow.univ,
          team: newRow.team,
          type: newRow.type || null,
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
      if (oldRow.num !== matchedNew.num) {
        movedTargetNums.add(matchedNew.num);
        moves.push({
          prevNum: oldRow.num,
          newNum: matchedNew.num,
          entry: {
            univ: matchedNew.univ,
            team: matchedNew.team,
            type: matchedNew.type || null,
          },
          oldEntry: oldRow,
        });
      }
    }
  }
  for (const oldRow of oldRows) {
    if (matchedOldNums.has(oldRow.num)) continue;
    if (!newNums.has(oldRow.num) || movedTargetNums.has(oldRow.num)) deletedNums.push(oldRow.num);
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
  return { events, deletedNums, renumberCount: moves.length };
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

  const result = dbRun(() => {
    const data = {};
    for (const row of db.prepare(`SELECT * FROM '${tableName}'`).all()) {
      data[row.num] = { univ: row.univ, team: row.team, type: row.type };
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
      return db
        .prepare(`INSERT INTO '${tableName}' (num, univ, team, type) VALUES (?, ?, ?, ?)`)
        .run(numValidation.value, dataValidation.univ, dataValidation.team, dataValidation.type);
    })(),
  );

  if (!result.success) {
    logger.warn(req, "entry.create", { error: result.error, year }, `#${numValidation.value}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.create", { year, univ: dataValidation.univ, team: dataValidation.team, type: dataValidation.type }, `#${numValidation.value}`);
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

  const result = dbRun(() => {
    return db.transaction(() => {
      let eventIds = [];
      if (numChanged) {
        assertNoPendingLifecycleRefs([prevNum, newNum], year);
        const numResult = db.prepare(`UPDATE '${tableName}' SET num = ? WHERE num = ?`).run(newNum, prevNum);
        if (!numResult.changes) {
          throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
        }
      }

      const updateResult = db.prepare(`UPDATE '${tableName}' SET univ = ?, team = ?, type = ? WHERE num = ?`)
        .run(dataValidation.univ, dataValidation.team, dataValidation.type, newNum);

      if (!updateResult.changes) {
        throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
      }

      if (numChanged) {
        eventIds = insertLifecycleEvents(buildEntryRenumberedEvents(prevNum, newNum, year, {
          univ: dataValidation.univ,
          team: dataValidation.team,
          type: dataValidation.type,
        }));
      }

      return { updateResult, eventIds };
    })();
  });

  if (!result.success) {
    logger.warn(req, "entry.update", { error: result.error, year }, `#${newNum}`);
    return res.status(result.status).send(result.error);
  }

  if (numChanged) {
    await processLifecycleOutbox({ ids: result.result.eventIds });
    logger.log(req, "entry.notify_renumber", { year, prevNum, newNum, events: result.result.eventIds.length }, `#${newNum}`);
    if (sendLifecyclePending(res, result.result.eventIds, "엔트리 번호 변경은 반영되었고 일부 서비스 동기화는 재시도 대기 중입니다.")) return;
  }

  logger.log(req, "entry.update", { year, univ: dataValidation.univ, team: dataValidation.team, type: dataValidation.type }, `#${newNum}`);
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
  if (existingNums.length > 0) {
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

  const result = dbRun(() => {
    return db.transaction(() => {
      const oldRows = db.prepare(`SELECT num, univ, team, type FROM '${tableName}'`).all();
      const vtTable = ensureVtTable(year);
      const validTypes = new Set(db.prepare(`SELECT name FROM '${vtTable}'`).all().map(t => t.name));
      const newRowsByNum = new Map();
      const query = db.prepare(`INSERT INTO '${tableName}' (num, univ, team, type) VALUES (?, ?, ?, ?)`);
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
        });
      }

      assertNoPendingLifecycleRefs([
        ...oldRows.map((row) => row.num),
        ...newRowsByNum.keys(),
      ], year);
      const { events, deletedNums, renumberCount } = buildBulkLifecycleEvents(oldRows, newRowsByNum, year, renumberValidation.renumbers);

      db.prepare(`DELETE FROM '${tableName}'`).run();
      for (const row of newRowsByNum.values()) {
        query.run(row.num, row.univ, row.team, row.type);
      }
      const eventIds = insertLifecycleEvents(events);
      return { deletedNums, renumberCount, eventIds };
    })();
  });

  if (!result.success) {
    logger.warn(req, "entry.bulk_upload", { error: result.error, year });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.bulk_upload", { year, count: Object.keys(validation.data).length });

  const { deletedNums, renumberCount, eventIds } = result.result;
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
  const { vtTableName } = req;
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
  res.status(200).send();
});

return { app, db };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createEntryApp();
  setupProcessHandlers(db);
  app.listen(9200);
}
