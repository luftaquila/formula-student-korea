import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase, addColumn } from "../shared/db-setup.mjs";
import Busboy from "busboy";
import archiver from "archiver";
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
  started_at TEXT DEFAULT '',
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
db.exec(`CREATE INDEX IF NOT EXISTS idx_sf_submission
  ON submission_file(submission_id)`);

// 마이그레이션: allowed_extensions 컬럼 추가
addColumn(db, "session", "allowed_extensions TEXT DEFAULT ''");

// 마이그레이션: started_at 컬럼 추가 (업로드 시작 시간)
addColumn(db, "submission", "started_at TEXT DEFAULT ''");

// 마이그레이션: attempt_no 컬럼 추가 (제출 시도 누적 번호 — retention과 무관하게 유지)
addColumn(db, "submission", "attempt_no INTEGER NOT NULL DEFAULT 0");
{
  const pending = db.prepare("SELECT 1 FROM submission WHERE attempt_no = 0 LIMIT 1").get();
  if (pending) {
    // 살아남은 row 그룹별로 logs(submission.create info)에서 실제 시도 횟수를 복원.
    // logs FIFO cap(50k, shared/logger.mjs)에 의해 잘려있을 경우 최소 하한은 현재 row 수.
    db.transaction(() => {
      const groups = db.prepare(`
        SELECT session_id, team_num, COUNT(*) AS rows
        FROM submission WHERE attempt_no = 0
        GROUP BY session_id, team_num
      `).all();
      const countLogs = db.prepare(`
        SELECT COUNT(*) AS c FROM logs
        WHERE action = 'submission.create' AND level = 'info'
          AND CAST(json_extract(detail, '$.session_id') AS INTEGER) = ?
          AND CAST(json_extract(detail, '$.team_num') AS INTEGER) = ?
      `);
      const zeroRowsStmt = db.prepare(`
        SELECT id FROM submission
        WHERE session_id = ? AND team_num = ? AND attempt_no = 0
        ORDER BY id DESC
      `);
      const setAttempt = db.prepare("UPDATE submission SET attempt_no = ? WHERE id = ?");
      for (const g of groups) {
        const logged = countLogs.get(g.session_id, g.team_num).c;
        // 로그가 잘려 있어도 최소 하한은 살아남은 row 수.
        const newest = Math.max(logged, g.rows);
        const rows = zeroRowsStmt.all(g.session_id, g.team_num);
        let n = newest;
        for (const r of rows) {
          setAttempt.run(n, r.id);
          n -= 1;
        }
      }
    })();
  }
}

