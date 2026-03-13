<script setup>
import { ref, onMounted, computed } from "vue";
import { Notyf } from "notyf";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";

const notyf = new Notyf({ duration: 3000, position: { x: "right", y: "top" } });

const users = ref([]);
const loading = ref(true);
const newEmail = ref("");
const newRole = ref("official");

// Check auth from cookie
function getUserFromCookie() {
  const match = document.cookie.match(/fsk_user=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); }
  catch { return null; }
}

const currentUser = getUserFromCookie();

// Redirect if not admin
if (!currentUser || currentUser.role !== "admin") {
  window.location.href = "/auth/login?redirect=/auth";
}

async function fetchUsers() {
  loading.value = true;
  try {
    const res = await fetch(`${BASE_URL}/api/users`);
    if (res.status === 401) {
      window.location.href = `/auth/login?redirect=/auth`;
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    users.value = await res.json();
  } catch (e) {
    notyf.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function addUser() {
  if (!newEmail.value.trim()) {
    notyf.error("이메일을 입력해주세요.");
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail.value.trim(), role: newRole.value }),
    });
    if (!res.ok) throw new Error(await res.text());
    notyf.success("사용자를 추가했습니다.");
    newEmail.value = "";
    await fetchUsers();
  } catch (e) {
    notyf.error(e.message);
  }
}

