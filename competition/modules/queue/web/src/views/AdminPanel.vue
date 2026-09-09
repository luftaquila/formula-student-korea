<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from "vue";
import { useRouter } from "vue-router";
import { currentCompetitionYear } from "@shared/common/competition-year.mjs";
import {
  fetchEntries,
  fetchAllInspections,
  fetchInspectionQueue,
  fetchInspectionSummary,
  sendLastCall,
  cancelFromQueue,
  fetchActivePenalties,
  clearActivePenalty,
  restoreActivePenalty,
  enterBooth,
  exitBooth,
  setBoothTimerPaused,
  toggleBooth,
} from "../api";
import { useSSE } from "../composables/useSSE";
import { useInspectionSSE } from "../composables/useInspectionSSE";
import { useNotification } from "@shared/browser/useNotification.js";
import { useBoothTimers } from "../composables/useBoothTimers";
import { displayPhone } from "@shared/common/format-phone.js";
import { permissionComputed } from "@shared/browser/officialsStore.js";
import { createCoalescedRefresh } from "../coalesced-refresh.js";
import { findInspectionCategory } from "../inspection-category.js";
import { inspectionSheetPath } from "../inspection-sheet-path.js";
import { addPendingKey, removePendingKey } from "../pending-last-calls.js";

const { success, error, warning } = useNotification();
const router = useRouter();
const canManage = permissionComputed("queue.manage");
const canInspect = permissionComputed("inspection.operate");

const { activeInspections, lastQueueUpdate, allBooths, lastBoothUpdate, lastPenaltyUpdate, lastEntriesUpdate, reconnected } = useSSE();
const {
  lastInspectorUpdate,
  reconnected: inspectionReconnected,
} = useInspectionSSE(canInspect);

const entries = ref({});
const inspections = ref([]);
const inspectionSummary = ref(null);
const currentQueue = ref([]);
const currentTab = ref("");
const loading = ref(true);
const boothSelectedTeam = ref({});
const penalties = ref([]);
const penaltyModalOpen = ref(false);
const penaltiesLoading = ref(false);
const pendingPenaltyKey = ref("");
const pendingPenaltyAction = ref("");
const pendingBoothTimerKey = ref("");
const pendingLastCallKeys = ref(new Set());
const penaltyClock = ref(Date.now());
const penaltyButton = ref(null);
const penaltyCloseButton = ref(null);
let penaltyClockTimer;
let penaltyFetchSequence = 0;
const { elapsedTimes, syncTimers, clearAllTimers } = useBoothTimers();

const activeInspectionTypes = computed(() => activeInspections.value.map((i) => i.type));

const currentTabName = computed(() => {
  const item = activeInspections.value.find((i) => i.type === currentTab.value);
  return item ? item.name : "";
});

const currentCancelPenalty = computed(() => (
  inspections.value.find((item) => item.type === currentTab.value)?.cancel_penalty ?? 10
));

const currentBooths = computed(() => {
  if (!currentTab.value || !allBooths.value[currentTab.value]) return [];
  return allBooths.value[currentTab.value];
});

const activePenalties = computed(() => penalties.value.filter((penalty) => penalty.until > penaltyClock.value));

const inspectionSummaryRefresh = createCoalescedRefresh({ refresh: loadInspectionSummary });

function requestInspectionSummary() {
  if (!canInspect.value) return Promise.resolve(false);
  return inspectionSummaryRefresh.request();
}

// Watch for queue updates from SSE
watch(lastQueueUpdate, async (update) => {
  // type == null은 전 탭에 영향을 주는 변경(팀 삭제·번호변경 등)이다. 특정 탭을 보는 중이면
  // update.type(null)이 currentTab과 안 맞아 갱신을 놓쳤다 — null이면 항상 현재 탭을 새로고침.
  if (update && (update.type == null || update.type === currentTab.value || !currentTab.value)) {
    await refreshQueue(currentTab.value || update.type);
  }
});

// Watch for booth updates from SSE
watch(lastBoothUpdate, (update) => {
  if (update && update.type === currentTab.value) {
    syncElapsedTimers();
  }
});

watch(allBooths, syncElapsedTimers);

watch(lastPenaltyUpdate, () => {
  if (penaltyModalOpen.value) refreshPenaltyList();
});

