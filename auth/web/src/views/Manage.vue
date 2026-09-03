<script setup>
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { formatPhone } from "@shared/format-phone.js";
import { ROLE_SORT_ORDER } from "@shared/constants.js";
import { parseDbTimestamp } from "@shared/parse-timestamp.js";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";

const { notyf } = useNotification();

const applyUrl = `${window.location.origin}${import.meta.env.PROD ? "/auth/apply" : "/apply"}`;

async function copyApplyUrl() {
  try {
    await navigator.clipboard.writeText(applyUrl);
    notyf.success("신청자 URL을 복사했습니다.");
  } catch {
    notyf.error("복사하지 못했습니다.");
  }
}

const users = ref([]);
const accessCatalog = ref({ permissions: [], accessControls: [] });
const loading = ref(true);
const newEmail = ref("");
const newRole = ref("official");

// 운영 오피셜 연락처 (사이드바 표시)
const opsDisplayIds = ref(new Set());
const opsDescriptions = ref(new Map());
const opsDisplayOrder = ref([]);
const opsOrderSaving = ref(false);
const opsDragUserId = ref(null);
const editingOpsDescriptionId = ref(null);
const opsDropdownOpen = ref(false);
const opsDropdownSearch = ref("");
const opsDropdownStyle = ref({});

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

function formatTimestamp(value) {
  const d = parseDbTimestamp(value);
  return d ? d.toLocaleString("ko-KR") : "-";
}

async function fetchUsers(showLoading = false) {
  if (showLoading) loading.value = true;
  try {
    const res = await fetch(`${BASE_URL}/api/users`);
    if (res.status === 401) {
      window.location.href = `/`;
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    users.value = await res.json();
    selectedIds.value = new Set();
    await fetchOpsDisplay();
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
  return { student: "badge-success", official: "badge-primary", admin: "badge-danger" }[role] || "badge-primary";
}

const editingAccessUser = ref(null);
const selectedGrants = ref(new Set());
const accessSaving = ref(false);

function accessLevel(control) {
  if (selectedGrants.value.has(control.manage.key)) return "manage";
  if (selectedGrants.value.has(control.operate.key)) return "operate";
  return "none";
}

function setAccessLevel(control, level) {
  const next = new Set(selectedGrants.value);
  next.delete(control.operate.key);
  next.delete(control.manage.key);
  if (level === "operate") next.add(control.operate.key);
  if (level === "manage") next.add(control.manage.key);
  selectedGrants.value = next;
}

function toggleAccess(control, checked) {
  const next = new Set(selectedGrants.value);
  if (checked) next.add(control.permission);
  else next.delete(control.permission);
  selectedGrants.value = next;
}

function editAccess(user) {
  editingAccessUser.value = user;
  selectedGrants.value = new Set(user.grants || []);
}

async function saveAccess() {
  const target = editingAccessUser.value;
  if (!target || accessSaving.value) return;
  accessSaving.value = true;
  try {
    const res = await fetch(`${BASE_URL}/api/users/${target.id}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: target.accessRevision,
        grants: [...selectedGrants.value],
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.code === "ACCESS_STALE_WRITE") throw new Error("다른 관리자가 먼저 권한을 변경했습니다. 다시 확인하세요.");
      throw new Error(body?.message || "권한을 저장하지 못했습니다.");
    }
    notyf.success("서비스 권한을 변경했습니다.");
    editingAccessUser.value = null;
    await fetchUsers();
  } catch (e) {
    notyf.error(e.message);
    await fetchUsers();
  } finally {
    accessSaving.value = false;
  }
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

// Realname / Phone / Affiliation click-to-edit
const editingRealnameId = ref(null);
const editingPhoneId = ref(null);
const editingAffiliationId = ref(null);

function startRealnameEdit(userId) {
  editingRealnameId.value = userId;
}

function startPhoneEdit(userId) {
  editingPhoneId.value = userId;
}

function startAffiliationEdit(userId) {
  editingAffiliationId.value = userId;
}

function inlineInputRef(el) {
  if (el) el.focus();
}

async function handleRealnameChange(user, value) {
  editingRealnameId.value = null;
  if (value === (user.realname || "")) return;
  try {
    const res = await fetch(`${BASE_URL}/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ realname: value }),
    });
    if (!res.ok) throw new Error(await res.text());
    user.realname = value;
  } catch (e) {
    notyf.error(e.message);
  }
}

