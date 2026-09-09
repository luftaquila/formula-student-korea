<script setup>
import { ref, onMounted, computed, watch } from "vue";
import { useRouter } from "vue-router";
import {
  fetchEntries,
  fetchVehicleTypes,
  fetchAllInspections,
  toggleInspectionActive,
  toggleInspectionVisibility,
  updateBoothConfig,
  setInspectionSettings,
  fetchPriorities,
  setPriority,
  removePriority,
  resetAllPriorities,
  resetInspectionHistory,
  setInspectionIgnore,
  fetchReinspectionStatus,
} from "../api";
import { useNotification } from "@shared/browser/useNotification.js";
import { useSSE } from "../composables/useSSE";
import { usePersistentTypeFilters } from "@shared/browser/usePersistentTypeFilters.js";
import { useTableHeadBand } from "@shared/browser/useTableHeadBand.js";

const { success, error } = useNotification();
const router = useRouter();
const { allBooths, lastEntriesUpdate } = useSSE();

const tableRef = ref(null);
const scrollerRef = ref(null);
const headBandRef = ref(null);
useTableHeadBand({ tableRef, scrollerRef, bandRef: headBandRef });

const entries = ref({});
const inspections = ref([]);
const allPriorities = ref({}); // { inspectionType: { num: priority, ... }, ... }
const priorityDrafts = ref({});
const reinspectionStatus = ref({}); // { inspectionType: [num, ...], ... }
const settingsDrafts = ref({});
const loading = ref(true);
const searchQuery = ref("");
const typeColorMap = ref({});

// Convert entries object to sorted array
const entriesArray = computed(() => {
  return Object.entries(entries.value)
    .map(([num, data]) => ({
      num: Number(num),
      ...data,
    }))
    .sort((a, b) => a.num - b.num);
});
const availableTypes = computed(() => [...new Set(entriesArray.value.map((entry) => entry.type).filter(Boolean))].sort());
const typeFilters = usePersistentTypeFilters("queue-priority-type-filter", availableTypes);

function getTypeColor(type) {
  return typeColorMap.value[type] || "blue";
}

// Filtered entries based on search
const filteredEntries = computed(() => {
  const typeFiltered = entriesArray.value.filter(
    (entry) => !entry.type || typeFilters.value[entry.type] !== false,
  );
  if (!searchQuery.value.trim()) return typeFiltered;
  const query = searchQuery.value.toLowerCase();
  return typeFiltered.filter(
    (entry) =>
      entry.num.toString().includes(query) ||
      entry.univ.toLowerCase().includes(query) ||
      entry.team.toLowerCase().includes(query),
  );
});

// Get priority for a specific entry and inspection type
function getPriority(num, type) {
  return allPriorities.value[type]?.[num] ?? null;
}

function getPriorityInput(num, type) {
  return priorityDrafts.value[`${type}:${num}`]?.value ?? getPriority(num, type);
}

function editPriority(type, num, value) {
  priorityDrafts.value[`${type}:${num}`] = { value };
}

// Check if any priority is set for a given inspection type
function hasAnyPriority(type) {
  const priorities = allPriorities.value[type];
  return priorities && Object.keys(priorities).length > 0;
}

function isReinspection(num, type) {
  return reinspectionStatus.value[type]?.includes(num) ?? false;
}

