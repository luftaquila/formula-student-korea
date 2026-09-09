export function registerEventsRoutes({
  app,
  sseHandler,
  getRecordFiles,
  getEventModes,
  getRecordVisibility,
  getLiveAttempts,
  getLightState,
  getMapping,
  getLiveTelemetry,
  getBridgeState,
  getSessions,
  getLiveQualityFaults,
  getLastEventId,
}) {
  /* ============================================
   Express 앱 설정
   ============================================ */
  // 서버 시각(epoch ms). 클라가 자기 시계와의 오프셋을 추정해 라이브 클럭을 전 클라 동기화(공유 클럭).
  app.get("/api/time", (req, res) => res.json({ now: Date.now() }));

  // SSE 엔드포인트
  app.get(
    "/api/events",
    sseHandler(() => ({
      recordFiles: getRecordFiles(),
      eventModes: getEventModes(),
      recordVisibility: getRecordVisibility(),
      liveAttempts: getLiveAttempts(),
      wireless: {
        light: getLightState(),
        mapping: getMapping(),
        telemetry: getLiveTelemetry(),
        bridge: getBridgeState(),
        sessions: getSessions(),
        qualityFaults: getLiveQualityFaults(),
        lastEventId: getLastEventId(),
      },
    })),
  );
}
