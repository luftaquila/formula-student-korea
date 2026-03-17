<template>
  <div class="logs-page">
    <div class="card">
      <div class="card-header">
        <h3>시스템 로그</h3>
      </div>
      <div class="card-body">
        <!-- Filter Bar -->
        <div class="filter-bar">
          <div class="filter-row">
            <select v-model="filters.service" class="form-select filter-select" @change="fetchLogs(true)">
              <option value="">전체 서비스</option>
              <option v-for="s in serviceList" :key="s" :value="s">{{ s }}</option>
            </select>
            <select v-model="filters.level" class="form-select filter-select" @change="fetchLogs(true)">
              <option value="">전체 레벨</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
            <input v-model="filters.action" type="text" class="form-input filter-input" placeholder="액션 검색"
              @keyup.enter="fetchLogs(true)" />
            <input v-model="filters.actor" type="text" class="form-input filter-input" placeholder="유저 검색"
              @keyup.enter="fetchLogs(true)" />
          </div>
          <div class="filter-row">
            <input v-model="filters.from" type="datetime-local" class="form-input filter-input" @change="fetchLogs(true)" />
            <input v-model="filters.to" type="datetime-local" class="form-input filter-input" @change="fetchLogs(true)" />
            <input v-model="filters.search" type="text" class="form-input filter-input filter-search" placeholder="통합 검색 (액션/대상/상세)"
              @keyup.enter="fetchLogs(true)" />
            <div class="filter-actions">
              <button class="btn btn-primary btn-sm" @click="fetchLogs(true)">검색</button>
              <button class="btn btn-ghost btn-sm" @click="resetFilters">초기화</button>
              <label class="auto-refresh-label">
                <input type="checkbox" v-model="autoRefresh" @change="toggleAutoRefresh" />
                자동 새로고침
              </label>
            </div>
          </div>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="loading-text">로딩 중...</div>

        <!-- Error -->
        <div v-else-if="error" class="error-text">{{ error }}</div>

        <!-- Log Table -->
        <div v-else class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th class="col-time">시간</th>
                <th class="col-shrink">서비스</th>
                <th class="col-shrink">레벨</th>
                <th class="col-action">액션</th>
                <th class="col-actor">유저</th>
                <th class="col-target">대상</th>
                <th>상세</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="logs.length === 0">
                <td colspan="7" class="empty-text">로그가 없습니다.</td>
              </tr>
              <tr v-for="log in logs" :key="`${log._service || log.service}-${log.id}`" :class="{ 'log-warn': log.level === 'warn', 'log-error': log.level === 'error' }">
                <td class="col-time">{{ formatTime(log.timestamp) }}</td>
                <td><span class="badge badge-primary">{{ log._service || filters.service || '?' }}</span></td>
                <td>
                  <span class="badge" :class="levelBadge(log.level)">{{ log.level }}</span>
                </td>
                <td class="col-action">{{ log.action }}</td>
                <td class="col-actor">
                  <template v-if="log.actor_name || log.actor_email">
                    <span v-if="log.actor_name && log.actor_email">{{ log.actor_name }} ({{ log.actor_email }})</span>
                    <span v-else>{{ log.actor_name || log.actor_email }}</span>
                  </template>
                  <span v-else class="text-tertiary">-</span>
                </td>
                <td class="col-target">{{ log.target || '-' }}</td>
                <td class="col-detail">
                  <span v-if="log.detail" class="detail-text" :title="log.detail">{{ truncate(log.detail, 60) }}</span>
                  <span v-else class="text-tertiary">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        <div v-if="!loading && !error && total > 0" class="pagination">
          <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">이전</button>
          <span class="page-info">{{ page }} / {{ totalPages }} ({{ total }}건)</span>
          <button class="btn btn-ghost btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">다음</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { createApiClient } from "@shared/api-base.js";

const api = createApiClient("/auth");
const PAGE_SIZE = 100;

const logs = ref([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref(null);
const autoRefresh = ref(false);
let refreshTimer = null;

const serviceList = ["auth", "entry", "queue", "inspection", "traffic", "score", "documents"];

const filters = reactive({
  service: "",
  level: "",
  action: "",
  actor: "",
  from: "",
  to: "",
  search: "",
});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

function levelBadge(level) {
  if (level === "warn") return "badge-warning";
  if (level === "error") return "badge-danger";
  return "badge-success";
}

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(ts + "Z").toLocaleString("ko-KR");
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

async function fetchLogs(resetPage = false) {
  if (resetPage) page.value = 1;
  loading.value = true;
  error.value = null;

  try {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String((page.value - 1) * PAGE_SIZE));
    if (filters.service) params.set("service", filters.service);
    if (filters.level) params.set("level", filters.level);
    if (filters.action) params.set("action", filters.action);
    if (filters.actor) params.set("actor", filters.actor);
    if (filters.from) params.set("from", new Date(filters.from).toISOString());
    if (filters.to) params.set("to", new Date(filters.to).toISOString());
    if (filters.search) params.set("search", filters.search);

    const res = await api.request(`/api/admin/logs?${params}`);
    const data = await res.json();
    logs.value = data.logs || [];
    total.value = data.total || 0;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  filters.service = "";
  filters.level = "";
  filters.action = "";
  filters.actor = "";
  filters.from = "";
  filters.to = "";
  filters.search = "";
  fetchLogs(true);
}

function goPage(p) {
  page.value = p;
  fetchLogs();
}

function toggleAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (autoRefresh.value) {
    refreshTimer = setInterval(() => fetchLogs(), 10000);
  }
}

onMounted(() => {
  document.querySelector(".app-container").style.setProperty("--layout-max-width", "100%");
  fetchLogs();
});
onUnmounted(() => {
  document.querySelector(".app-container").style.setProperty("--layout-max-width", "1100px");
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.logs-page {
  margin: 0 auto;
}

.filter-bar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.filter-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.filter-select {
  min-width: 120px;
  flex: 0 0 auto;
}

.filter-input {
  min-width: 140px;
  flex: 1;
}

.filter-search {
  flex: 2;
}

.filter-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex: 0 0 auto;
}

.auto-refresh-label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}

.table-wrapper {
  overflow-x: auto;
}

.col-shrink {
  width: 1%;
  white-space: nowrap;
}

.col-time {
  width: 1%;
  white-space: nowrap;
  font-size: 0.8125rem;
  font-family: "JetBrains Mono", monospace;
  color: var(--text-secondary);
}

.col-action {
  width: 1%;
  white-space: nowrap;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
}

.col-actor {
  width: 1%;
  white-space: nowrap;
  font-size: 0.8125rem;
}

.col-target {
  width: 1%;
  white-space: nowrap;
  font-size: 0.8125rem;
}

.col-detail {
  font-size: 0.8125rem;
}

.detail-text {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.75rem;
  color: var(--text-secondary);
  cursor: default;
}

.text-tertiary {
  color: var(--text-tertiary);
}

.log-warn {
  background: rgba(245, 158, 11, 0.05);
}

.log-error {
  background: rgba(239, 68, 68, 0.05);
}

.loading-text,
.error-text,
.empty-text {
  text-align: center;
  padding: 2rem;
  color: var(--text-tertiary);
}

.error-text {
  color: var(--accent-danger);
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 1rem 0 0;
}

.page-info {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .filter-row {
    flex-direction: column;
  }

  .filter-select,
  .filter-input,
  .filter-search {
    width: 100%;
    min-width: unset;
  }

  .filter-actions {
    width: 100%;
    justify-content: space-between;
  }

  .col-actor {
    max-width: 80px;
  }
}
</style>
