<script setup>
import { ref, computed } from "vue";

const props = defineProps({
  entries: {
    type: Array,
    required: true,
  },
  vehicleTypes: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits(["update", "delete"]);

const sortKey = ref(null);
const sortOrder = ref("asc");

function getTypeColor(type) {
  if (!type) return "blue";
  const vt = props.vehicleTypes.find(v => v.name === type);
  return vt?.color || "blue";
}

// 인라인 편집 상태: { num, field } 형태
const editingCell = ref(null);

const sortedEntries = computed(() => {
  if (!sortKey.value || !props.entries.length) return props.entries;

  return [...props.entries].sort((a, b) => {
    let aVal = a[sortKey.value];
    let bVal = b[sortKey.value];

    if (sortKey.value === "num") {
      aVal = Number(aVal) || 0;
      bVal = Number(bVal) || 0;
    } else {
      aVal = String(aVal || "").toLowerCase();
      bVal = String(bVal || "").toLowerCase();
    }

    if (aVal < bVal) return sortOrder.value === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder.value === "asc" ? 1 : -1;
    return 0;
  });
});

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

function startEdit(num, field) {
  editingCell.value = { num, field };
}

function editInputRef(el) {
  if (el) el.focus();
}

function saveCell(entry, field, value) {
  editingCell.value = null;

  if (field === "num") {
    const numVal = Number(value);
    if (!numVal || numVal === entry.num) return;
    emit("update", {
      num: numVal,
      univ: entry.univ,
      team: entry.team,
      type: entry.type || null,
      prev: entry.num,
    });
  } else {
    const original = entry[field] || "";
    if (value === original) return;
    emit("update", {
      num: entry.num,
      univ: field === "univ" ? value : entry.univ,
      team: field === "team" ? value : entry.team,
      type: field === "type" ? (value || null) : (entry.type || null),
      prev: entry.num,
    });
  }
}

function isEditing(num, field) {
  return editingCell.value?.num === num && editingCell.value?.field === field;
}

function handleDelete(num) {
  if (confirm(`${num}번 엔트리를 삭제하시겠습니까?`)) {
    emit("delete", num);
  }
}
</script>

<template>
  <div class="table-wrapper">
    <table class="entry-table">
      <thead>
        <tr>
          <th class="col-num sortable" @click="handleSort('num')">
            번호 <span class="sort-icon">{{ getSortIcon("num") }}</span>
          </th>
          <th class="col-univ sortable" @click="handleSort('univ')">
            학교 <span class="sort-icon">{{ getSortIcon("univ") }}</span>
          </th>
          <th class="col-team sortable" @click="handleSort('team')">
            팀명 <span class="sort-icon">{{ getSortIcon("team") }}</span>
          </th>
          <th class="col-type sortable" @click="handleSort('type')">
            유형 <span class="sort-icon">{{ getSortIcon("type") }}</span>
          </th>
          <th class="col-actions">삭제</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="sortedEntries.length === 0">
          <td colspan="5" class="empty-state">
            <div class="empty-content">
              <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
              <p>등록된 엔트리가 없습니다</p>
            </div>
          </td>
        </tr>
        <tr v-for="entry in sortedEntries" :key="entry.num">
          <!-- 번호 -->
          <td class="col-num" @click="startEdit(entry.num, 'num')">
            <input
              v-if="isEditing(entry.num, 'num')"
              :ref="editInputRef"
              class="edit-input"
              type="number"
              :value="entry.num"
              @blur="saveCell(entry, 'num', $event.target.value)"
              @keyup.enter="$event.target.blur()"
              @keyup.escape="editingCell = null"
            />
            <span v-else class="entry-number">{{ entry.num }}</span>
          </td>
          <!-- 학교 -->
          <td class="col-univ editable-cell" @click="startEdit(entry.num, 'univ')">
            <input
              v-if="isEditing(entry.num, 'univ')"
              :ref="editInputRef"
              class="edit-input"
              type="text"
              :value="entry.univ"
              @blur="saveCell(entry, 'univ', $event.target.value)"
              @keyup.enter="$event.target.blur()"
              @keyup.escape="editingCell = null"
            />
            <span v-else class="cell-text">{{ entry.univ }}</span>
          </td>
          <!-- 팀명 -->
          <td class="col-team editable-cell" @click="startEdit(entry.num, 'team')">
            <input
              v-if="isEditing(entry.num, 'team')"
              :ref="editInputRef"
              class="edit-input"
              type="text"
              :value="entry.team"
              @blur="saveCell(entry, 'team', $event.target.value)"
              @keyup.enter="$event.target.blur()"
              @keyup.escape="editingCell = null"
            />
            <span v-else class="cell-text">{{ entry.team }}</span>
          </td>
          <!-- 유형 -->
          <td class="col-type editable-cell" @click="startEdit(entry.num, 'type')">
            <select
              v-if="isEditing(entry.num, 'type')"
              :ref="editInputRef"
              class="edit-input"
              :value="entry.type || ''"
              @change="saveCell(entry, 'type', $event.target.value)"
              @blur="editingCell = null"
            >
              <option value="">-</option>
              <option v-for="vt in vehicleTypes" :key="vt.id" :value="vt.name">{{ vt.name }}</option>
            </select>
            <span v-else-if="entry.type" class="badge" :class="'badge-type-' + getTypeColor(entry.type)">{{ entry.type }}</span>
            <span v-else class="cell-text">-</span>
          </td>
          <!-- 삭제 -->
          <td class="col-actions">
            <button class="btn btn-danger btn-icon" @click="handleDelete(entry.num)" title="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrapper {
  overflow-x: auto;
}

.entry-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.entry-table th {
  padding: 0.875rem 1rem;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.entry-table th.sortable {
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}

.entry-table th.sortable:hover {
  background: var(--bg-hover);
}

.sort-icon {
  display: inline-block;
  width: 1em;
  text-align: center;
  opacity: 0.5;
  font-size: 0.75rem;
  margin-left: 0.25rem;
}

.entry-table td {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  vertical-align: middle;
}

.entry-table tbody tr {
  transition: background-color 0.15s ease;
}

.entry-table tbody tr:hover {
  background: var(--bg-hover);
}

.col-num,
.col-univ,
.col-team,
.col-type,
.col-actions {
  width: 1%;
  white-space: nowrap;
}

.col-num {
  text-align: center;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.entry-table thead .col-num {
  z-index: 3;
}

.col-actions {
  text-align: center;
}

.editable-cell {
  cursor: text;
}

.cell-text {
  display: inline-block;
  min-width: 2em;
  min-height: 1.25em;
}

.entry-number {
  font-weight: 700;
  font-size: 1rem;
  font-family: "JetBrains Mono", monospace;
  cursor: text;
}

.btn-icon {
  opacity: 0.7;
  transition: opacity 0.15s ease;
}

.entry-table tbody tr:hover .btn-icon {
  opacity: 1;
}

.btn-icon svg {
  width: 16px;
  height: 16px;
}

.edit-input {
  width: 100%;
  padding: 0.375rem 0.5rem;
  background: var(--bg-input);
  border: 1px solid var(--border-focus);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.edit-input:focus {
  outline: none;
  box-shadow: 0 0 0 2px rgba(94, 106, 210, 0.2);
}

.empty-state {
  padding: 3rem !important;
}

.empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-tertiary);
}

.empty-icon {
  width: 48px;
  height: 48px;
  opacity: 0.5;
}

.empty-content p {
  font-size: 0.9375rem;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
}

.badge-type-blue {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
}

.badge-type-green {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
}

.badge-type-orange {
  background: rgba(245, 158, 11, 0.12);
  color: #d97706;
}

.badge-type-purple {
  background: rgba(139, 92, 246, 0.12);
  color: #7c3aed;
}

.badge-type-red {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}

.badge-type-teal {
  background: rgba(20, 184, 166, 0.12);
  color: #0d9488;
}
</style>
