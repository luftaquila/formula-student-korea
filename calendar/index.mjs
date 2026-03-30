import fs from "fs";
import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createApp, setupProcessHandlers, ensureDataDir } from "../shared/express-setup.mjs";
import { createLogger } from "../shared/logger.mjs";

const PORT = 11000;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const GCAL_BASE = "https://www.googleapis.com/calendar/v3";
const EVENT_ROLE_LEVELS = { public: 0, student: 1, official: 2, chief: 3, admin: 4 };

/* ============================================
   Google Auth via Service Account (no googleapis)
   ============================================ */
function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = base64url(signer.sign(key.private_key));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${payload}.${signature}`,
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

function createGoogleCalendarClient() {
  let keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

  if (!keyJson && keyFile) {
    try {
      keyJson = fs.readFileSync(keyFile, "utf-8");
    } catch (e) {
      console.error("Failed to read GOOGLE_SERVICE_ACCOUNT_KEY_FILE:", e.message);
      return null;
    }
  }

  if (!keyJson) {
    console.error("GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set");
    return null;
  }

  let key;
  try {
    key = JSON.parse(keyJson);
  } catch (e) {
    console.error("Failed to parse service account key:", e.message);
    return null;
  }

  let cachedToken = null;
  let tokenExpiry = 0;

  async function authFetch(url, options = {}) {
    if (!cachedToken || Date.now() > tokenExpiry) {
      cachedToken = await getAccessToken(key);
      tokenExpiry = Date.now() + 3500 * 1000; // refresh 100s before expiry
    }
    const res = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${cachedToken}`, "Content-Type": "application/json" },
    });
    return res;
  }

  const calUrl = `${GCAL_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

  return {
    async list(params) {
      const qs = new URLSearchParams(params).toString();
      const res = await authFetch(`${calUrl}?${qs}`);
      if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);
      return res.json();
    },
    async insert(body) {
      const res = await authFetch(calUrl, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);
      return res.json();
    },
    async update(eventId, body) {
      const res = await authFetch(`${calUrl}/${eventId}`, { method: "PUT", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);
      return res.json();
    },
    async get(eventId) {
      const res = await authFetch(`${calUrl}/${eventId}`);
      if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);
      return res.json();
    },
    async delete(eventId) {
      const res = await authFetch(`${calUrl}/${eventId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`Google API ${res.status}: ${await res.text()}`);
    },
  };
}

/* ============================================
   Event format conversion
   ============================================ */
function toScheduleXEvent(gcalEvent) {
  const isAllDay = !!gcalEvent.start.date;
  const role = gcalEvent.extendedProperties?.private?.role || "official";

  // Google Calendar uses exclusive end dates for all-day events; subtract 1 day for inclusive display
  let end;
  if (isAllDay) {
    const d = new Date(gcalEvent.end.date + "T00:00:00");
    d.setDate(d.getDate() - 1);
    end = d.toISOString().slice(0, 10);
  } else {
    end = gcalEvent.end.dateTime;
  }

  return {
    id: gcalEvent.id,
    title: gcalEvent.summary || "",
    start: isAllDay ? gcalEvent.start.date : gcalEvent.start.dateTime,
    end,
    description: gcalEvent.description || "",
    location: gcalEvent.location || "",
    allDay: isAllDay,
    calendarId: role,
    role,
  };
}

function toGoogleCalendarEvent(body) {
  const event = {
    summary: body.title,
    description: body.description || "",
    location: body.location || "",
    transparency: "transparent",
    extendedProperties: { private: { role: body.role || "official" } },
  };

  if (body.allDay) {
    event.start = { date: body.start.slice(0, 10) };
    // Google Calendar uses exclusive end dates; add 1 day for storage
    const d = new Date(body.end.slice(0, 10) + "T00:00:00");
    d.setDate(d.getDate() + 1);
    event.end = { date: d.toISOString().slice(0, 10) };
  } else {
    event.start = { dateTime: body.start, timeZone: "Asia/Seoul" };
    event.end = { dateTime: body.end, timeZone: "Asia/Seoul" };
  }

  return event;
}

