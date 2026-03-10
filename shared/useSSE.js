import { ref, onMounted, onUnmounted } from "vue";

export function createSSEConnection(endpointUrl) {
  const connected = ref(false);
  let eventSource = null;
  let subscribers = 0;
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
