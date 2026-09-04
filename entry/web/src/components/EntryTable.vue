<script setup>
import { ref, computed } from "vue";
import { useTableHeadBand } from "@shared/useTableHeadBand.js";

const props = defineProps({
  entries: {
    type: Array,
    required: true,
  },
  vehicleTypes: {
    type: Array,
    default: () => [],
  },
  activeUpdating: {
    type: Set,
    default: () => new Set(),
  },
  readonly: { type: Boolean, default: false },
});

const tableRef = ref(null);
const tableScrollerRef = ref(null);
const headBandRef = ref(null);
useTableHeadBand({ tableRef, scrollerRef: tableScrollerRef, bandRef: headBandRef });

const emit = defineEmits(["update", "active"]);

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

function getAriaSort(key) {
  if (sortKey.value !== key) return undefined;
  return sortOrder.value === "asc" ? "ascending" : "descending";
}

function startEdit(num, field) {
  if (props.readonly) return;
  editingCell.value = { num, field };
}

function editInputRef(el) {
  if (!el) return;
  queueMicrotask(() => {
    if (el.getClientRects().length) el.focus();
  });
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
      id: entry.id,
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
      id: entry.id,
      prev: entry.num,
    });
  }
}

function isEditing(num, field) {
  return editingCell.value?.num === num && editingCell.value?.field === field;
}

function toggleActive(entry) {
  if (props.readonly || props.activeUpdating.has(entry.num)) return;
  emit("active", { ...entry, active: entry.active === false });
}
</script>

<template>
  <div class="sticky-host team-table-sticky-host">
    <div ref="headBandRef" class="team-table-head-band" data-testid="entry-team-sticky-header"></div>
    <div ref="tableScrollerRef" class="table-wrapper team-table-scroll" data-testid="entry-team-table-scroll">
    <table ref="tableRef" class="entry-table team-table team-table-desktop-split" :class="{ readonly }">
      <thead>
        <tr>
          <th class="col-num sortable" :aria-sort="getAriaSort('num')" @click="handleSort('num')">
            엔트리 <span class="sort-icon">{{ getSortIcon("num") }}</span>
          </th>
          <th class="col-univ sortable" :aria-sort="getAriaSort('univ')" @click="handleSort('univ')">
            학교 <span class="sort-icon">{{ getSortIcon("univ") }}</span>
          </th>
          <th class="col-team sortable" :aria-sort="getAriaSort('team')" @click="handleSort('team')">
            팀명 <span class="sort-icon">{{ getSortIcon("team") }}</span>
          </th>
          <th class="col-type sortable" :aria-sort="getAriaSort('type')" @click="handleSort('type')">
            유형 <span class="sort-icon">{{ getSortIcon("type") }}</span>
          </th>
          <th class="col-active">상태</th>
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
        <tr v-for="entry in sortedEntries" :key="entry.id" :class="{ 'entry-inactive': entry.active === false }">
          <!-- 엔트리 -->
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
            <div v-else class="team-entry-summary">
              <div class="team-entry-summary-top">
                <span class="entry-number">{{ entry.num }}</span>
                <select
                  v-if="isEditing(entry.num, 'type')"
                  :ref="editInputRef"
                  class="team-mobile-edit-control"
                  :value="entry.type || ''"
                  @click.stop
                  @change="saveCell(entry, 'type', $event.target.value)"
                  @blur="editingCell = null"
                >
                  <option value="">-</option>
                  <option v-for="vt in vehicleTypes" :key="vt.id" :value="vt.name">{{ vt.name }}</option>
                </select>
                <button
                  v-else-if="entry.type"
                  type="button"
                  class="badge team-mobile-entry-type team-mobile-entry-button"
                  :class="'badge-type-' + getTypeColor(entry.type)"
                  @click.stop="startEdit(entry.num, 'type')"
                >{{ entry.type }}</button>
              </div>
              <input
                v-if="isEditing(entry.num, 'univ')"
                :ref="editInputRef"
                class="team-mobile-edit-control"
                type="text"
                :value="entry.univ"
                @click.stop
                @blur="saveCell(entry, 'univ', $event.target.value)"
                @keyup.enter="$event.target.blur()"
                @keyup.escape="editingCell = null"
              />
              <button v-else type="button" class="team-mobile-entry-univ team-mobile-entry-button" @click.stop="startEdit(entry.num, 'univ')">{{ entry.univ }}</button>
              <input
                v-if="isEditing(entry.num, 'team')"
                :ref="editInputRef"
                class="team-mobile-edit-control"
                type="text"
                :value="entry.team"
                @click.stop
                @blur="saveCell(entry, 'team', $event.target.value)"
                @keyup.enter="$event.target.blur()"
                @keyup.escape="editingCell = null"
              />
              <button v-else type="button" class="team-mobile-entry-name team-mobile-entry-button" @click.stop="startEdit(entry.num, 'team')">{{ entry.team }}</button>
            </div>
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
          <!-- 활성 상태 -->
          <td class="col-active">
            <button
              type="button"
              class="status-toggle"
              :class="{ active: entry.active !== false }"
              role="switch"
              :aria-checked="entry.active !== false"
              :aria-label="`${entry.num}번 엔트리 ${entry.active !== false ? '비활성화' : '활성화'}`"
              :aria-busy="activeUpdating.has(entry.num)"
              :title="entry.active !== false ? '비활성화' : '활성화'"
              :disabled="readonly || activeUpdating.has(entry.num)"
              @click="toggleActive(entry)"
            >
              <span class="status-toggle-track"><span class="status-toggle-thumb"></span></span>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    </div>
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
.col-active,
.col-actions {
  width: 1%;
  white-space: nowrap;
}

.entry-inactive td {
  color: var(--text-tertiary);
  background-color: var(--bg-secondary);
}

.entry-inactive .col-num,
.entry-inactive .col-univ,
.entry-inactive .col-team,
.entry-inactive .col-type {
  background-color: var(--bg-secondary) !important;
}

.status-toggle {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.status-toggle:disabled {
  cursor: wait;
  opacity: 0.6;
}

.status-toggle-track {
  position: relative;
  width: 2rem;
  height: 1.1rem;
  border-radius: 999px;
  background: var(--text-tertiary);
  transition: background-color 0.15s ease;
}

.status-toggle-thumb {
  position: absolute;
  top: 0.15rem;
  left: 0.15rem;
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 50%;
  background: white;
  transition: transform 0.15s ease;
}

.status-toggle.active .status-toggle-track {
  background: var(--accent-success);
}

.status-toggle.active .status-toggle-thumb {
  transform: translateX(0.9rem);
}

.col-num {
  text-align: left;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.entry-table thead .col-num {
  z-index: 3;
}

.sticky-host {
  position: relative;
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

.edit-input,
.team-mobile-edit-control {
  width: 100%;
  padding: 0.375rem 0.5rem;
  background: var(--bg-input);
  border: 1px solid var(--border-focus);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.edit-input:focus,
.team-mobile-edit-control:focus {
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

</style>
