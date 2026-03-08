<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useSSE } from "../composables/useSSE";
import { fetchRecord } from "../composables/useApi";

const { recordFiles: allRecordFiles, selectedFile, lastUpdate, connected } = useSSE();

const recordFiles = computed(() => {
  return allRecordFiles.value.filter((file) => file !== "controller");
});

const records = ref([]);
const loading = ref(false);
const isFullscreen = ref(false);
const trackTemp = ref("");

const EVENT_CONFIG = {
  가속: { label: "ACCELERATION", color: "#ffd000" },
  스키드패드: { label: "SKIDPAD", color: "#00e5ff" },
  짐카나: { label: "GYMKHANA", color: "#bf5af2" },
};

async function loadRecords() {
  if (!selectedFile.value) {
    records.value = [];
    return;
  }

  loading.value = true;
  try {
    const data = await fetchRecord(selectedFile.value);
    records.value = data;
  } catch (err) {
    console.error("기록 조회 실패:", err);
  } finally {
    loading.value = false;
  }
}

watch(selectedFile, () => loadRecords());

watch(lastUpdate, (update) => {
  if (update && update.name === selectedFile.value) {
    loadRecords();
  }
});

const validRecords = computed(() => {
  return records.value.filter((r) => r.scoreboard);
});

const availableTypes = computed(() => {
  const types = new Set(validRecords.value.map((r) => r.type));
  return Object.keys(EVENT_CONFIG).filter((t) => types.has(t));
});

const recordsByType = computed(() => {
  const grouped = {};
  availableTypes.value.forEach((type) => {
    grouped[type] = validRecords.value.filter((r) => r.type === type);
  });
  return grouped;
});

const latestByType = computed(() => {
  const latest = {};
  availableTypes.value.forEach((type) => {
    const typeRecords = recordsByType.value[type];
    if (typeRecords && typeRecords.length > 0) {
      latest[type] = [...typeRecords].sort((a, b) => new Date(b.time) - new Date(a.time))[0];
    }
  });
  return latest;
});

const bestRecords = computed(() => {
  const best = {};
  availableTypes.value.forEach((type) => {
    const valid = recordsByType.value[type]?.filter((r) => r.result > 0) || [];
    if (valid.length) {
      best[type] = valid.reduce((a, b) => (a.result < b.result ? a : b));
    }
  });
  return best;
});

const topRecords = computed(() => {
  const top = {};
  availableTypes.value.forEach((type) => {
    const latest = latestByType.value[type];
    const valid = recordsByType.value[type]?.filter((r) => r.result > 0 && r.rowid !== latest?.rowid) || [];
    top[type] = [...valid].sort((a, b) => a.result - b.result).slice(0, 5);
  });
  return top;
});

function formatResult(ms) {
  if (ms < 0) return "DNF";

  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
  }
  return seconds.toFixed(3);
}

const displayArea = ref(null);

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    displayArea.value?.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

function handleFullscreenChange() {
  isFullscreen.value = !!document.fullscreenElement;
  if (isFullscreen.value) {
    document.body.classList.add("scoreboard-fullscreen");
  } else {
    document.body.classList.remove("scoreboard-fullscreen");
  }
}

onMounted(() => {
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  if (selectedFile.value) {
    loadRecords();
  }
});

onUnmounted(() => {
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  document.body.classList.remove("scoreboard-fullscreen");
});
</script>

