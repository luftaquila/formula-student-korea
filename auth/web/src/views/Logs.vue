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
            <div class="multi-select" ref="serviceDropdownRef">
              <div class="multi-select-trigger form-select filter-select" @click="serviceDropdownOpen = !serviceDropdownOpen">
                {{ serviceFilterLabel }}
              </div>
              <div v-if="serviceDropdownOpen" class="multi-select-dropdown">
                <label class="multi-select-item">
                  <input type="checkbox" :checked="filters.services.size === serviceList.length" @change="toggleAllServices" />
                  <span>전체</span>
                </label>
                <div class="multi-select-divider"></div>
                <label class="multi-select-item" v-for="s in serviceList" :key="s">
                  <input type="checkbox" :checked="filters.services.has(s)" @change="toggleService(s)" />
                  <span>{{ s }}</span>
                </label>
              </div>
            </div>
            <div class="multi-select" ref="levelDropdownRef">
              <div class="multi-select-trigger form-select filter-select" @click="levelDropdownOpen = !levelDropdownOpen">
                {{ levelFilterLabel }}
              </div>
              <div v-if="levelDropdownOpen" class="multi-select-dropdown">
                <label class="multi-select-item">
                  <input type="checkbox" :checked="filters.levels.size === levelList.length" @change="toggleAllLevels" />
                  <span>전체</span>
                </label>
                <div class="multi-select-divider"></div>
                <label class="multi-select-item" v-for="l in levelList" :key="l">
                  <input type="checkbox" :checked="filters.levels.has(l)" @change="toggleLevel(l)" />
                  <span>{{ l }}</span>
                </label>
              </div>
            </div>
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
              <tr v-for="log in logs" :key="`${log._service || log.service}-${log.id}`" class="row-clickable" :class="{ 'log-warn': log.level === 'warn', 'log-error': log.level === 'error' }" @click="openDetail(log)">
                <td class="col-time">{{ formatTime(log.timestamp) }}</td>
                <td><span class="badge badge-primary">{{ log._service || '?' }}</span></td>
                <td>
                  <span class="badge" :class="levelBadge(log.level)">{{ log.level }}</span>
                </td>
                <td class="col-action">{{ log.action }}</td>
                <td class="col-actor">{{ formatActor(log) || '-' }}</td>
                <td class="col-target">{{ log.target || '-' }}</td>
                <td class="col-detail">
                  <span v-if="log.detail" class="detail-text">{{ truncate(log.detail, 60) }}</span>
                  <span v-else class="text-tertiary">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination (keyset 커서: 이전 = 커서 스택 pop, 다음 = nextCursor push) -->
        <div v-if="!loading && !error && total > 0" class="pagination">
          <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="goPrev">이전</button>
          <span class="page-info">{{ page }} 페이지 (총 {{ total }}건)</span>
          <button class="btn btn-ghost btn-sm" :disabled="!hasMore" @click="goNext">다음</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Log Detail Modal -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="selectedLog" class="modal-overlay" @click.self="closeDetail">
        <div class="modal-box">
          <div class="modal-header">
            <span class="modal-title">로그 상세</span>
            <button class="modal-close" @click="closeDetail">✕</button>
          </div>
          <div class="modal-body">
            <div class="modal-row">
              <span class="modal-label">시간</span>
              <span class="modal-value">{{ formatTime(selectedLog.timestamp) }}</span>
            </div>
            <div class="modal-row">
              <span class="modal-label">서비스</span>
              <span class="modal-value"><span class="badge badge-primary">{{ selectedLog._resolvedService }}</span></span>
            </div>
            <div class="modal-row">
              <span class="modal-label">레벨</span>
              <span class="modal-value"><span class="badge" :class="levelBadge(selectedLog.level)">{{ selectedLog.level }}</span></span>
            </div>
            <div class="modal-row">
              <span class="modal-label">액션</span>
              <span class="modal-value mono">{{ selectedLog.action }}</span>
            </div>
            <div class="modal-row">
              <span class="modal-label">유저</span>
              <span class="modal-value">
{{ formatActor(selectedLog) || '-' }}
              </span>
            </div>
            <div class="modal-row">
              <span class="modal-label">대상</span>
              <span class="modal-value">{{ selectedLog.target || '-' }}</span>
            </div>
            <div v-if="selectedLog.detail" class="modal-row modal-row-detail">
              <span class="modal-label">상세</span>
              <pre class="modal-detail">{{ selectedLog.detail }}</pre>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { createApiClient } from "@shared/api-base.js";