watch(lastEntriesUpdate, async () => {
  try {
    entries.value = await fetchEntries();
    await requestInspectionSummary();
  }
  catch { error("엔트리 정보를 새로고침할 수 없습니다."); }
});

watch(reconnected, () => {
  if (penaltyModalOpen.value) refreshPenaltyList();
  requestInspectionSummary();
});

watch(lastInspectorUpdate, (update) => {
  if (update?.year === currentCompetitionYear()) requestInspectionSummary();
});

watch(inspectionReconnected, () => {
  requestInspectionSummary();
});

watch(canInspect, (allowed) => {
  if (allowed && !inspectionSummary.value) requestInspectionSummary();
  if (!allowed) inspectionSummary.value = null;
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
  penaltyClockTimer = window.setInterval(() => {
    penaltyClock.value = Date.now();
  }, 1000);

  try {
    entries.value = await fetchEntries();
    inspections.value = await fetchAllInspections();
    if (canInspect.value) await requestInspectionSummary();

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

onUnmounted(() => {
  window.clearInterval(penaltyClockTimer);
  clearAllTimers();
  inspectionSummaryRefresh.stop();
});

async function refreshQueue(type) {
  if (!type) return;
  try {
    currentQueue.value = await fetchInspectionQueue(type);
  } catch (e) {
    error("대기열을 가져올 수 없습니다.");
  }
}

async function loadInspectionSummary() {
  try {
    const nextSummary = await fetchInspectionSummary(currentCompetitionYear());
    if (canInspect.value) inspectionSummary.value = nextSummary;
  } catch {
    inspectionSummary.value = null;
  }
}

function inspectionCategoryFor(num) {
  if (!canInspect.value || !inspectionSummary.value) return null;
  const inspection = inspections.value.find((item) => item.type === currentTab.value)
    || activeInspections.value.find((item) => item.type === currentTab.value);
  return findInspectionCategory(
    inspectionSummary.value.categories,
    inspection?.name,
    entries.value[num]?.type,
  );
}

function previousInspectorsFor(item) {
  const category = inspectionCategoryFor(item.num);
  if (!category) return [];
  const names = inspectionSummary.value?.teams?.[item.num]?.inspectors?.[category.id];
  return Array.isArray(names) ? names : [];
}

function selectTab(type) {
  currentTab.value = type;
  localStorage.setItem("admin_tab", type);
  refreshQueue(type);
}

async function enterBoothAction(boothNum) {
  const num = boothSelectedTeam.value[boothNum];
  if (!num) return;
  const entry = entries.value[num];
  if (!confirm(`${currentTabName.value}${boothNum} 입차 확인\n#${num} ${entry?.univ ?? ""} ${entry?.team ?? ""}`)) return;
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

async function toggleBoothTimerAction(booth) {
  const key = `${currentTab.value}-${booth.booth_num}`;
  if (pendingBoothTimerKey.value === key) return;
  const paused = booth.timer_paused_at != null;
  pendingBoothTimerKey.value = key;
  try {
    const updated = await setBoothTimerPaused(currentTab.value, booth.booth_num, !paused);
    Object.assign(booth, updated);
    syncElapsedTimers();
    success(`${currentTabName.value}${booth.booth_num} 타이머를 ${paused ? "재개" : "중단"}했습니다.`);
  } catch (e) {
    error(e.message);
  } finally {
    pendingBoothTimerKey.value = "";
  }
}

function syncElapsedTimers() {
  syncTimers(currentBooths.value, currentTab.value);
}

async function cancelEntry(num) {
  if (!confirm(`엔트리 ${num}번을 취소하시겠습니까?\n${currentCancelPenalty.value}분간 페널티가 적용됩니다.`)) return;

  try {
    await cancelFromQueue(currentTab.value, num);
    warning(`엔트리 ${num}번 취소 (${currentCancelPenalty.value}분 페널티)`);
    await refreshQueue(currentTab.value);
  } catch (e) {
    error(e.message);
  }
}

async function lastCallEntry(num) {
  const key = `${currentTab.value}-${num}`;
  if (pendingLastCallKeys.value.has(key)) return;

  const entry = entries.value[num];
  if (!confirm(
    `엔트리 ${num}번에 라스트콜 문자를 발송하시겠습니까?\n`
    + `${currentTabName.value} 검차장으로 지금 즉시 입차하도록 안내합니다.\n`
    + `${entry?.univ ?? ""} ${entry?.team ?? ""}`,
  )) return;

  pendingLastCallKeys.value = addPendingKey(pendingLastCallKeys.value, key);
  try {
    await sendLastCall(currentTab.value, num);
    success(`엔트리 ${num}번에 라스트콜 문자를 발송했습니다.`);
  } catch (e) {
    error(e.message);
  } finally {
    pendingLastCallKeys.value = removePendingKey(pendingLastCallKeys.value, key);
  }
}

function isLastCallPending(num) {
  return pendingLastCallKeys.value.has(`${currentTab.value}-${num}`);
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

function goToSettings() {
  router.push("/settings");
}

function goToStats() {
  router.push("/stats");
}

async function refreshPenaltyList(showLoading = false) {
  const sequence = ++penaltyFetchSequence;
  if (showLoading) penaltiesLoading.value = true;
  try {
    const nextPenalties = await fetchActivePenalties();
    if (sequence !== penaltyFetchSequence) return;
    penalties.value = nextPenalties;
    penaltyClock.value = Date.now();
  } catch (e) {
    if (sequence !== penaltyFetchSequence) return;
    error(e.message || "페널티 목록을 가져올 수 없습니다.");
  } finally {
    if (sequence === penaltyFetchSequence) penaltiesLoading.value = false;
  }
}

async function openPenaltyModal() {
  penaltyModalOpen.value = true;
  penalties.value = [];
  await nextTick();
  penaltyCloseButton.value?.focus();
  await refreshPenaltyList(true);
}

async function closePenaltyModal() {
  if (!penaltyModalOpen.value) return;
  penaltyModalOpen.value = false;
  await nextTick();
  penaltyButton.value?.focus();
}

async function clearPenalty(penalty) {
  const entry = entries.value[penalty.num];
  const teamName = entry ? ` ${entry.univ} ${entry.team}` : "";
  if (!confirm(`#${penalty.num}${teamName}\n${penalty.inspection_name} 페널티만 해제하시겠습니까?`)) return;

  const key = `${penalty.inspection}-${penalty.num}`;
  pendingPenaltyKey.value = key;
  pendingPenaltyAction.value = "clear";
  try {
    await clearActivePenalty(penalty.inspection, penalty.num);
    penalties.value = penalties.value.filter((item) =>
      item.num !== penalty.num || item.inspection !== penalty.inspection,
    );
    success(`엔트리 ${penalty.num}번 ${penalty.inspection_name} 페널티를 해제했습니다.`);
  } catch (e) {
    error(e.message || "페널티를 해제할 수 없습니다.");
  } finally {
    pendingPenaltyKey.value = "";
    pendingPenaltyAction.value = "";
  }
}

async function restorePenalty(penalty) {
  const entry = entries.value[penalty.num];
  const teamName = entry ? ` ${entry.univ} ${entry.team}` : "";
  if (!confirm(
    `#${penalty.num}${teamName}\n${penalty.inspection_name} 페널티를 해제하고 취소 전 순번으로 복구하시겠습니까?`,
  )) return;

  const key = `${penalty.inspection}-${penalty.num}`;
  pendingPenaltyKey.value = key;
  pendingPenaltyAction.value = "restore";
  try {
    await restoreActivePenalty(penalty.inspection, penalty.num);
    penalties.value = penalties.value.filter((item) =>
      item.num !== penalty.num || item.inspection !== penalty.inspection,
    );
    success(`엔트리 ${penalty.num}번 ${penalty.inspection_name} 페널티를 해제하고 순번을 복구했습니다.`);
    if (penalty.inspection === currentTab.value) {
      await refreshQueue(currentTab.value);
    }
  } catch (e) {
    error(e.message || "페널티 해제 후 순번을 복구할 수 없습니다.");
  } finally {
    pendingPenaltyKey.value = "";
    pendingPenaltyAction.value = "";
  }
}

function formatPenaltyUntil(timestamp) {
  return new Date(timestamp).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPenaltyRemaining(timestamp) {
  const remainingSeconds = Math.max(0, Math.ceil((timestamp - penaltyClock.value) / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초 남음` : `${seconds}초 남음`;
}

function goToInspection(num) {
  const category = inspectionCategoryFor(num);
  // 큐는 항상 현재 연도의 엔트리를 다루므로(getEntries → entry 기본 연도),
  // 인스펙션 시트 경로 /:year/:num 의 year 는 현재 연도로 이동한다.
  const base = import.meta.env.PROD ? "/inspection" : "";
  window.location.href = inspectionSheetPath({
    base,
    year: currentCompetitionYear(),
    num,
    categoryId: category?.id,
  });
}

</script>

<template>
  <div class="admin-panel">
    <!-- Top Actions -->
    <div class="top-actions">
      <button v-if="canManage" class="btn btn-primary" @click="goToRegister">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="M12 5v14M5 12h14" />
        </svg>
        검차 등록
      </button>
      <button
        ref="penaltyButton"
        class="btn btn-ghost"
        type="button"
        aria-haspopup="dialog"
        aria-controls="penalty-modal"
        @click="openPenaltyModal"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6" />
          <path d="M12 17h.01" />
        </svg>
        페널티
      </button>
      <button class="btn btn-ghost" @click="goToStats">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="M18 20V10" />
          <path d="M12 20V4" />
          <path d="M6 20v-6" />
        </svg>
        통계
      </button>
      <button v-if="canManage" class="btn btn-ghost" @click="goToSettings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.07 14H3v-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63h.01A1.7 1.7 0 0 0 10 3.07V3h4v.09A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9v.01A1.7 1.7 0 0 0 20.93 10H21v4h-.09A1.7 1.7 0 0 0 19.4 15z" />
        </svg>
        설정
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
                  :class="{
                    'booth-inactive': !booth.active,
                    'booth-occupied': booth.occupied_by,
                    'booth-paused': booth.timer_paused_at,
                  }"
                >
                  <div class="booth-card-header">
                    <span class="booth-num">{{ currentTabName }}{{ booth.booth_num }}</span>
                    <span v-if="!booth.active" class="badge badge-muted">비활성</span>
                    <span v-else-if="booth.timer_paused_at" class="badge badge-danger">일시중단</span>
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
                    <div class="booth-elapsed" :class="{ 'booth-elapsed-paused': booth.timer_paused_at }">
                      {{ elapsedTimes[`${currentTab}-${booth.booth_num}`] || '00:00' }}
                    </div>
                    <div class="booth-action-row">
                      <button class="btn btn-danger btn-sm" @click="exitBoothAction(booth.booth_num)">
                        출차
                      </button>
                      <button
                        class="btn btn-sm"
                        :class="booth.timer_paused_at ? 'btn-success' : 'btn-ghost'"
                        :disabled="pendingBoothTimerKey === `${currentTab}-${booth.booth_num}`"
                        @click="toggleBoothTimerAction(booth)"
                      >
                        {{ booth.timer_paused_at ? "재개" : "중단" }}
                      </button>
                      <button
                        v-if="canInspect"
                        class="btn btn-primary btn-sm"
                        @click="goToInspection(booth.occupied_by)"
                      >
                        검차
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
              <div v-for="item in currentQueue" :key="item.num" class="queue-item">
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
                  </div>
                  <div class="queue-item-rank-row">
                    <div class="queue-item-tags">
                      <span class="badge badge-primary">전체 {{ item.rank }}번</span>
                      <span class="badge" :class="item.is_reinspection ? 'badge-warning' : 'badge-success'">
                        {{ item.is_reinspection ? "재검" : "초검" }} {{ item.group_rank }}번
                      </span>
                      <span v-if="item.priority < 999" class="badge badge-primary">우선 {{ item.priority }}</span>
                    </div>
                    <button
                      v-if="item.is_reinspection && inspectionCategoryFor(item.num) && previousInspectorsFor(item).length"
                      class="previous-inspector-link"
                      type="button"
                      title="검차표 열기"
                      @click="goToInspection(item.num)"
                    >
                      {{ previousInspectorsFor(item).join(" ") }}
                    </button>
                  </div>
                </div>
                <div class="queue-item-actions">
                  <button
                    class="btn btn-danger btn-icon btn-sm queue-action-button"
                    type="button"
                    :aria-label="`${item.num}번 대기 취소`"
                    title="취소"
                    :disabled="isLastCallPending(item.num)"
                    @click="cancelEntry(item.num)"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                  <button
                    class="btn btn-primary btn-icon btn-sm queue-action-button"
                    type="button"
                    :aria-label="`${item.num}번 라스트콜 문자 발송`"
                    title="라스트콜"
                    :aria-busy="isLastCallPending(item.num)"
                    :disabled="isLastCallPending(item.num)"
                    @click="lastCallEntry(item.num)"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true">
                      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                      <path d="M10 21h4" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="empty-state">대기중인 엔트리가 없습니다.</div>
          </template>
        </div>
      </div>

    </div>

    <Teleport to="body">
      <Transition name="penalty-modal">
        <div
          v-if="penaltyModalOpen"
          class="penalty-modal-overlay"
          @click.self="closePenaltyModal"
          @keydown.escape.window="closePenaltyModal"
        >
          <section
            id="penalty-modal"
            class="penalty-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="penalty-modal-title"
          >
            <header class="penalty-modal-header">
              <div>
                <h2 id="penalty-modal-title">현재 적용 중인 페널티</h2>
                <span v-if="!penaltiesLoading" class="penalty-count">{{ activePenalties.length }}건</span>
              </div>
              <button
                ref="penaltyCloseButton"
                class="penalty-modal-close"
                type="button"
                aria-label="페널티 목록 닫기"
                @click="closePenaltyModal"
              >
                ✕
              </button>
            </header>

            <div class="penalty-modal-body">
              <div v-if="penaltiesLoading" class="penalty-loading">
                <div class="loading-spinner"></div>
                <span>페널티를 불러오는 중...</span>
              </div>

              <div v-else-if="activePenalties.length === 0" class="penalty-empty">
                현재 적용 중인 페널티가 없습니다.
              </div>

              <ul v-else class="penalty-list">
                <li
                  v-for="penalty in activePenalties"
                  :key="`${penalty.inspection}-${penalty.num}`"
                  class="penalty-item"
                >
                  <div class="penalty-item-info">
                    <div class="penalty-team-row">
                      <span class="penalty-team-num">#{{ penalty.num }}</span>
                      <span class="penalty-team-name">
                        {{ entries[penalty.num]?.univ }} {{ entries[penalty.num]?.team }}
                      </span>
                    </div>
                    <div class="penalty-meta">
                      <span class="badge badge-warning">{{ penalty.inspection_name }}</span>
                      <span>{{ formatPenaltyRemaining(penalty.until) }}</span>
                      <span class="penalty-until">{{ formatPenaltyUntil(penalty.until) }} 해제</span>
                      <span v-if="!penalty.can_restore" class="penalty-restore-unavailable">순번 복구 정보 없음</span>
                    </div>
                  </div>
                  <div class="penalty-actions">
                    <button
                      class="btn btn-danger btn-sm"
                      type="button"
                      :disabled="pendingPenaltyKey === `${penalty.inspection}-${penalty.num}`"
                      @click="clearPenalty(penalty)"
                    >
                      {{ pendingPenaltyKey === `${penalty.inspection}-${penalty.num}` && pendingPenaltyAction === "clear" ? "해제 중..." : "페널티만 해제" }}
                    </button>
                    <button
                      class="btn btn-primary btn-sm"
                      type="button"
                      :disabled="!penalty.can_restore || pendingPenaltyKey === `${penalty.inspection}-${penalty.num}`"
                      :title="penalty.can_restore ? '페널티를 해제하고 취소 전 순번으로 복구' : '취소 당시 대기열 정보가 없어 순번을 복구할 수 없습니다.'"
                      @click="restorePenalty(penalty)"
                    >
                      {{ pendingPenaltyKey === `${penalty.inspection}-${penalty.num}` && pendingPenaltyAction === "restore" ? "복구 중..." : "해제 후 순번 복구" }}
                    </button>
                  </div>
                </li>
              </ul>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>
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

.penalty-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.penalty-modal {
  width: min(100%, 620px);
  max-height: min(80vh, 680px);
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: var(--shadow-hover);
}

.penalty-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.penalty-modal-header > div {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.penalty-modal-header h2 {
  font-size: 1rem;
  font-weight: 600;
}

.penalty-count {
  padding: 0.125rem 0.5rem;
  color: var(--accent-danger);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.75rem;
  font-weight: 600;
  background: color-mix(in srgb, var(--accent-danger) 12%, transparent);
  border-radius: 999px;
}

.penalty-modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.penalty-modal-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.penalty-modal-body {
  max-height: calc(min(80vh, 680px) - 65px);
  padding: 0.5rem 1.25rem 1.25rem;
  overflow-y: auto;
}

.penalty-loading,
.penalty-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  color: var(--text-tertiary);
  font-size: 0.875rem;
}

.penalty-loading {
  flex-direction: column;
  gap: 0.75rem;
}

.penalty-list {
  list-style: none;
}

.penalty-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--border-color);
}

.penalty-item:last-child {
  border-bottom: 0;
}

.penalty-item-info {
  min-width: 0;
}

.penalty-team-row,
.penalty-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.penalty-team-row {
  margin-bottom: 0.375rem;
}

.penalty-team-num {
  flex-shrink: 0;
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
}

.penalty-team-name {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.875rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.penalty-meta {
  flex-wrap: wrap;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.penalty-until {
  color: var(--text-tertiary);
}

.penalty-restore-unavailable {
  color: var(--accent-danger);
}

.penalty-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.penalty-modal-enter-active,
.penalty-modal-leave-active {
  transition: opacity 0.15s ease;
}

.penalty-modal-enter-active .penalty-modal,
.penalty-modal-leave-active .penalty-modal {
  transition: transform 0.15s ease;
}

.penalty-modal-enter-from,
.penalty-modal-leave-to {
  opacity: 0;
}

.penalty-modal-enter-from .penalty-modal,
.penalty-modal-leave-to .penalty-modal {
  transform: translateY(8px) scale(0.98);
}

.admin-grid {
  display: grid;
  grid-template-columns: 1fr;
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--border-color);
}

.queue-item:last-child {
  border-bottom: none;
}

.queue-item-content {
  min-width: 0;
}

.queue-item-actions {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.queue-action-button {
  flex: none;
}

.queue-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.375rem;
}

.queue-item-left {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 0.5rem;
  min-width: 0;
}



.queue-item-meta {
  display: flex;
  align-items: center;
  gap: 0.25rem 0.625rem;
}

.queue-item-rank-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  margin-top: 0.25rem;
}

.queue-item-tags {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 0.25rem;
}

.previous-inspector-link {
  min-width: 0;
  padding: 0;
  overflow: hidden;
  border: 0;
  color: var(--accent-primary);
  background: none;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.3;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.previous-inspector-link:hover { text-decoration: underline; }

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
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  text-decoration: none;
}

.entry-phone:hover {
  color: var(--accent-primary);
  text-decoration: underline;
}

.entry-time {
  font-size: 0.8125rem;
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
}

.loading {
  padding: 2rem;
}

.empty-state {
  padding: 3rem;
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
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
  padding: 0.875rem 1rem;
}

.booth-card {
  min-width: 0;
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

.booth-card.booth-paused {
  border-color: var(--accent-danger, #ef4444);
  background: rgba(239, 68, 68, 0.06);
  box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.18);
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

.booth-elapsed-paused {
  color: var(--accent-danger, #ef4444);
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

@media (max-width: 1280px) {
  .booth-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1024px) {
  .admin-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .top-actions {
    flex-wrap: nowrap;
    overflow-x: auto;
  }

  .top-actions .btn {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .penalty-modal-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .penalty-modal {
    width: 100%;
    max-height: 85vh;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 12px 12px 0 0;
  }

  .penalty-modal-body {
    max-height: calc(85vh - 65px);
  }

  .penalty-item {
    align-items: stretch;
    flex-direction: column;
  }

  .booth-cards {
    grid-template-columns: minmax(0, 1fr);
  }

  .queue-item {
    padding: 0.5rem 0.625rem;
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
    gap: 0.25rem 0.5rem;
  }

  .queue-item-tags .badge {
    padding: 0.1875rem 0.375rem;
    font-size: 0.6875rem;
  }

  .queue-action-button {
    width: 30px;
    height: 30px;
    padding: 0;
  }

  .entry-phone,
  .entry-time {
    font-size: 0.75rem;
  }
}
</style>
