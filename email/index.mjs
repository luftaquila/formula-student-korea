import express from "express";
import crypto from "node:crypto";
import https from "node:https";
import Database from "better-sqlite3";
import { createDatabase, runMigrationOnce, setupRowCapRetention, parseLegacyTimestamp } from "../shared/db-setup.mjs";
import { createApp, createDbRun, setupProcessHandlers, ensureDataDir, requireInternalRequest } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";

const PORT = 9900;

const BREVO_API_BASE = "https://api.brevo.com/v3";

const CONFIG_KEYS = [
  "email_enabled",
  "brevo_api_key",
  "brevo_sender_name",
  "brevo_sender_email",
  "naver_cloud_access_key",
  "naver_cloud_secret_key",
  "naver_cloud_sms_service_id",
  "phone_number_sms_sender",
];

const MASKED_KEYS = new Set([
  "brevo_api_key",
  "naver_cloud_access_key",
  "naver_cloud_secret_key",
]);

/* ============================================
   App
   ============================================ */
export function createEmailApp(options = {}) {

const fetchFn = options.fetchFn || globalThis.fetch;
const db = createDatabase(Database, options.dbPath || "./data/email.db");
const EMAIL_LOG_MAX_ROWS = Number.parseInt(process.env.EMAIL_LOG_MAX_ROWS || "50000", 10);

db.exec(`CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`);

db.exec(`CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  recipient TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  message_id TEXT,
  html_content TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_by TEXT
)`);

// Migration: add html_content column if missing
try { db.exec("ALTER TABLE email_log ADD COLUMN html_content TEXT"); } catch { /* already exists */ }

// Migration: recipients JSON array → recipient single string, drop legacy columns
{
  const columns = () => db.prepare("PRAGMA table_info(email_log)").all().map((c) => c.name);
  let cols = columns();
  if (!cols.includes("recipient")) {
    db.exec("ALTER TABLE email_log ADD COLUMN recipient TEXT NOT NULL DEFAULT ''");
    cols = columns();
  }
  if (cols.includes("recipients")) {
    db.prepare(`
      UPDATE email_log
      SET recipient = COALESCE(NULLIF(json_extract(recipients, '$[0]'), ''), recipient, '')
      WHERE (recipient IS NULL OR recipient = '') AND recipients LIKE '[%' AND json_valid(recipients)
    `).run();
    db.exec("ALTER TABLE email_log DROP COLUMN recipients");
    cols = columns();
  }
  if (cols.includes("recipient_count")) {
    db.exec("ALTER TABLE email_log DROP COLUMN recipient_count");
  }
}

// 레거시 sent_at은 zone 없는 KST 로컬 값으로 저장됐으므로 +09:00으로 해석한다.
const normalizeEmailSentAt = (value) => parseLegacyTimestamp(value, { naiveOffset: "+09:00" });

runMigrationOnce(db, "email.sent_at_utc_normalization.v1", () => {
  const rows = db.prepare("SELECT id, sent_at FROM email_log WHERE sent_at IS NOT NULL AND sent_at != ''").all();
  const update = db.prepare("UPDATE email_log SET sent_at = ? WHERE id = ?");
  for (const row of rows) {
    const normalized = normalizeEmailSentAt(row.sent_at);
    if (normalized && normalized !== row.sent_at) update.run(normalized, row.id);
  }
});

db.exec(`CREATE INDEX IF NOT EXISTS idx_el_sent_at ON email_log(sent_at)`);
db.exec("DROP INDEX IF EXISTS idx_el_status");
db.exec(`CREATE INDEX IF NOT EXISTS idx_el_status_sent_at ON email_log(status, sent_at)`);

// Seed config keys
const insertConfig = db.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, '')");
for (const key of CONFIG_KEYS) insertConfig.run(key);

const logger = createLogger(db, "email");
const dbRun = createDbRun();

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path === "/api/logs") return "admin";
  if (req.path.startsWith("/api/")) return "admin";
  return "admin"; // SPA — admin only (redirect non-admins instead of serving a dead shell)
});

