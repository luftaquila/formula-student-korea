import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { addColumn, runMigrationOnce, normalizeTimestampColumn, parseLegacyTimestamp } from "../shared/db-setup.mjs";
import Busboy from "busboy";
import archiver from "archiver";
import { createServiceSkeleton, addSpaFallback } from "../shared/service-bootstrap.mjs";
import { validateYear } from "../shared/validation.mjs";
import { parseDbTimestamp } from "../shared/parse-timestamp.js";
import { serviceUrl } from "../shared/services.mjs";
import { currentCompetitionYear } from "../shared/competition-year.mjs";

export function createDocumentsApp(options = {}) {

const enableNotificationScheduler = options.enableNotificationScheduler !== false;
const notificationTasks = new Set();
const removeDirectory = options.removeDirectory || ((dir) => fs.rmSync(dir, { recursive: true, force: true }));

const { app, db, logger, dbRun } = createServiceSkeleton({
  name: "documents", express, Database, options,
  authRoleFn: (req) => {
    if (req.path === "/api/health") return null;
    if (req.path.startsWith("/api/internal/")) return "admin";
    if (req.path.startsWith("/api/admin")) return "chief";
    if (req.path === "/api/logs") return "admin";
    if (req.path.startsWith("/api/")) return "student";
    if (req.path.startsWith("/admin")) return "chief";
    return "student";
  },
});
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
  const yearCol = info.find(c => c.name === "year");
  if (emailCol && emailCol.pk === 1 && (!yearCol || yearCol.pk !== 2)) {
    // 기존 스키마: email이 단독 PK → (email, year) 복합 PK로 마이그레이션
    db.transaction(() => {
      db.exec(`CREATE TABLE student_team_new (
        email TEXT NOT NULL,
        team_num INTEGER NOT NULL,
        year INTEGER NOT NULL,
        PRIMARY KEY (email, year),
        UNIQUE(team_num, year)
      )`);
      db.exec("INSERT OR IGNORE INTO student_team_new (email, team_num, year) SELECT email, team_num, year FROM student_team");
      db.exec("DROP TABLE student_team");
      db.exec("ALTER TABLE student_team_new RENAME TO student_team");
    })();
  }
}
addColumn(db, "student_team", "team_id INTEGER");

db.exec(`CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notice TEXT DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  late_end_at TEXT NOT NULL,
  max_file_size INTEGER NOT NULL DEFAULT 52428800,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  year INTEGER NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_session_year ON session(year)");

db.exec(`CREATE TABLE IF NOT EXISTS session_team (
  session_id INTEGER NOT NULL,
  team_num INTEGER NOT NULL,
  PRIMARY KEY (session_id, team_num),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
)`);
addColumn(db, "session_team", "team_id INTEGER");

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

// idx_sub_session_team_id(session_id, team_num, id DESC)가 (session_id, team_num) 조회도
// 커버하므로 prefix 인덱스 idx_sub_session_team은 제거(기존 배포본 정리 포함).
db.exec("DROP INDEX IF EXISTS idx_sub_session_team");
db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_session_team_id
  ON submission(session_id, team_num, id DESC)`);

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
addColumn(db, "submission_file", "text_charset TEXT DEFAULT ''");

// 마이그레이션: allowed_extensions 컬럼 추가
addColumn(db, "session", "allowed_extensions TEXT DEFAULT ''");

// 마이그레이션: started_at 컬럼 추가 (업로드 시작 시간)
addColumn(db, "submission", "started_at TEXT DEFAULT ''");
// Competition stores a stable, team-ID-based relative directory here. The
// one-shot migrator populates this for imported rows before runtime starts.
addColumn(db, "submission", "storage_dir TEXT");

// 마이그레이션: attempt_no 컬럼 추가 (제출 시도 누적 번호 — retention과 무관하게 유지)
addColumn(db, "submission", "attempt_no INTEGER NOT NULL DEFAULT 0");
addColumn(db, "submission", "team_id INTEGER");
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
// 부분 발송 재시도용: 성공적으로 보낸 수신자 이메일(JSON 배열). 다음 tick에서 이 목록을
// 스킵해 실패 수신자만 재시도하고 이미 보낸 수신자에겐 중복 발송하지 않는다.
addColumn(db, "scheduled_notification", "sent_recipients TEXT DEFAULT '[]'");
// 부분 발송 재시도 횟수. 영구 실패(무효/바운스 주소 등)로 remaining이 계속 남으면 상한 도달 후
// sent=1로 종료해 매 tick 무한 재시도 + partial_send warn firehose를 막는다.
addColumn(db, "scheduled_notification", "attempts INTEGER NOT NULL DEFAULT 0");

// 업로드 디렉토리 생성
const UPLOADS_DIR = path.resolve(options.uploadsDir || "./data/uploads");
let UPLOADS_REAL_DIR = null;
let TMP_DIR = null;

cleanupManagedUploads();

// Documents에서는 엔트리 활성 상태와 무관하게 계정 할당과 제출을 허용한다.
// 학생에게는 자신의 매핑 팀만, chief에게는 관리에 필요한 전체 목록만 반환한다.
// 두 경로 모두 브라우저가 Entry의 관리자 전용 includeInactive API를 직접 호출하지
// 않도록 Documents가 내부 서비스 자격으로 조회한다.
app.get("/api/entries", async (req, res) => {
  const yearCheck = validateYear(req.query.year || currentCompetitionYear());
  if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
  const mapping = db.prepare("SELECT team_num FROM student_team WHERE email = ? AND year = ?")
    .get(req.user.email, yearCheck.value);
  if (!mapping) return res.json({});

  const entries = await fetchEntries(yearCheck.value, req, "entry.student_lookup");
  const entry = entries[mapping.team_num];
  res.json(entry ? { [mapping.team_num]: entry } : {});
});

app.get("/api/admin/entries", async (req, res) => {
  const yearCheck = validateYear(req.query.year || currentCompetitionYear());
  if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
  res.json(await fetchEntries(yearCheck.value, req, "entry.admin_list"));
});

/* ============================================
   헬퍼
   ============================================ */
function now() {
  return new Date().toISOString();
}

/** "YYYY-MM-DD HH:MM" 또는 ISO-like 입력 → UTC ISO(zone 없으면 UTC로 해석). 실패 시 null */
const normalizeTimestamp = (str) => parseLegacyTimestamp(str);

