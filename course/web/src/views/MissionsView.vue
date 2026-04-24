<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import L from "leaflet";
import { request } from "../api.js";

const missions = ref([]);
const selectedId = ref(null);
const detail = ref(null); // { id, waypoints, started_at, ended_at, status }
const samples = ref([]);
const loading = ref(false);

// Replay state
const playing = ref(false);
const replayIdx = ref(0); // index into samples
const replaySpeed = ref(4); // multiplier (1x, 4x, 16x)
let playTimer = null;

let map = null;
let plannedMarkers = [];
let plannedPath = null;
let telemetryLine = null;
let replayMarker = null;

const STATUS_LABEL = {
  running: "진행 중",
  completed: "완료",
  stopped: "정지됨",
  error: "오류",
};
const STATUS_COLOR = {
  running: "#3b82f6",
  completed: "#22c55e",
  stopped: "#f59e0b",
  error: "#ef4444",
};

function formatDuration(started, ended) {
  if (!ended) return "—";
  const s = Math.round((ended - started) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatTimestamp(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("ko-KR", { hour12: false });
}

async function loadMissions() {
  loading.value = true;
  try {
    const res = await request("/api/missions");
    const data = await res.json();
    missions.value = data.missions || [];
  } catch (err) {
    alert(err.message);
  } finally {
    loading.value = false;
  }
}

async function selectMission(id) {
  if (selectedId.value === id) return;
  selectedId.value = id;
  stopReplay();
  try {
    const [dRes, tRes] = await Promise.all([
      request(`/api/missions/${id}`).then((r) => r.json()),
      request(`/api/missions/${id}/telemetry`).then((r) => r.json()),
    ]);
    detail.value = dRes;
    samples.value = tRes.samples || [];
    replayIdx.value = 0;
    renderMap();
  } catch (err) {
    alert(err.message);
  }
}

function clearMap() {
  for (const m of plannedMarkers) { try { map.removeLayer(m); } catch {} }
  plannedMarkers = [];
  if (plannedPath) { try { map.removeLayer(plannedPath); } catch {} plannedPath = null; }
  if (telemetryLine) { try { map.removeLayer(telemetryLine); } catch {} telemetryLine = null; }
  if (replayMarker) { try { map.removeLayer(replayMarker); } catch {} replayMarker = null; }
}

function renderMap() {
  if (!map || !detail.value) return;
  clearMap();

  // Planned waypoints
  const waypoints = detail.value.waypoints || [];
  waypoints.forEach((wp, i) => {
    const marker = L.marker([wp.lat, wp.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:20px;height:20px;border-radius:50%;background:#8b5cf6;border:2px solid #fff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${i + 1}</div>`,
        iconSize: [20, 20], iconAnchor: [10, 10],
      }),
      interactive: false,
    }).addTo(map);
    plannedMarkers.push(marker);
  });
  if (waypoints.length > 0) {
    plannedPath = L.polyline(waypoints.map((w) => [w.lat, w.lng]), {
      color: "#8b5cf6", weight: 2, dashArray: "6 4", opacity: 0.7,
    }).addTo(map);
  }

  // Actual telemetry
  const validSamples = samples.value.filter((s) => s.lat != null && s.lng != null);
  if (validSamples.length >= 2) {
    telemetryLine = L.polyline(validSamples.map((s) => [s.lat, s.lng]), {
      color: "#ef4444", weight: 3, opacity: 0.9,
    }).addTo(map);
  }

  // Fit bounds
  const allPoints = [
    ...waypoints.map((w) => [w.lat, w.lng]),
    ...validSamples.map((s) => [s.lat, s.lng]),
  ];
  if (allPoints.length > 0) {
    map.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
  }

  updateReplayMarker();
}

function updateReplayMarker() {
  if (!map || samples.value.length === 0) return;
  const s = samples.value[replayIdx.value];
  if (!s || s.lat == null) {
    if (replayMarker) { map.removeLayer(replayMarker); replayMarker = null; }
    return;
  }
  const color = s.nav_state === "ERROR" ? "#ef4444"
    : s.nav_state === "SPRAYING" ? "#f59e0b"
    : "#22c55e";
  if (replayMarker) {
    replayMarker.setLatLng([s.lat, s.lng]);
  } else {
    replayMarker = L.marker([s.lat, s.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 2px ${color};"></div>`,
        iconSize: [16, 16], iconAnchor: [8, 8],
      }),
      interactive: false, zIndexOffset: 1000,
    }).addTo(map);
  }
}

watch(replayIdx, updateReplayMarker);

function scheduleNextStep() {
  // Read replayIdx fresh each tick so a slider drag while playing isn't
  // clobbered by a stale closure-captured value.
  const i = replayIdx.value;
  if (i >= samples.value.length - 1) {
    stopReplay();
    return;
  }
  const dt = Math.max(0, (samples.value[i + 1].t || 0) - (samples.value[i].t || 0));
  // 1× = wall-clock replay. Higher multipliers compress the gap. Clamp so a long
  // quiet stretch (>2s scaled) still feels responsive and a 0-gap (same ms) doesn't
  // busy-loop.
  const interval = Math.max(16, Math.min(2000, dt / Math.max(1, replaySpeed.value)));
  playTimer = setTimeout(() => {
    // Re-read live index; if the operator dragged the slider during the wait,
    // continue from their chosen position rather than the one we captured.
    if (!playing.value) return;
    replayIdx.value = Math.min(samples.value.length - 1, replayIdx.value + 1);
    scheduleNextStep();
  }, interval);
}

function startReplay() {
  if (samples.value.length === 0) return;
  if (replayIdx.value >= samples.value.length - 1) replayIdx.value = 0;
  playing.value = true;
  scheduleNextStep();
}

