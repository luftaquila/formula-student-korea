import { ref } from "vue";
import { createServiceSSE, parseSSEData } from "@shared/useSSE.js";

const { on, useSSE: useConnection, reconnected } = createServiceSSE("/score", "/api/score/events");

// Shared state across all components
const lastInspectionUpdate = ref(null);
const lastAnswerUpdate = ref(null);
const lastTrafficRecordUpdate = ref(null);
const lastManualScoreUpdate = ref(null);
const lastPenaltyUpdate = ref(null);
const lastSettingUpdate = ref(null);
const lastEnduranceUpdate = ref(null);
const lastPublicationUpdate = ref(null);

function parseSSE(e, target) {
  const data = parseSSEData(e);
  if (data) target.value = { ...data, timestamp: Date.now() };
}

on("inspection:category-result", (e) => parseSSE(e, lastInspectionUpdate));
on("inspection:answer", (e) => parseSSE(e, lastAnswerUpdate));
on("traffic:records", (e) => parseSSE(e, lastTrafficRecordUpdate));
on("traffic:record-visibility", (e) => parseSSE(e, lastTrafficRecordUpdate));
// 경기 모드 토글은 집계 대상 종목을 바꾸므로 전체 재조회를 트리거한다(reconnect와 동일 경로).
on("traffic:event-mode", () => { reconnected.value = Date.now(); });
// 차량 유형은 에너지 C/E 구분을 결정하므로 엔트리 변경 시 전체 스냅샷을 다시 읽는다.
on("entry:entries", () => { reconnected.value = Date.now(); });
on("manual-score", (e) => parseSSE(e, lastManualScoreUpdate));
on("penalty", (e) => parseSSE(e, lastPenaltyUpdate));
on("setting", (e) => parseSSE(e, lastSettingUpdate));
on("endurance", (e) => parseSSE(e, lastEnduranceUpdate));
on("team-active", () => { reconnected.value = Date.now(); });
on("publication", (e) => parseSSE(e, lastPublicationUpdate));
on("refresh", () => { reconnected.value = Date.now(); });

export function useSSE() {
  useConnection();

  return {
    lastInspectionUpdate,
    lastAnswerUpdate,
    lastTrafficRecordUpdate,
    lastManualScoreUpdate,
    lastPenaltyUpdate,
    lastSettingUpdate,
    lastEnduranceUpdate,
    lastPublicationUpdate,
    reconnected,
  };
}
