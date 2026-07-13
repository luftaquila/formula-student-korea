import { runMigrationOnce, normalizeUtcTextTimestamp } from "./db-setup.mjs";
import { createSecretChecker } from "./express-setup.mjs";

// logs 테이블 필터 쿼리 파라미터(level/action/actor/from/to/search)를 WHERE 절과
// 바인딩 파라미터로 변환한다. queryHandler와 auth의 로그 집계 로컬 쿼리가 공유한다.
// 쿼리 파라미터가 중복 지정되어 배열로 오는 경우(?level=a&level=b)도 안전하게 처리.
export function buildLogFilter(query) {
  const str = (v) => (Array.isArray(v) ? v.join(",") : v == null ? "" : String(v));
  const conditions = [];
  const params = [];

  const level = str(query.level);
  if (level) {
    const levels = level.split(",").map(l => l.trim()).filter(Boolean);
    if (levels.length) {
      conditions.push(`level IN (${levels.map(() => "?").join(",")})`);
      params.push(...levels);
    }
  }
  const action = str(query.action);
  if (action) {
    conditions.push("action LIKE ?");
    params.push(action + "%");
  }
  const actor = str(query.actor);
  if (actor) {
    conditions.push("(actor_email LIKE ? OR actor_name LIKE ?)");
    params.push(`%${actor}%`, `%${actor}%`);
  }
  const from = str(query.from);
  if (from) {
    conditions.push("timestamp >= ?");
    params.push(from);
  }
  const to = str(query.to);
  if (to) {
    conditions.push("timestamp <= ?");
    params.push(to);
  }
  const search = str(query.search);
  if (search) {
    conditions.push("(action LIKE ? OR target LIKE ? OR detail LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

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
      const normalized = normalizeUtcTextTimestamp(row.timestamp);
      if (normalized && normalized !== row.timestamp) update.run(normalized, row.id);
    }
  });

  function getIP(req) {
    // Caddy가 세팅한 신뢰 X-Real-IP 우선, 없으면 X-Forwarded-For 최좌측 → req.ip 폴백.
    return req.headers["x-real-ip"]?.trim() || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
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
  setInterval(cleanup, 3600000).unref();

  const isInternalSecret = createSecretChecker(process.env.INTERNAL_SECRET);

  // Query handler (used as Express route handler for GET /api/logs)
  function queryHandler(req, res) {
    // Auth check: admin or internal service
    const isInternal = isInternalSecret(req.headers["x-internal-service"]);
    if (!isInternal && req.user?.role !== "admin") {
      return res.status(403).send("권한이 없습니다.");
    }

    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const offset = Number(req.query.offset) || 0;

    const { where, params } = buildLogFilter(req.query);

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