// 예약 알림 테이블
db.exec(`CREATE TABLE IF NOT EXISTS scheduled_notification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_sn_pending ON scheduled_notification(sent, scheduled_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sn_session_sent ON scheduled_notification(session_id, sent)");

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
  if (req.path.startsWith("/api/internal/")) return "admin";
  if (req.path.startsWith("/api/admin")) return "chief";
  if (req.path === "/api/logs") return "admin";
  if (req.path.startsWith("/api/")) return "student";
  if (req.path.startsWith("/admin")) return "chief";
  return "student";
});

app.get("/api/logs", logger.queryHandler);

app.get("/api/health", (req, res) => res.send("ok"));

const dbRun = createDbRun();

function requireInternalRequest(req, res) {
  if (req.user?.email === "internal" && req.user?.role === "admin") return true;
  res.status(403).send("내부 서비스 호출만 허용됩니다.");
  return false;
}

/* ============================================
   헬퍼
   ============================================ */
function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** "YYYY-MM-DD HH:MM" 또는 "YYYY-MM-DDTHH:MM" → "YYYY-MM-DD HH:MM:SS" (19자) 정규화. 실패 시 null */
function normalizeTimestamp(str) {
  if (!str || typeof str !== "string") return null;
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/);
  if (!m) return null;
  return `${m[1]} ${m[2]}${m[3] || ":00"}`;
}

/** UTC DB date string → KST display "YYYY-MM-DD HH:MM" */
function toKST(utcStr) {
  if (!utcStr) return "";
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  d.setHours(d.getHours() + 9);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

/** Subtract hours from UTC date string → UTC date string */
function subtractHours(utcStr, hours) {
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  d.setHours(d.getHours() - hours);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function safeExt(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

// zip 엔트리/아카이브 폴더명에서 경로 구분자·금지 문자를 "_"로 치환.
function sanitize(s) {
  return s.replace(/[/\\:*?"<>|]/g, "_");
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(null, "file.cleanup", { error: err.message, dir });
  }
}

// 브라우저에서 안전하게 인라인으로 표시 가능한 MIME/확장자 화이트리스트.
// SVG·HTML은 same-origin XSS 위험이 있어 제외한다.
const INLINE_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "video/ogg",
]);
const INLINE_EXT_MIME = {
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function inlineDisposition(originalName, mimeType) {
  const ext = path.extname(originalName || "").toLowerCase();
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (mime && INLINE_MIME.has(mime)) return mime;
  if (INLINE_EXT_MIME[ext]) return INLINE_EXT_MIME[ext];
  return null;
}

function setFileResponseHeaders(res, file) {
  const inlineType = inlineDisposition(file.original_name, file.mime_type);
  const encoded = encodeURIComponent(file.original_name);
  if (inlineType) {
    res.setHeader("Content-Type", inlineType);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encoded}`);
  } else {
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encoded}`);
  }
}

// 브라우저 인라인 뷰어(PDF 등)는 Range 요청으로 파일을 여러 조각으로 나눠 가져온다.
// res.sendFile은 매 Range 요청마다 핸들러를 재실행하므로, 모든 요청에서 로깅하면
// 다운로드 1회에 로그가 수십 건 찍힌다. 초기 요청(Range 없음 또는 bytes=0-)에서만
// 로깅해 다운로드 1회당 로그 1건을 유지한다.
function isInitialDownload(req) {
  const range = req.headers.range;
  return !range || range.startsWith("bytes=0-");
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
  if (!team) { logger.warn(req, "session.view", { error: "no_team" }); return res.status(403).send("팀이 등록되지 않았습니다."); }

  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(Number(req.params.id));
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  const isTarget = db.prepare("SELECT 1 FROM session_team WHERE session_id = ? AND team_num = ?").get(session.id, team.team_num);
  if (!isTarget) { logger.warn(req, "session.view", { error: "not_target", session_id: session.id }, session.name); return res.status(403).send("대상 팀이 아닙니다."); }

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
  if (!team) { logger.warn(req, "submission.create", { error: "no_team" }); return res.status(403).send("팀이 등록되지 않았습니다."); }

  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(Number(req.params.id));
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  const isTarget = db.prepare("SELECT 1 FROM session_team WHERE session_id = ? AND team_num = ?").get(session.id, team.team_num);
  if (!isTarget) { logger.warn(req, "submission.create", { error: "not_target", session_id: session.id }, session.name); return res.status(403).send("대상 팀이 아닙니다."); }

  const startTime = now();
  const effectiveLateEnd = session.late_end_at || session.end_at;
  if (startTime < session.start_at) return res.status(400).send("제출 기간이 아닙니다.");
  if (startTime > effectiveLateEnd) return res.status(400).send("제출 기간이 종료되었습니다.");

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
        if (!res.headersSent) {
          logger.warn(req, "submission.create", { error: "invalid_extension", filename: info.filename, ext, allowed: allowedExts, session_id: session.id, team_num: team.team_num }, session.name);
          res.status(400).send(`허용되지 않는 파일 형식입니다. (허용: ${allowedExts.join(", ")})`);
        }
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
      logger.warn(req, "submission.create", { warning: "mime_mismatch", filename: info.filename, ext, mime: info.mimeType }, session.name);
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
        if (!res.headersSent) {
          logger.warn(req, "submission.create", { error: "file_size_exceeded", max_file_size: session.max_file_size, total_size: totalSize, filename: info.filename, session_id: session.id, team_num: team.team_num }, session.name);
          res.status(413).send(`파일 용량 제한(${Math.round(session.max_file_size / 1024 / 1024)}MB)을 초과했습니다.`);
        }
      }
    });

    fileStream.on("limit", () => {
      aborted = true;
      ws.destroy();
      rmDir(tmpDir);
      if (!res.headersSent) {
        logger.warn(req, "submission.create", { error: "file_size_exceeded", max_file_size: session.max_file_size, filename: info.filename, session_id: session.id, team_num: team.team_num }, session.name);
        res.status(413).send(`파일 용량 제한(${Math.round(session.max_file_size / 1024 / 1024)}MB)을 초과했습니다.`);
      }
    });

    fileStream.pipe(ws);
  });

  busboy.on("filesLimit", () => {
    aborted = true;
    rmDir(tmpDir);
    if (!res.headersSent) {
      logger.warn(req, "submission.create", { error: "files_limit_exceeded", limit: 100, session_id: session.id, team_num: team.team_num }, session.name);
      res.status(400).send("파일 수가 100개를 초과했습니다.");
    }
  });

  busboy.on("error", (err) => {
    aborted = true;
    rmDir(tmpDir);
    if (!res.headersSent) {
      logger.warn(req, "submission.create", { error: err?.message || "busboy_error", session_id: session.id, team_num: team.team_num }, session.name);
      res.status(500).send("업로드 중 오류가 발생했습니다.");
    }
  });

  busboy.on("finish", async () => {
    if (aborted) return;

    // 모든 파일 write stream이 완료될 때까지 대기
    try { await Promise.all(filePromises); } catch (writeErr) {
      logger.warn(req, "submission.create", { error: writeErr?.message || "file_write_failed", phase: "write_stream", session_id: session.id, team_num: team.team_num }, session.name);
      rmDir(tmpDir);
      if (!res.headersSent) res.status(500).send("파일 저장 중 오류가 발생했습니다.");
      return;
    }

    if (aborted) return;
    if (filesInfo.length === 0) {
      rmDir(tmpDir);
      return res.status(400).send("파일을 선택하세요.");
    }

    // 업로드 완료 시간 기준으로 마감·지각 여부 결정
    const submittedTime = now();
    if (submittedTime > effectiveLateEnd) {
      rmDir(tmpDir);
      logger.warn(req, "submission.create", { error: "upload_past_deadline", started_at: startTime, submitted_at: submittedTime, deadline: effectiveLateEnd, session_id: session.id, team_num: team.team_num }, session.name);
      if (!res.headersSent) return res.status(400).send("업로드 완료 시간이 제출 마감을 초과했습니다.");
      return;
    }
    const isLate = session.late_end_at && submittedTime > session.end_at ? 1 : 0;

    const txResult = dbRun(() => {
      const tx = db.transaction(() => {
        // attempt_no는 같은 (session, team)의 누적 최대치 + 1. retention으로 삭제되어도 최신 row가 살아남으므로 단조 증가.
        const prevAttempt = db.prepare(
          "SELECT MAX(attempt_no) AS m FROM submission WHERE session_id = ? AND team_num = ?",
        ).get(session.id, team.team_num);
        const attemptNo = (prevAttempt?.m || 0) + 1;

        // 새 제출 INSERT
        const subResult = db.prepare(
          "INSERT INTO submission (session_id, team_num, submitted_by, started_at, submitted_at, total_size, is_late, attempt_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(session.id, team.team_num, req.user.email, startTime, submittedTime, totalSize, isLate, attemptNo);
        const newSubId = subResult.lastInsertRowid;

        // 파일 메타데이터 INSERT
        const fileStmt = db.prepare("INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type) VALUES (?, ?, ?, ?, ?)");
        for (const f of filesInfo) {
          fileStmt.run(newSubId, f.original_name, f.stored_name, f.size, f.mime_type);
        }

        // 최신 2개를 제외한 오래된 제출 조회
        const allSubs = db.prepare(
          "SELECT id FROM submission WHERE session_id = ? AND team_num = ? ORDER BY id DESC",
        ).all(session.id, team.team_num);
        const toDelete = allSubs.slice(2).map(s => s.id);

        return { id: newSubId, submitted_at: submittedTime, is_late: isLate, total_size: totalSize, toDelete };
      });
      return tx();
    });

    if (!txResult.success) {
      logger.warn(req, "submission.create", { error: txResult.error, session_id: session.id }, session.name);
      rmDir(tmpDir);
      return res.status(txResult.status).send(txResult.error);
    }

    // 파일시스템 조작은 트랜잭션 성공 후 수행
    const finalDir = path.join(UPLOADS_DIR, String(session.id), String(team.team_num), String(txResult.result.id));
    try {
      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.renameSync(tmpDir, finalDir);
    } catch (fsErr) {
      logger.warn(req, "submission.create", { error: fsErr.message, phase: "file_move" }, session.name);
      try {
        db.prepare("DELETE FROM submission_file WHERE submission_id = ?").run(txResult.result.id);
        db.prepare("DELETE FROM submission WHERE id = ?").run(txResult.result.id);
      } catch (rollbackErr) {
        logger.warn(req, "submission.create", { error: rollbackErr.message, phase: "rollback", submission_id: txResult.result.id }, session.name);
      }
      rmDir(tmpDir);
      if (!res.headersSent) return res.status(500).send("파일 저장에 실패했습니다.");
      return;
    }

    for (const oldId of txResult.result.toDelete) {
      try {
        db.prepare("DELETE FROM submission_file WHERE submission_id = ?").run(oldId);
        db.prepare("DELETE FROM submission WHERE id = ?").run(oldId);
      } catch (e) {
        logger.warn(req, "submission.create", { error: e.message, phase: "prev_cleanup", prev_id: oldId }, session.name);
      }
      rmDir(path.join(UPLOADS_DIR, String(session.id), String(team.team_num), String(oldId)));
    }

    const { toDelete, ...result } = txResult.result;
    logger.log(req, "submission.create", { session_id: session.id, team_num: team.team_num, files: filesInfo.length, size: totalSize, is_late: isLate, started_at: startTime, submitted_at: submittedTime }, session.name);
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
  if (!team) { logger.warn(req, "file.download", { error: "no_team", sub_id: Number(req.params.subId) }); return res.status(403).send("팀이 등록되지 않았습니다."); }

  const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
  if (sub.team_num !== team.team_num) { logger.warn(req, "file.download", { error: "wrong_team", sub_team: sub.team_num, my_team: team.team_num }, `#${sub.team_num}`); return res.status(403).send("권한이 없습니다."); }

  // 해당 submission의 세션이 학생 팀에 할당된 세션인지 검증
  const isTarget = db.prepare("SELECT 1 FROM session_team st JOIN session s ON s.id = st.session_id WHERE st.session_id = ? AND st.team_num = ? AND s.year = ?").get(sub.session_id, team.team_num, team.year);
  if (!isTarget) { logger.warn(req, "file.download", { error: "not_target", session_id: sub.session_id }, `#${sub.team_num}`); return res.status(403).send("권한이 없습니다."); }

  const file = db.prepare("SELECT * FROM submission_file WHERE id = ? AND submission_id = ?").get(Number(req.params.fileId), sub.id);
  if (!file) return res.status(404).send("파일을 찾을 수 없습니다.");

  const filePath = path.join(UPLOADS_DIR, String(sub.session_id), String(sub.team_num), String(sub.id), file.stored_name);
  if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).send("잘못된 파일 경로입니다.");
  if (!fs.existsSync(filePath)) return res.status(404).send("파일이 존재하지 않습니다.");

  const session = db.prepare("SELECT name FROM session WHERE id = ?").get(sub.session_id);
  if (isInitialDownload(req)) logger.log(req, "file.download", { session_name: session?.name, team_num: sub.team_num, file: file.original_name }, `#${sub.team_num}`);
  setFileResponseHeaders(res, file);
  res.sendFile(filePath);
});

