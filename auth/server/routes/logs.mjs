import { buildLogFilter, parseLogCursor } from "../../../shared/server/logger.mjs";

export function registerLogsRoutes({
  app,
  logFilterHash,
  decodeAggCursor,
  LOG_SERVICES,
  db,
  logger,
  warnAggThrottled,
  encodeAggCursor,
}) {
  // GET /api/admin/logs - 전체 서비스 로그 집계 (keyset 커서 k-way 병합)
  // 예전 offset 방식은 서비스당 fetch 상한(2000행) 너머에서 빈 페이지를 돌려주면서
  // total은 더 있다고 말했고, 원격 정렬 키(id)와 병합 정렬 키(timestamp)가 달라 페이지
  // 경계에서 행이 어긋날 수 있었다. 커서는 페이지 깊이와 무관하게 서비스당 limit행만
  // 가져오고, 정렬 키를 (timestamp, id)로 양쪽에서 통일한다.
  app.get("/api/admin/logs", async (req, res) => {
    const { service, limit: qLimit, cursor: qCursor, offset: _qOffset, ...filters } = req.query;
    const limit = Math.max(1, Math.min(Number(qLimit) || 100, 500));
    const filterHash = logFilterHash(service, filters);

    let cursors = {};
    if (qCursor) {
      const token = decodeAggCursor(qCursor);
      if (!token) return res.status(400).send("올바르지 않은 cursor입니다.");
      if (token.f !== filterHash)
        return res.status(400).send("cursor가 현재 필터와 일치하지 않습니다.");
      cursors = token.c;
    }

    // Determine which services to query
    const targetServices = service
      ? Object.fromEntries(
          service
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            // 모르는 이름을 거른다. 안 거르면 url이 undefined인 채로 아래 템플릿에 들어가
            // "undefined/api/logs"로 fetch 한다(documents에서 고친 것과 같은 패턴).
            .filter((name) => name === "auth" || LOG_SERVICES[name])
            .map((name) => [name, name === "auth" ? null : LOG_SERVICES[name]]),
        )
      : { auth: null, ...LOG_SERVICES };

    const fetches = Object.entries(targetServices).map(async ([name, url]) => {
      const before = typeof cursors[name] === "string" ? cursors[name] : null;
      if (name === "auth") {
        // Local query (no HTTP) — 원격 queryHandler와 동일한 keyset SQL.
        // limit+1행으로 hasMore를 판정한다(정확히 limit개 매칭 ≠ 다음 페이지 있음).
        try {
          const { where, params } = buildLogFilter(filters);
          const total = db.prepare(`SELECT COUNT(*) as cnt FROM logs ${where}`).get(...params).cnt;
          const parsed = parseLogCursor(before);
          let logs;
          if (parsed) {
            const cond = `${where ? `${where} AND` : "WHERE"} (timestamp, id) < (?, ?)`;
            logs = db
              .prepare(`SELECT * FROM logs ${cond} ORDER BY timestamp DESC, id DESC LIMIT ?`)
              .all(...params, parsed.ts, parsed.id, limit + 1);
          } else {
            logs = db
              .prepare(`SELECT * FROM logs ${where} ORDER BY timestamp DESC, id DESC LIMIT ?`)
              .all(...params, limit + 1);
          }
          const hasMore = logs.length > limit;
          if (hasMore) logs.length = limit;
          return { name, logs: logs.map((l) => ({ ...l, _service: name })), total, hasMore };
        } catch (e) {
          logger.warn(null, "logs.query_failed", { error: e.message }, "auth");
          return { name, logs: [], total: 0, hasMore: false, failed: true };
        }
      }

      try {
        const qs = new URLSearchParams();
        qs.set("limit", String(limit));
        if (before) qs.set("before", before);
        for (const [k, v] of Object.entries(filters)) {
          if (v) qs.set(k, v);
        }
        const fetchRes = await fetch(`${url}?${qs}`, {
          headers: { "X-Internal-Service": process.env.INTERNAL_SECRET || "" },
          signal: AbortSignal.timeout(5000),
        });
        if (!fetchRes.ok) {
          warnAggThrottled(
            "logs.aggregate_failed",
            { service: name, status: fetchRes.status },
            name,
          );
          return { name, logs: [], total: 0, hasMore: false, failed: true };
        }
        const data = await fetchRes.json();
        return {
          name,
          logs: (data.logs || []).map((l) => ({ ...l, _service: name })),
          total: data.total || 0,
          hasMore: !!data.hasMore,
        };
      } catch (e) {
        warnAggThrottled("logs.aggregate_failed", { service: name, error: e.message }, name);
        return { name, logs: [], total: 0, hasMore: false, failed: true };
      }
    });

    const allResults = await Promise.all(fetches);

    // k-way 병합: (timestamp DESC, id DESC, service ASC) — 서비스 간 (ts,id) 충돌까지
    // 결정적으로 갈라야 커서 재개가 안정적이다.
    const merged = [];
    let totalSum = 0;
    for (const r of allResults) {
      merged.push(...r.logs);
      totalSum += r.total;
    }
    merged.sort(
      (a, b) =>
        (b.timestamp || "").localeCompare(a.timestamp || "") ||
        (b.id || 0) - (a.id || 0) ||
        (a._service || "").localeCompare(b._service || ""),
    );

    const paged = merged.slice(0, limit);

    // 서비스별 다음 커서: 이번 페이지에서 소비된 마지막 행의 키. 하나도 소비되지 않았거나
    // 실패한 서비스는 이전 커서를 그대로 물려받아, 그 행들이 다음 페이지(또는 복구 후)에
    // 다시 표면화된다.
    const nextCursors = { ...cursors };
    const consumedCount = new Map();
    for (const row of paged) {
      nextCursors[row._service] = `${row.timestamp},${row.id}`;
      consumedCount.set(row._service, (consumedCount.get(row._service) || 0) + 1);
    }
    const hasMore =
      merged.length > limit ||
      allResults.some((r) => r.hasMore && (consumedCount.get(r.name) || 0) === r.logs.length);

    res.json({
      logs: paged,
      total: totalSum,
      nextCursor: hasMore ? encodeAggCursor(filterHash, nextCursors) : null,
      hasMore,
      services: Object.keys(targetServices),
    });
  });
}
