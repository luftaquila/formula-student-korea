import crypto from "node:crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createApp, createDbRun, setupProcessHandlers, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";

const PORT = 11000;
const EVENT_ROLE_LEVELS = { public: 0, student: 1, official: 2, chief: 3, admin: 4 };
const ALLOWED_EVENT_ROLES = ["public", "student", "official", "chief", "admin"];

/* ============================================
   App
   ============================================ */
export function createCalendarApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/calendar.db");

db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'official'
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_events_start_end ON events(start, end)");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_end_start ON events(end, start)");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_role_start ON events(role, start)");

const logger = createLogger(db, "calendar");
const dbRun = createDbRun();

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path === "/api/logs") return "admin";
  if (req.method === "GET" && req.path === "/api/events") return null;
  if (req.path === "/api/events/ical") return null;
  if (req.path === "/api/events/subscribe") return "student";
  if (req.path.startsWith("/api/")) return "chief";
  return null;
});

app.get("/api/health", (req, res) => res.send("ok"));
app.get("/api/logs", logger.queryHandler);

function toEventResponse(row) {
  return {
    id: row.id,
    title: row.title,
    start: row.start,
    end: row.end,
    description: row.description,
    location: row.location,
    allDay: !!row.all_day,
    calendarId: row.role,
    role: row.role,
  };
}

function validDateParts(year, month, day, hour = 0, minute = 0) {
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return d.getUTCFullYear() === year
    && d.getUTCMonth() === month - 1
    && d.getUTCDate() === day
    && d.getUTCHours() === hour
    && d.getUTCMinutes() === minute;
}

function normalizeDateTime(value, { allDay = false, requireTime = false } = {}) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const dateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, yy, mm, dd] = dateOnly;
    const [y, m, d] = [Number(yy), Number(mm), Number(dd)];
    if (!validDateParts(y, m, d)) return null;
    if (requireTime && !allDay) return null;
    return `${yy}-${mm}-${dd}`;
  }
  const dateTime = input.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (!dateTime) return null;
  const [, yy, mo, dd, hh, mi] = dateTime;
  const [y, m, d, hour, minute] = [Number(yy), Number(mo), Number(dd), Number(hh), Number(mi)];
  if (!validDateParts(y, m, d, hour, minute)) return null;
  const normalized = `${yy}-${mo}-${dd} ${hh}:${mi}`;
  return allDay ? normalized.slice(0, 10) : normalized;
}

// List events (public access, filtered by user role)
app.get("/api/events", (req, res) => {
  const { timeMin, timeMax } = req.query;
  if (!timeMin || !timeMax) {
    logger.warn(req, "event.list", { error: "timeMin and timeMax are required" });
    return res.status(400).json({ error: "timeMin and timeMax are required" });
  }

  const normalizedMin = normalizeDateTime(String(timeMin));
  const normalizedMax = normalizeDateTime(String(timeMax));
  if (!normalizedMin || !normalizedMax) {
    logger.warn(req, "event.list", { error: "invalid timeMin/timeMax", timeMin, timeMax });
    return res.status(400).json({ error: "Invalid time range" });
  }

  const result = dbRun(() =>
    db.prepare("SELECT * FROM events WHERE end >= ? AND start <= ? ORDER BY start").all(normalizedMin, normalizedMax)
  );

  if (!result.success) {
    logger.warn(req, "event.list", { error: result.error });
    return res.status(result.status).json({ error: result.error });
  }

  const userLevel = EVENT_ROLE_LEVELS[req.user?.role] ?? 0;
  const events = result.result
    .filter(e => {
      const eventLevel = ALLOWED_EVENT_ROLES.includes(e.role) ? EVENT_ROLE_LEVELS[e.role] : EVENT_ROLE_LEVELS.official;
      return userLevel >= eventLevel;
    })
    .map(toEventResponse);
  res.json(events);
});

// 이벤트 입력 검증 (생성·수정 공유). 실패 시 응답을 보내고 null 반환, 성공 시 { role }.
function validateEventInput(req, res, action, target) {
  const { title, start, end } = req.body;
  if (!title || !start || !end) {
    logger.warn(req, action, { error: "title, start, and end are required", title, start, end }, target);
    res.status(400).json({ error: "title, start, and end are required" });
    return null;
  }
  const allDay = !!req.body.allDay;
  const normalizedStart = normalizeDateTime(start, { allDay, requireTime: true });
  const normalizedEnd = normalizeDateTime(end, { allDay, requireTime: true });
  if (!normalizedStart || !normalizedEnd) {
    logger.warn(req, action, { error: "invalid start/end format", start, end, allDay }, target);
    res.status(400).json({ error: "Invalid start or end format" });
    return null;
  }
  if (normalizedStart > normalizedEnd) {
    logger.warn(req, action, { error: "start must not be after end", start: normalizedStart, end: normalizedEnd }, target);
    res.status(400).json({ error: "start must not be after end" });
    return null;
  }
  const role = req.body.role || "official";
  if (!ALLOWED_EVENT_ROLES.includes(role)) {
    logger.warn(req, action, { error: "Invalid role value", role }, target);
    res.status(400).json({ error: "Invalid role value" });
    return null;
  }
  const userLevel = EVENT_ROLE_LEVELS[req.user?.role] ?? 0;
  if (EVENT_ROLE_LEVELS[role] > userLevel) {
    logger.warn(req, action, { error: "role exceeds own level", requested: role, actual: req.user?.role }, target);
    res.status(403).json({ error: "Cannot set visibility above your own role" });
    return null;
  }
  return { role, start: normalizedStart, end: normalizedEnd, allDay };
}

