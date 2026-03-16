import { ref } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";

const API_BASE = import.meta.env.DEV ? "" : "/inspection";
const { on, useSSE: useConnection, connected } = createSSEConnection(`${API_BASE}/api/sheet/events`);

// Shared state across all components
const lastUpdate = ref(null);
const lastInspectorUpdate = ref(null);
const lastAnswerUpdate = ref(null);
const lastMemoUpdate = ref(null);

on("init", () => {
  connected.value = true;
});

on("category-result", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastUpdate.value = { ...data, timestamp: Date.now() };
});

on("inspector", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastInspectorUpdate.value = { ...data, timestamp: Date.now() };
});

on("answer", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastAnswerUpdate.value = { ...data, timestamp: Date.now() };
});

on("memo", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  lastMemoUpdate.value = { ...data, timestamp: Date.now() };
});

export function useSSE() {
  useConnection();

  return {
    lastUpdate,
    lastInspectorUpdate,
    lastAnswerUpdate,
    lastMemoUpdate,
  };
}
