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
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastInspectionUpdate.value = { ...data, timestamp: Date.now() };
});

on("inspection:answer", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastAnswerUpdate.value = { ...data, timestamp: Date.now() };
});

on("traffic:records", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastTrafficRecordUpdate.value = { ...data, timestamp: Date.now() };
});

on("manual-score", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastManualScoreUpdate.value = { ...data, timestamp: Date.now() };
});

on("penalty", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastPenaltyUpdate.value = { ...data, timestamp: Date.now() };
});

on("setting", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastSettingUpdate.value = { ...data, timestamp: Date.now() };
});

on("endurance", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastEnduranceUpdate.value = { ...data, timestamp: Date.now() };
});

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
