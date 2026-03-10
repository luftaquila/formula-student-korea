import { ref, onMounted, onUnmounted } from "vue";

const API_BASE = import.meta.env.DEV ? "" : "/score";

// Shared state across all components
const lastInspectionUpdate = ref(null);
const lastRecordAutoUpdate = ref(null);
const lastRecordManualUpdate = ref(null);
const connected = ref(false);

let eventSource = null;
let subscribers = 0;

function connect() {
  if (eventSource) return;

  eventSource = new EventSource(`${API_BASE}/api/score/events`);

  eventSource.onopen = () => {
    connected.value = true;
  };

  eventSource.onerror = () => {
    connected.value = false;
    setTimeout(() => {
      if (subscribers > 0) {
        eventSource?.close();
        eventSource = null;
        connect();
      }
    }, 3000);
  };

  eventSource.addEventListener("init", () => {
    connected.value = true;
  });

  eventSource.addEventListener("inspection:category-result", (e) => {
    const data = JSON.parse(e.data);
    lastInspectionUpdate.value = { ...data, timestamp: Date.now() };
  });

  eventSource.addEventListener("record-auto", (e) => {
    const data = JSON.parse(e.data);
    lastRecordAutoUpdate.value = { ...data, timestamp: Date.now() };
  });

  eventSource.addEventListener("record-update", (e) => {
    const data = JSON.parse(e.data);
    lastRecordManualUpdate.value = { ...data, timestamp: Date.now() };
  });
}

function disconnect() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
    connected.value = false;
  }
}

export function useSSE() {
  onMounted(() => {
    subscribers++;
    connect();
  });

  onUnmounted(() => {
    subscribers--;
    if (subscribers === 0) {
      disconnect();
    }
  });

  return {
    lastInspectionUpdate,
    lastRecordAutoUpdate,
    lastRecordManualUpdate,
    connected,
  };
}
