import crypto from "node:crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase, runMigrationOnce } from "../shared/db-setup.mjs";
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
// 범위 조회는 idx_events_all_day_end_start, 정렬 조회는 idx_events_role_start가 커버.
// 단독 (start,end)/(end,start) 인덱스는 매칭되는 쿼리가 없어 제거(기존 배포본 정리 포함).
db.exec("DROP INDEX IF EXISTS idx_events_start_end");
db.exec("DROP INDEX IF EXISTS idx_events_end_start");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_role_start ON events(role, start)");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_all_day_end_start ON events(all_day, end, start)");

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

function toUtcIso({ yy, mo, dd, hh = "00", mi = "00", ss = "00", zone = "" }) {
  const text = zone
    ? `${yy}-${mo}-${dd}T${hh}:${mi}:${ss}${zone}`
    : new Date(Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh) - 9, Number(mi), Number(ss))).toISOString();
  if (zone) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return text;
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
  const dateTime = input.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!dateTime) return null;
  const [, yy, mo, dd, hh, mi, ss = "00", zone = ""] = dateTime;
  const [y, m, d, hour, minute] = [Number(yy), Number(mo), Number(dd), Number(hh), Number(mi)];
  if (!validDateParts(y, m, d, hour, minute)) return null;
  return allDay ? `${yy}-${mo}-${dd}` : toUtcIso({ yy, mo, dd, hh, mi, ss, zone });
}

function normalizeRangeBound(value, endOfDay = false) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const dateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, yy, mo, dd] = dateOnly;
    const [y, m, d] = [Number(yy), Number(mo), Number(dd)];
    if (!validDateParts(y, m, d)) return null;
    const localMs = Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return new Date(localMs - 9 * 3600000).toISOString();
  }
  return normalizeDateTime(input);
}

function kstDateFromUtcIso(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

runMigrationOnce(db, "calendar.event_timestamp_normalization.v1", () => {
  const update = db.prepare("UPDATE events SET start = ?, end = ? WHERE id = ?");
  for (const event of db.prepare("SELECT id, start, end, all_day FROM events").all()) {
    const allDay = !!event.all_day;
    const start = normalizeDateTime(event.start, { allDay, requireTime: !allDay });
    const end = normalizeDateTime(event.end, { allDay, requireTime: !allDay });
    if (start && end && (start !== event.start || end !== event.end)) {
      update.run(start, end, event.id);
    }
  }
});

// List events (public access, filtered by user role)
app.get("/api/events", (req, res) => {
  const { timeMin, timeMax } = req.query;
  if (!timeMin || !timeMax) {
    logger.warn(req, "event.list", { error: "timeMin and timeMax are required" });
    return res.status(400).send("timeMin과 timeMax가 필요합니다.");
  }

  const normalizedMin = normalizeRangeBound(String(timeMin), false);
  const normalizedMax = normalizeRangeBound(String(timeMax), true);
  if (!normalizedMin || !normalizedMax) {
    logger.warn(req, "event.list", { error: "invalid timeMin/timeMax", timeMin, timeMax });
    return res.status(400).send("올바르지 않은 시간 범위입니다.");
  }
  const minAllDayDate = kstDateFromUtcIso(normalizedMin);
  const maxAllDayDate = kstDateFromUtcIso(normalizedMax);

  const result = dbRun(() =>
    db.prepare(`
      SELECT * FROM (
        SELECT * FROM events WHERE all_day = 0 AND end >= ? AND start <= ?
        UNION ALL
        SELECT * FROM events WHERE all_day = 1 AND end >= ? AND start <= ?
      )
      ORDER BY start
    `).all(normalizedMin, normalizedMax, minAllDayDate, maxAllDayDate)
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
    res.status(400).send("제목, 시작, 종료는 필수입니다.");
    return null;
  }
  const allDay = !!req.body.allDay;
  const normalizedStart = normalizeDateTime(start, { allDay, requireTime: true });
  const normalizedEnd = normalizeDateTime(end, { allDay, requireTime: true });
  if (!normalizedStart || !normalizedEnd) {
    logger.warn(req, action, { error: "invalid start/end format", start, end, allDay }, target);
    res.status(400).send("시작 또는 종료 형식이 올바르지 않습니다.");
    return null;
  }
  if (normalizedStart > normalizedEnd) {
    logger.warn(req, action, { error: "start must not be after end", start: normalizedStart, end: normalizedEnd }, target);
    res.status(400).send("시작은 종료보다 늦을 수 없습니다.");
    return null;
  }
  const role = req.body.role || "official";
  if (!ALLOWED_EVENT_ROLES.includes(role)) {
    logger.warn(req, action, { error: "Invalid role value", role }, target);
    res.status(400).send("올바르지 않은 공개 범위입니다.");
    return null;
  }
  const userLevel = EVENT_ROLE_LEVELS[req.user?.role] ?? 0;
  if (EVENT_ROLE_LEVELS[role] > userLevel) {
    logger.warn(req, action, { error: "role exceeds own level", requested: role, actual: req.user?.role }, target);
    res.status(403).send("자신의 권한보다 높은 공개 범위는 설정할 수 없습니다.");
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
  if (!existing) return res.status(404).send("일정을 찾을 수 없습니다.");

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
  if (!existing) return res.status(404).send("일정을 찾을 수 없습니다.");

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
    return res.status(400).send("올바르지 않은 요청입니다.");
  }

  const expected = generateICalSig(role);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))) {
    logger.warn(req, "event.ical", { error: "invalid signature", role }, role);
    return res.status(403).send("서명이 올바르지 않습니다.");
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
  const d = /[zZ]$/.test(String(dateStr)) ? new Date(dateStr) : null;
  if (d && !Number.isNaN(d.getTime())) {
    d.setHours(d.getHours() + 9);
    const iso = d.toISOString();
    return iso.slice(0, 10).replace(/-/g, "") + "T" + iso.slice(11, 19).replace(/:/g, "");
  }
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
