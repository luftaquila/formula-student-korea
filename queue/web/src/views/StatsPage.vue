<script setup>
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import { fetchEntries, fetchAllInspections, getStats, getTeamStats } from "../api";
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

// Timeline detail
const expandedTeam = ref(null);
const teamTimeline = ref([]);
const timelineLoading = ref(false);

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
  expandedTeam.value = null;
  teamTimeline.value = [];
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

function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${M}/${D} ${h}:${m}:${s}`;
}

function inspectionName(type) {
  const found = inspections.value.find((i) => i.type === type);
  return found ? found.name : type;
}

async function toggleTeamDetail(num) {
  if (expandedTeam.value === num) {
    expandedTeam.value = null;
    teamTimeline.value = [];
    return;
  }
  expandedTeam.value = num;
  timelineLoading.value = true;
  try {
    const params = {};
    if (filterFrom.value) params.from = new Date(filterFrom.value).getTime();
    if (filterTo.value) params.to = new Date(filterTo.value).getTime();
    if (filterInspection.value) params.inspection = filterInspection.value;
    const data = await getTeamStats(num, params);
    teamTimeline.value = data.timeline;
  } catch (e) {
    error("타임라인을 가져올 수 없습니다.");
    teamTimeline.value = [];
  }
  timelineLoading.value = false;
}

const eventLabels = {
  register: "등록",
  enter: "입차",
  exit: "출차",
  cancel: "취소",
};

function eventLabel(event) {
  return eventLabels[event] || event;
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
              <template v-for="row in sortedStats" :key="row.num">
                <tr
                  class="clickable-row"
                  :class="{ 'expanded-row': expandedTeam === row.num }"
                  @click="toggleTeamDetail(row.num)"
                >
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
                <!-- Timeline detail row -->
                <tr v-if="expandedTeam === row.num" class="detail-row">
                  <td colspan="6">
                    <div class="timeline-section">
                      <div class="timeline-header">
                        <h4>
                          #{{ row.num }} {{ entries[row.num]?.univ }} {{ entries[row.num]?.team }} 타임라인
                        </h4>
                        <button class="btn btn-ghost btn-sm" @click.stop="toggleTeamDetail(row.num)">닫기</button>
                      </div>
                      <div v-if="timelineLoading" class="loading">
                        <div class="loading-spinner"></div>
                      </div>
                      <div v-else-if="teamTimeline.length === 0" class="timeline-empty">
                        타임라인 데이터가 없습니다.
                      </div>
                      <div v-else class="timeline-list">
                        <div v-for="(evt, idx) in teamTimeline" :key="idx" class="timeline-event">
                          <span class="timeline-event-time mono">{{ formatTime(evt.timestamp) }}</span>
                          <span class="timeline-event-badge" :class="`event-${evt.event}`">{{ eventLabel(evt.event) }}</span>
                          <span class="timeline-event-info">
                            <span class="timeline-event-type">{{ inspectionName(evt.inspection) }}</span>
                            <span v-if="evt.event === 'enter' && evt.boothNum" class="timeline-event-booth">{{ inspectionName(evt.inspection) }}{{ evt.boothNum }}</span>
                            <span v-if="evt.duration" class="timeline-event-duration mono">{{ formatDuration(evt.duration) }}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
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

/* Clickable Rows */
.clickable-row {
  cursor: pointer;
  transition: background 0.15s;
}

.clickable-row:hover {
  background: var(--bg-hover);
}

.expanded-row {
  background: var(--bg-secondary);
}

.expanded-row:hover {
  background: var(--bg-secondary);
}

/* Detail Row */
.detail-row td {
  padding: 0 !important;
  border-bottom: 1px solid var(--border-color);
}

.detail-row:hover {
  background: none !important;
}

/* Timeline Section */
.timeline-section {
  padding: 1rem 1.25rem;
  background: var(--bg-secondary);
}

.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.timeline-header h4 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
}

.btn-sm {
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
}

.timeline-empty {
  color: var(--text-tertiary);
  text-align: center;
  padding: 1.5rem 0;
}

/* Timeline List */
.timeline-list {
  display: flex;
  flex-direction: column;
}

.timeline-event {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border-color);
}

.timeline-event:last-child {
  border-bottom: none;
}

.timeline-event-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 6px;
  flex-shrink: 0;
  min-width: 3rem;
  text-align: center;
}

.event-register {
  background: rgba(59, 130, 246, 0.15);
  color: var(--accent-primary);
}

.event-enter {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
}

.event-exit {
  background: rgba(245, 158, 11, 0.15);
  color: var(--accent-warning, #f59e0b);
}

.event-cancel {
  background: rgba(239, 68, 68, 0.15);
  color: var(--accent-danger);
}

.timeline-event-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.timeline-event-type {
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.timeline-event-booth {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.timeline-event-duration {
  font-size: 0.75rem;
  color: var(--accent-warning, #f59e0b);
}

.timeline-event-time {
  font-size: 0.8125rem;
  flex-shrink: 0;
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
