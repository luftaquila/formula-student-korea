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

  function connect() {
    if (eventSource) return;

    eventSource = new EventSource(endpointUrl);

    eventSource.onopen = () => {
      connected.value = true;
      retryDelay = 1000; // Reset on successful connection
    };

    eventSource.onerror = () => {
      connected.value = false;
      const delay = retryDelay + Math.random() * 1000; // Add jitter
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      setTimeout(() => {
        if (subscribers > 0) {
          eventSource?.close();
          eventSource = null;
          connect();
        }
      }, delay);
    };

    for (const { eventName, handler } of pendingListeners) {
      eventSource.addEventListener(eventName, handler);
    }
  }

  function disconnect() {
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
