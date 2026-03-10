import { ref } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";

const API_BASE = import.meta.env.DEV ? "" : "/score";
const { on, useSSE: useConnection, connected } = createSSEConnection(`${API_BASE}/api/score/events`);

// Shared state across all components
const lastInspectionUpdate = ref(null);
const lastRecordAutoUpdate = ref(null);
const lastRecordManualUpdate = ref(null);

on("init", () => {
  connected.value = true;
});

on("inspection:category-result", (e) => {
  const data = JSON.parse(e.data);
  lastInspectionUpdate.value = { ...data, timestamp: Date.now() };
});

on("record-auto", (e) => {
  const data = JSON.parse(e.data);
  lastRecordAutoUpdate.value = { ...data, timestamp: Date.now() };
});

on("record-update", (e) => {
  const data = JSON.parse(e.data);
  lastRecordManualUpdate.value = { ...data, timestamp: Date.now() };
});

export function useSSE() {
  const { connected } = useConnection();

  return {
    lastInspectionUpdate,
    lastRecordAutoUpdate,
    lastRecordManualUpdate,
    connected,
  };
}
