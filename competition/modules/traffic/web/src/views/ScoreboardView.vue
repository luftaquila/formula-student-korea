<script setup>
import { ref, computed, watch, onMounted, onUnmounted, onActivated, onDeactivated } from "vue";
import { useRoute } from "vue-router";

import { useSSE } from "../composables/useSSE";
import { fetchRecord } from "../composables/useApi";
import { useWirelessStore } from "../stores/wireless";
import { currentCompetitionYear } from "@shared/common/competition-year.mjs";
import {
  scoreboardLiveAttempt,
  scoreboardRecordEffects,
  scoreboardRecordFiles,
  scoreboardSerialLiveAttempt,
} from "../utils/scoreboard-live";
import {
  MAX_EVENT_LABEL_LENGTH,
  scoreboardEventLabels,
} from "../utils/scoreboard-settings";

const {
  recordFiles: allRecordFiles,
  selectedFile,
  lastUpdate,
  connected,
  reconnected,
  liveAttempts: serialLiveAttempts,
} = useSSE();
const route = useRoute();
const wirelessStore = useWirelessStore();
const competitionYear = currentCompetitionYear();
const isWirelessScoreboard = computed(() => route.path.startsWith("/wireless/"));

const records = ref([]);
const loading = ref(false);
const isFullscreen = ref(false);
const trackTemp = ref("");
const isActive = ref(true);
const missedUpdate = ref(false);
const lastLoadedFile = ref(null);
const scoreboardNow = ref(Date.now());
const currentRecordEffects = ref({});
const bestRecordEffects = ref({});

const EVENT_CONFIG = {
  가속: { mode: "accel", label: "ACCELERATION", color: "#ffd000" },
  스키드패드: { mode: "skidpad", label: "SKIDPAD", color: "#00e5ff" },
  오토크로스: { mode: "autocross", label: "AUTOCROSS", color: "#ff6b6b" },
};

const recordFiles = computed(() => scoreboardRecordFiles({
  persistedFiles: allRecordFiles.value,
  sessions: isWirelessScoreboard.value ? wirelessStore.sessions : null,
  liveAttempts: isWirelessScoreboard.value ? null : serialLiveAttempts.value,
  year: competitionYear,
  eventTypes: Object.keys(EVENT_CONFIG),
}));

const SCOREBOARD_COLORS_KEY = "traffic-scoreboard-colors";
const SCOREBOARD_VISIBILITY_KEY = "traffic-scoreboard-visibility";
const SCOREBOARD_LABELS_KEY = "traffic-scoreboard-labels";

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

function loadEventLabels() {
  return scoreboardEventLabels(EVENT_CONFIG, localStorage.getItem(SCOREBOARD_LABELS_KEY));
}

const eventColors = ref(loadEventColors());
const eventVisibility = ref(loadEventVisibility());
const eventLabels = ref(loadEventLabels());

watch(eventColors, (colors) => {
  localStorage.setItem(SCOREBOARD_COLORS_KEY, JSON.stringify(colors));
}, { deep: true });

watch(eventVisibility, (visibility) => {
  localStorage.setItem(SCOREBOARD_VISIBILITY_KEY, JSON.stringify(visibility));
}, { deep: true });

watch(eventLabels, (labels) => {
  localStorage.setItem(SCOREBOARD_LABELS_KEY, JSON.stringify(labels));
}, { deep: true });

let fetchSeq = 0;
let effectBaseline = null;
let effectsPrimed = false;

function resetRecordEffects() {
  effectBaseline = null;
  effectsPrimed = false;
  currentRecordEffects.value = {};
  bestRecordEffects.value = {};
}

function activateRecordEffects(types, target) {
  if (!types.length) return;
  target.value = {
    ...target.value,
    ...Object.fromEntries(types.map((type) => [type, true])),
  };
}

function clearRecordEffect(target, type, event) {
  if (event.target !== event.currentTarget) return;
  const next = { ...target.value };
  delete next[type];
  target.value = next;
}

function clearCurrentRecordEffect(type, event) {
  clearRecordEffect(currentRecordEffects, type, event);
}

function clearBestRecordEffect(type, event) {
  clearRecordEffect(bestRecordEffects, type, event);
}

