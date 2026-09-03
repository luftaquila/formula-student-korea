<script setup>
import { ref, computed, onMounted } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { parseDbTimestamp } from "@shared/parse-timestamp.js";
import { user, hasPermission } from "@shared/officialsStore.js";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";
const { success, error } = useNotification();

if (!hasPermission("applications.manage")) {
  window.location.href = "/";
}

const applications = ref([]);
const loading = ref(true);
const selectedIds = ref(new Set());
const approveRole = ref("student");
const applicationsOpen = ref(false);

const allSelected = computed(
  () => applications.value.length > 0 && applications.value.every((a) => selectedIds.value.has(a.id)),
);

function toggleAll() {
  selectedIds.value = allSelected.value ? new Set() : new Set(applications.value.map((a) => a.id));
}

function toggleOne(id) {
  const s = new Set(selectedIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selectedIds.value = s;
}

async function fetchApplications(showLoading = false) {
  if (showLoading) loading.value = true;
  try {
    const res = await fetch(`${BASE_URL}/api/applications`);
    if (res.status === 401) { window.location.href = "/"; return; }
    if (!res.ok) throw new Error(await res.text());
    applications.value = await res.json();
    selectedIds.value = new Set();
  } catch (e) {
    error(e.message);
  } finally {
    loading.value = false;
  }
}

async function fetchConfig() {
  try {
    const res = await fetch(`${BASE_URL}/api/apply/config`);
    if (res.ok) applicationsOpen.value = (await res.json()).open;
  } catch { /* noop */ }
}

async function toggleOpen() {
  const next = !applicationsOpen.value;
  try {
    const res = await fetch(`${BASE_URL}/api/applications/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ open: next }),
    });
    if (!res.ok) throw new Error(await res.text());
    applicationsOpen.value = next;
    success(next ? "신청을 받습니다." : "신청을 받지 않습니다.");
  } catch (e) {
    error(e.message);
  }
}

async function approveSelected() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  if (!confirm(`선택한 ${ids.length}건을 ${approveRole.value} 권한으로 계정에 추가할까요?`)) return;
  try {
    const res = await fetch(`${BASE_URL}/api/applications/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, role: approveRole.value }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    let msg = `${data.added}건을 계정에 추가했습니다.`;
    if (data.skipped > 0) msg += ` · ${data.skipped}건은 이미 등록`;
    success(msg);
    await fetchApplications();
  } catch (e) {
    error(e.message);
  }
}

async function deleteSelected() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  if (!confirm(`선택한 ${ids.length}건의 신청을 삭제할까요?`)) return;
  try {
    const res = await fetch(`${BASE_URL}/api/applications`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    success(`${data.deleted}건을 삭제했습니다.`);
    await fetchApplications();
  } catch (e) {
    error(e.message);
  }
}

function fmtDate(s) {
  const d = parseDbTimestamp(s);
  return d ? d.toLocaleString("ko-KR") : "-";
}

// Sorting (mirrors Manage.vue). 전화번호/학교·팀은 정렬 비활성화라 그 헤더는
// handleSort를 호출하지 않는다. 초기엔 정렬 없이 API 순서(id) 그대로.
const sortKey = ref("");
const sortOrder = ref("asc");

function handleSort(key) {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortOrder.value = "asc";
  }
}

function getSortIcon(key) {
  if (sortKey.value !== key) return "↕";
  return sortOrder.value === "asc" ? "↑" : "↓";
}

const sortedApplications = computed(() => {
  if (!sortKey.value) return applications.value;
  const k = sortKey.value;
  const dir = sortOrder.value === "asc" ? 1 : -1;
  return [...applications.value].sort((a, b) => {
    const va = (a[k] || "").toString().toLowerCase();
    const vb = (b[k] || "").toString().toLowerCase();
    return va < vb ? -dir : va > vb ? dir : 0;
  });
});

onMounted(() => {
  fetchApplications(true);
  fetchConfig();
});
</script>

