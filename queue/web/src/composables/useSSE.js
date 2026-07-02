import { ref } from "vue";
import { createServiceSSE, parseSSEData } from "@shared/useSSE.js";

const { on, useSSE: useConnection, reconnected } = createServiceSSE("/queue");

// Shared state across all components
const activeInspections = ref([]);
const lastQueueUpdate = ref(null);
const allBooths = ref({});
const lastBoothUpdate = ref(null);

on("init", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  activeInspections.value = data.activeInspections;
  if (data.allBooths) {
    allBooths.value = data.allBooths;
  }
});

on("inspections", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  activeInspections.value = data.activeInspections;
});

on("queue", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  activeInspections.value = data.activeInspections;
  lastQueueUpdate.value = { type: data.type, timestamp: Date.now() };
});

on("booth", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  allBooths.value[data.type] = data.booths;
  lastBoothUpdate.value = { type: data.type, timestamp: Date.now() };
});

export function useSSE() {
  useConnection();

  return {
    activeInspections,
    lastQueueUpdate,
    allBooths,
    lastBoothUpdate,
    reconnected,
  };
}