onMounted(async () => {
  try {
    const [entryData, vehicleTypeData] = await Promise.all([
      fetchEntries(),
      fetchVehicleTypes().catch(() => []),
    ]);
    entries.value = entryData;
    typeColorMap.value = Object.fromEntries(vehicleTypeData.map((type) => [type.name, type.color]));
    inspections.value = await fetchAllInspections();
    settingsDrafts.value = Object.fromEntries(inspections.value.map((inspection) => [inspection.type, {
      sms: inspection.sms === 1 || inspection.sms === true,
      smsRank: inspection.sms_rank,
      cancelPenalty: inspection.cancel_penalty,
    }]));

    // Fetch priorities and reinspection status for all inspection types
    await Promise.all([refreshAllPriorities(), refreshReinspectionStatus()]);
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
});

watch(lastEntriesUpdate, async () => {
  try {
    entries.value = await fetchEntries();
    await Promise.all([refreshAllPriorities(), refreshReinspectionStatus()]);
  } catch {
    error("엔트리 정보를 새로고침할 수 없습니다.");
  }
});

async function refreshAllPriorities() {
  try {
    const priorityPromises = inspections.value.map(async (inspection) => {
      const data = await fetchPriorities(inspection.type);
      return {
        type: inspection.type,
        priorities: data.reduce((acc, p) => {
          acc[p.num] = p.priority;
          return acc;
        }, {}),
      };
    });

    const results = await Promise.all(priorityPromises);
    allPriorities.value = results.reduce((acc, result) => {
      acc[result.type] = result.priorities;
      return acc;
    }, {});
  } catch (e) {
    error("우선순위 정보를 가져올 수 없습니다.");
  }
}

async function refreshReinspectionStatus() {
  try {
    reinspectionStatus.value = await fetchReinspectionStatus();
  } catch (e) {
    error("재검 현황을 가져올 수 없습니다.");
  }
}

async function refreshPrioritiesForType(type) {
  try {
    const data = await fetchPriorities(type);
    allPriorities.value[type] = data.reduce((acc, p) => {
      acc[p.num] = p.priority;
      return acc;
    }, {});
  } catch (e) {
    error("우선순위 정보를 가져올 수 없습니다.");
  }
}

async function updatePriority(type, num, value) {
  const key = `${type}:${num}`;
  const draft = priorityDrafts.value[key];
  try {
    await savePriority(type, num, value);
  } finally {
    // A slow save must not discard input entered while that request was pending.
    if (priorityDrafts.value[key] === draft) delete priorityDrafts.value[key];
  }
}

async function savePriority(type, num, value) {
  const priority = Number(value);

  if (!value || value === "") {
    // Remove priority
    try {
      await removePriority(type, num);
      success(`${num}번 우선순위 해제`);
      await refreshPrioritiesForType(type);
    } catch (e) {
      // Ignore if not exists
    }
    return;
  }

  if (isNaN(priority) || priority < 0) {
    error("우선순위는 0 이상의 숫자여야 합니다.");
    return;
  }

  try {
    await setPriority(type, num, priority);
    const inspectionName = inspections.value.find((i) => i.type === type)?.name || type;
    success(`${num}번 ${inspectionName} 우선순위 ${priority}로 설정`);
    await refreshPrioritiesForType(type);
  } catch (e) {
    error(e.message);
  }
}

async function resetAll(type) {
  const inspectionName = inspections.value.find((i) => i.type === type)?.name || type;
  if (!confirm(`${inspectionName} 검차의 모든 우선순위를 초기화하시겠습니까?`)) return;

  try {
    await resetAllPriorities(type);
    success(`${inspectionName} 우선순위를 초기화했습니다.`);
    await refreshPrioritiesForType(type);
  } catch (e) {
    error(e.message);
  }
}

async function resetHistory(type) {
  const inspectionName = inspections.value.find((i) => i.type === type)?.name || type;
  if (!confirm(`${inspectionName} 검차의 초검/재검 이력을 초기화하시겠습니까?\n모든 팀이 초검으로 간주됩니다.`)) return;

  try {
    await resetInspectionHistory(type);
    success(`${inspectionName} 검차 이력을 초기화했습니다.`);
    await refreshReinspectionStatus();
  } catch (e) {
    error(e.message);
  }
}

async function toggleIgnore(type, field, currentValue) {
  try {
    await setInspectionIgnore(type, field, !currentValue);
    // Refresh inspections to get updated flags
    inspections.value = await fetchAllInspections();
    const label = field === "ignore_priority" ? "우선순위" : "초검/재검";
    success(`${label} ${!currentValue ? "무시" : "적용"}`);
  } catch (e) {
    error(e.message);
  }
}

async function toggleActive(inspection) {
  const active = !inspection.active;
  try {
    await toggleInspectionActive(inspection.type, active);
    inspection.active = active ? 1 : 0;
    success(`${inspection.name} 대기열을 ${active ? "활성화" : "비활성화"}했습니다.`);
  } catch (e) {
    error(e.message || "활성화 상태를 변경할 수 없습니다.");
  }
}

async function toggleVisibility(inspection) {
  const hidden = !inspection.hidden_from_register;
  try {
    await toggleInspectionVisibility(inspection.type, hidden);
    inspection.hidden_from_register = hidden ? 1 : 0;
    success(`${inspection.name} 공개 화면 ${hidden ? "숨김" : "표시"} 설정을 저장했습니다.`);
  } catch (e) {
    error(e.message || "표시 상태를 변경할 수 없습니다.");
  }
}

function applyInspectionSettings(inspection, updated) {
  inspection.sms = updated.sms ? 1 : 0;
  inspection.sms_rank = updated.smsRank;
  inspection.cancel_penalty = updated.cancelPenalty;
  Object.assign(settingsDrafts.value[inspection.type], updated);
}

async function toggleSms(inspection, event) {
  const enabled = event.target.checked;
  try {
    const updated = await setInspectionSettings(inspection.type, { sms: enabled });
    applyInspectionSettings(inspection, updated);
    success(`${inspection.name} SMS 알림을 ${enabled ? "활성화" : "비활성화"}했습니다.`);
  } catch (e) {
    event.target.checked = settingsDrafts.value[inspection.type].sms;
    error(e.message);
  }
}

async function updateSmsRank(inspection, event) {
  const value = Number(event.target.value);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    settingsDrafts.value[inspection.type].smsRank = inspection.sms_rank;
    return;
  }
  try {
    const updated = await setInspectionSettings(inspection.type, { smsRank: value });
    applyInspectionSettings(inspection, updated);
    success(`${inspection.name} SMS 알림 순번을 ${value}번으로 변경했습니다.`);
  } catch (e) {
    settingsDrafts.value[inspection.type].smsRank = inspection.sms_rank;
    error(e.message);
  }
}

