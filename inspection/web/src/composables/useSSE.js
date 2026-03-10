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
  const data = JSON.parse(e.data);
  lastUpdate.value = { ...data, timestamp: Date.now() };
});

on("inspector", (e) => {
  const data = JSON.parse(e.data);
  lastInspectorUpdate.value = { ...data, timestamp: Date.now() };
});

on("answer", (e) => {
  const data = JSON.parse(e.data);
  lastAnswerUpdate.value = { ...data, timestamp: Date.now() };
});

on("memo", (e) => {
  const data = JSON.parse(e.data);
  lastMemoUpdate.value = { ...data, timestamp: Date.now() };
});

export function useSSE() {
  const { connected } = useConnection();

  return {
    lastUpdate,
    lastInspectorUpdate,
    lastAnswerUpdate,
    lastMemoUpdate,
    connected,
  };
}
