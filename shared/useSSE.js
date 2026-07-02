import { ref, onMounted, onUnmounted } from "vue";

export function createSSEConnection(endpointUrl) {
  const connected = ref(false);
  let eventSource = null;
  let subscribers = 0;
  let retryDelay = 1000;
  const MAX_RETRY_DELAY = 30000;
  const pendingListeners = [];

  function on(eventName, handler) {
    if (!pendingListeners.some(l => l.eventName === eventName && l.handler === handler)) {
      pendingListeners.push({ eventName, handler });
    }
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

// 서비스 앱 공용 SSE 진입점. base path 계산(api-base.js와 동일하게 PROD 키 사용),
// init 기반 connected 확정과 재연결 감지(reconnected)까지 한 곳에서 제공해 앱별
// composable의 드리프트(env 플래그 반전, 재연결 감지 누락)를 막는다.
export function createServiceSSE(basePath, eventPath = "/api/events") {
  const base = import.meta.env.PROD ? basePath : "";
  const conn = createSSEConnection(`${base}${eventPath}`);
  const reconnected = ref(null);
  let initCount = 0;
  conn.on("init", () => {
    conn.connected.value = true;
    if (++initCount > 1) reconnected.value = Date.now();
  });
  return { ...conn, reconnected };
}

// SSE 프레임의 JSON 페이로드 파싱. 손상 프레임은 null — 리스너가 조기 반환한다.
export function parseSSEData(e) {
  try { return JSON.parse(e.data); } catch { return null; }
}