function stopReplay() {
  playing.value = false;
  if (playTimer) { clearTimeout(playTimer); playTimer = null; }
}

function togglePlay() {
  if (playing.value) stopReplay(); else startReplay();
}

const currentSampleTime = computed(() => {
  const s = samples.value[replayIdx.value];
  return s ? formatTimestamp(s.t) : "—";
});
const currentSampleState = computed(() => samples.value[replayIdx.value]?.nav_state || "—");
const currentSampleFix = computed(() => samples.value[replayIdx.value]?.fix_status || "—");

onMounted(async () => {
  await loadMissions();
  await nextTick();
  map = L.map("mission-map", { zoomControl: true }).setView([36.3504, 127.3845], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 22, maxNativeZoom: 19,
  }).addTo(map);
});

onUnmounted(() => {
  stopReplay();
  if (map) map.remove();
});
</script>

<template>
  <div class="missions-layout">
    <div class="missions-sidebar">
      <div class="missions-header">
        <h2>미션 이력</h2>
        <button class="btn btn-ghost btn-sm" @click="loadMissions">↻</button>
      </div>
      <div v-if="loading" class="empty-msg">불러오는 중...</div>
      <div v-else-if="missions.length === 0" class="empty-msg">기록된 미션이 없습니다.</div>
      <div v-else class="missions-list">
        <div
          v-for="m in missions" :key="m.id"
          :class="['mission-item', { selected: selectedId === m.id }]"
          @click="selectMission(m.id)"
        >
          <div class="mission-top">
            <span class="mission-id">#{{ m.id }}</span>
            <span class="status-badge" :style="{ background: STATUS_COLOR[m.status] }">
              {{ STATUS_LABEL[m.status] || m.status }}
            </span>
          </div>
          <div class="mission-meta">
            <span>{{ formatTimestamp(m.started_at) }}</span>
            <span>· {{ formatDuration(m.started_at, m.ended_at) }}</span>
            <span v-if="m.course_name">· {{ m.course_name }}</span>
          </div>
          <div class="mission-meta-sub">{{ m.sample_count }}개 샘플</div>
        </div>
      </div>
    </div>

    <div class="missions-main">
      <div id="mission-map" class="mission-map"></div>
      <div v-if="detail" class="replay-panel">
        <div class="replay-info">
          <span>#{{ detail.id }}</span>
          <span>·</span>
          <span>{{ formatTimestamp(detail.started_at) }}</span>
          <span>·</span>
          <span>{{ formatDuration(detail.started_at, detail.ended_at) }}</span>
          <span>·</span>
          <span class="replay-state">{{ currentSampleState }} / {{ currentSampleFix }}</span>
        </div>
        <div class="replay-controls">
          <button class="btn btn-sm btn-primary" @click="togglePlay" :disabled="samples.length === 0">
            {{ playing ? '⏸ 일시정지' : '▶ 재생' }}
          </button>
          <input
            type="range" class="replay-slider"
            :min="0" :max="Math.max(0, samples.length - 1)" :step="1"
            v-model.number="replayIdx"
            :disabled="samples.length === 0"
          />
          <select v-model.number="replaySpeed" class="replay-speed">
            <option :value="1">1× 실시간</option>
            <option :value="4">4×</option>
            <option :value="16">16×</option>
            <option :value="64">64×</option>
          </select>
          <span class="replay-time">{{ currentSampleTime }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.missions-layout {
  display: flex;
  height: 100%;
  padding: 1.5rem;
  gap: 1rem;
  overflow: hidden;
}

.missions-sidebar {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border-primary);
  border-radius: 12px;
  overflow: hidden;
}

.missions-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-primary);
}
.missions-header h2 { margin: 0; font-size: 1rem; }

.missions-list { flex: 1; overflow-y: auto; }
.empty-msg { padding: 1.5rem; text-align: center; color: var(--text-secondary); font-size: 0.85rem; }

.mission-item {
  padding: 0.6rem 0.9rem;
  cursor: pointer;
  border-bottom: 1px solid var(--border-primary);
  transition: background 0.1s;
}
.mission-item:hover { background: var(--bg-secondary); }
.mission-item.selected { background: color-mix(in srgb, var(--accent-primary) 15%, var(--bg-primary)); }

.mission-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
}
.mission-id { font-weight: 700; font-family: "JetBrains Mono", monospace; }
.status-badge {
  padding: 0.1rem 0.5rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 600;
  color: #fff;
}
.mission-meta {
  font-size: 0.8rem;
  color: var(--text-secondary);
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}
.mission-meta-sub {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 0.2rem;
}

.missions-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-primary);
  border-radius: 12px;
  overflow: hidden;
  min-width: 0;
}
.mission-map { flex: 1; min-height: 0; }

.replay-panel {
  padding: 0.6rem 1rem;
  background: var(--bg-primary);
  border-top: 1px solid var(--border-primary);
}

.replay-info {
  display: flex;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
  align-items: center;
  margin-bottom: 0.4rem;
  flex-wrap: wrap;
}
.replay-state { font-family: "JetBrains Mono", monospace; color: var(--text-primary); }

.replay-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.replay-slider { flex: 1; min-width: 0; accent-color: var(--accent-primary); }
.replay-speed {
  padding: 0.3rem 0.5rem;
  background: var(--bg-primary); color: var(--text-primary);
  border: 1px solid var(--border-primary); border-radius: 6px;
  font-family: "JetBrains Mono", monospace;
}
.replay-time {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8rem;
  color: var(--text-secondary);
  min-width: 12em;
  text-align: right;
}

@media (max-width: 768px) {
  .missions-layout { flex-direction: column; padding: 0.75rem; }
  .missions-sidebar { width: 100%; max-height: 280px; }
  .replay-time { display: none; }
}
</style>
