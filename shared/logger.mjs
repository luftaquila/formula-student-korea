import crypto from "crypto";
import { runMigrationOnce } from "./db-setup.mjs";

export function createLogger(db, serviceName, maxRows = 50000) {
  db.exec(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    level TEXT NOT NULL DEFAULT 'info',
    action TEXT NOT NULL,
    actor_email TEXT,
    actor_name TEXT,
    actor_role TEXT,
    target TEXT,
    detail TEXT,
    ip TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_action ON logs(action)");

  runMigrationOnce(db, "shared.logs_timestamp_utc_normalization.v1", () => {
    const rows = db.prepare("SELECT id, timestamp FROM logs WHERE timestamp IS NOT NULL AND timestamp != ''").all();
    const update = db.prepare("UPDATE logs SET timestamp = ? WHERE id = ?");
    for (const row of rows) {
      const s = String(row.timestamp);
      const text = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z";
      const d = new Date(text);
      if (!Number.isNaN(d.getTime())) {
        const normalized = d.toISOString();
        if (normalized !== row.timestamp) update.run(normalized, row.id);
      }
    }
  });

  function getIP(req) {
    return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  }

  function write(level, req, action, detail, target, actorOverride) {
    const actor = actorOverride || req?.user || {};
    const detailStr = detail != null ? (typeof detail === "string" ? detail : JSON.stringify(detail)) : null;
    try {
      db.prepare(
        "INSERT INTO logs (level, action, actor_email, actor_name, actor_role, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(level, action, actor.email || null, actor.name || null, actor.role || null, target || null, detailStr, req ? getIP(req) : null);
    } catch (e) {
      console.error(`[logger] write error: ${e.message}`);
    }
  }

  // Auto-cleanup: delete oldest rows beyond maxRows every hour
  const cleanup = () => {
    try {
      const count = db.prepare("SELECT COUNT(*) as cnt FROM logs").get().cnt;
      if (count > maxRows) {
        db.prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)").run(count - maxRows);
      }
    } catch (e) {
      console.error(`[logger] cleanup error: ${e.message}`);
    }
  };
  setInterval(cleanup, 3600000);

  // Pre-compute secret hash at init time
  const internalSecret = process.env.INTERNAL_SECRET;
  const cachedSecretHash = internalSecret
    ? crypto.createHash("sha256").update(internalSecret).digest()
    : null;

  // Query handler (used as Express route handler for GET /api/logs)
  function queryHandler(req, res) {
    // Auth check: admin or internal service
    const header = req.headers["x-internal-service"];
    let isInternal = false;
    if (cachedSecretHash && header) {
      const headerHash = crypto.createHash("sha256").update(header).digest();
      isInternal = headerHash.length === cachedSecretHash.length && crypto.timingSafeEqual(headerHash, cachedSecretHash);
    }

    if (!isInternal && req.user?.role !== "admin") {
      return res.status(403).send("권한이 없습니다.");
    }

    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const offset = Number(req.query.offset) || 0;

    const conditions = [];
    const params = [];

    if (req.query.level) {
      const levels = req.query.level.split(",").map(l => l.trim()).filter(Boolean);
      conditions.push(`level IN (${levels.map(() => "?").join(",")})`);
      params.push(...levels);
    }
    if (req.query.action) {
      conditions.push("action LIKE ?");
      params.push(req.query.action + "%");
    }
    if (req.query.actor) {
      conditions.push("(actor_email LIKE ? OR actor_name LIKE ?)");
      params.push(`%${req.query.actor}%`, `%${req.query.actor}%`);
    }
    if (req.query.from) {
      conditions.push("timestamp >= ?");
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push("timestamp <= ?");
      params.push(req.query.to);
    }
    if (req.query.search) {
      conditions.push("(action LIKE ? OR target LIKE ? OR detail LIKE ?)");
      params.push(`%${req.query.search}%`, `%${req.query.search}%`, `%${req.query.search}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM logs ${where}`).get(...params).cnt;
    const logs = db.prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

    res.json({ logs, total, service: serviceName });
  }

  return {
    log: (req, action, detail, target, actorOverride) => write("info", req, action, detail, target, actorOverride),
    warn: (req, action, detail, target, actorOverride) => write("warn", req, action, detail, target, actorOverride),
    queryHandler,
  };
}
