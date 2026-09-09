import { createSSEManager } from "../../../../../shared/server/sse.mjs";

export function createScoreEvents({
  logger,
  parseScoreYear,
  invalidatePublicScoreCache,
  invalidateInflightScore,
  isScorePublished,
}) {
  /* ============================================
   SSE (Server-Sent Events) 설정
   ============================================ */
  const {
    broadcast: broadcastAdminEvent,
    handler: sseHandler,
    close: closeAdminSse,
  } = createSSEManager(200, { logger });

  const {
    broadcast: broadcastPublicEvent,
    handler: publicSseHandler,
    close: closePublicSse,
  } = createSSEManager(500, { logger });

  // 관리자에게는 원본 이벤트를, 공개 페이지에는 데이터가 없는 refresh 신호만 보낸다.
  // 공개 클라이언트가 관리자용 SSE 페이로드를 통해 숨긴 열의 값을 받지 않도록 스트림을 분리한다.
  function broadcastEvent(event, data) {
    broadcastAdminEvent(event, data);
    const eventYear = parseScoreYear(data?.year);
    invalidatePublicScoreCache(eventYear);
    // 변경 전 스냅샷으로 시작한 집계를 이벤트 직후의 관리자 재조회가
    // 재사용하지 않게 한다. 기존 요청은 완료하되, 다음 요청은 새 집계를 시작한다.
    invalidateInflightScore(eventYear);
    broadcastPublicEvent("refresh", {}, (meta) => {
      if (!isScorePublished(meta.year)) return false;
      return eventYear == null || meta.year === eventYear;
    });
  }

  const handlePublicSSE = publicSseHandler((req) => ({ year: Number(req.params.year) }), {
    meta: (req) => ({ year: Number(req.params.year) }),
    revalidate: (meta) => (isScorePublished(meta.year) ? meta : null),
    // 공개 스트림이므로 단일 IP가 전체 연결 슬롯을 점유하지 못하게 제한한다.
    maxPerIp: 10,
  });

  const SOURCE_EVENT_ALLOWLIST = {
    entry: new Set(["entries"]),
    inspection: new Set(["category-result", "answer"]),
    traffic: new Set(["records", "record-visibility", "event-mode"]),
  };

  function sourceEvent(source, event, data) {
    if (!SOURCE_EVENT_ALLOWLIST[source]?.has(event)) return;
    broadcastEvent(`${source}:${event}`, data);
  }

  return {
    broadcastAdminEvent,
    sseHandler,
    closeAdminSse,
    broadcastPublicEvent,
    closePublicSse,
    broadcastEvent,
    handlePublicSSE,
    sourceEvent,
  };
}
