import { ref, watch } from "vue";
import { createServiceSSE, parseSSEData } from "@shared/useSSE.js";
import { fetchWirelessEvents } from "./useApi";

const { on, useSSE: useConnection } = createServiceSSE("/competition/api/v1/traffic");

// Shared state across all components
const recordFiles = ref([]);
const selectedFile = ref(localStorage.getItem("traffic-last-file") || null);
const lastUpdate = ref(null);
const lastEntriesUpdate = ref(null);
const eventModes = ref({});
const recordVisibility = ref({});

// 무선 LoRa 계측 실시간 상태
const wirelessLight = ref(null);
const wirelessMapping = ref([]);
const wirelessTelemetry = ref({}); // node_id -> { rssi, snr, offset_us, skew_ppm, latency_ms, link_state, last_seen }
const wirelessBridge = ref({ online: false, last_seen: null });
const wirelessSessions = ref({}); // event_type -> { armed, light_color, green_tick, team, event_name, controller, ... }
const wirelessQualityFaults = ref({}); // event_type -> 마지막 자동 중단 원인
// wireless:event는 last-value ref로 모으면 빠른 연속 이벤트가 합쳐지므로 fan-out 사용
const wirelessEventSubs = new Set();
export function onWirelessEvent(fn) {
  wirelessEventSubs.add(fn);
  return () => wirelessEventSubs.delete(fn);
}
// 물리 신호등 다운링크 명령(서버→브리지). 브리지만 의미 있게 처리(시리얼 전달).
const wirelessCommandSubs = new Set();
export function onWirelessCommand(fn) {
  wirelessCommandSubs.add(fn);
  return () => wirelessCommandSubs.delete(fn);
}
export {
  wirelessLight,
  wirelessMapping,
  wirelessTelemetry,
  wirelessBridge,
  wirelessSessions,
  wirelessQualityFaults,
};

// ── 무선 이벤트 디스패치 + 재연결 백필 ──────────────────────────────────────
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
        // 디바운스는 wireless store가 tick 기준으로 처리하므로 백필 클러스터도 올바르게
        // 접힌다 — 별도 우회 표시 불필요.
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
  const data = parseSSEData(e);
  if (!data) return;
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
    const smap = {};
    for (const s of data.wireless.sessions || []) smap[s.event_type] = s;
    wirelessSessions.value = smap;
    const fmap = {};
    for (const fault of data.wireless.qualityFaults || []) {
      if (fault?.event_type && fault?.fault_id) fmap[fault.event_type] = fault;
    }
    wirelessQualityFaults.value = fmap;
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
  const data = parseSSEData(e);
  if (!data) return;
  for (const ev of data.events || []) dispatchWirelessEvent(ev);
});

on("wireless:telemetry", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  const m = { ...wirelessTelemetry.value };
  for (const t of data.telemetry || []) m[t.node_id] = t;
  wirelessTelemetry.value = m;
});

on("wireless:light", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  wirelessLight.value = data;
});

on("wireless:mapping", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  if (data.deleted) {
    wirelessMapping.value = wirelessMapping.value.filter((m) => m.node_id !== data.node_id);
  } else {
    const others = wirelessMapping.value.filter((m) => m.node_id !== data.node_id);
    wirelessMapping.value = [...others, data];
  }
});

on("wireless:bridge", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  wirelessBridge.value = data;
});

on("wireless:session", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  if (!data || !data.event_type) return;
  wirelessSessions.value = { ...wirelessSessions.value, [data.event_type]: data };
});

on("wireless:quality-fault", (e) => {
  const data = parseSSEData(e);
  if (!data?.event_type) return;
  const next = { ...wirelessQualityFaults.value };
  if (data.cleared) delete next[data.event_type];
  else if (data.fault_id) next[data.event_type] = data;
  wirelessQualityFaults.value = next;
});

on("wireless:command", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  for (const fn of wirelessCommandSubs) {
    try { fn(data); } catch { /* subscriber error ignored */ }
  }
});

on("records", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  recordFiles.value = ["controller", ...data.recordFiles];
  lastUpdate.value = {
    ...data,
    timestamp: Date.now(),
  };
});

on("entries", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  lastEntriesUpdate.value = { ...data, timestamp: Date.now() };
});

on("record-visibility", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  recordVisibility.value = { ...recordVisibility.value, [data.name]: !!data.visible };
});

on("event-mode", (e) => {
  const data = parseSSEData(e);
  if (!data) return;
  eventModes.value = { ...eventModes.value, [data.event_type]: !!data.enabled };
});

export function useSSE() {
  const { connected } = useConnection();

  return {
    recordFiles,
    selectedFile,
    lastUpdate,
    lastEntriesUpdate,
    eventModes,
    recordVisibility,
    connected,
    wirelessLight,
    wirelessMapping,
    wirelessTelemetry,
    wirelessBridge,
    wirelessSessions,
    wirelessQualityFaults,
  };
}