import { parseDbTimestamp } from "@shared/parse-timestamp.js";
import { SERVICE_NAMES } from "@shared/service-names.js";

const api = createApiClient("/auth");
const PAGE_SIZE = 100;

const selectedLog = ref(null);

function openDetail(log) {
  selectedLog.value = { ...log, _resolvedService: log._service || '?' };
}

function closeDetail() {
  selectedLog.value = null;
}

const logs = ref([]);
const total = ref(0);
// 커서 스택: 스택의 각 항목은 "그 페이지를 가져올 때 쓴 커서 토큰". 페이지 1은 커서 없음
// (빈 스택). 다음 = nextCursor push 후 fetch, 이전 = pop 후 fetch. keyset 커서는 삽입에
// 안정적이라(새 행은 항상 더 큰 키) 뒤 페이지가 밀리지 않는다.
const cursorStack = ref([]);
const nextCursor = ref(null);
const hasMore = ref(false);
const page = computed(() => cursorStack.value.length + 1);
const loading = ref(false);
const error = ref(null);
const autoRefresh = ref(false);
let refreshTimer = null;

const serviceDropdownOpen = ref(false);
const levelDropdownOpen = ref(false);
const serviceDropdownRef = ref(null);
const levelDropdownRef = ref(null);

// 집계 대상과 같은 레지스트리에서 온다(auth 포함 — 자기 로그는 로컬 조회). 손으로 적은
// 목록을 두면 SERVICE_URLS에 키를 추가했을 때 집계만 늘고 필터에는 안 나타난다.
const serviceList = SERVICE_NAMES;
const levelList = ["info", "warn", "error"];

const filters = reactive({
  services: new Set(serviceList),
  levels: new Set(levelList),
  action: "",
  actor: "",
  from: "",
  to: "",
  search: "",
});

const serviceFilterLabel = computed(() => {
  if (filters.services.size === serviceList.length) return "전체 서비스";
  if (filters.services.size === 0) return "서비스 선택";
  return `서비스 ${filters.services.size}개`;
});

const levelFilterLabel = computed(() => {
  if (filters.levels.size === levelList.length) return "전체 레벨";
  if (filters.levels.size === 0) return "레벨 선택";
  return [...filters.levels].join(", ");
});

function toggleService(s) {
  if (filters.services.has(s)) filters.services.delete(s);
  else filters.services.add(s);
  fetchLogs(true);
}

function toggleAllServices() {
  if (filters.services.size === serviceList.length) filters.services.clear();
  else serviceList.forEach(s => filters.services.add(s));
  fetchLogs(true);
}

function toggleLevel(l) {
  if (filters.levels.has(l)) filters.levels.delete(l);
  else filters.levels.add(l);
  fetchLogs(true);
}

function toggleAllLevels() {
  if (filters.levels.size === levelList.length) filters.levels.clear();
  else levelList.forEach(l => filters.levels.add(l));
  fetchLogs(true);
}

function levelBadge(level) {
  if (level === "warn") return "badge-warning";
  if (level === "error") return "badge-danger";
  return "badge-success";
}

function formatTime(ts) {
  const d = parseDbTimestamp(ts);
  return d ? d.toLocaleString("ko-KR") : "-";
}