// Create event
app.post("/api/events", (req, res) => {
  const { title } = req.body;
  const valid = validateEventInput(req, res, "event.create", null);
  if (!valid) return;
  const { role, start, end, allDay } = valid;

  const description = req.body.description || "";
  const location = req.body.location || "";

  const result = dbRun(() =>
    db.prepare("INSERT INTO events (title, description, location, start, end, all_day, role) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(title, description, location, start, end, allDay ? 1 : 0, role)
  );

  if (!result.success) {
    logger.warn(req, "event.create", { error: result.error, title, start, end });
    return res.status(result.status).json({ error: result.error });
  }

  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(result.result.lastInsertRowid);
  logger.log(req, "event.create", { title, start, end, allDay, role }, `${event.id}`);
  res.status(201).json(toEventResponse(event));
});

// Update event
app.put("/api/events/:id", (req, res) => {
  const { id } = req.params;
  const { title } = req.body;
  const valid = validateEventInput(req, res, "event.update", id);
  if (!valid) return;
  const { role, start, end, allDay } = valid;

  const existing = db.prepare("SELECT id FROM events WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Event not found" });

  const description = req.body.description || "";
  const location = req.body.location || "";

  const result = dbRun(() =>
    db.prepare("UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, role = ? WHERE id = ?")
      .run(title, description, location, start, end, allDay ? 1 : 0, role, id)
  );

  if (!result.success) {
    logger.warn(req, "event.update", { error: result.error, title, start, end }, id);
    return res.status(result.status).json({ error: result.error });
  }

  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  logger.log(req, "event.update", { title, start, end, allDay, role }, id);
  res.json(toEventResponse(event));
});

// Delete event
app.delete("/api/events/:id", (req, res) => {
  const { id } = req.params;

  const existing = db.prepare("SELECT title FROM events WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Event not found" });

  const result = dbRun(() => db.prepare("DELETE FROM events WHERE id = ?").run(id));

  if (!result.success) {
    logger.warn(req, "event.delete", { error: result.error }, id);
    return res.status(result.status).json({ error: result.error });
  }

  logger.log(req, "event.delete", { title: existing.title }, id);
  res.status(204).end();
});

// Generate HMAC signature for iCal subscription URL
function generateICalSig(role) {
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update(`ical:${role}`).digest("hex");
}

// Get signed subscription URL for current user's role
app.get("/api/events/subscribe", (req, res) => {
  const role = req.user.role;
  const sig = generateICalSig(role);
  res.json({ role, path: `/calendar/api/events/ical?role=${role}&sig=${sig}` });
});

// iCal feed (signature-verified, no cookie auth)
app.get("/api/events/ical", (req, res) => {
  const { role, sig } = req.query;
  if (!role || !sig || !ALLOWED_EVENT_ROLES.includes(role)) {
    logger.warn(req, "event.ical", { error: "invalid parameters", role }, role ?? null);
    return res.status(400).send("Invalid parameters");
  }

  const expected = generateICalSig(role);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))) {
    logger.warn(req, "event.ical", { error: "invalid signature", role }, role);
    return res.status(403).send("Invalid signature");
  }

  const roleLevel = EVENT_ROLE_LEVELS[role];
  const visibleRoles = ALLOWED_EVENT_ROLES.filter(r => EVENT_ROLE_LEVELS[r] <= roleLevel);
  const placeholders = visibleRoles.map(() => "?").join(",");

  const result = dbRun(() =>
    db.prepare(`SELECT * FROM events WHERE role IN (${placeholders}) ORDER BY start ASC`).all(...visibleRoles)
  );

  if (!result.success) {
    logger.warn(req, "event.ical", { error: result.error });
    return res.status(result.status).send("Internal error");
  }

  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.send(generateICal(result.result));
});

function escapeICalText(text) {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function formatICalDateTime(dateStr) {
  // "YYYY-MM-DD HH:MM" → "YYYYMMDDTHHMMSS"
  return dateStr.slice(0, 10).replace(/-/g, "") + "T" + dateStr.slice(11, 16).replace(/:/g, "") + "00";
}

function generateICal(events) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Formula Student Korea//Calendar//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Formula Student Korea",
    "X-WR-TIMEZONE:Asia/Seoul",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Seoul",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0900",
    "TZOFFSETTO:+0900",
    "TZNAME:KST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:event-${event.id}@fsk-calendar`);
    lines.push(`DTSTAMP:${now}`);

    if (event.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${event.start.slice(0, 10).replace(/-/g, "")}`);
      // iCal DTEND for all-day events is exclusive (day after last day)
      const endDate = new Date(event.end.slice(0, 10) + "T00:00:00");
      endDate.setDate(endDate.getDate() + 1);
      lines.push(`DTEND;VALUE=DATE:${endDate.toISOString().slice(0, 10).replace(/-/g, "")}`);
    } else {
      lines.push(`DTSTART;TZID=Asia/Seoul:${formatICalDateTime(event.start)}`);
      lines.push(`DTEND;TZID=Asia/Seoul:${formatICalDateTime(event.end)}`);
    }

    lines.push(`SUMMARY:${escapeICalText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeICalText(event.location)}`);
    lines.push("TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// SPA fallback
app.get("/{*splat}", (req, res) => {
  res.sendFile("index.html", { root: "./web/dist" });
});

return { app, db };

}

const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  ensureDataDir();
  const { app, db } = createCalendarApp();
  setupProcessHandlers(db);
  app.listen(PORT, () => console.log(`Calendar service running on port ${PORT}`));
}