/** UTC DB date string → KST display "YYYY-MM-DD HH:MM" */
function toKST(utcStr) {
  if (!utcStr) return "";
  const d = parseDbTimestamp(utcStr);
  if (!d) return "";
  d.setHours(d.getHours() + 9);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

/** Subtract hours from UTC date string → UTC date string */
function subtractHours(utcStr, hours) {
  const d = parseDbTimestamp(utcStr);
  if (!d) return "";
  d.setHours(d.getHours() - hours);
  return d.toISOString();
}

runMigrationOnce(db, "documents.utc_timestamp_normalization.v1", () => {
  for (const [table, column] of [
    ["session", "start_at"],
    ["session", "end_at"],
    ["session", "late_end_at"],
    ["session", "created_at"],
    ["submission", "started_at"],
    ["submission", "submitted_at"],
    ["scheduled_notification", "scheduled_at"],
  ]) {
    normalizeTimestampColumn(db, table, column, normalizeTimestamp);
  }
});

function safeExt(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

// zip 엔트리/아카이브 폴더명에서 경로 구분자·금지 문자를 "_"로 치환.
function sanitize(s) {
  return s.replace(/[/\\:*?"<>|]/g, "_");
}

function rmDir(dir, { logFailure = true } = {}) {
  try {
    removeDirectory(dir);
    return { removed: true, error: null };
  } catch (err) {
    if (logFailure) logger.warn(null, "file.cleanup", { error: err.message, dir });
    return { removed: false, error: err.message || String(err) };
  }
}

function auditedLookup(req, res, { action, target, phase, lookup, message }) {
  const result = dbRun(lookup);
  if (!result.success) {
    const error = result.internalError || result.error;
    logger.warn(req, action, { error, reason: error, phase }, target);
    res.status(500).send(message);
    return { ok: false, value: null };
  }
  return { ok: true, value: result.result };
}

function logCleanupFailures(req, action, target, context, cleanup) {
  const failed = cleanup.filter((item) => !item.removed);
  if (failed.length === 0) return;
  logger.warn(req, action, {
    error: "partial_file_cleanup",
    reason: "partial_file_cleanup",
    ...context,
    failed_cleanup: failed,
  }, target);
}

function teamUploadDir(sessionId, teamNum) {
  return path.join(UPLOADS_DIR, String(sessionId), String(teamNum));
}

function submissionRelativeDir(submission) {
  const storageDir = submission?.storage_dir;
  if (typeof storageDir !== "string" || !storageDir.trim()) {
    throw new Error(`submission ${submission?.id ?? "?"} has no canonical storage directory`);
  }
  if (path.isAbsolute(storageDir)) {
    throw new Error(`submission ${submission?.id ?? "?"} has an absolute storage directory`);
  }
  return storageDir;
}

function submissionUploadDir(submission) {
  const root = UPLOADS_REAL_DIR;
  if (!root) throw new Error("managed uploads directory is not initialized");
  const target = path.resolve(root, submissionRelativeDir(submission));
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("submission storage path escapes the uploads directory");
  }
  return target;
}

function submissionFilePath(submission, storedName) {
  if (typeof storedName !== "string" || !storedName || path.basename(storedName) !== storedName) {
    throw new Error(`submission_file has an invalid stored name: ${String(storedName)}`);
  }
  const directory = submissionUploadDir(submission);
  const target = path.resolve(directory, storedName);
  if (!target.startsWith(`${directory}${path.sep}`)) {
    throw new Error("submission file path escapes its storage directory");
  }
  return target;
}

function assertExistingPathComponentsAreNotSymlinks(target) {
  const parsed = path.parse(target);
  let cursor = parsed.root;
  const components = path.relative(parsed.root, target).split(path.sep).filter(Boolean);
  for (const component of components) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`uploads directory path contains a symbolic link: ${cursor}`);
    }
  }
}

function cleanupManagedUploads() {
  const configuredRoot = path.resolve(UPLOADS_DIR);
  let root = configuredRoot;
  const referencedRows = db.prepare(`
    SELECT s.id, s.session_id, s.team_num, s.storage_dir, f.stored_name
    FROM submission_file f JOIN submission s ON s.id = f.submission_id
  `).all();
  const submissions = db.prepare("SELECT id, storage_dir FROM submission").all();
  const referenced = new Set();
  const deleted = [];
  try {
    assertExistingPathComponentsAreNotSymlinks(configuredRoot);
    if (!fs.existsSync(configuredRoot)) fs.mkdirSync(configuredRoot, { recursive: true });
    assertExistingPathComponentsAreNotSymlinks(configuredRoot);
    const configuredStat = fs.lstatSync(configuredRoot);
    if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
      throw new Error("uploads directory must be a real directory, not a symbolic link");
    }
    root = fs.realpathSync.native(configuredRoot);
    if (root === path.parse(root).root) throw new Error("filesystem root cannot be used as the uploads directory");
    UPLOADS_REAL_DIR = root;
    for (const submission of submissions) submissionUploadDir(submission);
    TMP_DIR = path.join(root, "_tmp");
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const file of referencedRows) {
      const target = submissionFilePath(file, file.stored_name);
      const relative = path.relative(root, target);
      let cursor = root;
      let stat;
      for (const component of relative.split(path.sep)) {
        cursor = path.join(cursor, component);
        stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) {
          throw new Error(`referenced upload path contains a symbolic link: ${relative}`);
        }
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`referenced upload is not a regular file: ${relative}`);
      }
      referenced.add(target);
    }
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (target === TMP_DIR) {
          for (const temp of fs.readdirSync(target)) deleted.push(path.relative(root, path.join(target, temp)));
          fs.rmSync(target, { recursive: true, force: true });
          fs.mkdirSync(target, { recursive: true });
        } else if (entry.isDirectory()) {
          walk(target);
          if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
        } else if (!entry.isFile() || !referenced.has(path.resolve(target))) {
          fs.rmSync(target, { recursive: true, force: true });
          deleted.push(path.relative(root, target));
        }
      }
    };
    walk(root);
    logger.log(null, "file.startup_cleanup", {
      uploadRoot: root,
      referencedFiles: referenced.size,
      deletedCount: deleted.length,
      deleted,
    });
  } catch (error) {
    logger.warn(null, "file.startup_cleanup", {
      error: error.message || String(error), uploadRoot: root, deletedCount: deleted.length, deleted,
    });
    throw new Error(`managed upload cleanup failed: ${error.message || error}`);
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
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
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

// BOM이 있으면 해당 인코딩을 따르고, BOM이 없으면 UTF-8을 엄격하게 검증한다.
// UTF-8과 CP949로 모두 해석 가능한 바이트열은 구분할 수 없으므로 UTF-8을 우선한다.
function createTextCharsetDetector() {
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  let prefix = Buffer.alloc(0);
  let started = false;
  let settledCharset = "";

  function decodeUtf8(bytes) {
    if (settledCharset) return settledCharset;
    try { utf8Decoder.decode(bytes, { stream: true }); }
    catch { settledCharset = "euc-kr"; }
    return settledCharset;
  }

  function start(bytes) {
    started = true;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) settledCharset = "utf-16le";
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) settledCharset = "utf-16be";
    else decodeUtf8(bytes);
    return settledCharset;
  }

  return {
    write(chunk) {
      if (settledCharset) return settledCharset;
      if (started) return decodeUtf8(chunk);
      const bytes = prefix.length > 0 ? Buffer.concat([prefix, chunk]) : chunk;
      if (bytes.length < 2) {
        prefix = Buffer.from(bytes);
        return "";
      }
      prefix = Buffer.alloc(0);
      return start(bytes);
    },
    finish() {
      if (!started) start(prefix);
      if (settledCharset) return settledCharset;
      try { utf8Decoder.decode(); }
      catch { return "euc-kr"; }
      return "utf-8";
    },
  };
}

async function detectTextCharset(filePath) {
  const detector = createTextCharsetDetector();
  for await (const chunk of fs.createReadStream(filePath)) {
    const charset = detector.write(chunk);
    if (charset) return charset;
  }
  return detector.finish();
}

// 신규 업로드는 판별 결과를 DB에 저장한다. 기존 파일은 최초 열람 때 비동기로 한 번만
// 판별하고 저장하며, 동시에 들어온 Range 요청은 같은 Promise를 공유한다.
const textCharsetPromises = new Map();
async function getTextCharset(file, filePath) {
  if (["utf-8", "euc-kr", "utf-16le", "utf-16be"].includes(file.text_charset)) return file.text_charset;
  if (!textCharsetPromises.has(file.id)) {
    const pending = detectTextCharset(filePath)
      .then((charset) => {
        try {
          db.prepare("UPDATE submission_file SET text_charset = ? WHERE id = ?").run(charset, file.id);
        } catch (e) {
          logger.warn(null, "file.charset_cache", { error: e.message, file_id: file.id });
        }
        return charset;
      })
      .catch(() => "utf-8");
    textCharsetPromises.set(file.id, pending);
    pending.finally(() => {
      if (textCharsetPromises.get(file.id) === pending) textCharsetPromises.delete(file.id);
    });
  }
  return textCharsetPromises.get(file.id);
}

