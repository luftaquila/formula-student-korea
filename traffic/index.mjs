import fs from "fs";
import path from "path";
import express from "express";
import pinoHttp from "pino-http";
import Database from "better-sqlite3";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";

/* ============================================
   Database 초기화
   ============================================ */
ensureDataDir();

const db = new Database("./data/traffic.db");

db.exec(`CREATE TABLE IF NOT EXISTS controller (
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL
);`);

setupProcessHandlers(db);

/* ============================================
   Express 앱 설정
   ============================================ */
const app = createApp("traffic.log", { express, pinoHttp }, (req) => {
  if (req.path === "/api/events") return "official";
  if (req.path.match(/^\/api\/records\/.+/)) return "official";
  if (req.path.startsWith("/api/")) return "admin";
  return "admin"; // SPA
});

/* ============================================
   설정
   ============================================ */
const ENTRY_SERVER = process.env.ENTRY_SERVER || "http://localhost:9100";

/* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
import { createSSEManager } from "../shared/sse.mjs";
const { broadcast: broadcastEvent, handler: sseHandler } = createSSEManager();

function getRecordFiles() {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'controller'")
    .all();
  return tables.map((table) => table.name);
}

// SSE 엔드포인트
app.get("/api/events", sseHandler(() => ({ recordFiles: getRecordFiles() })));

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateRecordName(name) {
  if (name === undefined || name === null || typeof name !== "string" || name.trim() === "") {
    return { valid: false, error: "올바르지 않은 기록 이름입니다." };
  }
  // 파일 경로에 사용할 수 없는 문자들을 .으로 치환
  const sanitized = name.trim().replace(/[/\\:*?"<>|]/g, ".");
  return { valid: true, value: sanitized };
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

  return { valid: true };
}

function validateControllerData({ timestamp, data }) {
  if (timestamp === undefined || timestamp === null) {
    return { valid: false, error: "타임스탬프가 누락되었습니다." };
  }
  if (data === undefined || data === null) {
    return { valid: false, error: "데이터가 누락되었습니다." };
  }
  return { valid: true };
}

/* ============================================
   DB 헬퍼
   ============================================ */
const dbRun = createDbRun();

/* ============================================
   API 라우트: /api/entries (entry 서버 프록시)
   ============================================ */

// GET /api/entries - 모든 엔트리 조회
app.get("/api/entries", async (req, res) => {
  try {
    const response = await fetch(`${ENTRY_SERVER}/api/entries`);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).send(`Entry 서버 연결 오류: ${e}`);
  }
});

// GET /api/entries/:num - 특정 엔트리 조회
app.get("/api/entries/:num", async (req, res) => {
  try {
    const response = await fetch(`${ENTRY_SERVER}/api/entries/${req.params.num}`);
    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).send(`Entry 서버 연결 오류: ${e}`);
  }
});

// POST /api/entries - 엔트리 추가
app.post("/api/entries", async (req, res) => {
  try {
    const response = await fetch(`${ENTRY_SERVER}/api/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }
    res.status(201).send();
  } catch (e) {
    res.status(500).send(`Entry 서버 연결 오류: ${e}`);
  }
});

// DELETE /api/entries/:num - 엔트리 삭제
app.delete("/api/entries/:num", async (req, res) => {
  try {
    const response = await fetch(`${ENTRY_SERVER}/api/entries/${req.params.num}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }
    res.status(200).send();
  } catch (e) {
    res.status(500).send(`Entry 서버 연결 오류: ${e}`);
  }
});

/* ============================================
   API 라우트: /api/records
   ============================================ */

