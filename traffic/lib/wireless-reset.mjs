function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewerSession(session, marker) {
  const sessionTime = timestampMs(session?.updated_at);
  const markerTime = timestampMs(marker?.updated_at);
  return sessionTime != null && markerTime != null && sessionTime > markerTime;
}

// reset은 POST 응답 자체로 완료가 확정된다. reset session SSE를 놓친 요청자만
// 이전 런을 계속 보지 않도록, 요청 시작 시점의 런과 응답을 대조해 완료 latch를 만든다.
export function createResetMarker(currentSession, resetSession, requestedRunId) {
  if (!currentSession || !resetSession?.event_type) return null;
  if (currentSession.event_type !== resetSession.event_type) return null;
  if (requestedRunId == null || currentSession.run_id !== requestedRunId) return null;
  if (
    resetSession.armed ||
    resetSession.run_id != null ||
    resetSession.saved_record_name != null ||
    resetSession.saved_record_rowid != null
  ) return null;
  if (isNewerSession(currentSession, resetSession)) return null;
  return {
    run_id: requestedRunId,
    updated_at: resetSession.updated_at ?? null,
  };
}

// 새 run_id가 열리면 latch를 제거한다.
// 응답보다 오래된 이전 런 SSE는 완료 latch를 풀 수 없다.
export function resetMarkerResolved(marker, session) {
  if (!marker || !session) return false;
  if (session.run_id == null) return false;
  if (session.run_id !== marker.run_id) return true;
  return false;
}

export function applyResetMarker(session, marker) {
  if (!session || !marker) return session;
  if (session.run_id !== marker.run_id) return session;
  return {
    ...session,
    armed: false,
    verification: null,
    result: null,
    lap_times: [],
    finished: false,
    run_id: null,
    saved_record_name: null,
    saved_record_rowid: null,
    updated_at: marker.updated_at ?? session.updated_at,
  };
}
