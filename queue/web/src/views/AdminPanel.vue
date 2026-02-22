<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { useRouter } from "vue-router";
import {
  fetchEntries,
  fetchAllInspections,
  fetchInspectionQueue,
  toggleInspectionActive,
  cancelFromQueue,
  enterBooth,
  exitBooth,
  updateBoothConfig,
  toggleBooth,
  resetInspectionHistory,
  fetchSmsSettings,
  setSmsSettings,
  fetchSmsRankSettings,
  setSmsRankSettings,
  fetchCancelPenaltySettings,
  setCancelPenaltySettings,
} from "../api";
import { useSSE } from "../composables/useSSE";
import { useNotification } from "../composables/useNotification";

const { success, error, warning } = useNotification();
const router = useRouter();

const { activeInspections, lastQueueUpdate, allBooths, lastBoothUpdate } = useSSE();

const entries = ref({});
const inspections = ref([]);
const currentQueue = ref([]);
const currentTab = ref("");
const smsEnabled = ref(false);
const smsRank = ref(3);
const cancelPenalty = ref(10);
const loading = ref(true);
const boothSelectedTeam = ref({});
const elapsedTimes = ref({});
let elapsedTimers = {};

const activeInspectionTypes = computed(() => activeInspections.value.map((i) => i.type));

const currentBooths = computed(() => {
  if (!currentTab.value || !allBooths.value[currentTab.value]) return [];
  return allBooths.value[currentTab.value];
});

// Watch for queue updates from SSE
watch(lastQueueUpdate, async (update) => {
  if (update && (update.type === currentTab.value || !currentTab.value)) {
    await refreshQueue(currentTab.value || update.type);
  }
});

// Watch for booth updates from SSE
watch(lastBoothUpdate, (update) => {
  if (update && update.type === currentTab.value) {
    syncElapsedTimers();
  }
});

// Re-sync timers when tab changes
watch(currentTab, () => {
  syncElapsedTimers();
});

// Watch for active inspections changes
watch(
  activeInspections,
  async (newVal) => {
    if (newVal.length > 0 && !currentTab.value) {
      const savedTab = localStorage.getItem("admin_tab");
      if (savedTab && activeInspectionTypes.value.includes(savedTab)) {
        currentTab.value = savedTab;
      } else {
        currentTab.value = newVal[0].type;
        localStorage.setItem("admin_tab", currentTab.value);
      }
      await refreshQueue(currentTab.value);
    }
  },
  { immediate: true },
);

