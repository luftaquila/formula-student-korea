<script setup>
import { ref, computed, watch, onMounted, onUnmounted, onActivated, onDeactivated } from "vue";

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
const isActive = ref(true);
const missedUpdate = ref(false);
const lastLoadedFile = ref(null);

const EVENT_CONFIG = {
  가속: { label: "ACCELERATION", color: "#ffd000" },
  스키드패드: { label: "SKIDPAD", color: "#00e5ff" },
  오토크로스: { label: "AUTOCROSS", color: "#ff6b6b" },
};

const SCOREBOARD_THEME_KEY = "traffic-scoreboard-theme";
const SCOREBOARD_COLORS_KEY = "traffic-scoreboard-colors";
const SCOREBOARD_VISIBILITY_KEY = "traffic-scoreboard-visibility";

function loadScoreboardTheme() {
  const saved = localStorage.getItem(SCOREBOARD_THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "dark";
}

function loadEventColors() {
  const colors = Object.fromEntries(
    Object.entries(EVENT_CONFIG).map(([type, config]) => [type, config.color]),
  );

  try {
    const saved = JSON.parse(localStorage.getItem(SCOREBOARD_COLORS_KEY));
    for (const type of Object.keys(EVENT_CONFIG)) {
      if (typeof saved?.[type] === "string" && /^#[0-9a-f]{6}$/i.test(saved[type])) {
        colors[type] = saved[type];
      }
    }
  } catch {
    // Ignore malformed local settings and keep the built-in colors.
  }

  return colors;
}

function loadEventVisibility() {
  const visibility = Object.fromEntries(
    Object.keys(EVENT_CONFIG).map((type) => [type, true]),
  );

  try {
    const saved = JSON.parse(localStorage.getItem(SCOREBOARD_VISIBILITY_KEY));
    for (const type of Object.keys(EVENT_CONFIG)) {
      if (typeof saved?.[type] === "boolean") {
        visibility[type] = saved[type];
      }
    }
  } catch {
    // Ignore malformed local settings and show every event by default.
  }

  return visibility;
}

const scoreboardTheme = ref(loadScoreboardTheme());
const eventColors = ref(loadEventColors());
const eventVisibility = ref(loadEventVisibility());

function toggleScoreboardTheme() {
  scoreboardTheme.value = scoreboardTheme.value === "dark" ? "light" : "dark";
}

watch(scoreboardTheme, (theme) => {
  localStorage.setItem(SCOREBOARD_THEME_KEY, theme);
});

watch(eventColors, (colors) => {
  localStorage.setItem(SCOREBOARD_COLORS_KEY, JSON.stringify(colors));
}, { deep: true });

watch(eventVisibility, (visibility) => {
  localStorage.setItem(SCOREBOARD_VISIBILITY_KEY, JSON.stringify(visibility));
}, { deep: true });

let fetchSeq = 0;

async function loadRecords() {
  if (!selectedFile.value) {
    records.value = [];
    lastLoadedFile.value = null;
    return;
  }

  loading.value = true;
  const seq = ++fetchSeq;
  try {
    const data = await fetchRecord(selectedFile.value);
    if (seq !== fetchSeq) return;
    records.value = data;
    lastLoadedFile.value = selectedFile.value;
  } catch (err) {
    if (seq !== fetchSeq) return;
    console.error("기록 조회 실패:", err);
  } finally {
    if (seq === fetchSeq) loading.value = false;
  }
}

watch(selectedFile, () => { if (isActive.value) loadRecords(); });

watch(lastUpdate, (update) => {
  if (!isActive.value) {
    if (update && update.name === selectedFile.value) {
      missedUpdate.value = true;
    }
    return;
  }
  if (update && update.name === selectedFile.value) {
    loadRecords();
  }
});

const validRecords = computed(() => {
  return records.value.filter((r) => r.scoreboard);
});

const availableTypes = computed(() => {
  const types = new Set(validRecords.value.map((r) => r.type));
  return Object.keys(EVENT_CONFIG).filter((t) => types.has(t) && eventVisibility.value[t]);
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
    const valid = recordsByType.value[type]?.filter((r) => r.status == null && r.result > 0) || [];
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
    const valid = recordsByType.value[type]?.filter((r) => r.status == null && r.result > 0 && r.rowid !== latest?.rowid) || [];
    top[type] = [...valid].sort((a, b) => a.result - b.result).slice(0, 5);
  });
  return top;
});

