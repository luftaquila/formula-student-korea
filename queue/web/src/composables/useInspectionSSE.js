import { ref } from "vue";
import { createServiceSSE, parseSSEData } from "@shared/useSSE.js";

const {
  on,
  useSSE: useConnection,
  reconnected,
} = createServiceSSE("/competition/api/v1/inspection", "/api/sheet/events");

const lastInspectorUpdate = ref(null);

on("inspector", (event) => {
  const data = parseSSEData(event);
  if (!data) return;
  lastInspectorUpdate.value = { ...data, timestamp: Date.now() };
});

export function useInspectionSSE(enabled = true) {
  if (typeof enabled === "object" ? enabled.value : enabled) useConnection();
  return { lastInspectorUpdate, reconnected };
}