async function handlePhoneChange(user, value) {
  editingPhoneId.value = null;
  const formatted = formatPhone(value);
  if (formatted === (user.phone || "")) return;
  try {
    const res = await fetch(`${BASE_URL}/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: formatted }),
    });
    if (!res.ok) throw new Error(await res.text());
    user.phone = formatted;
  } catch (e) {
    notyf.error(e.message);
  }
}

async function handleAffiliationChange(user, value) {
  editingAffiliationId.value = null;
  if (value === (user.affiliation || "")) return;
  try {
    const res = await fetch(`${BASE_URL}/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ affiliation: value }),
    });
    if (!res.ok) throw new Error(await res.text());
    user.affiliation = value;
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

// CSV 셀: 수식 인젝션 방지 — =,+,-,@,tab,CR로 시작하는 값(신청자 제출 realname/affiliation 등)은
// 앞에 텍스트 마커(')를 붙여 Excel/Sheets가 수식으로 실행하지 않게 한다.
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// CSV export
function exportCSV() {
  const header = "email,name,role,realname,phone,affiliation,grants";
  const rows = users.value.map((u) => [
    u.email, u.name || "", u.role, u.realname || "", u.phone || "", u.affiliation || "",
    (u.grants || []).join(";"),
  ].map(csvCell).join(","));
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
      // CSV format: email, name (ignored — set via Google OAuth), role, realname, phone, affiliation
      const [email, , role, realname, phone, affiliation, grants = ""] = rows[i];
      if (!email || !email.trim()) continue;
      users.push({
        email: email.trim(), role: role?.trim() || "official", realname: realname?.trim() || "",
        phone: phone?.trim() || "", affiliation: affiliation?.trim() || "",
        grants: grants.split(";").map((v) => v.trim()).filter(Boolean),
      });
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
      return ((ROLE_SORT_ORDER[a.role] || 0) - (ROLE_SORT_ORDER[b.role] || 0)) * dir;
    }
    const va = (a[k] || "").toString().toLowerCase();
    const vb = (b[k] || "").toString().toLowerCase();
    return va < vb ? -dir : va > vb ? dir : 0;
  });
});

// 운영 연락처 후보는 사람 운영 계정으로 제한한다.
const officialUsers = computed(() =>
  users.value.filter((u) => u.active && ["official", "admin"].includes(u.role)),
);

async function fetchOpsDisplay() {
  try {
    const res = await fetch(`${BASE_URL}/api/ops-contacts`);
    if (res.ok) {
      const data = await res.json();
      opsDisplayIds.value = new Set(data.map((d) => d.id));
      opsDescriptions.value = new Map(data.map((d) => [d.id, d.description || ""]));
      opsDisplayOrder.value = data.map((d) => d.id);
    }
  } catch {}
}

// 추가 가능한 운영 사용자 (이미 표시 중인 사용자 제외)
const opsFilteredUsers = computed(() => {
  const q = opsDropdownSearch.value.toLowerCase();
  return officialUsers.value.filter((u) => {
    if (opsDisplayIds.value.has(u.id)) return false;
    if (!q) return true;
    return u.email.toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q) || (u.realname || "").toLowerCase().includes(q);
  });
});

// 현재 표시 중인 사용자 상세 목록
const opsDisplayUsers = computed(() =>
  opsDisplayOrder.value
    .map((id) => users.value.find((u) => u.id === id))
    .filter(Boolean)
    .map((u) => ({ ...u, opsDescription: opsDescriptions.value.get(u.id) || "" })),
);

let opsDragPointerId = null;
let opsDragStartOrder = [];
let opsDragPointerX = 0;
let opsDragPointerY = 0;
let opsDragScrollFrame = null;
let opsDragHandle = null;

