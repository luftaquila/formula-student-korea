import express from "express";
import Database from "better-sqlite3";
import { createServiceSkeleton, addSpaFallback } from "../shared/service-bootstrap.mjs";
import { createSSEManager } from "../shared/sse.mjs";
import {
  assertCurrentCompetitionYear,
  currentCompetitionYear,
  parseCompetitionYear,
  sendYearError,
} from "../shared/competition-year.mjs";
import { createSmsClient } from "../shared/sms-client.mjs";

const ACTIVE_STATUSES = Object.freeze(["waiting", "called"]);
const SMS_PREFIX = (year) => `[FSK ${year}]`;
const DEFAULT_SETTINGS = Object.freeze({ open: false, sms: false, notifyRank: 3 });

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw Object.assign(new Error(`올바르지 않은 ${label}입니다.`), { status: 400, code: "INVALID_REQUEST" });
  }
  return number;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^010\d{8}$/.test(digits) ? digits : null;
}

function maskedPhone(value) {
  const phone = String(value || "");
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : "invalid";
}

function auditTeam(team) {
  return team && {
    id: team.id,
    year: team.year,
    number: team.number,
    university: team.university,
    name: team.name,
    active: team.active,
  };
}

function sendError(res, error, fallbackCode = "REGISTRATION_OPERATION_FAILED") {
  if (error?.code === "YEAR_READ_ONLY" || error?.code === "INVALID_YEAR") return sendYearError(res, error);
  const status = Number(error?.status) || (error?.code?.startsWith?.("SQLITE_CONSTRAINT") ? 409 : 500);
  return res.status(status).json({
    code: error?.code || (status >= 500 ? fallbackCode : "INVALID_REQUEST"),
    message: status >= 500 ? "등록 대기열 처리 중 오류가 발생했습니다." : error.message,
  });
}

