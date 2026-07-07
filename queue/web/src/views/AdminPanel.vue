<script setup>
import { ref, onMounted, computed, watch } from "vue";
import { useRouter } from "vue-router";
import {
  fetchEntries,
  fetchAllInspections,
  fetchInspectionQueue,
  toggleInspectionActive,
  toggleInspectionVisibility,
  cancelFromQueue,
  enterBooth,
  exitBooth,
  updateBoothConfig,
  toggleBooth,
  fetchSmsSettings,
  setSmsSettings,
  fetchSmsRankSettings,
  setSmsRankSettings,
  fetchCancelPenaltySettings,
  setCancelPenaltySettings,
} from "../api";
import { useSSE } from "../composables/useSSE";
import { useNotification } from "@shared/useNotification.js";
import { useBoothTimers } from "../composables/useBoothTimers";
import { displayPhone } from "@shared/format-phone.js";
import { isChief } from "@shared/officialsStore.js";

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
const { elapsedTimes, syncTimers, clearAllTimers } = useBoothTimers();

const activeInspectionTypes = computed(() => activeInspections.value.map((i) => i.type));

const currentTabName = computed(() => {
  const item = activeInspections.value.find((i) => i.type === currentTab.value);
  return item ? item.name : "";
});

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
    if (newVal.length > 0 && (!currentTab.value || !activeInspectionTypes.value.includes(currentTab.value))) {
      const savedTab = localStorage.getItem("admin_tab");
      if (savedTab && activeInspectionTypes.value.includes(savedTab)) {
        currentTab.value = savedTab;
      } else {
        currentTab.value = newVal[0].type;
        localStorage.setItem("admin_tab", currentTab.value);
      }
      await refreshQueue(currentTab.value);
    } else if (newVal.length === 0) {
      currentTab.value = "";
    }
  },
  { immediate: true },
);