async function setFileResponseHeaders(res, file, filePath) {
  const inlineType = inlineDisposition(file.original_name, file.mime_type);
  const encoded = encodeURIComponent(file.original_name);
  // Caddy가 전역으로 nosniff를 붙이지만, 프록시 없이 직접 접속하는 경로(dev 등)도 방어
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (inlineType) {
    const contentType = inlineType.startsWith("text/")
      ? `${inlineType}; charset=${await getTextCharset(file, filePath)}`
      : inlineType;
    res.setHeader("Content-Type", contentType);
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
  let team;
  if (req.query.year !== undefined) {
    const yearCheck = validateYear(req.query.year);
    if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
    team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? AND year = ?")
      .get(req.user.email, yearCheck.value);
  } else {
    team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? ORDER BY year DESC LIMIT 1")
      .get(req.user.email);
  }
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
  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(Number(req.params.id));
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  // cross-year IDOR 방지: 세션 연도의 팀 매핑으로 해석한다(팀 번호는 연도별 재할당되므로
  // 같은 번호를 쓰는 타 연도=다른 대학 팀의 세션을 순회 접근할 수 없다).
  const team = db.prepare("SELECT * FROM student_team WHERE email = ? AND year = ?").get(req.user.email, session.year);
  if (!team) { logger.warn(req, "session.view", { error: "no_team_for_year", session_id: session.id, year: session.year }, session.name); return res.status(403).send("대상 팀이 아닙니다."); }
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
  const sessionId = Number(req.params.id);
  const preflight = auditedLookup(req, res, {
    action: "submission.create",
    target: `session:${sessionId}`,
    phase: "submission_preflight",
    message: "제출 대상을 확인할 수 없습니다.",
    lookup: () => {
      const session = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId);
      if (!session) return { session: null, team: null, isTarget: false };
      const team = db.prepare("SELECT * FROM student_team WHERE email = ? AND year = ?").get(req.user.email, session.year);
      const isTarget = team
        ? !!db.prepare("SELECT 1 FROM session_team WHERE session_id = ? AND team_num = ?").get(session.id, team.team_num)
        : false;
      return { session, team, isTarget };
    },
  });
  if (!preflight.ok) return;
  const { session, team, isTarget } = preflight.value;
  if (!session) {
    logger.warn(req, "submission.create", {
      error: "session_not_found", reason: "session_not_found", phase: "submission_preflight", session_id: sessionId,
    }, `session:${sessionId}`);
    return res.status(404).send("세션을 찾을 수 없습니다.");
  }

  // cross-year IDOR 방지: 팀 번호는 연도별로 재할당되므로 세션 연도의 팀 매핑으로 해석한다.
  // 세션 연도에 매핑이 없으면(다른 연도 매핑만 있어도) 이 세션 대상이 아니다 — 이렇게 하면
  // 학생이 최신 연도 매핑을 가져도 과거 세션에 정상 제출할 수 있고, 타 연도 팀의 세션 접근은 막힌다.
  if (!team) { logger.warn(req, "submission.create", { error: "no_team_for_year", session_id: session.id, year: session.year }, session.name); return res.status(403).send("대상 팀이 아닙니다."); }
  if (!isTarget) { logger.warn(req, "submission.create", { error: "not_target", session_id: session.id }, session.name); return res.status(403).send("대상 팀이 아닙니다."); }
  let canonicalTeam;
  try {
    const storedTeamId = Number(team.team_id);
    canonicalTeam = Number.isInteger(storedTeamId) && storedTeamId > 0
      ? options.teamStore?.getById?.(storedTeamId)
      : null;
    canonicalTeam ||= options.teamStore?.getByNumber?.(
      session.year,
      team.team_num,
      { includeInactive: true },
    );
  } catch (error) {
    logger.warn(req, "submission.create", {
      error: error?.message || String(error),
      phase: "canonical_team_lookup",
      session_id: session.id,
      year: session.year,
      team_num: team.team_num,
    }, session.name);
    return res.status(500).send("팀 기준 정보를 확인할 수 없습니다.");
  }
  const canonicalTeamId = Number(canonicalTeam?.id);
  const canonicalTeamYear = Number(canonicalTeam?.year ?? session.year);
  const canonicalTeamNum = Number(canonicalTeam?.number ?? canonicalTeam?.num ?? team.team_num);
  const canonicalTeamActive = canonicalTeam?.active == null ? null : !!canonicalTeam.active;
  if (!Number.isInteger(canonicalTeamId) || canonicalTeamId < 1
      || canonicalTeamYear !== session.year || canonicalTeamNum !== team.team_num) {
    logger.warn(req, "submission.create", {
      error: "missing_canonical_team_id", session_id: session.id, year: session.year, team_num: team.team_num,
    }, session.name);
    return res.status(409).send("팀 기준 정보를 찾을 수 없습니다.");
  }

  const startTime = now();
  const effectiveLateEnd = session.late_end_at || session.end_at;
  if (startTime < session.start_at) {
    logger.warn(req, "submission.create", {
      error: "submission_not_open",
      reason: "submission_not_open",
      phase: "submission_window",
      session_id: session.id,
      year: session.year,
      team_num: team.team_num,
      started_at: startTime,
      opens_at: session.start_at,
    }, session.name);
    return res.status(400).send("제출 기간이 아닙니다.");
  }
  if (startTime > effectiveLateEnd) {
    logger.warn(req, "submission.create", {
      error: "submission_closed",
      reason: "submission_closed",
      phase: "submission_window",
      session_id: session.id,
      year: session.year,
      team_num: team.team_num,
      started_at: startTime,
      closes_at: effectiveLateEnd,
    }, session.name);
    return res.status(400).send("제출 기간이 종료되었습니다.");
  }

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      limits: { files: 100, fileSize: session.max_file_size },
    });
  } catch (error) {
    logger.warn(req, "submission.create", {
      error: error?.message || String(error),
      phase: "multipart_init",
      session_id: session.id,
      year: session.year,
      team_num: team.team_num,
    }, session.name);
    return res.status(400).send("올바른 multipart 업로드 요청이 아닙니다.");
  }

  const uploadId = crypto.randomUUID();
  const tmpDir = path.join(TMP_DIR, uploadId);
  fs.mkdirSync(tmpDir, { recursive: true });

  const filesInfo = [];
  const filePromises = [];
  let totalSize = 0;
  let aborted = false;

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
    const inlineType = inlineDisposition(info.filename, info.mimeType);
    const charsetDetector = inlineType?.startsWith("text/") ? createTextCharsetDetector() : null;
    let fileSize = 0;

    const done = new Promise((resolve, reject) => {
      ws.on("finish", () => {
        if (!aborted) {
          filesInfo.push({
            original_name: info.filename,
            stored_name: storedName,
            size: fileSize,
            mime_type: info.mimeType || "",
            text_charset: charsetDetector?.finish() || "",
          });
        }
        resolve();
      });
      ws.on("error", (err) => aborted ? resolve() : reject(err));
    });
    filePromises.push(done);

    fileStream.on("data", (chunk) => {
      charsetDetector?.write(chunk);
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

    let movedFinalDir = null;
    let fileMoveError = null;
    try {
      options.beforeSubmissionMetadataCommit?.({
        sessionId: session.id,
        teamId: canonicalTeamId,
        teamNum: team.team_num,
      });
    } catch (error) {
      rmDir(tmpDir);
      logger.warn(req, "submission.create", {
        error: error?.message || String(error),
        phase: "metadata_revalidation_hook",
        session_id: session.id,
        year: session.year,
        team_id: canonicalTeamId,
        team_num: team.team_num,
      }, session.name);
      return res.status(500).send("제출 정보를 확인하는 도중 오류가 발생했습니다.");
    }
    const txResult = dbRun(() => {
      const tx = db.transaction(() => {
        // Multipart streaming can take long enough for an administrator to
        // change the session or team assignment. Revalidate every authority
        // input in the same transaction that persists metadata.
        const currentSession = db.prepare("SELECT * FROM session WHERE id = ?").get(session.id);
        const currentMapping = currentSession
          ? db.prepare("SELECT * FROM student_team WHERE email = ? AND year = ?")
            .get(req.user.email, currentSession.year)
          : null;
        let currentCanonical = null;
        let currentMappingTeamId = Number(currentMapping?.team_id);
        if (currentSession && currentMapping) {
          currentCanonical = options.teamStore?.getById?.(canonicalTeamId) || null;
          if (!Number.isInteger(currentMappingTeamId) || currentMappingTeamId < 1) {
            const mappedCanonical = options.teamStore?.getByNumber?.(
              currentSession.year,
              currentMapping.team_num,
              { includeInactive: true },
            );
            currentMappingTeamId = Number(mappedCanonical?.id);
            currentCanonical ||= mappedCanonical;
          }
        }
        const currentCanonicalSnapshot = currentCanonical ? {
          id: Number(currentCanonical.id),
          year: Number(currentCanonical.year ?? currentSession?.year),
          team_num: Number(currentCanonical.number ?? currentCanonical.num ?? currentMapping?.team_num),
          active: currentCanonical.active == null ? null : !!currentCanonical.active,
        } : null;
        const currentTarget = currentSession ? db.prepare(`
          SELECT team_num, team_id FROM session_team
          WHERE session_id = ?
            AND (team_id = ? OR (team_id IS NULL AND team_num = ?))
          LIMIT 1
        `).get(session.id, canonicalTeamId, team.team_num) : null;
        let currentTargetTeamId = Number(currentTarget?.team_id);
        if (currentSession && currentTarget
            && (!Number.isInteger(currentTargetTeamId) || currentTargetTeamId < 1)) {
          if (currentCanonicalSnapshot?.year === currentSession.year
              && currentCanonicalSnapshot.team_num === currentTarget.team_num) {
            currentTargetTeamId = currentCanonicalSnapshot.id;
          } else {
            const targetCanonical = options.teamStore?.getByNumber?.(
              currentSession.year,
              currentTarget.team_num,
              { includeInactive: true },
            );
            currentTargetTeamId = Number(targetCanonical?.id);
          }
        }
        const currentEffectiveLateEnd = currentSession
          ? (currentSession.late_end_at || currentSession.end_at)
          : null;
        const expected = {
          session: {
            id: session.id,
            year: session.year,
            start_at: session.start_at,
            end_at: session.end_at,
            late_end_at: session.late_end_at,
          },
          mapping: { team_id: canonicalTeamId, team_num: team.team_num },
          canonical_team: {
            id: canonicalTeamId,
            year: canonicalTeamYear,
            team_num: canonicalTeamNum,
            active: canonicalTeamActive,
          },
          target: { team_id: canonicalTeamId, team_num: team.team_num },
        };
        const current = {
          session: currentSession ? {
            id: currentSession.id,
            year: currentSession.year,
            start_at: currentSession.start_at,
            end_at: currentSession.end_at,
            late_end_at: currentSession.late_end_at,
          } : null,
          mapping: currentMapping ? {
            team_id: Number.isInteger(currentMappingTeamId) ? currentMappingTeamId : null,
            team_num: currentMapping.team_num,
          } : null,
          canonical_team: currentCanonicalSnapshot,
          target: currentTarget ? {
            team_id: Number.isInteger(currentTargetTeamId) ? currentTargetTeamId : null,
            team_num: currentTarget.team_num,
          } : null,
        };
        const stale = !currentSession
          || currentSession.year !== session.year
          || currentSession.start_at !== session.start_at
          || currentSession.end_at !== session.end_at
          || currentSession.late_end_at !== session.late_end_at
          || !currentMapping
          || currentMapping.team_num !== team.team_num
          || currentMappingTeamId !== canonicalTeamId
          || !currentCanonicalSnapshot
          || currentCanonicalSnapshot.id !== canonicalTeamId
          || currentCanonicalSnapshot.year !== canonicalTeamYear
          || currentCanonicalSnapshot.team_num !== canonicalTeamNum
          || currentCanonicalSnapshot.active !== canonicalTeamActive
          || !currentTarget
          || currentTarget.team_num !== team.team_num
          || currentTargetTeamId !== canonicalTeamId
          || submittedTime < currentSession?.start_at
          || submittedTime > currentEffectiveLateEnd;
        if (stale) {
          return {
            rejected: true,
            status: 409,
            message: "제출 대상 또는 기간이 변경되었습니다. 다시 시도하세요.",
            audit: {
              error: "stale_submission_preflight",
              reason: "stale_submission_preflight",
              phase: "metadata_revalidation",
              session_id: session.id,
              year: session.year,
              team_id: canonicalTeamId,
              team_num: team.team_num,
              started_at: startTime,
              submitted_at: submittedTime,
              expected,
              current,
            },
          };
        }

        // attempt_no는 같은 (session, team)의 누적 최대치 + 1. retention으로 삭제되어도 최신 row가 살아남으므로 단조 증가.
        const prevAttempt = db.prepare(
          "SELECT MAX(attempt_no) AS m FROM submission WHERE session_id = ? AND team_num = ?",
        ).get(session.id, team.team_num);
        const attemptNo = (prevAttempt?.m || 0) + 1;

        // 새 제출 INSERT
        const subResult = db.prepare(
          "INSERT INTO submission (session_id, team_num, team_id, submitted_by, started_at, submitted_at, total_size, is_late, attempt_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(session.id, team.team_num, canonicalTeamId, req.user.email, startTime, submittedTime, totalSize, isLate, attemptNo);
        const newSubId = subResult.lastInsertRowid;
        const storageDir = path.join(String(session.id), `team-${canonicalTeamId}`, String(newSubId));
        db.prepare("UPDATE submission SET storage_dir = ? WHERE id = ?").run(storageDir, newSubId);

        // 파일 메타데이터 INSERT
        const fileStmt = db.prepare("INSERT INTO submission_file (submission_id, original_name, stored_name, size, mime_type, text_charset) VALUES (?, ?, ?, ?, ?, ?)");
        for (const f of filesInfo) {
          fileStmt.run(newSubId, f.original_name, f.stored_name, f.size, f.mime_type, f.text_charset);
        }

        // Establish the bytes at their final path before the metadata commit.
        // A crash after this rename rolls the SQLite transaction back and leaves
        // only an orphan directory, which startup cleanup removes. The inverse
        // state (committed references to bytes still under _tmp) is impossible.
        const finalDir = submissionUploadDir({
          id: newSubId,
          session_id: session.id,
          team_num: team.team_num,
          storage_dir: storageDir,
        });
        try {
          fs.mkdirSync(path.dirname(finalDir), { recursive: true });
          fs.renameSync(tmpDir, finalDir);
          movedFinalDir = finalDir;
          options.afterSubmissionFilesMoved?.({
            submissionId: Number(newSubId),
            finalDir,
            storageDir,
          });
        } catch (error) {
          fileMoveError = error;
          throw error;
        }

        // 최신 2개를 제외한 오래된 제출 조회
        const allSubs = db.prepare(
          "SELECT id, session_id, team_num, storage_dir FROM submission WHERE session_id = ? AND team_num = ? ORDER BY id DESC",
        ).all(session.id, team.team_num);
        const toDelete = allSubs.slice(2);

        return { id: newSubId, submitted_at: submittedTime, is_late: isLate, total_size: totalSize, storage_dir: storageDir, toDelete };
      });
      return tx();
    });

    if (!txResult.success) {
      logger.warn(req, "submission.create", {
        error: fileMoveError?.message || txResult.internalError || txResult.error,
        phase: fileMoveError ? "file_move" : "metadata_commit",
        session_id: session.id,
        year: session.year,
        team_num: team.team_num,
      }, session.name);
      if (movedFinalDir) rmDir(movedFinalDir);
      else rmDir(tmpDir);
      return res.status(txResult.status).send(
        fileMoveError ? "파일 저장에 실패했습니다." : txResult.error,
      );
    }
    if (txResult.result.rejected) {
      rmDir(tmpDir);
      logger.warn(req, "submission.create", txResult.result.audit, session.name);
      return res.status(txResult.result.status).send(txResult.result.message);
    }

    for (const oldSubmission of txResult.result.toDelete) {
      let metadataDeleted = false;
      try {
        const deleted = db.prepare("DELETE FROM submission WHERE id = ?").run(oldSubmission.id);
        if (deleted.changes !== 1) {
          throw new Error(`expected one deleted submission row, got ${deleted.changes}`);
        }
        metadataDeleted = true;
      } catch (e) {
        logger.warn(req, "submission.retention_cleanup", {
          error: e.message,
          submission_id: oldSubmission.id,
          storage_dir: oldSubmission.storage_dir,
          file_preserved: true,
        }, session.name);
      }
      if (metadataDeleted) {
        const fileCleanup = rmDir(submissionUploadDir(oldSubmission), { logFailure: false });
        const detail = {
          submission_id: oldSubmission.id,
          storage_dir: oldSubmission.storage_dir,
          metadata_deleted: true,
          file_removed: fileCleanup.removed,
          ...(fileCleanup.error ? { error: fileCleanup.error } : {}),
        };
        if (fileCleanup.removed) logger.log(req, "submission.retention_cleanup", detail, session.name);
        else logger.warn(req, "submission.retention_cleanup", detail, session.name);
      }
    }

    const { toDelete, storage_dir, ...result } = txResult.result;
    logger.log(req, "submission.create", { session_id: session.id, team_id: canonicalTeamId, team_num: team.team_num, files: filesInfo.length, size: totalSize, is_late: isLate, started_at: startTime, submitted_at: submittedTime }, session.name);
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
app.get("/api/submissions/:subId/files/:fileId", async (req, res) => {
  const sub = db.prepare(`
    SELECT sub.*, s.year AS session_year
    FROM submission sub JOIN session s ON s.id = sub.session_id
    WHERE sub.id = ?
  `).get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
  const team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? AND year = ?")
    .get(req.user.email, sub.session_year);
  if (!team) { logger.warn(req, "file.download", { error: "no_team_for_year", sub_id: sub.id, year: sub.session_year }); return res.status(403).send("팀이 등록되지 않았습니다."); }
  if (sub.team_num !== team.team_num) { logger.warn(req, "file.download", { error: "wrong_team", sub_team: sub.team_num, my_team: team.team_num }, `#${sub.team_num}`); return res.status(403).send("권한이 없습니다."); }

  // 해당 submission의 세션이 학생 팀에 할당된 세션인지 검증
  const isTarget = db.prepare("SELECT 1 FROM session_team st JOIN session s ON s.id = st.session_id WHERE st.session_id = ? AND st.team_num = ? AND s.year = ?").get(sub.session_id, team.team_num, team.year);
  if (!isTarget) { logger.warn(req, "file.download", { error: "not_target", session_id: sub.session_id }, `#${sub.team_num}`); return res.status(403).send("권한이 없습니다."); }

  const file = db.prepare("SELECT * FROM submission_file WHERE id = ? AND submission_id = ?").get(Number(req.params.fileId), sub.id);
  if (!file) return res.status(404).send("파일을 찾을 수 없습니다.");

  const filePath = submissionFilePath(sub, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send("파일이 존재하지 않습니다.");

  const session = db.prepare("SELECT name FROM session WHERE id = ?").get(sub.session_id);
  if (isInitialDownload(req)) logger.log(req, "file.download", { session_name: session?.name, team_num: sub.team_num, file: file.original_name }, `#${sub.team_num}`);
  await setFileResponseHeaders(res, file, filePath);
  res.sendFile(filePath);
});

// GET /api/submissions/:subId/zip - 본인 제출 파일 전체 압축 다운로드
app.get("/api/submissions/:subId/zip", async (req, res) => {
  const sub = db.prepare(`
    SELECT sub.*, s.year AS session_year
    FROM submission sub JOIN session s ON s.id = sub.session_id
    WHERE sub.id = ?
  `).get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
  const team = db.prepare("SELECT team_num, year FROM student_team WHERE email = ? AND year = ?")
    .get(req.user.email, sub.session_year);
  if (!team) { logger.warn(req, "file.zip", { error: "no_team_for_year", sub_id: sub.id, year: sub.session_year }); return res.status(403).send("팀이 등록되지 않았습니다."); }
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
    const filePath = submissionFilePath(sub, f.stored_name);
    if (fs.existsSync(filePath)) {
      // zip-slip 방지: 업로드 당시 원본 파일명이 경로 구분자를 포함할 수 있다
      archive.file(filePath, { name: sanitize(f.original_name) });
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
  const yearCheck = validateYear(year);
  if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
  const numYear = yearCheck.value;
  if (!Array.isArray(teams) || teams.length === 0) return res.status(400).send("대상 팀을 선택하세요.");

  const maxSize = max_file_size ? Number(max_file_size) : 52428800;
  if (!Number.isFinite(maxSize) || maxSize <= 0 || maxSize > 524288000) return res.status(400).send("올바르지 않은 파일 크기 제한입니다 (최대 500MB).");
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

  const preflight = auditedLookup(req, res, {
    action: "session.update",
    target: `session:${id}`,
    phase: "session_preflight",
    message: "세션을 확인할 수 없습니다.",
    lookup: () => {
      const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
      const oldTeams = session
        ? db.prepare("SELECT team_num FROM session_team WHERE session_id = ? ORDER BY team_num").all(id).map((row) => row.team_num)
        : [];
      return { session, oldTeams };
    },
  });
  if (!preflight.ok) return;
  const { session, oldTeams } = preflight.value;
  if (!session) {
    logger.warn(req, "session.update", {
      error: "session_not_found", reason: "session_not_found", phase: "session_preflight", session_id: id,
    }, `session:${id}`);
    return res.status(404).send("세션을 찾을 수 없습니다.");
  }

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
  if (!Number.isFinite(maxSize) || maxSize <= 0 || maxSize > 524288000) return res.status(400).send("올바르지 않은 파일 크기 제한입니다 (최대 500MB).");
  const exts = allowed_extensions || "";

  for (const t of teams) {
    if (!Number.isInteger(t) || t < 1) return res.status(400).send("올바르지 않은 팀 번호가 포함되어 있습니다.");
  }

  const removedSubmissions = [];
  const txResult = dbRun(() => {
    const tx = db.transaction(() => {
      db.prepare(
        "UPDATE session SET name = ?, notice = ?, start_at = ?, end_at = ?, late_end_at = ?, max_file_size = ?, allowed_extensions = ? WHERE id = ?",
      ).run(name.trim(), notice || "", nStart, nEnd, nLateEnd, maxSize, exts, id);

      const newTeamsSet = new Set(teams);

      // 제거되는 팀의 제출물 정리
      for (const oldTeam of oldTeams) {
        if (!newTeamsSet.has(oldTeam)) {
          const subs = db.prepare("SELECT id, session_id, team_num, storage_dir FROM submission WHERE session_id = ? AND team_num = ?").all(id, oldTeam);
          if (subs.length) {
            db.prepare("DELETE FROM submission WHERE session_id = ? AND team_num = ?").run(id, oldTeam);
          }
          if (subs.length) removedSubmissions.push(...subs);
        }
      }

      db.prepare("DELETE FROM session_team WHERE session_id = ?").run(id);
      const teamStmt = db.prepare("INSERT INTO session_team (session_id, team_num) VALUES (?, ?)");
      for (const t of teams) teamStmt.run(id, t);
    });
    return tx();
  });

  if (!txResult.success) { logger.warn(req, "session.update", { error: txResult.internalError || txResult.error }, name.trim()); return res.status(txResult.status).send(txResult.error); }

  // 트랜잭션 성공 후 디스크 파일 정리
  const cleanup = removedSubmissions.map((submission) => {
    const directory = submissionUploadDir(submission);
    return {
      submission_id: submission.id,
      team_num: submission.team_num,
      storage_dir: submission.storage_dir,
      directory,
      ...rmDir(directory, { logFailure: false }),
    };
  });
  const auditDetail = {
    session_id: id,
    year: session.year,
    before_teams: oldTeams,
    after_teams: [...teams].sort((a, b) => a - b),
    deleted_submissions: removedSubmissions.map((submission) => ({
      id: submission.id,
      team_num: submission.team_num,
      storage_dir: submission.storage_dir,
    })),
    file_cleanup: cleanup,
  };
  logger.log(req, "session.update", auditDetail, name.trim());
  logCleanupFailures(req, "session.update", name.trim(), {
    session_id: id, year: session.year, before_teams: oldTeams, after_teams: auditDetail.after_teams,
  }, cleanup);
  res.status(200).send();

  // 예약 알림 재등록 (날짜 변경 반영)
  try { scheduleSessionNotifications(id, nStart, nEnd); }
  catch (e) { logger.warn(req, "schedule.register", { error: e.message, sessionId: id }); }
});

// DELETE /api/admin/sessions/:id - 세션 삭제
app.delete("/api/admin/sessions/:id", (req, res) => {
  const id = Number(req.params.id);
  const preflight = auditedLookup(req, res, {
    action: "session.delete",
    target: `session:${id}`,
    phase: "session_preflight",
    message: "세션을 확인할 수 없습니다.",
    lookup: () => {
      const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
      const submissions = session
        ? db.prepare("SELECT id, session_id, team_num, storage_dir FROM submission WHERE session_id = ? ORDER BY id").all(id)
        : [];
      return { session, submissions };
    },
  });
  if (!preflight.ok) return;
  const { session, submissions } = preflight.value;
  if (!session) {
    logger.warn(req, "session.delete", {
      error: "session_not_found", reason: "session_not_found", phase: "session_preflight", session_id: id,
    }, `session:${id}`);
    return res.status(404).send("세션을 찾을 수 없습니다.");
  }

  const txResult = dbRun(() => {
    db.prepare("DELETE FROM session WHERE id = ?").run(id);
  });

  if (!txResult.success) { logger.warn(req, "session.delete", { error: txResult.internalError || txResult.error }, session.name); return res.status(txResult.status).send(txResult.error); }

  const directory = path.join(UPLOADS_DIR, String(id));
  const cleanup = [{ directory, ...rmDir(directory, { logFailure: false }) }];
  const auditDetail = {
    id,
    year: session.year,
    deleted_submissions: submissions.map((submission) => ({
      id: submission.id,
      team_num: submission.team_num,
      storage_dir: submission.storage_dir,
    })),
    file_cleanup: cleanup,
  };
  logger.log(req, "session.delete", auditDetail, session.name);
  logCleanupFailures(req, "session.delete", session.name, { session_id: id, year: session.year }, cleanup);

  res.status(200).send();
});

// GET /api/admin/sessions/:id/status - 팀별 제출 현황
app.get("/api/admin/sessions/:id/status", (req, res) => {
  const id = Number(req.params.id);
  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
  if (!session) return res.status(404).send("세션을 찾을 수 없습니다.");

  const teams = db.prepare("SELECT team_num FROM session_team WHERE session_id = ? ORDER BY team_num").all(id);

  const submissions = db.prepare(`
    SELECT id, team_num, submitted_at, total_size, is_late, submitted_by, attempt_no, rn
    FROM (
      SELECT s.id, s.team_num, s.submitted_at, s.total_size, s.is_late, s.submitted_by, s.attempt_no,
             ROW_NUMBER() OVER (PARTITION BY s.team_num ORDER BY s.id DESC) AS rn
      FROM submission s
      WHERE s.session_id = ?
    )
    WHERE rn <= 2
    ORDER BY team_num, rn
  `).all(id);
  const submissionsByTeam = new Map();
  for (const sub of submissions) {
    const list = submissionsByTeam.get(sub.team_num) || [];
    list.push(sub);
    submissionsByTeam.set(sub.team_num, list);
  }

  const filesBySubmission = new Map();
  if (submissions.length > 0) {
    const placeholders = submissions.map(() => "?").join(",");
    const files = db.prepare(`
      SELECT submission_id, id, original_name, size, mime_type
      FROM submission_file
      WHERE submission_id IN (${placeholders})
      ORDER BY id
    `).all(...submissions.map((s) => s.id));
    for (const file of files) {
      const list = filesBySubmission.get(file.submission_id) || [];
      list.push({
        id: file.id,
        original_name: file.original_name,
        size: file.size,
        mime_type: file.mime_type,
      });
      filesBySubmission.set(file.submission_id, list);
    }
  }

  const status = teams.map((t) => {
    const subs = submissionsByTeam.get(t.team_num) || [];
    const sub = subs[0] ? (({ team_num, rn, ...rest }) => rest)(subs[0]) : null;
    const files = sub ? filesBySubmission.get(sub.id) || [] : [];
    const prevSub = subs[1] ? (({ team_num, rn, ...rest }) => rest)(subs[1]) : null;
    const prevFiles = prevSub ? filesBySubmission.get(prevSub.id) || [] : [];
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
  const entries = await fetchEntries(session.year, req, "session.archive");

  const subs = db.prepare(`
    SELECT sub.id, sub.session_id, sub.team_num, sub.storage_dir FROM submission sub
    INNER JOIN (
      SELECT session_id, team_num, MAX(id) AS max_id
      FROM submission
      WHERE session_id = ?
      GROUP BY session_id, team_num
    ) latest ON sub.id = latest.max_id
  `).all(id);

  const sessionName = sanitize(session.name);
  const archiveFiles = [];
  const subById = new Map(subs.map((sub) => [sub.id, sub]));
  const subIds = subs.map((sub) => sub.id);
  const files = subIds.length
    ? db.prepare(`SELECT submission_id, original_name, stored_name FROM submission_file WHERE submission_id IN (${subIds.map(() => "?").join(",")})`).all(...subIds)
    : [];

  for (const f of files) {
    const sub = subById.get(f.submission_id);
    if (!sub) continue;
    const diskPath = submissionFilePath(sub, f.stored_name);
    if (fs.existsSync(diskPath)) {
      const entry = entries[sub.team_num];
      const teamFolder = entry
        ? `${sub.team_num}_${sanitize(entry.univ)}_${sanitize(entry.team)}`
        : String(sub.team_num);
      // zip-slip 방지: 업로드 당시 원본 파일명이 경로 구분자를 포함할 수 있다
      archiveFiles.push({ diskPath, zipPath: `${sessionName}/${teamFolder}/${sanitize(f.original_name)}` });
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
app.get("/api/admin/submissions/:subId/files/:fileId", async (req, res) => {
  const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");
  const session = db.prepare("SELECT name, year FROM session WHERE id = ?").get(sub.session_id);
  if (!session) return res.status(404).send("제출을 찾을 수 없습니다.");

  const file = db.prepare("SELECT * FROM submission_file WHERE id = ? AND submission_id = ?").get(Number(req.params.fileId), sub.id);
  if (!file) return res.status(404).send("파일을 찾을 수 없습니다.");

  const filePath = submissionFilePath(sub, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send("파일이 존재하지 않습니다.");

  if (isInitialDownload(req)) logger.log(req, "file.admin_download", { session_name: session?.name, team_num: sub.team_num, file: file.original_name }, `#${sub.team_num}`);
  await setFileResponseHeaders(res, file, filePath);
  res.sendFile(filePath);
});

// GET /api/admin/submissions/:subId/zip - 제출 파일 전체 압축 다운로드
app.get("/api/admin/submissions/:subId/zip", async (req, res) => {
  const sub = db.prepare("SELECT * FROM submission WHERE id = ?").get(Number(req.params.subId));
  if (!sub) return res.status(404).send("제출을 찾을 수 없습니다.");

  const session = db.prepare("SELECT name, year FROM session WHERE id = ?").get(sub.session_id);
  if (!session) return res.status(404).send("제출을 찾을 수 없습니다.");

  const files = db.prepare("SELECT * FROM submission_file WHERE submission_id = ?").all(sub.id);
  if (files.length === 0) return res.status(404).send("다운로드할 파일이 없습니다.");

  const sessionName = sanitize(session?.name || String(sub.session_id));

  // entry 서비스에서 팀 정보 조회
  let teamLabel = String(sub.team_num);
  if (session?.year) {
    const entries = await fetchEntries(session.year, req, "file.admin_zip");
    const entry = entries[sub.team_num];
    if (entry) teamLabel = `${sub.team_num}_${sanitize(entry.univ)}_${sanitize(entry.team)}`;
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
    const filePath = submissionFilePath(sub, f.stored_name);
    if (fs.existsSync(filePath)) {
      // zip-slip 방지: 업로드 당시 원본 파일명이 경로 구분자를 포함할 수 있다
      archive.file(filePath, { name: sanitize(f.original_name) });
    }
  }

  archive.finalize();
  logger.log(req, "file.admin_zip", { session_name: session?.name, team_num: sub.team_num, files: files.length }, `#${sub.team_num}`);
});

// GET /api/admin/students - auth 서비스에서 student 역할 사용자 목록 조회
app.get("/api/admin/students", async (req, res) => {
  try {
    const authRes = await fetch(`${serviceUrl("auth")}/api/users`, {
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
  if (!Number.isInteger(numTeam) || numTeam < 1) return res.status(400).send("올바르지 않은 팀 번호입니다.");
  const yearCheck = validateYear(year);
  if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
  const numYear = yearCheck.value;

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

  launchOpenSessionNotification(req, email.trim().toLowerCase(), numTeam, numYear);
});

// DELETE /api/admin/student-teams/:email/:year - 학생-팀 매핑 삭제
app.delete("/api/admin/student-teams/:email/:year", (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year)) return res.status(400).send("올바르지 않은 연도입니다.");
  const email = decodeURIComponent(req.params.email);
  const result = dbRun(() => db.transaction(() => {
    const mapping = db.prepare("SELECT team_num FROM student_team WHERE email = ? AND year = ?").get(email, year);
    if (!mapping) return { mapping: null, changes: 0 };
    const deleted = db.prepare("DELETE FROM student_team WHERE email = ? AND year = ?").run(email, year);
    return { mapping, changes: deleted.changes };
  })());
  if (!result.success) {
    logger.warn(req, "student_team.delete", {
      error: result.internalError || result.error,
      reason: result.internalError || result.error,
      phase: "mapping_preflight",
      year,
    }, email);
    return res.status(result.status).send(result.error);
  }
  if (result.result.changes === 0) {
    logger.warn(req, "student_team.delete", {
      error: "mapping_not_found", reason: "mapping_not_found", year,
    }, email);
    return res.status(404).send("매핑을 찾을 수 없습니다.");
  }
  logger.log(req, "student_team.delete", { year, team_num: result.result.mapping.team_num }, email);
  res.status(200).send();
});

/* ============================================
   Year-level Admin API (연도별 관리)
   ============================================ */

// DELETE /api/admin/years/:year/files - 연도별 파일 데이터 삭제 (제출 기록 유지)
app.delete("/api/admin/years/:year/files", (req, res) => {
  const yearCheck = validateYear(req.params.year);
  if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
  const year = yearCheck.value;

  const txResult = dbRun(() => {
    return db.transaction(() => {
      const sessions = db.prepare("SELECT id FROM session WHERE year = ? ORDER BY id").all(year);
      if (sessions.length === 0) return { sessions, fileCount: 0 };
      const sessionIds = sessions.map((s) => s.id);
      const placeholders = sessionIds.map(() => "?").join(",");
      const subIds = db.prepare(`SELECT id FROM submission WHERE session_id IN (${placeholders})`).all(...sessionIds).map((s) => s.id);
      let fileCount = 0;
      if (subIds.length) {
        const subPlaceholders = subIds.map(() => "?").join(",");
        fileCount = db.prepare(`DELETE FROM submission_file WHERE submission_id IN (${subPlaceholders})`).run(...subIds).changes;
      }
      return { sessions, fileCount };
    })();
  });

  if (!txResult.success) {
    logger.warn(req, "year.purge_files", {
      error: txResult.internalError || txResult.error,
      reason: txResult.internalError || txResult.error,
      phase: "year_purge_preflight",
      year,
    });
    return res.status(txResult.status).send(txResult.error);
  }
  const { sessions, fileCount } = txResult.result;
  if (sessions.length === 0) {
    logger.warn(req, "year.purge_files", {
      error: "year_has_no_sessions", reason: "year_has_no_sessions", year,
    }, String(year));
    return res.status(404).send("해당 연도의 세션이 없습니다.");
  }

  // 트랜잭션 성공 후 디스크 파일 삭제
  const cleanup = sessions.map((session) => {
    const directory = path.join(UPLOADS_DIR, String(session.id));
    return { session_id: session.id, directory, ...rmDir(directory, { logFailure: false }) };
  });

  logger.log(req, "year.purge_files", { year, sessions: sessions.length, files: fileCount, file_cleanup: cleanup });
  logCleanupFailures(req, "year.purge_files", String(year), { year, sessions: sessions.length, files: fileCount }, cleanup);
  res.json({ sessions: sessions.length, files: fileCount });
});

// GET /api/admin/years/:year/archive - 연도별 전체 압축 다운로드
app.get("/api/admin/years/:year/archive", async (req, res) => {
  const yearCheck = validateYear(req.params.year);
  if (!yearCheck.valid) return res.status(400).send(yearCheck.error);
  const year = yearCheck.value;

  const sessions = db.prepare("SELECT * FROM session WHERE year = ? ORDER BY end_at ASC").all(year);
  if (sessions.length === 0) return res.status(404).send("해당 연도의 세션이 없습니다.");

  // entry 서비스에서 팀 정보 조회 (실패 시 빈 객체 — graceful degradation)
  const entries = await fetchEntries(year, req, "year.archive");

  // 각 세션의 최신 제출 + 파일 조회
  const archiveFiles = [];
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const files = db.prepare(`
    WITH latest AS (
      SELECT id, session_id, team_num, storage_dir
      FROM (
        SELECT sub.id, sub.session_id, sub.team_num, sub.storage_dir,
               ROW_NUMBER() OVER (PARTITION BY sub.session_id, sub.team_num ORDER BY sub.id DESC) AS rn
        FROM submission sub
        JOIN session s ON s.id = sub.session_id
        WHERE s.year = ?
      )
      WHERE rn = 1
    )
    SELECT latest.id AS submission_id, latest.session_id, latest.team_num, latest.storage_dir, f.original_name, f.stored_name
    FROM latest
    JOIN submission_file f ON f.submission_id = latest.id
    ORDER BY latest.session_id, latest.team_num, f.id
  `).all(year);

  for (const f of files) {
    const s = sessionById.get(f.session_id);
    if (!s) continue;
    const diskPath = submissionFilePath({
      id: f.submission_id,
      session_id: f.session_id,
      team_num: f.team_num,
      storage_dir: f.storage_dir,
    }, f.stored_name);
    if (fs.existsSync(diskPath)) {
      const entry = entries[f.team_num];
      const sessionName = sanitize(s.name);
      const teamFolder = entry
        ? sanitize(`${f.team_num}_${entry.univ}_${entry.team}`)
        : String(f.team_num);
      // zip-slip 방지: 업로드 당시 원본 파일명이 경로 구분자를 포함할 수 있다
      archiveFiles.push({ diskPath, zipPath: `${sessionName}/${teamFolder}/${sanitize(f.original_name)}` });
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
  if (options.sendNotificationEmail) {
    return options.sendNotificationEmail(subject, htmlContent, recipient);
  }
  const emailServer = serviceUrl("email");
  if (!process.env.INTERNAL_SECRET) return { ok: false, error: "INTERNAL_SECRET not configured" };

  // 이메일 발송은 Brevo 왕복이 포함돼 내부 표준(5초)보다 길게 잡는다
  const EMAIL_SEND_TIMEOUT_MS = 15000;
  const resp = await fetch(`${emailServer}/api/internal/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Service": process.env.INTERNAL_SECRET },
    body: JSON.stringify({ subject, htmlContent, recipients: [recipient], source: "documents" }),
    signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
  });

  if (!resp.ok) return { ok: false, error: await resp.text() };
  return { ok: true };
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 엔트리 정보 조회. 공유 DB 읽기 실패는 감사한 뒤 호출자에게 전파한다. */
async function fetchEntries(year, req = null, action = "entry.fetch") {
  if (!options.teamStore) {
    logger.warn(req, action, { error: "Competition team store is required", year });
    throw new Error("Competition team store is required");
  }
  try {
    return options.teamStore.moduleEntries(year, { includeInactive: true });
  } catch (error) {
    logger.warn(req, action, { error: error.message || String(error), year });
    throw error;
  }
}

/** 팀 정보 헤더 HTML */
function teamHeaderHtml(teamNum, entries) {
  const entry = entries[teamNum];
  const label = entry ? `#${teamNum} ${escapeHtml(entry.univ)} ${escapeHtml(entry.team)}` : `#${teamNum}`;
  return `<p style="margin:0 0 12px;font-size:15px;font-weight:bold;font-style:italic;color:#333">${label}</p>`;
}

/** 예약 알림 처리 — 1분마다 실행 */
let schedulerTask = null;
let notificationDraining = false;

function processScheduledNotifications() {
  // 재진입 가드: 발송(수신자별 순차 await, 건당 최대 15초)이 60초 인터벌을 넘기면 다음
  // tick이 겹쳐 실행돼 같은 sent=0 행을 다시 읽고 중복 발송한다. 한 번에 하나만 돈다.
  if (notificationDraining) return Promise.resolve();
  if (schedulerTask) return schedulerTask;
  schedulerTask = runScheduledNotifications();
  schedulerTask.then(
    () => { schedulerTask = null; },
    () => { schedulerTask = null; },
  );
  return schedulerTask;
}

async function runScheduledNotifications() {
  try {
  const currentTime = now();
  const pending = db.prepare(
    "SELECT sn.*, s.name, s.notice, s.start_at, s.end_at, s.late_end_at, s.year FROM scheduled_notification sn JOIN session s ON sn.session_id = s.id WHERE sn.sent = 0 AND sn.scheduled_at <= ? AND s.year = ?",
  ).all(currentTime, currentCompetitionYear());

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
        const completion = db.prepare("UPDATE scheduled_notification SET sent = 1 WHERE id = ? AND sent = 0").run(n.id);
        if (completion.changes !== 1) {
          throw new Error(`no-recipient completion updated ${completion.changes} scheduled notifications`);
        }
        logger.log(null, `schedule.${n.type}`, {
          notificationId: n.id,
          sessionId: n.session_id,
          year: n.year,
          type: n.type,
          recipientCount: 0,
          completionReason: "no_recipients",
          before: { sent: Number(n.sent) },
          after: { sent: 1 },
        }, n.name);
        continue;
      }

      // 엔트리 정보 조회
      const entries = await fetchEntries(n.year);

      let subject;
      const safeName = escapeHtml(n.name);

      if (n.type === "session_open") subject = `[FSK] 서류 제출 안내: ${n.name}`;
      else if (n.type === "deadline_3h") subject = `[FSK] 서류 제출 마감 3시간 전: ${n.name}`;
      else if (n.type === "deadline_1h") subject = `[FSK] 서류 미제출 알림: ${n.name}`;

      // 수신자별 개별 발송 — 이미 성공한 수신자는 스킵(부분 실패 재시도 시 중복 방지).
      const alreadySent = new Set(JSON.parse(n.sent_recipients || "[]"));
      const todo = recipientRows.filter((r) => !alreadySent.has(r.email));
      for (const { email, team_num } of todo) {
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

        try {
          const result = await sendNotificationEmail(subject, htmlContent, email);
          if (result.ok) {
            alreadySent.add(email);
            // Persist each success immediately. A later recipient throwing or
            // the process stopping must not make an already-delivered address
            // eligible for the next scheduler retry.
            db.prepare("UPDATE scheduled_notification SET sent_recipients = ? WHERE id = ?")
              .run(JSON.stringify([...alreadySent]), n.id);
          } else {
            logger.warn(null, `schedule.${n.type}`, {
              error: result.error || "email_send_rejected",
              reason: result.error || "email_send_rejected",
              recipient: email,
              phase: "recipient_send",
              sent: alreadySent.size,
            }, n.name);
          }
        } catch (error) {
          logger.warn(null, `schedule.${n.type}`, {
            error: error?.message || String(error),
            recipient: email,
            phase: "recipient_send",
            sent: alreadySent.size,
          }, n.name);
        }
      }

      // 현재 대상 중 아직 못 보낸 수신자가 남으면 sent=0을 유지해 다음 tick이 실패분만
      // 재시도한다(성공분은 sent_recipients로 스킵 → 중복 발송 없음). 진행 상황은 항상 저장.
      const remaining = recipientRows.filter((r) => !alreadySent.has(r.email));
      const sentList = JSON.stringify([...alreadySent]);
      if (remaining.length === 0) {
        db.prepare("UPDATE scheduled_notification SET sent = 1, sent_recipients = ? WHERE id = ?").run(sentList, n.id);
        logger.log(null, `schedule.${n.type}`, { recipientCount: alreadySent.size }, n.name);
      } else {
        // 영구 실패(무효/바운스 주소)로 remaining이 계속 남으면 매 60s tick 무한 재시도 + warn
        // firehose가 된다. 재시도 상한(5회 ≈ 5분)을 두고, 초과하면 sent=1로 종료해 최종 실패만 남긴다.
        const attempts = (n.attempts || 0) + 1;
        const MAX_SEND_ATTEMPTS = 5;
        if (attempts >= MAX_SEND_ATTEMPTS) {
          db.prepare("UPDATE scheduled_notification SET sent = 1, sent_recipients = ?, attempts = ? WHERE id = ?").run(sentList, attempts, n.id);
          logger.warn(null, `schedule.${n.type}`, { error: "gave_up_after_max_attempts", sent: alreadySent.size, remaining: remaining.length, attempts }, n.name);
        } else {
          db.prepare("UPDATE scheduled_notification SET sent_recipients = ?, attempts = ? WHERE id = ?").run(sentList, attempts, n.id);
          logger.warn(null, `schedule.${n.type}`, { error: "partial_send", sent: alreadySent.size, remaining: remaining.length, attempts }, n.name);
        }
      }
    } catch (e) {
      logger.warn(null, `schedule.${n.type}`, {
        error: e.message || String(e),
        notificationId: n.id,
        sessionId: n.session_id,
        year: n.year,
        type: n.type,
        phase: "notification_processing",
      }, n.name);
    }
  }
  } catch (e) {
    // pending 쿼리 등 루프 밖에서 throw하면 setInterval 콜백의 미처리 프라미스 거부가 된다.
    // 구조화 로그로 남기고 스케줄러는 다음 tick에 계속 돈다.
    logger.warn(null, "schedule.run", { error: e.message || String(e) });
  }
}

// 1분마다 예약 알림 처리
const _schedulerInterval = enableNotificationScheduler
  ? setInterval(processScheduledNotifications, 60_000)
  : null;
_schedulerInterval?.unref?.();
// 서버 시작 후 5초 뒤 첫 실행 (밀린 알림 즉시 처리)
const _schedulerStartupTimer = enableNotificationScheduler
  ? setTimeout(processScheduledNotifications, 5000)
  : null;
_schedulerStartupTimer?.unref?.();

/** 계정 할당 시 현재 열린 세션 알림 */
function launchOpenSessionNotification(req, email, teamNum, year) {
  const task = notifyOpenSessions(req, email, teamNum, year);
  notificationTasks.add(task);
  void task.finally(() => notificationTasks.delete(task));
  return task;
}

async function drainNotificationTasks() {
  notificationDraining = true;
  if (_schedulerInterval) clearInterval(_schedulerInterval);
  if (_schedulerStartupTimer) clearTimeout(_schedulerStartupTimer);
  while (notificationTasks.size > 0 || schedulerTask) {
    await Promise.all([
      ...notificationTasks,
      ...(schedulerTask ? [schedulerTask] : []),
    ]);
  }
}

function hasPendingNotificationTasks() {
  return notificationTasks.size > 0 || schedulerTask != null;
}

async function notifyOpenSessions(req, email, teamNum, year) {
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

    if (!result.ok) {
      logger.warn(req, "student_team.notify", {
        error: result.error || "email_send_rejected",
        reason: result.error || "email_send_rejected",
        phase: "recipient_send",
        recipient: email,
        year,
        team_num: teamNum,
        session_count: openSessions.length,
      }, email);
    } else {
      logger.log(req, "student_team.notify", {
        recipient: email,
        year,
        team_num: teamNum,
        session_count: openSessions.length,
      }, email);
    }
  } catch (e) {
    logger.warn(req, "student_team.notify", {
      error: e.message,
      reason: e.message,
      recipient: email,
      year,
      team_num: teamNum,
    }, email);
  }
}

if (!options.skipSpaFallback) addSpaFallback(app);

return {
  app,
  db,
  processScheduledNotifications,
  drainNotificationTasks,
  drain: drainNotificationTasks,
  hasPendingNotificationTasks,
  _schedulerInterval,
  _schedulerStartupTimer,
  timers: [
    _schedulerInterval,
    _schedulerStartupTimer,
  ].filter(Boolean),
};
}
