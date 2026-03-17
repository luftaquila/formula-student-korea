import { ref } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";

const API_BASE = import.meta.env.DEV ? "" : "/score";
const { on, useSSE: useConnection, connected } = createSSEConnection(`${API_BASE}/api/score/events`);

// Shared state across all components
const lastInspectionUpdate = ref(null);
const lastAnswerUpdate = ref(null);
const lastTrafficRecordUpdate = ref(null);
const lastManualScoreUpdate = ref(null);
const lastPenaltyUpdate = ref(null);
const lastSettingUpdate = ref(null);
const lastEnduranceUpdate = ref(null);

function parseSSE(e, target) {
  try { target.value = { ...JSON.parse(e.data), timestamp: Date.now() }; }
  catch { /* malformed */ }
}

on("init", () => {
  connected.value = true;
});

on("inspection:category-result", (e) => parseSSE(e, lastInspectionUpdate));
on("inspection:answer", (e) => parseSSE(e, lastAnswerUpdate));
on("traffic:records", (e) => parseSSE(e, lastTrafficRecordUpdate));
on("manual-score", (e) => parseSSE(e, lastManualScoreUpdate));
on("penalty", (e) => parseSSE(e, lastPenaltyUpdate));
on("setting", (e) => parseSSE(e, lastSettingUpdate));
on("endurance", (e) => parseSSE(e, lastEnduranceUpdate));

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
  };
}
