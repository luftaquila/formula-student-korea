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

on("traffic:records", (e) => {
  const data = JSON.parse(e.data);
  lastTrafficRecordUpdate.value = { ...data, timestamp: Date.now() };
});

on("manual-score", (e) => {
  const data = JSON.parse(e.data);
  lastManualScoreUpdate.value = { ...data, timestamp: Date.now() };
});

on("penalty", (e) => {
  const data = JSON.parse(e.data);
  lastPenaltyUpdate.value = { ...data, timestamp: Date.now() };
});

on("setting", (e) => {
  const data = JSON.parse(e.data);
  lastSettingUpdate.value = { ...data, timestamp: Date.now() };
});

on("endurance", (e) => {
  const data = JSON.parse(e.data);
  lastEnduranceUpdate.value = { ...data, timestamp: Date.now() };
});

export function useSSE() {
  const { connected } = useConnection();

  return {
    lastInspectionUpdate,
    lastAnswerUpdate,
    lastTrafficRecordUpdate,
    lastManualScoreUpdate,
    lastPenaltyUpdate,
    lastSettingUpdate,
    lastEnduranceUpdate,
    connected,
  };
}
