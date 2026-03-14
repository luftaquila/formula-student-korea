import { ref } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";

const API_BASE = import.meta.env.DEV ? "" : "/score";
const { on, useSSE: useConnection, connected } = createSSEConnection(`${API_BASE}/api/score/events`);

// Shared state across all components
const lastInspectionUpdate = ref(null);
const lastAnswerUpdate = ref(null);
const lastRecordAutoUpdate = ref(null);
const lastRecordManualUpdate = ref(null);
const lastManualScoreUpdate = ref(null);
const lastPenaltyUpdate = ref(null);

on("init", () => {
  connected.value = true;
});

on("inspection:category-result", (e) => {
  const data = JSON.parse(e.data);
  lastInspectionUpdate.value = { ...data, timestamp: Date.now() };
});

on("inspection:answer", (e) => {
  const data = JSON.parse(e.data);
  lastAnswerUpdate.value = { ...data, timestamp: Date.now() };
});

on("record-auto", (e) => {
  const data = JSON.parse(e.data);
  lastRecordAutoUpdate.value = { ...data, timestamp: Date.now() };
});

on("record-update", (e) => {
  const data = JSON.parse(e.data);
  lastRecordManualUpdate.value = { ...data, timestamp: Date.now() };
});

on("manual-score", (e) => {
  const data = JSON.parse(e.data);
  lastManualScoreUpdate.value = { ...data, timestamp: Date.now() };
});

on("penalty", (e) => {
  const data = JSON.parse(e.data);
  lastPenaltyUpdate.value = { ...data, timestamp: Date.now() };
});

export function useSSE() {
  const { connected } = useConnection();

  return {
    lastInspectionUpdate,
    lastAnswerUpdate,
    lastRecordAutoUpdate,
    lastRecordManualUpdate,
    lastManualScoreUpdate,
    lastPenaltyUpdate,
    connected,
  };
}