function formatActor(log) {
  if (log.actor_name && log.actor_email) return `${log.actor_name} (${log.actor_email})`;
  return log.actor_name || log.actor_email || null;
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

async function fetchLogs(resetPage = false) {
  if (resetPage) cursorStack.value = [];
  if (filters.services.size === 0 || filters.levels.size === 0) {
    logs.value = [];
    total.value = 0;
    nextCursor.value = null;
    hasMore.value = false;
    return;
  }

  loading.value = true;
  error.value = null;

  try {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    const cursor = cursorStack.value[cursorStack.value.length - 1];
    if (cursor) params.set("cursor", cursor);
    if (filters.services.size > 0 && filters.services.size < serviceList.length) {
      params.set("service", [...filters.services].join(","));
    }
    if (filters.levels.size > 0 && filters.levels.size < levelList.length) {
      params.set("level", [...filters.levels].join(","));
    }
    if (filters.action) params.set("action", filters.action);
    if (filters.actor) params.set("actor", filters.actor);
    if (filters.from) params.set("from", new Date(filters.from).toISOString());
    if (filters.to) params.set("to", new Date(filters.to).toISOString());
    if (filters.search) params.set("search", filters.search);

    const res = await api.request(`/api/admin/logs?${params}`);
    const data = await res.json();
    logs.value = data.logs || [];
    total.value = data.total || 0;
    nextCursor.value = data.nextCursor || null;
    hasMore.value = !!data.hasMore;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  filters.services.clear();
  serviceList.forEach(s => filters.services.add(s));
  filters.levels.clear();
  levelList.forEach(l => filters.levels.add(l));
  filters.action = "";
  filters.actor = "";
  filters.from = "";
  filters.to = "";
  filters.search = "";
  fetchLogs(true);
}

function goNext() {
  if (!nextCursor.value) return;
  cursorStack.value.push(nextCursor.value);
  fetchLogs();
}

function goPrev() {
  if (cursorStack.value.length === 0) return;
  cursorStack.value.pop();
  fetchLogs();
}

function toggleAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (autoRefresh.value) {
    // 새 로그는 1페이지(커서 없음)에만 나타나므로 깊은 페이지에서는 갱신을 건너뛴다 —
    // keyset 커서라 깊은 페이지 내용은 어차피 변하지 않는다.
    refreshTimer = setInterval(() => {
      if (cursorStack.value.length === 0) fetchLogs();
    }, 10000);
  }
}

function onKeydown(e) {
  if (selectedLog.value && e.key === "Escape") closeDetail();
}

function onClickOutside(e) {
  if (serviceDropdownRef.value && !serviceDropdownRef.value.contains(e.target)) {
    serviceDropdownOpen.value = false;
  }
  if (levelDropdownRef.value && !levelDropdownRef.value.contains(e.target)) {
    levelDropdownOpen.value = false;
  }
}

onMounted(() => {
  document.querySelector(".app-container").style.setProperty("--layout-max-width", "100%");
  window.addEventListener("keydown", onKeydown);
  document.addEventListener("click", onClickOutside);
  fetchLogs();
});
onUnmounted(() => {
  document.querySelector(".app-container").style.setProperty("--layout-max-width", "1100px");
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("click", onClickOutside);
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.logs-page {
  margin: 0 auto;
}

.logs-page .card {
  overflow: visible;
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

.multi-select {
  position: relative;
  min-width: 120px;
  flex: 0 0 auto;
}

.multi-select-trigger {
  cursor: pointer;
  user-select: none;
}

.multi-select-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 100;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  margin-top: 0.25rem;
  min-width: 100%;
  padding: 0.25rem 0;
}

.multi-select-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  cursor: pointer;
  font-size: 0.875rem;
  white-space: nowrap;
}

.multi-select-item:hover {
  background: var(--bg-hover);
}

.multi-select-divider {
  height: 1px;
  background: var(--border-color);
  margin: 0.25rem 0;
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
}

.row-clickable {
  cursor: pointer;
}

.row-clickable:hover {
  background: var(--bg-hover) !important;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.modal-box {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  width: 100%;
  max-width: 640px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  font-weight: 600;
  font-size: 1rem;
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-tertiary);
  font-size: 1rem;
  cursor: pointer;
  padding: 0.25rem;
  line-height: 1;
}

.modal-close:hover {
  color: var(--text-primary);
}

.modal-body {
  padding: 1rem 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.modal-row {
  display: flex;
  gap: 1rem;
  align-items: baseline;
}

.modal-row-detail {
  align-items: flex-start;
}

.modal-label {
  font-size: 0.8125rem;
  color: var(--text-tertiary);
  min-width: 4rem;
  flex-shrink: 0;
}

.modal-value {
  font-size: 0.875rem;
  color: var(--text-primary);
  word-break: break-all;
}

.modal-value.mono {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
}

.modal-detail {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  background: var(--bg-secondary);
  border-radius: 0.375rem;
  padding: 0.75rem;
  flex: 1;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.15s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
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

  .multi-select,
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

}
</style>
