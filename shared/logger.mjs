import { runMigrationOnce, normalizeUtcTextTimestamp, setupRowCapRetention } from "./db-setup.mjs";
import { createSecretChecker } from "./express-setup.mjs";
import { currentCompetitionYear } from "./competition-year.mjs";

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function competitionYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2099 ? year : null;
}

function normalizeAuditTeam(team, fallback = {}) {
  if (!team || typeof team !== "object" || Array.isArray(team)) return null;
  const number = positiveInteger(team.number ?? team.num ?? team.team_num ?? fallback.number);
  const university = team.university ?? team.univ;
  const name = team.name ?? team.team;
  if (!number || typeof university !== "string" || !university.trim()
      || typeof name !== "string" || !name.trim()) return null;

  const id = positiveInteger(team.id ?? team.teamId ?? team.team_id ?? fallback.id);
  const year = competitionYear(team.year ?? fallback.year);
  return {
    ...(id ? { id } : {}),
    ...(year ? { year } : {}),
    number,
    university: university.trim(),
    name: name.trim(),
    ...(typeof team.active === "boolean" ? { active: team.active } : {}),
  };
}

function teamReferenceYear(detail) {
  if (!detail || typeof detail !== "object") return currentCompetitionYear();
  for (const key of ["year", "state_year", "session_year", "record_year", "current_year"]) {
    if (Object.hasOwn(detail, key) && detail[key] != null && detail[key] !== "") {
      return competitionYear(detail[key]);
    }
  }
  return currentCompetitionYear();
}

function targetTeamReference(target, fallbackYear) {
  if (typeof target !== "string") return null;
  let match = target.match(/^(\d{4})#(\d+)$/);
  if (match) {
    const year = competitionYear(match[1]);
    const number = positiveInteger(match[2]);
    return year && number ? { year, number } : null;
  }
  match = target.match(/^#(\d+)$/);
  return match ? { year: fallbackYear, number: positiveInteger(match[1]) } : null;
}

function teamObjectReference(value, fallbackYear) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    id: value.id ?? value.teamId ?? value.team_id,
    year: value.year ?? fallbackYear,
    number: value.number ?? value.num ?? value.team_num,
  };
}

function collectTeamReferences(detail, target) {
  const year = teamReferenceYear(detail);
  const refs = [];
  const add = (reference) => {
    const normalized = {
      id: positiveInteger(reference?.id),
      year: competitionYear(reference?.year) ?? year,
      number: positiveInteger(reference?.number),
    };
    if (!normalized.id && !normalized.number) return;
    if (normalized.number && !normalized.year && !normalized.id) return;
    const existing = refs.find((candidate) => {
      if (normalized.id && candidate.id) return candidate.id === normalized.id;
      return normalized.number && candidate.number === normalized.number
        && candidate.year === normalized.year;
    });
    if (existing) {
      existing.id ??= normalized.id;
      existing.year ??= normalized.year;
      existing.number ??= normalized.number;
      return;
    }
    refs.push(normalized);
  };

  const targetReference = targetTeamReference(target, year);
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    add(targetReference);
    return refs;
  }

  const directId = detail.team_id ?? detail.teamId;
  const directNumber = detail.team_num ?? detail.entry_num ?? detail.num ?? detail.number;
  add({
    id: directId,
    year,
    number: directNumber ?? (directId ? targetReference?.number : null),
  });
  for (const value of [detail.team, detail.entry]) add(teamObjectReference(value, year));
  for (const state of [detail.before, detail.after]) {
    if (!state || typeof state !== "object" || Array.isArray(state)) continue;
    for (const value of [state.team, state.entry]) add(teamObjectReference(value, year));
  }
  add(targetReference);
  for (const key of ["sub_team", "my_team"]) add({ year, number: detail[key] });
  for (const key of ["before_teams", "after_teams", "team_numbers"]) {
    if (Array.isArray(detail[key])) {
      for (const number of detail[key]) add({ year, number });
    }
  }
  for (const key of ["deleted_submissions", "file_cleanup"]) {
    if (Array.isArray(detail[key])) {
      for (const item of detail[key]) add({
        id: item?.team_id ?? item?.teamId,
        year: item?.year ?? year,
        number: item?.team_num ?? item?.entry_num ?? item?.num,
      });
    }
  }
  if (Array.isArray(detail.teams)) {
    for (const value of detail.teams) {
      if (typeof value === "object" && value) {
        add(teamObjectReference(value, year));
      } else {
        add({ year, number: value });
      }
    }
  }
  return refs;
}

function resolveAuditTeam(teamSource, reference) {
  if (!teamSource || !reference) return null;
  try {
    let team = null;
    if (reference.id && typeof teamSource.getById === "function") {
      team = teamSource.getById(reference.id);
    }
    if (!team && reference.number && reference.year && typeof teamSource.getByNumber === "function") {
      team = teamSource.getByNumber(reference.year, reference.number, { includeInactive: true });
    }
    if (!team && reference.number && reference.year && typeof teamSource.moduleEntries === "function") {
      const entries = teamSource.moduleEntries(reference.year, { includeInactive: true });
      team = entries?.[reference.number] ?? null;
    }
    return normalizeAuditTeam(team, reference);
  } catch {
    // Team lookup failures must not suppress the original audit event. The
    // caller's own failure log remains writable even when canonical lookup is
    // the operation that failed.
    return null;
  }
}

