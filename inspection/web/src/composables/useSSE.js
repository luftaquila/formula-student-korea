import { ref } from "vue";
import { createServiceSSE, parseSSEData } from "@shared/useSSE.js";

const { on, useSSE: useConnection, reconnected } = createServiceSSE("/inspection", "/api/sheet/events");

// Shared state across all components
const lastUpdate = ref(null);
const lastInspectorUpdate = ref(null);
const lastAnswerUpdate = ref(null);
const lastMemoUpdate = ref(null);

on("category-result", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  lastUpdate.value = { ...data, timestamp: Date.now() };
});

on("inspector", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  lastInspectorUpdate.value = { ...data, timestamp: Date.now() };
});

on("answer", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  lastAnswerUpdate.value = { ...data, timestamp: Date.now() };
});

on("memo", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  lastMemoUpdate.value = { ...data, timestamp: Date.now() };
});

export function useSSE() {
  useConnection();

  return {
    lastUpdate,
    lastInspectorUpdate,
    lastAnswerUpdate,
    lastMemoUpdate,
    reconnected,
  };
}
