export function createRetentionService({
  db,
  logger,
  SYS_ACTOR,
  broadcastEvent,
  getSession,
  pruneWirelessEvents,
  RETAIN_EVENTS,
  liveTelemetry,
}) {
  // lease 만료 정리: 만료된 controller를 비우고 해당 경기 세션을 브로드캐스트(전 클라가 read-only 해제 인지).
  function runLeaseWatch() {
    try {
      const expired = db
        .prepare(
          "SELECT event_type, controller, lease_expires_at FROM wireless_session WHERE controller IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
        )
        .all(new Date().toISOString());
      for (const before of expired) {
        const update = db
          .prepare(
            "UPDATE wireless_session SET controller = NULL, lease_expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_type = ? AND controller = ? AND lease_expires_at = ?",
          )
          .run(before.event_type, before.controller, before.lease_expires_at);
        if (update.changes !== 1) continue;
        logger.log(
          null,
          "wireless.lease.expire",
          {
            event_type: before.event_type,
            before: { controller: before.controller, lease_expires_at: before.lease_expires_at },
            after: { controller: null, lease_expires_at: null },
          },
          before.event_type,
          SYS_ACTOR,
        );
        broadcastEvent("wireless:session", getSession(before.event_type));
      }
      return { skipped: false, expired: expired.length };
    } catch (e) {
      logger.warn(
        null,
        "wireless.lease.watch",
        { error: e.message || String(e) },
        "lease",
        SYS_ACTOR,
      );
      // try 본문이 DB 작업이라 위 logger INSERT도 같이 실패했을 수 있다 — 콘솔 폴백 유지(정책 예외).
      console.error("[wireless] lease watch:", e.message || e);
    }
    return { skipped: false, expired: 0 };
  }

  const leaseWatch = setInterval(runLeaseWatch, 5000);

  // 무선 이벤트 보존 한도(약 50만 행). 백그라운드 트림.
  function runEventRetention() {
    try {
      const result = pruneWirelessEvents();
      if (result.removed > 0) {
        logger.log(
          null,
          "wireless.event.retention",
          {
            cutoff_id: result.cutoff,
            removed: result.removed,
            retained_limit: RETAIN_EVENTS,
          },
          "wireless_event",
          SYS_ACTOR,
        );
      }
      return { skipped: false, ...result };
    } catch (e) {
      logger.warn(
        null,
        "wireless.event.retention",
        { error: e.message || String(e) },
        "wireless_event",
        SYS_ACTOR,
      );
      // try 본문이 DB 작업이라 위 logger INSERT도 같이 실패했을 수 있다 — 콘솔 폴백 유지(정책 예외).
      console.error("[wireless] event retention:", e.message || e);
    }
    return { skipped: false, removed: 0, cutoff: null };
  }

  const eventRetention = setInterval(runEventRetention, 60000);

  // liveTelemetry TTL 정리: 오래 안 보인 node 항목을 제거해 무한 성장(임의 node_id 유입)과
  // SSE init 페이로드 비대를 막는다. wireless_event와 달리 실시간 상태라 짧게 유지.
  const LIVE_TELEMETRY_TTL_MS = 10 * 60 * 1000;

  const telemetryRetention = setInterval(() => {
    const cutoff = Date.now() - LIVE_TELEMETRY_TTL_MS;
    for (const [node, t] of liveTelemetry) {
      const seen = Date.parse(t.last_seen || "");
      if (!Number.isFinite(seen) || seen < cutoff) liveTelemetry.delete(node);
    }
  }, 60000);

  return { runLeaseWatch, leaseWatch, runEventRetention, eventRetention, telemetryRetention };
}