app.get("/api/health", (req, res) => res.send("ok"));
app.get("/api/logs", logger.queryHandler);

// AFTER INSERT 트리거로 매 발송 로그 삽입마다 최신 N행만 보존한다(인터벌 prune과 달리
// 한도를 초과하는 구간이 생기지 않음).
setupRowCapRetention(db, "email_log", EMAIL_LOG_MAX_ROWS);

/* ============================================
   Config
   ============================================ */
function getConfig(key) {
  return db.prepare("SELECT value FROM config WHERE key = ?").get(key)?.value || "";
}

function getAllConfig() {
  return db.prepare("SELECT key, value FROM config").all();
}

function maskValue(key, value) {
  if (!MASKED_KEYS.has(key) || !value) return value;
  return value.length > 4 ? "****" + value.slice(-4) : "****";
}

app.get("/api/config", (req, res) => {
  const result = dbRun(() => getAllConfig());
  if (!result.success) {
    logger.warn(req, "config.list", { error: result.error });
    return res.status(result.status).send(result.error);
  }
  const configs = {};
  for (const { key, value } of result.result) {
    configs[key] = maskValue(key, value);
  }
  res.json(configs);
});

app.put("/api/config", (req, res) => {
  const { configs } = req.body;
  if (!Array.isArray(configs)) {
    logger.warn(req, "config.update", { error: "configs 배열 누락" });
    return res.status(400).send("configs 배열이 필요합니다.");
  }

  const updated = [];
  const result = dbRun(() => {
    const stmt = db.prepare("UPDATE config SET value = ? WHERE key = ?");
    for (const { key, value } of configs) {
      if (!CONFIG_KEYS.includes(key)) continue;
      if (!value && value !== "") continue; // skip null/undefined
      if (value === "") continue; // skip empty (unchanged masked field)
      if (MASKED_KEYS.has(key) && value.startsWith("****")) continue; // skip masked placeholder
      stmt.run(value, key);
      updated.push(key);
    }
  });

  if (!result.success) {
    logger.warn(req, "config.update", { error: result.error, keys: updated });
    return res.status(result.status).send(result.error);
  }

  for (const key of updated) {
    logger.log(req, "config.update", { key, value: maskValue(key, getConfig(key)) });
  }
  res.json({ updated });
});

/* ============================================
   Config Reset
   ============================================ */
const CONFIG_GROUPS = {
  brevo: ["brevo_api_key", "brevo_sender_name", "brevo_sender_email"],
  sms: ["naver_cloud_access_key", "naver_cloud_secret_key", "naver_cloud_sms_service_id", "phone_number_sms_sender"],
};

app.post("/api/config/reset", (req, res) => {
  const { group } = req.body;
  const keys = CONFIG_GROUPS[group];
  if (!keys) {
    logger.warn(req, "config.reset", { error: "유효하지 않은 group", group });
    return res.status(400).send("유효하지 않은 그룹입니다. (brevo | sms)");
  }

  const result = dbRun(() => {
    const stmt = db.prepare("UPDATE config SET value = '' WHERE key = ?");
    for (const key of keys) stmt.run(key);
  });

  if (!result.success) {
    logger.warn(req, "config.reset", { error: result.error, group });
    return res.status(result.status).send(result.error);
  }

  logger.log(req, "config.reset", { group, keys });
  res.json({ reset: keys });
});

/* ============================================
   Stats
   ============================================ */
