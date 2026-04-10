<script setup>
import { ref, onMounted, computed } from "vue";
import { Notyf } from "notyf";
import { formatPhone } from "@shared/format-phone.js";
import { ROLE_LEVELS } from "@shared/constants.js";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";

const notyf = new Notyf({ duration: 3000, position: { x: "right", y: "top" } });

const users = ref([]);
const loading = ref(true);
const newEmail = ref("");
const newRole = ref("official");

// 운영 오피셜 연락처
const opsContacts = ref([]);
const newOpsName = ref("");
const newOpsPhone = ref("");

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
  window.location.href = "/";
}

async function fetchUsers() {
  loading.value = true;
  try {
    const res = await fetch(`${BASE_URL}/api/users`);
    if (res.status === 401) {
      window.location.href = `/`;
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    users.value = await res.json();
    selectedIds.value = new Set();
  } catch (e) {
    notyf.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function addUser() {
  if (!newEmail.value.trim()) {
    notyf.error("이메일을 입력하세요.");
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

function roleBadgeClass(role) {
  return { student: "badge-success", official: "badge-primary", chief: "badge-warning", admin: "badge-danger" }[role] || "badge-primary";
}

async function changeRole(user, newRole) {
  if (newRole === user.role) return;
  if (!confirm(`${user.email}의 역할을 ${newRole}(으)로 변경하시겠습니까?`)) {
    await fetchUsers();
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok) throw new Error(await res.text());
    notyf.success("역할을 변경했습니다.");
    await fetchUsers();
  } catch (e) {
    notyf.error(e.message);
    await fetchUsers();
  }
}

async function toggleActive(user) {
  const next = !user.active;
  const action = next ? "활성화" : "비활성화";
  if (!confirm(`${user.email}을(를) ${action}하시겠습니까?`)) return;

  try {
    const res = await fetch(`${BASE_URL}/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: next }),
    });
    if (!res.ok) throw new Error(await res.text());
    notyf.success(`${action}했습니다.`);
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

// Filters
const filterRole = ref("all");
const filterActive = ref("all");

const filteredUsers = computed(() => {
  return users.value.filter((u) => {
    if (filterRole.value !== "all" && u.role !== filterRole.value) return false;
    if (filterActive.value === "active" && !u.active) return false;
    if (filterActive.value === "inactive" && u.active) return false;
    return true;
  });
});

// Bulk selection
const selectedIds = ref(new Set());

const allSelected = computed(() => sortedUsers.value.length > 0 && sortedUsers.value.every((u) => selectedIds.value.has(u.id)));

function toggleAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(sortedUsers.value.map((u) => u.id));
  }
}

function toggleOne(id) {
  const s = new Set(selectedIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selectedIds.value = s;
}

// Bulk deactivate
async function bulkDeactivate() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  if (!confirm(`${ids.length}명의 사용자를 비활성화하시겠습니까?`)) return;

  try {
    const res = await fetch(`${BASE_URL}/api/users/bulk`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, active: false }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    notyf.success(`${data.updated}명 비활성화했습니다.`);
    await fetchUsers();
  } catch (e) {
    notyf.error(e.message);
  }
}

// Bulk delete
async function bulkDelete() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  if (!confirm(`${ids.length}명의 사용자를 삭제하시겠습니까?`)) return;

  try {
    const res = await fetch(`${BASE_URL}/api/users/bulk`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    notyf.success(`${data.deleted}명 삭제했습니다.`);
    await fetchUsers();
  } catch (e) {
    notyf.error(e.message);
  }
}

// CSV export
function exportCSV() {
  const header = "email,name,role,memo";
  const rows = users.value.map((u) => [u.email, u.name || "", u.role, u.memo || ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const csv = "\uFEFF" + [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `users_${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// CSV upload
function uploadCSV() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length === 0) { notyf.error("CSV 파일이 비어있습니다."); return; }

    // Detect header row
    let start = 0;
    if (rows[0].some((c) => c.toLowerCase().includes("email"))) start = 1;

    const users = [];
    for (let i = start; i < rows.length; i++) {
      // CSV format: email, name (ignored — set via Google OAuth), role, memo
      const [email, , role, memo] = [rows[i][0], rows[i][1], rows[i][2], rows[i][3]];
      if (!email || !email.trim()) continue;
      users.push({ email: email.trim(), role: role?.trim() || "official", memo: memo?.trim() || "" });
    }

    if (users.length === 0) { notyf.error("추가할 사용자가 없습니다."); return; }

    try {
      const res = await fetch(`${BASE_URL}/api/users/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      let msg = `${data.added}명 추가`;
      if (data.skipped > 0) msg += `, ${data.skipped}명 중복`;
      if (data.errors.length > 0) msg += `, ${data.errors.length}건 오류`;
      notyf.success(msg);
      await fetchUsers();
    } catch (e) {
      notyf.error(e.message);
    }
  };
  input.click();
}

function parseCSV(text) {
  const rows = [];
  let i = 0;
  while (i < text.length) {
    const row = [];
    while (i < text.length) {
      if (text[i] === '"') {
        i++;
        let val = "";
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { val += '"'; i += 2; }
            else { i++; break; }
          } else { val += text[i]; i++; }
        }
        row.push(val);
        if (text[i] === ",") i++;
      } else {
        let val = "";
        while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") { val += text[i]; i++; }
        row.push(val);
        if (text[i] === ",") { i++; continue; }
      }
      if (text[i] === "\r") i++;
      if (text[i] === "\n") { i++; break; }
    }
    if (row.length > 0 && row.some((c) => c.trim())) rows.push(row);
  }
  return rows;
}

// Sorting
const sortKey = ref("role");
const sortOrder = ref("desc");

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
  if (!sortKey.value) return filteredUsers.value;
  const k = sortKey.value;
  const dir = sortOrder.value === "asc" ? 1 : -1;
  return [...filteredUsers.value].sort((a, b) => {
    if (k === "role") {
      return ((ROLE_LEVELS[a.role] || 0) - (ROLE_LEVELS[b.role] || 0)) * dir;
    }
    const va = (a[k] || "").toString().toLowerCase();
    const vb = (b[k] || "").toString().toLowerCase();
    return va < vb ? -dir : va > vb ? dir : 0;
  });
});

async function fetchOpsContacts() {
  try {
    const res = await fetch(`${BASE_URL}/api/ops-contacts`);
    if (res.ok) opsContacts.value = await res.json();
  } catch {}
}

async function addOpsContact() {
  if (!newOpsName.value.trim() || !newOpsPhone.value.trim()) {
    notyf.error("이름과 전화번호를 모두 입력하세요.");
    return;
  }
  try {
    const res = await fetch(`${BASE_URL}/api/ops-contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newOpsName.value, phone: newOpsPhone.value }),
    });
    if (!res.ok) throw new Error(await res.text());
    const contact = await res.json();
    opsContacts.value.push(contact);
    newOpsName.value = "";
    newOpsPhone.value = "";
    notyf.success("연락처를 추가했습니다.");
  } catch (e) {
    notyf.error(e.message);
  }
}



function onOpsPhoneInput(e) {
  newOpsPhone.value = formatPhone(e.target.value);
}

async function deleteOpsContact(id) {
  try {
    const res = await fetch(`${BASE_URL}/api/ops-contacts/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    opsContacts.value = opsContacts.value.filter(c => c.id !== id);
  } catch (e) {
    notyf.error(e.message);
  }
}

onMounted(() => {
  fetchUsers();
  fetchOpsContacts();
});
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
            <option value="student">Student</option>
            <option value="official">Official</option>
            <option value="chief">Chief</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" class="btn btn-primary">추가</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>등록된 사용자 <span class="count-badge">{{ filteredUsers.length }}</span></h3>
        <div class="header-actions">
          <div class="header-filters">
            <select v-model="filterRole" class="filter-select">
              <option value="all">전체 역할</option>
              <option value="admin">Admin</option>
              <option value="chief">Chief</option>
              <option value="official">Official</option>
              <option value="student">Student</option>
            </select>
            <select v-model="filterActive" class="filter-select">
              <option value="all">전체 상태</option>
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
            </select>
          </div>
          <div class="header-btns">
            <button v-if="selectedIds.size > 0" class="btn btn-sm btn-ghost" @click="bulkDeactivate">선택 비활성화 ({{ selectedIds.size }})</button>
            <button v-if="selectedIds.size > 0" class="btn btn-sm btn-danger" @click="bulkDelete">선택 삭제 ({{ selectedIds.size }})</button>
            <button class="btn btn-sm btn-ghost" @click="exportCSV">CSV 내보내기</button>
            <button class="btn btn-sm btn-ghost" @click="uploadCSV">CSV 업로드</button>
          </div>
        </div>
      </div>

      <div class="card-body table-body">
        <div v-if="loading" class="loading">
          <div class="loading-spinner"></div>
        </div>

        <div v-else class="table-container">
          <table class="data-table users-table">
            <thead>
              <tr>
                <th class="col-check"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
                <th class="col-email sortable" @click="handleSort('email')">이메일 <span class="sort-icon">{{ getSortIcon('email') }}</span></th>
                <th class="col-name sortable" @click="handleSort('name')">이름 <span class="sort-icon">{{ getSortIcon('name') }}</span></th>
                <th class="col-role sortable" @click="handleSort('role')">역할 <span class="sort-icon">{{ getSortIcon('role') }}</span></th>
                <th class="col-memo">메모</th>
                <th class="col-date sortable" @click="handleSort('created_at')">등록일 <span class="sort-icon">{{ getSortIcon('created_at') }}</span></th>
                <th class="col-action">액션</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in sortedUsers" :key="user.id" :class="{ 'row-inactive': !user.active }">
                <td class="col-check"><input type="checkbox" :checked="selectedIds.has(user.id)" @change="toggleOne(user.id)" /></td>
                <td class="col-email">{{ user.email }}</td>
                <td class="col-name">{{ user.name || "-" }}</td>
                <td class="col-role">
                  <span class="badge" :class="roleBadgeClass(user.role)">{{ user.role }}</span>
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
                    <select
                      class="role-select"
                      :value="user.role"
                      @change="changeRole(user, $event.target.value)"
                      :disabled="user.protected || (user.role === 'admin' && adminCount <= 1)"
                      :title="user.protected ? '기본 관리자의 역할은 변경할 수 없습니다' : user.role === 'admin' && adminCount <= 1 ? '마지막 관리자는 강등할 수 없습니다' : ''"
                    >
                      <option value="student">Student</option>
                      <option value="official">Official</option>
                      <option value="chief">Chief</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button
                      class="btn btn-sm"
                      :class="user.active ? 'btn-ghost' : 'btn-primary'"
                      @click="toggleActive(user)"
                      :disabled="user.protected"
                      :title="user.protected ? '기본 관리자는 비활성화할 수 없습니다' : ''"
                    >
                      {{ user.active ? "비활성화" : "활성화" }}
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      @click="deleteUser(user)"
                      :disabled="user.protected || (user.role === 'admin' && adminCount <= 1)"
                      :title="user.protected ? '기본 관리자는 삭제할 수 없습니다' : user.role === 'admin' && adminCount <= 1 ? '마지막 관리자는 삭제할 수 없습니다' : ''"
                    >
                      삭제
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="users.length === 0">
                <td colspan="7" class="empty-state">등록된 사용자가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card ops-card">
      <div class="card-header"><h3>운영 오피셜 연락처</h3></div>
      <div v-if="opsContacts.length" class="ops-list">
        <div v-for="c in opsContacts" :key="c.id" class="ops-item">
          <span class="ops-name">{{ c.name }}</span>
          <a :href="'tel:' + c.phone" class="ops-phone">{{ c.phone }}</a>
          <button class="btn btn-sm btn-danger" @click="deleteOpsContact(c.id)">삭제</button>
        </div>
      </div>
      <div class="ops-add-form">
        <form @submit.prevent="addOpsContact" class="form-row ops-form">
          <input v-model="newOpsName" type="text" placeholder="이름" class="form-input" />
          <input :value="newOpsPhone" @input="onOpsPhoneInput" type="tel" placeholder="전화번호" class="form-input" maxlength="13" />
          <button type="submit" class="btn btn-primary">추가</button>
        </form>
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

.header-filters,
.header-btns {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.filter-select {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.75rem;
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
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
}

/* Memo click-to-edit */
.memo-cell {
  cursor: text;
  min-width: 6rem;
  font-size: 0.8125rem;
}

.memo-text {
  display: inline-block;
  min-width: 2em;
  min-height: 1.25em;
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
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
}

/* Action buttons */
.role-select {
  padding: 0.25rem 0.375rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.75rem;
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
}

.action-btns {
  display: flex;
  gap: 0.5rem;
}

.row-inactive {
  opacity: 0.45;
}

/* 운영 오피셜 연락처 */
.ops-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.ops-name {
  font-weight: 600;
  font-size: 0.875rem;
}

.ops-phone {
  font-size: 0.875rem;
  color: var(--accent-primary);
  text-decoration: none;
}

.ops-phone:hover {
  text-decoration: underline;
}

.ops-item .btn {
  margin-left: auto;
}

.ops-add-form {
  padding: 1rem 1.25rem;
}

.ops-form.form-row {
  flex-direction: row;
  margin: 0;
}

@media (max-width: 768px) {
  .form-row {
    flex-direction: column;
  }

  .form-row .form-input,
  .form-select {
    width: 100%;
  }

  .card-header {
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .header-actions {
    flex-direction: column;
    width: 100%;
  }

  .header-filters,
  .header-btns {
    width: 100%;
  }

  .header-filters {
    flex: 1;
  }

  .header-filters .filter-select {
    flex: 1;
  }

}
</style>
