import { ref, watch } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";
import { fetchWirelessEvents } from "./useApi";

const API_BASE = import.meta.env.DEV ? "" : "/traffic";
const { on, useSSE: useConnection } = createSSEConnection(`${API_BASE}/api/events`);

// Shared state across all components
const recordFiles = ref([]);
const selectedFile = ref(localStorage.getItem("traffic-last-file") || null);
const lastUpdate = ref(null);
const eventModes = ref({});
const recordVisibility = ref({});

// 무선 LoRa 계측 실시간 상태
const wirelessLight = ref(null);
const wirelessMapping = ref([]);
const wirelessTelemetry = ref({}); // node_id -> { rssi, snr, offset_us, skew_ppm, latency_ms, link_state, last_seen }
const wirelessBridge = ref({ online: false, last_seen: null });
// wireless:event는 last-value ref로 모으면 빠른 연속 이벤트가 합쳐지므로 fan-out 사용
const wirelessEventSubs = new Set();
export function onWirelessEvent(fn) {
  wirelessEventSubs.add(fn);
  return () => wirelessEventSubs.delete(fn);
}
export { wirelessLight, wirelessMapping, wirelessTelemetry, wirelessBridge };

// ── raw 이벤트 디스패치 + 재연결 백필 ──────────────────────────────────────
// SSE가 잠깐 끊기면 그동안 broadcast된 wireless:event를 놓친다(브라우저 EventSource는
// 재연결 시 누락분을 재생하지 않음). 재연결마다 서버 백필 API로 누락 id 구간을 다시 받아
// 같은 fan-out으로 재생한다. 라이브와 백필이 같은 이벤트를 두 번 처리(이중 기록)하지 않도록
// id seen-set으로 정확히 한 번만 디스패치. id는 단조 증가라 set은 한도에서 오래된 것부터 정리.
let lastWirelessEventId = null; // null = 첫 연결 전(첫 연결 시 과거 전체 재생 방지)
let backfillInProgress = false;
const seenEventIds = new Set();

function dispatchWirelessEvent(ev) {
  const id = ev && ev.id;
  if (id != null) {
    if (seenEventIds.has(id)) return; // 백필/라이브 중복 — 한 번만
    seenEventIds.add(id);
    if (seenEventIds.size > 4096) {
      const arr = [...seenEventIds].sort((a, b) => a - b);
      for (let i = 0; i < arr.length - 2048; i++) seenEventIds.delete(arr[i]);
    }
    if (lastWirelessEventId == null || id > lastWirelessEventId) lastWirelessEventId = id;
  }
  for (const fn of wirelessEventSubs) {
    try { fn(ev); } catch { /* subscriber error ignored */ }
  }
}

async function backfillWirelessEvents() {
  if (backfillInProgress || lastWirelessEventId == null) return;
  backfillInProgress = true;
  try {
    // 로컬 커서: 백필 중 라이브 이벤트가 lastWirelessEventId를 앞당겨도 갭을 건너뛰지 않도록
    // 백필은 자기 커서로만 전진한다. 라이브와의 중복은 seenEventIds가 제거.
    let cursor = lastWirelessEventId;
    for (;;) {
      let rows;
      try { rows = await fetchWirelessEvents(cursor, 1000); }
      catch { break; } // best-effort: 다음 재연결이 다시 시도
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const ev of rows) {
        ev._backfill = true; // 구독자(wireless store)가 쿨다운 우회하도록 표시
        dispatchWirelessEvent(ev);
        if (ev.id != null && ev.id > cursor) cursor = ev.id;
      }
      if (rows.length < 1000) break;
    }
  } finally {
    backfillInProgress = false;
  }
}

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
  if (data.recordVisibility) {
    recordVisibility.value = data.recordVisibility;
  }
  if (data.wireless) {
    wirelessLight.value = data.wireless.light || null;
    wirelessMapping.value = data.wireless.mapping || [];
    const tmap = {};
    for (const t of data.wireless.telemetry || []) tmap[t.node_id] = t;
    wirelessTelemetry.value = tmap;
    wirelessBridge.value = data.wireless.bridge || { online: false, last_seen: null };
    // 첫 연결: 현재 위치만 기준점으로 잡고 백필 안 함. 재연결: init이 다시 와도 기준점은
    // 유지하고, 끊긴 동안 누락분을 백필. (mapping은 위에서 이미 갱신돼 라우팅이 최신값 사용.)
    if (lastWirelessEventId == null) {
      lastWirelessEventId = Number.isFinite(data.wireless.lastEventId) ? data.wireless.lastEventId : 0;
    } else {
      backfillWirelessEvents();
    }
  }
});

on("wireless:event", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  for (const ev of data.events || []) dispatchWirelessEvent(ev);
});

on("wireless:telemetry", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  const m = { ...wirelessTelemetry.value };
  for (const t of data.telemetry || []) m[t.node_id] = t;
  wirelessTelemetry.value = m;
});

on("wireless:light", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  wirelessLight.value = data;
});

on("wireless:mapping", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  if (data.deleted) {
    wirelessMapping.value = wirelessMapping.value.filter((m) => m.node_id !== data.node_id);
  } else {
    const others = wirelessMapping.value.filter((m) => m.node_id !== data.node_id);
    wirelessMapping.value = [...others, data];
  }
});

on("wireless:bridge", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  wirelessBridge.value = data;
});

on("records", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  recordFiles.value = ["controller", ...data.recordFiles];
  lastUpdate.value = {
    type: data.type,
    name: data.name,
    field: data.field,
    record: data.record,
    timestamp: Date.now(),
  };
});

on("record-visibility", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  recordVisibility.value = { ...recordVisibility.value, [data.name]: !!data.visible };
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
    recordVisibility,
    connected,
    wirelessLight,
    wirelessMapping,
    wirelessTelemetry,
    wirelessBridge,
  };
}
