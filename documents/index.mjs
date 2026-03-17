import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase, addColumn } from "../shared/db-setup.mjs";
import Busboy from "busboy";
import { createApp, setupProcessHandlers, createDbRun, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";

export function createDocumentsApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/documents.db");
db.pragma("foreign_keys = ON");

db.exec(`CREATE TABLE IF NOT EXISTS student_team (
  email TEXT PRIMARY KEY,
  team_num INTEGER NOT NULL,
  year INTEGER NOT NULL,
  UNIQUE(team_num, year)
)`);

// 마이그레이션: student_team PK를 (email, year)로 변경
{
  const info = db.prepare("PRAGMA table_info(student_team)").all();
  const emailCol = info.find(c => c.name === "email");
  if (emailCol && emailCol.pk === 1) {
    // 기존 스키마: email이 단독 PK → (email, year) 복합 PK로 마이그레이션
    db.transaction(() => {
      db.exec(`CREATE TABLE student_team_new (
        email TEXT NOT NULL,
        team_num INTEGER NOT NULL,
        year INTEGER NOT NULL,
        PRIMARY KEY (email, year),
        UNIQUE(team_num, year)
      )`);
      db.exec("INSERT OR IGNORE INTO student_team_new SELECT email, team_num, year FROM student_team");
      db.exec("DROP TABLE student_team");
      db.exec("ALTER TABLE student_team_new RENAME TO student_team");
    })();
  }
}

db.exec(`CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notice TEXT DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  late_end_at TEXT NOT NULL,
  max_file_size INTEGER NOT NULL DEFAULT 52428800,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  year INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS session_team (
  session_id INTEGER NOT NULL,
  team_num INTEGER NOT NULL,
  PRIMARY KEY (session_id, team_num),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
)`);

db.exec(`CREATE TABLE IF NOT EXISTS submission (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  team_num INTEGER NOT NULL,
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  total_size INTEGER NOT NULL DEFAULT 0,
  is_late INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
)`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_session_team
  ON submission(session_id, team_num)`);

db.exec(`CREATE TABLE IF NOT EXISTS submission_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT DEFAULT '',
  FOREIGN KEY (submission_id) REFERENCES submission(id) ON DELETE CASCADE
)`);

// 마이그레이션: allowed_extensions 컬럼 추가
addColumn(db, "session", "allowed_extensions TEXT DEFAULT ''");

// 업로드 디렉토리 생성
const UPLOADS_DIR = options.uploadsDir || path.resolve("./data/uploads");
const TMP_DIR = path.join(UPLOADS_DIR, "_tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

// 서버 시작 시 _tmp 잔여 파일 정리 (크래시/재시작 후 남은 고아 파일)
{
  const entries = fs.readdirSync(TMP_DIR);
  for (const entry of entries) {
    rmDir(path.join(TMP_DIR, entry));
  }
  if (entries.length > 0) {
    console.log(`[documents] Cleaned up ${entries.length} leftover temp upload(s)`);
  }
}

/* ============================================
   Express 앱 설정
   ============================================ */
const logger = createLogger(db, "documents");

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path.startsWith("/api/admin")) return "chief";
  if (req.path === "/api/logs") return "admin";
  if (req.path.startsWith("/api/")) return "student";
  if (req.path.startsWith("/admin")) return "chief";
  return "student";
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

const dbRun = createDbRun();

/* ============================================
   헬퍼
   ============================================ */
function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function safeExt(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error("rmDir failed:", dir, err.message);
  }
}

/* ============================================
   학생 API
   ============================================ */

// GET /api/sessions - 내 팀에 열린 세션 목록
app.get("/api/sessions", (req, res) => {
  const team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? ORDER BY year DESC LIMIT 1").get(req.user.email);
  if (!team) return res.json({ team: null, sessions: [] });

  const rows = db.prepare(`
    SELECT s.*, st.team_num AS target,
      sub.id AS sub_id, sub.submitted_at AS sub_submitted_at, sub.is_late AS sub_is_late
    FROM session s
    JOIN session_team st ON st.session_id = s.id AND st.team_num = ?
    LEFT JOIN (
      SELECT session_id, team_num, id, submitted_at, is_late,
        ROW_NUMBER() OVER (PARTITION BY session_id, team_num ORDER BY id DESC) AS rn
      FROM submission
    ) sub ON sub.session_id = s.id AND sub.team_num = ? AND sub.rn = 1
    WHERE s.year = ?
    ORDER BY s.end_at ASC
  `).all(team.team_num, team.team_num, team.year);

  const result = rows.map(({ sub_id, sub_submitted_at, sub_is_late, ...s }) => ({
    ...s,
    submission: sub_id ? { id: sub_id, submitted_at: sub_submitted_at, is_late: sub_is_late } : null,
  }));

  res.json({ team, sessions: result });
});

// GET /api/sessions/:id - 세션 상세
app.get("/api/sessions/:id", (req, res) => {
  const team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? ORDER BY year DESC LIMIT 1").get(req.user.email);
  if (!team) return res.status(403).send("팀이 등록되지 않았습니다.");

  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(Number(req.params.id));
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  const isTarget = db.prepare("SELECT 1 FROM session_team WHERE session_id = ? AND team_num = ?").get(session.id, team.team_num);
  if (!isTarget) return res.status(403).send("대상 팀이 아닙니다.");

  // 최신 제출
  const sub = db.prepare(`
    SELECT id, submitted_at, total_size, is_late FROM submission
    WHERE session_id = ? AND team_num = ?
    ORDER BY id DESC LIMIT 1
  `).get(session.id, team.team_num);

  let files = [];
  if (sub) {
    files = db.prepare("SELECT id, original_name, size, mime_type FROM submission_file WHERE submission_id = ?").all(sub.id);
  }

  res.json({ session, team_num: team.team_num, submission: sub || null, files });
});

// POST /api/sessions/:id/submit - 파일 업로드
app.post("/api/sessions/:id/submit", (req, res) => {
  const team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? ORDER BY year DESC LIMIT 1").get(req.user.email);
  if (!team) return res.status(403).send("팀이 등록되지 않았습니다.");

  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(Number(req.params.id));
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  const isTarget = db.prepare("SELECT 1 FROM session_team WHERE session_id = ? AND team_num = ?").get(session.id, team.team_num);
  if (!isTarget) return res.status(403).send("대상 팀이 아닙니다.");

  const currentTime = now();
  const effectiveLateEnd = session.late_end_at || session.end_at;
  if (currentTime < session.start_at) return res.status(400).send("제출 기간이 아닙니다.");
  if (currentTime > effectiveLateEnd) return res.status(400).send("제출 기간이 종료되었습니다.");

  const isLate = session.late_end_at && currentTime > session.end_at ? 1 : 0;

  const uploadId = crypto.randomUUID();
  const tmpDir = path.join(TMP_DIR, uploadId);
  fs.mkdirSync(tmpDir, { recursive: true });

  const filesInfo = [];
  const filePromises = [];
  let totalSize = 0;
  let aborted = false;

  const busboy = Busboy({
    headers: req.headers,
    defParamCharset: "utf8",
    limits: { files: 100, fileSize: session.max_file_size },
  });

  // 허용 확장자 파싱 (DB에 "pdf,docx" 형태로 저장, 비교 시 ".pdf" 형태로)
  const allowedExts = session.allowed_extensions
    ? session.allowed_extensions.split(",").map((e) => {
        const s = e.trim().toLowerCase().replace(/^\./, "");
        return s ? `.${s}` : "";
      }).filter(Boolean)
    : [];

  busboy.on("file", (fieldname, fileStream, info) => {
    if (aborted) { fileStream.resume(); return; }

    // 확장자 검증
    if (allowedExts.length > 0) {
      const ext = path.extname(info.filename || "").toLowerCase();
      if (!allowedExts.includes(ext)) {
        aborted = true;
        fileStream.resume();
        rmDir(tmpDir);
        if (!res.headersSent) res.status(400).send(`허용되지 않는 파일 형식입니다. (허용: ${allowedExts.join(", ")})`);
        return;
      }
    }

    // MIME type mismatch warning
    const MIME_MAP = {
      ".pdf": ["application/pdf"],
      ".doc": ["application/msword"],
      ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ".jpg": ["image/jpeg"], ".jpeg": ["image/jpeg"],
      ".png": ["image/png"],
      ".zip": ["application/zip", "application/x-zip-compressed"],
    };
    const ext = path.extname(info.filename || "").toLowerCase();
    if (MIME_MAP[ext] && !MIME_MAP[ext].includes(info.mimeType)) {
      console.warn(`[upload] MIME mismatch: ${info.filename} ext=${ext} mime=${info.mimeType}`);
    }

    const storedName = crypto.randomUUID() + safeExt(info.filename);
    const filePath = path.join(tmpDir, storedName);
    const ws = fs.createWriteStream(filePath);
    let fileSize = 0;

    const done = new Promise((resolve, reject) => {
      ws.on("finish", () => {
        if (!aborted) {
          filesInfo.push({
            original_name: info.filename,
            stored_name: storedName,
            size: fileSize,
            mime_type: info.mimeType || "",
          });
        }
        resolve();
      });
      ws.on("error", (err) => aborted ? resolve() : reject(err));
    });
    filePromises.push(done);

    fileStream.on("data", (chunk) => {
      fileSize += chunk.length;
      totalSize += chunk.length;
      if (totalSize > session.max_file_size) {
        aborted = true;
        fileStream.resume();
        ws.destroy();
        rmDir(tmpDir);
        if (!res.headersSent) res.status(413).send(`파일 용량 제한(${Math.round(session.max_file_size / 1024 / 1024)}MB)을 초과했습니다.`);
      }
    });

    fileStream.on("limit", () => {
      aborted = true;
      ws.destroy();
      rmDir(tmpDir);
      if (!res.headersSent) res.status(413).send(`파일 용량 제한(${Math.round(session.max_file_size / 1024 / 1024)}MB)을 초과했습니다.`);
    });

    fileStream.pipe(ws);
  });

  busboy.on("filesLimit", () => {
    aborted = true;
    rmDir(tmpDir);
    if (!res.headersSent) res.status(400).send("파일 수가 100개를 초과했습니다.");
  });

  busboy.on("error", () => {
    aborted = true;
    rmDir(tmpDir);
    if (!res.headersSent) res.status(500).send("업로드 중 오류가 발생했습니다.");
  });

  busboy.on("finish", async () => {
    if (aborted) return;

    // 모든 파일 write stream이 완료될 때까지 대기
    try { await Promise.all(filePromises); } catch {
      rmDir(tmpDir);
      if (!res.headersSent) res.status(500).send("파일 저장 중 오류가 발생했습니다.");
      return;
    }

    if (aborted) return;
    if (filesInfo.length === 0) {
      rmDir(tmpDir);
      return res.status(400).send("파일을 선택하세요.");
    }

    // 기존 제출 조회 (트랜잭션 밖에서)
    const prev = db.prepare("SELECT id FROM submission WHERE session_id = ? AND team_num = ? ORDER BY id DESC LIMIT 1").get(session.id, team.team_num);

    const txResult = dbRun(() => {
      const tx = db.transaction(() => {
        // 새 제출 INSERT
        const subResult = db.prepare(
          "INSERT INTO submission (session_id, team_num, submitted_by, submitted_at, total_size, is_late) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(session.id, team.team_num, req.user.email, currentTime, totalSize, isLate);
        const newSubId = subResult.lastInsertRowid;

        // 파일 메타데이터 INSERT
        const fileStmt = db.prepare("INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type) VALUES (?, ?, ?, ?, ?)");
        for (const f of filesInfo) {
          fileStmt.run(newSubId, f.original_name, f.stored_name, f.size, f.mime_type);
        }

        return { id: newSubId, submitted_at: currentTime, is_late: isLate, total_size: totalSize, prevId: prev ? prev.id : null };
      });
      return tx();
    });

    if (!txResult.success) {
      rmDir(tmpDir);
      return res.status(txResult.status).send(txResult.error);
    }

    // 파일시스템 조작은 트랜잭션 성공 후 수행
    const finalDir = path.join(UPLOADS_DIR, String(session.id), String(team.team_num), String(txResult.result.id));
    try {
      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.renameSync(tmpDir, finalDir);
    } catch (fsErr) {
      console.error("File operation failed after DB commit:", fsErr.message);
      try {
        db.prepare("DELETE FROM submission_file WHERE submission_id = ?").run(txResult.result.id);
        db.prepare("DELETE FROM submission WHERE id = ?").run(txResult.result.id);
      } catch (rollbackErr) {
        console.error("DB rollback after file error also failed — orphan record may exist:", rollbackErr.message);
      }
      rmDir(tmpDir);
      if (!res.headersSent) return res.status(500).send("파일 저장에 실패했습니다.");
      return;
    }

    if (txResult.result.prevId) {
      try {
        db.prepare("DELETE FROM submission_file WHERE submission_id = ?").run(txResult.result.prevId);
        db.prepare("DELETE FROM submission WHERE id = ?").run(txResult.result.prevId);
      } catch (e) {
        console.error("Failed to delete previous submission:", e.message);
      }
      rmDir(path.join(UPLOADS_DIR, String(session.id), String(team.team_num), String(txResult.result.prevId)));
    }

    const { prevId, ...result } = txResult.result;
    logger.log(req, "submission.create", { session_id: session.id, team_num: team.team_num, files: filesInfo.length, size: totalSize, is_late: isLate }, session.name);
    res.json(result);
  });

  req.on("error", () => {
    aborted = true;
    rmDir(tmpDir);
    if (!res.headersSent) res.status(400).send("업로드가 중단되었습니다.");
  });

  req.on("close", () => {
    if (!req.complete && !aborted && fs.existsSync(tmpDir)) {
      aborted = true;
      rmDir(tmpDir);
    }
  });

  req.pipe(busboy);
});

// GET /api/submissions/:subId/files/:fileId - 파일 다운로드
app.get("/api/submissions/:subId/files/:fileId", (req, res) => {
  const team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? ORDER BY year DESC LIMIT 1").get(req.user.email);
  if (!team) return res.status(403).send("팀이 등록되지 않았습니다.");

  const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
  if (sub.team_num !== team.team_num) return res.status(403).send("권한이 없습니다.");

  // 해당 submission의 세션이 학생 팀에 할당된 세션인지 검증
  const isTarget = db.prepare("SELECT 1 FROM session_team st JOIN session s ON s.id = st.session_id WHERE st.session_id = ? AND st.team_num = ? AND s.year = ?").get(sub.session_id, team.team_num, team.year);
  if (!isTarget) return res.status(403).send("권한이 없습니다.");

  const file = db.prepare("SELECT * FROM submission_file WHERE id = ? AND submission_id = ?").get(Number(req.params.fileId), sub.id);
  if (!file) return res.status(404).send("파일을 찾을 수 없습니다.");

  const filePath = path.join(UPLOADS_DIR, String(sub.session_id), String(sub.team_num), String(sub.id), file.stored_name);
  if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).send("잘못된 파일 경로입니다.");
  if (!fs.existsSync(filePath)) return res.status(404).send("파일이 존재하지 않습니다.");

  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.sendFile(filePath);
});

/* ============================================
   Chief/Admin API
   ============================================ */

// GET /api/admin/sessions - 전체 세션 목록
app.get("/api/admin/sessions", (req, res) => {
  const year = req.query.year ? Number(req.query.year) : null;
  const sessions = year
    ? db.prepare("SELECT * FROM session WHERE year = ? ORDER BY created_at DESC").all(year)
    : db.prepare("SELECT * FROM session ORDER BY created_at DESC").all();
  res.json(sessions);
});

// POST /api/admin/sessions - 세션 생성
app.post("/api/admin/sessions", (req, res) => {
  const { name, notice, start_at, end_at, max_file_size, allowed_extensions, year, teams } = req.body;
  const late_end_at = req.body.late_end_at || "";
  if (!name?.trim()) return res.status(400).send("세션 이름을 입력하세요.");
  if (!start_at || !end_at) return res.status(400).send("시간을 모두 입력하세요.");
  const isoRegex = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
  if (!isoRegex.test(start_at) || !isoRegex.test(end_at)) return res.status(400).send("날짜 형식이 올바르지 않습니다.");
  if (late_end_at && !isoRegex.test(late_end_at)) return res.status(400).send("지연 제출 마감 날짜 형식이 올바르지 않습니다.");
  if (end_at <= start_at) return res.status(400).send("제출 마감은 시작 이후여야 합니다.");
  if (late_end_at && late_end_at < end_at) return res.status(400).send("지각 마감은 제출 마감 이후여야 합니다.");
  const numYear = Number(year);
  if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099) return res.status(400).send("올바르지 않은 연도입니다.");
  if (!Array.isArray(teams) || teams.length === 0) return res.status(400).send("대상 팀을 선택하세요.");

  const maxSize = max_file_size ? Number(max_file_size) : 52428800;
  if (!Number.isFinite(maxSize) || maxSize <= 0) return res.status(400).send("올바르지 않은 파일 크기 제한입니다.");
  const exts = allowed_extensions || "";

  for (const t of teams) {
    if (!Number.isInteger(t) || t < 1) return res.status(400).send("올바르지 않은 팀 번호가 포함되어 있습니다.");
  }

  const txResult = dbRun(() => {
    const tx = db.transaction(() => {
      const result = db.prepare(
        "INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(name.trim(), notice || "", start_at, end_at, late_end_at, maxSize, exts, req.user.email, numYear);
      const sessionId = result.lastInsertRowid;

      const teamStmt = db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)");
      for (const t of teams) teamStmt.run(sessionId, t);

      return { id: sessionId };
    });
    return tx();
  });

  if (!txResult.success) return res.status(txResult.status).send(txResult.error);
  logger.log(req, "session.create", { year: numYear, teams: teams.length }, name.trim());
  res.status(201).json(txResult.result);
});

// PUT /api/admin/sessions/:id - 세션 수정
app.put("/api/admin/sessions/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, notice, start_at, end_at, max_file_size, allowed_extensions, teams } = req.body;
  const late_end_at = req.body.late_end_at || "";

  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  if (!name?.trim()) return res.status(400).send("세션 이름을 입력하세요.");
  if (!start_at || !end_at) return res.status(400).send("시간을 모두 입력하세요.");
  const isoRegex = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
  if (!isoRegex.test(start_at) || !isoRegex.test(end_at)) return res.status(400).send("날짜 형식이 올바르지 않습니다.");
  if (late_end_at && !isoRegex.test(late_end_at)) return res.status(400).send("지연 제출 마감 날짜 형식이 올바르지 않습니다.");
  if (end_at <= start_at) return res.status(400).send("제출 마감은 시작 이후여야 합니다.");
  if (late_end_at && late_end_at < end_at) return res.status(400).send("지각 마감은 제출 마감 이후여야 합니다.");
  if (!Array.isArray(teams) || teams.length === 0) return res.status(400).send("대상 팀을 선택하세요.");

  const maxSize = max_file_size ? Number(max_file_size) : 52428800;
  if (!Number.isFinite(maxSize) || maxSize <= 0) return res.status(400).send("올바르지 않은 파일 크기 제한입니다.");
  const exts = allowed_extensions || "";

  for (const t of teams) {
    if (!Number.isInteger(t) || t < 1) return res.status(400).send("올바르지 않은 팀 번호가 포함되어 있습니다.");
  }

  const removedTeamNums = [];
  const txResult = dbRun(() => {
    const tx = db.transaction(() => {
      db.prepare(
        "UPDATE session SET name = ?, notice = ?, start_at = ?, end_at = ?, late_end_at = ?, max_file_size = ?, allowed_extensions = ? WHERE id = ?",
      ).run(name.trim(), notice || "", start_at, end_at, late_end_at, maxSize, exts, id);

      // 기존 팀 목록 조회
      const oldTeams = db.prepare("SELECT team_num FROM session_team WHERE session_id = ?").all(id).map(r => r.team_num);
      const newTeamsSet = new Set(teams);

      // 제거되는 팀의 제출물 정리
      for (const oldTeam of oldTeams) {
        if (!newTeamsSet.has(oldTeam)) {
          const subs = db.prepare("SELECT id FROM submission WHERE session_id = ? AND team_num = ?").all(id, oldTeam);
          for (const sub of subs) {
            db.prepare("DELETE FROM submission_file WHERE submission_id = ?").run(sub.id);
            db.prepare("DELETE FROM submission WHERE id = ?").run(sub.id);
          }
          if (subs.length) removedTeamNums.push({ team: oldTeam, subIds: subs.map(s => s.id) });
        }
      }

      db.prepare("DELETE FROM session_team WHERE session_id = ?").run(id);
      const teamStmt = db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)");
      for (const t of teams) teamStmt.run(id, t);
    });
    return tx();
  });

  if (!txResult.success) return res.status(txResult.status).send(txResult.error);

  // 트랜잭션 성공 후 디스크 파일 정리
  for (const { team, subIds } of removedTeamNums) {
    for (const subId of subIds) {
      rmDir(path.join(UPLOADS_DIR, String(id), String(team), String(subId)));
    }
  }
  logger.log(req, "session.update", { id }, name.trim());
  res.status(200).send();
});

// DELETE /api/admin/sessions/:id - 세션 삭제
app.delete("/api/admin/sessions/:id", (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  const txResult = dbRun(() => {
    db.prepare("DELETE FROM session WHERE id = ?").run(id);
  });

  if (!txResult.success) return res.status(txResult.status).send(txResult.error);

  logger.log(req, "session.delete", { id, year: session.year }, session.name);

  // 파일 비동기 삭제
  rmDir(path.join(UPLOADS_DIR, String(id)));

  res.status(200).send();
});

// GET /api/admin/sessions/:id/status - 팀별 제출 현황
app.get("/api/admin/sessions/:id/status", (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  const teams = db.prepare("SELECT team_num FROM session_team WHERE session_id = ? ORDER BY team_num").all(id);

  const subStmt = db.prepare(`
    SELECT s.id, s.submitted_at, s.total_size, s.is_late, s.submitted_by
    FROM submission s
    WHERE s.session_id = ? AND s.team_num = ?
    ORDER BY s.id DESC LIMIT 1
  `);

  const fileStmt = db.prepare("SELECT id, original_name, size, mime_type FROM submission_file WHERE submission_id = ?");

  const status = teams.map((t) => {
    const sub = subStmt.get(id, t.team_num);
    const files = sub ? fileStmt.all(sub.id) : [];
    return { team_num: t.team_num, submission: sub || null, files };
  });

  res.json({ session, status });
});

// GET /api/admin/submissions/:subId/files/:fileId - 관리자 파일 다운로드
app.get("/api/admin/submissions/:subId/files/:fileId", (req, res) => {
  const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");

  const file = db.prepare("SELECT * FROM submission_file WHERE id = ? AND submission_id = ?").get(Number(req.params.fileId), sub.id);
  if (!file) return res.status(404).send("파일을 찾을 수 없습니다.");

  const filePath = path.join(UPLOADS_DIR, String(sub.session_id), String(sub.team_num), String(sub.id), file.stored_name);
  if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).send("잘못된 파일 경로입니다.");
  if (!fs.existsSync(filePath)) return res.status(404).send("파일이 존재하지 않습니다.");

  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.sendFile(filePath);
});

// GET /api/admin/students - auth 서비스에서 student 역할 사용자 목록 조회
app.get("/api/admin/students", async (req, res) => {
  try {
    const authRes = await fetch(`${process.env.AUTH_SERVER}/api/users`, {
      headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
      signal: AbortSignal.timeout(5000),
    });
    if (!authRes.ok) return res.status(502).send("계정 서비스 연결 실패");
    const users = await authRes.json();
    const students = users.filter((u) => u.role === "student" && u.active);
    res.json(students.map((u) => ({ email: u.email, name: u.name })));
  } catch {
    res.status(502).send("계정 서비스 연결 실패");
  }
});

// GET /api/admin/student-teams - 학생-팀 매핑 목록
app.get("/api/admin/student-teams", (req, res) => {
  const year = req.query.year ? Number(req.query.year) : null;
  const rows = year
    ? db.prepare("SELECT * FROM student_team WHERE year = ? ORDER BY team_num").all(year)
    : db.prepare("SELECT * FROM student_team ORDER BY year DESC, team_num").all();
  res.json(rows);
});

// POST /api/admin/student-teams - 학생-팀 매핑 추가
app.post("/api/admin/student-teams", (req, res) => {
  const { email, team_num, year } = req.body;
  if (!email?.trim()) return res.status(400).send("이메일을 입력하세요.");
  const numTeam = Number(team_num);
  const numYear = Number(year);
  if (!Number.isInteger(numTeam) || numTeam < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2099) return res.status(400).send("올바르지 않은 연도입니다.");

  const result = dbRun(() =>
    db.prepare("INSERT INTO student_team (email, team_num, year) VALUES (?, ?, ?)").run(email.trim().toLowerCase(), numTeam, numYear),
  );

  if (!result.success) {
    if (result.error.includes("UNIQUE")) return res.status(400).send("이미 등록된 이메일이거나 해당 팀에 이미 학생이 있습니다.");
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "student_team.create", { team_num: Number(team_num), year: Number(year) }, email.trim().toLowerCase());
  res.status(201).json({ email: email.trim().toLowerCase(), team_num: Number(team_num), year: Number(year) });
});

// DELETE /api/admin/student-teams/:email/:year - 학생-팀 매핑 삭제
app.delete("/api/admin/student-teams/:email/:year", (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year)) return res.status(400).send("올바르지 않은 연도입니다.");
  const result = dbRun(() =>
    db.prepare("DELETE FROM student_team WHERE email = ? AND year = ?")
      .run(decodeURIComponent(req.params.email), year)
  );
  if (!result.success) return res.status(result.status).send(result.error);
  if (result.result.changes === 0) return res.status(404).send("매핑을 찾을 수 없습니다.");
  logger.log(req, "student_team.delete", { year }, decodeURIComponent(req.params.email));
  res.status(200).send();
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
  const { app, db } = createDocumentsApp();
  setupProcessHandlers(db);
  app.listen(9900);
}
