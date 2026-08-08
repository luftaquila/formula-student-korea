import { runMigrationOnce, normalizeUtcTextTimestamp, setupRowCapRetention } from "./db-setup.mjs";
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

// keyset 커서 "<timestamp>,<id>" 파서. ISO 타임스탬프에는 콤마가 없으므로 마지막 콤마로
// 안전하게 분리한다. 형식이 어긋나면 null(= 커서 없음, 첫 페이지)로 조용히 폴백한다.
export function parseLogCursor(raw) {
  if (!raw) return null;
  const s = String(raw);
  const idx = s.lastIndexOf(",");
  if (idx < 1) return null;
  const id = Number(s.slice(idx + 1));
  return Number.isInteger(id) ? { ts: s.slice(0, idx), id } : null;
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

  // 보존은 다른 row-cap 테이블(queue_log, booth_log 등)과 같은 AFTER INSERT 트리거로
  // 통일한다. 시간별 COUNT+DELETE sweep은 스윕 사이 무제한 초과를 허용했고, 리포에
  // 보존 메커니즘이 두 벌 존재하게 만들었다. 트리거의 삽입당 비용은 PK MAX 조회 +
  // 대부분 no-op인 범위 DELETE라 이 시스템의 로그 쓰기 빈도에서 무시 가능하다.
  setupRowCapRetention(db, "logs", maxRows);

  const isInternalSecret = createSecretChecker(process.env.INTERNAL_SECRET);

  // Query handler (used as Express route handler for GET /api/logs)
  function queryHandler(req, res) {
    // Auth check: admin or internal service
    const isInternal = isInternalSecret(req.headers["x-internal-service"]);
    if (!isInternal && req.user?.role !== "admin") {
      return res.status(403).send("권한이 없습니다.");
    }

    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const cursor = parseLogCursor(req.query.before);

    const { where, params } = buildLogFilter(req.query);

    // 정렬 키는 (timestamp DESC, id DESC)로 통일한다 — auth 집계의 병합 정렬 키와 같아야
    // keyset 커서가 페이지 경계에서 행을 빠뜨리거나 중복시키지 않는다. id는 rowid alias라
    // idx_logs_timestamp가 사실상 (timestamp, rowid) 복합 인덱스로 동작한다.
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM logs ${where}`).get(...params).cnt;
    let logs;
    if (cursor) {
      const cond = `${where ? `${where} AND` : "WHERE"} (timestamp, id) < (?, ?)`;
      logs = db.prepare(`SELECT * FROM logs ${cond} ORDER BY timestamp DESC, id DESC LIMIT ?`)
        .all(...params, cursor.ts, cursor.id, limit);
    } else {
      // offset은 레거시 호환(내부 소비자 전환기)용. 커서가 오면 무시된다.
      const offset = Number(req.query.offset) || 0;
      logs = db.prepare(`SELECT * FROM logs ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    }

    const last = logs[logs.length - 1];
    res.json({
      logs, total, service: serviceName,
      nextCursor: logs.length === limit && last ? `${last.timestamp},${last.id}` : null,
      hasMore: logs.length === limit,
    });
  }

  return {
    log: (req, action, detail, target, actorOverride) => write("info", req, action, detail, target, actorOverride),
    warn: (req, action, detail, target, actorOverride) => write("warn", req, action, detail, target, actorOverride),
    queryHandler,
  };
}