async function changeRole(user) {
  const nextRole = user.role === "admin" ? "official" : "admin";
  if (!confirm(`${user.email}의 역할을 ${nextRole}(으)로 변경하시겠습니까?`)) return;

  try {
    const res = await fetch(`${BASE_URL}/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: nextRole }),
    });
    if (!res.ok) throw new Error(await res.text());
    notyf.success("역할을 변경했습니다.");
    await fetchUsers();
  } catch (e) {
    notyf.error(e.message);
  }
}

async function deleteUser(user) {
  if (!confirm(`${user.email}을(를) 삭제하시겠습니까?`)) return;

  try {
    const res = await fetch(`${BASE_URL}/api/users/${user.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    notyf.success("사용자를 삭제했습니다.");
    await fetchUsers();
  } catch (e) {
    notyf.error(e.message);
  }
}

// Memo click-to-edit
const editingMemoId = ref(null);

function startMemoEdit(userId) {
  editingMemoId.value = userId;
}

function memoInputRef(el) {
  if (el) el.focus();
}

async function handleMemoChange(user, value) {
  editingMemoId.value = null;
  if (value === (user.memo || "")) return;
  try {
    const res = await fetch(`${BASE_URL}/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memo: value }),
    });
    if (!res.ok) throw new Error(await res.text());
    user.memo = value;
  } catch (e) {
    notyf.error(e.message);
  }
}

const adminCount = computed(() => users.value.filter((u) => u.role === "admin").length);

// Sorting
const sortKey = ref(null);
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

const sortedUsers = computed(() => {
  if (!sortKey.value) return users.value;
  const k = sortKey.value;
  const dir = sortOrder.value === "asc" ? 1 : -1;
  return [...users.value].sort((a, b) => {
    const va = (a[k] || "").toString().toLowerCase();
    const vb = (b[k] || "").toString().toLowerCase();
    return va < vb ? -dir : va > vb ? dir : 0;
  });
});

onMounted(fetchUsers);
</script>

<template>
  <div class="manage-container">
    <div class="add-form card">
      <div class="card-header"><h3>사용자 추가</h3></div>
      <div class="card-body">
        <form @submit.prevent="addUser" class="form-row">
          <input
            v-model="newEmail"
            type="email"
            placeholder="이메일 주소"
            class="form-input"
            required
          />
          <select v-model="newRole" class="form-select">
            <option value="official">Official</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" class="btn btn-primary">추가</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>등록된 사용자 <span class="count-badge">{{ users.length }}</span></h3>
      </div>
      <div class="card-body table-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
        </div>

        <div v-else class="table-container">
          <table class="data-table users-table">
            <thead>
              <tr>
                <th class="col-email sortable" @click="handleSort('email')">이메일 <span class="sort-icon">{{ getSortIcon('email') }}</span></th>
                <th class="col-name sortable" @click="handleSort('name')">이름 <span class="sort-icon">{{ getSortIcon('name') }}</span></th>
                <th class="col-role sortable" @click="handleSort('role')">역할 <span class="sort-icon">{{ getSortIcon('role') }}</span></th>
                <th class="col-memo">메모</th>
                <th class="col-date sortable" @click="handleSort('created_at')">등록일 <span class="sort-icon">{{ getSortIcon('created_at') }}</span></th>
                <th class="col-action">액션</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in sortedUsers" :key="user.id">
                <td class="col-email">{{ user.email }}</td>
                <td class="col-name">{{ user.name || "-" }}</td>
                <td class="col-role">
                  <span class="badge" :class="user.role === 'admin' ? 'badge-danger' : 'badge-primary'">{{ user.role }}</span>
                </td>
                <td class="col-memo memo-cell" @click="startMemoEdit(user.id)">
                  <input
                    v-if="editingMemoId === user.id"
                    :ref="memoInputRef"
                    class="memo-input"
                    type="text"
                    :value="user.memo || ''"
                    @blur="handleMemoChange(user, $event.target.value)"
                    @keyup.enter="$event.target.blur()"
                  />
                  <span v-else class="memo-text">{{ user.memo || '' }}</span>
                </td>
                <td class="col-date">{{ user.created_at ? new Date(user.created_at + 'Z').toLocaleString("ko-KR") : "-" }}</td>
                <td class="col-action">
                  <div class="action-btns">
                    <button
                      class="btn btn-sm btn-outline"
                      @click="changeRole(user)"
                      :disabled="user.role === 'admin' && adminCount <= 1"
                      :title="user.role === 'admin' && adminCount <= 1 ? '마지막 관리자는 강등할 수 없습니다' : ''"
                    >
                      {{ user.role === "admin" ? "Official" : "Admin" }}
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      @click="deleteUser(user)"
                      :disabled="user.role === 'admin' && adminCount <= 1"
                      :title="user.role === 'admin' && adminCount <= 1 ? '마지막 관리자는 삭제할 수 없습니다' : ''"
                    >
                      삭제
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="users.length === 0">
                <td colspan="6" class="empty-state">등록된 사용자가 없습니다.</td>
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
.manage-container {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.form-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.form-row .form-input {
  flex: 1;
}

.form-select {
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.875rem;
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
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

.table-container {
  overflow-x: auto;
}

.users-table {
  width: 100%;
}

.col-email,
.col-name,
.col-role,
.col-date,
.col-action {
  width: 1%;
  white-space: nowrap;
}

.col-email {
  font-size: 0.8125rem;
}

.col-name {
  font-size: 0.8125rem;
}

.col-role {
  text-align: center !important;
}

/* Sortable headers */
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

.col-date {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  font-family: "JetBrains Mono", monospace;
}

/* Memo click-to-edit */
.memo-cell {
  cursor: text;
  min-width: 0;
}

.memo-text {
  display: inline-block;
  min-width: 2em;
  min-height: 1.25em;
}

.memo-cell {
  font-size: 0.8125rem;
}

.memo-input {
  width: 100%;
  padding: 0.25rem 0.5rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.8125rem;
  transition: all 0.2s ease;
}

.memo-input:hover {
  border-color: var(--border-color);
}

.memo-input:focus {
  outline: none;
  background: var(--bg-input);
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

/* Action buttons */
.action-btns {
  display: flex;
  gap: 0.5rem;
}

.empty-state {
  text-align: center;
  color: var(--text-tertiary);
  padding: 2rem;
}

/* Loading */
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
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .form-row {
    flex-direction: column;
  }

  .form-row .form-input,
  .form-select {
    width: 100%;
  }

  .col-date {
    display: none;
  }

  .action-btns {
    flex-direction: column;
  }
}
</style>