<template>
  <div class="scoreboard-page">
    <div class="scoreboard-container">
      <!-- Controls -->
      <div v-show="!isFullscreen" class="controls">
        <div class="control-group">
          <select v-model="selectedFile" class="form-select">
            <option :value="null" disabled>파일 선택</option>
            <option v-for="file in recordFiles" :key="file" :value="file">
              {{ file }}
            </option>
          </select>

          <input
            v-model="trackTemp"
            class="form-input temp-input"
            type="text"
            placeholder="Track Temp"
          />

          <button class="btn btn-secondary" @click="toggleFullscreen" title="전체화면">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Display Area 3:4 ratio -->
      <div class="display-wrapper">
        <div ref="displayArea" class="display-area">
          <div v-if="!selectedFile" class="empty-state"></div>
          <div v-else-if="records.length === 0 && !loading" class="empty-state">
            <p>기록이 없습니다</p>
          </div>

          <!-- Scoreboard -->
          <div v-else class="scoreboard">
            <!-- Header -->
            <header class="header">
              <h1 class="title">FSK Race Control</h1>
              <div class="live">
                <span class="live-dot" :class="{ connected }"></span>
                <span>LIVE</span>
              </div>
              <div class="temp" v-if="trackTemp">
                <span>Track Temp : </span>
                <span class="temp-val">{{ trackTemp }}°C</span>
              </div>
            </header>

            <!-- Panels -->
            <div class="panels" :class="`cols-${availableTypes.length}`">
              <div
                v-for="type in availableTypes"
                :key="type"
                class="panel"
                :style="{ '--panel-color': EVENT_CONFIG[type].color }"
              >
                <!-- Panel Title -->
                <div class="panel-title">{{ EVENT_CONFIG[type].label }}</div>

                <!-- Main Box -->
                <div class="main-box">
                  <div class="accent-bar"></div>
                  <div class="box-content">
                    <!-- Vehicle Info -->
                    <div class="vehicle" v-if="latestByType[type]">
                      <div class="vehicle-no">
                        <span class="no-label">No.</span>
                        <span class="no-value">{{ String(latestByType[type].num).padStart(2, "0") }}</span>
                      </div>
                      <div class="vehicle-team">{{ latestByType[type].univ }} {{ latestByType[type].team }}</div>
                    </div>
                    <div class="vehicle empty" v-else>
                      <div class="vehicle-no">
                        <span class="no-label">No.</span>
                        <span class="no-value">--</span>
                      </div>
                      <div class="vehicle-team">-</div>
                    </div>

                    <!-- Current Time -->
                    <div class="current-time-section">
                      <div class="current-time-box">
                        <div class="time-label">Current Record</div>
                        <span class="current-time" v-if="latestByType[type]">
                          {{ formatResult(latestByType[type].result) }}<span class="unit">s</span>
                        </span>
                        <span class="current-time" v-else>--:--<span class="unit">s</span></span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Best Record (RED) -->
                <div class="best-section">
                  <div class="best-label">Best Record</div>
                  <div class="best-row" v-if="bestRecords[type]">
                    <span class="best-team">
                      <span class="best-team-inner">
                        <span class="best-num">{{ String(bestRecords[type].num).padStart(2, "0") }}</span>
                        <span class="best-team-text">{{ bestRecords[type].univ }} {{ bestRecords[type].team }}</span>
                      </span>
                    </span>
                    <span class="best-time">{{ formatResult(bestRecords[type].result) }}<span class="unit">s</span></span>
                  </div>
                </div>

                <!-- Recent Records -->
                <div class="record-section">
                  <div class="record-box">
                    <div class="record-label">Recent Records</div>
                    <div class="record-list">
                      <div v-for="record in topRecords[type]" :key="record.rowid" class="record-row">
                        <span class="record-info">
                          <span class="record-num">{{ String(record.num).padStart(2, "0") }}</span>
                          <span class="record-team">{{ record.univ }} {{ record.team }}</span>
                        </span>
                        <span class="record-time">{{ formatResult(record.result) }}<span class="unit">s</span></span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scoreboard-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 0;
}