app.get("/api/stats", (req, res) => {
  const kstDate = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const dayStart = new Date(`${kstDate}T00:00:00+09:00`);
  const start = dayStart.toISOString();
  const end = new Date(dayStart.getTime() + 86400000).toISOString();
  const result = dbRun(() => {
    const sent = db.prepare("SELECT COUNT(*) as count FROM email_log WHERE status = 'sent' AND sent_at >= ? AND sent_at < ?").get(start, end);
    const errors = db.prepare("SELECT COUNT(*) as count FROM email_log WHERE status = 'error' AND sent_at >= ? AND sent_at < ?").get(start, end);
    const totalSent = db.prepare("SELECT COUNT(*) as count FROM email_log WHERE status = 'sent'").get();
    const totalErrors = db.prepare("SELECT COUNT(*) as count FROM email_log WHERE status = 'error'").get();
    return { sent: sent.count, errors: errors.count, totalSent: totalSent.count, totalErrors: totalErrors.count };
  });

  if (!result.success) {
    logger.warn(req, "stats.query", { error: result.error });
    return res.status(result.status).send(result.error);
  }
  res.json(result.result);
});

/* ============================================
   Quota (Brevo API)
   ============================================ */
app.get("/api/quota", async (req, res) => {
  const apiKey = getConfig("brevo_api_key");
  if (!apiKey) return res.json({ remaining: null, error: "API 키가 설정되지 않았습니다." });

  try {
    const resp = await fetchFn(`${BREVO_API_BASE}/account`, {
      headers: { "api-key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.warn(req, "quota.fetch", { error: text, status: resp.status });
      return res.json({ remaining: null, error: `Brevo API 오류 (${resp.status})` });
    }

    const data = await resp.json();
    const freePlan = data.plan?.find((p) => p.type === "free" && p.creditsType === "sendLimit");
    const remaining = freePlan?.credits ?? 0;
    res.json({ remaining });
  } catch (e) {
    logger.warn(req, "quota.fetch", { error: e.message });
    res.json({ remaining: null, error: "Brevo API 연결 실패" });
  }
});

/* ============================================
   Email Log
   ============================================ */
app.get("/api/emails", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;

  const result = dbRun(() => {
    let query = `
      SELECT id, subject, recipient, status, error, message_id, source, sent_at, sent_by
      FROM email_log
    `;
    let countQuery = "SELECT COUNT(*) as total FROM email_log";
    const params = [];

    if (status && (status === "sent" || status === "error")) {
      query += " WHERE status = ?";
      countQuery += " WHERE status = ?";
      params.push(status);
    }

    query += " ORDER BY sent_at DESC LIMIT ? OFFSET ?";
    const total = db.prepare(countQuery).get(...params).total;
    const rows = db.prepare(query).all(...params, limit, offset);
    return { rows, total };
  });

  if (!result.success) {
    logger.warn(req, "emails.list", { error: result.error });
    return res.status(result.status).send(result.error);
  }
  res.json(result.result);
});

app.get("/api/emails/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).send("Invalid email id");

  const result = dbRun(() =>
    db.prepare(`
      SELECT id, subject, recipient, status, error, message_id, html_content, source, sent_at, sent_by
      FROM email_log
      WHERE id = ?
    `).get(id)
  );

  if (!result.success) {
    logger.warn(req, "emails.get", { error: result.error }, String(id));
    return res.status(result.status).send(result.error);
  }
  if (!result.result) return res.status(404).send("Email not found");
  res.json(result.result);
});

/* ============================================
   Send Email (Admin UI)
   ============================================ */
