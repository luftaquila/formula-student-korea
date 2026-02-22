<script setup>
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import { fetchEntries, fetchAllInspections, getStats } from "../api";
import { useNotification } from "../composables/useNotification";

const { error } = useNotification();
const router = useRouter();

const entries = ref({});
const inspections = ref([]);
const statsData = ref([]);
const loading = ref(true);
const fetching = ref(false);

// Filters
const filterFrom = ref("");
const filterTo = ref("");
const filterInspection = ref("");

// Sort
const sortKey = ref("");
const sortAsc = ref(true);

const sortedStats = computed(() => {
  if (!sortKey.value) return statsData.value;
  const key = sortKey.value;
  return [...statsData.value].sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    if (typeof va === "number" && typeof vb === "number") {
      return sortAsc.value ? va - vb : vb - va;
    }
    va = String(va);
    vb = String(vb);
    return sortAsc.value ? va.localeCompare(vb) : vb.localeCompare(va);
  });
});

function toggleSort(key) {
  if (sortKey.value === key) {
    sortAsc.value = !sortAsc.value;
  } else {
    sortKey.value = key;
    sortAsc.value = true;
  }
}

function sortIndicator(key) {
  if (sortKey.value !== key) return "";
  return sortAsc.value ? " ▲" : " ▼";
}

onMounted(async () => {
  try {
    entries.value = await fetchEntries();
    inspections.value = await fetchAllInspections();
    await fetchStats();
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;
});

async function fetchStats() {
  fetching.value = true;
  try {
    const params = {};
    if (filterFrom.value) params.from = new Date(filterFrom.value).getTime();
    if (filterTo.value) params.to = new Date(filterTo.value).getTime();
    if (filterInspection.value) params.inspection = filterInspection.value;
    statsData.value = await getStats(params);
  } catch (e) {
    error("통계를 가져올 수 없습니다.");
  }
  fetching.value = false;
}

function onFilterChange() {
  fetchStats();
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600).toString().padStart(2, "0");
  const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function goBack() {
  router.push("/admin");
}
</script>

<template>
  <div class="stats-page">
    <button class="btn btn-ghost back-btn" @click="goBack">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
        <path d="m15 18-6-6 6-6" />
      </svg>
      돌아가기
    </button>

    <!-- Filters -->
    <div class="filter-bar">
      <div class="filter-group">
        <label class="filter-label">시작</label>
        <input
          type="datetime-local"
          class="filter-input"
          v-model="filterFrom"
          @change="onFilterChange"
        />
      </div>
      <div class="filter-group">
        <label class="filter-label">종료</label>
        <input
          type="datetime-local"
          class="filter-input"
          v-model="filterTo"
          @change="onFilterChange"
        />
      </div>
      <div class="filter-group">
        <label class="filter-label">검차 종류</label>
        <select class="filter-input" v-model="filterInspection" @change="onFilterChange">
          <option value="">전체</option>
          <option v-for="item in inspections" :key="item.type" :value="item.type">
            {{ item.name }}
          </option>
        </select>
      </div>
    </div>

    <!-- Stats Table -->
    <div class="card stats-card">
      <div class="card-header">
        <div class="header-left">
          <h3>팀별 통계</h3>
          <span class="count-badge">{{ statsData.length }}개 팀</span>
        </div>
      </div>
      <div class="card-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
        </div>
        <div v-else class="table-container">
          <table class="stats-table">
            <thead>
              <tr>
                <th class="col-num sortable" @click="toggleSort('num')">
                  번호{{ sortIndicator("num") }}
                </th>
                <th class="col-team sortable" @click="toggleSort('teamName')">
                  팀{{ sortIndicator("teamName") }}
                </th>
                <th class="col-stat sortable" @click="toggleSort('registrations')">
                  등록{{ sortIndicator("registrations") }}
                </th>
                <th class="col-stat sortable" @click="toggleSort('cancellations')">
                  취소{{ sortIndicator("cancellations") }}
                </th>
                <th class="col-stat sortable" @click="toggleSort('entries')">
                  입장{{ sortIndicator("entries") }}
                </th>
                <th class="col-time sortable" @click="toggleSort('totalOccupyTime')">
                  검차 시간{{ sortIndicator("totalOccupyTime") }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in sortedStats" :key="row.num">
                <td class="col-num">
                  <span class="entry-num">{{ row.num }}</span>
                </td>
                <td class="col-team">
                  <span class="entry-name">{{ entries[row.num]?.univ }} {{ entries[row.num]?.team }}</span>
                </td>
                <td class="col-stat">{{ row.registrations }}</td>
                <td class="col-stat">{{ row.cancellations }}</td>
                <td class="col-stat">{{ row.entries }}</td>
                <td class="col-time mono">{{ formatDuration(row.totalOccupyTime) }}</td>
              </tr>
              <tr v-if="sortedStats.length === 0">
                <td colspan="6" class="empty-state">
                  {{ fetching ? "데이터를 불러오는 중..." : "통계 데이터가 없습니다." }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.back-btn {
  align-self: flex-start;
}

/* Filter Bar */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.filter-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.filter-input {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.875rem;
  background: var(--bg-input);
  color: var(--text-primary);
}

.filter-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

/* Stats Card */
.stats-card {
  display: flex;
  flex-direction: column;
}

.stats-card .card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.header-left {
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

.stats-card .card-body {
  overflow: auto;
  flex: 1;
  padding: 0;
}

/* Table */
.table-container {
  overflow-x: auto;
}

.stats-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 600px;
}

.stats-table th,
.stats-table td {
  padding: 0.75rem 1rem;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

.stats-table th {
  background: var(--bg-secondary);
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  position: sticky;
  top: 0;
  z-index: 1;
  white-space: nowrap;
}

.stats-table th.sortable {
  cursor: pointer;
  user-select: none;
}

.stats-table th.sortable:hover {
  color: var(--accent-primary);
}

.stats-table tbody tr:hover {
  background: var(--bg-hover);
}

.col-num {
  width: 70px;
  text-align: center !important;
}

.col-team {
  width: auto;
}

.col-stat {
  width: 80px;
  text-align: center !important;
}

.col-time {
  width: 120px;
  text-align: center !important;
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

.mono {
  font-family: "JetBrains Mono", monospace;
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
@media (max-width: 640px) {
  .filter-bar {
    flex-direction: column;
  }

  .filter-input {
    width: 100%;
  }
}
</style>