// GET /api/submissions/:subId/zip - 본인 제출 파일 전체 압축 다운로드
app.get("/api/submissions/:subId/zip", async (req, res) => {
  const team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? ORDER BY year DESC LIMIT 1").get(req.user.email);
  if (!team) { logger.warn(req, "file.zip", { error: "no_team", sub_id: Number(req.params.subId) }); return res.status(403).send("팀이 등록되지 않았습니다."); }

  const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
  if (sub.team_num !== team.team_num) { logger.warn(req, "file.zip", { error: "wrong_team", sub_team: sub.team_num, my_team: team.team_num }, `#${sub.team_num}`); return res.status(403).send("권한이 없습니다."); }

  // 해당 submission의 세션이 학생 팀에 할당된 세션인지 검증
  const isTarget = db.prepare("SELECT 1 FROM session_team st JOIN session s ON s.id = st.session_id WHERE st.session_id = ? AND st.team_num = ? AND s.year = ?").get(sub.session_id, team.team_num, team.year);
  if (!isTarget) { logger.warn(req, "file.zip", { error: "not_target", session_id: sub.session_id }, `#${sub.team_num}`); return res.status(403).send("권한이 없습니다."); }

  const files = db.prepare("SELECT * FROM submission_file WHERE submission_id = ?").all(sub.id);
  if (files.length === 0) return res.status(404).send("다운로드할 파일이 없습니다.");

  const session = db.prepare("SELECT name FROM session WHERE id = ?").get(sub.session_id);
  const zipName = `${sanitize(session?.name || String(sub.session_id))}.zip`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);

  const archive = archiver("zip", { zlib: { level: 5 } });
  archive.on("error", (err) => {
    logger.warn(req, "file.zip", { error: err.message, submission_id: sub.id }, `#${sub.team_num}`);
    if (!res.headersSent) res.status(500).send("압축 중 오류가 발생했습니다.");
  });
  archive.pipe(res);

  for (const f of files) {
    const filePath = path.join(UPLOADS_DIR, String(sub.session_id), String(sub.team_num), String(sub.id), f.stored_name);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: f.original_name });
    }
  }

  archive.finalize();
  logger.log(req, "file.zip", { session_name: session?.name, team_num: sub.team_num, files: files.length }, `#${sub.team_num}`);
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
  const rawLateEnd = req.body.late_end_at || "";
  if (!name?.trim()) return res.status(400).send("세션 이름을 입력하세요.");
  if (!start_at || !end_at) return res.status(400).send("시간을 모두 입력하세요.");
  const nStart = normalizeTimestamp(start_at);
  const nEnd = normalizeTimestamp(end_at);
  if (!nStart || !nEnd) return res.status(400).send("날짜 형식이 올바르지 않습니다.");
  const nLateEnd = rawLateEnd ? normalizeTimestamp(rawLateEnd) : "";
  if (rawLateEnd && !nLateEnd) return res.status(400).send("지연 제출 마감 날짜 형식이 올바르지 않습니다.");
  if (nEnd <= nStart) return res.status(400).send("제출 마감은 시작 이후여야 합니다.");
  if (nLateEnd && nLateEnd < nEnd) return res.status(400).send("지각 마감은 제출 마감 이후여야 합니다.");
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
      ).run(name.trim(), notice || "", nStart, nEnd, nLateEnd, maxSize, exts, req.user.email, numYear);
      const sessionId = result.lastInsertRowid;

      const teamStmt = db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)");
      for (const t of teams) teamStmt.run(sessionId, t);

      return { id: sessionId };
    });
    return tx();
  });

  if (!txResult.success) { logger.warn(req, "session.create", { error: txResult.error }, name.trim()); return res.status(txResult.status).send(txResult.error); }
  logger.log(req, "session.create", { year: numYear, teams: teams.length }, name.trim());
  res.status(201).json(txResult.result);

  // 예약 알림 등록 (세션 시작 시, 마감 3시간 전, 마감 1시간 전)
  try { scheduleSessionNotifications(txResult.result.id, nStart, nEnd); }
  catch (e) { logger.warn(req, "schedule.register", { error: e.message, sessionId: txResult.result.id }); }
});

