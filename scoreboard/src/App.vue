<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useSSE } from "./composables/useSSE";
import { fetchRecord } from "./composables/useApi";
import ThemeToggle from "./components/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";

const { recordFiles, selectedFile, lastUpdate, connected } = useSSE();

const records = ref([]);
const loading = ref(false);
const isFullscreen = ref(false);
const newRecordKeys = ref(new Set());

const EVENT_TYPES = ["가속", "짐카나", "스키드패드"];

// Generate unique key for a record
function getRecordKey(record) {
  return `${record.entry}-${record.type}-${record.time}-${record.result}`;
}

// Fetch records when file changes
async function loadRecords(isUpdate = false) {
  if (!selectedFile.value) {
    records.value = [];
    return;
  }

  loading.value = true;
  try {
    const data = await fetchRecord(selectedFile.value);

    // Detect new records on SSE update
    if (isUpdate && records.value.length > 0) {
      const oldKeys = new Set(records.value.map(getRecordKey));
      const newKeys = data
        .filter(r => !oldKeys.has(getRecordKey(r)))
        .map(getRecordKey);

      if (newKeys.length > 0) {
        newRecordKeys.value = new Set(newKeys);
        // Clear flash after animation
        setTimeout(() => {
          newRecordKeys.value = new Set();
        }, 1500);
      }
    }

    records.value = data;
  } catch (err) {
    console.error("기록 조회 실패:", err);
  } finally {
    loading.value = false;
  }
}

// Check if record is newly added
function isNewRecord(record) {
  return newRecordKeys.value.has(getRecordKey(record));
}

// Watch for file selection changes
watch(selectedFile, () => loadRecords(false));

// Watch for SSE updates
watch(lastUpdate, (update) => {
  if (update && update.name === selectedFile.value) {
    loadRecords(true);
  }
});

// 유효한 기록만 필터링 (무효화되지 않은 기록)
const validRecords = computed(() => {
  return records.value.filter((r) => !r.invalidated);
});

// Get available event types from current valid records
const availableTypes = computed(() => {
  const types = new Set(validRecords.value.map((r) => r.type));
  return EVENT_TYPES.filter((t) => types.has(t));
});

// Best records by event type (result > 0, minimum value, not invalidated)
const bestRecords = computed(() => {
  const best = {};
  availableTypes.value.forEach((type) => {
    const valid = validRecords.value.filter((r) => r.type === type && r.result > 0);
    if (valid.length) {
      best[type] = valid.reduce((a, b) => (a.result < b.result ? a : b));
    }
  });
  return best;
});

// Recent records sorted by time (newest first, not invalidated)
const recentRecords = computed(() => {
  return [...validRecords.value].sort((a, b) => new Date(b.time) - new Date(a.time));
});

// Format time as "오후 2시 30분"
function formatKoreanTime(dateString) {
  const date = new Date(dateString);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours < 12 ? "오전" : "오후";
  const hour12 = hours % 12 || 12;
  return `${period} ${hour12}시 ${minutes}분`;
}

// Check if a record is a best record
function isBestRecord(record) {
  const best = bestRecords.value[record.type];
  if (!best) return false;
  return best.entry === record.entry &&
         best.result === record.result &&
         best.time === record.time;
}

// Format result time as MM:SS.mmm or SS.mmm
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

// Fullscreen API
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
}

onMounted(() => {
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  // Initial load if file already selected
  if (selectedFile.value) {
    loadRecords();
  }
});

onUnmounted(() => {
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
});
</script>

<template>
  <div class="app-container">
    <!-- Header -->
    <header class="header" v-show="!isFullscreen">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📺</span>
          <h1>FSK 전광판</h1>
        </a>
        <div class="header-actions">
          <span class="connection-status" :class="{ connected }">
            {{ connected ? "연결됨" : "연결 끊김" }}
          </span>

          <select v-model="selectedFile" class="form-select">
            <option :value="null" disabled>파일 선택</option>
            <option v-for="file in recordFiles" :key="file" :value="file">
              {{ file }}
            </option>
          </select>

          <button class="btn-icon" @click="toggleFullscreen" title="전체화면">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>

          <ThemeToggle />
          <NavMenu currentPath="/scoreboard" />
        </div>
      </div>
    </header>

    <!-- Display Area (3:2 ratio) -->
    <main class="display-wrapper" :class="{ fullscreen: isFullscreen }">
      <div ref="displayArea" class="display-area">
        <!-- No file selected -->
        <div v-if="!selectedFile" class="empty-state">
          <p></p>
        </div>

        <!-- No records -->
        <div v-else-if="records.length === 0 && !loading" class="empty-state">
          <p>기록이 없습니다</p>
        </div>

        <!-- Scoreboard content -->
        <div v-else class="scoreboard">
          <!-- Best Records Section -->
          <section class="best-section" v-if="availableTypes.length > 0">
            <div class="best-grid" :class="`cols-${availableTypes.length}`">
              <div v-for="type in availableTypes" :key="type" class="best-card">
                <div class="best-type">{{ type }}</div>
                <template v-if="bestRecords[type]">
                  <div class="best-info">
                    <div class="best-univ">{{ bestRecords[type].univ }}</div>
                    <div class="best-team">{{ bestRecords[type].team }}</div>
                  </div>
                  <div class="best-time mono">{{ formatResult(bestRecords[type].result) }}</div>
                </template>
                <template v-else>
                  <div class="best-info">
                    <div class="best-univ">-</div>
                    <div class="best-team">-</div>
                  </div>
                  <div class="best-time mono">--:--.---</div>
                </template>
              </div>
            </div>
          </section>

          <!-- Recent Records Section -->
          <section class="recent-section">
            <div class="recent-table-wrapper">
              <table class="recent-table">
                <tbody>
                  <tr v-for="record in recentRecords" :key="getRecordKey(record)" :class="{ dnf: record.result < 0, 'best-row': isBestRecord(record), 'new-record': isNewRecord(record) }">
                    <td>{{ formatKoreanTime(record.time) }}</td>
                    <td class="mono">{{ record.entry }}</td>
                    <td>{{ record.univ }} {{ record.team }}</td>
                    <td class="col-type">{{ record.type }}</td>
                    <td class="mono record-result col-result">{{ formatResult(record.result) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <!-- Exit fullscreen hint -->
        <div v-if="isFullscreen" class="fullscreen-hint">
          ESC를 눌러 전체화면 종료
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.app-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

/* Header */
.header {
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  padding: 1rem 2rem;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  flex-shrink: 0;
}

.header-content {
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 2rem;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-shrink: 0;
  text-decoration: none;
}

.logo-icon {
  font-size: 2rem;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
}

.logo h1 {
  color: white;
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
}

.header-actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-shrink: 0;
}

.connection-status {
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.2);
  color: white;
}