async function loadRecords() {
  if (!selectedFile.value) {
    records.value = [];
    lastLoadedFile.value = null;
    return;
  }
  if (
    !allRecordFiles.value.includes(selectedFile.value)
    && recordFiles.value.includes(selectedFile.value)
  ) {
    records.value = [];
    lastLoadedFile.value = selectedFile.value;
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

watch(selectedFile, () => {
  resetRecordEffects();
  if (isActive.value) loadRecords();
});

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

watch(reconnected, () => {
  if (!selectedFile.value) return;
  if (!isActive.value) {
    missedUpdate.value = true;
    return;
  }
  loadRecords();
});

const validRecords = computed(() => {
  return records.value.filter((r) => r.scoreboard);
});

const liveAttempts = computed(() => {
  const attempts = {};
  if (!isWirelessScoreboard.value) {
    for (const type of Object.keys(EVENT_CONFIG)) {
      const activeAttempt = serialLiveAttempts.value[type];
      if (!activeAttempt) continue;
      const attempt = scoreboardSerialLiveAttempt({
        selectedFile: selectedFile.value,
        year: competitionYear,
        attempt: activeAttempt,
        now: scoreboardNow.value,
      });
      if (attempt) attempts[type] = attempt;
    }
    return attempts;
  }

  for (const [type, config] of Object.entries(EVENT_CONFIG)) {
    const attempt = scoreboardLiveAttempt({
      selectedFile: selectedFile.value,
      year: competitionYear,
      session: wirelessStore.sessions?.[type],
      timing: wirelessStore.timing?.[config.mode],
      records: records.value,
    });
    if (attempt) attempts[type] = attempt;
  }
  return attempts;
});

const availableTypes = computed(() => {
  const types = new Set(validRecords.value.map((r) => r.type));
  for (const type of Object.keys(liveAttempts.value)) types.add(type);
  return Object.keys(EVENT_CONFIG).filter((t) => types.has(t) && eventVisibility.value[t]);
});

const recordsByType = computed(() => {
  const grouped = {};
  Object.keys(EVENT_CONFIG).forEach((type) => {
    grouped[type] = validRecords.value.filter((r) => r.type === type);
  });
  return grouped;
});

const latestByType = computed(() => {
  const latest = {};
  Object.keys(EVENT_CONFIG).forEach((type) => {
    const typeRecords = recordsByType.value[type];
    if (typeRecords && typeRecords.length > 0) {
      latest[type] = [...typeRecords].sort((a, b) => new Date(b.time) - new Date(a.time))[0];
    }
  });
  return latest;
});

const currentByType = computed(() => Object.fromEntries(
  availableTypes.value.map((type) => [type, liveAttempts.value[type] || latestByType.value[type]]),
));

const bestRecords = computed(() => {
  const best = {};
  Object.keys(EVENT_CONFIG).forEach((type) => {
    const valid = recordsByType.value[type]?.filter((r) => r.status == null && r.result > 0) || [];
    if (valid.length) {
      best[type] = valid.reduce((a, b) => (a.result < b.result ? a : b));
    }
  });
  return best;
});

watch([latestByType, bestRecords], () => {
  const nextState = {
    latest: latestByType.value,
    best: bestRecords.value,
  };
  if (!effectsPrimed) {
    effectBaseline = nextState;
    effectsPrimed = true;
    return;
  }
  const effects = scoreboardRecordEffects(
    effectBaseline,
    nextState,
    Object.keys(EVENT_CONFIG),
  );
  effectBaseline = nextState;
  activateRecordEffects(effects.confirmed, currentRecordEffects);
  activateRecordEffects(effects.bestUpdated, bestRecordEffects);
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

const displayWrapper = ref(null);
const fitTextHandlers = new WeakMap();

function textFitKey(value, element) {
  if (Array.isArray(value)) return value.map((part) => String(part ?? "")).join("\u0000");
  return element.textContent;
}

function scheduleTextFit(element) {
  const state = fitTextHandlers.get(element);
  if (!state) return;

  cancelAnimationFrame(state.frame);
  state.frame = requestAnimationFrame(() => {
    if (!element.isConnected) return;

    element.style.removeProperty("font-size");
    const maximumSize = Number.parseFloat(getComputedStyle(element).fontSize);
    let fittedSize = maximumSize;

    for (let attempt = 0; attempt < 4 && element.scrollWidth > element.clientWidth; attempt += 1) {
      const availableWidth = element.clientWidth;
      if (availableWidth <= 0) break;
      fittedSize *= (availableWidth - 2) / element.scrollWidth;
      element.style.fontSize = `${fittedSize.toFixed(2)}px`;
    }
  });
}

const vFitText = {
  mounted(element, binding) {
    const state = {
      frame: 0,
      key: textFitKey(binding.value, element),
      resize: () => scheduleTextFit(element),
      observer: null,
    };
    fitTextHandlers.set(element, state);
    state.observer = new ResizeObserver(state.resize);
    state.observer.observe(element);
    window.addEventListener("resize", state.resize);
    scheduleTextFit(element);
    document.fonts?.ready.then(state.resize);
  },
  updated(element, binding) {
    const state = fitTextHandlers.get(element);
    const key = textFitKey(binding.value, element);
    if (!state || state.key === key) return;
    state.key = key;
    scheduleTextFit(element);
  },
  unmounted(element) {
    const state = fitTextHandlers.get(element);
    if (!state) return;
    cancelAnimationFrame(state.frame);
    state.observer.disconnect();
    window.removeEventListener("resize", state.resize);
    fitTextHandlers.delete(element);
  },
};

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    displayWrapper.value?.requestFullscreen();
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

let scoreboardClockFrame = null;
function startScoreboardClock() {
  if (scoreboardClockFrame != null) return;
  const tick = () => {
    scoreboardNow.value = Date.now();
    scoreboardClockFrame = requestAnimationFrame(tick);
  };
  scoreboardClockFrame = requestAnimationFrame(tick);
}

function stopScoreboardClock() {
  if (scoreboardClockFrame == null) return;
  cancelAnimationFrame(scoreboardClockFrame);
  scoreboardClockFrame = null;
}

onMounted(() => {
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  startScoreboardClock();
  if (selectedFile.value) {
    loadRecords();
  }
});

onUnmounted(() => {
  stopScoreboardClock();
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  document.body.classList.remove("scoreboard-fullscreen");
});

onActivated(() => {
  isActive.value = true;
  startScoreboardClock();
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  if (missedUpdate.value || lastLoadedFile.value !== selectedFile.value) {
    missedUpdate.value = false;
    loadRecords();
  }
});

onDeactivated(() => {
  isActive.value = false;
  stopScoreboardClock();
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
          <label class="control-field record-file-field">
            <span>기록 파일</span>
            <select v-model="selectedFile" class="form-select" aria-label="기록 파일">
              <option :value="null" disabled>파일 선택</option>
              <option v-for="file in recordFiles" :key="file" :value="file">
                {{ file }}
              </option>
            </select>
          </label>

          <label class="control-field">
            <span>트랙 온도 · °C</span>
            <input
              v-model="trackTemp"
              class="form-input temp-input"
              type="text"
              placeholder="미입력 시 숨김"
              aria-label="트랙 온도"
            />
          </label>

          <button class="btn btn-secondary fullscreen-button" @click="toggleFullscreen" title="전체화면" aria-label="전체화면">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
          <div class="accent-controls" role="group" aria-label="이벤트 표시명, 표시 여부 및 악센트 컬러">
            <div v-for="type in Object.keys(EVENT_CONFIG)" :key="type" class="event-control">
              <label class="visibility-control">
                <input
                  v-model="eventVisibility[type]"
                  type="checkbox"
                  :data-testid="`scoreboard-visible-${type}`"
                />
                <span>{{ type }}</span>
              </label>
              <textarea
                v-model="eventLabels[type]"
                class="form-input event-label-input"
                rows="2"
                :maxlength="MAX_EVENT_LABEL_LENGTH"
                :aria-label="`${type} 경기 표시명`"
                :data-testid="`scoreboard-label-${type}`"
                spellcheck="false"
              ></textarea>
              <label
                class="color-control"
                :style="{ '--picker-color': eventColors[type] }"
              >
                <input
                  v-model="eventColors[type]"
                  type="color"
                  :aria-label="`${type} 악센트 컬러`"
                  :data-testid="`scoreboard-color-${type}`"
                />
                <output :data-testid="`scoreboard-color-value-${type}`">
                  {{ eventColors[type].toUpperCase() }}
                </output>
              </label>
            </div>
          </div>

        </div>
      </div>

      <!-- Display Area 16:9 ratio -->
      <div ref="displayWrapper" class="display-wrapper">
        <div class="display-area">
          <div v-if="!selectedFile" class="empty-state"></div>
          <div v-else-if="records.length === 0 && !loading && availableTypes.length === 0" class="empty-state">
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
                <div class="event-heading">
                  <span v-fit-text class="event-name">{{ eventLabels[type] }}</span>
                </div>

                <section
                  class="record-cell current-record"
                  :class="{
                    empty: !currentByType[type],
                    measuring: currentByType[type]?.measuring,
                    'record-confirmed': currentRecordEffects[type],
                  }"
                  :data-measuring="currentByType[type]?.measuring ? 'true' : 'false'"
                  :data-testid="`current-record-${type}`"
                  @animationend="clearCurrentRecordEffect(type, $event)"
                >
                  <div class="record-head">
                    <span class="record-label">Current</span>
                    <span class="entry-number">No. {{ currentByType[type]?.num != null ? String(currentByType[type].num).padStart(2, "0") : "--" }}</span>
                  </div>
                  <div class="record-result">
                    <template v-if="currentByType[type]?.measuring">
                      <span :data-testid="`live-timer-${type}`">{{ currentByType[type].elapsedSeconds }}</span><span class="unit">s</span>
                    </template>
                    <template v-else-if="currentByType[type]">
                      {{ formatResult(currentByType[type].result, currentByType[type].status) }}<span v-if="!currentByType[type].status" class="unit">s</span>
                    </template>
                    <template v-else>--:--<span class="unit">s</span></template>
                  </div>
                  <div class="record-team record-team-name">
                    <span
                      v-fit-text="[currentByType[type]?.univ, currentByType[type]?.measuring]"
                      class="university-name"
                    >{{ currentByType[type]?.univ || "-" }}</span>
                    <span
                      v-fit-text="[currentByType[type]?.team, currentByType[type]?.measuring]"
                      class="team-name-text"
                    >{{ currentByType[type]?.team || "-" }}</span>
                  </div>
                </section>

                <section
                  class="record-cell best-record"
                  :class="{ empty: !bestRecords[type], 'best-updated': bestRecordEffects[type] }"
                  :data-testid="`best-record-${type}`"
                  @animationend="clearBestRecordEffect(type, $event)"
                >
                  <div class="record-head">
                    <span class="record-label">Best</span>
                    <span class="entry-number">No. {{ bestRecords[type] ? String(bestRecords[type].num).padStart(2, "0") : "--" }}</span>
                  </div>
                  <div class="record-result">
                    {{ bestRecords[type] ? formatResult(bestRecords[type].result) : "--:--" }}<span class="unit">s</span>
                  </div>
                  <div class="record-team record-team-name">
                    <span v-fit-text class="university-name">{{ bestRecords[type]?.univ || "-" }}</span>
                    <span v-fit-text class="team-name-text">{{ bestRecords[type]?.team || "-" }}</span>
                  </div>
                </section>
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

/* Competition display target: 16:9 landscape. */
.display-area {
  --scoreboard-bg: #000;
  --scoreboard-text: #fff;
  --scoreboard-muted: #666;
  --scoreboard-best: #ff4444;
  --scoreboard-live: #ef4444;
  --scoreboard-temp: #ff6b6b;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--scoreboard-bg);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
}

.display-wrapper:fullscreen {
  width: 100vw;
  height: 100vh;
  background: #16171c;
}

.display-wrapper:fullscreen .display-area {
  width: min(100vw, 177.7778vh);
  height: min(100vh, 56.25vw);
  max-width: none;
  border-radius: 0;
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
  --scoreboard-padding: 2cqw;
  --scoreboard-header-spacing: 1cqw;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: var(--scoreboard-padding);
  padding-top: var(--scoreboard-header-spacing);
  background: var(--scoreboard-bg);
  color: var(--scoreboard-text);
  overflow: hidden;
}

/* Header — override the app shell's globally dark .header surface. */
.scoreboard > .header {
  display: flex;
  align-items: center;
  gap: 1.6cqw;
  margin-bottom: var(--scoreboard-header-spacing);
  padding: 0;
  background: transparent;
  border: 0;
}

.title {
  font-size: 2.6cqw;
  font-weight: 700;
  color: var(--scoreboard-text);
  margin: 0;
}

.live {
  display: flex;
  align-items: center;
  gap: 0.416667cqw;
  font-size: 1.4cqw;
  font-weight: 600;
}

.live-dot {
  width: 0.833333cqw;
  height: 0.833333cqw;
  border-radius: 50%;
  background: var(--scoreboard-muted);
}

.live-dot.connected {
  background: var(--scoreboard-live);
}

.temp {
  font-size: 1.4cqw;
  margin-left: auto;
}

.temp-val {
  color: var(--scoreboard-temp);
  font-weight: 700;
}

/* Panels */
.panels {
  flex: 1;
  display: grid;
  gap: 1.52cqw;
  min-height: 0;
}

.panels.cols-1 { grid-template-rows: minmax(0, 1fr); }
.panels.cols-2 { grid-template-rows: repeat(2, minmax(0, 1fr)); }
.panels.cols-3 { grid-template-rows: repeat(3, minmax(0, 1fr)); }
.panels.cols-4 { grid-template-rows: repeat(4, minmax(0, 1fr)); }

.panel {
  --panel-fg: var(--panel-color);
  --event-font-size: 4.2cqw;
  display: grid;
  /* Three Korean glyphs plus letter spacing, padding, and the accent border. */
  grid-template-columns: calc(var(--event-font-size) + var(--event-font-size) + var(--event-font-size) + 3cqw) repeat(2, minmax(0, 1fr));
  min-width: 0;
  min-height: 0;
  background: color-mix(in srgb, var(--panel-color) 4%, var(--scoreboard-bg));
  border: 1px solid color-mix(in srgb, var(--panel-color) 35%, transparent);
  border-radius: 0.9cqw;
  overflow: hidden;
}

.event-heading {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 1cqw;
  background: color-mix(in srgb, var(--panel-color) 13%, var(--scoreboard-bg));
  border-left: 0.6cqw solid var(--panel-color);
}

.event-name {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  font-size: var(--event-font-size);
  line-height: 1.3;
  font-weight: 800;
  color: var(--panel-fg);
  letter-spacing: 0.025em;
  white-space: pre;
}

.record-cell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 0;
  min-width: 0;
  gap: 0.25cqw;
  padding: 0.56cqw 1.2cqw;
  padding-bottom: 1cqw;
  background: var(--scoreboard-bg);
}

.current-record.record-confirmed {
  --record-effect-color: var(--panel-color);
}

.best-record.best-updated {
  --record-effect-color: var(--scoreboard-best);
}

.current-record.record-confirmed,
.best-record.best-updated {
  animation: record-updated 1250ms cubic-bezier(0.2, 0.75, 0.25, 1);
}

.current-record.record-confirmed .record-result,
.best-record.best-updated .record-result {
  animation: record-result-updated 1250ms cubic-bezier(0.2, 0.75, 0.25, 1);
}

.best-record.best-updated .record-label,
.best-record.best-updated .entry-number {
  animation: best-meta-updated 1250ms cubic-bezier(0.2, 0.75, 0.25, 1);
}

@keyframes record-updated {
  0%, 100% { box-shadow: inset 0 0 0 0 transparent, inset 0 0 0 transparent; }
  18% {
    box-shadow:
      inset 0 0 0 0.32cqw color-mix(in srgb, var(--record-effect-color) 90%, white),
      inset 0 0 2.6cqw color-mix(in srgb, var(--record-effect-color) 58%, transparent);
  }
  36% { box-shadow: inset 0 0 0 0 transparent, inset 0 0 0 transparent; }
  54% {
    box-shadow:
      inset 0 0 0 0.32cqw color-mix(in srgb, var(--record-effect-color) 90%, white),
      inset 0 0 2.6cqw color-mix(in srgb, var(--record-effect-color) 58%, transparent);
  }
  72% { box-shadow: inset 0 0 0 0 transparent, inset 0 0 0 transparent; }
}

@keyframes record-result-updated {
  0%, 100% { transform: scale(1); text-shadow: none; }
  18% {
    transform: scale(1.075);
    text-shadow:
      0 0 0.12em color-mix(in srgb, var(--record-effect-color) 90%, white),
      0 0 0.42em color-mix(in srgb, var(--record-effect-color) 72%, transparent);
  }
  36% { transform: scale(1); text-shadow: none; }
  54% {
    transform: scale(1.075);
    text-shadow:
      0 0 0.12em color-mix(in srgb, var(--record-effect-color) 90%, white),
      0 0 0.42em color-mix(in srgb, var(--record-effect-color) 72%, transparent);
  }
  72% { transform: scale(1); text-shadow: none; }
}

@keyframes best-meta-updated {
  0%, 100% { filter: brightness(1); text-shadow: none; }
  18%, 54% { filter: brightness(1.75); text-shadow: 0 0 0.32em color-mix(in srgb, var(--scoreboard-best) 78%, transparent); }
  36%, 72% { filter: brightness(1); text-shadow: none; }
}

.record-cell + .record-cell {
  border-left: 1px solid color-mix(in srgb, var(--scoreboard-text) 18%, transparent);
}

.record-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.416667cqw;
  min-width: 0;
}

.record-label {
  font-size: 3.1cqw;
  line-height: 0.95;
  color: var(--panel-fg);
  font-weight: 900;
  letter-spacing: 0.055em;
  text-transform: uppercase;
}

.best-record .record-label {
  color: var(--scoreboard-best);
}

.record-result {
  align-self: center;
  text-align: center;
  font-size: 7cqw;
  line-height: 0.95;
  font-weight: 900;
  color: var(--panel-fg);
  font-style: italic;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.035em;
}

.best-record .record-result {
  color: var(--scoreboard-best);
}

.entry-number {
  flex: 0 0 auto;
  padding: 0;
  background: transparent;
  color: var(--panel-fg);
  font-size: 3.1cqw;
  line-height: 1;
  font-weight: 900;
  font-style: italic;
  white-space: nowrap;
}

.best-record .entry-number {
  background: transparent;
  color: var(--scoreboard-best);
}

.record-team {
  min-width: 0;
  color: var(--scoreboard-text);
  /* The 0.9em name text is 58px on a 1920px-wide display. */
  font-size: 3.356481cqw;
  line-height: 1;
  font-weight: 850;
  display: flex;
  flex-direction: column;
  gap: 0.4cqw;
}

.university-name,
.team-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.university-name {
  width: 100%;
  text-align: center;
  font-size: 0.9em;
  font-weight: 900;
}

.team-name-text {
  width: 100%;
  text-align: center;
  font-size: 0.9em;
  font-weight: 750;
}

.record-cell.empty .entry-number,
.record-cell.empty .record-team {
  opacity: 0.45;
}

.unit {
  font-size: 0.4em;
  margin-left: 0.1em;
}

@media (prefers-reduced-motion: reduce) {
  .current-record.record-confirmed,
  .current-record.record-confirmed .record-result,
  .best-record.best-updated,
  .best-record.best-updated .record-result,
  .best-record.best-updated .record-label,
  .best-record.best-updated .entry-number {
    animation-duration: 1ms;
  }
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
  align-items: flex-end;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.control-field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.record-file-field {
  flex: 1 1 16rem;
}

.record-file-field .form-select {
  width: 100%;
  min-width: 0;
}

.btn.fullscreen-button {
  justify-content: center;
  width: 40px;
  padding: 0;
  flex: 0 0 40px;
  min-height: 38px;
}

.accent-controls,
.event-control,
.visibility-control,
.color-control {
  display: flex;
  align-items: center;
}

.accent-controls {
  order: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
  gap: 0.75rem;
  margin-top: 0.25rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border-color);
}

.event-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.75rem;
  padding: 0.875rem;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  min-width: 0;
}

.event-control .color-control {
  grid-column: 2;
  grid-row: 1;
}

.visibility-control {
  gap: 0.35rem;
}

.form-input.event-label-input {
  grid-column: 1 / -1;
  width: 100%;
  min-height: 4.25rem;
  padding: 0.5rem 0.625rem;
  line-height: 1.5;
  resize: vertical;
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
  width: 140px;
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
    grid-template-columns: minmax(0, 1fr);
  }

  .controls {
    padding: 1rem;
  }

  .record-file-field {
    flex-basis: 100%;
  }
}
</style>