function formatResult(ms, status = null) {
  if (status) return status;
  if (!Number.isFinite(ms) || ms <= 0) return "--:--";

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

onActivated(() => {
  isActive.value = true;
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  if (missedUpdate.value || lastLoadedFile.value !== selectedFile.value) {
    missedUpdate.value = false;
    loadRecords();
  }
});

onDeactivated(() => {
  isActive.value = false;
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
          <select v-model="selectedFile" class="form-select" aria-label="기록 파일">
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
            aria-label="트랙 온도"
          />

          <button
            type="button"
            class="btn btn-secondary scoreboard-theme-toggle"
            :data-theme="scoreboardTheme"
            :title="scoreboardTheme === 'dark' ? '화이트 전광판 테마' : '다크 전광판 테마'"
            :aria-label="scoreboardTheme === 'dark' ? '화이트 전광판 테마로 전환' : '다크 전광판 테마로 전환'"
            data-testid="scoreboard-theme"
            @click="toggleScoreboardTheme"
          >
            <svg v-if="scoreboardTheme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          </button>

          <div class="accent-controls" role="group" aria-label="이벤트 표시 및 악센트 컬러">
            <div v-for="(config, type) in EVENT_CONFIG" :key="type" class="event-control">
              <label class="visibility-control">
                <input
                  v-model="eventVisibility[type]"
                  type="checkbox"
                  :data-testid="`scoreboard-visible-${type}`"
                />
                <span>{{ config.label }}</span>
              </label>
              <label
                class="color-control"
                :style="{ '--picker-color': eventColors[type] }"
              >
                <input
                  v-model="eventColors[type]"
                  type="color"
                  :aria-label="`${config.label} 악센트 컬러`"
                  :data-testid="`scoreboard-color-${type}`"
                />
                <output :data-testid="`scoreboard-color-value-${type}`">
                  {{ eventColors[type].toUpperCase() }}
                </output>
              </label>
            </div>
          </div>

          <button class="btn btn-secondary" @click="toggleFullscreen" title="전체화면">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Display Area 3:4 ratio -->
      <div class="display-wrapper">
        <div ref="displayArea" class="display-area" :data-scoreboard-theme="scoreboardTheme">
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
                :style="{ '--panel-color': eventColors[type] }"
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
                          {{ formatResult(latestByType[type].result, latestByType[type].status) }}<span v-if="!latestByType[type].status" class="unit">s</span>
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
                    <div class="record-label">Top Records</div>
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
  --scoreboard-bg: #000;
  --scoreboard-text: #fff;
  --scoreboard-muted: #666;
  --scoreboard-best: #ff4444;
  --scoreboard-live: #ef4444;
  --scoreboard-temp: #ff6b6b;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: var(--scoreboard-bg);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.display-area[data-scoreboard-theme="light"] {
  --scoreboard-bg: #fff;
  --scoreboard-text: #17191f;
  --scoreboard-muted: #6b7280;
  --scoreboard-best: #c81e1e;
  --scoreboard-live: #dc2626;
  --scoreboard-temp: #c81e1e;
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
  color: var(--scoreboard-muted);
  font-size: 2rem;
  background: var(--scoreboard-bg);
}

/* Scoreboard */
.scoreboard {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 2rem 2.5rem;
  background: var(--scoreboard-bg);
  color: var(--scoreboard-text);
  overflow: hidden;
}

:global(.scoreboard-fullscreen) .scoreboard {
  padding: 3rem 5rem;
}

/* Header — override the app shell's globally dark .header surface. */
.scoreboard > .header {
  display: flex;
  align-items: center;
  gap: 2rem;
  margin-bottom: 1.5rem;
  padding: 0;
  background: transparent;
  border: 0;
}

.title {
  font-size: 2.5rem;
  font-weight: 700;
  color: var(--scoreboard-text);
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
  background: var(--scoreboard-muted);
}

:global(.scoreboard-fullscreen) .live-dot {
  width: 24px;
  height: 24px;
}

.live-dot.connected {
  background: var(--scoreboard-live);
}

.temp {
  font-size: 1.4rem;
  margin-left: auto;
}

:global(.scoreboard-fullscreen) .temp {
  font-size: 2rem;
}

.temp-val {
  color: var(--scoreboard-temp);
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

.panels.cols-4 {
  grid-template-columns: repeat(4, 1fr);
}

.panel {
  --panel-fg: var(--panel-color);
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.display-area[data-scoreboard-theme="light"] .panel {
  --panel-fg: color-mix(in srgb, var(--panel-color) 68%, #000);
}

/* Panel Title */
.panel-title {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--panel-fg);
  letter-spacing: 0.08em;
}

:global(.scoreboard-fullscreen) .panel-title {
  font-size: 2rem;
}

/* Main Box */
.main-box {
  border: 4px solid var(--panel-color);
  border-radius: 12px;
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
  color: var(--panel-fg);
  font-style: italic;
}

:global(.scoreboard-fullscreen) .no-label {
  font-size: 2.5rem;
}

.no-value {
  font-size: 2.8rem;
  font-weight: 800;
  color: var(--scoreboard-text);
  font-style: italic;
}

:global(.scoreboard-fullscreen) .no-value {
  font-size: 4rem;
}

.vehicle-team {
  font-size: 2.2rem;
  color: var(--scoreboard-text);
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
  color: var(--scoreboard-text);
  font-weight: 500;
  background: var(--scoreboard-bg);
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
  color: var(--panel-fg);
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
  color: var(--scoreboard-best);
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
  color: var(--scoreboard-text);
  font-weight: 500;
}

.best-team-text {
  flex: 1;
  min-width: 0;
}

.best-num {
  color: var(--scoreboard-best);
  font-weight: 700;
  margin-right: 0.6rem;
}

.best-time {
  font-size: 2.5rem;
  font-weight: 800;
  line-height: 1.5;
  color: var(--scoreboard-best);
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
  color: var(--scoreboard-text);
  font-style: italic;
  font-weight: 500;
  background: var(--scoreboard-bg);
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
  color: var(--panel-fg);
  font-weight: 700;
}

.record-team {
  color: var(--scoreboard-text);
  font-weight: 500;
}

.record-time {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--panel-fg);
  font-style: italic;
}

:global(.scoreboard-fullscreen) .record-time {
  font-size: 2.2rem;
}

/* Controls */
.controls {
  width: 100%;
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  padding: 1rem 1.5rem;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.accent-controls,
.event-control,
.visibility-control,
.color-control {
  display: flex;
  align-items: center;
}

.btn.scoreboard-theme-toggle {
  width: 40px;
  height: 38px;
  min-width: 40px;
  padding: 0;
  flex: 0 0 40px;
}

.btn.scoreboard-theme-toggle svg {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
}

.accent-controls {
  gap: 0.75rem;
  padding-left: 0.75rem;
  border-left: 1px solid var(--border-color);
  flex-wrap: wrap;
}

.event-control,
.visibility-control {
  gap: 0.35rem;
}

.color-control {
  position: relative;
  min-width: 78px;
  height: 30px;
  justify-content: center;
  overflow: hidden;
  background: color-mix(in srgb, var(--picker-color) 12%, var(--bg-input));
  border: 1px solid color-mix(in srgb, var(--picker-color) 65%, var(--border-color));
  border-radius: 6px;
  cursor: pointer;
}

.event-control {
  color: var(--text-primary);
  font-size: 0.75rem;
  font-weight: 500;
}

.visibility-control {
  cursor: pointer;
}

.visibility-control input[type="checkbox"] {
  width: 15px;
  height: 15px;
  accent-color: var(--accent-primary);
  cursor: pointer;
}

.color-control input[type="color"] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  opacity: 0;
  border: 0;
  cursor: pointer;
}

.color-control output {
  color: var(--picker-color);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
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
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
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
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
}

.temp-input {
  width: 110px;
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
  .accent-controls {
    width: 100%;
    padding-top: 0.75rem;
    padding-left: 0;
    border-top: 1px solid var(--border-color);
    border-left: 0;
  }

  .panels.cols-4,
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