async function updateCancelPenalty(inspection, event) {
  const value = Number(event.target.value);
  if (!Number.isInteger(value) || value < 0 || value > 60) {
    settingsDrafts.value[inspection.type].cancelPenalty = inspection.cancel_penalty;
    return;
  }
  try {
    const updated = await setInspectionSettings(inspection.type, { cancelPenalty: value });
    applyInspectionSettings(inspection, updated);
    success(`${inspection.name} 취소 페널티를 ${value}분으로 변경했습니다.`);
  } catch (e) {
    settingsDrafts.value[inspection.type].cancelPenalty = inspection.cancel_penalty;
    error(e.message);
  }
}

async function updateBoothCount(inspection, event) {
  const value = Number(event.target.value);
  if (!Number.isInteger(value) || value < 1) {
    event.target.value = allBooths.value[inspection.type]?.length || 1;
    return;
  }
  try {
    await updateBoothConfig(inspection.type, value);
    success(`${inspection.name} 부스 수를 ${value}개로 변경했습니다.`);
  } catch (e) {
    event.target.value = allBooths.value[inspection.type]?.length || 1;
    error(e.message);
  }
}

// 키보드 방향키 네비게이션 (내구 입력과 동일)
function handleKeyNav(e) {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const target = e.target;
  if (target.tagName !== "INPUT" || target.disabled) return;
  e.preventDefault();

  const grid = getInputGrid(target);
  let row = -1,
    col = -1;
  for (let r = 0; r < grid.length; r++) {
    const c = grid[r].indexOf(target);
    if (c !== -1) {
      row = r;
      col = c;
      break;
    }
  }
  if (row === -1) return;

  let next = null;
  if (e.key === "ArrowLeft" && col > 0) next = grid[row][col - 1];
  else if (e.key === "ArrowRight" && col < grid[row].length - 1) next = grid[row][col + 1];
  else if (e.key === "ArrowUp") {
    for (let r = row - 1; r >= 0; r--) {
      if (grid[r][col]) {
        next = grid[r][col];
        break;
      }
    }
  } else if (e.key === "ArrowDown") {
    for (let r = row + 1; r < grid.length; r++) {
      if (grid[r][col]) {
        next = grid[r][col];
        break;
      }
    }
  }
  if (next) {
    next.focus();
    next.select();
  }
}

