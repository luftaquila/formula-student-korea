import { onUnmounted, watch } from "vue";

import { publishLiveAttempt } from "./useApi";

function newAttemptId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useLiveAttempt({ enabled, active, eventType, eventName, team }) {
  let attempt = null;
  let publishChain = Promise.resolve();

  function publish(body) {
    publishChain = publishChain
      .catch(() => {})
      .then(() => publishLiveAttempt(body))
      .catch((error) => console.error("전광판 실시간 상태 전송 실패:", error));
  }

  function start() {
    if (!enabled()) return null;
    const selectedTeam = team();
    const selectedEventName = eventName().trim();
    if (!selectedTeam || !selectedEventName) return null;

    const startedAttempt = Object.freeze({
      id: newAttemptId(),
      eventType: typeof eventType === "function" ? eventType() : eventType,
    });
    attempt = startedAttempt;
    publish({
      action: "start",
      event_type: startedAttempt.eventType,
      attempt_id: startedAttempt.id,
      event_name: selectedEventName,
      team: {
        id: selectedTeam.id,
        num: selectedTeam.num,
        univ: selectedTeam.univ,
        team: selectedTeam.team,
      },
    });
    return startedAttempt;
  }

  function stop(stoppedAttempt = attempt) {
    if (!stoppedAttempt) return;
    if (attempt?.id === stoppedAttempt.id) attempt = null;
    publish({
      action: "stop",
      event_type: stoppedAttempt.eventType,
      attempt_id: stoppedAttempt.id,
    });
  }

  watch(active, (isActive, wasActive) => {
    if (wasActive && !isActive) stop();
  });
  onUnmounted(stop);

  return { start, stop };
}