// PUT /api/admin/sessions/:id - 세션 수정
app.put("/api/admin/sessions/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, notice, start_at, end_at, max_file_size, allowed_extensions, teams } = req.body;
  const rawLateEnd = req.body.late_end_at || "";

  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  if (!name?.trim()) return res.status(400).send("세션 이름을 입력하세요.");
  if (!start_at || !end_at) return res.status(400).send("시간을 모두 입력하세요.");
  const nStart = normalizeTimestamp(start_at);
  const nEnd = normalizeTimestamp(end_at);
  if (!nStart || !nEnd) return res.status(400).send("날짜 형식이 올바르지 않습니다.");
  const nLateEnd = rawLateEnd ? normalizeTimestamp(rawLateEnd) : "";
  if (rawLateEnd && !nLateEnd) return res.status(400).send("지연 제출 마감 날짜 형식이 올바르지 않습니다.");
  if (nEnd <= nStart) return res.status(400).send("제출 마감은 시작 이후여야 합니다.");
  if (nLateEnd && nLateEnd < nEnd) return res.status(400).send("지각 마감은 제출 마감 이후여야 합니다.");
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
      ).run(name.trim(), notice || "", nStart, nEnd, nLateEnd, maxSize, exts, id);

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

  if (!txResult.success) { logger.warn(req, "session.update", { error: txResult.error }, name.trim()); return res.status(txResult.status).send(txResult.error); }

  // 트랜잭션 성공 후 디스크 파일 정리
  for (const { team, subIds } of removedTeamNums) {
    for (const subId of subIds) {
      rmDir(path.join(UPLOADS_DIR, String(id), String(team), String(subId)));
    }
  }
  logger.log(req, "session.update", { year: session.year, teams: teams.length }, name.trim());
  res.status(200).send();

  // 예약 알림 재등록 (날짜 변경 반영)
  try { scheduleSessionNotifications(id, nStart, nEnd); }
  catch (e) { logger.warn(req, "schedule.register", { error: e.message, sessionId: id }); }
});

// DELETE /api/admin/sessions/:id - 세션 삭제
app.delete("/api/admin/sessions/:id", (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  const txResult = dbRun(() => {
    db.prepare("DELETE FROM session WHERE id = ?").run(id);
  });

  if (!txResult.success) { logger.warn(req, "session.delete", { error: txResult.error }, session.name); return res.status(txResult.status).send(txResult.error); }

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
    SELECT s.id, s.submitted_at, s.total_size, s.is_late, s.submitted_by, s.attempt_no
    FROM submission s
    WHERE s.session_id = ? AND s.team_num = ?
    ORDER BY s.id DESC LIMIT 2
  `);

  const fileStmt = db.prepare("SELECT id, original_name, size, mime_type FROM submission_file WHERE submission_id = ?");

  const status = teams.map((t) => {
    const subs = subStmt.all(id, t.team_num);
    const sub = subs[0] || null;
    const files = sub ? fileStmt.all(sub.id) : [];
    const prevSub = subs[1] || null;
    const prevFiles = prevSub ? fileStmt.all(prevSub.id) : [];
    // 백필 누락 등으로 attempt_no가 0이면 최소 1로 보정 (sub이 존재하니 최소 1회 제출은 있음)
    const submissionCount = sub ? (sub.attempt_no || 1) : 0;
    return { team_num: t.team_num, submission: sub, files, prevSubmission: prevSub, prevFiles, submissionCount };
  });

  res.json({ session, status });
});

// GET /api/admin/sessions/:id/archive - 세션별 전체 압축 다운로드
app.get("/api/admin/sessions/:id/archive", async (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  // entry 서비스에서 팀 정보 조회
  let entries = {};
  const entryServer = process.env.ENTRY_SERVER;
  if (entryServer) {
    try {
      const entryRes = await fetch(`${entryServer}/api/entries?year=${session.year}`, {
        headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
        signal: AbortSignal.timeout(5000),
      });
      if (entryRes.ok) entries = await entryRes.json();
      else logger.warn(req, "session.archive", { warning: "entry_fetch_non_ok", status: entryRes.status, session_id: id });
    } catch (e) {
      logger.warn(req, "session.archive", { warning: "entry_fetch_failed", error: e.message, session_id: id });
    }
  }

  const subs = db.prepare(`
    SELECT sub.id, sub.team_num FROM submission sub
    INNER JOIN (
      SELECT session_id, team_num, MAX(id) AS max_id
      FROM submission WHERE session_id = ? GROUP BY session_id, team_num
    ) latest ON sub.id = latest.max_id
  `).all(id);

  const sessionName = sanitize(session.name);
  const archiveFiles = [];

  for (const sub of subs) {
    const files = db.prepare("SELECT original_name, stored_name FROM submission_file WHERE submission_id = ?").all(sub.id);
    for (const f of files) {
      const diskPath = path.join(UPLOADS_DIR, String(id), String(sub.team_num), String(sub.id), f.stored_name);
      if (fs.existsSync(diskPath)) {
        const entry = entries[sub.team_num];
        const teamFolder = entry
          ? `${sub.team_num}_${sanitize(entry.univ)}_${sanitize(entry.team)}`
          : String(sub.team_num);
        archiveFiles.push({ diskPath, zipPath: `${sessionName}/${teamFolder}/${f.original_name}` });
      }
    }
  }

  if (archiveFiles.length === 0) return res.status(404).send("다운로드할 파일이 없습니다.");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${sessionName}.zip`)}`);

  const archive = archiver("zip", { zlib: { level: 5 } });
  archive.on("error", (err) => {
    logger.warn(req, "session.archive", { error: err.message, session_id: id });
    if (!res.headersSent) res.status(500).send("압축 중 오류가 발생했습니다.");
  });
  archive.pipe(res);

  for (const f of archiveFiles) {
    archive.file(f.diskPath, { name: f.zipPath });
  }

  await archive.finalize();
  logger.log(req, "session.archive", { session_name: session.name, teams: subs.length, files: archiveFiles.length });
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

  const session = db.prepare("SELECT name FROM session WHERE id = ?").get(sub.session_id);
  if (isInitialDownload(req)) logger.log(req, "file.admin_download", { session_name: session?.name, team_num: sub.team_num, file: file.original_name }, `#${sub.team_num}`);
  setFileResponseHeaders(res, file);
  res.sendFile(filePath);
});

