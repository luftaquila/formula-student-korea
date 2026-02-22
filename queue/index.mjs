import fs from "fs";
import http from "http";
import https from "https";
import crypto from "crypto";
import express from "express";
import pinoHttp from "pino-http";
import Database from "better-sqlite3";

const inspections = {
  battery: "배터리",
  electric: "전기",
  chassis: "섀시",
  tilting: "틸팅",
  braking: "제동",
  noise: "소음",
  rain: "우천",
  report: "보고서",
};

/* ============================================
   Database 초기화
   ============================================ */
if (!fs.existsSync("./data")) {
  fs.mkdirSync("./data", { recursive: true });
}

const db = new Database("./data/queue.db");

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
  try {
    db.exec(`ALTER TABLE inspection ADD COLUMN ignore_priority BOOLEAN NOT NULL DEFAULT FALSE`);
  } catch (e) { /* already exists */ }
  try {
    db.exec(`ALTER TABLE inspection ADD COLUMN ignore_reinspection BOOLEAN NOT NULL DEFAULT FALSE`);
  } catch (e) { /* already exists */ }

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
    db.exec(`CREATE TABLE IF NOT EXISTS ${k} (
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
})();

process.on("exit", () => db.close());
process.on("SIGHUP", () => process.exit(128 + 1));
process.on("SIGINT", () => process.exit(128 + 2));
process.on("SIGTERM", () => process.exit(128 + 15));

/* ============================================
   Express 앱 설정
   ============================================ */
const app = express();
app.use(express.json());
app.use(express.static("./web/dist"));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.headers.authorization) {
    req.headers.authuser = Buffer.from(req.headers.authorization.split(" ")[1], "base64")
      .toString("utf-8")
      .split(":")[0];
  }
  next();
});
app.use(
  pinoHttp({
    stream: fs.createWriteStream("./data/queue.log", { flags: "a" }),
    customProps: (req, res) => ({ reqBody: req.body }),
  }),
);

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
const sseClients = new Set();

function broadcastEvent(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// SSE 엔드포인트
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // 연결 시 초기 데이터 전송
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  const allBooths = {};
  for (const k of Object.keys(inspections)) {
    allBooths[k] = db.prepare("SELECT booth_num, active, occupied_by, entered_at FROM booth WHERE inspection = ? ORDER BY booth_num").all(k);
  }
  res.write(`event: init\ndata: ${JSON.stringify({ activeInspections, allBooths })}\n\n`);

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateEntryNum(num) {
  const parsed = Number(num);
  if (num === "" || num === undefined || Number.isNaN(parsed) || parsed < 0) {
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
  if (priority === "" || priority === undefined || Number.isNaN(parsed) || parsed < 1) {
    return { valid: false, error: "우선순위는 1 이상의 정수여야 합니다." };
  }
  return { valid: true, value: parsed };
}

/* ============================================
   DB 헬퍼
   ============================================ */
function dbRun(fn) {
  try {
    return { success: true, result: fn() };
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return { success: false, status: 400, error: "이미 존재하는 항목입니다." };
    }
    if (e.status && e.message) {
      return { success: false, status: e.status, error: e.message };
    }
    return { success: false, status: 500, error: `DB 오류: ${e.message || e}` };
  }
}

/**
 * 대기열 조회 쿼리 (정렬 순서: 초검 > 재검, 우선순위 높음 > 낮음, 선착순)
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
        SELECT 1 FROM inspection_history h WHERE h.num = t.num AND h.inspection = ?
      ) THEN 1 ELSE 0 END AS is_reinspection,
      COALESCE(p.priority, 999) AS priority
    FROM ${inspection} AS t
    LEFT JOIN team_priority AS p ON t.num = p.num AND p.inspection = ?
    ORDER BY ${orderClauses.join(", ")}
  `;
}

/**
 * 특정 엔트리의 대기열 순위 조회
 */
