import { ref, watch } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";

const API_BASE = import.meta.env.DEV ? "" : "/traffic";
const { on, useSSE: useConnection } = createSSEConnection(`${API_BASE}/api/events`);

// Shared state across all components
const recordFiles = ref([]);
const selectedFile = ref(localStorage.getItem("traffic-last-file") || null);
const lastUpdate = ref(null);
const eventModes = ref({});

watch(selectedFile, (v) => {
  if (v) localStorage.setItem("traffic-last-file", v);
  else localStorage.removeItem("traffic-last-file");
});

on("init", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  recordFiles.value = ["controller", ...data.recordFiles];
  if (data.eventModes) {
    const modes = {};
    for (const m of data.eventModes) modes[m.event_type] = !!m.enabled;
    eventModes.value = modes;
  }
});

on("records", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  recordFiles.value = ["controller", ...data.recordFiles];
  lastUpdate.value = { type: data.type, name: data.name, timestamp: Date.now() };
});

on("event-mode", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  eventModes.value = { ...eventModes.value, [data.event_type]: !!data.enabled };
});

export function useSSE() {
  const { connected } = useConnection();

  return {
    recordFiles,
    selectedFile,
    lastUpdate,
    eventModes,
    connected,
  };
}
