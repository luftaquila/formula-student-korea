function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewerSession(session, marker) {
  const sessionTime = timestampMs(session?.updated_at);
  const markerTime = timestampMs(marker?.updated_at);
  return sessionTime != null && markerTime != null && sessionTime > markerTime;
}

// 물리 reset 명령 응답은 pending SSE보다 먼저 또는 나중에 도착할 수 있다. 응답 전체를
// 세션에 덮지 않고, 같은 런의 이전 캐시일 때만 로컬 pending latch를 만든다.
export function createResetPendingMarker(currentSession, commandSession) {
  if (!currentSession || !commandSession?.reset_pending) return null;
  if (!commandSession.event_type || currentSession.event_type !== commandSession.event_type) return null;
  if (currentSession.reset_pending) return null;
  if (commandSession.run_id == null || currentSession.run_id !== commandSession.run_id) return null;
  if (isNewerSession(currentSession, commandSession)) return null;
  return {
    run_id: commandSession.run_id,
    updated_at: commandSession.updated_at ?? null,
  };
}

// pending SSE/init이 도착했거나 OFF 확정으로 런이 바뀌면 로컬 latch의 역할이 끝난다.
// 같은 런의 더 오래된 false SSE는 latch를 풀지 않아 요청 직후 잠금 공백을 막는다.
export function resetPendingMarkerResolved(marker, session) {
  if (!marker || !session) return false;
  if (session.reset_pending) return true;
  if (session.run_id !== marker.run_id) return true;
  return isNewerSession(session, marker);
}

export function applyResetPendingMarker(session, marker) {
  if (!session || !marker || session.reset_pending) return session;
  if (session.run_id !== marker.run_id || isNewerSession(session, marker)) return session;
  return { ...session, reset_pending: true };
}

// 가상 reset은 POST 응답 자체로 완료가 확정된다. reset session SSE를 놓친 요청자만
// 이전 런을 계속 보지 않도록, 요청 시작 시점의 런과 응답을 대조해 완료 latch를 만든다.
export function createVirtualResetMarker(currentSession, resetSession, requestedRunId) {
  if (!currentSession || !resetSession?.event_type) return null;
  if (currentSession.event_type !== resetSession.event_type) return null;
  if (requestedRunId == null || currentSession.run_id !== requestedRunId) return null;
  if (
    resetSession.armed ||
    resetSession.light_color !== "off" ||
    resetSession.run_id != null ||
    resetSession.saved_record_name != null ||
    resetSession.saved_record_rowid != null ||
    resetSession.reset_pending
  ) return null;
  if (isNewerSession(currentSession, resetSession)) return null;
  return {
    run_id: requestedRunId,
    updated_at: resetSession.updated_at ?? null,
  };
}

// 권위 SSE/init이 같은 완료 상태를 확인하거나 새 run_id를 열면 latch를 제거한다.
// 응답보다 오래된 이전 런 SSE는 완료 latch를 풀 수 없다.
export function virtualResetMarkerResolved(marker, session) {
  if (!marker || !session) return false;
  if (session.run_id == null) return true;
  if (session.run_id !== marker.run_id) return true;
  return isNewerSession(session, marker);
}

export function applyVirtualResetMarker(session, marker) {
  if (!session || !marker) return session;
  if (session.run_id !== marker.run_id || isNewerSession(session, marker)) return session;
  return {
    ...session,
    armed: false,
    light_color: "off",
    run_id: null,
    saved_record_name: null,
    saved_record_rowid: null,
    reset_pending: false,
    updated_at: marker.updated_at ?? session.updated_at,
  };
}
