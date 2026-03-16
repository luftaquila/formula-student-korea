import { ref } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";

const API_BASE = import.meta.env.DEV ? "" : "/queue";
const { on, useSSE: useConnection } = createSSEConnection(`${API_BASE}/api/events`);

// Shared state across all components
const activeInspections = ref([]);
const lastQueueUpdate = ref(null);
const allBooths = ref({});
const lastBoothUpdate = ref(null);

on("init", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  activeInspections.value = data.activeInspections;
  if (data.allBooths) {
    allBooths.value = data.allBooths;
  }
});

on("inspections", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  activeInspections.value = data.activeInspections;
});

on("queue", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  activeInspections.value = data.activeInspections;
  lastQueueUpdate.value = { type: data.type, timestamp: Date.now() };
});

on("booth", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
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
  };
}