app.post("/api/send", async (req, res) => {
  const { subject, htmlContent, recipients } = req.body;
  if (!subject || !htmlContent || !Array.isArray(recipients) || recipients.length === 0) {
    logger.warn(req, "email.send", { error: "필수값 누락 (제목/내용/수신자)" });
    return res.status(400).send("제목, 내용, 수신자가 필요합니다.");
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = recipients.filter(e => !emailRegex.test(e));
  if (invalid.length > 0) {
    logger.warn(req, "email.send", { error: "잘못된 이메일 형식", invalid });
    return res.status(400).send(`유효하지 않은 이메일 주소: ${invalid.join(", ")}`);
  }

  await sendEmail(req, res, { subject, htmlContent, recipients, source: "manual" });
});

/* ============================================
   Internal Send API (for other services)
   ============================================ */
app.post("/api/internal/send", async (req, res) => {
  if (!requireInternalRequest(req, res)) return;

  const { subject, htmlContent, recipients, source } = req.body;
  if (!subject || !htmlContent || !Array.isArray(recipients) || recipients.length === 0) {
    logger.warn(req, "email.send", { error: "필수값 누락 (subject/htmlContent/recipients)", source });
    return res.status(400).send("subject, htmlContent, recipients are required.");
  }

  await sendEmail(req, res, { subject, htmlContent, recipients, source: source || "internal" });
});

/* ============================================
   Brevo API Wrapper — single recipient, no side effects
   ============================================ */
async function sendBrevo({ apiKey, senderName, senderEmail, subject, wrappedHtml, recipient }) {
  const resp = await fetchFn(`${BREVO_API_BASE}/smtp/email`, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { name: senderName || "FSK", email: senderEmail },
      to: [{ email: recipient }],
      subject,
      htmlContent: wrappedHtml,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.ok) return { ok: true, messageId: data.messageId };
  return { ok: false, error: data.message || `Brevo API 오류 (${resp.status})`, status: resp.status >= 400 && resp.status < 500 ? 400 : 500 };
}

/* ============================================
   Shared Send Logic — config/quota, per-recipient loop, logging
   ============================================ */
async function sendEmail(req, res, { subject, htmlContent, recipients, source }) {
  if (getConfig("email_enabled") === "FALSE") {
    logger.warn(req, "email.send", { error: "email_disabled", subject, recipientCount: recipients.length, source });
    return res.status(503).send("이메일 전송이 비활성화되어 있습니다.");
  }

  const sentBy = req.user?.email || null;
  const apiKey = getConfig("brevo_api_key");
  const senderName = getConfig("brevo_sender_name");
  const senderEmail = getConfig("brevo_sender_email");

  if (!apiKey || !senderEmail) {
    logger.warn(req, "email.send", { error: "Brevo 설정 미완료", subject, recipientCount: recipients.length, source });
    return res.status(400).send("Brevo API 키 또는 발신자 이메일이 설정되지 않았습니다.");
  }

  // Check quota before sending
  try {
    const quotaResp = await fetchFn(`${BREVO_API_BASE}/account`, {
      headers: { "api-key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (quotaResp.ok) {
      const quotaData = await quotaResp.json();
      const freePlan = quotaData.plan?.find((p) => p.type === "free" && p.creditsType === "sendLimit");
      const remaining = freePlan?.credits ?? 0;
      if (remaining < recipients.length) {
        logger.warn(req, "email.send", {
          error: "quota_exceeded",
          remaining,
          recipientCount: recipients.length,
          subject,
          source,
        });
        return res.status(400).send(`전송 가능한 메일 수(${remaining}건)가 수신자 수(${recipients.length}명)보다 적습니다.`);
      }
    } else {
      const quotaErrText = await quotaResp.text().catch(() => "");
      logger.warn(req, "email.quota_check", { error: quotaErrText || quotaResp.status, status: quotaResp.status, subject, source });
    }
  } catch (e) {
    logger.warn(req, "email.quota_check", { error: e.message, subject, source });
    // Quota check failure is non-fatal — proceed with send attempt
  }

  const wrappedHtml = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#333333;background-color:#ffffff;">
${htmlContent}
</body></html>`;

  let successCount = 0;
  let lastMessageId = null;
  let lastError = null;
  let lastErrorStatus = 500;

  for (const recipient of recipients) {
    let result;
    try {
      result = await sendBrevo({ apiKey, senderName, senderEmail, subject, wrappedHtml, recipient });
    } catch (e) {
      result = { ok: false, error: e.message, status: 500 };
    }

    // Per-recipient DB log
    if (result.ok) {
      const logResult = dbRun(() =>
        db.prepare("INSERT INTO email_log (subject, recipient, status, message_id, html_content, source, sent_by, sent_at) VALUES (?, ?, 'sent', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
          .run(subject, recipient, result.messageId || null, htmlContent, source, sentBy)
      );
      if (!logResult.success) logger.warn(req, "email.log_insert", { error: logResult.error, subject, recipient, source });
      successCount++;
      lastMessageId = result.messageId || lastMessageId;
    } else {
      const logResult = dbRun(() =>
        db.prepare("INSERT INTO email_log (subject, recipient, status, error, html_content, source, sent_by, sent_at) VALUES (?, ?, 'error', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
          .run(subject, recipient, result.error, htmlContent, source, sentBy)
      );
      if (!logResult.success) logger.warn(req, "email.log_insert", { error: logResult.error, subject, recipient, source });
      lastError = result.error;
      lastErrorStatus = result.status;
    }
  }

  if (successCount === 0) {
    logger.warn(req, "email.send", { error: lastError || "전송 실패", subject, recipientCount: recipients.length, source });
    return res.status(lastErrorStatus).send(lastError || "전송 실패");
  }

  if (successCount < recipients.length) {
    logger.warn(req, "email.send_partial", { subject, successCount, failedCount: recipients.length - successCount, lastError, source });
  }
  // 내부 서비스에서 호출한 경우(예: documents 예약 알림은 수신자별 1건씩 호출), 호출자가
  // 자체 집계 로그(`schedule.*`)를 남기므로 성공 info는 생략해 로그 노이즈를 줄인다.
  // email_log 테이블에는 수신자별 행이 그대로 남아 추적 가능.
  const isInternal = req.headers["x-internal-service"] && req.headers["x-internal-service"] === process.env.INTERNAL_SECRET;
  if (!isInternal) {
    logger.log(req, "email.send", { subject, recipientCount: successCount, messageId: lastMessageId, source });
  }
  res.json({ success: true, messageId: lastMessageId });
}

/* ============================================
   Recipients (proxy to auth service)
   ============================================ */
app.get("/api/recipients", async (req, res) => {
  const authServer = process.env.AUTH_SERVER || "http://auth:9100";
  try {
    const headers = {};
    if (process.env.INTERNAL_SECRET) headers["X-Internal-Service"] = process.env.INTERNAL_SECRET;
    const resp = await fetchFn(`${authServer}/api/users`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`Auth API 오류 (${resp.status})`);
    const users = await resp.json();
    const list = users.map(({ email, name, role, realname, active }) => ({ email, name, role, realname, active }));
    res.json(list);
  } catch (e) {
    logger.warn(req, "recipients.fetch", { error: e.message });
    res.status(500).send("수신자 목록을 가져올 수 없습니다.");
  }
});

/* ============================================
   Internal API: SMS Config for queue service
   ============================================ */
app.get("/api/internal/sms-config", (req, res) => {
  if (!requireInternalRequest(req, res)) return;

  const result = dbRun(() => {
    const configs = {};
    for (const key of CONFIG_KEYS.filter((k) => k.startsWith("naver_") || k === "phone_number_sms_sender")) {
      configs[key] = getConfig(key);
    }
    return configs;
  });
  if (!result.success) {
    logger.warn(req, "sms_config.fetch", { error: result.error });
    return res.status(result.status).send(result.error);
  }
  res.json(result.result);
});

/* ============================================
   Test Email
   ============================================ */
app.post("/api/test-email", async (req, res) => {
  const { recipient } = req.body;
  if (!recipient) {
    logger.warn(req, "email.test", { error: "recipient 누락" });
    return res.status(400).send("수신자 이메일이 필요합니다.");
  }

  if (getConfig("email_enabled") === "FALSE") {
    logger.warn(req, "email.test", { error: "email_disabled", recipient });
    return res.status(503).send("이메일 전송이 비활성화되어 있습니다.");
  }

  const apiKey = getConfig("brevo_api_key");
  const senderName = getConfig("brevo_sender_name");
  const senderEmail = getConfig("brevo_sender_email");

  if (!apiKey || !senderEmail) {
    logger.warn(req, "email.test", { error: "Brevo 설정 미완료", recipient });
    return res.status(400).send("Brevo API 키 또는 발신자 이메일이 설정되지 않았습니다.");
  }

  try {
    const resp = await fetchFn(`${BREVO_API_BASE}/smtp/email`, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: senderName || "FSK", email: senderEmail },
        to: [{ email: recipient }],
        subject: "[FSK] 이메일 전송 테스트",
        htmlContent: `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#333333;background-color:#ffffff;">
<p>이 메일은 FSK 이메일 서비스의 테스트 메일입니다.</p>
</body></html>`,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const errorMsg = data.message || `Brevo API 오류 (${resp.status})`;
      logger.warn(req, "email.test", { error: errorMsg, recipient });
      return res.status(400).send(errorMsg);
    }

    logger.log(req, "email.test", { recipient, messageId: data.messageId });
    res.json({ success: true });
  } catch (e) {
    logger.warn(req, "email.test", { error: e.message, recipient });
    res.status(500).send("테스트 메일 전송 중 오류가 발생했습니다.");
  }
});

/* ============================================
   Test SMS
   ============================================ */
app.post("/api/test-sms", async (req, res) => {
  const { recipient } = req.body;
  if (!recipient) {
    logger.warn(req, "sms.test", { error: "recipient 누락" });
    return res.status(400).send("수신자 전화번호가 필요합니다.");
  }

  const accessKey = getConfig("naver_cloud_access_key");
  const secretKey = getConfig("naver_cloud_secret_key");
  const serviceId = getConfig("naver_cloud_sms_service_id");
  const sender = getConfig("phone_number_sms_sender");

  if (!accessKey || !secretKey || !serviceId || !sender) {
    logger.warn(req, "sms.test", { error: "SMS 설정 미완료", recipient });
    return res.status(400).send("SMS 설정이 완료되지 않았습니다.");
  }

  const timestamp = String(Date.now());
  const path = `/sms/v2/services/${serviceId}/messages`;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`POST ${path}\n${timestamp}\n${accessKey}`)
    .digest("base64");

  const body = JSON.stringify({
    type: "SMS",
    from: sender,
    content: `[FSK] SMS 전송 테스트입니다.`,
    messages: [{ to: recipient }],
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const smsReq = https.request({
        hostname: "sens.apigw.ntruss.com",
        port: 443,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "x-ncp-apigw-timestamp": timestamp,
          "x-ncp-iam-access-key": accessKey,
          "x-ncp-apigw-signature-v2": signature,
        },
      }, (smsRes) => {
        let data = "";
        smsRes.on("data", (chunk) => (data += chunk));
        smsRes.on("end", () => resolve({ status: smsRes.statusCode, data }));
      });

      smsReq.setTimeout(10000, () => { smsReq.destroy(); reject(new Error("SMS 전송 타임아웃")); });
      smsReq.on("error", reject);
      smsReq.write(body);
      smsReq.end();
    });

    if (result.status >= 200 && result.status < 300) {
      logger.log(req, "sms.test", { recipient, response: result.data });
      res.json({ success: true });
    } else {
      logger.warn(req, "sms.test", { error: result.data, recipient, status: result.status });
      res.status(400).send(`SMS 전송 실패 (${result.status}): ${result.data}`);
    }
  } catch (e) {
    logger.warn(req, "sms.test", { error: e.message, recipient });
    res.status(500).send("테스트 SMS 전송 중 오류가 발생했습니다.");
  }
});

/* ============================================
   SPA fallback
   ============================================ */
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db };

}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createEmailApp();
  setupProcessHandlers(db);
  app.listen(PORT, () => console.log(`Email service running on port ${PORT}`));
}