export function createRegistrationApp(options = {}) {
  if (!options.teamStore) throw new Error("Competition team store is required");

  const { app, db, logger, dbRun } = createServiceSkeleton({
    name: "registration",
    express,
    Database,
    options,
    authRoleFn: (req) => {
      if (["/api/health", "/api/status", "/api/lookup", "/api/events"].includes(req.path)) return null;
      if (req.path === "/api/logs") return "admin";
      if (req.method === "GET" && /^\/api\/team\/\d+$/.test(req.path)) return "chief";
      if (req.path === "/api/queue" && req.method === "POST") return "chief";
      if (req.path === "/api/settings" && req.method !== "GET") return "chief";
      if (req.path.startsWith("/api/")) return "official";
      if (/^\/register(?:\/|$)/.test(req.path)) return "chief";
      if (/^\/manage(?:\/|$)/.test(req.path)) return "official";
      return null;
    },
  });

  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS registration_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES competition_team(id),
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK(status IN ('waiting','called','done','canceled')),
      notified INTEGER NOT NULL DEFAULT 0 CHECK(notified IN (0,1,2)),
      notify_claimed_at TEXT,
      registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      called_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_registration_queue_status
      ON registration_queue(status, id);
    CREATE INDEX IF NOT EXISTS idx_registration_queue_team
      ON registration_queue(team_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_registration_queue_finished
      ON registration_queue(finished_at) WHERE finished_at IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_queue_active_team
      ON registration_queue(team_id) WHERE status IN ('waiting','called');

    CREATE TABLE IF NOT EXISTS registration_settings (
      year INTEGER PRIMARY KEY CHECK(year BETWEEN 2000 AND 2099),
      open INTEGER NOT NULL DEFAULT 0 CHECK(open IN (0,1)),
      sms INTEGER NOT NULL DEFAULT 0 CHECK(sms IN (0,1)),
      notify_rank INTEGER NOT NULL DEFAULT 3 CHECK(notify_rank BETWEEN 0 AND 20),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );`);
    db.prepare(`
      INSERT OR IGNORE INTO registration_settings (year, open, sms, notify_rank)
      VALUES (?, 0, 0, 3)
    `).run(currentCompetitionYear());
  })();

  const smsClient = options.smsClient || createSmsClient({
    logger,
    smsRequest: options.smsRequest,
    smsConfig: options.smsConfig,
    fetchImpl: options.fetchImpl,
  });
  const pendingTasks = new Set();
  const track = (promise) => {
    pendingTasks.add(promise);
    promise.then(
      () => pendingTasks.delete(promise),
      () => pendingTasks.delete(promise),
    );
    return promise;
  };

  const rateLimitMap = new Map();
  const rateLimitTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  }, 60_000);
  rateLimitTimer.unref();

  function lookupRateLimit(req, res, next) {
    const ip = req.headers["x-real-ip"]?.trim()
      || req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || req.ip;
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60_000;
    }
    entry.count += 1;
    rateLimitMap.set(ip, entry);
    if (entry.count > 60) {
      logger.warn(req, "registration.lookup", { reason: "rate_limit", count: entry.count, ip }, "public");
      return res.status(429).json({ code: "RATE_LIMITED", message: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." });
    }
    next();
  }

  function settingsForYear(year) {
    const row = db.prepare(`
      SELECT year, open, sms, notify_rank, updated_at
      FROM registration_settings WHERE year = ?
    `).get(year);
    return {
      year,
      open: row ? row.open === 1 : DEFAULT_SETTINGS.open,
      sms: row ? row.sms === 1 : DEFAULT_SETTINGS.sms,
      notifyRank: row ? row.notify_rank : DEFAULT_SETTINGS.notifyRank,
      smsAvailable: smsClient.isAvailable(),
      smsPrefix: SMS_PREFIX(year),
      updatedAt: row?.updated_at || null,
    };
  }

  function registrationRow(id) {
    return db.prepare(`
      SELECT q.id, q.team_id, q.phone, q.status, q.notified,
             q.registered_at, q.called_at, q.finished_at,
             t.year, t.num, t.univ, t.name, t.active
      FROM registration_queue q
      JOIN competition_team t ON t.id = q.team_id
      WHERE q.id = ?
    `).get(id);
  }

  function publicStatus(year) {
    const waiting = db.prepare(`
      SELECT COUNT(*) AS count
      FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
      WHERE t.year = ? AND q.status = 'waiting'
    `).get(year).count;
    const called = db.prepare(`
      SELECT t.id AS teamId, t.num AS number, q.called_at AS calledAt
      FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
      WHERE t.year = ? AND q.status = 'called'
      ORDER BY q.called_at, q.id
    `).all(year);
    return { year, open: settingsForYear(year).open, waiting, called };
  }

  const { broadcast, handler: sseHandler, close: closeSse } = createSSEManager();

  function broadcastChange(year) {
    broadcast("registration", { year }, (meta) => meta.year === year);
  }

  function parseEventYear(req, res, next) {
    try {
      req.registrationYear = parseCompetitionYear(req.query.year);
      next();
    } catch (error) {
      sendYearError(res, error);
    }
  }

  app.get("/api/events", parseEventYear, sseHandler(
    (req) => publicStatus(req.registrationYear),
    { meta: (req) => ({ year: req.registrationYear }), maxPerIp: 20 },
  ));

  app.get("/api/status", (req, res) => {
    try {
      res.json(publicStatus(parseCompetitionYear(req.query.year)));
    } catch (error) {
      logger.warn(req, "registration.status", { requestedYear: req.query.year, error: error.message });
      sendError(res, error, "REGISTRATION_STATUS_FAILED");
    }
  });

  app.post("/api/lookup", lookupRateLimit, (req, res) => {
    let year;
    let number;
    try {
      year = parseCompetitionYear(req.body?.year);
      number = parsePositiveInteger(req.body?.num, "엔트리 번호");
      const phone = normalizePhone(req.body?.phone);
      if (!phone) throw Object.assign(new Error("올바르지 않은 전화번호입니다."), { status: 400, code: "INVALID_PHONE" });

      const row = db.prepare(`
        SELECT q.id, q.team_id, q.status, q.registered_at, q.called_at,
               t.num, t.univ, t.name
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND t.num = ? AND q.phone = ?
          AND q.status IN ('waiting','called')
      `).get(year, number, phone);
      if (!row) {
        logger.warn(req, "registration.lookup", {
          reason: "not_found", year, number, phone: maskedPhone(phone),
        }, `${year}#${number}`);
        return res.status(404).json({ code: "REGISTRATION_NOT_FOUND", message: "대기 중인 등록 내역이 없습니다." });
      }

      const waitingTotal = db.prepare(`
        SELECT COUNT(*) AS count
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting'
      `).get(year).count;
      const position = row.status === "waiting"
        ? db.prepare(`
          SELECT COUNT(*) AS count
          FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
          WHERE t.year = ? AND q.status = 'waiting' AND q.id <= ?
        `).get(year, row.id).count
        : null;

      return res.json({
        teamId: row.team_id,
        number: row.num,
        university: row.univ,
        name: row.name,
        status: row.status,
        position,
        waitingTotal,
        registeredAt: row.registered_at,
        calledAt: row.called_at,
      });
    } catch (error) {
      logger.warn(req, "registration.lookup", {
        reason: "invalid_request", year, number, error: error.message,
      }, year && number ? `${year}#${number}` : "public");
      return sendError(res, error, "REGISTRATION_LOOKUP_FAILED");
    }
  });

  app.get("/api/team/:num", (req, res) => {
    let year;
    let number;
    try {
      year = parseCompetitionYear(req.query.year);
      number = parsePositiveInteger(req.params.num, "엔트리 번호");
      const team = options.teamStore.getByNumber(year, number, { includeInactive: false });
      if (!team) {
        logger.warn(req, "registration.team_lookup", {
          reason: "not_found", year, number,
        }, `${year}#${number}`);
        return res.status(404).json({ code: "TEAM_NOT_FOUND", message: "등록되지 않은 활성 엔트리 번호입니다." });
      }
      const active = db.prepare(`
        SELECT status FROM registration_queue
        WHERE team_id = ? AND status IN ('waiting','called')
      `).get(team.id);
      return res.json({ ...auditTeam(team), queueStatus: active?.status || null });
    } catch (error) {
      logger.warn(req, "registration.team_lookup", { year, number, error: error.message });
      return sendError(res, error, "REGISTRATION_TEAM_LOOKUP_FAILED");
    }
  });

  app.get("/api/queue", (req, res) => {
    let year;
    try {
      year = parseCompetitionYear(req.query.year);
      const waiting = db.prepare(`
        SELECT q.id, q.team_id AS teamId, t.num AS number, t.univ AS university, t.name,
               q.phone, q.registered_at AS registeredAt, q.notified
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting'
        ORDER BY q.id
      `).all(year).map((row, index) => ({ ...row, position: index + 1 }));
      const called = db.prepare(`
        SELECT q.id, q.team_id AS teamId, t.num AS number, t.univ AS university, t.name,
               q.phone, q.registered_at AS registeredAt, q.called_at AS calledAt
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'called'
        ORDER BY q.called_at, q.id
      `).all(year);
      const today = db.prepare(`
        SELECT
          COALESCE(SUM(q.status = 'done'), 0) AS done,
          COALESCE(SUM(q.status = 'canceled'), 0) AS canceled
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ?
          AND q.finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','+9 hours','start of day','-9 hours')
          AND q.finished_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','+9 hours','start of day','-9 hours','+1 day')
      `).get(year);
      return res.json({
        year,
        waiting,
        called,
        today: { done: today.done, canceled: today.canceled },
        settings: settingsForYear(year),
      });
    } catch (error) {
      logger.warn(req, "registration.queue_view", { year, error: error.message }, year && String(year));
      return sendError(res, error, "REGISTRATION_QUEUE_VIEW_FAILED");
    }
  });

  function finishAdvanceNotification(id, team, sent) {
    const result = dbRun(() => db.prepare(`
      UPDATE registration_queue
      SET notified = ?, notify_claimed_at = NULL
      WHERE id = ? AND notified = 2
    `).run(sent ? 1 : 0, id));
    if (!result.success) {
      logger.warn(null, "registration.sms_claim", {
        error: result.error, registrationId: id, team: auditTeam(team), sent,
      }, String(id));
    }
  }

  let lastSmsSkipWarning = 0;
  function warnSmsUnavailable(year) {
    const now = Date.now();
    if (now - lastSmsSkipWarning < 60_000) return;
    lastSmsSkipWarning = now;
    logger.warn(null, "registration.sms_skip", {
      reason: "sms_configuration_unavailable", year,
    }, String(year));
  }

  function dispatchSms({ kind, team, registrationId, phone, content, onSuccess, onFailure }) {
    const task = Promise.resolve().then(() => smsClient.send(phone, content)).then(
      ({ response, status }) => {
        onSuccess?.();
        logger.log(null, "registration.sms_send", {
          kind, registrationId, team: auditTeam(team), status, response,
        }, String(registrationId));
      },
      (error) => {
        onFailure?.();
        logger.warn(null, "registration.sms_send", {
          kind,
          registrationId,
          team: auditTeam(team),
          error: error?.response || error?.message || String(error),
          status: error?.status,
        }, String(registrationId));
      },
    );
    track(task);
  }

  function advanceTarget(year, rank) {
    return db.prepare(`
      SELECT q.id, q.team_id, q.phone, q.notified,
             t.year, t.num, t.univ, t.name, t.active
      FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
      WHERE t.year = ? AND q.status = 'waiting'
      ORDER BY q.id LIMIT 1 OFFSET ?
    `).get(year, rank - 1);
  }

  function notifyUpcoming(year, previousTargetId) {
    try {
      const settings = settingsForYear(year);
      if (!settings.sms || settings.notifyRank <= 0) return;
      if (!smsClient.isAvailable()) {
        warnSmsUnavailable(year);
        return;
      }

      const target = advanceTarget(year, settings.notifyRank);
      if (!target || target.id === previousTargetId || target.notified === 1) return;

      const claim = dbRun(() => db.prepare(`
        UPDATE registration_queue
        SET notified = 2, notify_claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status = 'waiting'
          AND (notified = 0 OR (
            notified = 2 AND (
              notify_claimed_at IS NULL
              OR notify_claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')
            )
          ))
      `).run(target.id));
      if (!claim.success) {
        logger.warn(null, "registration.sms_claim", {
          error: claim.error, registrationId: target.id, teamId: target.team_id,
        }, String(target.id));
        return;
      }
      if (claim.result.changes !== 1) return;

      const team = {
        id: target.team_id,
        year: target.year,
        number: target.num,
        university: target.univ,
        name: target.name,
        active: target.active === 1,
      };
      dispatchSms({
        kind: "advance",
        team,
        registrationId: target.id,
        phone: target.phone,
        content: `${SMS_PREFIX(year)} 엔트리 ${target.num}번 등록 대기 ${settings.notifyRank}번째입니다. 등록 데스크 근처에서 대기하세요.`,
        onSuccess: () => finishAdvanceNotification(target.id, team, true),
        onFailure: () => finishAdvanceNotification(target.id, team, false),
      });
    } catch (error) {
      logger.warn(null, "registration.sms_prepare", {
        error: error?.message || String(error), year,
      }, String(year));
    }
  }

  app.post("/api/queue", (req, res) => {
    let team;
    let phone;
    try {
      const teamId = parsePositiveInteger(req.body?.teamId, "팀 ID");
      phone = normalizePhone(req.body?.phone);
      if (!phone) throw Object.assign(new Error("올바르지 않은 전화번호입니다."), { status: 400, code: "INVALID_PHONE" });
      team = options.teamStore.getById(teamId);
      if (!team || !team.active) {
        logger.warn(req, "registration.register", {
          reason: "inactive_or_missing_team", teamId,
        }, String(teamId));
        return res.status(409).json({ code: "TEAM_INACTIVE", message: "현재 등록 가능한 활성 팀이 아닙니다." });
      }
      assertCurrentCompetitionYear(team.year);
      const settings = settingsForYear(team.year);
      if (!settings.open) {
        logger.warn(req, "registration.register", {
          reason: "closed", team: auditTeam(team),
        }, String(team.id));
        return res.status(403).json({ code: "REGISTRATION_CLOSED", message: "지금은 등록 대기 접수를 받지 않습니다." });
      }
      const active = db.prepare(`
        SELECT id, status FROM registration_queue
        WHERE team_id = ? AND status IN ('waiting','called')
      `).get(team.id);
      if (active) {
        logger.warn(req, "registration.register", {
          reason: "duplicate", team: auditTeam(team), existingStatus: active.status,
        }, String(team.id));
        return res.status(409).json({
          code: "REGISTRATION_ALREADY_ACTIVE",
          message: active.status === "called"
            ? "이미 호출된 엔트리입니다. 등록 데스크로 오세요."
            : "이미 대기 중인 엔트리입니다.",
        });
      }

      const result = dbRun(() => db.prepare(`
        INSERT INTO registration_queue (team_id, phone) VALUES (?, ?)
      `).run(team.id, phone));
      if (!result.success) {
        logger.warn(req, "registration.register", {
          error: result.error, team: auditTeam(team), phone: maskedPhone(phone),
        }, String(team.id));
        return res.status(result.status).json({ code: "REGISTRATION_CREATE_FAILED", message: result.error });
      }
      const id = Number(result.result.lastInsertRowid);
      const position = db.prepare(`
        SELECT COUNT(*) AS count
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting' AND q.id <= ?
      `).get(team.year, id).count;
      const waitingTotal = db.prepare(`
        SELECT COUNT(*) AS count
        FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
        WHERE t.year = ? AND q.status = 'waiting'
      `).get(team.year).count;

      logger.log(req, "registration.register", {
        registrationId: id,
        team: auditTeam(team),
        phone: maskedPhone(phone),
        position,
      }, String(id));
      broadcastChange(team.year);
      return res.status(201).json({
        id,
        teamId: team.id,
        number: team.number,
        university: team.university,
        name: team.name,
        position,
        waitingTotal,
      });
    } catch (error) {
      logger.warn(req, "registration.register", {
        error: error.message, team: auditTeam(team), phone: maskedPhone(phone),
      }, team ? String(team.id) : "registration");
      return sendError(res, error, "REGISTRATION_CREATE_FAILED");
    }
  });

  function transition(req, res, { from, to, timestampColumn, action, sendCallSms = false }) {
    let row;
    try {
      const id = parsePositiveInteger(req.params.id, "대기 ID");
      row = registrationRow(id);
      if (!row) {
        logger.warn(req, action, {
          reason: "not_found", registrationId: id, requested: to,
        }, String(id));
        return res.status(404).json({ code: "REGISTRATION_NOT_FOUND", message: "대기 내역을 찾을 수 없습니다." });
      }
      assertCurrentCompetitionYear(row.year);
      if (!from.includes(row.status)) {
        logger.warn(req, action, {
          reason: "invalid_status", registrationId: row.id, status: row.status, teamId: row.team_id,
        }, String(row.id));
        return res.status(409).json({ code: "REGISTRATION_ALREADY_PROCESSED", message: "이미 처리된 대기 내역입니다." });
      }

      const previousAdvanceTargetId = row.status === "waiting"
        ? advanceTarget(row.year, settingsForYear(row.year).notifyRank)?.id
        : undefined;

      const placeholders = from.map(() => "?").join(",");
      const result = dbRun(() => db.prepare(`
        UPDATE registration_queue
        SET status = ?, ${timestampColumn} = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status IN (${placeholders})
      `).run(to, row.id, ...from));
      if (!result.success) {
        logger.warn(req, action, {
          error: result.error, registrationId: row.id, teamId: row.team_id, before: row.status, requested: to,
        }, String(row.id));
        return res.status(result.status).json({ code: "REGISTRATION_TRANSITION_FAILED", message: result.error });
      }
      if (result.result.changes !== 1) {
        const latest = registrationRow(row.id);
        logger.warn(req, action, {
          reason: "concurrent_transition", registrationId: row.id,
          teamId: row.team_id, before: row.status, actual: latest?.status,
        }, String(row.id));
        return res.status(409).json({ code: "REGISTRATION_CONFLICT", message: "다른 요청에서 먼저 처리된 대기 내역입니다." });
      }

      const team = {
        id: row.team_id,
        year: row.year,
        number: row.num,
        university: row.univ,
        name: row.name,
        active: row.active === 1,
      };
      logger.log(req, action, {
        registrationId: row.id,
        team: auditTeam(team),
        before: row.status,
        after: to,
      }, String(row.id));

      if (sendCallSms && settingsForYear(row.year).sms) {
        if (smsClient.isAvailable()) {
          dispatchSms({
            kind: "call",
            team,
            registrationId: row.id,
            phone: row.phone,
            content: `${SMS_PREFIX(row.year)} 엔트리 ${row.num}번 등록 차례입니다. 등록 데스크로 오세요.`,
          });
        } else {
          warnSmsUnavailable(row.year);
        }
      }
      if (row.status === "waiting") notifyUpcoming(row.year, previousAdvanceTargetId);
      broadcastChange(row.year);
      return res.status(200).json({ id: row.id, status: to });
    } catch (error) {
      logger.warn(req, action, {
        error: error.message,
        registrationId: row?.id || req.params.id,
        teamId: row?.team_id,
        before: row?.status,
        requested: to,
      }, String(row?.id || req.params.id));
      return sendError(res, error, "REGISTRATION_TRANSITION_FAILED");
    }
  }

  app.post("/api/queue/:id/call", (req, res) => transition(req, res, {
    from: ["waiting"], to: "called", timestampColumn: "called_at",
    action: "registration.call", sendCallSms: true,
  }));
  app.post("/api/queue/:id/done", (req, res) => transition(req, res, {
    from: ACTIVE_STATUSES, to: "done", timestampColumn: "finished_at", action: "registration.done",
  }));
  app.post("/api/queue/:id/cancel", (req, res) => transition(req, res, {
    from: ACTIVE_STATUSES, to: "canceled", timestampColumn: "finished_at", action: "registration.cancel",
  }));

  app.get("/api/settings", (req, res) => {
    try {
      res.json(settingsForYear(parseCompetitionYear(req.query.year)));
    } catch (error) {
      logger.warn(req, "registration.settings_view", { requestedYear: req.query.year, error: error.message });
      sendError(res, error, "REGISTRATION_SETTINGS_FAILED");
    }
  });

  app.patch("/api/settings", (req, res) => {
    let year;
    try {
      year = assertCurrentCompetitionYear(req.body?.year);
      const changes = {};
      if (Object.hasOwn(req.body || {}, "open")) {
        if (typeof req.body.open !== "boolean") throw Object.assign(new Error("open은 불리언이어야 합니다."), { status: 400 });
        changes.open = req.body.open ? 1 : 0;
      }
      if (Object.hasOwn(req.body || {}, "sms")) {
        if (typeof req.body.sms !== "boolean") throw Object.assign(new Error("sms는 불리언이어야 합니다."), { status: 400 });
        if (req.body.sms && !smsClient.isAvailable()) {
          logger.warn(req, "registration.settings_update", {
            reason: "sms_configuration_unavailable", year, requested: { sms: true },
          }, String(year));
          return res.status(400).json({
            code: "SMS_CONFIGURATION_UNAVAILABLE",
            message: "SMS 설정이 되어 있지 않습니다. 이메일/SMS 서비스에서 설정해 주세요.",
          });
        }
        changes.sms = req.body.sms ? 1 : 0;
      }
      if (Object.hasOwn(req.body || {}, "notifyRank")) {
        const rank = Number(req.body.notifyRank);
        if (!Number.isInteger(rank) || rank < 1 || rank > 10) {
          throw Object.assign(new Error("사전 안내 순번은 1~10 사이여야 합니다."), { status: 400 });
        }
        changes.notify_rank = rank;
      }
      if (!Object.keys(changes).length) throw Object.assign(new Error("변경할 설정이 없습니다."), { status: 400 });

      const before = settingsForYear(year);
      const result = dbRun(() => db.transaction(() => {
        db.prepare(`
          INSERT OR IGNORE INTO registration_settings (year, open, sms, notify_rank)
          VALUES (?, 0, 0, 3)
        `).run(year);
        const columns = Object.keys(changes);
        db.prepare(`
          UPDATE registration_settings
          SET ${columns.map((column) => `${column} = ?`).join(", ")},
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE year = ?
        `).run(...columns.map((column) => changes[column]), year);
      })());
      if (!result.success) {
        logger.warn(req, "registration.settings_update", { error: result.error, year, before, requested: req.body }, String(year));
        return res.status(result.status).json({ code: "REGISTRATION_SETTINGS_FAILED", message: result.error });
      }
      const after = settingsForYear(year);
      logger.log(req, "registration.settings_update", { year, before, after }, String(year));
      broadcastChange(year);
      return res.json(after);
    } catch (error) {
      logger.warn(req, "registration.settings_update", { error: error.message, year, requested: req.body }, String(year || "settings"));
      return sendError(res, error, "REGISTRATION_SETTINGS_FAILED");
    }
  });

  function sourceEvent(event, data) {
    if (event === "entries" && data?.year) broadcastChange(data.year);
  }

  if (!options.skipSpaFallback) addSpaFallback(app);

  return {
    app,
    db,
    loadSmsConfig: smsClient.loadConfig || (async () => smsClient.isAvailable()),
    closeSse,
    sourceEvent,
    drain: () => Promise.allSettled([...pendingTasks]),
    hasPendingTasks: () => pendingTasks.size > 0,
    timers: [rateLimitTimer, ...(smsClient.timer ? [smsClient.timer] : [])],
  };
}