onMounted(async () => {
  try {
    entries.value = await fetchEntries();
    inspections.value = await fetchAllInspections();
    const sms = await fetchSmsSettings();
    smsEnabled.value = sms.value;
    const smsRankData = await fetchSmsRankSettings();
    smsRank.value = smsRankData.value;
    const penaltyData = await fetchCancelPenaltySettings();
    cancelPenalty.value = penaltyData.value;

    // Restore saved tab
    const savedTab = localStorage.getItem("admin_tab");
    if (savedTab && activeInspectionTypes.value.includes(savedTab)) {
      currentTab.value = savedTab;
      await refreshQueue(savedTab);
    } else if (activeInspections.value.length > 0) {
      currentTab.value = activeInspections.value[0].type;
      localStorage.setItem("admin_tab", currentTab.value);
      await refreshQueue(currentTab.value);
    }
  } catch (e) {
    error("초기 데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
});

async function refreshQueue(type) {
  if (!type) return;
  try {
    currentQueue.value = await fetchInspectionQueue(type);
  } catch (e) {
    error("대기열을 가져올 수 없습니다.");
  }
}

function selectTab(type) {
  currentTab.value = type;
  localStorage.setItem("admin_tab", type);
  refreshQueue(type);
}

async function toggleActive(type, e) {
  try {
    await toggleInspectionActive(type, e.target.checked);
    // SSE will handle the update
  } catch (e) {
    error("활성화 상태를 변경할 수 없습니다.");
  }
}

async function enterBoothAction(boothNum) {
  const num = boothSelectedTeam.value[boothNum];
  if (!num) return;
  try {
    await enterBooth(currentTab.value, boothNum, num);
    success(`엔트리 ${num}번 부스 ${boothNum} 입장`);
    boothSelectedTeam.value[boothNum] = null;
    await refreshQueue(currentTab.value);
  } catch (e) {
    error(e.message);
  }
}

async function exitBoothAction(boothNum) {
  const booth = currentBooths.value.find((b) => b.booth_num === boothNum);
  if (!booth || !booth.occupied_by) return;
  try {
    await exitBooth(currentTab.value, boothNum);
    success(`엔트리 ${booth.occupied_by}번 부스 ${boothNum} 퇴장`);
    await refreshQueue(currentTab.value);
  } catch (e) {
    error(e.message);
  }
}

function syncElapsedTimers() {
  // Clear all existing timers
  Object.values(elapsedTimers).forEach(clearInterval);
  elapsedTimers = {};
  elapsedTimes.value = {};

  const booths = currentBooths.value;
  for (const booth of booths) {
    if (booth.occupied_by && booth.entered_at) {
      const key = `${currentTab.value}-${booth.booth_num}`;
      elapsedTimes.value[key] = formatElapsed(booth.entered_at);
      elapsedTimers[key] = setInterval(() => {
        elapsedTimes.value[key] = formatElapsed(booth.entered_at);
      }, 1000);
    }
  }
}

function formatElapsed(enteredAt) {
  const diff = Math.max(0, Math.floor((Date.now() - enteredAt) / 1000));
  const min = Math.floor(diff / 60).toString().padStart(2, "0");
  const sec = (diff % 60).toString().padStart(2, "0");
  return `${min}:${sec}`;
}

function clearAllTimers() {
  Object.values(elapsedTimers).forEach(clearInterval);
  elapsedTimers = {};
}

async function cancelEntry(num) {
  if (!confirm(`엔트리 ${num}번을 취소하시겠습니까?\n${cancelPenalty.value}분간 페널티가 적용됩니다.`)) return;

  try {
    await cancelFromQueue(currentTab.value, num);
    warning(`엔트리 ${num}번 취소 (${cancelPenalty.value}분 페널티)`);
    await refreshQueue(currentTab.value);
  } catch (e) {
    error(e.message);
  }
}

async function toggleSms() {
  try {
    await setSmsSettings(!smsEnabled.value);
    const sms = await fetchSmsSettings();
    smsEnabled.value = sms.value;
    success("SMS 설정을 변경했습니다.");
  } catch (e) {
    error(e.message);
  }
}

async function updateSmsRank(e) {
  const value = parseInt(e.target.value, 10);
  if (isNaN(value) || value < 1 || value > 10) return;

  try {
    await setSmsRankSettings(value);
    smsRank.value = value;
    success(`SMS 알림 순번을 ${value}번으로 변경했습니다.`);
  } catch (e) {
    error(e.message);
  }
}

async function updateCancelPenalty(e) {
  const value = parseInt(e.target.value, 10);
  if (isNaN(value) || value < 0 || value > 60) return;

  try {
    await setCancelPenaltySettings(value);
    cancelPenalty.value = value;
    success(`취소 페널티를 ${value}분으로 변경했습니다.`);
  } catch (e) {
    error(e.message);
  }
}

async function resetHistory(type, name) {
  if (!confirm(`${name} 검차의 초검/재검 이력을 초기화하시겠습니까?\n모든 팀이 초검으로 간주됩니다.`)) return;

  try {
    await resetInspectionHistory(type);
    success(`${name} 검차 이력을 초기화했습니다.`);
    // SSE will handle queue update
  } catch (e) {
    error(e.message);
  }
}

async function updateBoothCount(type, ev) {
  const value = parseInt(ev.target.value, 10);
  if (isNaN(value) || value < 1) return;
  try {
    await updateBoothConfig(type, value);
    success(`부스 수를 ${value}개로 변경했습니다.`);
  } catch (err) {
    error(err.message);
    // Revert input to current booth count
    const booths = allBooths.value[type];
    if (booths) ev.target.value = booths.length;
  }
}

async function toggleBoothActive(type, boothNum, ev) {
  const active = ev.target.checked;
  try {
    await toggleBooth(type, boothNum, active);
    success(`부스 ${boothNum} ${active ? "활성화" : "비활성화"}`);
  } catch (err) {
    error(err.message);
    // Revert toggle
    ev.target.checked = !active;
  }
}

function formatPhone(phone) {
  return phone.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;
}

onUnmounted(() => {
  clearAllTimers();
});

function goToRegister() {
  router.push("/register");
}

function goToPriority() {
  router.push("/priority");
}
</script>

<template>
  <div class="admin-panel">
    <!-- Top Actions -->
    <div class="top-actions">
      <button class="btn btn-primary" @click="goToRegister">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="M12 5v14M5 12h14" />
        </svg>
        검차 등록
      </button>
      <button class="btn btn-ghost" @click="goToPriority">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <polygon
            points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
          />
        </svg>
        우선순위 관리
      </button>
    </div>

    <div class="admin-grid">
      <!-- Queue Panel -->
      <div class="card queue-panel">
        <div class="card-header">
          <div class="header-left">
            <h3>📋 검차 대기열</h3>
            <span class="queue-count">{{ currentQueue.length }}팀 대기중</span>
          </div>
        </div>

        <!-- Tabs -->
        <div class="tabs-container">
          <div class="tabs">
            <button
              v-for="item in activeInspections"
              :key="item.type"
              class="tab"
              :class="{ active: currentTab === item.type }"
              @click="selectTab(item.type)"
            >
              {{ item.name }}
            </button>
          </div>
        </div>

        <div class="card-body">
          <div v-if="loading" class="loading">
            <div class="loading-spinner"></div>
          </div>
          <template v-else>
            <!-- Booth Status Section -->
            <div v-if="currentBooths.length > 0" class="booth-section">
              <div class="booth-section-header">
                <span class="booth-section-title">부스 현황</span>
              </div>
              <div class="booth-cards">
                <div
                  v-for="booth in currentBooths"
                  :key="booth.booth_num"
                  class="booth-card"
                  :class="{ 'booth-inactive': !booth.active, 'booth-occupied': booth.occupied_by }"
                >
                  <div class="booth-card-header">
                    <span class="booth-num">부스 {{ booth.booth_num }}</span>
                    <span v-if="!booth.active" class="badge badge-muted">비활성</span>
                    <span v-else-if="booth.occupied_by" class="badge badge-warning">사용중</span>
                    <span v-else class="badge badge-success">비어있음</span>
                  </div>
                  <div v-if="booth.active && booth.occupied_by" class="booth-card-body">
                    <div class="booth-team-info">
                      <span class="booth-team-num">{{ booth.occupied_by }}</span>
                      <span class="booth-team-name">{{ entries[booth.occupied_by]?.univ }} {{ entries[booth.occupied_by]?.team }}</span>
                    </div>
                    <div class="booth-elapsed">{{ elapsedTimes[`${currentTab}-${booth.booth_num}`] || '00:00' }}</div>
                    <button class="btn btn-danger btn-sm booth-action-btn" @click="exitBoothAction(booth.booth_num)">
                      퇴장
                    </button>
                  </div>
                  <div v-else-if="booth.active" class="booth-card-body">
                    <select
                      class="booth-select"
                      v-model="boothSelectedTeam[booth.booth_num]"
                    >
                      <option :value="null" disabled>팀 선택</option>
                      <option v-for="item in currentQueue" :key="item.num" :value="item.num">
                        {{ item.num }} - {{ entries[item.num]?.univ }} {{ entries[item.num]?.team }}
                      </option>
                    </select>
                    <button
                      class="btn btn-success btn-sm booth-action-btn"
                      :disabled="!boothSelectedTeam[booth.booth_num]"
                      @click="enterBoothAction(booth.booth_num)"
                    >
                      입장
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Queue Section -->
            <div class="queue-section-header">
              <span class="booth-section-title">대기열</span>
            </div>
            <div v-if="currentQueue.length > 0" class="queue-list">
              <div v-for="(item, index) in currentQueue" :key="item.num" class="queue-item">
                <div class="queue-item-header">
                  <div class="queue-item-left">
                    <span class="entry-num">{{ item.num }}</span>
                    <span class="entry-detail">{{ entries[item.num]?.univ }} {{ entries[item.num]?.team }}</span>
                  </div>
                  <div class="queue-item-badges">
                    <span v-if="item.is_reinspection" class="badge badge-warning">재검</span>
                    <span v-else class="badge badge-success">초검</span>
                    <span v-if="item.priority < 999" class="badge badge-primary">{{ item.priority }}순위</span>
                  </div>
                </div>
                <div class="queue-item-footer">
                  <div class="queue-item-meta">
                    <a :href="`tel:${item.phone}`" class="entry-phone">{{ formatPhone(item.phone) }}</a>
                    <span class="entry-time">{{ formatTime(item.timestamp) }}</span>
                  </div>
                  <div class="action-buttons">
                    <button class="btn btn-danger btn-icon btn-sm" @click="cancelEntry(item.num)" title="취소">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="empty-state">대기중인 엔트리가 없습니다.</div>
          </template>
        </div>
      </div>

      <!-- Settings Panel -->
      <div class="card settings-panel">
        <div class="card-header">
          <h3>⚙️ 설정</h3>
        </div>
        <div class="card-body">
          <!-- SMS Setting -->
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-label">SMS 알림 활성화</span>
            </div>
            <label class="toggle">
              <input type="checkbox" :checked="smsEnabled" @change="toggleSms" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- SMS Rank Setting -->
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-label">SMS 알림 순번</span>
            </div>
            <div class="setting-input">
              <input type="number" :value="smsRank" min="1" max="10" @change="updateSmsRank" />
              <span>번</span>
            </div>
          </div>

          <!-- Cancel Penalty Setting -->
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-label">취소 페널티</span>
            </div>
            <div class="setting-input">
              <input type="number" :value="cancelPenalty" min="0" max="60" @change="updateCancelPenalty" />
              <span>분</span>
            </div>
          </div>

          <hr class="divider" />

          <!-- Active Inspections -->
          <div class="setting-section">
            <div v-for="item in inspections" :key="item.type" class="inspection-setting-group">
              <div class="setting-item inspection-setting">
                <div class="setting-info">
                  <span class="setting-label">{{ item.name }}</span>
                </div>
                <div class="setting-actions">
                  <label class="toggle">
                    <input type="checkbox" :checked="item.active" @change="toggleActive(item.type, $event)" />
                    <span class="toggle-slider"></span>
                  </label>
                  <div class="setting-input">
                    <input
                      type="number"
                      :value="allBooths[item.type]?.length || 1"
                      min="1"
                      @change="updateBoothCount(item.type, $event)"
                    />
                    <span>부스</span>
                  </div>
                  <button
                    class="btn btn-ghost btn-sm"
                    @click="resetHistory(item.type, item.name)"
                    title="초검/재검 이력 초기화"
                  >
                    초기화
                  </button>
                </div>
              </div>
              <div v-if="allBooths[item.type]?.length > 0" class="booth-toggle-list">
                <div
                  v-for="booth in allBooths[item.type]"
                  :key="booth.booth_num"
                  class="booth-toggle-item"
                >
                  <span class="booth-toggle-label">부스 {{ booth.booth_num }}</span>
                  <label class="toggle toggle-sm">
                    <input
                      type="checkbox"
                      :checked="booth.active"
                      @change="toggleBoothActive(item.type, booth.booth_num, $event)"
                    />
                    <span class="toggle-slider"></span>
                  </label>
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
.admin-panel {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.top-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.admin-grid {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 1.5rem;
}

.queue-panel .card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.queue-count {
  background: var(--accent-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 12px;
  font-family: "JetBrains Mono", monospace;
}

.tabs-container {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
}

/* Queue List */
.queue-list {
  display: flex;
  flex-direction: column;
}

.queue-item {
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--border-color);
}

.queue-item:last-child {
  border-bottom: none;
}

.queue-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.queue-item-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.queue-item-badges {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}

.queue-item-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
}

.queue-item-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.entry-num {
  font-weight: 700;
  font-size: 1.125rem;
  font-family: "JetBrains Mono", monospace;
  flex-shrink: 0;
}

.entry-detail {
  font-size: 0.875rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.entry-phone {
  font-size: 0.8125rem;
  color: var(--text-tertiary);
  font-family: "JetBrains Mono", monospace;
  text-decoration: none;
}

.entry-phone:hover {
  color: var(--accent-primary);
  text-decoration: underline;
}

.entry-time {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  font-family: "JetBrains Mono", monospace;
}

.loading {
  display: flex;
  justify-content: center;
  padding: 2rem;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.empty-state {
  text-align: center;
  color: var(--text-tertiary);
  padding: 3rem;
}

/* Settings Panel */
.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.setting-label {
  font-weight: 500;
  font-size: 0.875rem;
}

.setting-desc {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.divider {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 0.5rem 0;
}

.setting-section {
  margin-top: 0.5rem;
}

.setting-section-title {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.5rem;
}

.action-buttons {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}

.setting-input {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.setting-input input {
  width: 60px;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  text-align: center;
  font-size: 0.875rem;
  font-family: "JetBrains Mono", monospace;
  background: var(--bg-input);
  color: var(--text-primary);
}

.setting-input input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.setting-input input::-webkit-outer-spin-button,
.setting-input input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.setting-input span {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.inspection-setting {
  flex-wrap: wrap;
  gap: 0.5rem;
}

.setting-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

/* Booth Settings */
.inspection-setting-group {
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 0.5rem;
  margin-bottom: 0.5rem;
}

.inspection-setting-group:last-child {
  border-bottom: none;
  padding-bottom: 0;
  margin-bottom: 0;
}

.booth-toggle-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem 0.75rem;
  padding: 0.375rem 0 0.25rem 0.5rem;
}

.booth-toggle-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.booth-toggle-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.toggle-sm .toggle-slider {
  width: 32px;
  height: 18px;
}

.toggle-sm .toggle-slider::before {
  width: 14px;
  height: 14px;
}

.toggle-sm input:checked + .toggle-slider::before {
  transform: translateX(14px);
}

/* Booth Section */
.booth-section {
  border-bottom: 1px solid var(--border-color);
}

.booth-section-header,
.queue-section-header {
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.booth-section-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.booth-cards {
  display: flex;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
  overflow-x: auto;
}

.booth-card {
  flex: 1;
  min-width: 160px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.75rem;
  background: var(--bg-primary);
}

.booth-card.booth-inactive {
  background: var(--bg-tertiary, var(--bg-secondary));
  opacity: 0.6;
}

.booth-card.booth-occupied {
  border-color: var(--accent-warning, #f59e0b);
}

.booth-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.booth-num {
  font-weight: 600;
  font-size: 0.875rem;
}

.badge-muted {
  background: var(--bg-secondary);
  color: var(--text-tertiary);
  font-size: 0.6875rem;
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
}

.booth-card-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.booth-team-info {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.booth-team-num {
  font-weight: 700;
  font-size: 1rem;
  font-family: "JetBrains Mono", monospace;
}

.booth-team-name {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.booth-elapsed {
  font-size: 1.25rem;
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
  color: var(--accent-warning, #f59e0b);
  text-align: center;
}

.booth-select {
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.8125rem;
  background: var(--bg-input, var(--bg-primary));
  color: var(--text-primary);
}

.booth-select:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.booth-action-btn {
  width: 100%;
}

@media (max-width: 1024px) {
  .admin-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .booth-cards {
    flex-direction: column;
  }

  .booth-card {
    min-width: unset;
  }

  .queue-item {
    padding: 0.75rem;
  }

  .queue-item-header {
    flex-wrap: wrap;
  }

  .queue-item-left {
    flex: 1;
  }

  .entry-num {
    font-size: 1rem;
  }

  .entry-detail {
    font-size: 0.8125rem;
  }

  .queue-item-footer {
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .queue-item-meta {
    flex: 1;
    gap: 0.75rem;
  }

  .entry-phone {
    font-size: 0.75rem;
  }
}
</style>
