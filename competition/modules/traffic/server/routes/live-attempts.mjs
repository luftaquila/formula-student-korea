import { EVENT_TYPES } from "../../../../../shared/common/constants.js";

export function registerLiveAttemptsRoutes({
  app,
  rejectMutation,
  validateSelectionRequest,
  liveAttemptPayload,
  logger,
  liveAttempts,
  broadcastEvent,
}) {
  // 유선 컨트롤러와 유선 매뉴얼 모드는 같은 센서 처리 경로를 사용한다. 출발 센서가
  // 래치된 시점만 서버에 공유하고, 전광판 클라이언트는 SSE 수신 시점부터 로컬로 시간을 증가시킨다.
  app.post("/api/live-attempts", (req, res) => {
    const { action, event_type, attempt_id } = req.body || {};
    const reject = (message) =>
      rejectMutation(req, res, {
        action: "live_attempt.publish",
        status: 400,
        message,
        target: typeof event_type === "string" ? event_type : "live_attempt",
        operation: typeof action === "string" ? action : "publish",
        context: { event_type: event_type ?? null, attempt_id: attempt_id ?? null },
      });

    if (!EVENT_TYPES.includes(event_type)) return reject("올바르지 않은 종목입니다.");
    if (!/^[A-Za-z0-9-]{1,100}$/.test(attempt_id || ""))
      return reject("올바르지 않은 계측 시도 ID입니다.");

    if (action === "start") {
      const selection = validateSelectionRequest(req, res, "live_attempt.start", event_type);
      if (!selection) return;
      if (!selection.valid) {
        return rejectMutation(req, res, {
          action: "live_attempt.start",
          status: selection.status || 400,
          message: selection.error,
          target: event_type,
          operation: "start",
          context: { event_type, attempt_id },
        });
      }
      if (!selection.team || !selection.event_name)
        return reject("경기 이름과 참가팀을 선택해야 합니다.");

      const startedAtMs = Date.now();
      const attempt = {
        attempt_id,
        event_type,
        event_name: selection.event_name,
        team: selection.team,
        started_at: new Date(startedAtMs).toISOString(),
        started_at_ms: startedAtMs,
      };
      const payload = liveAttemptPayload(attempt, startedAtMs);
      logger.log(
        req,
        "live_attempt.start",
        {
          event_type,
          attempt_id,
          event_name: selection.event_name,
          team_id: selection.team.id ?? selection.team.teamId ?? null,
          team_num: selection.team.num,
        },
        event_type,
      );
      liveAttempts.set(event_type, attempt);
      broadcastEvent("live-attempt", payload);
      return res.status(201).json(payload);
    }

    if (action === "stop") {
      const current = liveAttempts.get(event_type);
      const cleared = current?.attempt_id === attempt_id;
      logger.log(req, "live_attempt.stop", { event_type, attempt_id, cleared }, event_type);
      if (cleared) {
        liveAttempts.delete(event_type);
        broadcastEvent("live-attempt", { active: false, event_type, attempt_id });
      }
      return res.json({ cleared });
    }

    return reject("올바르지 않은 계측 상태 작업입니다.");
  });
}
