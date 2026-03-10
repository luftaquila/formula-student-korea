import { ref, onMounted, onUnmounted } from "vue";

const API_BASE = import.meta.env.DEV ? "" : "/inspection";

// Shared state across all components
const lastUpdate = ref(null);
const lastInspectorUpdate = ref(null);
const lastAnswerUpdate = ref(null);
const lastMemoUpdate = ref(null);
const connected = ref(false);

let eventSource = null;
let subscribers = 0;

function connect() {
  if (eventSource) return;

  eventSource = new EventSource(`${API_BASE}/api/sheet/events`);

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

  eventSource.addEventListener("category-result", (e) => {
    const data = JSON.parse(e.data);
    lastUpdate.value = { ...data, timestamp: Date.now() };
  });

  eventSource.addEventListener("inspector", (e) => {
    const data = JSON.parse(e.data);
    lastInspectorUpdate.value = { ...data, timestamp: Date.now() };
  });

  eventSource.addEventListener("answer", (e) => {
    const data = JSON.parse(e.data);
    lastAnswerUpdate.value = { ...data, timestamp: Date.now() };
  });

  eventSource.addEventListener("memo", (e) => {
    const data = JSON.parse(e.data);
    lastMemoUpdate.value = { ...data, timestamp: Date.now() };
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
    lastUpdate,
    lastInspectorUpdate,
    lastAnswerUpdate,
    lastMemoUpdate,
    connected,
  };
}
