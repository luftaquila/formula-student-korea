export function createLiveAttemptService({ logger, SYS_ACTOR, broadcastEvent }) {
  // 경기 중 자동 중단 사유. 프로세스 생존 중 SSE 재연결/화면 이동으로 경고가
  // 사라지지 않게 init/state에도 포함하고, 품질을 통과한 다음 START에서만 해제한다.
  const liveAttempts = new Map();

  function liveAttemptPayload(attempt, now = Date.now()) {
    return {
      active: true,
      attempt_id: attempt.attempt_id,
      event_type: attempt.event_type,
      event_name: attempt.event_name,
      team: attempt.team,
      started_at: attempt.started_at,
      elapsed_ms: Math.max(0, now - attempt.started_at_ms),
    };
  }

  function getLiveAttempts(now = Date.now()) {
    return [...liveAttempts.values()].map((attempt) => liveAttemptPayload(attempt, now));
  }

  const LIVE_ATTEMPT_TTL_MS = 10 * 60 * 1000;

  function runLiveAttemptWatch(now = Date.now()) {
    for (const [eventType, attempt] of liveAttempts) {
      if (now - attempt.started_at_ms <= LIVE_ATTEMPT_TTL_MS) continue;
      try {
        logger.log(
          null,
          "live_attempt.expire",
          {
            event_type: eventType,
            attempt_id: attempt.attempt_id,
          },
          eventType,
          SYS_ACTOR,
        );
        liveAttempts.delete(eventType);
        broadcastEvent("live-attempt", {
          active: false,
          event_type: eventType,
          attempt_id: attempt.attempt_id,
          reason: "timeout",
        });
      } catch (error) {
        console.error("[traffic] live attempt expiry:", error?.message || error);
      }
    }
  }

  const liveAttemptWatch = setInterval(runLiveAttemptWatch, 1000);

  return {
    liveAttempts,
    liveAttemptPayload,
    getLiveAttempts,
    runLiveAttemptWatch,
    liveAttemptWatch,
  };
}
