import { ref, onMounted, onUnmounted } from "vue";

const API_BASE = import.meta.env.PROD ? "/traffic" : "/traffic";

// Shared state across all components
const recordFiles = ref([]);
const selectedFile = ref(null);
const lastUpdate = ref(null);
const connected = ref(false);

let eventSource = null;
let subscribers = 0;

function connect() {
  if (eventSource) return;

  eventSource = new EventSource(`${API_BASE}/api/events`);

  eventSource.onopen = () => {
    connected.value = true;
  };

  eventSource.onerror = () => {
    connected.value = false;
    // Reconnect after 3 seconds
    setTimeout(() => {
      if (subscribers > 0) {
        eventSource?.close();
        eventSource = null;
        connect();
      }
    }, 3000);
  };

  eventSource.addEventListener("init", (e) => {
    const data = JSON.parse(e.data);
    recordFiles.value = data.recordFiles;
  });

  eventSource.addEventListener("records", (e) => {
    const data = JSON.parse(e.data);
    recordFiles.value = data.recordFiles;
    lastUpdate.value = { type: data.type, name: data.name, timestamp: Date.now() };
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
    recordFiles,
    selectedFile,
    lastUpdate,
    connected,
  };
}
