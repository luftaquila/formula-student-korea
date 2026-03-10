import { ref, watch } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";

const API_BASE = import.meta.env.DEV ? "" : "/traffic";
const { on, useSSE: useConnection, connected } = createSSEConnection(`${API_BASE}/api/events`);

// Shared state across all components
const recordFiles = ref([]);
const selectedFile = ref(localStorage.getItem("traffic-last-file") || null);
const lastUpdate = ref(null);

watch(selectedFile, (v) => {
  if (v) localStorage.setItem("traffic-last-file", v);
  else localStorage.removeItem("traffic-last-file");
});

on("init", (e) => {
  const data = JSON.parse(e.data);
  recordFiles.value = ["controller", ...data.recordFiles];
});

on("records", (e) => {
  const data = JSON.parse(e.data);
  recordFiles.value = ["controller", ...data.recordFiles];
  lastUpdate.value = { type: data.type, name: data.name, timestamp: Date.now() };
});

export function useSSE() {
  const { connected } = useConnection();

  return {
    recordFiles,
    selectedFile,
    lastUpdate,
    connected,
  };
}