// GET /api/records - 모든 기록 테이블 목록 조회
app.get("/api/records", (req, res) => {
  const result = dbRun(() => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'controller'",
      )
      .all();
    return tables.map((table) => table.name);
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// GET /api/records/:name - 특정 기록 조회
app.get("/api/records/:name", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = decodeURIComponent(validation.value);

  const result = dbRun(() => {
    // 기존 테이블에 누락된 컬럼 추가
    const columns = db.prepare(`PRAGMA table_info('${name}')`).all();
    if (!columns.some((c) => c.name === "invalidated")) {
      db.exec(`ALTER TABLE '${name}' ADD COLUMN invalidated INTEGER DEFAULT 0`);
    }
    if (!columns.some((c) => c.name === "scoreboard")) {
      db.exec(`ALTER TABLE '${name}' ADD COLUMN scoreboard INTEGER DEFAULT 1`);
      db.exec(`UPDATE '${name}' SET scoreboard = 0 WHERE invalidated = 1`);
    }
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
    db.transaction(() => {
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
          invalidated INTEGER DEFAULT 0,
          scoreboard INTEGER DEFAULT 1
        );`);
      } else {
        // 기존 테이블에 누락된 컬럼 추가
        const columns = db.prepare(`PRAGMA table_info('${name}')`).all();
        if (!columns.some((c) => c.name === "invalidated")) {
          db.exec(`ALTER TABLE '${name}' ADD COLUMN invalidated INTEGER DEFAULT 0`);
        }
        if (!columns.some((c) => c.name === "scoreboard")) {
          db.exec(`ALTER TABLE '${name}' ADD COLUMN scoreboard INTEGER DEFAULT 1`);
          db.exec(`UPDATE '${name}' SET scoreboard = 0 WHERE invalidated = 1`);
        }
      }

      db.prepare(
        `INSERT INTO '${name}' (time, num, univ, team, type, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(data.time, data.entry.num, data.entry.univ, data.entry.team, data.type, data.result, data.detail);
    })();
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  // SSE 브로드캐스트
  broadcastEvent("records", { type: "add", name, recordFiles: getRecordFiles(), record: { num: data.entry.num, eventType: data.type } });

  res.status(201).send();
});

// PATCH /api/records/:name/:rowid - 기록 필드 업데이트
app.patch("/api/records/:name/:rowid", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = decodeURIComponent(validation.value);
  const rowid = parseInt(req.params.rowid, 10);

  if (isNaN(rowid)) {
    return res.status(400).send("올바르지 않은 rowid입니다.");
  }

  const { field, value } = req.body;
  if (!["invalidated", "scoreboard", "detail"].includes(field)) {
    return res.status(400).send("올바르지 않은 필드입니다.");
  }

  const result = dbRun(() => {
    const row = db.prepare(`SELECT invalidated, scoreboard FROM '${name}' WHERE rowid = ?`).get(rowid);
    if (!row) {
      throw new Error("기록을 찾을 수 없습니다.");
    }

    if (field === "invalidated") {
      const newStatus = row.invalidated ? 0 : 1;
      if (newStatus === 1) {
        // 무효화 ON → 전광판도 자동 OFF
        db.prepare(`UPDATE '${name}' SET invalidated = 1, scoreboard = 0 WHERE rowid = ?`).run(rowid);
        return { invalidated: 1, scoreboard: 0 };
      } else {
        db.prepare(`UPDATE '${name}' SET invalidated = 0, scoreboard = 1 WHERE rowid = ?`).run(rowid);
        return { invalidated: 0, scoreboard: 1 };
      }
    } else if (field === "scoreboard") {
      const newStatus = row.scoreboard ? 0 : 1;
      db.prepare(`UPDATE '${name}' SET scoreboard = ? WHERE rowid = ?`).run(newStatus, rowid);
      return { invalidated: row.invalidated, scoreboard: newStatus };
    } else if (field === "detail") {
      db.prepare(`UPDATE '${name}' SET detail = ? WHERE rowid = ?`).run(value ?? null, rowid);
      return { invalidated: row.invalidated, scoreboard: row.scoreboard, detail: value ?? null };
    }
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  // SSE 브로드캐스트 (무효화 변경 시 팀/종목 정보 포함)
  let record = null;
  if (field === "invalidated") {
    const row = db.prepare(`SELECT num, type FROM '${name}' WHERE rowid = ?`).get(rowid);
    if (row) record = { num: row.num, eventType: row.type };
  }
  broadcastEvent("records", { type: "update", name, field, recordFiles: getRecordFiles(), record });

  res.json(result.result);
});

// DELETE /api/records/:name - 기록 테이블 삭제
app.delete("/api/records/:name", (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = decodeURIComponent(validation.value);

  const result = dbRun(() => db.exec(`DROP TABLE IF EXISTS '${name}'`));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

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
    return res.status(result.status).send(result.error);
  }

  res.status(201).send();
});

// DELETE /api/controllers - 모든 컨트롤러 로그 삭제
app.delete("/api/controllers", (req, res) => {
  const result = dbRun(() => db.prepare("DELETE FROM controller").run());

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.status(200).send();
});

/* ============================================
   SPA Fallback
   ============================================ */
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.includes(".")) {
    const distPath = "./web/dist";
    const indexPath = fs.existsSync(distPath) ? path.join(distPath, "index.html") : "./web/index.html";
    res.sendFile(path.resolve(indexPath));
  } else {
    next();
  }
});

/* ============================================
   서버 시작
   ============================================ */
app.listen(9200);
