import https from "https";
import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase, addColumn } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createSSEManager } from "../shared/sse.mjs";

export const INSPECTIONS = {
  battery: "배터리",
  electric: "전기",
  chassis: "섀시",
  tilting: "틸팅",
  braking: "제동",
  noise: "소음",
  rain: "우천",
  report: "보고서",
};

export function createQueueApp(options = {}) {

const inspections = INSPECTIONS;

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
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > 30) return res.status(429).send("요청이 너무 많습니다.");
  next();
}

const db = createDatabase(Database, options.dbPath || "./data/queue.db");

db.transaction(() => {
  // 검차 종류 메타 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS inspection (
    type TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    length INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    ignore_priority BOOLEAN NOT NULL DEFAULT FALSE,
    ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE
  );`);

  // 마이그레이션: 기존 테이블에 컬럼 추가
  addColumn(db, "inspection", "ignore_priority BOOLEAN NOT NULL DEFAULT FALSE");
  addColumn(db, "inspection", "ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE");
  addColumn(db, "inspection", "hidden_from_register BOOLEAN NOT NULL DEFAULT FALSE");

  // 팀별 검차별 우선순위 테이블 (1이 가장 높음, 숫자가 클수록 낮음)
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
    PRIMARY KEY (num, inspection, timestamp)
  );`);

  // 현재 대기중인 엔트리 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS current (
    num INTEGER PRIMARY KEY,
    phone TEXT NOT NULL,
    inspection TEXT NOT NULL
  );`);

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
    entered_at INTEGER NULL,
    PRIMARY KEY (inspection, booth_num)
  );`);

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

  // 검차 종류별 대기열 테이블 생성 및 부스 기본 데이터 생성
  for (const [k, v] of Object.entries(inspections)) {
    db.prepare(`INSERT OR IGNORE INTO inspection (type, name) VALUES (?, ?)`).run(k, v);
    db.exec(`CREATE TABLE IF NOT EXISTS '${k}' (
      num INTEGER PRIMARY KEY,
      phone TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );`);

    // 부스 기본 설정: 검차 종류당 1개 부스
    db.prepare(`INSERT OR IGNORE INTO booth_config (inspection, count) VALUES (?, 1)`).run(k);
    db.prepare(`INSERT OR IGNORE INTO booth (inspection, booth_num) VALUES (?, 1)`).run(k);
  }

  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("sms", "FALSE");
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("sms_rank", "3");
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("cancel_penalty", "10");

  if (
    !process.env.NAVER_CLOUD_ACCESS_KEY ||
    !process.env.NAVER_CLOUD_SECRET_KEY ||
    !process.env.NAVER_CLOUD_SMS_SERVICE_ID ||
    !process.env.PHONE_NUMBER_SMS_SENDER
  ) {
    db.prepare(`UPDATE settings SET value = ? WHERE key = ?`).run("FALSE", "sms");
  }

  // 인덱스 생성
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ih_num_insp ON inspection_history(num, inspection)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tp_insp_prio ON team_priority(inspection, priority, num)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bl_active ON booth_log(num, inspection, booth_num, exited_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ql_num ON queue_log(num)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ql_insp_ts ON queue_log(inspection, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cp_num_insp ON cancel_penalty(num, inspection)`);
})();

// 연도 컬럼 마이그레이션 (기존 스키마 생성과 분리)
{
  const yr = new Date().getFullYear();

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

  // cancel_penalty: year를 PK에 추가
  const cpInfo = db.prepare("PRAGMA table_info(cancel_penalty)").all();
  if (!cpInfo.some(c => c.name === "year")) {
    db.transaction(() => {
      db.exec(`CREATE TABLE cancel_penalty_new (
        num INTEGER NOT NULL,
        inspection TEXT NOT NULL,
        year INTEGER NOT NULL,
        until INTEGER NOT NULL,
        PRIMARY KEY (num, inspection, year)
      )`);
      db.exec(`INSERT INTO cancel_penalty_new SELECT num, inspection, ${yr}, until FROM cancel_penalty`);
      db.exec(`DROP TABLE cancel_penalty`);
      db.exec(`ALTER TABLE cancel_penalty_new RENAME TO cancel_penalty`);
      db.exec(`CREATE INDEX idx_cp_num_insp ON cancel_penalty(year, num, inspection)`);
    })();
  }

  // 나머지 테이블: year 컬럼 추가
  addColumn(db, "inspection_history", `year INTEGER NOT NULL DEFAULT ${yr}`);
  addColumn(db, "current", `year INTEGER NOT NULL DEFAULT ${yr}`);
  addColumn(db, "booth_log", `year INTEGER NOT NULL DEFAULT ${yr}`);
  addColumn(db, "queue_log", `year INTEGER NOT NULL DEFAULT ${yr}`);
  for (const k of Object.keys(INSPECTIONS)) {
    addColumn(db, `'${k}'`, `year INTEGER NOT NULL DEFAULT ${yr}`);
  }
}

/* ============================================
   Express 앱 설정
   ============================================ */
function currentYear() {
  return new Date().getFullYear();
}

const logger = createLogger(db, "queue");

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path.startsWith("/api/internal/")) return "admin";
  // Chief-only: 우선순위, 이력 초기화, 설정 변경, 검차 활성화/표시/무시, 부스 수 설정
  if (req.path.startsWith("/api/admin/priority")) return "chief";
  if (req.path.startsWith("/api/admin/history")) return "chief";
  if (req.path.startsWith("/api/admin/settings") && req.method !== "GET") return "chief";
  if (/^\/api\/admin\/inspection\/[^/]+\/(visibility|ignore)/.test(req.path)) return "chief";
  if (req.method === "PATCH" && /^\/api\/admin\/inspection\/[^/]+$/.test(req.path)) return "chief";
  if (/^\/api\/admin\/booths\/[^/]+\/config$/.test(req.path)) return "chief";
  // Official: 나머지 admin (대기열 조회, 등록, 취소, 개별 부스 토글, 입/출차 등)
  if (req.path.startsWith("/api/admin")) return "official";
  // SPA routes
  if (/^\/priority(\/|$)/.test(req.path)) return "chief";
  if (/^\/(admin|register|stats)/.test(req.path)) return "official";
  if (req.path === "/api/logs") return "admin";
  if (req.path === "/api/events") return null;
  if (req.path === "/api/active") return null;
  if (req.path.startsWith("/api/booths/")) return null;
  if (req.path.startsWith("/api/state/")) return null;
  if (req.path.startsWith("/api/")) return "official"; // API 기본값: default-close
  return null; // SPA (public display)
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

// SSE 엔드포인트
app.get("/api/events", sseHandler(() => {
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  const allBooths = {};
  for (const row of db.prepare("SELECT inspection, booth_num, active, occupied_by, entered_at FROM booth ORDER BY inspection, booth_num").all()) {
    (allBooths[row.inspection] ||= []).push(row);
  }
  return { activeInspections, allBooths };
}));

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateEntryNum(num) {
  const parsed = Number(num);
  if (num === "" || num === undefined || Number.isNaN(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    return { valid: false, error: "올바르지 않은 엔트리 번호입니다." };
  }
  return { valid: true, value: parsed };
}

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
  if (priority === "" || priority === undefined || Number.isNaN(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    return { valid: false, error: "우선순위는 1 이상의 정수여야 합니다." };
  }
  return { valid: true, value: parsed };
}

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/**
 * 대기열 조회 쿼리 (정렬 순서: 초검 > 재검, 우선순위 높음 > 낮음, 선착순)
 * 파라미터 순서: [inspection, year, inspection, year, year]
 */
function getQueueQuery(inspection) {
  const meta = db.prepare("SELECT ignore_priority, ignore_reinspection FROM inspection WHERE type = ?").get(inspection);
  const ignoreReinspection = meta?.ignore_reinspection;
  const ignorePriority = meta?.ignore_priority;

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
    FROM '${inspection}' AS t
    LEFT JOIN team_priority AS p ON t.num = p.num AND p.inspection = ? AND p.year = ?
    WHERE t.year = ?
    ORDER BY ${orderClauses.join(", ")}
  `;
}

function getQueueParams(inspection, year) {
  return [inspection, year, inspection, year, year];
}

/**
 * 특정 엔트리의 대기열 순위 조회
 */
function getQueueRank(inspection, num, year) {
  const meta = db.prepare("SELECT ignore_priority, ignore_reinspection FROM inspection WHERE type = ?").get(inspection);
  const ignoreReinspection = meta?.ignore_reinspection;
  const ignorePriority = meta?.ignore_priority;

  const orderClauses = [];
  if (!ignoreReinspection) orderClauses.push(`CASE WHEN EXISTS (
              SELECT 1 FROM inspection_history h WHERE h.num = t.num AND h.inspection = ? AND h.year = ?
            ) THEN 1 ELSE 0 END ASC`);
  if (!ignorePriority) orderClauses.push("COALESCE(p.priority, 999) ASC");
  orderClauses.push("t.timestamp ASC");

  const params = [];
  if (!ignoreReinspection) params.push(inspection, year);
  params.push(inspection, year); // for LEFT JOIN team_priority
  params.push(year); // for WHERE t.year = ?
  params.push(num); // for WHERE sub.num = ?

  const result = db
    .prepare(`
    SELECT sub.rank FROM (
      SELECT t.num,
        ROW_NUMBER() OVER (
          ORDER BY ${orderClauses.join(", ")}
        ) AS rank
      FROM '${inspection}' AS t
      LEFT JOIN team_priority AS p ON t.num = p.num AND p.inspection = ? AND p.year = ?
      WHERE t.year = ?
    ) AS sub WHERE sub.num = ?
  `)
    .get(...params);

  return result ? result.rank : null;
}

/* ============================================
   API 라우트: Public
   ============================================ */

// GET /api/active - 활성화된 검차 목록 조회
app.get("/api/active", (req, res) => {
  const result = dbRun(() => db.prepare("SELECT * FROM inspection WHERE active = TRUE").all());

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
    const entry = db.prepare("SELECT * FROM current WHERE num = ? AND year = ?").get(num, year);

    if (!entry) {
      return { queue: undefined, rank: -1 };
    }

    if (typeof req.body.phone !== "string") {
      throw { status: 400, message: "전화번호 형식이 올바르지 않습니다." };
    }
    if (entry.phone !== req.body.phone) {
      throw { status: 400, message: "전화번호가 일치하지 않습니다." };
    }

    if (entry.inspection.includes(",")) {
      const ranks = { queue: [], rank: [] };

      for (let inspection of entry.inspection.split(",")) {
        ranks.queue.push(inspections[inspection]);
        ranks.rank.push(getQueueRank(inspection, num, year));
      }

      return { queue: ranks.queue.join(", "), rank: ranks.rank.join(", ") };
    } else {
      const rank = getQueueRank(entry.inspection, num, year);
      return { queue: inspections[entry.inspection], rank: rank };
    }
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// GET /api/booths/:type - 공개 부스 상태 조회
app.get("/api/booths/all", (req, res) => {
  const result = dbRun(() => {
    const allBooths = {};
    for (const k of Object.keys(inspections)) {
      allBooths[k] = getBoothsForType(k);
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
  const result = dbRun(() => db.prepare("SELECT * FROM inspection").all());

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
  const result = dbRun(() => db.prepare(getQueueQuery(req.params.type)).all(...getQueueParams(req.params.type, year)));

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
    logger.warn(req, "inspection.toggle", { error: result.error }, req.params.type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "inspection.toggle", { active: req.body.active === true }, req.params.type);

  // SSE 브로드캐스트: 활성 검차 목록 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("inspections", { activeInspections });

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
    logger.warn(req, "inspection.visibility", { error: result.error }, req.params.type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "inspection.visibility", { active: !(req.body.hidden === true) }, req.params.type);

  // SSE 브로드캐스트: 활성 검차 목록 변경 (hidden 정보 포함)
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("inspections", { activeInspections });

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

  try {
    const entries = await getEntries();

    if (entries[num] === undefined) {
      return res.status(400).send("존재하지 않는 엔트리 번호입니다.");
    }
  } catch (e) {
    logger.warn(req, "queue.entry_lookup", { error: e.message, num });
    return res.status(500).send("엔트리를 조회할 수 없습니다.");
  }

  const result = dbRun(() => {
    db.transaction(() => {
      if (!db.prepare("SELECT active FROM inspection WHERE type = ?").get(type).active) {
        throw { status: 400, message: "대기열이 비활성화 상태입니다." };
      }

      const year = currentYear();

      // 페널티 확인
      const penalty = db.prepare("SELECT * FROM cancel_penalty WHERE num = ? AND inspection = ? AND year = ?").get(num, type, year);
      if (penalty && penalty.until > Date.now()) {
        const remaining = Math.ceil((penalty.until - Date.now()) / 1000 / 60);
        throw {
          status: 403,
          message: JSON.stringify({ remaining, until: penalty.until }),
        };
      } else if (penalty) {
        // 만료된 페널티 삭제
        db.prepare("DELETE FROM cancel_penalty WHERE num = ? AND inspection = ? AND year = ?").run(num, type, year);
      }

      const current = db.prepare("SELECT * FROM current WHERE num = ? AND year = ?").get(num, year);

      if (current) {
        const currentTypes = current.inspection.split(",");

        if (currentTypes.includes(type)) {
          const name = inspections[type];
          throw { status: 400, message: `이미 ${name} 검차에 등록된 엔트리입니다.` };
        }

        // 보고서는 다른 검차와 항상 동시 등록 가능
        if (type === "report") {
          current.inspection += `,${type}`;
          db.prepare("UPDATE current SET inspection = ?, phone = ? WHERE num = ? AND year = ?").run(current.inspection, phone, num, year);
        } else {
          const nonReportTypes = currentTypes.filter((t) => t !== "report");

          if (
            nonReportTypes.length === 0 ||
            (nonReportTypes.length === 1 && nonReportTypes[0] === "battery" && type === "chassis") ||
            (nonReportTypes.length === 1 && nonReportTypes[0] === "chassis" && type === "battery")
          ) {
            // 보고서만 등록 또는 배터리+섀시 동시 등록 허용
            current.inspection += `,${type}`;
            db.prepare("UPDATE current SET inspection = ?, phone = ? WHERE num = ? AND year = ?").run(current.inspection, phone, num, year);
          } else {
            const name = currentTypes.map((i) => inspections[i]).join(", ");
            throw { status: 400, message: `이미 ${name} 검차에 등록된 엔트리입니다.` };
          }
        }
      } else {
        db.prepare("INSERT INTO current (num, phone, inspection, year) VALUES (?, ?, ?, ?)").run(num, phone, type, year);
      }

      db.prepare(`INSERT INTO '${type}' (num, phone, timestamp, year) VALUES (?, ?, ?, ?)`).run(num, phone, Date.now(), year);
      db.prepare("UPDATE inspection SET length = length + 1 WHERE type = ?").run(type);

      // 대기열 이벤트 로그 기록 (트랜잭션 내부)
      db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)").run("register", num, type, Date.now(), year);
    })();
  });

  if (!result.success) {
    logger.warn(req, "queue.register", { error: result.error }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  const maskedPhone = phone ? phone.slice(0, 3) + "****" + phone.slice(-4) : "";
  logger.log(req, "queue.register", { inspection: type, phone: maskedPhone }, `#${num}`);

  // SSE 브로드캐스트: 대기열 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type, activeInspections });

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

  // SMS 발송용: 삭제 전 N번째 대기자 조회
  const smsRank = parseInt(db.prepare(`SELECT value FROM settings WHERE key = 'sms_rank'`).get()?.value || "3", 10);
  const prev = db.prepare(getQueueQuery(type) + " LIMIT 1 OFFSET ?").get(...getQueueParams(type, year), smsRank - 1);

  const result = dbRun(() => {
    db.transaction(() => {
      const ret = db.prepare(`DELETE FROM '${type}' WHERE num = ? AND year = ?`).run(num, year);

      if (!ret.changes) {
        throw { status: 400, message: "존재하지 않는 엔트리입니다." };
      }

      db.prepare("UPDATE inspection SET length = length - 1 WHERE type = ?").run(type);

      // 페널티 적용
      const penaltyMinutes = parseInt(
        db.prepare(`SELECT value FROM settings WHERE key = 'cancel_penalty'`).get()?.value || "10",
        10,
      );
      if (penaltyMinutes > 0) {
        const until = Date.now() + penaltyMinutes * 60 * 1000;
        db.prepare("INSERT OR REPLACE INTO cancel_penalty (num, inspection, year, until) VALUES (?, ?, ?, ?)").run(
          num,
          type,
          year,
          until,
        );
      }

      const current = db.prepare("SELECT * FROM current WHERE num = ? AND year = ?").get(num, year);

      if (!current) {
        throw { status: 400, message: "현재 등록 상태를 찾을 수 없습니다." };
      }

      const remaining = current.inspection.split(",").filter((i) => i !== type);
      if (remaining.length > 0) {
        db.prepare("UPDATE current SET inspection = ? WHERE num = ? AND year = ?").run(remaining.join(","), num, year);
      } else {
        db.prepare("DELETE FROM current WHERE num = ? AND year = ?").run(num, year);
      }

      // 대기열 이벤트 로그 기록 (트랜잭션 내부)
      db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp, year) VALUES (?, ?, ?, ?, ?)").run("cancel", num, type, Date.now(), year);
    })();
  });

  if (!result.success) {
    logger.warn(req, "queue.cancel", { error: result.error }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "queue.cancel", { inspection: type }, `#${num}`);

  // SSE 브로드캐스트: 대기열 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type, activeInspections });

  res.status(200).send();

  // SMS 발송 (N번째 대기자에게)
  sendSmsNotification(type, prev);
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
    db.prepare("SELECT * FROM team_priority WHERE inspection = ? AND year = ? ORDER BY priority ASC, num ASC").all(req.params.type, currentYear()),
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

  const result = dbRun(() =>
    db
      .prepare("INSERT OR REPLACE INTO team_priority (num, inspection, year, priority) VALUES (?, ?, ?, ?)")
      .run(numValidation.value, req.params.type, currentYear(), priorityValidation.value),
  );

  if (!result.success) {
    logger.warn(req, "priority.set", { error: result.error }, `#${numValidation.value}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "priority.set", { inspection: req.params.type, priority: priorityValidation.value }, `#${numValidation.value}`);

  // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type: req.params.type, activeInspections });

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
  const prior = db.prepare("SELECT priority FROM team_priority WHERE num = ? AND inspection = ? AND year = ?").get(numValidation.value, req.params.type, year);
  const result = dbRun(() =>
    db.prepare("DELETE FROM team_priority WHERE num = ? AND inspection = ? AND year = ?").run(numValidation.value, req.params.type, year),
  );

  if (!result.success) {
    logger.warn(req, "priority.delete", { error: result.error }, `#${numValidation.value}`);
    return res.status(result.status).send(result.error);
  }

  if (!result.result.changes) {
    return res.status(400).send("존재하지 않는 우선순위 엔트리입니다.");
  }

  logger.log(req, "priority.delete", { inspection: req.params.type, priority: prior?.priority }, `#${numValidation.value}`);

  // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type: req.params.type, activeInspections });

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
    logger.warn(req, "priority.clear", { error: result.error }, req.params.type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "priority.clear", null, req.params.type);

  // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type: req.params.type, activeInspections });

  res.status(200).send();
});

// GET /api/admin/history/status - 재검 현황 조회
app.get("/api/admin/history/status", (req, res) => {
  const year = currentYear();
  const rows = db.prepare("SELECT DISTINCT num, inspection FROM inspection_history WHERE year = ?").all(year);

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
    logger.warn(req, "history.clear", { error: result.error }, type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "history.clear", { year }, type);

  // SSE 브로드캐스트: 이력 초기화 -> 대기열 순서 변경 및 부스 상태 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type, activeInspections });
  broadcastEvent("booth", { type, booths: getBoothsForType(type) });

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
    logger.warn(req, "inspection.ignore", { error: result.error }, type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "inspection.ignore", { field, value: !!value }, type);

  // SSE 브로드캐스트: 설정 변경 -> 대기열 순서 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type, activeInspections });

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
    logger.warn(req, "booth.count", { error: result.error }, type);
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
    logger.warn(req, "booth.toggle", { error: result.error }, type);
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

  // SMS 발송용: 삭제 전 N번째 대기자 조회
  const smsRank = parseInt(db.prepare(`SELECT value FROM settings WHERE key = 'sms_rank'`).get()?.value || "3", 10);
  const prev = db.prepare(getQueueQuery(type) + " LIMIT 1 OFFSET ?").get(...getQueueParams(type, year), smsRank - 1);

  const result = dbRun(() => {
    db.transaction(() => {
      // 대기열에 팀이 있는지 확인
      const queueEntry = db.prepare(`SELECT * FROM '${type}' WHERE num = ? AND year = ?`).get(num, year);
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
      db.prepare(`DELETE FROM '${type}' WHERE num = ? AND year = ?`).run(num, year);
      db.prepare("UPDATE inspection SET length = length - 1 WHERE type = ?").run(type);

      // 부스 점유
      db.prepare("UPDATE booth SET occupied_by = ?, entered_at = ? WHERE inspection = ? AND booth_num = ?").run(
        num, now, type, boothNum
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
      const current = db.prepare("SELECT * FROM current WHERE num = ? AND year = ?").get(num, year);
      if (current) {
        const remaining = current.inspection.split(",").filter((i) => i !== type);
        if (remaining.length > 0) {
          db.prepare("UPDATE current SET inspection = ? WHERE num = ? AND year = ?").run(remaining.join(","), num, year);
        } else {
          db.prepare("DELETE FROM current WHERE num = ? AND year = ?").run(num, year);
        }
      }
    })();
  });

  if (!result.success) {
    logger.warn(req, "booth.enter", { error: result.error }, `#${num}`);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "booth.enter", { inspection: type, booth: boothNum }, `#${num}`);

  // SSE 브로드캐스트: 부스 및 대기열 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("booth", { type, booths: getBoothsForType(type) });
  broadcastEvent("queue", { type, activeInspections });

  res.status(200).send();

  // SMS 발송 (N번째 대기자에게)
  sendSmsNotification(type, prev);
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

  const result = dbRun(() => {
    db.transaction(() => {
      const booth = db.prepare("SELECT * FROM booth WHERE inspection = ? AND booth_num = ?").get(type, boothNum);
      if (!booth) {
        throw { status: 400, message: "존재하지 않는 부스입니다." };
      }
      if (booth.occupied_by === null) {
        throw { status: 400, message: "비어있는 부스입니다." };
      }

      const now = Date.now();
      const num = booth.occupied_by;

      // 부스 비우기
      db.prepare("UPDATE booth SET occupied_by = NULL, entered_at = NULL WHERE inspection = ? AND booth_num = ?").run(
        type, boothNum
      );

      // 부스 로그 퇴장 시간 기록
      db.prepare(
        "UPDATE booth_log SET exited_at = ? WHERE num = ? AND inspection = ? AND booth_num = ? AND exited_at IS NULL"
      ).run(now, num, type, boothNum);

      // 검차 이력에 추가 (재검 판단용)
      db.prepare("INSERT INTO inspection_history (num, inspection, timestamp, year) VALUES (?, ?, ?, ?)").run(num, type, now, currentYear());
    })();
  });

  if (!result.success) {
    logger.warn(req, "booth.exit", { error: result.error }, type);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "booth.exit", { inspection: type, booth: boothNum }, `#${db.prepare("SELECT num FROM booth_log WHERE inspection = ? AND booth_num = ? ORDER BY id DESC LIMIT 1").get(type, boothNum)?.num || "?"}`);

  // SSE 브로드캐스트: 부스 및 대기열 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("booth", { type, booths: getBoothsForType(type) });
  broadcastEvent("queue", { type, activeInspections });

  res.status(200).send();
});

/* ============================================
   API 라우트: Admin - 통계
   ============================================ */

// GET /api/admin/stats/timerange - 특정 연도의 로그 시간 범위 조회
app.get("/api/admin/stats/timerange", (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearEnd = new Date(year + 1, 0, 1).getTime() - 1;

  const result = dbRun(() => {
    const q = db.prepare(
      "SELECT MIN(timestamp) as minTs, MAX(timestamp) as maxTs FROM queue_log WHERE timestamp >= ? AND timestamp <= ?"
    ).get(yearStart, yearEnd);
    const b = db.prepare(
      "SELECT MIN(entered_at) as minTs, MAX(COALESCE(exited_at, entered_at)) as maxTs FROM booth_log WHERE entered_at >= ? AND entered_at <= ?"
    ).get(yearStart, yearEnd);

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

  if (inspection) {
    const typeValidation = validateInspection(inspection);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }
  }

  const queueLogConditions = [];
  const queueLogParams = [];
  const boothLogConditions = ["exited_at IS NOT NULL"];
  const boothLogParams = [];

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

  if (inspection) {
    const typeValidation = validateInspection(inspection);
    if (!typeValidation.valid) {
      return res.status(400).send(typeValidation.error);
    }
  }

  const queueLogConditions = ["num = ?"];
  const queueLogParams = [num];
  const boothLogConditions = ["num = ?"];
  const boothLogParams = [num];
  const boothLogOccupyConditions = ["num = ?", "exited_at IS NOT NULL"];
  const boothLogOccupyParams = [num];

  if (from) {
    queueLogConditions.push("timestamp >= ?");
    queueLogParams.push(Number(from));
    boothLogConditions.push("entered_at >= ?");
    boothLogParams.push(Number(from));
    boothLogOccupyConditions.push("entered_at >= ?");
    boothLogOccupyParams.push(Number(from));
  }
  if (to) {
    queueLogConditions.push("timestamp <= ?");
    queueLogParams.push(Number(to));
    boothLogConditions.push("exited_at <= ?");
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

    // Register and cancel events from queue_log
    const regCancelEvents = db.prepare(`
      SELECT event, inspection, timestamp
      FROM queue_log
      ${queueLogWhere} AND event IN ('register', 'cancel')
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

    const boothEvents = [];
    for (const row of boothLogs) {
      boothEvents.push({
        event: "enter",
        inspection: row.inspection,
        boothNum: row.boothNum,
        timestamp: row.enteredAt,
      });
      if (row.exitedAt) {
        boothEvents.push({
          event: "exit",
          inspection: row.inspection,
          boothNum: row.boothNum,
          timestamp: row.exitedAt,
          duration: row.exitedAt - row.enteredAt,
        });
      }
    }

    const timeline = [...regCancelEvents, ...boothEvents].sort((a, b) => a.timestamp - b.timestamp);

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
    if (
      !process.env.NAVER_CLOUD_ACCESS_KEY ||
      !process.env.NAVER_CLOUD_SECRET_KEY ||
      !process.env.NAVER_CLOUD_SMS_SERVICE_ID ||
      !process.env.PHONE_NUMBER_SMS_SENDER
    ) {
      return res.status(400).send("SMS 환경 변수가 설정되지 않았습니다.");
    }
  }

  const result = dbRun(() =>
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(req.body.value === true ? "TRUE" : "FALSE", "sms"),
  );

  if (!result.success) {
    logger.warn(req, "settings.sms", { error: result.error });
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
    logger.warn(req, "settings.sms_rank", { error: result.error });
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
    logger.warn(req, "settings.cancel_penalty", { error: result.error });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "settings.cancel_penalty", { minutes });
  res.status(200).send();
});

/* ============================================
   유틸리티 함수
   ============================================ */
async function getEntries() {
  const entryServer = process.env.ENTRY_SERVER || "http://entry:9200";
  const headers = {};
  if (process.env.INTERNAL_SECRET) headers["X-Internal-Service"] = process.env.INTERNAL_SECRET;
  const res = await fetch(`${entryServer}/api/entries`, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error("엔트리를 조회할 수 없습니다.");
  return res.json();
}

function sendSmsNotification(type, prev) {
  try {
    if (db.prepare(`SELECT value FROM settings WHERE key = 'sms'`).get()?.value !== "TRUE") {
      return;
    }

    const year = currentYear();
    const smsRank = parseInt(db.prepare(`SELECT value FROM settings WHERE key = 'sms_rank'`).get()?.value || "3", 10);
    const target = db.prepare(getQueueQuery(type) + " LIMIT 1 OFFSET ?").get(...getQueueParams(type, year), smsRank - 1);

    if (target && (!prev || target.num !== prev.num)) {
      const payload = {
        hostname: "sens.apigw.ntruss.com",
        port: 443,
        path: `/sms/v2/services/${process.env.NAVER_CLOUD_SMS_SERVICE_ID}/messages`,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "x-ncp-apigw-timestamp": Date.now(),
          "x-ncp-iam-access-key": process.env.NAVER_CLOUD_ACCESS_KEY,
          "x-ncp-apigw-signature-v2": "",
        },
      };

      const secret = crypto
        .createHmac("sha256", process.env.NAVER_CLOUD_SECRET_KEY)
        .update(
          `${payload.method} ${payload.path}\n${payload.headers["x-ncp-apigw-timestamp"]}\n${process.env.NAVER_CLOUD_ACCESS_KEY}`,
        )
        .digest("base64");

      payload.headers["x-ncp-apigw-signature-v2"] = secret;

      const sms = https.request(payload, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => logger.log(null, "sms.send", { response: data, num: target.num, type }));
      });

      sms.setTimeout(5000, () => {
        logger.warn(null, "sms.timeout", { num: target.num, type });
        sms.destroy();
      });
      sms.on("error", (e) => logger.warn(null, "sms.error", { error: e.message, num: target.num, type }));
      sms.write(
        JSON.stringify({
          type: "SMS",
          from: process.env.PHONE_NUMBER_SMS_SENDER,
          content: `[FSK ${new Date().getFullYear()}]\n엔트리 ${target.num}번 ${inspections[type]} 검차 대기 순서 ${smsRank}번입니다.\n차량과 함께 검차장으로 오세요.`,
          messages: [{ to: target.phone }],
        }),
      );
      sms.end();
    }
  } catch (e) {
    logger.warn(null, "sms.error", { error: String(e), num: target?.num, type });
  }
}

/* ============================================
   Internal API: 엔트리 삭제 연동
   ============================================ */

// DELETE /api/internal/team/:num - 엔트리 삭제 시 관련 데이터 정리
app.delete("/api/internal/team/:num", (req, res) => {
  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const num = numValidation.value;
  const year = Number(req.query.year) || currentYear();

  const result = dbRun(() => {
    db.transaction(() => {
      // 모든 검차 대기열에서 제거
      for (const type of Object.keys(inspections)) {
        const deleted = db.prepare(`DELETE FROM '${type}' WHERE num = ? AND year = ?`).run(num, year);
        if (deleted.changes) {
          db.prepare("UPDATE inspection SET length = length - 1 WHERE type = ?").run(type);
        }
      }

      // current에서 제거
      db.prepare("DELETE FROM current WHERE num = ? AND year = ?").run(num, year);

      // 우선순위 제거
      db.prepare("DELETE FROM team_priority WHERE num = ? AND year = ?").run(num, year);

      // 취소 페널티 제거
      db.prepare("DELETE FROM cancel_penalty WHERE num = ? AND year = ?").run(num, year);

      // 검차 이력 제거
      db.prepare("DELETE FROM inspection_history WHERE num = ? AND year = ?").run(num, year);

      // 부스 점유 해제
      const booths = db.prepare("SELECT inspection, booth_num FROM booth WHERE occupied_by = ?").all(num);
      for (const b of booths) {
        db.prepare("UPDATE booth SET occupied_by = NULL, entered_at = NULL WHERE inspection = ? AND booth_num = ?").run(b.inspection, b.booth_num);
      }
    })();
  });

  if (!result.success) {
    logger.warn(req, "team.cascade_delete", { error: result.error, year }, "#" + num);
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "team.cascade_delete", { year }, "#" + num);

  // SSE 브로드캐스트
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type: null, activeInspections });

  res.status(200).send();
});

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createQueueApp();
  setupProcessHandlers(db);
  app.listen(9300);
}