// GET /api/admin/submissions/:subId/zip - 제출 파일 전체 압축 다운로드
app.get("/api/admin/submissions/:subId/zip", async (req, res) => {
  const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");

  const files = db.prepare("SELECT * FROM submission_file WHERE submission_id = ?").all(sub.id);
  if (files.length === 0) return res.status(404).send("다운로드할 파일이 없습니다.");

  const session = db.prepare("SELECT name, year FROM session WHERE id = ?").get(sub.session_id);
  const sessionName = sanitize(session?.name || String(sub.session_id));

  // entry 서비스에서 팀 정보 조회
  let teamLabel = String(sub.team_num);
  const entryServer = process.env.ENTRY_SERVER;
  if (entryServer && session?.year) {
    try {
      const entryRes = await fetch(`${entryServer}/api/entries?year=${session.year}`, {
        headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
        signal: AbortSignal.timeout(5000),
      });
      if (entryRes.ok) {
        const entries = await entryRes.json();
        const entry = entries[sub.team_num];
        if (entry) teamLabel = `${sub.team_num}_${sanitize(entry.univ)}_${sanitize(entry.team)}`;
      } else {
        logger.warn(req, "file.admin_zip", { warning: "entry_fetch_non_ok", status: entryRes.status, submission_id: sub.id });
      }
    } catch (e) {
      logger.warn(req, "file.admin_zip", { warning: "entry_fetch_failed", error: e.message, submission_id: sub.id });
    }
  }

  const zipName = `${sessionName}_${teamLabel}.zip`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);

  const archive = archiver("zip", { zlib: { level: 5 } });
  archive.on("error", (err) => {
    logger.warn(req, "file.admin_zip", { error: err.message, submission_id: sub.id });
    if (!res.headersSent) res.status(500).send("압축 중 오류가 발생했습니다.");
  });
  archive.pipe(res);

  for (const f of files) {
    const filePath = path.join(UPLOADS_DIR, String(sub.session_id), String(sub.team_num), String(sub.id), f.stored_name);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: f.original_name });
    }
  }

  archive.finalize();
  logger.log(req, "file.admin_zip", { session_name: session?.name, team_num: sub.team_num, files: files.length }, `#${sub.team_num}`);
});

// GET /api/admin/students - auth 서비스에서 student 역할 사용자 목록 조회
app.get("/api/admin/students", async (req, res) => {
  try {
    const authRes = await fetch(`${process.env.AUTH_SERVER}/api/users`, {
      headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
      signal: AbortSignal.timeout(5000),
    });
    if (!authRes.ok) { logger.warn(req, "auth.fetch", { error: "status_" + authRes.status }); return res.status(502).send("계정 서비스 연결 실패"); }
    const users = await authRes.json();
    const students = users.filter((u) => u.role === "student" && u.active);
    res.json(students.map((u) => ({ email: u.email, name: u.name, realname: u.realname, phone: u.phone })));
  } catch (e) {
    logger.warn(req, "auth.fetch", { error: e.message });
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
    if (result.error.includes("UNIQUE")) {
      logger.warn(req, "student_team.create", { error: "duplicate", team_num: numTeam, year: numYear }, email.trim().toLowerCase());
      return res.status(400).send("이미 등록된 이메일이거나 해당 팀에 이미 학생이 있습니다.");
    }
    logger.warn(req, "student_team.create", { error: result.error }, email.trim().toLowerCase());
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "student_team.create", { team_num: Number(team_num), year: Number(year) }, email.trim().toLowerCase());
  res.status(201).json({ email: email.trim().toLowerCase(), team_num: Number(team_num), year: Number(year) });

  notifyOpenSessions(req, email.trim().toLowerCase(), numTeam, numYear);
});

// DELETE /api/admin/student-teams/:email/:year - 학생-팀 매핑 삭제
app.delete("/api/admin/student-teams/:email/:year", (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year)) return res.status(400).send("올바르지 않은 연도입니다.");
  const email = decodeURIComponent(req.params.email);
  const mapping = db.prepare("SELECT team_num FROM student_team WHERE email = ? AND year = ?").get(email, year);
  const result = dbRun(() =>
    db.prepare("DELETE FROM student_team WHERE email = ? AND year = ?")
      .run(email, year)
  );
  if (!result.success) { logger.warn(req, "student_team.delete", { error: result.error }, email); return res.status(result.status).send(result.error); }
  if (result.result.changes === 0) return res.status(404).send("매핑을 찾을 수 없습니다.");
  logger.log(req, "student_team.delete", { year, team_num: mapping?.team_num }, email);
  res.status(200).send();
});

/* ============================================
   Year-level Admin API (연도별 관리)
   ============================================ */

// DELETE /api/admin/years/:year/files - 연도별 파일 데이터 삭제 (제출 기록 유지)
app.delete("/api/admin/years/:year/files", (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return res.status(400).send("올바르지 않은 연도입니다.");

  const sessions = db.prepare("SELECT id FROM session WHERE year = ?").all(year);
  if (sessions.length === 0) return res.status(404).send("해당 연도의 세션이 없습니다.");

  let fileCount = 0;
  const txResult = dbRun(() => {
    db.transaction(() => {
      for (const s of sessions) {
        const subs = db.prepare("SELECT id FROM submission WHERE session_id = ?").all(s.id);
        for (const sub of subs) {
          const deleted = db.prepare("DELETE FROM submission_file WHERE submission_id = ?").run(sub.id);
          fileCount += deleted.changes;
        }
      }
    })();
  });

  if (!txResult.success) {
    logger.warn(req, "year.purge_files", { error: txResult.error, year });
    return res.status(txResult.status).send(txResult.error);
  }

  // 트랜잭션 성공 후 디스크 파일 삭제
  for (const s of sessions) {
    rmDir(path.join(UPLOADS_DIR, String(s.id)));
  }

  logger.log(req, "year.purge_files", { year, sessions: sessions.length, files: fileCount });
  res.json({ sessions: sessions.length, files: fileCount });
});

