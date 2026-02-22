import { ref, onMounted, onUnmounted } from "vue";

const API_BASE = import.meta.env.DEV ? "" : "/queue";

// Shared state across all components
const activeInspections = ref([]);
const lastQueueUpdate = ref(null);
const allBooths = ref({});
const lastBoothUpdate = ref(null);
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
    activeInspections.value = data.activeInspections;
    if (data.allBooths) {
      allBooths.value = data.allBooths;
    }
  });

  eventSource.addEventListener("inspections", (e) => {
    const data = JSON.parse(e.data);
    activeInspections.value = data.activeInspections;
  });

  eventSource.addEventListener("queue", (e) => {
    const data = JSON.parse(e.data);
    activeInspections.value = data.activeInspections;
    lastQueueUpdate.value = { type: data.type, timestamp: Date.now() };
  });

  eventSource.addEventListener("booth", (e) => {
    const data = JSON.parse(e.data);
    allBooths.value[data.type] = data.booths;
    lastBoothUpdate.value = { type: data.type, timestamp: Date.now() };
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
    activeInspections,
    lastQueueUpdate,
    allBooths,
    lastBoothUpdate,
    connected,
  };
}