function getInputGrid(el) {
  const table = el.closest(".priority-table");
  const rows = Array.from(table.querySelectorAll("tbody tr"));
  return rows.map((tr) => Array.from(tr.querySelectorAll("input:not([disabled])")));
}

function goBack() {
  router.push("/admin");
}
</script>

<template>
  <div class="priority-page">
    <button class="btn btn-ghost back-btn" @click="goBack">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
        <path d="m15 18-6-6 6-6" />
      </svg>
      돌아가기
    </button>

    <section class="card inspection-settings-section">
      <div class="card-header settings-section-header">
        <div>
          <h2>검차별 설정</h2>
          <p>대기열 운영, 공개 범위, 알림과 페널티를 검차별로 설정합니다.</p>
        </div>
      </div>
      <div class="card-body settings-section-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
        </div>
        <div v-else class="inspection-settings-grid">
          <article
            v-for="inspection in inspections"
            :key="inspection.type"
            class="inspection-setting-group"
            :data-inspection="inspection.type"
          >
            <header class="inspection-setting-header">
              <div>
                <h3>{{ inspection.name }}</h3>
                <span class="inspection-code">{{ inspection.type }}</span>
              </div>
              <span class="inspection-status" :class="{ active: inspection.active }">
                {{ inspection.active ? "운영 중" : "운영 중지" }}
              </span>
            </header>

            <div class="inspection-buttons">
              <button
                type="button"
                class="inspection-state-button"
                :class="{ enabled: inspection.active }"
                :aria-pressed="Boolean(inspection.active)"
                @click="toggleActive(inspection)"
              >
                <span class="state-indicator"></span>
                <span class="state-copy">
                  <strong>대기열</strong>
                  <small>{{ inspection.active ? "사용 중" : "사용 안 함" }}</small>
                </span>
              </button>
              <button
                type="button"
                class="inspection-state-button"
                :class="{ enabled: !inspection.hidden_from_register }"
                :aria-pressed="!inspection.hidden_from_register"
                @click="toggleVisibility(inspection)"
              >
                <span class="state-indicator"></span>
                <span class="state-copy">
                  <strong>공개 화면</strong>
                  <small>{{ inspection.hidden_from_register ? "숨김" : "표시" }}</small>
                </span>
              </button>
            </div>

            <div class="inspection-setting-fields">
              <div class="setting-item">
                <div class="setting-copy">
                  <span class="setting-label">SMS 알림</span>
                  <small>대기 순번 안내</small>
                </div>
                <label class="toggle">
                  <input
                    type="checkbox"
                    :aria-label="`${inspection.name} SMS 알림`"
                    :checked="settingsDrafts[inspection.type].sms"
                    @change="toggleSms(inspection, $event)"
                  />
                  <span class="toggle-slider"></span>
                </label>
              </div>

              <label class="setting-item">
                <span class="setting-copy">
                  <span class="setting-label">SMS 알림 순번</span>
                  <small>1~10번</small>
                </span>
                <span class="setting-input">
                  <input
                    v-model="settingsDrafts[inspection.type].smsRank"
                    type="number"
                    min="1"
                    max="10"
                    @change="updateSmsRank(inspection, $event)"
                  />
                  <span>번</span>
                </span>
              </label>

              <label class="setting-item">
                <span class="setting-copy">
                  <span class="setting-label">취소 페널티</span>
                  <small>0~60분</small>
                </span>
                <span class="setting-input">
                  <input
                    v-model="settingsDrafts[inspection.type].cancelPenalty"
                    type="number"
                    min="0"
                    max="60"
                    @change="updateCancelPenalty(inspection, $event)"
                  />
                  <span>분</span>
                </span>
              </label>

              <label class="setting-item booth-setting">
                <span class="setting-copy">
                  <span class="setting-label">운영 부스</span>
                  <small>최소 1개</small>
                </span>
                <span class="setting-input">
                  <input
                    type="number"
                    :value="allBooths[inspection.type]?.length || 1"
                    min="1"
                    @change="updateBoothCount(inspection, $event)"
                  />
                  <span>개</span>
                </span>
              </label>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- Rules -->
    <div class="rules-banner">
      <div class="rules-title">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="18"
          height="18"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        우선순위 규칙
      </div>
      <div class="rules-list">
        <div class="rule-item">
          <span class="rule-number">1</span>
          <span class="rule-text"><strong>초검/재검</strong></span>
        </div>
        <div class="rule-item">
          <span class="rule-number">2</span>
          <span class="rule-text"><strong>우선순위</strong></span>
        </div>
        <div class="rule-item">
          <span class="rule-number">3</span>
          <span class="rule-text"><strong>선착순</strong></span>
        </div>
      </div>
    </div>

    <!-- Entry Table with Priority Inputs -->
    <div class="card entries-card team-table-card">
      <div class="card-header">
        <div class="header-left">
          <h3>우선순위 설정</h3>
          <span class="count-badge">{{ filteredEntries.length }}개 팀</span>
        </div>
        <div class="header-right">
          <div v-if="availableTypes.length" class="team-type-filter" data-testid="queue-priority-type-filter">
            <label v-for="type in availableTypes" :key="type" class="team-type-filter-label">
              <input v-model="typeFilters[type]" type="checkbox" :value="type" />
              <span class="badge" :class="'badge-type-' + getTypeColor(type)">{{ type }}</span>
            </label>
          </div>
          <div class="search-box">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input v-model="searchQuery" type="text" placeholder="엔트리 / 학교 / 팀명" class="search-input" />
          </div>
        </div>
      </div>

      <div class="card-body team-table-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
        </div>
        <div v-else class="sticky-host team-table-sticky-host">
          <div ref="headBandRef" class="team-table-head-band" data-testid="queue-priority-sticky-header"></div>
          <div ref="scrollerRef" class="table-container team-table-scroll" data-testid="queue-priority-table-scroll">
          <table ref="tableRef" class="priority-table team-table" @keydown="handleKeyNav">
            <thead>
              <tr>
                <th class="col-num">엔트리</th>
                <th class="col-team">학교 / 팀</th>
                <th class="col-type">유형</th>
                <th v-for="inspection in inspections" :key="inspection.type" class="col-priority">
                  <div class="th-content">
                    <span>{{ inspection.name }}</span>
                    <button
                      class="btn-reset"
                      @click="resetAll(inspection.type)"
                      :disabled="!hasAnyPriority(inspection.type)"
                      title="우선순위 초기화"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    </button>
                  </div>
                  <div class="th-controls">
                    <button
                      class="btn-th-toggle"
                      :class="{ active: !inspection.ignore_reinspection }"
                      @click="toggleIgnore(inspection.type, 'ignore_reinspection', inspection.ignore_reinspection)"
                      :title="inspection.ignore_reinspection ? '초검/재검 적용' : '초검/재검 무시'"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    </button>
                    <button
                      class="btn-th-toggle"
                      :class="{ active: !inspection.ignore_priority }"
                      @click="toggleIgnore(inspection.type, 'ignore_priority', inspection.ignore_priority)"
                      :title="inspection.ignore_priority ? '우선순위 적용' : '우선순위 무시'"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    </button>
                    <button
                      class="btn-th-toggle btn-th-history"
                      @click="resetHistory(inspection.type)"
                      title="초검/재검 이력 초기화"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in filteredEntries" :key="entry.num">
                <td class="col-num">
                  <div class="team-entry-summary">
                    <div class="team-entry-summary-top">
                      <span class="entry-num">{{ entry.num }}</span>
                      <span v-if="entry.type" class="badge team-mobile-entry-type" :class="'badge-type-' + getTypeColor(entry.type)">{{ entry.type }}</span>
                    </div>
                    <span class="team-mobile-entry-univ">{{ entry.univ }}</span>
                    <span class="team-mobile-entry-name">{{ entry.team }}</span>
                  </div>
                </td>
                <td class="col-team">
                  <span class="entry-name">{{ entry.univ }} {{ entry.team }}</span>
                </td>
                <td class="col-type"><span v-if="entry.type" class="badge" :class="'badge-type-' + getTypeColor(entry.type)">{{ entry.type }}</span></td>
                <td v-for="inspection in inspections" :key="inspection.type" class="col-priority">
                  <input
                    type="number"
                    class="priority-input"
                    :data-inspection="inspection.type"
                    :aria-label="`${entry.num}번 ${inspection.name} 우선순위`"
                    :class="{
                      active: getPriority(entry.num, inspection.type) !== null,
                      reinspection: isReinspection(entry.num, inspection.type),
                      'first-inspection': !isReinspection(entry.num, inspection.type),
                    }"
                    :value="getPriorityInput(entry.num, inspection.type)"
                    placeholder="-"
                    min="0"
                    @input="editPriority(inspection.type, entry.num, $event.target.value)"
                    @change="updatePriority(inspection.type, entry.num, $event.target.value)"
                    @focus="$event.target.select()"
                  />
                </td>
              </tr>
              <tr v-if="filteredEntries.length === 0">
                <td :colspan="3 + inspections.length" class="empty-state">검색 결과가 없습니다.</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.priority-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.back-btn {
  align-self: flex-start;
}