// GET /api/admin/years/:year/archive - 연도별 전체 압축 다운로드
app.get("/api/admin/years/:year/archive", async (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return res.status(400).send("올바르지 않은 연도입니다.");

  const sessions = db.prepare("SELECT * FROM session WHERE year = ? ORDER BY end_at ASC").all(year);
  if (sessions.length === 0) return res.status(404).send("해당 연도의 세션이 없습니다.");

  // entry 서비스에서 팀 정보 조회 (실패 시 빈 객체 — graceful degradation)
  let entries = {};
  const entryServer = process.env.ENTRY_SERVER;
  if (entryServer) {
    try {
      const entryRes = await fetch(`${entryServer}/api/entries?year=${year}`, {
        headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
        signal: AbortSignal.timeout(5000),
      });
      if (entryRes.ok) entries = await entryRes.json();
      else logger.warn(req, "year.archive", { warning: "entry_fetch_non_ok", status: entryRes.status, year });
    } catch (e) {
      logger.warn(req, "year.archive", { warning: "entry_fetch_failed", error: e.message, year });
    }
  }

  // 각 세션의 최신 제출 + 파일 조회
  const archiveFiles = [];
  for (const s of sessions) {
    const subs = db.prepare(`
      SELECT sub.id, sub.team_num FROM submission sub
      INNER JOIN (
        SELECT session_id, team_num, MAX(id) AS max_id
        FROM submission WHERE session_id = ? GROUP BY session_id, team_num
      ) latest ON sub.id = latest.max_id
    `).all(s.id);

    for (const sub of subs) {
      const files = db.prepare("SELECT original_name, stored_name FROM submission_file WHERE submission_id = ?").all(sub.id);
      for (const f of files) {
        const diskPath = path.join(UPLOADS_DIR, String(s.id), String(sub.team_num), String(sub.id), f.stored_name);
        if (fs.existsSync(diskPath)) {
          const entry = entries[sub.team_num];
          const sessionName = sanitize(s.name);
          const teamFolder = entry
            ? sanitize(`${sub.team_num}_${entry.univ}_${entry.team}`)
            : String(sub.team_num);
          archiveFiles.push({ diskPath, zipPath: `${sessionName}/${teamFolder}/${f.original_name}` });
        }
      }
    }
  }

  if (archiveFiles.length === 0) return res.status(404).send("다운로드할 파일이 없습니다.");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`FSK_${year}_documents.zip`)}`);

  const archive = archiver("zip", { zlib: { level: 5 } });
  archive.on("error", (err) => {
    logger.warn(req, "year.archive", { error: err.message, year });
    if (!res.headersSent) res.status(500).send("압축 중 오류가 발생했습니다.");
  });
  archive.pipe(res);

  for (const f of archiveFiles) {
    archive.file(f.diskPath, { name: f.zipPath });
  }

  await archive.finalize();
  logger.log(req, "year.archive", { year, sessions: sessions.length, files: archiveFiles.length });
});

/* ============================================
   Internal API (서비스 간 통신)
   ============================================ */

// PATCH /api/internal/team-num - 엔트리 번호 변경 시 team_num 일괄 갱신
app.patch("/api/internal/team-num", (req, res) => {
  if (!requireInternalRequest(req, res)) return;

  const prevNum = Number(req.body.prevNum);
  const newNum = Number(req.body.newNum);
  const year = Number(req.body.year);
  if (!Number.isInteger(prevNum) || !Number.isInteger(newNum) || !Number.isInteger(year)) {
    return res.status(400).send("올바르지 않은 요청입니다.");
  }

  const sessions = db.prepare("SELECT id FROM session WHERE year = ?").all(year);
  const prevExists = db.prepare(`
    SELECT 1
    WHERE EXISTS (SELECT 1 FROM student_team WHERE team_num = ? AND year = ?)
       OR EXISTS (
         SELECT 1 FROM session_team
         WHERE team_num = ? AND session_id IN (SELECT id FROM session WHERE year = ?)
       )
       OR EXISTS (
         SELECT 1 FROM submission
         WHERE team_num = ? AND session_id IN (SELECT id FROM session WHERE year = ?)
       )
  `).get(prevNum, year, prevNum, year, prevNum, year);

  if (!prevExists) {
    logger.log(req, "team_num.update", { year, prevNum, newNum, noop: true });
    return res.status(200).send();
  }

  for (const s of sessions) {
    const oldDir = path.join(UPLOADS_DIR, String(s.id), String(prevNum));
    const newDir = path.join(UPLOADS_DIR, String(s.id), String(newNum));
    const staleTarget = db.prepare(`
      SELECT 1
      WHERE EXISTS (SELECT 1 FROM session_team WHERE session_id = ? AND team_num = ?)
         OR EXISTS (SELECT 1 FROM submission WHERE session_id = ? AND team_num = ?)
    `).get(s.id, newNum, s.id, newNum);
    if (staleTarget && fs.existsSync(oldDir) && fs.existsSync(newDir)) {
      rmDir(newDir);
    }
  }

  const txResult = dbRun(() => {
    db.transaction(() => {
      db.prepare("DELETE FROM submission WHERE team_num = ? AND session_id IN (SELECT id FROM session WHERE year = ?)")
        .run(newNum, year);
      db.prepare("DELETE FROM session_team WHERE team_num = ? AND session_id IN (SELECT id FROM session WHERE year = ?)")
        .run(newNum, year);
      db.prepare("DELETE FROM student_team WHERE team_num = ? AND year = ?")
        .run(newNum, year);
      db.prepare("UPDATE student_team SET team_num = ? WHERE team_num = ? AND year = ?")
        .run(newNum, prevNum, year);
      db.prepare("UPDATE session_team SET team_num = ? WHERE team_num = ? AND session_id IN (SELECT id FROM session WHERE year = ?)")
        .run(newNum, prevNum, year);
      db.prepare("UPDATE submission SET team_num = ? WHERE team_num = ? AND session_id IN (SELECT id FROM session WHERE year = ?)")
        .run(newNum, prevNum, year);
    })();
  });

  if (!txResult.success) { logger.warn(req, "team_num.update", { error: txResult.error, year, prevNum, newNum }); return res.status(txResult.status).send(txResult.error); }

  // 업로드 디렉토리 이름 변경
  const renamedDirs = [];
  const failedRenames = [];
  for (const s of sessions) {
    const oldDir = path.join(UPLOADS_DIR, String(s.id), String(prevNum));
    const newDir = path.join(UPLOADS_DIR, String(s.id), String(newNum));
    if (fs.existsSync(oldDir)) {
      try {
        fs.renameSync(oldDir, newDir);
        renamedDirs.push({ oldDir, newDir });
      } catch (e) {
        failedRenames.push({ sessionId: s.id, error: e.message });
      }
    }
  }

  if (failedRenames.length > 0) {
    // 성공한 rename 되돌리기
    for (const { oldDir, newDir } of renamedDirs) {
      try { fs.renameSync(newDir, oldDir); } catch (e) { logger.warn(req, "team_num.update", { error: e.message, phase: "rollback_rename", oldDir, newDir }); }
    }

    // DB 롤백: 원래 값으로 복원
    const rollbackResult = dbRun(() => {
      db.transaction(() => {
        db.prepare("UPDATE student_team SET team_num = ? WHERE team_num = ? AND year = ?")
          .run(prevNum, newNum, year);
        db.prepare("UPDATE session_team SET team_num = ? WHERE team_num = ? AND session_id IN (SELECT id FROM session WHERE year = ?)")
          .run(prevNum, newNum, year);
        db.prepare("UPDATE submission SET team_num = ? WHERE team_num = ? AND session_id IN (SELECT id FROM session WHERE year = ?)")
          .run(prevNum, newNum, year);
      })();
    });

    logger.warn(req, "team_num.rename_fail", { year, prevNum, newNum, failedRenames, rollback: rollbackResult.success });
    return res.status(500).send("업로드 디렉토리 이름 변경에 실패하여 롤백되었습니다.");
  }

  logger.log(req, "team_num.update", { year, prevNum, newNum });
  res.status(200).send();
});

/* ============================================
   Internal API: 엔트리 삭제 연동
   ============================================ */

// DELETE /api/internal/team/:num - 엔트리 삭제 시 관련 데이터 정리
app.delete("/api/internal/team/:num", (req, res) => {
  if (!requireInternalRequest(req, res)) return;

  const num = Number(req.params.num);
  const year = Number(req.query.year);
  if (!Number.isInteger(num) || num < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  if (!Number.isInteger(year)) return res.status(400).send("연도를 지정해야 합니다.");

  const removedFiles = [];
  const txResult = dbRun(() => {
    db.transaction(() => {
      db.prepare("DELETE FROM student_team WHERE team_num = ? AND year = ?").run(num, year);

      const sessions = db.prepare("SELECT id FROM session WHERE year = ?").all(year);
      for (const s of sessions) {
        db.prepare("DELETE FROM session_team WHERE session_id = ? AND team_num = ?").run(s.id, num);
        const subs = db.prepare("SELECT id FROM submission WHERE session_id = ? AND team_num = ?").all(s.id, num);
        for (const sub of subs) {
          db.prepare("DELETE FROM submission_file WHERE submission_id = ?").run(sub.id);
          db.prepare("DELETE FROM submission WHERE id = ?").run(sub.id);
          removedFiles.push({ sessionId: s.id, subId: sub.id });
        }
      }
    })();
  });

  if (!txResult.success) { logger.warn(req, "team.cascade_delete", { error: txResult.error, year }, "#" + num); return res.status(txResult.status).send(txResult.error); }

  for (const { sessionId, subId } of removedFiles) {
    rmDir(path.join(UPLOADS_DIR, String(sessionId), String(num), String(subId)));
  }

  logger.log(req, "team.cascade_delete", { year, removed: removedFiles.length }, "#" + num);
  res.status(200).send();
});

/* ============================================
   Email Notification
   ============================================ */
/* ============================================
   예약 알림 시스템
   ============================================ */

/** 세션에 대한 예약 알림 등록 (미전송 건만 삭제 후 재등록) */
function scheduleSessionNotifications(sessionId, start_at, end_at) {
  db.prepare("DELETE FROM scheduled_notification WHERE session_id = ? AND sent = 0").run(sessionId);

  const currentTime = now();
  const insert = db.prepare("INSERT INTO scheduled_notification (session_id, type, scheduled_at) VALUES (?, ?, ?)");

  // 제출 시작 알림: 이미 발송된 경우 재등록하지 않음
  const alreadySent = db.prepare("SELECT 1 FROM scheduled_notification WHERE session_id = ? AND type = 'session_open' AND sent = 1").get(sessionId);
  if (!alreadySent) {
    if (start_at > currentTime) {
      insert.run(sessionId, "session_open", start_at);
    } else {
      insert.run(sessionId, "session_open", currentTime);
    }
  }

  // 마감 3시간 전 알림
  const h3 = subtractHours(end_at, 3);
  if (h3 > currentTime) {
    insert.run(sessionId, "deadline_3h", h3);
  }

  // 마감 1시간 전 알림 (미제출 팀만)
  const h1 = subtractHours(end_at, 1);
  if (h1 > currentTime) {
    insert.run(sessionId, "deadline_1h", h1);
  }
}

/** 이메일 전송 공통 */
async function sendNotificationEmail(subject, htmlContent, recipient) {
  const emailServer = process.env.EMAIL_SERVER;
  if (!emailServer || !process.env.INTERNAL_SECRET) return { ok: false, error: "EMAIL_SERVER not configured" };

  const resp = await fetch(`${emailServer}/api/internal/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Service": process.env.INTERNAL_SECRET },
    body: JSON.stringify({ subject, htmlContent, recipients: [recipient], source: "documents" }),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) return { ok: false, error: await resp.text() };
  return { ok: true };
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 엔트리 정보 조회 */
async function fetchEntries(year) {
  const entryServer = process.env.ENTRY_SERVER;
  if (!entryServer) return {};
  try {
    const res = await fetch(`${entryServer}/api/entries?year=${year}`, {
      headers: { "X-Internal-Service": process.env.INTERNAL_SECRET },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return await res.json();
    else logger.warn(null, "entry.fetch", { warning: "non_ok", status: res.status, year });
  } catch (e) {
    logger.warn(null, "entry.fetch", { error: e.message, year });
  }
  return {};
}

/** 팀 정보 헤더 HTML */
function teamHeaderHtml(teamNum, entries) {
  const entry = entries[teamNum];
  const label = entry ? `#${teamNum} ${escapeHtml(entry.univ)} ${escapeHtml(entry.team)}` : `#${teamNum}`;
  return `<p style="margin:0 0 12px;font-size:15px;font-weight:bold;font-style:italic;color:#333">${label}</p>`;
}

/** 예약 알림 처리 — 1분마다 실행 */
async function processScheduledNotifications() {
  const currentTime = now();
  const pending = db.prepare(
    "SELECT sn.*, s.name, s.notice, s.start_at, s.end_at, s.late_end_at, s.year FROM scheduled_notification sn JOIN session s ON sn.session_id = s.id WHERE sn.sent = 0 AND sn.scheduled_at <= ?",
  ).all(currentTime);

  for (const n of pending) {
    try {
      const url = process.env.PUBLIC_URL || "https://fsk.luftaquila.io";
      const deadlineInfo = n.late_end_at
        ? `제출 마감: ${toKST(n.end_at)} (KST)<br>지각 마감: ${toKST(n.late_end_at)} (KST)`
        : `제출 마감: ${toKST(n.end_at)} (KST)`;

      // 수신자 결정 (team_num 포함)
      let recipientRows;
      if (n.type === "deadline_1h") {
        // 미제출 팀 학생만
        recipientRows = db.prepare(
          `SELECT st2.email, st.team_num FROM session_team st
           JOIN student_team st2 ON st.team_num = st2.team_num AND st2.year = ?
           WHERE st.session_id = ?
             AND st.team_num NOT IN (SELECT team_num FROM submission WHERE session_id = ?)`,
        ).all(n.year, n.session_id, n.session_id);
      } else {
        // 전체 대상 팀 학생
        recipientRows = db.prepare(
          `SELECT st2.email, st.team_num FROM session_team st
           JOIN student_team st2 ON st.team_num = st2.team_num AND st2.year = ?
           WHERE st.session_id = ?`,
        ).all(n.year, n.session_id);
      }

      if (recipientRows.length === 0) {
        db.prepare("UPDATE scheduled_notification SET sent = 1 WHERE id = ?").run(n.id);
        continue;
      }

      // 엔트리 정보 조회
      const entries = await fetchEntries(n.year);

      let subject;
      const safeName = escapeHtml(n.name);

      if (n.type === "session_open") subject = `[FSK] 서류 제출 안내: ${n.name}`;
      else if (n.type === "deadline_3h") subject = `[FSK] 서류 제출 마감 3시간 전: ${n.name}`;
      else if (n.type === "deadline_1h") subject = `[FSK] 서류 미제출 알림: ${n.name}`;

      // 수신자별 개별 발송
      let sentCount = 0;
      for (const { email, team_num } of recipientRows) {
        const teamHeader = teamHeaderHtml(team_num, entries);
        let htmlContent;

        if (n.type === "session_open") {
          const noticeHtml = n.notice ? escapeHtml(n.notice).replace(/\n/g, "<br>") : "";
          htmlContent =
            `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea 서류 제출 안내</h2>` +
            teamHeader +
            (noticeHtml ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${noticeHtml}</p>` : "") +
            `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">제출 시작: ${toKST(n.start_at)} (KST)</p>` +
            `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${deadlineInfo}</p>` +
            `<p style="margin:0;font-size:14px"><a href="${url}/documents">서류 제출 바로가기</a></p>`;
        } else if (n.type === "deadline_3h") {
          htmlContent =
            `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea 서류 제출 마감 안내</h2>` +
            teamHeader +
            `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${safeName} 서류 제출 마감이 3시간 남았습니다.</p>` +
            `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${deadlineInfo}</p>` +
            `<p style="margin:0 0 8px;font-size:14px"><a href="${url}/documents">서류 제출 바로가기</a></p>` +
            `<p style="margin:0;font-size:12px;color:#888">본 메일은 서류 제출 여부와 관계없이 발송되는 마감 안내 메일입니다.</p>`;
        } else if (n.type === "deadline_1h") {
          htmlContent =
            `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea 서류 미제출 알림</h2>` +
            teamHeader +
            `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${safeName} 서류가 아직 제출되지 않았습니다. 마감까지 1시간 남았습니다.</p>` +
            `<p style="margin:0 0 8px;font-size:14px;line-height:1.6">${deadlineInfo}</p>` +
            `<p style="margin:0;font-size:14px"><a href="${url}/documents">서류 제출 바로가기</a></p>`;
        }

        const result = await sendNotificationEmail(subject, htmlContent, email);
        if (result.ok) sentCount++;
      }

      if (sentCount > 0) {
        db.prepare("UPDATE scheduled_notification SET sent = 1 WHERE id = ?").run(n.id);
        logger.log(null, `schedule.${n.type}`, { recipientCount: sentCount }, n.name);
      } else {
        logger.warn(null, `schedule.${n.type}`, { error: "all_sends_failed", recipientCount: recipientRows.length }, n.name);
      }
    } catch (e) {
      logger.warn(null, `schedule.${n.type}`, { error: e.message }, n.name);
    }
  }
}

// 1분마다 예약 알림 처리
const _schedulerInterval = setInterval(processScheduledNotifications, 60_000);
// 서버 시작 후 5초 뒤 첫 실행 (밀린 알림 즉시 처리)
setTimeout(processScheduledNotifications, 5000);

/** 계정 할당 시 현재 열린 세션 알림 */
async function notifyOpenSessions(req, email, teamNum, year) {
  const emailServer = process.env.EMAIL_SERVER;
  if (!emailServer || !process.env.INTERNAL_SECRET) return;

  try {
    const currentTime = now();
    const openSessions = db.prepare(
      `SELECT s.id, s.name, s.end_at, s.late_end_at FROM session s
       JOIN session_team st ON s.id = st.session_id
       WHERE st.team_num = ? AND s.year = ? AND s.start_at <= ? AND COALESCE(NULLIF(s.late_end_at, ''), s.end_at) > ?
         AND s.id NOT IN (SELECT session_id FROM submission WHERE team_num = ?)
       ORDER BY COALESCE(NULLIF(s.late_end_at, ''), s.end_at) ASC`
    ).all(teamNum, year, currentTime, currentTime, teamNum);

    if (openSessions.length === 0) return;

    const entries = await fetchEntries(year);
    const teamHeader = teamHeaderHtml(teamNum, entries);

    const url = process.env.PUBLIC_URL || "https://fsk.luftaquila.io";
    const sessionList = openSessions.map((s) => {
      const safeName = escapeHtml(s.name);
      const deadlines = s.late_end_at
        ? `<li>제출 마감: ${toKST(s.end_at)} (KST)</li><li>지각 마감: ${toKST(s.late_end_at)} (KST)</li>`
        : `<li>제출 마감: ${toKST(s.end_at)} (KST)</li>`;
      return `<li><strong>${safeName}</strong><ul style="margin:4px 0 0;padding-left:20px">${deadlines}</ul></li>`;
    }).join("");

    const result = await sendNotificationEmail(
      `[FSK] 제출 대기 중인 서류가 있습니다`,
      `<h2 style="margin:0 0 16px;font-size:20px">Formula Student Korea 서류 제출 안내</h2>` +
        teamHeader +
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">현재 제출 대기 중인 서류 세션이 있습니다.</p>` +
        `<ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.8">${sessionList}</ul>` +
        `<p style="margin:0;font-size:14px"><a href="${url}/documents">서류 제출 바로가기</a></p>`,
      email,
    );

    if (!result.ok) logger.warn(req, "student_team.notify", { error: result.error }, email);
    else logger.log(req, "student_team.notify", { sessionCount: openSessions.length }, email);
  } catch (e) {
    logger.warn(req, "student_team.notify", { error: e.message }, email);
  }
}

/* ============================================
   SPA Fallback
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db, _schedulerInterval };
}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createDocumentsApp();
  setupProcessHandlers(db);
  app.listen(9700);
}
