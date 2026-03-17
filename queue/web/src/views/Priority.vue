<script setup>
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import {
  fetchEntries,
  fetchAllInspections,
  fetchPriorities,
  setPriority,
  removePriority,
  resetAllPriorities,
  resetInspectionHistory,
  setInspectionIgnore,
} from "../api";
import { useNotification } from "@shared/useNotification.js";

const { success, error } = useNotification();
const router = useRouter();

const entries = ref({});
const inspections = ref([]);
const allPriorities = ref({}); // { inspectionType: { num: priority, ... }, ... }
const loading = ref(true);
const searchQuery = ref("");

// Convert entries object to sorted array
const entriesArray = computed(() => {
  return Object.entries(entries.value)
    .map(([num, data]) => ({
      num: Number(num),
      ...data,
    }))
    .sort((a, b) => a.num - b.num);
});

// Filtered entries based on search
const filteredEntries = computed(() => {
  if (!searchQuery.value.trim()) return entriesArray.value;
  const query = searchQuery.value.toLowerCase();
  return entriesArray.value.filter(
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

// Check if any priority is set for a given inspection type
function hasAnyPriority(type) {
  const priorities = allPriorities.value[type];
  return priorities && Object.keys(priorities).length > 0;
}

onMounted(async () => {
  try {
    entries.value = await fetchEntries();
    inspections.value = await fetchAllInspections();

    // Fetch priorities for all inspection types
    await refreshAllPriorities();
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
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

  if (isNaN(priority) || priority < 1) {
    error("우선순위는 1 이상의 숫자여야 합니다.");
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

    <!-- Inspection Settings -->
    <div class="card settings-card">
      <div class="card-header settings-header">
        <h3>검차별 설정</h3>
        <div class="settings-legend">
          <span class="legend-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            초검/재검
          </span>
          <span class="legend-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            우선순위
          </span>
        </div>
      </div>
      <div class="card-body">
        <div v-for="item in inspections" :key="item.type" class="inspection-config">
          <span class="config-name">{{ item.name }}</span>
          <div class="config-toggles">
            <button
              class="btn-config-toggle"
              :class="{ active: !item.ignore_reinspection }"
              @click="toggleIgnore(item.type, 'ignore_reinspection', item.ignore_reinspection)"
              :title="item.ignore_reinspection ? '초검/재검 적용' : '초검/재검 무시'"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </button>
            <button
              class="btn-config-toggle"
              :class="{ active: !item.ignore_priority }"
              @click="toggleIgnore(item.type, 'ignore_priority', item.ignore_priority)"
              :title="item.ignore_priority ? '우선순위 적용' : '우선순위 무시'"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </button>
          </div>
          <button
            class="btn btn-ghost btn-sm"
            @click="resetHistory(item.type)"
            title="초검/재검 이력 초기화"
          >
            이력 초기화
          </button>
        </div>
      </div>
    </div>

    <!-- Entry Table with Priority Inputs -->
    <div class="card entries-card">
      <div class="card-header">
        <div class="header-left">
          <h3>팀별 우선순위 설정</h3>
          <span class="count-badge">{{ entriesArray.length }}개 팀</span>
        </div>
        <div class="header-right">
          <div class="search-box">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input v-model="searchQuery" type="text" placeholder="검색..." class="search-input" />
          </div>
        </div>
      </div>

      <div class="card-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
        </div>
        <div v-else class="table-container">
          <table class="priority-table">
            <thead>
              <tr>
                <th class="col-num">번호</th>
                <th class="col-team">팀</th>
                <th v-for="inspection in inspections" :key="inspection.type" class="col-priority">
                  <div class="th-content">
                    <span>{{ inspection.name }}</span>
                    <button
                      class="btn-reset"
                      @click="resetAll(inspection.type)"
                      :disabled="!hasAnyPriority(inspection.type)"
                      title="초기화"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        width="14"
                        height="14"
                      >
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    </button>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in filteredEntries" :key="entry.num">
                <td class="col-num">
                  <span class="entry-num">{{ entry.num }}</span>
                </td>
                <td class="col-team">
                  <span class="entry-name">{{ entry.univ }} {{ entry.team }}</span>
                </td>
                <td v-for="inspection in inspections" :key="inspection.type" class="col-priority">
                  <input
                    type="number"
                    class="priority-input"
                    :class="{ active: getPriority(entry.num, inspection.type) !== null }"
                    :value="getPriority(entry.num, inspection.type)"
                    placeholder="-"
                    min="1"
                    @change="updatePriority(inspection.type, entry.num, $event.target.value)"
                    @focus="$event.target.select()"
                  />
                </td>
              </tr>
              <tr v-if="filteredEntries.length === 0">
                <td :colspan="2 + inspections.length" class="empty-state">검색 결과가 없습니다.</td>
              </tr>
            </tbody>
          </table>
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

/* Settings Card */
.settings-card .card-body {
  display: flex;
  flex-direction: column;
  padding-top: 0;
  padding-bottom: 0;
}

.inspection-config {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border-color);
}

.inspection-config:last-child {
  border-bottom: none;
}

.config-name {
  font-weight: 600;
  font-size: 0.875rem;
  min-width: 5rem;
  margin-right: auto;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.settings-legend {
  display: flex;
  gap: 1rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.config-toggles {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.btn-config-toggle {
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

.btn-config-toggle svg {
  width: 16px;
  height: 16px;
}

.btn-config-toggle:hover {
  background: var(--bg-hover);
}

.btn-config-toggle.active {
  background: var(--accent-primary);
  color: white;
  border-color: var(--accent-primary);
}

.btn-config-toggle.active:hover {
  opacity: 0.85;
}

.inspection-config .btn {
  flex-shrink: 0;
}

/* Entries Card */
.entries-card {
  max-height: calc(100vh - 260px);
  display: flex;
  flex-direction: column;
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
  flex: 1;
  padding: 0;
}

/* Table */
.table-container {
  overflow-x: auto;
}

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

.col-num,
.col-priority {
  text-align: center !important;
}

.th-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
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
  font-weight: 700;
  font-size: 1rem;
  font-family: "JetBrains Mono", monospace;
}

.entry-name {
  color: var(--text-secondary);
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

.priority-input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.priority-input.active {
  border-color: var(--accent-primary);
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-primary);
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

/* Loading & Empty */
.loading {
  display: flex;
  justify-content: center;
  padding: 3rem;
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
  padding: 2rem;
}

/* Responsive */
@media (max-width: 768px) {
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
</style>