.scoreboard-container {
  width: 100%;
  max-width: 1400px;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.display-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

/* 4:3 aspect ratio (landscape) */
.display-area {
  width: 100%;
  aspect-ratio: 4 / 3;
  background: #000;
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

:global(.scoreboard-fullscreen) .display-area {
  max-width: none;
  aspect-ratio: auto;
  height: 100vh;
  width: 100vw;
  border-radius: 0;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  font-size: 2rem;
  background: #000;
}

/* Scoreboard */
.scoreboard {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 2rem 2.5rem;
  background: #000;
  color: #fff;
  overflow: hidden;
}

:global(.scoreboard-fullscreen) .scoreboard {
  padding: 3rem 5rem;
}

/* Header */
.header {
  display: flex;
  align-items: center;
  gap: 2rem;
  margin-bottom: 1.5rem;
}

.title {
  font-size: 2.5rem;
  font-weight: 700;
  color: #fff;
  margin: 0;
}

:global(.scoreboard-fullscreen) .title {
  font-size: 4rem;
}

.live {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.4rem;
  font-weight: 600;
}

:global(.scoreboard-fullscreen) .live {
  font-size: 2rem;
}

.live-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #666;
}

:global(.scoreboard-fullscreen) .live-dot {
  width: 24px;
  height: 24px;
}

.live-dot.connected {
  background: #ef4444;
}

.temp {
  font-size: 1.4rem;
  margin-left: auto;
}

:global(.scoreboard-fullscreen) .temp {
  font-size: 2rem;
}

.temp-val {
  color: #ff6b6b;
  font-weight: 700;
}

/* Panels */
.panels {
  flex: 1;
  display: grid;
  gap: 2rem;
  min-height: 0;
}

.panels.cols-1 {
  grid-template-columns: 1fr;
}

.panels.cols-2 {
  grid-template-columns: repeat(2, 1fr);
}

.panels.cols-3 {
  grid-template-columns: repeat(3, 1fr);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

/* Panel Title */
.panel-title {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--panel-color);
  letter-spacing: 0.08em;
}

:global(.scoreboard-fullscreen) .panel-title {
  font-size: 2rem;
}

/* Main Box */
.main-box {
  border: 4px solid var(--panel-color);
  border-radius: 16px;
  display: flex;
  overflow: hidden;
}

:global(.scoreboard-fullscreen) .main-box {
  border-width: 6px;
}

.accent-bar {
  width: 14px;
  background: var(--panel-color);
  flex-shrink: 0;
}

:global(.scoreboard-fullscreen) .accent-bar {
  width: 20px;
}

.box-content {
  flex: 1;
  padding: 1rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

:global(.scoreboard-fullscreen) .box-content {
  padding: 1.5rem 2rem;
  gap: 1.2rem;
}

/* Vehicle */
.vehicle {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.vehicle.empty {
  opacity: 0.5;
}

.vehicle-no {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
}

.no-label {
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--panel-color);
  font-style: italic;
}

:global(.scoreboard-fullscreen) .no-label {
  font-size: 2.5rem;
}

.no-value {
  font-size: 2.8rem;
  font-weight: 800;
  color: #fff;
  font-style: italic;
}

:global(.scoreboard-fullscreen) .no-value {
  font-size: 4rem;
}

.vehicle-team {
  font-size: 2.2rem;
  color: #fff;
  font-weight: 600;
  line-height: 1.6;
  height: 3.2em;
  display: flex;
  align-items: center;
  overflow: hidden;
}

:global(.scoreboard-fullscreen) .vehicle-team {
  font-size: 3.5rem;
}

/* Current Time */
.current-time-section {
  display: flex;
  flex-direction: column;
}

.current-time-box {
  border: 4px solid var(--panel-color);
  border-radius: 14px;
  padding: 0.3rem 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

:global(.scoreboard-fullscreen) .current-time-box {
  border-width: 6px;
  padding: 0.5rem 1.5rem;
}

.time-label {
  position: absolute;
  top: -2px;
  left: 1rem;
  font-size: 1.3rem;
  color: #fff;
  font-weight: 500;
  background: #000;
  padding: 0 0.5rem;
  transform: translateY(-50%);
}

:global(.scoreboard-fullscreen) .time-label {
  font-size: 1.8rem;
  top: -3px;
  left: 1.5rem;
}

.current-time {
  font-size: 2.8rem;
  font-weight: 800;
  color: var(--panel-color);
  font-style: italic;
}

:global(.scoreboard-fullscreen) .current-time {
  font-size: 4.5rem;
}

.unit {
  font-size: 0.55em;
  margin-left: 0.08em;
}

/* Best Record - RED */
.best-section {
  margin-top: 0.5rem;
}

.best-label {
  font-size: 1.5rem;
  color: #ff4444;
  font-style: italic;
  font-weight: 600;
  margin-bottom: 0.3rem;
  line-height: 1;
}

:global(.scoreboard-fullscreen) .best-label {
  font-size: 2.2rem;
}

.best-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.best-team {
  font-size: 1.8rem;
  line-height: 1.6;
  height: 3.2em;
  display: flex;
  align-items: center;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

:global(.scoreboard-fullscreen) .best-team {
  font-size: 2.5rem;
}

.best-team-inner {
  display: flex;
  align-items: flex-start;
  color: #fff;
  font-weight: 500;
}

.best-team-text {
  flex: 1;
  min-width: 0;
}

.best-num {
  color: #ff4444;
  font-weight: 700;
  margin-right: 0.6rem;
}

.best-time {
  font-size: 2.5rem;
  font-weight: 800;
  line-height: 1.5;
  color: #ff4444;
}

:global(.scoreboard-fullscreen) .best-time {
  font-size: 3.5rem;
}

/* Recent Records */
.record-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-top: 0.8rem;
}

:global(.scoreboard-fullscreen) .record-section {
  margin-top: 1.2rem;
}

.record-box {
  border: 3px solid var(--panel-color);
  border-radius: 12px;
  padding: 1.8rem 1rem 1.2rem;
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
}

:global(.scoreboard-fullscreen) .record-box {
  border-width: 4px;
  padding: 2.5rem 1.5rem 1.8rem;
}

.record-label {
  position: absolute;
  top: -1.5px;
  left: 1rem;
  font-size: 1.3rem;
  color: #fff;
  font-style: italic;
  font-weight: 500;
  background: #000;
  padding: 0 0.5rem;
  transform: translateY(-50%);
}

:global(.scoreboard-fullscreen) .record-label {
  font-size: 1.8rem;
  top: -2px;
  left: 1.5rem;
}

.record-list {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 0.8rem;
  flex: 1;
}

:global(.scoreboard-fullscreen) .record-list {
  gap: 1.2rem;
}

.record-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.record-info {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 1.5rem;
}

:global(.scoreboard-fullscreen) .record-info {
  font-size: 2.2rem;
}

.record-num {
  color: var(--panel-color);
  font-weight: 700;
}

.record-team {
  color: #fff;
  font-weight: 500;
}

.record-time {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--panel-color);
  font-style: italic;
}

:global(.scoreboard-fullscreen) .record-time {
  font-size: 2.2rem;
}

/* Controls */
.controls {
  width: 100%;
  background: var(--bg-card);
  border-radius: 16px;
  box-shadow: var(--shadow-card);
  padding: 1rem 1.5rem;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.form-select {
  min-width: 200px;
  padding: 0.5rem 0.875rem;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.form-select:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.form-input {
  padding: 0.5rem 0.875rem;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.form-input:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.temp-input {
  width: 150px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.625rem 1rem;
  border: none;
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
}

.btn-secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.btn-secondary:hover {
  background: var(--bg-hover);
}

@media (max-width: 768px) {
  .panels.cols-3,
  .panels.cols-2 {
    grid-template-columns: 1fr;
  }

  .scoreboard {
    padding: 1.5rem;
  }

  .title {
    font-size: 1.8rem;
  }

  .current-time {
    font-size: 3rem;
  }
}
</style>