/* ============================================
   App
   ============================================ */
export function createCalendarApp(options = {}) {

const db = createDatabase(Database, options.dbPath || "./data/calendar.db");

const logger = createLogger(db, "calendar");

const app = createApp({ express }, (req) => {
  if (req.path === "/api/health") return null;
  if (req.path === "/api/logs") return "admin";
  if (req.method === "GET" && req.path === "/api/events") return null;
  if (req.path.startsWith("/api/")) return "chief";
  return null;
});

const calendar = options.googleCalendarClient || createGoogleCalendarClient();

app.get("/api/health", (req, res) => res.send("ok"));
app.get("/api/logs", logger.queryHandler);

// List events (public access, filtered by user role)
app.get("/api/events", async (req, res) => {
  if (!calendar) return res.status(503).json({ error: "Google Calendar not configured" });

  const { timeMin, timeMax } = req.query;
  if (!timeMin || !timeMax) return res.status(400).json({ error: "timeMin and timeMax are required" });

  // schedule-x sends "YYYY-MM-DD HH:mm" or "YYYY-MM-DD", Google API needs RFC3339
  const toRFC3339 = (s) => s.includes("T") ? s : s.length === 10 ? `${s}T00:00:00+09:00` : `${s.replace(" ", "T")}:00+09:00`;

  try {
    const data = await calendar.list({
      timeMin: toRFC3339(timeMin), timeMax: toRFC3339(timeMax), singleEvents: true, orderBy: "startTime", maxResults: 500,
    });

    const userLevel = EVENT_ROLE_LEVELS[req.user?.role] ?? 0;
    const events = (data.items || [])
      .filter(e => userLevel >= (EVENT_ROLE_LEVELS[e.extendedProperties?.private?.role] ?? EVENT_ROLE_LEVELS.official))
      .map(toScheduleXEvent);
    res.json(events);
  } catch (e) {
    logger.warn(req, "event.list", { error: e.message });
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// Create event
app.post("/api/events", async (req, res) => {
  if (!calendar) return res.status(503).json({ error: "Google Calendar not configured" });

  const { title, start, end } = req.body;
  if (!title || !start || !end) return res.status(400).json({ error: "title, start, and end are required" });

  try {
    const data = await calendar.insert(toGoogleCalendarEvent(req.body));
    const event = toScheduleXEvent(data);
    logger.log(req, "event.create", { title, start, end, allDay: req.body.allDay || false, role: req.body.role || "official" }, event.id);
    res.status(201).json(event);
  } catch (e) {
    logger.warn(req, "event.create", { error: e.message, title, start, end });
    res.status(500).json({ error: "Failed to create event" });
  }
});

// Update event
app.put("/api/events/:id", async (req, res) => {
  if (!calendar) return res.status(503).json({ error: "Google Calendar not configured" });

  const { id } = req.params;
  const { title, start, end } = req.body;
  if (!title || !start || !end) return res.status(400).json({ error: "title, start, and end are required" });

  try {
    const data = await calendar.update(id, toGoogleCalendarEvent(req.body));
    const event = toScheduleXEvent(data);
    logger.log(req, "event.update", { title, start, end, allDay: req.body.allDay || false, role: req.body.role || "official" }, id);
    res.json(event);
  } catch (e) {
    logger.warn(req, "event.update", { error: e.message, title, start, end }, id);
    res.status(500).json({ error: "Failed to update event" });
  }
});

// Delete event
app.delete("/api/events/:id", async (req, res) => {
  if (!calendar) return res.status(503).json({ error: "Google Calendar not configured" });

  const { id } = req.params;

  try {
    let eventTitle = id;
    try {
      const existing = await calendar.get(id);
      eventTitle = existing.summary || id;
    } catch { /* best-effort */ }

    await calendar.delete(id);

    logger.log(req, "event.delete", { title: eventTitle }, id);
    res.status(204).end();
  } catch (e) {
    logger.warn(req, "event.delete", { error: e.message }, id);
    res.status(500).json({ error: "Failed to delete event" });
  }
});

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