/* Inspection Settings */
.settings-section-header h2 {
  margin: 0;
  font-size: 1.125rem;
}

.settings-section-header p {
  margin: 0.25rem 0 0;
  color: var(--text-secondary);
  font-size: 0.8125rem;
}

.settings-section-body {
  padding: 1rem;
}

.inspection-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}

.inspection-setting-group {
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
}

.inspection-setting-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border-color);
}

.inspection-setting-header h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 1rem;
}

.inspection-code {
  display: block;
  margin-top: 0.125rem;
  color: var(--text-tertiary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.6875rem;
}

.inspection-status {
  flex: none;
  padding: 0.25rem 0.5rem;
  border-radius: 999px;
  background: var(--bg-primary);
  color: var(--text-tertiary);
  font-size: 0.6875rem;
  font-weight: 700;
}

.inspection-status.active {
  background: rgba(34, 197, 94, 0.14);
  color: var(--accent-success);
}

.inspection-buttons {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  margin: 0.75rem 0;
}

.inspection-state-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}

.inspection-state-button:hover {
  border-color: var(--accent-primary);
}

.state-indicator {
  width: 0.625rem;
  height: 0.625rem;
  flex: none;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.inspection-state-button.enabled .state-indicator {
  background: var(--accent-success);
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.14);
}