function enrichTeamDetail(detail, target, teamSource) {
  if (!teamSource) return detail;
  const objectDetail = detail == null
    ? {}
    : (typeof detail === "object" && !Array.isArray(detail) ? detail : null);
  if (!objectDetail) return detail;

  const resolved = collectTeamReferences(objectDetail, target)
    .map((reference) => resolveAuditTeam(teamSource, reference))
    .filter(Boolean);
  const teams = [];
  for (const team of resolved) {
    if (teams.some((candidate) => (
      team.id && candidate.id === team.id
    ) || (candidate.year === team.year && candidate.number === team.number))) continue;
    teams.push(team);
  }
  if (!teams.length) return detail;
  if (teams.length === 1) {
    if (Object.hasOwn(objectDetail, "team")) return { ...objectDetail, team: teams[0] };
    return { team: teams[0], ...objectDetail };
  }
  return { ...objectDetail, teams };
}

// logs 테이블 필터 쿼리 파라미터(level/action/actor/from/to/search)를 WHERE 절과
// 바인딩 파라미터로 변환한다. queryHandler와 auth의 로그 집계 로컬 쿼리가 공유한다.
// 쿼리 파라미터가 중복 지정되어 배열로 오는 경우(?level=a&level=b)도 안전하게 처리.
export function buildLogFilter(query, { module = null } = {}) {
  const str = (v) => (Array.isArray(v) ? v.join(",") : v == null ? "" : String(v));
  const conditions = [];
  const params = [];

  if (module) {
    conditions.push("module = ?");
    params.push(module);
  }

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

export function createLogger(db, serviceName, maxRows = 50000, { teamSource } = {}) {
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
  const logColumns = db.prepare("PRAGMA table_info(logs)").all();
  if (!logColumns.some((column) => column.name === "module")) {
    db.exec("ALTER TABLE logs ADD COLUMN module TEXT");
  }
  // Databases created before the shared module column contain logs from the
  // factory that opened them, so backfill that known module deterministically.
  db.prepare("UPDATE logs SET module = ? WHERE module IS NULL OR module = ''").run(serviceName);
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_action ON logs(action)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_module_timestamp ON logs(module, timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_logs_module_id ON logs(module, id)");

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
    const enrichedDetail = enrichTeamDetail(detail, target, teamSource);
    const detailStr = enrichedDetail != null
      ? (typeof enrichedDetail === "string" ? enrichedDetail : JSON.stringify(enrichedDetail))
      : null;
    try {
      db.prepare(
        "INSERT INTO logs (module, level, action, actor_email, actor_name, actor_role, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(serviceName, level, action, actor.email || null, actor.name || null, actor.role || null, target || null, detailStr, req ? getIP(req) : null);
    } catch (e) {
      console.error(`[logger] write error: ${e.message}`);
    }
  }

  // 보존은 다른 row-cap 테이블(queue_log, booth_log 등)과 같은 AFTER INSERT 트리거로
  // 통일한다. 시간별 COUNT+DELETE sweep은 스윕 사이 무제한 초과를 허용했다. 통합 DB는
  // module별 한도를 독립 적용하고 (module, id) 인덱스로 각 파티션의 오래된 꼬리만 찾는다.
  setupRowCapRetention(db, "logs", maxRows, { partitionColumn: "module" });

  const isInternalSecret = createSecretChecker(process.env.INTERNAL_SECRET);

  // Query handler (used as Express route handler for GET /api/logs)
  function queryHandler(req, res) {
    // The route gate normally enforces this. Keep the handler safe when mounted
    // directly by a service test or future caller.
    const isInternal = isInternalSecret(req.headers["x-internal-service"]);
    const canAudit = req.user?.kind === "human" && req.user.role === "admin";
    if (!isInternal && !canAudit) {
      return res.status(403).send("권한이 없습니다.");
    }

    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const cursor = parseLogCursor(req.query.before);

    const { where, params } = buildLogFilter(req.query, { module: serviceName });

    // 정렬 키는 (timestamp DESC, id DESC)로 통일한다 — auth 집계의 병합 정렬 키와 같아야
    // keyset 커서가 페이지 경계에서 행을 빠뜨리거나 중복시키지 않는다. id는 rowid alias라
    // idx_logs_timestamp가 사실상 (timestamp, rowid) 복합 인덱스로 동작한다.
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM logs ${where}`).get(...params).cnt;
    // limit+1행을 가져와 초과분 존재 여부로 hasMore를 판정한다. logs.length === limit
    // 휴리스틱은 "정확히 limit개 매칭"과 "다음 페이지 있음"을 구분하지 못해, 딱 limit개인
    // 결과에서 다음 버튼이 열리고 빈 2페이지가 나온다.
    let logs;
    if (cursor) {
      const cond = `${where ? `${where} AND` : "WHERE"} (timestamp, id) < (?, ?)`;
      logs = db.prepare(`SELECT * FROM logs ${cond} ORDER BY timestamp DESC, id DESC LIMIT ?`)
        .all(...params, cursor.ts, cursor.id, limit + 1);
    } else {
      // offset은 레거시 호환(내부 소비자 전환기)용. 커서가 오면 무시된다.
      const offset = Number(req.query.offset) || 0;
      logs = db.prepare(`SELECT * FROM logs ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit + 1, offset);
    }

    const hasMore = logs.length > limit;
    if (hasMore) logs.length = limit;
    const last = logs[logs.length - 1];
    res.json({
      logs, total, service: serviceName,
      nextCursor: hasMore && last ? `${last.timestamp},${last.id}` : null,
      hasMore,
    });
  }

  return {
    log: (req, action, detail, target, actorOverride) => write("info", req, action, detail, target, actorOverride),
    warn: (req, action, detail, target, actorOverride) => write("warn", req, action, detail, target, actorOverride),
    queryHandler,
  };
}