onMounted(async () => {
  try {
    entries.value = await fetchEntries();
    inspections.value = await fetchAllInspections();
    if (isChief.value) {
      const sms = await fetchSmsSettings();
      smsEnabled.value = sms.value;
      const smsRankData = await fetchSmsRankSettings();
      smsRank.value = smsRankData.value;
    }
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

async function toggleActive(type, currentActive) {
  try {
    await toggleInspectionActive(type, !currentActive);
    const item = inspections.value.find(i => i.type === type);
    if (item) item.active = !currentActive;
  } catch (e) {
    error("활성화 상태를 변경할 수 없습니다.");
  }
}

async function toggleVisibility(type, currentHidden) {
  try {
    await toggleInspectionVisibility(type, !currentHidden);
    const item = inspections.value.find(i => i.type === type);
    if (item) item.hidden_from_register = !currentHidden ? 1 : 0;
  } catch (e) {
    error("표시 상태를 변경할 수 없습니다.");
  }
}

async function enterBoothAction(boothNum) {
  const num = boothSelectedTeam.value[boothNum];
  if (!num) return;
  try {
    await enterBooth(currentTab.value, boothNum, num);
    success(`엔트리 ${num}번 ${currentTabName.value}${boothNum} 입차`);
    boothSelectedTeam.value[boothNum] = null;
    await refreshQueue(currentTab.value);
  } catch (e) {
    error(e.message);
  }
}

async function exitBoothAction(boothNum) {
  const booth = currentBooths.value.find((b) => b.booth_num === boothNum);
  if (!booth || !booth.occupied_by) return;
  const occupant = entries.value[booth.occupied_by];
  if (!confirm(`${currentTabName.value}${boothNum} 출차 확인\n#${booth.occupied_by} ${occupant?.univ ?? ""} ${occupant?.team ?? ""}`)) return;
  try {
    await exitBooth(currentTab.value, boothNum);
    success(`엔트리 ${booth.occupied_by}번 ${currentTabName.value}${boothNum} 출차`);
    await refreshQueue(currentTab.value);
  } catch (e) {
    error(e.message);
  }
}

function syncElapsedTimers() {
  syncTimers(currentBooths.value, currentTab.value);
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

async function toggleBoothActive(type, boothNum, currentActive, ev) {
  try {
    await toggleBooth(type, boothNum, !currentActive);
    success(`${currentTabName.value}${boothNum} ${!currentActive ? "활성화" : "비활성화"}`);
  } catch (err) {
    error(err.message);
    ev.target.checked = currentActive;
  }
}



function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("ko-KR");
}

function goToRegister() {
  router.push("/register");
}

function goToPriority() {
  router.push("/priority");
}

function goToStats() {
  router.push("/stats");
}

function goToInspection(num) {
  // 큐는 항상 현재 연도의 엔트리를 다루므로(getEntries → entry 기본 연도),
  // 인스펙션 시트 경로 /:year/:num 의 year 는 현재 연도로 이동한다.
  const base = import.meta.env.PROD ? "/inspection" : "";
  window.location.href = `${base}/${new Date().getFullYear()}/${num}`;
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
      <button v-if="isChief" class="btn btn-ghost" @click="goToPriority">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <polygon
            points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
          />
        </svg>
        우선순위
      </button>
      <button class="btn btn-ghost" @click="goToStats">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="M18 20V10" />
          <path d="M12 20V4" />
          <path d="M6 20v-6" />
        </svg>
        통계
      </button>
    </div>

    <div class="admin-grid" :class="{ 'no-settings': !isChief }">
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
                    <span class="booth-num">{{ currentTabName }}{{ booth.booth_num }}</span>
                    <span v-if="!booth.active" class="badge badge-muted">비활성</span>
                    <span v-else-if="booth.occupied_by" class="badge badge-warning">검차중</span>
                    <span v-else class="badge badge-success">입차 가능</span>
                    <label class="toggle toggle-sm booth-toggle">
                      <input
                        type="checkbox"
                        :checked="booth.active"
                        :disabled="booth.active && !!booth.occupied_by"
                        @change="toggleBoothActive(currentTab, booth.booth_num, booth.active, $event)"
                      />
                      <span class="toggle-slider"></span>
                    </label>
                  </div>
                  <div v-if="booth.active && booth.occupied_by" class="booth-card-body">
                    <div class="booth-team-info">
                      <span class="booth-team-num">{{ booth.occupied_by }}</span>
                      <span class="booth-team-name">{{ entries[booth.occupied_by]?.univ }} {{ entries[booth.occupied_by]?.team }}</span>
                    </div>
                    <div class="booth-elapsed">{{ elapsedTimes[`${currentTab}-${booth.booth_num}`] || '00:00' }}</div>
                    <div class="booth-action-row">
                      <button class="btn btn-danger btn-sm" @click="exitBoothAction(booth.booth_num)">
                        출차
                      </button>
                      <button class="btn btn-primary btn-sm" @click="goToInspection(booth.occupied_by)">
                        인스펙션
                      </button>
                    </div>
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
                    <div class="booth-elapsed booth-elapsed-empty">--:--</div>
                    <button
                      class="btn btn-success btn-sm booth-action-btn"
                      :disabled="!boothSelectedTeam[booth.booth_num]"
                      @click="enterBoothAction(booth.booth_num)"
                    >
                      입차
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
                <div class="queue-item-content">
                  <div class="queue-item-header">
                    <div class="queue-item-left">
                      <span class="entry-num">{{ item.num }}</span>
                      <span class="entry-detail">{{ entries[item.num]?.univ }} {{ entries[item.num]?.team }}</span>
                    </div>
                  </div>
                  <div class="queue-item-meta">
                    <a :href="`tel:${item.phone}`" class="entry-phone">{{ displayPhone(item.phone) }}</a>
                    <span class="entry-time">{{ formatTime(item.timestamp) }}</span>
                    <div class="queue-item-tags">
                      <span v-if="item.is_reinspection" class="badge badge-warning">재검</span>
                      <span v-else class="badge badge-success">초검</span>
                      <span v-if="item.priority < 999" class="badge badge-primary">{{ item.priority }}순위</span>
                    </div>
                  </div>
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
            <div v-else class="empty-state">대기중인 엔트리가 없습니다.</div>
          </template>
        </div>
      </div>

      <!-- Settings Panel -->
      <div v-if="isChief" class="card settings-panel">
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
                <div class="setting-info-left">
                  <span class="setting-label">{{ item.name }}</span>
                  <div class="setting-input">
                    <input
                      type="number"
                      :value="allBooths[item.type]?.length || 1"
                      min="1"
                      @change="updateBoothCount(item.type, $event)"
                    />
                    <span>부스</span>
                  </div>
                </div>
                <div class="inspection-buttons">
                  <button
                    class="btn-toggle-visibility"
                    :class="{ hidden: item.hidden_from_register }"
                    @click="toggleVisibility(item.type, item.hidden_from_register)"
                    :title="item.hidden_from_register ? '등록 페이지에 표시' : '등록 페이지에서 숨김'"
                  >
                    <svg v-if="!item.hidden_from_register" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  </button>
                  <button
                    class="btn-toggle-active"
                    :class="{ active: item.active }"
                    @click="toggleActive(item.type, item.active)"
                    :title="item.active ? '비활성화' : '활성화'"
                  >
                    <svg v-if="item.active" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </button>
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

.admin-grid.no-settings {
  grid-template-columns: 1fr;
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
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--border-color);
}

.queue-item:last-child {
  border-bottom: none;
}

.queue-item-content {
  flex: 1;
  min-width: 0;
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



.queue-item-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.queue-item-tags {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.entry-num {
  font-size: 1.125rem;
  flex-shrink: 0;
}

.entry-detail {
  font-size: 0.875rem;
  color: var(--text-primary);
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
  font-size: 0.8125rem;
  color: var(--text-tertiary);
  font-family: "JetBrains Mono", monospace;
}

.loading {
  padding: 2rem;
}

.empty-state {
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

.divider {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 0.5rem 0;
}

.setting-section {
  margin-top: 0.5rem;
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

.setting-info-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.setting-info-left .setting-label {
  min-width: 3.5em;
}

.inspection-setting .setting-input input {
  width: 40px;
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

.inspection-buttons {
  display: flex;
  gap: 0.375rem;
}

/* 표시/숨김 버튼 */
.btn-toggle-visibility {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--accent-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-toggle-visibility svg {
  width: 18px;
  height: 18px;
}

.btn-toggle-visibility:hover {
  background: var(--bg-hover);
}

.btn-toggle-visibility.hidden {
  color: var(--text-tertiary);
  border-color: var(--border-color);
}

/* 활성화 토글 버튼 */
.btn-toggle-active {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-toggle-active svg {
  width: 18px;
  height: 18px;
}

.btn-toggle-active:hover {
  background: var(--bg-hover);
  color: var(--accent-success);
  border-color: var(--accent-success);
}

.btn-toggle-active.active {
  background: var(--accent-success);
  color: white;
  border-color: var(--accent-success);
}

.btn-toggle-active.active:hover {
  background: var(--accent-danger);
  border-color: var(--accent-danger);
}

.toggle.toggle-sm {
  width: 32px;
  height: 18px;
}

.toggle-sm .toggle-slider {
  width: 32px;
  height: 18px;
}

.toggle-sm .toggle-slider::before {
  width: 14px;
  height: 14px;
  bottom: 2px;
  left: 2px;
}

.toggle-sm input:checked + .toggle-slider::before {
  transform: translateX(14px);
}

.toggle-sm input:disabled + .toggle-slider {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Booth Section */
.booth-section {
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
  min-width: 200px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.75rem;
  background: var(--bg-card);
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
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  min-width: 0;
}

.booth-toggle {
  margin-left: auto;
  flex-shrink: 0;
}

.booth-num {
  font-weight: 600;
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.booth-card-header .badge {
  flex-shrink: 0;
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
  /* 대기 부스의 select 와 같은 높이(min-height 2rem, box-sizing: border-box)로
     맞춰 입차/대기 부스 카드의 총 높이를 일치시킨다. */
  min-height: 2rem;
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

.booth-elapsed-empty {
  color: var(--text-tertiary);
}

.booth-select {
  width: 100%;
  min-height: 2rem;
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

.booth-action-row {
  display: flex;
  gap: 0.5rem;
}

.booth-action-row .btn {
  flex: 1;
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

  .queue-item-meta {
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
  }

  .queue-item-tags {
    flex-basis: 100%;
  }

  .entry-phone {
    font-size: 0.75rem;
  }
}
</style>