.state-copy,
.setting-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.125rem;
}

.state-copy strong {
  color: var(--text-primary);
  font-size: 0.8125rem;
}

.state-copy small,
.setting-copy small {
  color: var(--text-tertiary);
  font-size: 0.6875rem;
}

.inspection-setting-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card);
}

.setting-item {
  display: flex;
  min-width: 0;
  min-height: 3.75rem;
  align-items: center;
  justify-content: space-between;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--border-color);
}

.setting-item:nth-child(odd) {
  border-right: 1px solid var(--border-color);
}

.setting-item:nth-last-child(-n + 2) {
  border-bottom: 0;
}

.setting-label {
  color: var(--text-primary);
  font-size: 0.8125rem;
  font-weight: 600;
}

.setting-input {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.setting-input input {
  width: 3.25rem;
  padding: 0.375rem 0.25rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
  text-align: center;
}

.setting-input input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(94, 106, 210, 0.12);
}

.setting-input input::-webkit-outer-spin-button,
.setting-input input::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

/* Rules Banner */
.rules-banner {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem;
}

.rules-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
  font-size: 0.9375rem;
  margin-bottom: 0.75rem;
  color: var(--text-primary);
}

.rules-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
}

.rule-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.rule-number {
  width: 20px;
  height: 20px;
  background: var(--border-color);
  color: var(--text-secondary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.6875rem;
  flex-shrink: 0;
}

.rule-text {
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.rule-text strong {
  color: var(--text-primary);
}

/* Entries Card */
.entries-card {
  display: block;
}

.entries-card .card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.count-badge {
  background: var(--accent-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 12px;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 12px;
  width: 18px;
  height: 18px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.search-input {
  padding: 0.5rem 0.75rem 0.5rem 2.5rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.875rem;
  width: 200px;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.entries-card .card-body {
  overflow: auto;
  padding: 0;
}

/* Table */
.priority-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 600px;
}

.priority-table th,
.priority-table td {
  padding: 0.75rem 1rem;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

.priority-table th {
  background: var(--bg-secondary);
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--text-secondary);
  position: sticky;
  top: 0;
  z-index: 1;
}

.priority-table tbody tr:hover {
  background: var(--bg-hover);
}

.col-num,
.col-team,
.col-type,
.col-priority {
  width: 1%;
  white-space: nowrap;
}

.col-num {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.priority-table thead .col-num {
  z-index: 3;
}

.sticky-host {
  position: relative;
}

.col-num,
.col-type,
.col-priority {
  text-align: center !important;
}

.th-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.th-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  margin-top: 0.375rem;
}

.btn-th-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-th-toggle svg {
  width: 13px;
  height: 13px;
}

.btn-th-toggle:hover {
  background: var(--bg-hover);
}

.btn-th-toggle.active {
  background: var(--accent-primary);
  color: white;
  border-color: var(--accent-primary);
}

.btn-th-toggle.active:hover {
  opacity: 0.85;
}

.btn-th-history:hover {
  color: var(--accent-danger);
  border-color: var(--accent-danger);
}

.btn-reset {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-reset:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--danger);
  border-color: var(--danger);
}

.btn-reset:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.entry-num {
  font-size: 1rem;
}

.entry-name {
  color: var(--text-primary);
  font-size: 0.875rem;
}

.priority-input {
  width: 60px;
  padding: 0.375rem 0.5rem;
  text-align: center;
  border: 2px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.9375rem;
  font-weight: 600;
  font-family: "JetBrains Mono", monospace;
  background: var(--bg-input);
  color: var(--text-primary);
  transition: all 0.2s ease;
}

.priority-input.first-inspection {
  border-color: var(--accent-success);
}

.priority-input.reinspection {
  border-color: var(--accent-warning);
}

.priority-input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
}


.priority-input::placeholder {
  color: var(--text-tertiary);
  font-weight: 400;
}

.priority-input::-webkit-outer-spin-button,
.priority-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* Responsive */
@media (max-width: 768px) {
  .inspection-settings-grid {
    grid-template-columns: 1fr;
  }

  .rules-list {
    flex-direction: column;
    gap: 0.5rem;
  }

  .header-right {
    flex-wrap: wrap;
  }

  .search-input {
    width: 150px;
  }

  .priority-input {
    width: 50px;
    padding: 0.25rem 0.375rem;
    font-size: 0.875rem;
  }
}

@media (max-width: 480px) {
  .settings-section-body {
    padding: 0.75rem;
  }

  .inspection-setting-fields {
    grid-template-columns: 1fr;
  }

  .setting-item:nth-child(odd) {
    border-right: 0;
  }

  .setting-item:nth-last-child(2) {
    border-bottom: 1px solid var(--border-color);
  }
}
</style>