.connection-status.connected {
  background: var(--accent-success);
}

.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
  color: white;
}

.btn-icon:hover {
  background: rgba(255, 255, 255, 0.25);
  transform: scale(1.05);
}

.form-select {
  min-width: 200px;
}

/* Display Area */
.display-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.display-wrapper.fullscreen {
  padding: 0;
}

.display-area {
  width: 100%;
  max-width: 1200px;
  aspect-ratio: 3 / 2;
  background: var(--bg-card);
  border-radius: 16px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

.fullscreen .display-area {
  max-width: none;
  aspect-ratio: auto;
  height: 100vh;
  width: 100vw;
  border-radius: 0;
}

/* Empty State */
.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: var(--font-size-record);
}

/* Scoreboard */
.scoreboard {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 1.5rem;
  gap: 2rem;
  overflow: hidden;
}

.fullscreen .scoreboard {
  padding: 2rem;
  gap: 2.5rem;
}

/* Best Records */
.best-section {
  flex-shrink: 0;
}

.best-grid {
  display: grid;
  gap: 1rem;
  justify-content: center;
}

.best-grid.cols-1 {
  grid-template-columns: minmax(300px, 50%);
}

.best-grid.cols-2 {
  grid-template-columns: repeat(2, minmax(280px, 1fr));
}

.best-grid.cols-3 {
  grid-template-columns: repeat(3, 1fr);
}

.best-card {
  background: #2563eb;
  border-radius: 12px;
  padding: 1rem 1.5rem;
  text-align: center;
  color: white;
  display: flex;
  flex-direction: column;
}

.fullscreen .best-card {
  padding: 1.5rem 2rem;
}

.best-type {
  font-size: var(--font-size-record);
  font-weight: 600;
  opacity: 0.9;
  margin-bottom: auto;
}

.best-info {
  margin-top: 1rem;
  margin-bottom: 1rem;
  min-height: calc(var(--font-size-record) * 3);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.best-univ,
.best-team {
  font-size: var(--font-size-record);
  font-weight: 500;
  opacity: 0.95;
  line-height: 1.4;
}

.best-time {
  font-size: calc(var(--font-size-best) * 0.85);
  font-weight: 700;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  margin-top: auto;
}

/* Recent Records */
.recent-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.recent-table-wrapper {
  flex: 1;
  overflow-y: auto;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.recent-table-wrapper::-webkit-scrollbar {
  display: none;
}

.recent-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-table);
  font-weight: 600;
}

.recent-table td {
  padding: 0.75rem 1rem;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

.fullscreen .recent-table td {
  padding: 1rem 1.5rem;
}

.recent-table tbody tr {
  transition: background-color 0.2s ease;
}

.recent-table tbody tr:hover {
  background: var(--bg-hover);
}

.recent-table tbody tr.dnf {
  color: var(--accent-danger);
}

.recent-table tbody tr.best-row {
  color: #2563eb;
  font-weight: 700;
}

[data-theme="dark"] .recent-table tbody tr.best-row {
  color: #60a5fa;
}

.recent-table tbody tr.new-record {
  animation: flash 2s ease-out;
}

@keyframes flash {
  0% {
    background-color: rgba(37, 99, 235, 0.4);
  }
  100% {
    background-color: transparent;
  }
}

[data-theme="dark"] .recent-table tbody tr.new-record {
  animation: flash-dark 2s ease-out;
}

@keyframes flash-dark {
  0% {
    background-color: rgba(96, 165, 250, 0.4);
  }
  100% {
    background-color: transparent;
  }
}

.col-type,
.col-result {
  text-align: center !important;
}

/* Fullscreen hint */
.fullscreen-hint {
  position: absolute;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.5rem 1rem;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  border-radius: 8px;
  font-size: 0.875rem;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.display-area:hover .fullscreen-hint {
  opacity: 1;
}

/* Responsive */
@media (max-width: 1024px) {
  .header-content {
    flex-wrap: wrap;
  }
}

@media (max-width: 768px) {
  .header {
    padding: 1rem;
  }

  .header-content {
    flex-direction: column;
    gap: 1rem;
  }

  .logo h1 {
    font-size: 1.25rem;
  }

  .display-wrapper {
    padding: 1rem;
  }

  .scoreboard {
    padding: 1rem;
  }

  .best-grid.cols-3 {
    grid-template-columns: 1fr;
  }

  .best-grid.cols-2 {
    grid-template-columns: 1fr;
  }
}
</style>
