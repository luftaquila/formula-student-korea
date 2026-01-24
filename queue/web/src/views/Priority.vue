<script setup>
import { ref, onMounted, computed, watch } from "vue";
import { useRouter } from "vue-router";
import {
  fetchEntries,
  fetchAllInspections,
  fetchPriorities,
  setPriority,
  removePriority,
  resetAllPriorities,
} from "../api";

const props = defineProps(["showToast"]);
const router = useRouter();

const entries = ref({});
const inspections = ref([]);
const priorities = ref({});
const currentTab = ref("");
const loading = ref(true);
const searchQuery = ref("");

// Convert priorities array to object for easy lookup
const priorityMap = computed(() => {
  const map = {};
  for (const p of Object.values(priorities.value)) {
    map[p.num] = p.priority;
  }
  return map;
});

// Convert entries object to sorted array with priority info
const entriesArray = computed(() => {
  return Object.entries(entries.value)
    .map(([num, data]) => ({
      num: Number(num),
      ...data,
      priority: priorityMap.value[num] || null,
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

// Entries with priority set
const prioritizedEntries = computed(() => {
  return entriesArray.value.filter((e) => e.priority !== null).sort((a, b) => a.priority - b.priority);
});

// Watch tab changes
watch(currentTab, async (newTab) => {
  if (newTab) {
    await refreshPriorities(newTab);
  }
});

onMounted(async () => {
  try {
    entries.value = await fetchEntries();
    inspections.value = await fetchAllInspections();

    if (inspections.value.length > 0) {
      currentTab.value = inspections.value[0].type;
    }
  } catch (e) {
    props.showToast?.("데이터를 가져올 수 없습니다.", "error");
  }
  loading.value = false;
});

async function refreshPriorities(type) {
  try {
    const data = await fetchPriorities(type);
    priorities.value = data.reduce((acc, p) => {
      acc[p.num] = p;
      return acc;
    }, {});
  } catch (e) {
    props.showToast?.("우선순위 정보를 가져올 수 없습니다.", "error");
  }
}

function selectTab(type) {
  currentTab.value = type;
}

async function updatePriority(num, value) {
  const priority = Number(value);

  if (!value || value === "") {
    // Remove priority
    try {
      await removePriority(currentTab.value, num);
      props.showToast?.(`${num}번 우선순위 해제`, "success");
      await refreshPriorities(currentTab.value);
    } catch (e) {
      // Ignore if not exists
    }
    return;
  }

  if (isNaN(priority) || priority < 1) {
    props.showToast?.("우선순위는 1 이상의 숫자여야 합니다.", "error");
    return;
  }

  try {
    await setPriority(currentTab.value, num, priority);
    props.showToast?.(`${num}번 우선순위 ${priority}로 설정`, "success");
    await refreshPriorities(currentTab.value);
  } catch (e) {
    props.showToast?.(e.message, "error");
  }
}

async function resetAll() {
  const inspectionName = inspections.value.find((i) => i.type === currentTab.value)?.name || currentTab.value;
  if (!confirm(`${inspectionName} 검차의 모든 우선순위를 초기화하시겠습니까?`)) return;

  try {
    await resetAllPriorities(currentTab.value);
    props.showToast?.(`${inspectionName} 우선순위를 초기화했습니다.`, "success");
    await refreshPriorities(currentTab.value);
  } catch (e) {
    props.showToast?.(e.message, "error");
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

    <div class="priority-layout">
      <!-- Left: Entry List with Priority Input -->
      <div class="card entries-card">
        <div class="card-header">
          <div class="header-left">
            <h3>팀 목록</h3>
            <span class="count-badge">{{ entriesArray.length }}개 팀</span>
          </div>
          <div class="header-right">
            <button class="btn btn-danger btn-sm" @click="resetAll" :disabled="prioritizedEntries.length === 0">
              전체 초기화
            </button>
            <div class="search-box">
              <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input v-model="searchQuery" type="text" placeholder="검색..." class="search-input" />
            </div>
          </div>
        </div>

        <!-- Inspection Tabs -->
        <div class="tabs-container">
          <div class="tabs">
            <button
              v-for="item in inspections"
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
          <div v-else class="entries-list">
            <div
              v-for="entry in filteredEntries"
              :key="entry.num"
              class="entry-row"
              :class="{ 'has-priority': entry.priority !== null }"
            >
              <div class="entry-info">
                <span class="entry-num">{{ entry.num }}</span>
                <span class="entry-divider">-</span>
                <span class="entry-name">{{ entry.univ }} {{ entry.team }}</span>
              </div>
              <div class="priority-input-wrap">
                <input
                  type="number"
                  class="priority-input"
                  :class="{ active: entry.priority !== null }"
                  :value="entry.priority"
                  placeholder="-"
                  min="1"
                  @change="updatePriority(entry.num, $event.target.value)"
                  @focus="$event.target.select()"
                />
                <span class="priority-label">순위</span>
              </div>
            </div>
            <div v-if="filteredEntries.length === 0" class="empty-state">검색 결과가 없습니다.</div>
          </div>
        </div>
      </div>

      <!-- Right: Priority Summary & Rules -->
      <div class="side-panel">
        <!-- Priority Summary -->
        <div class="card summary-card">
          <div class="card-header">
            <h3>우선순위 설정 현황</h3>
          </div>
          <div class="card-body">
            <div v-if="prioritizedEntries.length === 0" class="empty-state small">설정된 우선순위가 없습니다.</div>
            <div v-else class="priority-list">
              <div v-for="entry in prioritizedEntries" :key="entry.num" class="priority-item">
                <span class="priority-rank">{{ entry.priority }}</span>
                <div class="priority-info">
                  <span class="priority-num">{{ entry.num }}</span>
                  <span class="priority-divider">-</span>
                  <span class="priority-name">{{ entry.univ }} {{ entry.team }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Rules -->
        <div class="card rules-card">
          <div class="card-header">
            <h3>우선순위 규칙</h3>
          </div>
          <div class="card-body">
            <div class="rule-item">
              <span class="rule-number">1</span>
              <div class="rule-content">
                <strong>초검 우선</strong>
                <p>처음 검차받는 팀이 재검 팀보다 먼저</p>
              </div>
            </div>
            <div class="rule-item">
              <span class="rule-number">2</span>
              <div class="rule-content">
                <strong>우선순위 적용</strong>
                <p>같은 그룹 내 낮은 숫자가 먼저</p>
              </div>
            </div>
            <div class="rule-item">
              <span class="rule-number">3</span>
              <div class="rule-content">
                <strong>선착순</strong>
                <p>우선순위 같으면 등록 순서대로</p>
              </div>
            </div>
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
  gap: 1.5rem;
}

.back-btn {
  align-self: flex-start;
}

.priority-layout {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 1.5rem;
  align-items: start;
}

/* Entries Card */
.entries-card {
  max-height: calc(100vh - 200px);
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

.tabs-container {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  flex-shrink: 0;
}

.entries-card .card-body {
  overflow-y: auto;
  flex: 1;
  padding: 0;
}

.entries-list {
  display: flex;
  flex-direction: column;
}

.entry-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.875rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  transition: background 0.15s ease;
}

.entry-row:hover {
  background: var(--bg-hover);
}

.entry-row.has-priority {
  background: rgba(59, 130, 246, 0.05);
}

.entry-row.has-priority:hover {
  background: rgba(59, 130, 246, 0.1);
}

.entry-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.entry-num {
  font-weight: 700;
  font-size: 1.125rem;
  font-family: "JetBrains Mono", monospace;
}

.entry-divider {
  color: var(--text-tertiary);
}

.entry-name {
  color: var(--text-secondary);
  font-size: 0.9375rem;
}

.priority-input-wrap {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.priority-input {
  width: 64px;
  padding: 0.5rem;
  text-align: center;
  border: 2px solid var(--border-color);
  border-radius: 8px;
  font-size: 1rem;
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

.priority-label {
  font-size: 0.8125rem;
  color: var(--text-tertiary);
}

/* Side Panel */
.side-panel {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.summary-card .card-body {
  max-height: 300px;
  overflow-y: auto;
}

.priority-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.priority-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-secondary);
  border-radius: 10px;
}

.priority-rank {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.875rem;
  flex-shrink: 0;
}

.priority-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  flex: 1;
}

.priority-num {
  font-weight: 600;
  font-family: "JetBrains Mono", monospace;
  flex-shrink: 0;
}

.priority-divider {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.priority-name {
  font-size: 0.875rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Rules */
.rules-card .card-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.rule-item {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-secondary);
  border-radius: 10px;
}

.rule-number {
  width: 28px;
  height: 28px;
  background: var(--border-color);
  color: var(--text-secondary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.75rem;
  flex-shrink: 0;
}

.rule-content {
  min-width: 0;
}

.rule-content strong {
  display: block;
  font-size: 0.875rem;
  margin-bottom: 0.125rem;
}

.rule-content p {
  font-size: 0.75rem;
  color: var(--text-tertiary);
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

.empty-state.small {
  padding: 1.5rem;
  font-size: 0.875rem;
}

/* Responsive */
@media (max-width: 1024px) {
  .priority-layout {
    grid-template-columns: 1fr;
  }

  .side-panel {
    flex-direction: row;
  }

  .side-panel > * {
    flex: 1;
  }
}

@media (max-width: 640px) {
  .side-panel {
    flex-direction: column;
  }

  .entry-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .priority-input-wrap {
    align-self: flex-end;
  }

  .header-right {
    flex-wrap: wrap;
  }

  .search-input {
    width: 150px;
  }
}
</style>