<template>
  <div class="applications-container">
    <div class="page-nav">
      <a href="/" class="btn btn-sm btn-ghost">← 홈</a>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>계정 신청 <span class="count-badge">{{ applications.length }}</span></h3>
        <div class="header-actions">
          <label class="open-toggle">
            <span>신청 받기</span>
            <span class="toggle">
              <input type="checkbox" :checked="applicationsOpen" @change="toggleOpen" />
              <span class="toggle-slider"></span>
            </span>
          </label>
          <select v-model="approveRole" class="role-select">
            <option value="student">Student</option>
            <option value="official">Official</option>
            <option v-if="user?.role === 'admin'" value="admin">Admin</option>
          </select>
          <button class="btn btn-sm btn-primary" :disabled="selectedIds.size === 0" @click="approveSelected">
            선택 계정 추가 ({{ selectedIds.size }})
          </button>
          <button class="btn btn-sm btn-danger" :disabled="selectedIds.size === 0" @click="deleteSelected">
            선택 삭제 ({{ selectedIds.size }})
          </button>
        </div>
      </div>

      <div class="card-body table-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
        </div>

        <div v-else class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th class="col-check"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
                <th class="col-email sortable" @click="handleSort('email')">이메일 <span class="sort-icon">{{ getSortIcon('email') }}</span></th>
                <th class="col-name sortable" @click="handleSort('name')">이름 <span class="sort-icon">{{ getSortIcon('name') }}</span></th>
                <th class="col-realname sortable" @click="handleSort('realname')">실명 <span class="sort-icon">{{ getSortIcon('realname') }}</span></th>
                <th class="col-phone">전화번호</th>
                <th class="col-affiliation">학교/팀</th>
                <th class="col-date sortable" @click="handleSort('created_at')">신청일 <span class="sort-icon">{{ getSortIcon('created_at') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in sortedApplications" :key="a.id">
                <td class="col-check"><input type="checkbox" :checked="selectedIds.has(a.id)" @change="toggleOne(a.id)" /></td>
                <td class="col-email">{{ a.email }}</td>
                <td class="col-name">{{ a.name || "-" }}</td>
                <td class="col-realname">{{ a.realname || "-" }}</td>
                <td class="col-phone">{{ a.phone || "-" }}</td>
                <td class="col-affiliation">{{ a.affiliation || "-" }}</td>
                <td class="col-date">{{ fmtDate(a.created_at) }}</td>
              </tr>
              <tr v-if="applications.length === 0">
                <td colspan="7" class="empty-state">신청 내역이 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@import "@shared/styles/base.css";
</style>

<style scoped>
.applications-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.page-nav {
  display: flex;
}

.card-header {
  display: flex;
  align-items: center;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-left: auto;
}

.open-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  white-space: nowrap;
}

.count-badge {
  background: var(--accent-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 12px;
  margin-left: 0.25rem;
}

.table-body {
  padding: 0 !important;
  overflow: auto;
}

.col-check {
  width: 1%;
  white-space: nowrap;
  text-align: center !important;
}

.col-check input[type="checkbox"] {
  cursor: pointer;
  width: 1rem;
  height: 1rem;
}

.col-email,
.col-name,
.col-realname,
.col-phone,
.col-affiliation,
.col-date {
  width: 1%;
  white-space: nowrap;
  font-size: 0.8125rem;
}

.col-date {
  color: var(--text-secondary);
}

/* Sortable headers (matches Manage.vue) */
.sortable {
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}

.sortable:hover {
  background: var(--bg-hover);
}

.sort-icon {
  display: inline-block;
  width: 1em;
  text-align: center;
  opacity: 0.5;
  font-size: 0.75rem;
}

.role-select {
  padding: 0.25rem 0.375rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.75rem;
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
}

@media (max-width: 768px) {
  .card-header {
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .header-actions {
    flex-direction: column;
    align-items: stretch;
    width: 100%;
  }

  .open-toggle {
    justify-content: space-between;
  }
}
</style>
