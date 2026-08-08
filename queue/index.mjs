import express from "express";
import Database from "better-sqlite3";
import { addColumn, setupRowCapRetention } from "../shared/db-setup.mjs";
import { createServiceSkeleton, addSpaFallback } from "../shared/service-bootstrap.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import { validateEntryNum, validateYear } from "../shared/validation.mjs";
import { competitionYearBounds, currentCompetitionYear } from "../shared/competition-year.mjs";
import { ensureInactiveTeamView } from "../shared/team-status.mjs";
import { createSmsClient, createThrottledSkipWarning } from "../shared/sms-client.mjs";

// 키 순서가 곧 모든 화면의 검차 표시 순서다(withInspectionLengths 에서 이 순서로 정렬).
export const INSPECTIONS = {
  chassis: "섀시",
  battery: "축전지",
  electric: "전기",
  tilting: "틸팅",
  rain: "우천",
  noise: "소음",
  braking: "제동",
  report: "보고서",
};

export function createQueueApp(options = {}) {

const inspections = INSPECTIONS;
const QUEUE_LOG_MAX_ROWS = 100000;
const BOOTH_LOG_MAX_ROWS = 100000;

function primaryKeyColumns(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info('${table}')`).all()
    .filter((col) => col.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((col) => col.name);
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map((column) => column.name));
}

function assertRetiredCurrentTableShape(db) {
  if (!tableExists(db, "current_legacy")) return;
  const columns = [...tableColumns(db, "current_legacy")].sort();
  const primaryKey = primaryKeyColumns(db, "current_legacy").join(",");
  const expectedColumns = columns.join(",") === "inspection,num,phone"
    || columns.join(",") === "inspection,num,phone,year";
  if (!expectedColumns || !["num", "num,year"].includes(primaryKey)) {
    throw new Error(
      `unsupported Queue current_legacy schema: columns=${columns.join(",")} primaryKey=${primaryKey || "none"}`,
    );
  }
}

// Rate limiter for public endpoints
const rateLimitMap = new Map();
const rateLimitTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 60000);
rateLimitTimer.unref();

function rateLimit(req, res, next) {
  // Caddy가 세팅한 신뢰 X-Real-IP 우선(위조 불가), 없으면 X-Forwarded-For 최좌측 → req.ip 폴백.
  const ip = req.headers["x-real-ip"]?.trim() || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > 30) return res.status(429).send("요청이 너무 많습니다.");
  next();
}

const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "queue", express, Database, options,
  authRoleFn: (req) => {
    if (req.path === "/api/health") return null;
    if (req.path.startsWith("/api/internal/")) return "admin";
    // Chief-only: 대기 등록, 우선순위, 이력 초기화, 설정 변경, 검차 활성화/표시/무시, 부스 수 설정
    if (/^\/api\/admin\/register\/[^/]+$/.test(req.path)) return "chief";
    if (req.path.startsWith("/api/admin/priority")) return "chief";
    if (req.path.startsWith("/api/admin/history")) return "chief";
    if (req.path.startsWith("/api/admin/settings") && req.method !== "GET") return "chief";
    if (/^\/api\/admin\/inspection\/[^/]+\/(visibility|ignore)/.test(req.path)) return "chief";
    if (req.method === "PATCH" && /^\/api\/admin\/inspection\/[^/]+$/.test(req.path)) return "chief";
    if (/^\/api\/admin\/booths\/[^/]+\/config$/.test(req.path)) return "chief";
    // Official: 나머지 admin (대기열 조회, 취소, 개별 부스 토글, 입/출차 등)
    if (req.path.startsWith("/api/admin")) return "official";
    // SPA routes
    if (/^\/(priority|register)(\/|$)/.test(req.path)) return "chief";
    if (/^\/(admin|stats)/.test(req.path)) return "official";
    if (req.path === "/api/logs") return "admin";
    if (req.path === "/api/events") return null;
    if (req.path === "/api/active") return null;
    if (req.path.startsWith("/api/booths/")) return null;
    if (req.path.startsWith("/api/state/")) return null;
    if (req.path.startsWith("/api/")) return "official"; // API 기본값: default-close
    return null; // SPA (public display)
  },
});
// Reject an unknown same-name object before Queue-owned normalization can
// consume any predecessor state. The one-shot migrator runs this on its
// private staging copy, never on a source database.
assertRetiredCurrentTableShape(db);
ensureInactiveTeamView(db);

db.transaction(() => {
  // 검차 종류 메타 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS inspection (
    type TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    ignore_priority BOOLEAN NOT NULL DEFAULT FALSE,
    ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE
  );`);

  // 마이그레이션: 기존 테이블에 컬럼 추가
  addColumn(db, "inspection", "ignore_priority BOOLEAN NOT NULL DEFAULT FALSE");
  addColumn(db, "inspection", "ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE");
  addColumn(db, "inspection", "hidden_from_register BOOLEAN NOT NULL DEFAULT FALSE");
  {
    const cols = db.prepare("PRAGMA table_info(inspection)").all().map((c) => c.name);
    if (cols.includes("length")) {
      db.transaction(() => {
        db.exec(`CREATE TABLE inspection_new (
          type TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          ignore_priority BOOLEAN NOT NULL DEFAULT FALSE,
          ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE,
          hidden_from_register BOOLEAN NOT NULL DEFAULT FALSE
        )`);
        db.exec(`INSERT OR REPLACE INTO inspection_new (type, name, active, ignore_priority, ignore_reinspection, hidden_from_register)
          SELECT type, name, active, ignore_priority, ignore_reinspection, hidden_from_register FROM inspection`);
        db.exec("DROP TABLE inspection");
        db.exec("ALTER TABLE inspection_new RENAME TO inspection");
      })();
    }
  }

  // 팀별 검차별 우선순위 테이블 (0이 가장 높음, 숫자가 클수록 낮음)
  db.exec(`CREATE TABLE IF NOT EXISTS team_priority (
    num INTEGER NOT NULL,
    inspection TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 999,
    PRIMARY KEY (num, inspection)
  );`);

  // 검차 이력 테이블 (재검 여부 판단용)
  db.exec(`CREATE TABLE IF NOT EXISTS inspection_history (
    num INTEGER NOT NULL,
    inspection TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    year INTEGER NOT NULL,
    PRIMARY KEY (num, inspection, year, timestamp)
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS current_inspection (
    num INTEGER NOT NULL,
    inspection TEXT NOT NULL,
    phone TEXT NOT NULL,
    year INTEGER NOT NULL,
    PRIMARY KEY (num, inspection, year)
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_year_num
    ON current_inspection(year, num, inspection)`);

  db.exec(`CREATE TABLE IF NOT EXISTS inspection_queue (
    inspection TEXT NOT NULL,
    num INTEGER NOT NULL,
    phone TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    year INTEGER NOT NULL,
    PRIMARY KEY (inspection, num, year)
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_iq_year_insp_ts
    ON inspection_queue(year, inspection, timestamp, num)`);

  // 설정 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`);

  // 취소 페널티 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS cancel_penalty (
    num INTEGER NOT NULL,
    inspection TEXT NOT NULL,
    until INTEGER NOT NULL,
    phone TEXT,
    queue_timestamp INTEGER,
    PRIMARY KEY (num, inspection)
  );`);

  // 부스 설정 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS booth_config (
    inspection TEXT PRIMARY KEY,
    count INTEGER DEFAULT 1
  );`);

  // 부스 상태 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS booth (
    inspection TEXT,
    booth_num INTEGER,
    active BOOLEAN DEFAULT TRUE,
    occupied_by INTEGER NULL,
    occupied_team_id INTEGER NULL,
    entered_at INTEGER NULL,
    PRIMARY KEY (inspection, booth_num)
  );`);
  addColumn(db, "booth", "occupied_team_id INTEGER");

  // 부스 사용 로그 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS booth_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    num INTEGER,
    inspection TEXT,
    booth_num INTEGER,
    entered_at INTEGER,
    exited_at INTEGER NULL,
    created_at INTEGER
  );`);

  // 대기열 이벤트 로그 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS queue_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT,
    num INTEGER,
    inspection TEXT,
    timestamp INTEGER
  );`);

  // 검차 종류 메타 및 부스 기본 데이터 생성
  for (const [k, v] of Object.entries(inspections)) {
    db.prepare(`INSERT OR IGNORE INTO inspection (type, name) VALUES (?, ?)`).run(k, v);
    // 이름은 INSPECTIONS 가 유일한 출처다. 라우트가 name 을 수정하지 않으므로
    // 상수 변경(배터리 -> 축전지)이 기존 DB에도 반영되도록 매 부팅에 맞춘다.
    db.prepare(`UPDATE inspection SET name = ? WHERE type = ? AND name != ?`).run(v, k, v);

    // 부스 기본 설정: 검차 종류당 1개 부스
    db.prepare(`INSERT OR IGNORE INTO booth_config (inspection, count) VALUES (?, 1)`).run(k);
    db.prepare(`INSERT OR IGNORE INTO booth (inspection, booth_num) VALUES (?, 1)`).run(k);
  }

  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("sms", "FALSE");
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("sms_rank", "3");
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("cancel_penalty", "10");

  // SMS 설정은 이메일 서비스에서 가져오거나 환경변수로 폴백
  // loadSmsConfig()에서 비동기로 확인 후 활성화

  // year-aware indexes are created after the year-column migration below.
  setupRowCapRetention(db, "queue_log", QUEUE_LOG_MAX_ROWS);
  setupRowCapRetention(db, "booth_log", BOOTH_LOG_MAX_ROWS);
})();

// 연도 컬럼 마이그레이션 (기존 스키마 생성과 분리)
{
  const yr = currentCompetitionYear();

  // team_priority: year를 PK에 추가
  const tpInfo = db.prepare("PRAGMA table_info(team_priority)").all();
  if (!tpInfo.some(c => c.name === "year")) {
    db.transaction(() => {
      db.exec(`CREATE TABLE team_priority_new (
        num INTEGER NOT NULL,
        inspection TEXT NOT NULL,
        year INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 999,
        PRIMARY KEY (num, inspection, year)
      )`);
      db.exec(`INSERT INTO team_priority_new SELECT num, inspection, ${yr}, priority FROM team_priority`);
      db.exec(`DROP TABLE team_priority`);
      db.exec(`ALTER TABLE team_priority_new RENAME TO team_priority`);
      db.exec(`CREATE INDEX idx_tp_insp_prio ON team_priority(year, inspection, priority, num)`);
    })();
  }

  // 취소 전 순번 복구에 필요한 원본 전화번호·접수시각을 보존한다. 기존 페널티는
  // 두 값이 NULL이므로 해제는 가능하지만 원래 순번 복구는 제공하지 않는다.
  addColumn(db, "cancel_penalty", "phone TEXT");
  addColumn(db, "cancel_penalty", "queue_timestamp INTEGER");

  // cancel_penalty: year를 PK에 추가
  const cpInfo = db.prepare("PRAGMA table_info(cancel_penalty)").all();
  if (!cpInfo.some(c => c.name === "year")) {
    db.transaction(() => {
      db.exec(`CREATE TABLE cancel_penalty_new (
        num INTEGER NOT NULL,
        inspection TEXT NOT NULL,
        year INTEGER NOT NULL,
        until INTEGER NOT NULL,
        phone TEXT,
        queue_timestamp INTEGER,
        PRIMARY KEY (num, inspection, year)
      )`);
      db.exec(`INSERT INTO cancel_penalty_new (num, inspection, year, until, phone, queue_timestamp)
        SELECT num, inspection, ${yr}, until, phone, queue_timestamp FROM cancel_penalty`);
      db.exec(`DROP TABLE cancel_penalty`);
      db.exec(`ALTER TABLE cancel_penalty_new RENAME TO cancel_penalty`);
      db.exec(`CREATE INDEX idx_cp_num_insp ON cancel_penalty(year, num, inspection)`);
    })();
  }

  // 나머지 테이블: year 컬럼 추가
  addColumn(db, "inspection_history", `year INTEGER NOT NULL DEFAULT ${yr}`);
  addColumn(db, "booth_log", `year INTEGER NOT NULL DEFAULT ${yr}`);
  addColumn(db, "queue_log", `year INTEGER NOT NULL DEFAULT ${yr}`);

  if (tableExists(db, "current")) {
    const currentCols = db.prepare("PRAGMA table_info('current')").all().map((c) => c.name);
    const yearExpr = currentCols.includes("year") ? "year" : `${yr} AS year`;
    const ciInsert = db.prepare("INSERT OR IGNORE INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)");
    for (const row of db.prepare(`SELECT num, phone, inspection, ${yearExpr} FROM current`).all()) {
      for (const type of String(row.inspection || "").split(",").filter((t) => INSPECTIONS[t])) {
        ciInsert.run(row.num, type, row.phone, row.year);
      }
    }
    // The normalized tables are the only runtime model. Unknown inspection
    // names are intentionally not retained in a second compatibility table.
    db.exec("DROP TABLE current");
  }
  db.exec("DROP TABLE IF EXISTS current_legacy");

  if (primaryKeyColumns(db, "inspection_history").join(",") !== "num,inspection,year,timestamp") {
    db.transaction(() => {
      db.exec(`CREATE TABLE inspection_history_new (
        num INTEGER NOT NULL,
        inspection TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        year INTEGER NOT NULL,
        PRIMARY KEY (num, inspection, year, timestamp)
      )`);
      db.exec(`INSERT OR IGNORE INTO inspection_history_new (num, inspection, timestamp, year)
        SELECT num, inspection, timestamp, year FROM inspection_history`);
      db.exec(`DROP TABLE inspection_history`);
      db.exec(`ALTER TABLE inspection_history_new RENAME TO inspection_history`);
    })();
  }

  for (const k of Object.keys(INSPECTIONS)) {
    if (!tableExists(db, k)) continue;
    const cols = db.prepare(`PRAGMA table_info('${k}')`).all().map((c) => c.name);
    if (cols.includes("num") && cols.includes("phone") && cols.includes("timestamp")) {
      const yearExpr = cols.includes("year") ? "year" : `${yr} AS year`;
      db.prepare(`
        INSERT OR IGNORE INTO inspection_queue (inspection, num, phone, timestamp, year)
        SELECT ?, num, phone, timestamp, ${yearExpr} FROM '${k}'
      `).run(k);
    }
    db.exec(`DROP TRIGGER IF EXISTS trg_${k}_iq_insert`);
    db.exec(`DROP TRIGGER IF EXISTS trg_${k}_iq_update`);
    db.exec(`DROP TRIGGER IF EXISTS trg_${k}_iq_delete`);
    db.exec(`DROP TABLE '${k}'`);
  }

  db.exec(`DROP INDEX IF EXISTS idx_ih_num_insp`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ih_year_num_insp ON inspection_history(year, num, inspection)`);
  db.exec(`DROP INDEX IF EXISTS idx_tp_insp_prio`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tp_insp_prio ON team_priority(year, inspection, priority, num)`);
  db.exec(`DROP INDEX IF EXISTS idx_cp_num_insp`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cp_num_insp ON cancel_penalty(year, num, inspection)`);
  db.exec(`DROP INDEX IF EXISTS idx_bl_active`);
  db.exec(`DROP INDEX IF EXISTS idx_ql_num`);
  db.exec(`DROP INDEX IF EXISTS idx_ql_insp_ts`);
  db.exec(`DROP INDEX IF EXISTS idx_ql_timestamp`);
  db.exec(`DROP INDEX IF EXISTS idx_bl_entered`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ql_year_num_ts ON queue_log(year, num, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ql_year_insp_ts ON queue_log(year, inspection, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bl_year_entered ON booth_log(year, entered_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bl_year_num_entered ON booth_log(year, num, entered_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bl_year_open ON booth_log(year, num, inspection, booth_num, exited_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ql_year_ts ON queue_log(year, timestamp)`);
}

/* ============================================
   Express 앱 설정
   ============================================ */
function currentYear() {
  return currentCompetitionYear();
}

function activeTeam(num, year = currentYear()) {
  if (options.teamStore) {
    return options.teamStore.getByNumber(year, num, { includeInactive: false });
  }
  return { id: null, year, number: num, active: true };
}

function requestTeamActivity(req, res, { action, num, year = currentYear() }) {
  try {
    const team = activeTeam(num, year);
    return { ok: true, active: !!team, team };
  } catch (error) {
    logger.warn(req, action, {
      error: error?.message || String(error),
      phase: "canonical_team_lookup",
      year,
      team_num: num,
    }, `#${num}`);
    res.status(500).send("팀 활성 상태를 확인할 수 없습니다.");
    return { ok: false, active: false };
  }
}

function parseYearQuery(value) {
  if (value == null || value === "") return currentYear();
  const check = validateYear(value);
  return check.valid ? check.value : null;
}

function withInspectionLengths(rows, year = currentYear()) {
  // 행마다 COUNT(*)를 돌리는 N+1 대신 한 번의 GROUP BY로 길이를 집계한다.
  const counts = new Map();
  for (const r of db.prepare("SELECT inspection, COUNT(*) AS count FROM inspection_queue WHERE year = ? GROUP BY inspection").all(year)) {
    counts.set(r.inspection, r.count);
  }
  // rowid(= 최초 삽입 순서)가 아니라 INSPECTIONS 키 순서로 노출한다. 기존 DB의
  // 삽입 순서가 달라도 모든 화면이 같은 순서를 본다.
  const order = Object.keys(inspections);
  return rows
    .filter((row) => order.includes(row.type))
    .map((row) => ({ ...row, length: counts.get(row.type) || 0 }))
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

function getActiveInspections(year = currentYear()) {
  return withInspectionLengths(db.prepare("SELECT * FROM inspection WHERE active = TRUE").all(), year);
}

function getAllInspections(year = currentYear()) {
  return withInspectionLengths(db.prepare("SELECT * FROM inspection").all(), year);
}

function getCurrentEntry(num, year) {
  const rows = db.prepare(`
    SELECT inspection, phone
    FROM current_inspection
    WHERE num = ? AND year = ?
    ORDER BY rowid
  `).all(num, year);
  if (rows.length > 0) {
    return {
      num,
      phone: rows[0].phone,
      inspection: rows.map((row) => row.inspection).join(","),
      inspections: rows.map((row) => row.inspection),
      year,
    };
  }
  return null;
}

function setCurrentInspections(num, phone, types, year) {
  const uniqueTypes = [...new Set(types.filter((type) => INSPECTIONS[type]))];
  db.prepare("DELETE FROM current_inspection WHERE num = ? AND year = ?").run(num, year);
  if (uniqueTypes.length === 0) return;
  const insert = db.prepare("INSERT OR REPLACE INTO current_inspection (num, inspection, phone, year) VALUES (?, ?, ?, ?)");
  for (const type of uniqueTypes) insert.run(num, type, phone, year);
}

function addCurrentInspection(num, phone, type, year) {
  const current = getCurrentEntry(num, year);
  if (!current) {
    setCurrentInspections(num, phone, [type], year);
    return;
  }

  const currentTypes = current.inspections;
  if (currentTypes.includes(type)) {
    throw { status: 400, message: `이미 ${inspections[type]} 검차에 등록된 엔트리입니다.` };
  }

  // 보고서는 다른 검차와 항상 동시 등록 가능
  if (type === "report") {
    setCurrentInspections(num, phone, [...currentTypes, type], year);
    return;
  }

  const nonReportTypes = currentTypes.filter((inspection) => inspection !== "report");
  if (
    nonReportTypes.length === 0 ||
    (nonReportTypes.length === 1 && nonReportTypes[0] === "battery" && type === "chassis") ||
    (nonReportTypes.length === 1 && nonReportTypes[0] === "chassis" && type === "battery")
  ) {
    // 보고서만 등록 또는 축전지+섀시 동시 등록 허용
    setCurrentInspections(num, phone, [...currentTypes, type], year);
    return;
  }

  const name = currentTypes.map((inspection) => inspections[inspection]).join(", ");
  throw { status: 400, message: `이미 ${name} 검차에 등록된 엔트리입니다.` };
}

function insertQueueRow(type, num, phone, timestamp, year) {
  db.prepare("INSERT INTO inspection_queue (inspection, num, phone, timestamp, year) VALUES (?, ?, ?, ?, ?)")
    .run(type, num, phone, timestamp, year);
}

function deleteQueueRow(type, num, year) {
  return db.prepare("DELETE FROM inspection_queue WHERE inspection = ? AND num = ? AND year = ?").run(type, num, year);
}

function getQueueRow(type, num, year) {
  return db.prepare("SELECT num, phone, timestamp, year FROM inspection_queue WHERE inspection = ? AND num = ? AND year = ?")
    .get(type, num, year);
}

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler, close: closeSse } = createSSEManager();

// SSE 엔드포인트
app.get("/api/events", sseHandler(() => {
  const activeInspections = getActiveInspections();
  const allBooths = {};
  for (const row of db.prepare("SELECT inspection, booth_num, active, occupied_by, entered_at FROM booth ORDER BY inspection, booth_num").all()) {
    (allBooths[row.inspection] ||= []).push(row);
  }
  return { activeInspections, allBooths };
// 공개 SSE라 비인증 단일 IP가 전역 상한(200)을 독점해 전광판·키오스크 갱신을 막는 DoS를
// 완화하기 위한 per-IP 동시연결 상한. 대회장은 하나의 NAT 공인 IP를 공유할 수 있어(전광판+
// 키오스크+스태프) 넉넉히 20으로 둔다 — 단일 IP가 전역의 10%까지만 점유. 필요 시 상향 튜닝.
}, { maxPerIp: 20 }));

// SSE 브로드캐스트 헬퍼 — 대기열/부스/활성검차 변경을 일관된 페이로드로 전파한다.
function broadcastQueue(type) {
  broadcastEvent("queue", { type, activeInspections: getActiveInspections() });
}
function broadcastBooth(type) {
  broadcastEvent("booth", { type, booths: getBoothsForType(type) });
}
function broadcastInspections() {
  broadcastEvent("inspections", { activeInspections: getActiveInspections() });
}
function broadcastPenalties() {
  // SSE endpoint is public, so only broadcast an invalidation signal. Authorized
  // clients fetch the protected penalty list separately.
  broadcastEvent("penalties", {});
}
function sourceEvent(event, data) {
  broadcastEvent(event, data);
  if (event !== "entries") return;
  // TeamStore applies renumber/deactivation cleanup before this callback. Reuse
  // the module's existing invalidations so open clients also discard queue and
  // booth state that referred to the previous canonical team row.
  broadcastEvent("queue", { type: null, activeInspections: getActiveInspections() });
  for (const type of Object.keys(inspections)) broadcastBooth(type);
}

/* ============================================
   Validation 헬퍼
   ============================================ */
function validatePhone(phone) {
  if (!phone || !/^010\d{8}$/.test(phone)) {
    return { valid: false, error: "전화번호가 올바르지 않습니다." };
  }
  return { valid: true, value: phone };
}

function validateInspection(type) {
  if (!inspections[type]) {
    return { valid: false, error: "검차 종류가 올바르지 않습니다." };
  }
  return { valid: true, value: type };
}

function validatePriority(priority) {
  const parsed = Number(priority);
  // 상한(999999)을 둬 비정상적으로 큰 정수가 정렬 키로 들어오는 것을 막는다(기본값 999).
  if (priority === "" || priority === undefined || Number.isNaN(parsed) || parsed < 0 || parsed > 999999 || !Number.isInteger(parsed)) {
    return { valid: false, error: "우선순위는 0 이상 999999 이하의 정수여야 합니다." };
  }
  return { valid: true, value: parsed };
}

/* ============================================
   DB 헬퍼
   ============================================ */
/**
 * 대기열 조회 쿼리 (정렬 순서: 초검 > 재검, 우선순위 높음 > 낮음, 선착순)
 * 파라미터 순서: [inspection, year] × 3 (재검 CASE, priority JOIN, WHERE 순)
 *
 * 정렬 변형은 (ignore_reinspection, ignore_priority) 조합당 4종뿐이므로 prepared
 * statement를 메모이즈한다 — 핫패스(등록/취소/입장/SMS/조회)의 매 요청 SQL
 * 재컴파일과 메타 조회 statement 재생성을 피한다.
 */
const inspectionMetaStmt = db.prepare("SELECT ignore_priority, ignore_reinspection FROM inspection WHERE type = ?");
const queueStmtCache = new Map();
const queueRankStmtCache = new Map();

function getQueueOrderFlags(inspection) {
  const meta = inspectionMetaStmt.get(inspection);
  return { ignoreReinspection: !!meta?.ignore_reinspection, ignorePriority: !!meta?.ignore_priority };
}

function buildQueueQuery({ ignoreReinspection, ignorePriority }) {
  const orderClauses = [];
  if (!ignoreReinspection) orderClauses.push("is_reinspection ASC");
  if (!ignorePriority) orderClauses.push("priority ASC");
  orderClauses.push("t.timestamp ASC");

  return `
    SELECT t.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM inspection_history h WHERE h.num = t.num AND h.inspection = ? AND h.year = ?
      ) THEN 1 ELSE 0 END AS is_reinspection,
      COALESCE(p.priority, 999) AS priority
    FROM inspection_queue AS t
    LEFT JOIN team_priority AS p ON t.num = p.num AND p.inspection = ? AND p.year = ?
    WHERE t.inspection = ? AND t.year = ?
      AND NOT EXISTS (
        SELECT 1 FROM competition_inactive_team s
        WHERE s.year = t.year AND s.team_num = t.num
      )
    ORDER BY ${orderClauses.join(", ")}
  `;
}

// variant: "list"(전체 목록) | "offset"(LIMIT 1 OFFSET ? 추가 — 순번 단건 조회)
function getQueueStmt(inspection, variant = "list") {
  const flags = getQueueOrderFlags(inspection);
  const key = `${flags.ignoreReinspection}|${flags.ignorePriority}|${variant}`;
  let stmt = queueStmtCache.get(key);
  if (!stmt) {
    stmt = db.prepare(buildQueueQuery(flags) + (variant === "offset" ? " LIMIT 1 OFFSET ?" : ""));
    queueStmtCache.set(key, stmt);
  }
  return stmt;
}

function getQueueParams(inspection, year) {
  return [inspection, year, inspection, year, inspection, year];
}

/**
 * 특정 엔트리의 대기열 순위 조회
 */
function getQueueRank(inspection, num, year) {
  const { ignoreReinspection, ignorePriority } = getQueueOrderFlags(inspection);

  const key = `${ignoreReinspection}|${ignorePriority}`;
  let stmt = queueRankStmtCache.get(key);
  if (!stmt) {
    const orderClauses = [];
    if (!ignoreReinspection) orderClauses.push(`CASE WHEN EXISTS (
              SELECT 1 FROM inspection_history h WHERE h.num = t.num AND h.inspection = ? AND h.year = ?
            ) THEN 1 ELSE 0 END ASC`);
    if (!ignorePriority) orderClauses.push("COALESCE(p.priority, 999) ASC");
    orderClauses.push("t.timestamp ASC");

    stmt = db.prepare(`
    SELECT sub.rank FROM (
      SELECT t.num,
        ROW_NUMBER() OVER (
          ORDER BY ${orderClauses.join(", ")}
        ) AS rank
      FROM inspection_queue AS t
      LEFT JOIN team_priority AS p ON t.num = p.num AND p.inspection = ? AND p.year = ?
      WHERE t.inspection = ? AND t.year = ?
        AND NOT EXISTS (
          SELECT 1 FROM competition_inactive_team s
          WHERE s.year = t.year AND s.team_num = t.num
        )
    ) AS sub WHERE sub.num = ?
  `);
    queueRankStmtCache.set(key, stmt);
  }

  const params = [];
  if (!ignoreReinspection) params.push(inspection, year);
  params.push(inspection, year); // for LEFT JOIN team_priority
  params.push(inspection, year); // for WHERE t.inspection = ? AND t.year = ?
  params.push(num); // for WHERE sub.num = ?

  const result = stmt.get(...params);

  return result ? result.rank : null;
}

/* ============================================
   API 라우트: Public
   ============================================ */

// GET /api/active - 활성화된 검차 목록 조회
app.get("/api/active", (req, res) => {
  const result = dbRun(() => getActiveInspections());

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/state/:num - 대기열 상태 조회 (전화번호 검증 필요)
app.post("/api/state/:num", rateLimit, async (req, res) => {
  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const num = numValidation.value;

  try {
    const entries = await getEntries();

    if (entries[num] === undefined) {
      return res.status(400).send("존재하지 않는 엔트리 번호입니다.");
    }
  } catch (e) {
    logger.warn(req, "queue.entry_lookup", { error: e.message, num });
    return res.status(500).send("엔트리를 조회할 수 없습니다.");
  }

  const year = currentYear();
  const result = dbRun(() => {
    const entry = getCurrentEntry(num, year);

    if (!entry) {
      return { queue: undefined, rank: -1, queues: [] };
    }

    if (typeof req.body.phone !== "string") {
      throw { status: 400, message: "전화번호 형식이 올바르지 않습니다." };
    }
    if (entry.phone !== req.body.phone) {
      throw { status: 400, message: "전화번호가 일치하지 않습니다." };
    }

    const queues = entry.inspections.map((type) => ({
      type,
      name: inspections[type],
      rank: getQueueRank(type, num, year),
      total: db.prepare(`
        SELECT COUNT(*) AS count FROM inspection_queue
        WHERE inspection = ? AND year = ?
      `).get(type, year).count,
    }));
    return {
      // 기존 소비자를 위한 표시 문자열은 유지하되, 화면은 안정 키와 같은 응답에서
      // 계산된 합계를 담은 queues를 사용한다. 이름 변경·비활성화와 무관하게 짝이 맞는다.
      queue: queues.length === 1 ? queues[0].name : queues.map((item) => item.name).join(", "),
      rank: queues.length === 1 ? queues[0].rank : queues.map((item) => item.rank).join(", "),
      queues,
    };
  });

  if (!result.success) {
    // 전화번호 불일치는 인증 실패에 준하는 보안 이벤트 — 무차별 대입 시도를 추적 가능하게 남긴다.
    if (result.error === "전화번호가 일치하지 않습니다.") {
      logger.warn(req, "queue.state_verify", { error: "전화번호 불일치" }, `#${num}`);
    }
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// GET /api/booths/:type - 공개 부스 상태 조회
app.get("/api/booths/all", (req, res) => {
  const result = dbRun(() => {
    // 타입별 개별 쿼리(N+1) 대신 단일 조회 후 그룹핑 (SSE init과 동일 패턴)
    const allBooths = {};
    for (const k of Object.keys(inspections)) allBooths[k] = [];
    for (const { inspection, ...row } of db.prepare("SELECT inspection, booth_num, active, occupied_by, entered_at FROM booth ORDER BY inspection, booth_num").all()) {
      if (allBooths[inspection]) allBooths[inspection].push(row);
    }
    return allBooths;
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

app.get("/api/booths/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const result = dbRun(() => getBoothsForType(req.params.type));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

/* ============================================
   API 라우트: Admin - 검차 관리
   ============================================ */

// GET /api/admin/all - 모든 검차 목록 조회
app.get("/api/admin/all", (req, res) => {
  const result = dbRun(() => getAllInspections());

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// GET /api/admin/inspection/:type - 검차별 대기열 조회
app.get("/api/admin/inspection/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const year = currentYear();
  const result = dbRun(() => getQueueStmt(req.params.type).all(...getQueueParams(req.params.type, year)));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// PATCH /api/admin/inspection/:type - 검차 활성화 상태 변경
app.patch("/api/admin/inspection/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const result = dbRun(() =>
    db
      .prepare("UPDATE inspection SET active = ? WHERE type = ?")
      .run(req.body.active === true ? 1 : 0, req.params.type),
  );

  if (!result.success) {
    logger.warn(req, "inspection.toggle", { error: result.error, cause: result.cause }, req.params.type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "inspection.toggle", { active: req.body.active === true }, req.params.type);

  // SSE 브로드캐스트: 활성 검차 목록 변경
  broadcastInspections();

  res.status(200).send();
});

// PATCH /api/admin/inspection/:type/visibility - 검차 등록 페이지 표시 상태 변경
app.patch("/api/admin/inspection/:type/visibility", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const result = dbRun(() =>
    db
      .prepare("UPDATE inspection SET hidden_from_register = ? WHERE type = ?")
      .run(req.body.hidden === true ? 1 : 0, req.params.type),
  );

  if (!result.success) {
    logger.warn(req, "inspection.visibility", { error: result.error, cause: result.cause }, req.params.type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "inspection.visibility", { active: !(req.body.hidden === true) }, req.params.type);

  // SSE 브로드캐스트: 활성 검차 목록 변경 (hidden 정보 포함)
  broadcastInspections();

  res.status(200).send();
});

/* ============================================
   API 라우트: Admin - 대기열 등록/삭제
   ============================================ */

// POST /api/admin/register/:type - 대기열에 엔트리 등록
app.post("/api/admin/register/:type", async (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const phoneValidation = validatePhone(req.body.phone);
  if (!phoneValidation.valid) {
    return res.status(400).send(phoneValidation.error);
  }

  const num = numValidation.value;
  const phone = phoneValidation.value;
  const type = typeValidation.value;
  const year = currentYear();

  try {
    const entries = await getEntries();

    if (entries[num] === undefined) {
      logger.warn(req, "queue.register", { error: "존재하지 않는 엔트리", num }, "#" + num);
      return res.status(400).send("존재하지 않는 엔트리 번호입니다.");
    }
  } catch (e) {
    logger.warn(req, "queue.entry_lookup", { error: e.message, num });
    return res.status(500).send("엔트리를 조회할 수 없습니다.");
  }

  const activity = requestTeamActivity(req, res, { action: "queue.register", num, year });
  if (!activity.ok) return;

  let denyReason = null;
  const result = dbRun(() => {
    db.transaction(() => {
      if (!db.prepare("SELECT active FROM inspection WHERE type = ?").get(type).active) {
        throw { status: 400, message: "대기열이 비활성화 상태입니다." };
      }

      if (!activity.active) {
        throw { status: 409, message: "비활성화된 엔트리는 대기열에 등록할 수 없습니다." };
      }

      // 페널티 확인
      const penalty = db.prepare("SELECT * FROM cancel_penalty WHERE num = ? AND inspection = ? AND year = ?").get(num, type, year);
      if (penalty && penalty.until > Date.now()) {
        const remaining = Math.ceil((penalty.until - Date.now()) / 1000 / 60);
        denyReason = "cancel_penalty";
        throw {
          status: 403,
          message: JSON.stringify({ remaining, until: penalty.until }),
        };
      } else if (penalty) {
        // 만료된 페널티 삭제
        db.prepare("DELETE FROM cancel_penalty WHERE num = ? AND inspection = ? AND year = ?").run(num, type, year);
      }

      addCurrentInspection(num, phone, type, year);

      const now = Date.now();
      insertQueueRow(type, num, phone, now, year);

      // 대기열 이벤트 로그 기록 (트랜잭션 내부)
      db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)").run("register", num, type, now, year);
    })();
  });

  if (!result.success) {
    logger.warn(req, "queue.register", denyReason ? { error: result.error, cause: result.cause, reason: denyReason } : { error: result.error, cause: result.cause }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  const maskedPhone = phone ? phone.slice(0, 3) + "****" + phone.slice(-4) : "";
  logger.log(req, "queue.register", { inspection: type, phone: maskedPhone }, `#${num}`);

  // SSE 브로드캐스트: 대기열 변경
  broadcastQueue(type);

  res.status(201).send();
});

// POST /api/admin/cancel/:type - 대기열에서 엔트리 취소 (페널티 적용)
app.post("/api/admin/cancel/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const num = numValidation.value;
  const type = typeValidation.value;
  const year = currentYear();

  const result = dbRun(() => {
    return db.transaction(() => {
      // SMS 대상 조회도 취소 mutation의 preflight다. 실패하면 삭제를 시작하지
      // 않고 동일한 audited boundary에서 응답한다.
      const smsRank = parseInt(db.prepare(`SELECT value FROM settings WHERE key = 'sms_rank'`).get()?.value || "3", 10);
      const prev = getQueueStmt(type, "offset").get(...getQueueParams(type, year), smsRank - 1);
      const queueEntry = getQueueRow(type, num, year);
      if (!queueEntry) {
        throw { status: 400, message: "존재하지 않는 엔트리입니다." };
      }
      deleteQueueRow(type, num, year);

      // 페널티 적용
      const penaltyMinutes = parseInt(
        db.prepare(`SELECT value FROM settings WHERE key = 'cancel_penalty'`).get()?.value || "10",
        10,
      );
      if (penaltyMinutes > 0) {
        const until = Date.now() + penaltyMinutes * 60 * 1000;
        appliedPenalty = { minutes: penaltyMinutes, until };
        db.prepare(`
          INSERT OR REPLACE INTO cancel_penalty
            (num, inspection, year, until, phone, queue_timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          num,
          type,
          year,
          until,
          queueEntry.phone,
          queueEntry.timestamp,
        );
      }

      const current = getCurrentEntry(num, year);

      if (!current) {
        throw { status: 400, message: "현재 등록 상태를 찾을 수 없습니다." };
      }

      const remaining = current.inspections.filter((i) => i !== type);
      setCurrentInspections(num, current.phone, remaining, year);

      // 대기열 이벤트 로그 기록 (트랜잭션 내부)
      db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)").run("cancel", num, type, Date.now(), year);
      return { prev };
    })();
  });

  if (!result.success) {
    logger.warn(req, "queue.cancel", {
      error: result.internalError || result.error,
      phase: "mutation_preflight",
      year,
      team_num: num,
      inspection: type,
    }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "queue.cancel", appliedPenalty
    ? { inspection: type, penalty_minutes: appliedPenalty.minutes, penalty_until: appliedPenalty.until }
    : { inspection: type, penalty: false }, `#${num}`);

  // SSE 브로드캐스트: 대기열 변경
  broadcastQueue(type);
  broadcastPenalties();

  res.status(200).send();

  // SMS 발송 (N번째 대기자에게)
  sendSmsNotification(type, result.result.prev);
});

// GET /api/admin/penalties - 현재 연도에 적용 중인 취소 페널티 조회
app.get("/api/admin/penalties", (req, res) => {
  const year = currentYear();
  const now = Date.now();
  const result = dbRun(() =>
    db.prepare(`
      SELECT
        cp.num,
        cp.inspection,
        i.name AS inspection_name,
        cp.until,
        CASE WHEN cp.phone IS NOT NULL AND cp.queue_timestamp IS NOT NULL THEN 1 ELSE 0 END AS can_restore
      FROM cancel_penalty cp
      JOIN inspection i ON i.type = cp.inspection
      WHERE cp.year = ? AND cp.until > ?
        AND NOT EXISTS (
          SELECT 1 FROM competition_inactive_team s
          WHERE s.year = cp.year AND s.team_num = cp.num
        )
      ORDER BY cp.until ASC, cp.num ASC, cp.inspection ASC
    `).all(year, now),
  );

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/admin/penalties/:type/:num/restore - 페널티 해제 후 취소 전 순번 복구
app.post("/api/admin/penalties/:type/:num/restore", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const type = typeValidation.value;
  const num = numValidation.value;
  const year = currentYear();
  const activity = requestTeamActivity(req, res, { action: "penalty.restore", num, year });
  if (!activity.ok) return;
  const result = dbRun(() =>
    db.transaction(() => {
      if (!activity.active) {
        throw { status: 409, message: "비활성화된 엔트리의 대기열 상태는 복구할 수 없습니다." };
      }
      if (!db.prepare("SELECT active FROM inspection WHERE type = ?").get(type).active) {
        throw { status: 400, message: "대기열이 비활성화 상태입니다." };
      }

      const penalty = db.prepare(`
        SELECT phone, queue_timestamp
        FROM cancel_penalty
        WHERE num = ? AND inspection = ? AND year = ? AND until > ?
      `).get(num, type, year, Date.now());

      if (!penalty) {
        throw { status: 404, message: "적용 중인 페널티가 없습니다." };
      }
      if (!penalty.phone || penalty.queue_timestamp == null) {
        throw { status: 409, message: "취소 당시 대기열 정보가 없어 원래 순번으로 복구할 수 없습니다." };
      }
      if (getQueueRow(type, num, year)) {
        throw { status: 409, message: "이미 대기열에 등록된 엔트리입니다." };
      }

      addCurrentInspection(num, penalty.phone, type, year);
      insertQueueRow(type, num, penalty.phone, penalty.queue_timestamp, year);
      db.prepare("DELETE FROM cancel_penalty WHERE num = ? AND inspection = ? AND year = ?").run(num, type, year);
      db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)")
        .run("restore", num, type, Date.now(), year);

      return { queueTimestamp: penalty.queue_timestamp };
    })(),
  );

  if (!result.success) {
    logger.warn(req, "penalty.restore", { error: result.error, cause: result.cause, inspection: type, year }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "penalty.restore", {
    inspection: type,
    year,
    queueTimestamp: result.result.queueTimestamp,
  }, `#${num}`);
  broadcastQueue(type);
  broadcastPenalties();
  res.status(200).send();
});

// DELETE /api/admin/penalties/:type/:num - 적용 중인 취소 페널티 해제
app.delete("/api/admin/penalties/:type/:num", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const type = typeValidation.value;
  const num = numValidation.value;
  const year = currentYear();
  const result = dbRun(() =>
    db.prepare(`
      DELETE FROM cancel_penalty
      WHERE num = ? AND inspection = ? AND year = ? AND until > ?
    `).run(num, type, year, Date.now()),
  );

  if (!result.success) {
    logger.warn(req, "penalty.clear", { error: result.error, cause: result.cause, inspection: type, year }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  if (!result.result.changes) {
    logger.warn(req, "penalty.clear", { error: "적용 중인 페널티 없음", inspection: type, year }, `#${num}`);
    return res.status(404).send("적용 중인 페널티가 없습니다.");
  }

  logger.log(req, "penalty.clear", { inspection: type, year }, `#${num}`);
  broadcastPenalties();
  res.status(200).send();
});

/* ============================================
   API 라우트: Admin - 팀 우선순위 관리
   ============================================ */

// GET /api/admin/priority/:type - 검차별 팀 우선순위 조회
app.get("/api/admin/priority/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const result = dbRun(() =>
    db.prepare(`
      SELECT p.* FROM team_priority p
      WHERE p.inspection = ? AND p.year = ?
        AND NOT EXISTS (
          SELECT 1 FROM competition_inactive_team s
          WHERE s.year = p.year AND s.team_num = p.num
        )
      ORDER BY p.priority ASC, p.num ASC
    `).all(req.params.type, currentYear()),
  );

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/admin/priority/:type - 검차별 팀 우선순위 설정/추가
app.post("/api/admin/priority/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const priorityValidation = validatePriority(req.body.priority);
  if (!priorityValidation.valid) {
    return res.status(400).send(priorityValidation.error);
  }

  const activity = requestTeamActivity(req, res, {
    action: "priority.set",
    num: numValidation.value,
  });
  if (!activity.ok) return;
  if (!activity.active) {
    logger.warn(req, "priority.set", {
      error: "inactive_or_missing_team",
      reason: "inactive_or_missing_team",
      year: currentYear(),
      team_num: numValidation.value,
      inspection: req.params.type,
      requested_priority: priorityValidation.value,
    }, `#${numValidation.value}`);
    return res.status(409).send("비활성화된 엔트리에는 우선순위를 설정할 수 없습니다.");
  }

  const result = dbRun(() =>
    db
      .prepare("INSERT OR REPLACE INTO team_priority (num, inspection, year, priority) VALUES (?, ?, ?, ?)")
      .run(numValidation.value, req.params.type, currentYear(), priorityValidation.value),
  );

  if (!result.success) {
    logger.warn(req, "priority.set", { error: result.error, cause: result.cause }, `#${numValidation.value}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "priority.set", { inspection: req.params.type, priority: priorityValidation.value }, `#${numValidation.value}`);

  // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
  broadcastQueue(req.params.type);

  res.status(201).send();
});

// DELETE /api/admin/priority/:type - 검차별 팀 우선순위 삭제
app.delete("/api/admin/priority/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const year = currentYear();
  const result = dbRun(() => db.transaction(() => {
    const prior = db.prepare("SELECT priority FROM team_priority WHERE num = ? AND inspection = ? AND year = ?")
      .get(numValidation.value, req.params.type, year);
    const deleted = db.prepare("DELETE FROM team_priority WHERE num = ? AND inspection = ? AND year = ?")
      .run(numValidation.value, req.params.type, year);
    return { prior, deleted };
  })());

  if (!result.success) {
    logger.warn(req, "priority.delete", {
      error: result.internalError || result.error,
      phase: "mutation_preflight",
      year,
      team_num: numValidation.value,
      inspection: req.params.type,
    }, `#${numValidation.value}`);
    return res.status(result.status).send(result.error);
  }

  if (!result.result.deleted.changes) {
    logger.warn(req, "priority.delete", { error: "존재하지 않는 우선순위 엔트리" }, "#" + numValidation.value);
    return res.status(400).send("존재하지 않는 우선순위 엔트리입니다.");
  }

  logger.log(req, "priority.delete", { inspection: req.params.type, priority: result.result.prior?.priority }, `#${numValidation.value}`);

  // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
  broadcastQueue(req.params.type);

  res.status(200).send();
});

// DELETE /api/admin/priority/:type/all - 검차별 우선순위 전체 초기화
app.delete("/api/admin/priority/:type/all", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const result = dbRun(() => db.prepare("DELETE FROM team_priority WHERE inspection = ? AND year = ?").run(req.params.type, currentYear()));

  if (!result.success) {
    logger.warn(req, "priority.clear", { error: result.error, cause: result.cause }, req.params.type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "priority.clear", null, req.params.type);

  // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
  broadcastQueue(req.params.type);

  res.status(200).send();
});

// GET /api/admin/history/status - 재검 현황 조회
app.get("/api/admin/history/status", (req, res) => {
  const year = currentYear();
  const rows = db.prepare(`
    SELECT DISTINCT h.num, h.inspection
    FROM inspection_history h
    WHERE h.year = ?
      AND NOT EXISTS (
        SELECT 1 FROM competition_inactive_team s
        WHERE s.year = h.year AND s.team_num = h.num
      )
  `).all(year);

  const result = {};
  for (const row of rows) {
    (result[row.inspection] ??= []).push(row.num);
  }
  res.json(result);
});

// DELETE /api/admin/history/:type - 검차별 초검/재검 이력 초기화
app.delete("/api/admin/history/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const type = typeValidation.value;
  const year = currentYear();

  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare("DELETE FROM inspection_history WHERE inspection = ? AND year = ?").run(type, year);

      // 부스 상태 초기화: 해당 검차 종류의 모든 부스 점유 해제
      db.prepare("UPDATE booth SET occupied_by = NULL, entered_at = NULL WHERE inspection = ?").run(type);
    })();
  });

  if (!result.success) {
    logger.warn(req, "history.clear", { error: result.error, cause: result.cause }, type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "history.clear", { year }, type);

  // SSE 브로드캐스트: 이력 초기화 -> 대기열 순서 변경 및 부스 상태 변경
  broadcastQueue(type);
  broadcastBooth(type);

  res.status(200).send();
});

// PUT /api/admin/inspection/:type/ignore - 검차별 우선순위/초검재검 무시 설정
app.put("/api/admin/inspection/:type/ignore", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const type = typeValidation.value;
  const { field, value } = req.body;

  if (!["ignore_priority", "ignore_reinspection"].includes(field)) {
    return res.status(400).send("유효하지 않은 필드입니다.");
  }

  const result = dbRun(() => {
    if (field === "ignore_priority") {
      db.prepare("UPDATE inspection SET ignore_priority = ? WHERE type = ?").run(value ? 1 : 0, type);
    } else {
      db.prepare("UPDATE inspection SET ignore_reinspection = ? WHERE type = ?").run(value ? 1 : 0, type);
    }
  });

  if (!result.success) {
    logger.warn(req, "inspection.ignore", { error: result.error, cause: result.cause }, type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "inspection.ignore", { field, value: !!value }, type);

  // SSE 브로드캐스트: 설정 변경 -> 대기열 순서 변경
  broadcastQueue(type);

  res.status(200).send();
});

/* ============================================
   API 라우트: Admin - 부스 관리
   ============================================ */

// 부스 목록 조회 헬퍼
function getBoothsForType(type) {
  return db.prepare("SELECT booth_num, active, occupied_by, entered_at FROM booth WHERE inspection = ? ORDER BY booth_num").all(type);
}

// GET /api/admin/booths/:type - 검차별 부스 목록 조회
app.get("/api/admin/booths/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const result = dbRun(() => getBoothsForType(req.params.type));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// PATCH /api/admin/booths/:type/config - 부스 수 변경
app.patch("/api/admin/booths/:type/config", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const type = typeValidation.value;
  const count = parseInt(req.body.count, 10);

  if (isNaN(count) || count < 1 || count > 100) {
    return res.status(400).send("부스 수는 1~100 사이여야 합니다.");
  }

  const result = dbRun(() => {
    return db.transaction(() => {
      const config = db.prepare("SELECT count FROM booth_config WHERE inspection = ?").get(type);
      if (!config) throw { status: 400, message: "부스 설정을 찾을 수 없습니다." };
      const currentCount = config.count;

      if (count > currentCount) {
        // 부스 추가
        for (let i = currentCount + 1; i <= count; i++) {
          db.prepare("INSERT INTO booth (inspection, booth_num) VALUES (?, ?)").run(type, i);
        }
      } else if (count < currentCount) {
        // 부스 삭제 (높은 번호부터, 점유 중인 부스는 삭제 불가)
        const boothsToRemove = db.prepare(
          "SELECT booth_num, occupied_by FROM booth WHERE inspection = ? ORDER BY booth_num DESC LIMIT ?"
        ).all(type, currentCount - count);

        for (const booth of boothsToRemove) {
          if (booth.occupied_by !== null) {
            throw { status: 400, message: `부스 ${booth.booth_num}번이 사용 중이므로 삭제할 수 없습니다.` };
          }
        }

        for (const booth of boothsToRemove) {
          db.prepare("DELETE FROM booth WHERE inspection = ? AND booth_num = ?").run(type, booth.booth_num);
        }
      }

      db.prepare("UPDATE booth_config SET count = ? WHERE inspection = ?").run(count, type);
    })();
  });

  if (!result.success) {
    logger.warn(req, "booth.count", { error: result.error, cause: result.cause }, type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "booth.count", { count }, type);

  // SSE 브로드캐스트: 부스 상태 변경
  const booths = getBoothsForType(type);
  broadcastEvent("booth", { type, booths });

  res.status(200).send();
});

// PATCH /api/admin/booths/:type/:boothNum - 부스 활성화/비활성화 토글
app.patch("/api/admin/booths/:type/:boothNum", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const type = typeValidation.value;
  const boothNum = parseInt(req.params.boothNum, 10);

  if (isNaN(boothNum) || boothNum < 1) {
    return res.status(400).send("올바르지 않은 부스 번호입니다.");
  }

  const result = dbRun(() => {
    const booth = db.prepare("SELECT * FROM booth WHERE inspection = ? AND booth_num = ?").get(type, boothNum);

    if (!booth) {
      throw { status: 400, message: "존재하지 않는 부스입니다." };
    }

    if (req.body.active === false && booth.occupied_by !== null) {
      throw { status: 400, message: "사용 중인 부스는 비활성화할 수 없습니다." };
    }

    db.prepare("UPDATE booth SET active = ? WHERE inspection = ? AND booth_num = ?").run(
      req.body.active === true ? 1 : 0, type, boothNum
    );
  });

  if (!result.success) {
    logger.warn(req, "booth.toggle", { error: result.error, cause: result.cause, booth: boothNum, active: req.body.active === true }, type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "booth.toggle", { booth: boothNum, active: req.body.active === true }, type);

  // SSE 브로드캐스트: 부스 상태 변경
  const booths = getBoothsForType(type);
  broadcastEvent("booth", { type, booths });

  res.status(200).send();
});

// POST /api/admin/booths/:type/:boothNum/enter - 대기열에서 부스로 입장
app.post("/api/admin/booths/:type/:boothNum/enter", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const type = typeValidation.value;
  const num = numValidation.value;
  const boothNum = parseInt(req.params.boothNum, 10);

  if (isNaN(boothNum) || boothNum < 1) {
    return res.status(400).send("올바르지 않은 부스 번호입니다.");
  }

  const year = currentYear();

  const activity = requestTeamActivity(req, res, { action: "booth.enter", num, year });
  if (!activity.ok) return;
  if (!activity.active) {
    logger.warn(req, "booth.enter", {
      error: "inactive_or_missing_team",
      reason: "inactive_or_missing_team",
      year,
      team_num: num,
      inspection: type,
      booth: boothNum,
    }, `#${num}`);
    return res.status(409).send("비활성화된 엔트리는 부스에 입장시킬 수 없습니다.");
  }

  const result = dbRun(() => {
    return db.transaction(() => {
      const smsRank = parseInt(db.prepare(`SELECT value FROM settings WHERE key = 'sms_rank'`).get()?.value || "3", 10);
      const prev = getQueueStmt(type, "offset").get(...getQueueParams(type, year), smsRank - 1);
      // 대기열에 팀이 있는지 확인
      const queueEntry = getQueueRow(type, num, year);
      if (!queueEntry) {
        throw { status: 400, message: "대기열에 존재하지 않는 엔트리입니다." };
      }

      // 부스 확인
      const booth = db.prepare("SELECT * FROM booth WHERE inspection = ? AND booth_num = ?").get(type, boothNum);
      if (!booth) {
        throw { status: 400, message: "존재하지 않는 부스입니다." };
      }
      if (!booth.active) {
        throw { status: 400, message: "비활성화된 부스입니다." };
      }
      if (booth.occupied_by !== null) {
        throw { status: 400, message: "이미 사용 중인 부스입니다." };
      }

      const now = Date.now();

      // 대기열에서 제거 및 길이 감소
      deleteQueueRow(type, num, year);

      // 부스 점유
      db.prepare("UPDATE booth SET occupied_by = ?, occupied_team_id = ?, entered_at = ? WHERE inspection = ? AND booth_num = ?").run(
        num, activity.team?.id ?? null, now, type, boothNum
      );

      // 부스 로그 기록
      db.prepare("INSERT INTO booth_log (num, inspection, booth_num, entered_at, created_at, year) VALUES (?, ?, ?, ?, ?, ?)").run(
        num, type, boothNum, now, now, year
      );

      // 대기열 이벤트 로그 기록
      db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)").run(
        "enter", num, type, now, year
      );

      // current 테이블에서 해당 검차 종류 제거
      const current = getCurrentEntry(num, year);
      if (current) {
        const remaining = current.inspections.filter((i) => i !== type);
        setCurrentInspections(num, current.phone, remaining, year);
      }
      return { prev };
    })();
  });

  if (!result.success) {
    logger.warn(req, "booth.enter", {
      error: result.internalError || result.error,
      phase: "mutation_preflight",
      year,
      team_num: num,
      inspection: type,
      booth: boothNum,
    }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "booth.enter", {
    inspection: type,
    booth: boothNum,
    year,
    team_id: activity.team?.id ?? null,
  }, `#${num}`);

  // SSE 브로드캐스트: 부스 및 대기열 변경
  broadcastBooth(type);
  broadcastQueue(type);

  res.status(200).send();

  // SMS 발송 (N번째 대기자에게)
  sendSmsNotification(type, result.result.prev);
});

// POST /api/admin/booths/:type/:boothNum/exit - 부스에서 퇴장 (검차 완료)
app.post("/api/admin/booths/:type/:boothNum/exit", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const type = typeValidation.value;
  const boothNum = parseInt(req.params.boothNum, 10);

  if (isNaN(boothNum) || boothNum < 1) {
    return res.status(400).send("올바르지 않은 부스 번호입니다.");
  }

  let boothBefore = null;
  const result = dbRun(() =>
    db.transaction(() => {
      const booth = db.prepare("SELECT * FROM booth WHERE inspection = ? AND booth_num = ?").get(type, boothNum);
      if (!booth) {
        throw { status: 400, message: "존재하지 않는 부스입니다." };
      }
      if (booth.occupied_by === null) {
        throw { status: 400, message: "비어있는 부스입니다." };
      }
      boothBefore = {
        occupied_by: booth.occupied_by,
        occupied_team_id: booth.occupied_team_id ?? null,
        entered_at: booth.entered_at ?? null,
      };

      const now = Date.now();
      const current = currentYear();
      const persistedTeamId = Number(booth.occupied_team_id);
      const hasPersistedTeamId = Number.isInteger(persistedTeamId) && persistedTeamId > 0;
      const canonical = hasPersistedTeamId && options.teamStore?.getById
        ? options.teamStore.getById(persistedTeamId)
        : null;
      if (hasPersistedTeamId && options.teamStore?.getById
          && (!canonical || canonical.number !== booth.occupied_by)) {
        throw { status: 409, message: "부스의 팀 정보가 일치하지 않습니다." };
      }
      const num = canonical?.number ?? booth.occupied_by;
      const stateYear = canonical?.year ?? current;
      const historicalState = stateYear !== current;
      const logHasTeamId = tableColumns(db, "booth_log").has("team_id");
      let logMutation;
      if (logHasTeamId && hasPersistedTeamId) {
        logMutation = historicalState
          ? db.prepare(`
              DELETE FROM booth_log
              WHERE team_id = ? AND inspection = ? AND booth_num = ? AND year = ? AND exited_at IS NULL
            `).run(persistedTeamId, type, boothNum, stateYear)
          : db.prepare(`
              UPDATE booth_log SET exited_at = ?
              WHERE team_id = ? AND inspection = ? AND booth_num = ? AND year = ? AND exited_at IS NULL
            `).run(now, persistedTeamId, type, boothNum, stateYear);
      } else {
        logMutation = historicalState
          ? db.prepare(`
              DELETE FROM booth_log
              WHERE num = ? AND inspection = ? AND booth_num = ? AND year = ? AND exited_at IS NULL
            `).run(num, type, boothNum, stateYear)
          : db.prepare(`
              UPDATE booth_log SET exited_at = ?
              WHERE num = ? AND inspection = ? AND booth_num = ? AND year = ? AND exited_at IS NULL
            `).run(now, num, type, boothNum, stateYear);
      }
      if (logMutation.changes !== 1) {
        throw { status: 409, message: "부스 사용 기록이 일치하지 않습니다." };
      }

      // 연도가 바뀐 뒤 남은 점유는 완료 이력으로 오인하지 않고 미완료 transient 상태로 정리한다.
      if (!historicalState) {
        if (tableColumns(db, "inspection_history").has("team_id") && hasPersistedTeamId) {
          db.prepare(`
            INSERT INTO inspection_history (num, inspection, timestamp, year, team_id)
            VALUES (?, ?, ?, ?, ?)
          `).run(num, type, now, stateYear, persistedTeamId);
        } else {
          db.prepare("INSERT INTO inspection_history (num, inspection, timestamp, year) VALUES (?, ?, ?, ?)")
            .run(num, type, now, stateYear);
        }
      }

      db.prepare(`
        UPDATE booth SET occupied_by = NULL, occupied_team_id = NULL, entered_at = NULL
        WHERE inspection = ? AND booth_num = ?
      `).run(type, boothNum);

      return {
        num,
        teamId: hasPersistedTeamId ? persistedTeamId : null,
        stateYear,
        currentYear: current,
        normalizedHistoricalState: historicalState,
        before: boothBefore,
        logAction: historicalState ? "deleted_incomplete" : "closed",
      };
    })()
  );

  if (!result.success) {
    logger.warn(req, "booth.exit", {
      error: result.internalError || result.error,
      inspection: type,
      booth: boothNum,
      current_year: currentYear(),
      before: boothBefore,
    }, type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "booth.exit", {
    inspection: type,
    booth: boothNum,
    team_id: result.result.teamId,
    team_num: result.result.num,
    state_year: result.result.stateYear,
    current_year: result.result.currentYear,
    normalized_historical_state: result.result.normalizedHistoricalState,
    before: result.result.before,
    after: { occupied_by: null, occupied_team_id: null, entered_at: null },
    open_log: { action: result.result.logAction, count: 1 },
  }, `#${result.result.num}`);

  // SSE 브로드캐스트: 부스 및 대기열 변경
  broadcastBooth(type);
  broadcastQueue(type);

  res.status(200).send();
});

/* ============================================
   API 라우트: Admin - 통계
   ============================================ */

// GET /api/admin/stats/timerange - 특정 연도의 로그 시간 범위 조회
app.get("/api/admin/stats/timerange", (req, res) => {
  const year = parseYearQuery(req.query.year);
  if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
  const { from: yearStart, to: yearEnd } = competitionYearBounds(year);

  const result = dbRun(() => {
    const q = db.prepare(
      `SELECT MIN(timestamp) as minTs, MAX(timestamp) as maxTs FROM queue_log
       WHERE year = ? AND timestamp >= ? AND timestamp <= ?
         AND NOT EXISTS (
           SELECT 1 FROM competition_inactive_team s
           WHERE s.year = queue_log.year AND s.team_num = queue_log.num
         )`
    ).get(year, yearStart, yearEnd);
    const b = db.prepare(
      `SELECT MIN(entered_at) as minTs, MAX(COALESCE(exited_at, entered_at)) as maxTs FROM booth_log
       WHERE year = ? AND entered_at >= ? AND entered_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM competition_inactive_team s
           WHERE s.year = booth_log.year AND s.team_num = booth_log.num
         )`
    ).get(year, yearStart, yearEnd);

    const mins = [q?.minTs, b?.minTs].filter(Boolean);
    const maxs = [q?.maxTs, b?.maxTs].filter(Boolean);

    return {
      from: mins.length ? Math.min(...mins) : null,
      to: maxs.length ? Math.max(...maxs) : null,
    };
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// GET /api/admin/stats - 전체 팀별 통계 조회
app.get("/api/admin/stats", (req, res) => {
  const { from, to, inspection } = req.query;
  const year = parseYearQuery(req.query.year);
  if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");

  if (inspection) {
    const typeValidation = validateInspection(inspection);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }
  }

  const queueLogConditions = ["year = ?", `NOT EXISTS (
    SELECT 1 FROM competition_inactive_team s
    WHERE s.year = queue_log.year AND s.team_num = queue_log.num
  )`];
  const queueLogParams = [year];
  const boothLogConditions = ["year = ?", "exited_at IS NOT NULL", `NOT EXISTS (
    SELECT 1 FROM competition_inactive_team s
    WHERE s.year = booth_log.year AND s.team_num = booth_log.num
  )`];
  const boothLogParams = [year];

  if (from) {
    queueLogConditions.push("timestamp >= ?");
    queueLogParams.push(Number(from));
    boothLogConditions.push("entered_at >= ?");
    boothLogParams.push(Number(from));
  }
  if (to) {
    queueLogConditions.push("timestamp <= ?");
    queueLogParams.push(Number(to));
    boothLogConditions.push("exited_at <= ?");
    boothLogParams.push(Number(to));
  }
  if (inspection) {
    queueLogConditions.push("inspection = ?");
    queueLogParams.push(inspection);
    boothLogConditions.push("inspection = ?");
    boothLogParams.push(inspection);
  }

  const queueLogWhere = queueLogConditions.length ? `WHERE ${queueLogConditions.join(" AND ")}` : "";
  const boothLogWhere = `WHERE ${boothLogConditions.join(" AND ")}`;

  const result = dbRun(() => {
    const queueStats = db.prepare(`
      SELECT num,
        SUM(CASE WHEN event = 'register' THEN 1 ELSE 0 END) as registrations,
        SUM(CASE WHEN event = 'cancel' THEN 1 ELSE 0 END) as cancellations,
        SUM(CASE WHEN event = 'enter' THEN 1 ELSE 0 END) as entries
      FROM queue_log
      ${queueLogWhere}
      GROUP BY num
    `).all(...queueLogParams);

    const boothStats = db.prepare(`
      SELECT num, SUM(exited_at - entered_at) as totalOccupyTime
      FROM booth_log
      ${boothLogWhere}
      GROUP BY num
    `).all(...boothLogParams);

    const statsMap = new Map();
    for (const row of queueStats) {
      statsMap.set(row.num, {
        num: row.num,
        registrations: row.registrations,
        cancellations: row.cancellations,
        entries: row.entries,
        totalOccupyTime: 0,
      });
    }
    for (const row of boothStats) {
      if (statsMap.has(row.num)) {
        statsMap.get(row.num).totalOccupyTime = row.totalOccupyTime;
      } else {
        statsMap.set(row.num, {
          num: row.num,
          registrations: 0,
          cancellations: 0,
          entries: 0,
          totalOccupyTime: row.totalOccupyTime,
        });
      }
    }

    return Array.from(statsMap.values());
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// GET /api/admin/stats/:num - 팀별 상세 통계 및 타임라인 조회
app.get("/api/admin/stats/:num", (req, res) => {
  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const num = numValidation.value;
  const { from, to, inspection } = req.query;
  const year = parseYearQuery(req.query.year);
  if (year == null) return res.status(400).send("올바르지 않은 연도입니다.");
  const activity = requestTeamActivity(req, res, { action: "stats.view", num, year });
  if (!activity.ok) return;
  if (!activity.active) return res.status(404).send("엔트리를 찾을 수 없습니다.");

  if (inspection) {
    const typeValidation = validateInspection(inspection);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }
  }

  const queueLogConditions = ["num = ?", "year = ?"];
  const queueLogParams = [num, year];
  const boothLogConditions = ["num = ?", "year = ?"];
  const boothLogParams = [num, year];
  const boothLogOccupyConditions = ["num = ?", "year = ?", "exited_at IS NOT NULL"];
  const boothLogOccupyParams = [num, year];

  // 타임라인용 boothLogConditions 는 구간과 "겹치는" 세션을 넉넉히 가져온다.
  // 입차/출차 이벤트는 각자 자기 타임스탬프(entered_at/exited_at)로 아래에서
  // 개별 필터링하므로, 여기서 exited_at 으로 행을 거르면 안 된다. 그렇게 하면
  // 검차중(exited_at IS NULL) 세션이 통째로 빠져 입차 이벤트가 출차 전까지
  // 숨겨지고, 출차 시 입차·출차가 동시에 나타나는 버그가 생긴다.
  if (from) {
    queueLogConditions.push("timestamp >= ?");
    queueLogParams.push(Number(from));
    // from 이전에 이미 종료된 세션만 제외(검차중 세션은 유지)
    boothLogConditions.push("(exited_at IS NULL OR exited_at >= ?)");
    boothLogParams.push(Number(from));
    boothLogOccupyConditions.push("entered_at >= ?");
    boothLogOccupyParams.push(Number(from));
  }
  if (to) {
    queueLogConditions.push("timestamp <= ?");
    queueLogParams.push(Number(to));
    // to 이후에 시작한 세션만 제외
    boothLogConditions.push("entered_at <= ?");
    boothLogParams.push(Number(to));
    boothLogOccupyConditions.push("exited_at <= ?");
    boothLogOccupyParams.push(Number(to));
  }
  if (inspection) {
    queueLogConditions.push("inspection = ?");
    queueLogParams.push(inspection);
    boothLogConditions.push("inspection = ?");
    boothLogParams.push(inspection);
    boothLogOccupyConditions.push("inspection = ?");
    boothLogOccupyParams.push(inspection);
  }

  const queueLogWhere = `WHERE ${queueLogConditions.join(" AND ")}`;
  const boothLogWhere = `WHERE ${boothLogConditions.join(" AND ")}`;
  const boothLogOccupyWhere = `WHERE ${boothLogOccupyConditions.join(" AND ")}`;

  const result = dbRun(() => {
    const queueSummary = db.prepare(`
      SELECT
        SUM(CASE WHEN event = 'register' THEN 1 ELSE 0 END) as registrations,
        SUM(CASE WHEN event = 'cancel' THEN 1 ELSE 0 END) as cancellations,
        SUM(CASE WHEN event = 'enter' THEN 1 ELSE 0 END) as entries
      FROM queue_log
      ${queueLogWhere}
    `).get(...queueLogParams);

    const occupyResult = db.prepare(`
      SELECT COALESCE(SUM(exited_at - entered_at), 0) as totalOccupyTime
      FROM booth_log
      ${boothLogOccupyWhere}
    `).get(...boothLogOccupyParams);

    // Register, cancel, and restore events from queue_log
    const queueEvents = db.prepare(`
      SELECT event, inspection, timestamp
      FROM queue_log
      ${queueLogWhere} AND event IN ('register', 'cancel', 'restore')
      ORDER BY timestamp ASC
    `).all(...queueLogParams).map((row) => ({
      event: row.event,
      inspection: row.inspection,
      timestamp: row.timestamp,
    }));

    // Enter/exit events from booth_log
    const boothLogs = db.prepare(`
      SELECT inspection, booth_num as boothNum, entered_at as enteredAt, exited_at as exitedAt
      FROM booth_log
      ${boothLogWhere}
      ORDER BY entered_at ASC
    `).all(...boothLogParams);

    // 입차 이벤트는 entered_at, 출차 이벤트는 exited_at 기준으로 각각 구간에
    // 속하는지 개별 판단한다. 검차중(exited_at NULL) 세션도 입차가 즉시 노출된다.
    const fromTs = from ? Number(from) : null;
    const toTs = to ? Number(to) : null;
    const inRange = (ts) => (fromTs == null || ts >= fromTs) && (toTs == null || ts <= toTs);

    const boothEvents = [];
    for (const row of boothLogs) {
      if (inRange(row.enteredAt)) {
        boothEvents.push({
          event: "enter",
          inspection: row.inspection,
          boothNum: row.boothNum,
          timestamp: row.enteredAt,
        });
      }
      if (row.exitedAt && inRange(row.exitedAt)) {
        boothEvents.push({
          event: "exit",
          inspection: row.inspection,
          boothNum: row.boothNum,
          timestamp: row.exitedAt,
          duration: row.exitedAt - row.enteredAt,
        });
      }
    }

    const timeline = [...queueEvents, ...boothEvents].sort((a, b) => a.timestamp - b.timestamp);

    return {
      summary: {
        registrations: queueSummary.registrations || 0,
        cancellations: queueSummary.cancellations || 0,
        entries: queueSummary.entries || 0,
        totalOccupyTime: occupyResult.totalOccupyTime,
      },
      timeline,
    };
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

/* ============================================
   API 라우트: 설정
   ============================================ */

// GET /api/admin/settings/sms - SMS 설정 조회
app.get("/api/admin/settings/sms", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT value FROM settings WHERE key = ?").get("sms"));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json({ value: result.result.value === "TRUE" });
});

// PATCH /api/admin/settings/sms - SMS 설정 변경
app.patch("/api/admin/settings/sms", (req, res) => {
  if (req.body.value === true) {
    if (!smsClient.isAvailable()) {
      logger.warn(req, "settings.sms", {
        error: "sms_configuration_unavailable",
        reason: "sms_configuration_unavailable",
        requested_enabled: true,
      }, "sms");
      return res.status(400).send("SMS 설정이 되어 있지 않습니다. 이메일/SMS 서비스에서 설정해 주세요.");
    }
  }

  const result = dbRun(() =>
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(req.body.value === true ? "TRUE" : "FALSE", "sms"),
  );

  if (!result.success) {
    logger.warn(req, "settings.sms", { error: result.error, cause: result.cause });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "settings.sms", { enabled: req.body.value === true });
  res.status(200).send();
});

// GET /api/admin/settings/sms-rank - SMS 알림 순번 조회
app.get("/api/admin/settings/sms-rank", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT value FROM settings WHERE key = ?").get("sms_rank"));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json({ value: parseInt(result.result?.value || "3", 10) });
});

// PATCH /api/admin/settings/sms-rank - SMS 알림 순번 변경
app.patch("/api/admin/settings/sms-rank", (req, res) => {
  const rank = parseInt(req.body.value, 10);
  if (isNaN(rank) || rank < 1 || rank > 10) {
    return res.status(400).send("알림 순번은 1~10 사이의 값이어야 합니다.");
  }

  const result = dbRun(() => db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(String(rank), "sms_rank"));

  if (!result.success) {
    logger.warn(req, "settings.sms_rank", { error: result.error, cause: result.cause });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "settings.sms_rank", { rank });
  res.status(200).send();
});

// GET /api/admin/settings/cancel-penalty - 취소 페널티 시간 조회
app.get("/api/admin/settings/cancel-penalty", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT value FROM settings WHERE key = ?").get("cancel_penalty"));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json({ value: parseInt(result.result?.value || "10", 10) });
});

// PATCH /api/admin/settings/cancel-penalty - 취소 페널티 시간 변경
app.patch("/api/admin/settings/cancel-penalty", (req, res) => {
  const minutes = parseInt(req.body.value, 10);
  if (isNaN(minutes) || minutes < 0 || minutes > 60) {
    return res.status(400).send("페널티 시간은 0~60분 사이의 값이어야 합니다.");
  }

  const result = dbRun(() =>
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(String(minutes), "cancel_penalty"),
  );

  if (!result.success) {
    logger.warn(req, "settings.cancel_penalty", { error: result.error, cause: result.cause });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "settings.cancel_penalty", { minutes });
  res.status(200).send();
});

/* ============================================
   유틸리티 함수
   ============================================ */
async function getEntries() {
  if (!options.teamStore) throw new Error("Competition team store is required");
  return options.teamStore.moduleEntries(currentYear());
}

// Competition 은 이 클라이언트를 Registration 에도 넘겨 한 프로세스가 SENS 자격
// 증명 한 벌과 갱신 타이머 하나만 갖도록 한다(createRegistrationApp options.smsClient).
const smsClient = createSmsClient({
  logger,
  smsRequest: options.smsRequest,
  smsConfig: options.smsConfig,
  fetchImpl: options.fetchImpl,
});
const loadSmsConfig = smsClient.loadConfig;

// SMS 켜져 있는데 설정을 못 쓰는 상태의 skip 경고(60초 스로틀) — 발송마다 쌓이지 않게.
// Registration 의 registration.sms_skip 과 같은 규칙을 공유한다.
const warnSmsSkipThrottled = createThrottledSkipWarning(logger, "sms.skip");

function sendSmsNotification(type, prev) {
  let target;
  try {
    if (db.prepare(`SELECT value FROM settings WHERE key = 'sms'`).get()?.value !== "TRUE") {
      return;
    }

    const year = currentYear();
    const smsRank = parseInt(db.prepare(`SELECT value FROM settings WHERE key = 'sms_rank'`).get()?.value || "3", 10);
    target = getQueueStmt(type, "offset").get(...getQueueParams(type, year), smsRank - 1);

    if (target && (!prev || target.num !== prev.num)) {
      if (!smsClient.isAvailable()) {
        warnSmsSkipThrottled({
          reason: "SMS 설정을 사용할 수 없습니다(email 서비스 미응답 또는 설정 미완성)",
          num: target.num, type,
        });
        return;
      }
      smsClient.send(
        target.phone,
        `[FSK ${currentCompetitionYear()}]\n엔트리 ${target.num}번 ${inspections[type]} 검차 대기 순서 ${smsRank}번입니다.\n차량과 함께 검차장으로 오세요.`,
      ).then(
        ({ response, status }) => logger.log(null, "sms.send", {
          response, status, num: target.num, type,
        }),
        // SENS 가 응답한 4xx/5xx 는 계속 sms.send(warn) 로 남긴다 — 저장된 로그
        // 조회와의 연속성을 위해서다. 소켓 오류만 sms.error, 타임아웃은 sms.timeout.
        (error) => logger.warn(null, error?.code === "SMS_TIMEOUT"
          ? "sms.timeout"
          : (error?.status ? "sms.send" : "sms.error"), {
          error: error?.response || error?.message || String(error),
          status: error?.status,
          num: target.num,
          type,
        }),
      );
    }
  } catch (e) {
    logger.warn(null, "sms.error", { error: String(e), num: target?.num, type });
  }
}

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
if (!options.skipSpaFallback) addSpaFallback(app);

return { app, db, loadSmsConfig, smsClient, closeSse, sourceEvent, timers: [rateLimitTimer, smsClient.timer] };
}