function getQueueRank(inspection, num) {
  const meta = db.prepare("SELECT ignore_priority, ignore_reinspection FROM inspection WHERE type = ?").get(inspection);
  const ignoreReinspection = meta?.ignore_reinspection;
  const ignorePriority = meta?.ignore_priority;

  const orderClauses = [];
  if (!ignoreReinspection) orderClauses.push(`CASE WHEN EXISTS (
              SELECT 1 FROM inspection_history h WHERE h.num = t.num AND h.inspection = ?
            ) THEN 1 ELSE 0 END ASC`);
  if (!ignorePriority) orderClauses.push("COALESCE(p.priority, 999) ASC");
  orderClauses.push("t.timestamp ASC");

  // Build params: each reinspection clause needs inspection param
  const params = [];
  if (!ignoreReinspection) params.push(inspection);
  params.push(inspection); // for LEFT JOIN
  params.push(num); // for WHERE

  const result = db
    .prepare(`
    SELECT sub.rank FROM (
      SELECT t.num,
        ROW_NUMBER() OVER (
          ORDER BY ${orderClauses.join(", ")}
        ) AS rank
      FROM ${inspection} AS t
      LEFT JOIN team_priority AS p ON t.num = p.num AND p.inspection = ?
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

// GET /api/state/:num - 대기열 상태 조회 (전화번호 검증 필요)
app.get("/api/state/:num", async (req, res) => {
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
    return res.status(500).send(`엔트리를 조회할 수 없습니다. ${e}`);
  }

  const result = dbRun(() => {
    const entry = db.prepare("SELECT * FROM current WHERE num = ?").get(num);

    if (!entry) {
      return { queue: undefined, rank: -1 };
    }

    if (entry.phone !== req.query.phone) {
      throw { status: 400, message: "전화번호가 일치하지 않습니다." };
    }

    if (entry.inspection.includes(",")) {
      const ranks = { queue: [], rank: [] };

      for (let inspection of entry.inspection.split(",")) {
        ranks.queue.push(inspections[inspection]);
        ranks.rank.push(getQueueRank(inspection, num));
      }

      return { queue: ranks.queue.join(", "), rank: ranks.rank.join(", ") };
    } else {
      const rank = getQueueRank(entry.inspection, num);
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

  const result = dbRun(() => db.prepare(getQueueQuery(req.params.type)).all(req.params.type, req.params.type));

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
    return res.status(result.status).send(result.error);
  }

  // SSE 브로드캐스트: 활성 검차 목록 변경
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
    return res.status(500).send(`엔트리를 조회할 수 없습니다. ${e}`);
  }

  let errorResponse = null;

  const result = dbRun(() => {
    db.transaction(() => {
      if (!db.prepare("SELECT active FROM inspection WHERE type = ?").get(type).active) {
        errorResponse = { status: 400, message: "대기열이 비활성화 상태입니다." };
        return;
      }

      // 페널티 확인
      const penalty = db.prepare("SELECT * FROM cancel_penalty WHERE num = ? AND inspection = ?").get(num, type);
      if (penalty && penalty.until > Date.now()) {
        const remaining = Math.ceil((penalty.until - Date.now()) / 1000 / 60);
        errorResponse = {
          status: 403,
          message: JSON.stringify({ remaining, until: penalty.until }),
        };
        return;
      } else if (penalty) {
        // 만료된 페널티 삭제
        db.prepare("DELETE FROM cancel_penalty WHERE num = ? AND inspection = ?").run(num, type);
      }

      const current = db.prepare("SELECT * FROM current WHERE num = ?").get(num);

      if (current) {
        const currentTypes = current.inspection.split(",");

        if (currentTypes.includes(type)) {
          const name = inspections[type];
          errorResponse = { status: 400, message: `이미 ${name} 검차에 등록된 엔트리입니다.` };
          return;
        }

        // 보고서는 다른 검차와 항상 동시 등록 가능
        if (type === "report") {
          current.inspection += `,${type}`;
          db.prepare("UPDATE current SET inspection = ? WHERE num = ?").run(current.inspection, num);
        } else {
          const nonReportTypes = currentTypes.filter((t) => t !== "report");

          if (
            nonReportTypes.length === 0 ||
            (nonReportTypes.length === 1 && nonReportTypes[0] === "battery" && type === "chassis") ||
            (nonReportTypes.length === 1 && nonReportTypes[0] === "chassis" && type === "battery")
          ) {
            // 보고서만 등록 또는 배터리+섀시 동시 등록 허용
            current.inspection += `,${type}`;
            db.prepare("UPDATE current SET inspection = ? WHERE num = ?").run(current.inspection, num);
          } else {
            const name = currentTypes.map((i) => inspections[i]).join(", ");
            errorResponse = { status: 400, message: `이미 ${name} 검차에 등록된 엔트리입니다.` };
            return;
          }
        }
      } else {
        db.prepare("INSERT INTO current (num, phone, inspection) VALUES (?, ?, ?)").run(num, phone, type);
      }

      db.prepare(`INSERT INTO ${type} (num, phone, timestamp) VALUES (?, ?, ?)`).run(num, phone, Date.now());
      db.prepare("UPDATE inspection SET length = length + 1 WHERE type = ?").run(type);
    })();
  });

  if (errorResponse) {
    return res.status(errorResponse.status).send(errorResponse.message);
  }

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  // 대기열 이벤트 로그 기록
  db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp) VALUES (?, ?, ?, ?)").run("register", num, type, Date.now());

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

  let ok = true;

  const result = dbRun(() => {
    db.transaction(() => {
      const ret = db.prepare(`DELETE FROM ${type} WHERE num = ?`).run(num);

      if (!ret.changes) {
        ok = false;
        return;
      }

      db.prepare("UPDATE inspection SET length = length - 1 WHERE type = ?").run(type);

      // 페널티 적용
      const penaltyMinutes = parseInt(
        db.prepare(`SELECT value FROM settings WHERE key = 'cancel_penalty'`).get()?.value || "10",
        10,
      );
      if (penaltyMinutes > 0) {
        const until = Date.now() + penaltyMinutes * 60 * 1000;
        db.prepare("INSERT OR REPLACE INTO cancel_penalty (num, inspection, until) VALUES (?, ?, ?)").run(
          num,
          type,
          until,
        );
      }

      const current = db.prepare("SELECT * FROM current WHERE num = ?").get(num);

      const remaining = current.inspection.split(",").filter((i) => i !== type);
      if (remaining.length > 0) {
        db.prepare("UPDATE current SET inspection = ? WHERE num = ?").run(remaining.join(","), num);
      } else {
        db.prepare("DELETE FROM current WHERE num = ?").run(num);
      }
    })();
  });

  if (!ok) {
    return res.status(400).send("존재하지 않는 엔트리입니다.");
  }

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  // 대기열 이벤트 로그 기록
  db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp) VALUES (?, ?, ?, ?)").run("cancel", num, type, Date.now());

  // SSE 브로드캐스트: 대기열 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type, activeInspections });

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
    db.prepare("SELECT * FROM team_priority WHERE inspection = ? ORDER BY priority ASC, num ASC").all(req.params.type),
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
      .prepare("INSERT OR REPLACE INTO team_priority (num, inspection, priority) VALUES (?, ?, ?)")
      .run(numValidation.value, req.params.type, priorityValidation.value),
  );

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

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

  const result = dbRun(() =>
    db.prepare("DELETE FROM team_priority WHERE num = ? AND inspection = ?").run(numValidation.value, req.params.type),
  );

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  if (!result.result.changes) {
    return res.status(400).send("존재하지 않는 우선순위 엔트리입니다.");
  }

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

  const result = dbRun(() => db.prepare("DELETE FROM team_priority WHERE inspection = ?").run(req.params.type));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  // SSE 브로드캐스트: 우선순위 변경 -> 대기열 순서 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("queue", { type: req.params.type, activeInspections });

  res.status(200).send();
});

// DELETE /api/admin/history/:type - 검차별 초검/재검 이력 초기화
app.delete("/api/admin/history/:type", (req, res) => {
  const typeValidation = validateInspection(req.params.type);
  if (!typeValidation.valid) {
    return res.status(400).send(typeValidation.error);
  }

  const type = typeValidation.value;

  const result = dbRun(() => {
    db.prepare("DELETE FROM inspection_history WHERE inspection = ?").run(type);

    // 부스 상태 초기화: 해당 검차 종류의 모든 부스 점유 해제
    db.prepare("UPDATE booth SET occupied_by = NULL, entered_at = NULL WHERE inspection = ?").run(type);
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

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
    db.prepare(`UPDATE inspection SET ${field} = ? WHERE type = ?`).run(value ? 1 : 0, type);
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

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

  if (isNaN(count) || count < 1) {
    return res.status(400).send("부스 수는 1 이상이어야 합니다.");
  }

  const result = dbRun(() => {
    const config = db.prepare("SELECT count FROM booth_config WHERE inspection = ?").get(type);
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
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

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
    return res.status(result.status).send(result.error);
  }

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

  // SMS 발송용: 삭제 전 N번째 대기자 조회
  const smsRank = parseInt(db.prepare(`SELECT value FROM settings WHERE key = 'sms_rank'`).get()?.value || "3", 10);
  const prev = db.prepare(getQueueQuery(type) + " LIMIT 1 OFFSET ?").get(type, type, smsRank - 1);

  const result = dbRun(() => {
    db.transaction(() => {
      // 대기열에 팀이 있는지 확인
      const queueEntry = db.prepare(`SELECT * FROM ${type} WHERE num = ?`).get(num);
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
      db.prepare(`DELETE FROM ${type} WHERE num = ?`).run(num);
      db.prepare("UPDATE inspection SET length = length - 1 WHERE type = ?").run(type);

      // 부스 점유
      db.prepare("UPDATE booth SET occupied_by = ?, entered_at = ? WHERE inspection = ? AND booth_num = ?").run(
        num, now, type, boothNum
      );

      // 부스 로그 기록
      db.prepare("INSERT INTO booth_log (num, inspection, booth_num, entered_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
        num, type, boothNum, now, now
      );

      // 대기열 이벤트 로그 기록
      db.prepare("INSERT INTO queue_log (event, num, inspection, timestamp) VALUES (?, ?, ?, ?)").run(
        "enter", num, type, now
      );

      // current 테이블에서 해당 검차 종류 제거
      const current = db.prepare("SELECT * FROM current WHERE num = ?").get(num);
      if (current) {
        const remaining = current.inspection.split(",").filter((i) => i !== type);
        if (remaining.length > 0) {
          db.prepare("UPDATE current SET inspection = ? WHERE num = ?").run(remaining.join(","), num);
        } else {
          db.prepare("DELETE FROM current WHERE num = ?").run(num);
        }
      }
    })();
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

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
      db.prepare("INSERT INTO inspection_history (num, inspection, timestamp) VALUES (?, ?, ?)").run(num, type, now);
    })();
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  // SSE 브로드캐스트: 부스 및 대기열 변경
  const activeInspections = db.prepare("SELECT * FROM inspection WHERE active = TRUE").all();
  broadcastEvent("booth", { type, booths: getBoothsForType(type) });
  broadcastEvent("queue", { type, activeInspections });

  res.status(200).send();
});

/* ============================================
   API 라우트: Admin - 통계
   ============================================ */

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

// GET /api/settings/sms - SMS 설정 조회
app.get("/api/settings/sms", (req, res) => {
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
    return res.status(result.status).send(result.error);
  }

  res.status(200).send();
});

// GET /api/settings/sms-rank - SMS 알림 순번 조회
app.get("/api/settings/sms-rank", (req, res) => {
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
    return res.status(result.status).send(result.error);
  }

  res.status(200).send();
});

// GET /api/settings/cancel-penalty - 취소 페널티 시간 조회
app.get("/api/settings/cancel-penalty", (req, res) => {
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
    return res.status(result.status).send(result.error);
  }

  res.status(200).send();
});

/* ============================================
   유틸리티 함수
   ============================================ */
async function getEntries() {
  const entryServer = process.env.ENTRY_SERVER || "http://entry:9100";

  return await new Promise((resolve, reject) => {
    http
      .get(`${entryServer}/api/entries`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", (e) => reject(e));
      })
      .on("error", (e) => reject(e));
  });
}

function sendSmsNotification(type, prev) {
  try {
    if (db.prepare(`SELECT value FROM settings WHERE key = 'sms'`).get().value !== "TRUE") {
      return;
    }

    const smsRank = parseInt(db.prepare(`SELECT value FROM settings WHERE key = 'sms_rank'`).get()?.value || "3", 10);
    const target = db.prepare(getQueueQuery(type) + " LIMIT 1 OFFSET ?").get(type, type, smsRank - 1);

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
        res.on("end", () => console.log(data));
      });

      sms.on("error", (e) => console.error(e));
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
    console.error(`SMS 발송 오류: ${e}`);
  }
}

/* ============================================
   SPA Fallback - Vue Router 지원
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

/* ============================================
   서버 시작
   ============================================ */
app.listen(9300);