function ordersMatch(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function reorderOpsDisplayAtPoint(clientX, clientY) {
  const targetRow = document.elementFromPoint(clientX, clientY)?.closest("tr[data-ops-contact-id]");
  if (!targetRow || !opsDragUserId.value) return;

  const targetId = Number(targetRow.dataset.opsContactId);
  const fromIndex = opsDisplayOrder.value.indexOf(opsDragUserId.value);
  const toIndex = opsDisplayOrder.value.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

  const nextOrder = [...opsDisplayOrder.value];
  const [movedId] = nextOrder.splice(fromIndex, 1);
  nextOrder.splice(toIndex, 0, movedId);
  opsDisplayOrder.value = nextOrder;
}

function stopOpsDragAutoScroll() {
  if (opsDragScrollFrame !== null) cancelAnimationFrame(opsDragScrollFrame);
  opsDragScrollFrame = null;
}

function scheduleOpsDragAutoScroll() {
  if (opsDragScrollFrame !== null || !opsDragUserId.value) return;
  opsDragScrollFrame = requestAnimationFrame(() => {
    opsDragScrollFrame = null;
    if (!opsDragUserId.value) return;

    const edgeSize = Math.min(80, window.innerHeight * 0.15);
    let scrollAmount = 0;
    if (opsDragPointerY < edgeSize) {
      scrollAmount = -Math.ceil(((edgeSize - opsDragPointerY) / edgeSize) * 14);
    } else if (opsDragPointerY > window.innerHeight - edgeSize) {
      scrollAmount = Math.ceil(((opsDragPointerY - (window.innerHeight - edgeSize)) / edgeSize) * 14);
    }

    if (scrollAmount !== 0) {
      window.scrollBy(0, scrollAmount);
      reorderOpsDisplayAtPoint(opsDragPointerX, opsDragPointerY);
      scheduleOpsDragAutoScroll();
    }
  });
}

function removeOpsDragListeners() {
  window.removeEventListener("pointermove", handleOpsDrag);
  window.removeEventListener("pointerup", finishOpsDrag);
  window.removeEventListener("pointercancel", cancelOpsDrag);
}

function startOpsDrag(event, userId) {
  if (opsOrderSaving.value || opsDragUserId.value || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  closeOpsDropdown();
  opsDragUserId.value = userId;
  opsDragPointerId = event.pointerId;
  opsDragStartOrder = [...opsDisplayOrder.value];
  opsDragPointerX = event.clientX;
  opsDragPointerY = event.clientY;
  opsDragHandle = event.currentTarget;
  opsDragHandle.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", handleOpsDrag, { passive: false });
  window.addEventListener("pointerup", finishOpsDrag);
  window.addEventListener("pointercancel", cancelOpsDrag);
}

function handleOpsDrag(event) {
  if (event.pointerId !== opsDragPointerId || !opsDragUserId.value) return;
  event.preventDefault();
  opsDragPointerX = event.clientX;
  opsDragPointerY = event.clientY;
  reorderOpsDisplayAtPoint(event.clientX, event.clientY);
  scheduleOpsDragAutoScroll();
}

function resetOpsDrag() {
  stopOpsDragAutoScroll();
  removeOpsDragListeners();
  opsDragUserId.value = null;
  opsDragPointerId = null;
  opsDragStartOrder = [];
  opsDragHandle = null;
}

async function persistOpsDisplayOrder(previousOrder) {
  const nextOrder = [...opsDisplayOrder.value];
  opsOrderSaving.value = true;

  try {
    const res = await fetch(`${BASE_URL}/api/ops-contacts/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_ids: nextOrder }),
    });
    if (!res.ok) throw new Error(await res.text());
  } catch (e) {
    opsDisplayOrder.value = previousOrder;
    notyf.error(e.message);
    await fetchOpsDisplay();
  } finally {
    opsOrderSaving.value = false;
  }
}

async function finishOpsDrag(event) {
  if (event.pointerId !== opsDragPointerId || !opsDragUserId.value) return;
  if (opsDragHandle?.hasPointerCapture(event.pointerId)) opsDragHandle.releasePointerCapture(event.pointerId);
  const previousOrder = opsDragStartOrder;
  const changed = !ordersMatch(previousOrder, opsDisplayOrder.value);
  resetOpsDrag();
  if (changed) await persistOpsDisplayOrder(previousOrder);
}

function cancelOpsDrag(event) {
  if (event.pointerId !== opsDragPointerId || !opsDragUserId.value) return;
  opsDisplayOrder.value = opsDragStartOrder;
  resetOpsDrag();
}

function startOpsDescriptionEdit(userId) {
  editingOpsDescriptionId.value = userId;
}

async function handleOpsDescriptionChange(user, value) {
  editingOpsDescriptionId.value = null;
  const description = value.trim();
  if (description === user.opsDescription) return;

  try {
    const res = await fetch(`${BASE_URL}/api/ops-contacts/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const descriptions = new Map(opsDescriptions.value);
    descriptions.set(user.id, data.description);
    opsDescriptions.value = descriptions;
  } catch (e) {
    notyf.error(e.message);
  }
}

function openOpsDropdown(event) {
  opsDropdownOpen.value = true;
  opsDropdownSearch.value = "";
  const rect = event.currentTarget.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const style = { left: `${rect.left}px`, width: `${rect.width}px` };
  if (spaceBelow < 220) {
    style.bottom = `${window.innerHeight - rect.top + 4}px`;
  } else {
    style.top = `${rect.bottom + 4}px`;
  }
  opsDropdownStyle.value = style;
}

function closeOpsDropdown() {
  opsDropdownOpen.value = false;
}

async function addOpsDisplay(user) {
  opsDropdownOpen.value = false;
  try {
    const res = await fetch(`${BASE_URL}/api/ops-contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id }),
    });
    if (!res.ok) throw new Error(await res.text());
    const s = new Set(opsDisplayIds.value);
    s.add(user.id);
    opsDisplayIds.value = s;
    if (!opsDisplayOrder.value.includes(user.id)) opsDisplayOrder.value = [...opsDisplayOrder.value, user.id];
    const descriptions = new Map(opsDescriptions.value);
    descriptions.set(user.id, "");
    opsDescriptions.value = descriptions;
  } catch (e) {
    notyf.error(e.message);
  }
}

async function removeOpsDisplay(user) {
  try {
    const res = await fetch(`${BASE_URL}/api/ops-contacts/${user.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    const s = new Set(opsDisplayIds.value);
    s.delete(user.id);
    opsDisplayIds.value = s;
    opsDisplayOrder.value = opsDisplayOrder.value.filter((id) => id !== user.id);
    const descriptions = new Map(opsDescriptions.value);
    descriptions.delete(user.id);
    opsDescriptions.value = descriptions;
  } catch (e) {
    notyf.error(e.message);
  }
}

onMounted(async () => {
  const response = await fetch(`${BASE_URL}/api/access/catalog`);
  if (response.ok) accessCatalog.value = await response.json();
  fetchUsers(true);
});

onUnmounted(() => {
  stopOpsDragAutoScroll();
  removeOpsDragListeners();
});
</script>

<template>
  <div class="manage-container">
    <div class="add-form card">
      <div class="card-header">
        <h3>사용자 추가</h3>
        <div class="header-actions">
          <button type="button" class="btn btn-sm btn-ghost apply-url" title="클릭하여 복사" @click="copyApplyUrl">{{ applyUrl }}</button>
          <router-link to="/applications" class="btn btn-sm btn-primary">계정 신청 관리</router-link>
          <router-link to="/devices" class="btn btn-sm btn-primary">태블릿 장비 관리</router-link>
        </div>
      </div>
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
            <option value="admin">Admin</option>
          </select>
          <button type="submit" class="btn btn-primary">추가</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>사용자 <span class="count-badge">{{ filteredUsers.length }}</span></h3>
        <div class="header-actions">
          <div class="header-filters">
            <select v-model="filterRole" class="filter-select">
              <option value="all">전체 역할</option>
              <option value="admin">Admin</option>
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
            <button class="btn btn-sm btn-ghost" @click="exportCSV">CSV 다운로드</button>
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
                <th class="col-realname sortable" @click="handleSort('realname')">실명 <span class="sort-icon">{{ getSortIcon('realname') }}</span></th>
                <th class="col-phone">전화번호</th>
                <th class="col-affiliation">학교/팀</th>
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
                <td class="col-realname inline-edit-cell" @click="startRealnameEdit(user.id)">
                  <input
                    v-if="editingRealnameId === user.id"
                    :ref="inlineInputRef"
                    class="inline-edit-input"
                    type="text"
                    :value="user.realname || ''"
                    @blur="handleRealnameChange(user, $event.target.value)"
                    @keyup.enter="$event.target.blur()"
                  />
                  <span v-else class="inline-edit-text">{{ user.realname || '' }}</span>
                </td>
                <td class="col-phone inline-edit-cell" @click="startPhoneEdit(user.id)">
                  <input
                    v-if="editingPhoneId === user.id"
                    :ref="inlineInputRef"
                    class="inline-edit-input"
                    type="tel"
                    :value="user.phone || ''"
                    maxlength="13"
                    @blur="handlePhoneChange(user, $event.target.value)"
                    @keyup.enter="$event.target.blur()"
                  />
                  <span v-else class="inline-edit-text">{{ user.phone || '' }}</span>
                </td>
                <td class="col-affiliation inline-edit-cell" @click="startAffiliationEdit(user.id)">
                  <input
                    v-if="editingAffiliationId === user.id"
                    :ref="inlineInputRef"
                    class="inline-edit-input"
                    type="text"
                    :value="user.affiliation || ''"
                    @blur="handleAffiliationChange(user, $event.target.value)"
                    @keyup.enter="$event.target.blur()"
                  />
                  <span v-else class="inline-edit-text">{{ user.affiliation || '' }}</span>
                </td>
                <td class="col-date">{{ formatTimestamp(user.created_at) }}</td>
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
                      <option value="admin">Admin</option>
                    </select>
                    <button v-if="user.role === 'official'" class="btn btn-sm btn-primary" @click="editAccess(user)">
                      권한 {{ user.permissions?.length || 0 }}
                    </button>
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
                <td colspan="9" class="empty-state">사용자가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card ops-card" @click="closeOpsDropdown">
      <div class="card-header">
        <h3>운영 오피셜 연락처</h3>
        <span class="ops-desc">Official과 Admin의 사이드바에 표시</span>
      </div>
      <div class="ops-body">
        <div class="ops-select">
          <div class="select-display" @click.stop="openOpsDropdown($event)">
            <span class="select-placeholder">사용자 추가...</span>
          </div>
          <div v-if="opsDropdownOpen" class="select-dropdown" :style="opsDropdownStyle" @click.stop>
            <input
              class="select-search"
              type="text"
              v-model="opsDropdownSearch"
              placeholder="검색..."
              autofocus
            />
            <div class="select-options">
              <div
                v-for="u in opsFilteredUsers"
                :key="u.id"
                class="select-option"
                @mousedown.prevent="addOpsDisplay(u)"
              >
                <span class="option-name">{{ u.realname ? (u.phone ? `${u.realname} (${u.phone})` : u.realname) : u.name || u.email }}</span>
                <span class="option-email">{{ u.email }}</span>
              </div>
              <div v-if="opsFilteredUsers.length === 0" class="select-empty">결과 없음</div>
            </div>
          </div>
        </div>
      </div>
      <div class="table-body">
        <div class="table-container">
          <table class="data-table ops-table">
            <thead>
              <tr>
                <th class="col-order">순서</th>
                <th class="col-email">이메일</th>
                <th class="col-name">이름</th>
                <th class="col-role">역할</th>
                <th class="col-realname">실명</th>
                <th class="col-phone">전화번호</th>
                <th class="col-description">설명</th>
                <th class="col-action">액션</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="u in opsDisplayUsers"
                :key="u.id"
                class="ops-contact-row"
                :class="{ 'ops-contact-row-dragging': opsDragUserId === u.id }"
                :data-ops-contact-id="u.id"
              >
                <td class="col-order">
                  <button
                    type="button"
                    class="ops-drag-handle"
                    :class="{ 'ops-drag-handle-active': opsDragUserId === u.id }"
                    :disabled="opsOrderSaving"
                    :aria-label="`${u.realname || u.name || u.email} 드래그하여 순서 변경`"
                    :aria-pressed="opsDragUserId === u.id"
                    title="드래그하여 순서 변경"
                    @pointerdown="startOpsDrag($event, u.id)"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="5" cy="3" r="1.25" />
                      <circle cx="11" cy="3" r="1.25" />
                      <circle cx="5" cy="8" r="1.25" />
                      <circle cx="11" cy="8" r="1.25" />
                      <circle cx="5" cy="13" r="1.25" />
                      <circle cx="11" cy="13" r="1.25" />
                    </svg>
                  </button>
                </td>
                <td class="col-email">{{ u.email }}</td>
                <td class="col-name">{{ u.name || '-' }}</td>
                <td class="col-role"><span class="badge" :class="roleBadgeClass(u.role)">{{ u.role }}</span></td>
                <td class="col-realname">{{ u.realname || '-' }}</td>
                <td class="col-phone">{{ u.phone || '-' }}</td>
                <td class="col-description inline-edit-cell" @click="startOpsDescriptionEdit(u.id)">
                  <input
                    v-if="editingOpsDescriptionId === u.id"
                    :ref="inlineInputRef"
                    class="inline-edit-input"
                    type="text"
                    :value="u.opsDescription"
                    maxlength="30"
                    aria-label="운영 연락처 설명"
                    @blur="handleOpsDescriptionChange(u, $event.target.value)"
                    @keyup.enter="$event.target.blur()"
                  />
                  <span v-else class="inline-edit-text ops-description-text">{{ u.opsDescription || '설명 입력' }}</span>
                </td>
                <td class="col-action"><div class="action-btns"><button class="btn btn-sm btn-danger" @click="removeOpsDisplay(u)">제거</button></div></td>
              </tr>
              <tr v-if="opsDisplayUsers.length === 0">
                <td colspan="8" class="empty-state">표시할 사용자가 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-if="editingAccessUser" class="access-overlay" @click.self="editingAccessUser = null">
      <section class="access-dialog card" role="dialog" aria-modal="true" aria-label="서비스 권한 편집">
        <div class="card-header">
          <div>
            <h3>서비스 권한</h3>
            <span class="ops-desc">{{ editingAccessUser.email }}</span>
          </div>
          <button class="btn btn-sm btn-ghost" @click="editingAccessUser = null">닫기</button>
        </div>
        <div class="access-list">
          <div
            v-for="control in accessCatalog.accessControls"
            :key="control.key"
            class="access-option"
            :data-access-key="control.key"
          >
            <div class="access-option-copy">
              <strong>{{ control.label }}</strong>
              <template v-if="control.type === 'tiered'">
                <small><b>운영</b> {{ control.operate.description }}</small>
                <small><b>관리</b> {{ control.manage.description }}</small>
              </template>
              <small v-else>{{ control.description }}</small>
            </div>
            <select
              v-if="control.type === 'tiered'"
              class="access-level-select"
              :aria-label="`${control.label} 권한`"
              :value="accessLevel(control)"
              @change="setAccessLevel(control, $event.target.value)"
            >
              <option value="none">없음</option>
              <option value="operate">운영</option>
              <option value="manage">관리</option>
            </select>
            <label v-else class="access-toggle">
              <input
                type="checkbox"
                :aria-label="`${control.label} 허용`"
                :checked="selectedGrants.has(control.permission)"
                @change="toggleAccess(control, $event.target.checked)"
              />
              <span>허용</span>
            </label>
          </div>
        </div>
        <div class="access-actions">
          <button class="btn btn-ghost" @click="editingAccessUser = null">취소</button>
          <button class="btn btn-primary" :disabled="accessSaving" @click="saveAccess">저장</button>
        </div>
      </section>
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

.access-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.65);
}

.access-dialog {
  width: min(1000px, 96vw);
  max-height: 90vh;
  overflow: auto;
}

.access-list {
  padding: 1rem;
}

.access-option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border-color);
}

.access-option-copy strong,
.access-option-copy small { display: block; }
.access-option-copy small { margin-top: 0.25rem; color: var(--text-tertiary); }
.access-option-copy small b { color: var(--text-secondary); }

.access-level-select {
  min-width: 7rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
}

.access-toggle {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  cursor: pointer;
}

.access-toggle input[type="checkbox"] {
  flex: 0 0 auto;
  width: 1rem;
  height: 1rem;
  margin: 0;
}

.access-actions { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 1rem; }

@media (max-width: 720px) {
  .access-option { grid-template-columns: 1fr; gap: 0.6rem; }
  .access-level-select { width: 100%; }
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

.apply-url {
  font-family: "JetBrains Mono", monospace;
  max-width: min(22rem, 100%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.col-realname,
.col-phone,
.col-affiliation,
.col-date,
.col-action {
  width: 1%;
  white-space: nowrap;
}

.col-realname,
.col-phone,
.col-affiliation {
  font-size: 0.8125rem;
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

/* Inline click-to-edit (realname, phone) */
.inline-edit-cell {
  cursor: text;
  min-width: 5rem;
  font-size: 0.8125rem;
}

.inline-edit-text {
  display: inline-block;
  min-width: 2em;
  min-height: 1.25em;
}

.inline-edit-input {
  width: 100%;
  padding: 0.25rem 0.5rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.8125rem;
  transition: all 0.2s ease;
}

.inline-edit-input:hover {
  border-color: var(--border-color);
}

.inline-edit-input:focus {
  outline: none;
  background: var(--bg-input);
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
}

.col-phone {
  white-space: nowrap;
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
.ops-desc {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-left: 0.5rem;
}

.ops-body {
  padding: 1rem 1.25rem;
}

.ops-select {
  position: relative;
  margin-bottom: 0.75rem;
}

.ops-select .select-display {
  display: flex;
  align-items: center;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.75rem;
  min-height: 1.75rem;
  background: var(--bg-input);
  transition: border-color 0.15s ease;
}

.ops-select .select-display:hover { border-color: var(--accent-primary); }
.ops-select .select-placeholder { color: var(--text-tertiary); flex: 1; }

.ops-select .select-dropdown {
  position: fixed;
  z-index: 100;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.ops-select .select-search {
  width: 100%;
  padding: 0.5rem;
  border: none;
  border-bottom: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-primary);
  font-size: 0.75rem;
  outline: none;
}

.ops-select .select-options { max-height: 160px; overflow-y: auto; }

.ops-select .select-option {
  padding: 0.375rem 0.5rem;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
  transition: background 0.1s ease;
}

.ops-select .select-option:hover { background: var(--bg-hover); }
.ops-select .option-name { font-size: 0.75rem; color: var(--text-primary); }
.ops-select .option-email { font-size: 0.6875rem; color: var(--text-tertiary); }
.ops-select .select-empty { padding: 0.5rem; text-align: center; font-size: 0.75rem; color: var(--text-tertiary); }

.ops-table {
  width: 100%;
}

.ops-table .col-description {
  min-width: 8rem;
}

.ops-table .col-order {
  width: 3.5rem;
}

.ops-drag-handle {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  transition: color 0.15s ease, background 0.15s ease;
}

.ops-drag-handle:hover,
.ops-drag-handle:focus-visible {
  color: var(--accent-primary);
  background: var(--bg-hover);
  outline: none;
}

.ops-drag-handle:focus-visible {
  box-shadow: 0 0 0 2px var(--border-focus);
}

.ops-drag-handle:disabled {
  cursor: wait;
  opacity: 0.45;
}

.ops-drag-handle-active {
  cursor: grabbing;
  color: var(--accent-primary);
  background: var(--bg-hover);
}

.ops-drag-handle svg {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}

.ops-contact-row-dragging {
  background: var(--bg-hover);
  box-shadow: inset 3px 0 var(--accent-primary);
  opacity: 0.75;
}

.ops-description-text {
  color: var(--text-secondary);
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

  .ops-desc {
    margin-left: 0;
  }
}
</style>
