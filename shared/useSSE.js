import { ref, onMounted, onUnmounted } from "vue";

export function createSSEConnection(endpointUrl) {
  const connected = ref(false);
  let eventSource = null;
  let subscribers = 0;
  let retryDelay = 1000;
  const MAX_RETRY_DELAY = 30000;
  const pendingListeners = [];

  function on(eventName, handler) {
    pendingListeners.push({ eventName, handler });
    if (eventSource) {
      eventSource.addEventListener(eventName, handler);
    }
  }

  let reconnectTimer = null;

  function connect() {
    if (eventSource) return;

    eventSource = new EventSource(endpointUrl);

    eventSource.onopen = () => {
      connected.value = true;
      retryDelay = 1000;
    };

    eventSource.onerror = () => {
      connected.value = false;
      // Close immediately to prevent browser's built-in reconnection
      eventSource?.close();
      eventSource = null;
      if (reconnectTimer) return; // Already scheduled
      const delay = retryDelay + Math.random() * 1000;
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (subscribers > 0) connect();
      }, delay);
    };

    for (const { eventName, handler } of pendingListeners) {
      eventSource.addEventListener(eventName, handler);
    }
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
      connected.value = false;
    }
  }

  function useSSE() {
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

    return { connected };
  }

  return { on, useSSE, connected };
}
