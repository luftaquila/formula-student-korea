import { ref, watch } from "vue";
import { createSSEConnection } from "@shared/useSSE.js";

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
  }
});

on("wireless:event", (e) => {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  for (const ev of data.events || []) {
    for (const fn of wirelessEventSubs) {
      try { fn(ev); } catch { /* subscriber error ignored */ }
    }
  }
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
