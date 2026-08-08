import express from "express";
import Database from "better-sqlite3";
import { createServiceSkeleton, runIfDirect } from "../shared/service-bootstrap.mjs";
import { requireInternalRequest } from "../shared/express-setup.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { validateEntryNum } from "../shared/validation.mjs";
import { VEHICLE_COLORS } from "../shared/constants.js";
import { serviceUrl } from "../shared/services.mjs";

export function createEntryApp(options = {}) {

const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "entry", express, Database, options,
  authRoleFn: (req) => {
    if (req.path === "/api/health") return null;
    if (req.path === "/api/years") return null;
    if (req.path === "/api/entries" && req.method === "GET" && req.query.includeInactive !== "true") return null;
    if (req.path === "/api/vehicle-types" && req.method === "GET") return null;
    return "admin";
  },
});

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
  try { db.exec(`ALTER TABLE '${tableName}' ADD COLUMN id INTEGER`); }
  catch { /* column already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_${y}_type ON '${tableName}'(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_${y}_active ON '${tableName}'(active)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_${y}_id ON '${tableName}'(id)`);
  // 레거시 행에 불변 id 발급 (프로세스당 1회, 멱등 — id IS NULL인 행만)
  db.transaction(() => {
    for (const row of db.prepare(`SELECT num FROM '${tableName}' WHERE id IS NULL`).all()) {
      db.prepare(`UPDATE '${tableName}' SET id = ? WHERE num = ?`).run(nextTeamId(), row.num);
    }
  })();
  _ensuredYearTables.add(tableName);
  return tableName;
}

function getAvailableYears() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'entry_%' ORDER BY name DESC")
    .all()
    .map(t => Number(t.name.replace('entry_', '')))
    .filter(y => !isNaN(y));
}

// 불변 team_id 발급 카운터 — 연도를 통틀어 유일하다. num(차량 번호)은 사람이 보는
// 가변 식별자이고, id는 다운스트림 서비스가 데이터를 키잉하는 불변 식별자다.
// (entry_active_revision과 같은 singleton-row 패턴)
db.exec(`CREATE TABLE IF NOT EXISTS entry_team_seq (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  value INTEGER NOT NULL DEFAULT 0
)`);
db.prepare("INSERT OR IGNORE INTO entry_team_seq (id, value) VALUES (1, 0)").run();

// 연도별 상태 버전 — 해당 연도의 팀 상태(엔트리 CRUD·활성·차량유형 변경)가 바뀔 때마다
// 변이 트랜잭션 안에서 +1. 다운스트림 team-state 캐시가 "바뀌었는가"만 판단하는 데 쓴다.
db.exec(`CREATE TABLE IF NOT EXISTS entry_state_version (
  year INTEGER PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
)`);

// 삭제된 팀의 tombstone. 상태 스냅샷 동기화에서 "스냅샷에 없음"은 삭제가 아니라
// 미지(unknown)로 취급되므로, 삭제 cascade는 반드시 명시적 tombstone으로 전달한다.
// 크기가 작아 프루닝하지 않는다.
db.exec(`CREATE TABLE IF NOT EXISTS team_tombstone (
  team_id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL,
  num INTEGER NOT NULL,
  univ TEXT NOT NULL,
  team TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_tombstone_year ON team_tombstone(year, deleted_at)");

function nextTeamId() {
  db.prepare("UPDATE entry_team_seq SET value = value + 1 WHERE id = 1").run();
  return db.prepare("SELECT value FROM entry_team_seq WHERE id = 1").get().value;
}

function bumpStateVersion(year) {
  db.prepare(`INSERT INTO entry_state_version (year, value) VALUES (?, 1)
    ON CONFLICT(year) DO UPDATE SET value = value + 1`).run(Number(year));
}

function getStateVersion(year) {
  return db.prepare("SELECT value FROM entry_state_version WHERE year = ?").get(Number(year))?.value || 0;
}

// 삭제·교체된 팀의 tombstone 기록. rows: { id, num, univ, team }[]
function insertTombstones(rows, year) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO team_tombstone (team_id, year, num, univ, team) VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    if (r.id != null) stmt.run(r.id, Number(year), r.num, r.univ, r.team);
  }
}

// 올해 테이블 보장
ensureYearTable(new Date().getFullYear());
ensureVtTable(new Date().getFullYear());

// outbox·리비전 시계는 team-state pull 동기화로 대체됐다. 업그레이드 시점에 남아 있던
// 미전달 이벤트는 폐기해도 안전하다 — 다운스트림의 첫 스냅샷 동기화가 현재 진실로 수렴시킨다.
db.exec("DROP TABLE IF EXISTS lifecycle_outbox");
db.exec("DROP TABLE IF EXISTS entry_active_revision");

// 현재 연도 이외의 기존 테이블도 같은 순서로 마이그레이션한다.
for (const year of getAvailableYears()) {
  ensureYearTable(year);
}

/* ============================================
   Express 앱 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

function broadcastEntries(year, change, detail = {}) {
  // version: 다운스트림 team-state 캐시가 이미 반영한 버전이면 재조회를 생략할 수 있게 동봉
  broadcastEvent("entries", { year: Number(year), change, version: getStateVersion(year), ...detail });
}

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
    if (!/^\d+$/.test(key) || Number(key) < 1 || Number(key) >= MAX_ENTRY_NUM) {
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
    // id는 선택 필드 — ?download 산출물의 왕복 업로드에서 권위 매칭 키로 쓰인다.
    if (value.id !== undefined && value.id !== null && (!Number.isInteger(value.id) || value.id < 1)) {
      return { valid: false, error: `엔트리 ${key}: 올바르지 않은 id입니다.` };
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
    if (!Number.isInteger(prevNum) || prevNum < 1 || prevNum >= MAX_ENTRY_NUM ||
        !Number.isInteger(newNum) || newNum < 1 || newNum >= MAX_ENTRY_NUM ||
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
    if (!Number.isInteger(v) || v < 1 || v >= MAX_ENTRY_NUM) {
      return { valid: false, error: `올바르지 않은 ${label} 목록입니다.` };
    }
    nums.add(v);
  }
  return { valid: true, nums };
}

/* ============================================
   DB 헬퍼
   ============================================ */
// 엔트리 번호 상한. 예전 리넘버 임시번호 대역(1e9)과의 하위호환 겸 정수 안전 상한.
const MAX_ENTRY_NUM = 1_000_000_000;

function entryIdentity(row) {
  return `${String(row.univ || "").trim()}\u0000${String(row.team || "").trim()}`;
}








// bulk 업로드의 팀 매칭 플랜: 기존 행을 identity/명시 renumber/업로드 id로 새 행에
// 대응시키고, 삭제 대상과 모호 항목을 가려낸다. 이벤트 팬아웃은 없다 — id 승계와
// tombstone 기록의 근거로만 쓰인다.
function buildBulkTeamPlan(oldRows, newRowsByNum, explicitRenumbers = new Map(), replacements = new Set(), retains = new Set()) {
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
    return { deletedNums: [], renumberCount: 0, ambiguous, retainedOldRowsByNewNum };
  }

  return { deletedNums, renumberCount: moves.length, ambiguous, retainedOldRowsByNewNum };
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

// GET /api/internal/team-state - 다운스트림 team-state 캐시가 pull하는 권위 스냅샷.
// { year, version, teams: {<team_id>: {num, univ, team, type, active}}, tombstones }
// 존재하지 않는 연도는 테이블을 만들지 않고 빈 스냅샷(version 0)을 돌려준다.
app.get("/api/internal/team-state", (req, res) => {
  if (!requireInternalRequest(req, res)) return;

  const y = Number(req.query.year);
  if (!Number.isInteger(y) || y < 2000 || y > 2099) {
    return res.status(400).send("올바르지 않은 연도입니다.");
  }

  const result = dbRun(() => {
    if (!getAvailableYears().includes(y)) {
      return { year: y, version: 0, teams: {}, tombstones: [] };
    }
    const tableName = ensureYearTable(y);
    const teams = {};
    for (const row of db.prepare(`SELECT id, num, univ, team, type, active FROM '${tableName}'`).all()) {
      teams[row.id] = { num: row.num, univ: row.univ, team: row.team, type: row.type, active: !!row.active };
    }
    const tombstones = db.prepare(
      "SELECT team_id AS id, num, deleted_at FROM team_tombstone WHERE year = ?",
    ).all(y);
    return { year: y, version: getStateVersion(y), teams, tombstones };
  });

  if (!result.success) {
    logger.warn(req, "entry.team_state", { error: result.error, year: y });
    return res.status(result.status).send(result.error);
  }
  res.json(result.result);
});

// GET /api/entries - 모든 엔트리 조회
app.get("/api/entries", withYearTable, (req, res) => {
  const { tableName, year } = req;
  const includeInactive = req.query.includeInactive === "true";

  const result = dbRun(() => {
    const data = {};
    const rows = db.prepare(`
      SELECT id, num, univ, team, type, active
      FROM '${tableName}'
      ${includeInactive ? "" : "WHERE active = 1"}
    `).all();
    for (const row of rows) {
      // id: 불변 team_id. ?download JSON에도 실려 재업로드 시 권위 매칭 키가 된다.
      data[row.num] = { id: row.id, univ: row.univ, team: row.team, type: row.type, active: !!row.active };
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
app.post("/api/entries", withYearTable, async (req, res) => {
  const { tableName, year } = req;

  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }
  if (numValidation.value >= MAX_ENTRY_NUM) {
    return res.status(400).send(numValidation.error);
  }

  const dataValidation = validateEntryData(req.body, year);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const result = dbRun(() =>
    db.transaction(() => {
      const insertResult = db
        .prepare(`INSERT INTO '${tableName}' (id, num, univ, team, type, active) VALUES (?, ?, ?, ?, ?, 1)`)
        .run(nextTeamId(), numValidation.value, dataValidation.univ, dataValidation.team, dataValidation.type);
      bumpStateVersion(year);
      return { insertResult };
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
  if (newNumValidation.value >= MAX_ENTRY_NUM) {
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
      if (numChanged) {
        // 번호 변경과 팀 정체성(학교/팀명) 변경이 한 요청에 함께 오면 순수 renumber로 처리돼
        // prevNum의 downstream(검차·대기열 등)이 newNum의 다른 팀에게 조용히 승계된다. same-num
        // 경로와 동일하게, 정체성이 바뀌면 명시적 intent="retain"(명칭 정정 후 이동)일 때만
        // 허용하고, 아니면 409로 거부한다(팀 교체는 삭제 후 재등록으로 처리).
        const existingPrev = db.prepare(`SELECT univ, team FROM '${tableName}' WHERE num = ?`).get(prevNum);
        if (!existingPrev) {
          throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
        }
        if (entryIdentity(existingPrev) !== entryIdentity(dataValidation) && intent !== "retain") {
          throw { status: 409, message: "번호와 팀 정보를 동시에 변경할 수 없습니다. 팀 정보를 유지한 채 번호만 옮기거나, 팀 교체는 삭제 후 재등록하세요." };
        }
        // 리넘버는 불변 id를 그대로 둔 채 num만 바꾼다 — 다운스트림은 id로 키잉하므로
        // 아무것도 옮길 필요가 없다.
        const numResult = db.prepare(`UPDATE '${tableName}' SET num = ? WHERE num = ?`).run(newNum, prevNum);
        if (!numResult.changes) {
          throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
        }
      } else {
        // 번호가 그대로일 때 identity 변경 여부를 확인한다. 명칭 정정인지 팀 교체인지
        // 페이로드만으로 알 수 없으므로, intent 미선언이면 bulk와 동일하게 ambiguous(409)로 보고하고
        // 아무것도 쓰지 않는다(읽기 전용 트랜잭션). 다른 팀이 downstream을 조용히 승계하지 못하게 막는다.
        const existing = db.prepare(`SELECT id, num, univ, team FROM '${tableName}' WHERE num = ?`).get(newNum);
        if (!existing) {
          throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
        }
        if (entryIdentity(existing) !== entryIdentity(dataValidation)) {
          if (intent === "replacement") {
            // 팀 교체 = 이전 팀 삭제 + 같은 번호의 새 팀. 이전 id는 tombstone으로 보내고
            // 새 id를 발급한다 — id가 불변이려면 다른 팀이 id를 승계해선 안 된다.
            // 다운스트림 cascade는 tombstone을 본 각 서비스의 수렴형 강제가 수행한다.
            insertTombstones([existing], year);
            db.prepare(`UPDATE '${tableName}' SET id = ? WHERE num = ?`).run(nextTeamId(), newNum);
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

      bumpStateVersion(year);
      return {};
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

  broadcastEntries(year, "update", { num: newNum, prevNum });
  logger.log(req, "entry.update", { year, prevNum, newNum, univ: dataValidation.univ, team: dataValidation.team, type: dataValidation.type }, `#${newNum}`);
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
    const existing = db.prepare(`SELECT active FROM '${tableName}' WHERE num = ?`).get(num);
    if (!existing) throw { status: 404, message: "존재하지 않는 엔트리 번호입니다." };
    if (!!existing.active === active) return { changed: false };

    db.prepare(`UPDATE '${tableName}' SET active = ? WHERE num = ?`).run(active ? 1 : 0, num);
    bumpStateVersion(year);
    return { changed: true };
  })());

  if (!result.success) {
    logger.warn(req, "entry.active", { error: result.error, year, active }, `#${num}`);
    return res.status(result.status).send(result.error);
  }
  if (!result.result.changed) return res.status(200).send();

  logger.log(req, active ? "entry.activate" : "entry.deactivate", { year }, `#${num}`);
  broadcastEntries(year, "active", { num, active });
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
    const entry = db.prepare(`SELECT id, num, univ, team FROM '${tableName}' WHERE num = ?`).get(numValidation.value);
    const deleteResult = db.prepare(`DELETE FROM '${tableName}' WHERE num = ?`).run(numValidation.value);
    if (deleteResult.changes) {
      insertTombstones([entry], year);
      bumpStateVersion(year);
    }
    return { deleteResult, entry };
  })());

  if (!result.success) {
    logger.warn(req, "entry.delete", { error: result.error, year }, `#${numValidation.value}`);
    return res.status(result.status).send(result.error);
  }

  if (!result.result.deleteResult.changes) {
    logger.warn(req, "entry.delete", { year, reason: "not_found" }, `#${numValidation.value}`);
    return res.status(404).send("존재하지 않는 엔트리 번호입니다.");
  }

  const { entry } = result.result;
  logger.log(req, "entry.delete", { year, univ: entry?.univ, team: entry?.team }, `#${numValidation.value}`);
  broadcastEntries(year, "delete", { num: numValidation.value });
  res.status(200).send();
});

// DELETE /api/entries - 모든 엔트리 삭제
app.delete("/api/entries", withYearTable, async (req, res) => {
  const { tableName, year } = req;

  const result = dbRun(() => db.transaction(() => {
    const existingRows = db.prepare(`SELECT id, num, univ, team FROM '${tableName}'`).all();
    const existingNums = existingRows.map(r => r.num);
    const deleteResult = db.prepare(`DELETE FROM '${tableName}'`).run();
    if (existingNums.length > 0) {
      insertTombstones(existingRows, year);
      bumpStateVersion(year);
    }
    return { existingNums, deleteResult };
  })());

  if (!result.success) {
    logger.warn(req, "entry.clear", { error: result.error, year });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "entry.clear", { year });

  if (result.result.existingNums.length > 0) broadcastEntries(year, "clear");
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
      const oldRows = db.prepare(`SELECT id, num, univ, team, type, active FROM '${tableName}'`).all();
      const vtTable = ensureVtTable(year);
      const validTypes = new Set(db.prepare(`SELECT name FROM '${vtTable}'`).all().map(t => t.name));
      const newRowsByNum = new Map();
      const query = db.prepare(`INSERT INTO '${tableName}' (id, num, univ, team, type, active) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const [k, v] of Object.entries(validation.data)) {
        const validatedType = v.type || null;
        if (validatedType && !validTypes.has(validatedType)) {
          throw { status: 400, message: `엔트리 ${k}: 존재하지 않는 차량 유형 '${validatedType}'` };
        }
        newRowsByNum.set(Number(k), {
          num: Number(k),
          uploadedId: v.id ?? null,
          univ: v.univ.trim(),
          team: v.team.trim(),
          type: validatedType,
          active: v.active !== false,
        });
      }

      // 업로드 행의 id는 권위 매칭 키다(?download 산출물 왕복). id가 가리키는 기존 행과
      // 같은 팀으로 확정한다: 번호가 다르면 explicit renumber로, 같은 번호에서 정체성이
      // 바뀌었으면 명칭 정정(retain)으로 — 같은 id = 같은 팀이므로 모호성이 없다.
      const oldRowsById = new Map(oldRows.filter((r) => r.id != null).map((r) => [r.id, r]));
      const seenUploadedIds = new Set();
      const renumbers = new Map(renumberValidation.renumbers);
      const retains = new Set(retainsValidation.nums);
      for (const row of newRowsByNum.values()) {
        if (row.uploadedId == null) continue;
        if (seenUploadedIds.has(row.uploadedId)) {
          throw { status: 400, message: `엔트리 ${row.num}: id ${row.uploadedId}가 중복되었습니다.` };
        }
        seenUploadedIds.add(row.uploadedId);
        const oldRow = oldRowsById.get(row.uploadedId);
        if (!oldRow) {
          throw { status: 400, message: `엔트리 ${row.num}: 존재하지 않는 id ${row.uploadedId}입니다.` };
        }
        if (oldRow.num !== row.num) {
          // 명시 renumbers가 같은 목적지 번호를 다른 팀에게 배정했다면 모순된 입력이다
          for (const [prevNum, targetNum] of renumbers) {
            if (targetNum === row.num && prevNum !== oldRow.num) {
              throw { status: 400, message: `엔트리 ${row.num}: id 매칭과 번호 변경 매핑이 충돌합니다.` };
            }
          }
          renumbers.set(oldRow.num, row.num);
        } else {
          retains.add(row.num);
        }
      }

      const { deletedNums, renumberCount, ambiguous, retainedOldRowsByNewNum } = buildBulkTeamPlan(
        oldRows, newRowsByNum, renumbers, replacementsValidation.nums, retains,
      );
      // 동일 번호의 팀 변경이 미선언 상태면 아무것도 쓰지 않고(읽기 전용 트랜잭션)
      // 운영자에게 의도 확인을 요청한다.
      if (ambiguous.length > 0) {
        return { ambiguous };
      }

      // id 계승: identity/explicit/id 매칭된 행은 기존 팀의 id를 상속하고(리넘버·명칭
      // 정정에도 불변), 매칭되지 않은 신규·교체 행은 새 id를 발급한다. 삭제·교체로
      // 사라지는 기존 팀은 tombstone에 기록한다. 다운스트림 반영은 각 서비스의 수렴형
      // 강제가 스냅샷 diff로 수행한다.
      const oldRowsByNum = new Map(oldRows.map((r) => [r.num, r]));
      insertTombstones(deletedNums.map((n) => oldRowsByNum.get(n)).filter(Boolean), year);
      for (const row of newRowsByNum.values()) {
        const oldRow = retainedOldRowsByNewNum.get(row.num) || null;
        row.id = oldRow?.id ?? nextTeamId();
      }

      db.prepare(`DELETE FROM '${tableName}'`).run();
      for (const row of newRowsByNum.values()) {
        query.run(row.id, row.num, row.univ, row.team, row.type, row.active ? 1 : 0);
      }
      bumpStateVersion(year);
      return { deletedNums, renumberCount };
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

  const { deletedNums, renumberCount } = result.result;
  logger.log(req, "entry.bulk_upload", {
    year, count: Object.keys(validation.data).length,
    deleted: deletedNums.length, renumbered: renumberCount,
    ...(deletedNums.length > 0 ? { deleted_nums: deletedNums } : {}),
  });
  broadcastEntries(year, "bulk");
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
        const changed = db.prepare(`UPDATE '${entryTable}' SET type = ? WHERE type = ?`).run(newName, type.name);
        // 팀 상태(type)가 실제로 바뀌었을 때만 상태 버전을 올린다
        if (changed.changes > 0) bumpStateVersion(vtYear);
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
      const changed = db.prepare(`UPDATE '${entryTable}' SET type = NULL WHERE type = ?`).run(type.name);
      if (changed.changes > 0) bumpStateVersion(vtYear);
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

return { app, db };
}

runIfDirect(import.meta, "entry", createEntryApp);
