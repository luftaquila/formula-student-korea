import { createSSEManager } from "../../../../../shared/server/sse.mjs";

export function createQueueEvents({ logger, getActiveInspections, getBoothsForType, inspections }) {
  /* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
  const {
    broadcast: broadcastEvent,
    handler: sseHandler,
    close: closeSse,
  } = createSSEManager(200, { logger });

  // SSE 브로드캐스트 헬퍼 — 대기열/부스/활성검차 변경을 일관된 페이로드로 전파한다.
  function broadcastQueue(type) {
    broadcastEvent("queue", { type, activeInspections: getActiveInspections() });
  }

  function broadcastBooth(type) {
    broadcastEvent("booth", { type, booths: getBoothsForType(type) });
  }

  function broadcastInspections() {
    broadcastEvent("inspections", { activeInspections: getActiveInspections() });
  }

  function broadcastPenalties() {
    // SSE endpoint is public, so only broadcast an invalidation signal. Authorized
    // clients fetch the protected penalty list separately.
    broadcastEvent("penalties", {});
  }

  function sourceEvent(event, data) {
    broadcastEvent(event, data);
    if (event !== "entries") return;
    // TeamStore applies renumber/deactivation cleanup before this callback. Reuse
    // the module's existing invalidations so open clients also discard queue and
    // booth state that referred to the previous canonical team row.
    broadcastEvent("queue", { type: null, activeInspections: getActiveInspections() });
    for (const type of Object.keys(inspections)) broadcastBooth(type);
  }

  return {
    broadcastEvent,
    sseHandler,
    closeSse,
    broadcastQueue,
    broadcastBooth,
    broadcastInspections,
    broadcastPenalties,
    sourceEvent,
  };
}
