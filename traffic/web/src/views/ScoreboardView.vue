<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useSSE } from "../composables/useSSE";
import { fetchRecord } from "../composables/useApi";

const { recordFiles: allRecordFiles, selectedFile, lastUpdate, connected } = useSSE();

// Filter out controller from record files for scoreboard
const recordFiles = computed(() => {
  return allRecordFiles.value.filter((file) => file !== "controller");
});

const records = ref([]);
const loading = ref(false);
const isFullscreen = ref(false);
const newRecordKeys = ref(new Set());

const EVENT_TYPES = ["가속", "짐카나", "스키드패드"];

// Generate unique key for a record
function getRecordKey(record) {
  return `${record.num}-${record.type}-${record.time}-${record.result}`;
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
      const newKeys = data.filter((r) => !oldKeys.has(getRecordKey(r))).map(getRecordKey);

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
  return best.num === record.num && best.result === record.result && best.time === record.time;
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
  // Emit event to parent to hide header
  if (isFullscreen.value) {
    document.body.classList.add("scoreboard-fullscreen");
  } else {
    document.body.classList.remove("scoreboard-fullscreen");
  }
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
  document.body.classList.remove("scoreboard-fullscreen");
});
</script>

<template>
  <div class="scoreboard-page">
    <div class="scoreboard-container">
      <!-- Controls (above display area, hidden in fullscreen) -->
      <div v-show="!isFullscreen" class="controls">
        <div class="control-group">
          <select v-model="selectedFile" class="form-select">
            <option :value="null" disabled>파일 선택</option>
            <option v-for="file in recordFiles" :key="file" :value="file">
              {{ file }}
            </option>
          </select>

          <button class="btn btn-secondary" @click="toggleFullscreen" title="전체화면">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Display Area (3:2 ratio) -->
      <div class="display-wrapper">
        <div ref="displayArea" class="display-area">
          <!-- No file selected -->
          <div v-if="!selectedFile" class="empty-state"></div>

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
                  <div class="best-type">{{ type }} 최고 기록</div>
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
                    <tr
                      v-for="record in recentRecords"
                      :key="getRecordKey(record)"
                      :class="{
                        dnf: record.result < 0,
                        'best-row': isBestRecord(record),
                        'new-record': isNewRecord(record),
                      }"
                    >
                      <td>{{ formatKoreanTime(record.time) }}</td>
                      <td class="mono col-entry">{{ record.num }}</td>
                      <td>{{ record.univ }} {{ record.team }}</td>
                      <td class="col-type">{{ record.type }}</td>
                      <td class="mono record-result col-result">{{ formatResult(record.result) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
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
  max-width: 1200px;
  display: flex;
  flex-direction: column;
  gap: 3rem;
}

/* Display Area */
.display-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
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

/* Empty State */
.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: var(--font-size-record, 1.5rem);
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

:global(.scoreboard-fullscreen) .scoreboard {
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

:global(.scoreboard-fullscreen) .best-card {
  padding: 1.5rem 2rem;
}

.best-type {
  font-size: var(--font-size-record, 1.5rem);
  font-weight: 600;
  opacity: 0.9;
  margin-bottom: auto;
}

.best-info {
  margin-top: 1rem;
  margin-bottom: 1rem;
  min-height: calc(var(--font-size-record, 1.5rem) * 3);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.best-univ,
.best-team {
  font-size: var(--font-size-record, 1.5rem);
  font-weight: 500;
  opacity: 0.95;
  line-height: 1.4;
}

.best-time {
  font-size: calc(var(--font-size-best, 3rem) * 0.85);
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
  font-size: var(--font-size-table, 1.25rem);
  font-weight: 600;
}

.recent-table td {
  padding: 0.75rem 1rem;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

:global(.scoreboard-fullscreen) .recent-table td {
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

.col-entry,
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

.connection-status {
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
  background: rgba(239, 68, 68, 0.1);
  color: var(--accent-danger);
}

.connection-status.connected {
  background: rgba(16, 185, 129, 0.1);
  color: var(--accent-success);
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

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  border: none;
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.btn-secondary:hover {
  background: var(--bg-hover);
}

/* Responsive */
@media (max-width: 1024px) {
  .best-grid.cols-3 {
    grid-template-columns: 1fr;
  }

  .best-grid.cols-2 {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .scoreboard {
    padding: 1rem;
  }

  .controls {
    padding: 1rem;
  }

  .control-group {
    flex-direction: column;
    align-items: stretch;
  }

  .form-select {
    width: 100%;
  }
}
</style>
