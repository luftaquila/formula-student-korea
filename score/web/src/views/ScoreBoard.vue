<script setup>
import { ref, onMounted, computed, nextTick, watch } from "vue";
import { fetchEntryYears, fetchScore, fetchTeamRecords, selectRecord, deselectRecord } from "../api";
import { useNotification } from "../composables/useNotification";
import { useSSE } from "../composables/useSSE";

const { success, error } = useNotification();
const { lastInspectionUpdate, lastRecordAutoUpdate, lastRecordManualUpdate } = useSSE();

const selectedYear = ref(new Date().getFullYear());
const availableYears = ref([]);
const loading = ref(true);
const searchQuery = ref("");

// 정렬 상태
const sortKey = ref(null);
const sortOrder = ref("asc");

// 성적 데이터
const entries = ref({});
const inspection = ref({ categories: [], teams: {} });
const events = ref([]); // [{ type, tables, records }]

// 경기 유형 필터 (클라이언트 사이드)
const hiddenTypes = ref(new Set());

// 기록 선택 드롭다운
const activeDropdown = ref(null); // { eventType, teamNum }

const isReadOnly = computed(() => selectedYear.value < new Date().getFullYear());

const visibleEvents = computed(() =>
  events.value.filter((evt) => !hiddenTypes.value.has(evt.type)),
);

const entryList = computed(() => {
  let list = Object.entries(entries.value).map(([num, e]) => ({ num: Number(num), ...e }));
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter(e => String(e.num).includes(q) || (e.univ || "").toLowerCase().includes(q) || (e.team || "").toLowerCase().includes(q));
  }

  if (!sortKey.value) return list.sort((a, b) => a.num - b.num);

  return [...list].sort((a, b) => {
    let aVal, bVal;

    if (sortKey.value === "num") {
      aVal = a.num;
      bVal = b.num;
    } else if (sortKey.value === "team") {
      aVal = `${a.univ || ""} ${a.team || ""}`.toLowerCase();
      bVal = `${b.univ || ""} ${b.team || ""}`.toLowerCase();
    } else if (sortKey.value === "type") {
      aVal = (a.type || "").toLowerCase();
      bVal = (b.type || "").toLowerCase();
    } else if (sortKey.value.startsWith("event:")) {
      const eventType = sortKey.value.slice(6);
      const evt = events.value.find(e => e.type === eventType);
      const aRec = evt?.records[a.num]?.selected?.result;
      const bRec = evt?.records[b.num]?.selected?.result;
      // DNS(없음) → 맨 뒤, DNF(-1) → 그 앞, 나머지 숫자 비교
      aVal = aRec == null ? Infinity : aRec === -1 ? Infinity - 1 : Number(aRec);
      bVal = bRec == null ? Infinity : bRec === -1 ? Infinity - 1 : Number(bRec);
    } else {
      aVal = 0;
      bVal = 0;
    }

    if (aVal < bVal) return sortOrder.value === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder.value === "asc" ? 1 : -1;
    return 0;
  });
});

onMounted(async () => {
  try {
    availableYears.value = await fetchEntryYears();
    if (availableYears.value.length && !availableYears.value.includes(selectedYear.value)) {
      selectedYear.value = availableYears.value[0];
    }
    await loadData();
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
  loading.value = false;

  document.addEventListener("click", handleOutsideClick);
});

function handleOutsideClick(e) {
  if (activeDropdown.value && !e.target.closest(".record-cell")) {
    activeDropdown.value = null;
  }
}

async function loadData() {
  try {
    const data = await fetchScore(selectedYear.value);
    entries.value = data.entries;
    inspection.value = data.inspection;
    events.value = data.events;
    hiddenTypes.value = new Set();
    sortKey.value = null;
    sortOrder.value = "asc";
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
}

async function onYearChange() {
  loading.value = true;
  activeDropdown.value = null;
  await loadData();
  loading.value = false;
}

// 경기 유형 필터
function toggleType(type) {
  const next = new Set(hiddenTypes.value);
  if (next.has(type)) {
    next.delete(type);
  } else {
    next.add(type);
  }
  hiddenTypes.value = next;
}

// 검차 결과
function getInspectionResult(num, catId) {
  return inspection.value.teams[num]?.results?.[catId] || "";
}

// 경기 기록
function getTeamEvent(evt, num) {
  return evt.records[num] || null;
}

function formatTime(time) {
  return new Date(time).toLocaleString("ko-KR");
}

function formatResult(result) {
  if (result === -1) return "DNF";
  if (result == null) return "-";
  const ms = Number(result);
  if (isNaN(ms)) return String(result);
  const totalMs = Math.abs(ms);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }
  return `${seconds}.${String(millis).padStart(3, "0")}`;
}

async function toggleDropdown(evt, teamNum, e) {
  e.stopPropagation();
  if (isReadOnly.value) return;
  const teamEvent = getTeamEvent(evt, teamNum);
  if (!teamEvent) return;

  if (activeDropdown.value?.eventType === evt.type && activeDropdown.value?.teamNum === teamNum) {
    activeDropdown.value = null;
  } else {
    const cell = e.currentTarget;

    // 드롭다운 열 때 최신 기록 fetch
    try {
      const fresh = await fetchTeamRecords(selectedYear.value, evt.type, teamNum);
      evt.records[teamNum] = fresh;
    } catch {
      // fetch 실패 시 기존 데이터 사용
    }

    if (!evt.records[teamNum]?.all?.length) return;

    activeDropdown.value = { eventType: evt.type, teamNum };
    await nextTick();
    const container = cell.closest('.table-container');
    const dropdown = cell.querySelector('.record-dropdown');
    if (dropdown && container) {
      const cellRect = cell.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const dropdownWidth = dropdown.offsetWidth;
      const cellCenter = cellRect.left + cellRect.width / 2;
      if (cellCenter + dropdownWidth / 2 > containerRect.right) {
        dropdown.style.left = 'auto';
        dropdown.style.right = '0';
        dropdown.style.transform = 'none';
      }
    }
  }
}

function isDropdownOpen(evt, teamNum) {
  return activeDropdown.value?.eventType === evt.type && activeDropdown.value?.teamNum === teamNum;
}

async function handleSelectRecord(evt, teamNum, run) {
  try {
    await selectRecord(selectedYear.value, evt.type, teamNum, run.table_name, run.rowid, run.result, run.detail);
    evt.records[teamNum].selected = {
      table_name: run.table_name,
      rowid: run.rowid,
      result: run.result,
      detail: run.detail,
    };
    activeDropdown.value = null;
  } catch {
    error("기록 선택에 실패했습니다.");
  }
}

async function handleDeselectRecord(evt, teamNum) {
  try {
    await deselectRecord(selectedYear.value, evt.type, teamNum);
    evt.records[teamNum].selected = null;
    activeDropdown.value = null;
    success("기록 선택이 해제되었습니다.");
  } catch {
    error("기록 선택 해제에 실패했습니다.");
  }
}

// 정렬
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

// SSE로 검차 결과 실시간 반영
watch(lastInspectionUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { team_num, category_id, result } = update;
  if (!inspection.value.teams[team_num]) {
    inspection.value.teams[team_num] = { inspectors: {}, results: {} };
  }
  inspection.value.teams[team_num].results[category_id] = result;
});

// SSE로 기록 자동 선택 실시간 반영
watch(lastRecordAutoUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { event_type, team_num, selected } = update;
  const evt = events.value.find((e) => e.type === event_type);
  if (!evt) return;

  if (!evt.records[team_num]) {
    evt.records[team_num] = { selected: null, all: [] };
  }

  evt.records[team_num].selected = selected
    ? { table_name: selected.table_name, rowid: selected.rowid, result: selected.result, detail: selected.detail || null }
    : null;
});

// SSE로 다른 관리자의 기록 선택/해제 실시간 반영
watch(lastRecordManualUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { event_type, team_num, selected } = update;
  const evt = events.value.find((e) => e.type === event_type);
  if (!evt) return;

  if (!evt.records[team_num]) {
    evt.records[team_num] = { selected: null, all: [] };
  }

  evt.records[team_num].selected = selected
    ? { table_name: selected.table_name, rowid: selected.rowid, result: selected.result, detail: selected.detail || null }
    : null;
});

// 경기 유형 색상 순환
const TYPE_COLORS = ['accel', 'gymkhana', 'skidpad'];
function typeColorClass(idx) {
  return TYPE_COLORS[idx % TYPE_COLORS.length];
}

// 여러 테이블이 합쳐진 경우 짧은 테이블명
function shortTableName(tableName) {
  const parts = tableName.split(" ");
  return parts.length > 2 ? parts.slice(2).join(" ") : tableName;
}
</script>

<template>
  <div class="score-page">
    <div class="filter-bar">
      <div class="filter-group">
        <label class="filter-label">엔트리</label>
        <select class="filter-input" v-model.number="selectedYear" @change="onYearChange">
          <option v-for="y in availableYears" :key="y" :value="y">{{ y }}년</option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">검색</label>
        <input class="filter-input" v-model="searchQuery" placeholder="번호 / 학교 / 팀명" />
      </div>
      <div v-if="events.length > 0" class="filter-group filter-types">
        <label class="filter-label">경기 유형</label>
        <div class="type-filters">
          <label v-for="(evt, idx) in events" :key="evt.type" class="filter-checkbox">
            <input type="checkbox" :checked="!hiddenTypes.has(evt.type)" @change="toggleType(evt.type)" />
            <span class="filter-tag" :class="typeColorClass(idx)">{{ evt.type }}</span>
          </label>
        </div>
      </div>
    </div>

    <div v-if="isReadOnly" class="readonly-banner">읽기 전용 모드 (과거 연도)</div>

    <!-- 메인 테이블 -->
    <div class="card">
      <div class="card-header">
        <div class="header-left">
          <h3>성적표</h3>
          <span class="count-badge">{{ entryList.length }}개 팀</span>
        </div>
      </div>
      <div class="card-body table-body">
        <div v-if="loading" class="loading"><div class="loading-spinner"></div></div>
        <div v-else class="table-container">
          <table class="data-table score-table">
            <thead>
              <tr>
                <th class="col-num sortable" @click="handleSort('num')">번호 <span class="sort-icon">{{ getSortIcon('num') }}</span></th>
                <th class="col-team sortable" @click="handleSort('team')">학교 / 팀 <span class="sort-icon">{{ getSortIcon('team') }}</span></th>
                <th class="col-type sortable" @click="handleSort('type')">유형 <span class="sort-icon">{{ getSortIcon('type') }}</span></th>
                <th
                  v-for="cat in inspection.categories"
                  :key="'h-insp-'+cat.id"
                  class="col-inspection"
                >{{ cat.name }}</th>
                <th
                  v-for="evt in visibleEvents"
                  :key="'h-evt-'+evt.type"
                  class="col-event sortable"
                  @click="handleSort('event:' + evt.type)"
                >{{ evt.type }} <span class="sort-icon">{{ getSortIcon('event:' + evt.type) }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in entryList" :key="entry.num">
                <td class="col-num"><span class="entry-num">{{ entry.num }}</span></td>
                <td class="col-team">{{ entry.univ }} {{ entry.team }}</td>
                <td class="col-type"><span class="badge badge-primary" v-if="entry.type">{{ entry.type }}</span></td>
                <td
                  v-for="cat in inspection.categories"
                  :key="'insp-'+cat.id+'-'+entry.num"
                  class="col-inspection"
                >
                  <span
                    v-if="getInspectionResult(entry.num, cat.id)"
                    class="badge"
                    :class="getInspectionResult(entry.num, cat.id) === 'PASS' ? 'badge-success' : 'badge-danger'"
                  >{{ getInspectionResult(entry.num, cat.id) }}</span>
                  <span v-else class="badge badge-empty">-</span>
                </td>
                <td
                  v-for="evt in visibleEvents"
                  :key="'evt-'+evt.type+'-'+entry.num"
                  class="col-event record-cell"
                  @click="toggleDropdown(evt, entry.num, $event)"
                >
                  <template v-if="getTeamEvent(evt, entry.num)">
                    <span
                      v-if="getTeamEvent(evt, entry.num).selected"
                      class="record-value"
                      :class="{ dnf: getTeamEvent(evt, entry.num).selected.result === -1 }"
                    >{{ formatResult(getTeamEvent(evt, entry.num).selected.result) }}</span>
                    <span v-else class="record-value unselected">-</span>
                  </template>
                  <span v-else class="record-value dns">DNS</span>

                  <!-- 기록 선택 드롭다운 -->
                  <div
                    v-if="isDropdownOpen(evt, entry.num)"
                    class="record-dropdown"
                    @click.stop
                  >
                    <div class="dropdown-header">
                      <span>기록 선택</span>
                      <button
                        v-if="getTeamEvent(evt, entry.num)?.selected"
                        class="btn btn-sm btn-ghost"
                        @click="handleDeselectRecord(evt, entry.num)"
                      >선택 해제</button>
                    </div>
                    <div class="dropdown-list">
                      <div
                        v-for="run in getTeamEvent(evt, entry.num).all"
                        :key="run.table_name + '-' + run.rowid"
                        class="dropdown-item"
                        :class="{
                          invalidated: run.invalidated,
                          'no-scoreboard': !run.invalidated && !run.scoreboard,
                          selected: getTeamEvent(evt, entry.num).selected?.rowid === run.rowid
                            && getTeamEvent(evt, entry.num).selected?.table_name === run.table_name,
                        }"
                        @click="handleSelectRecord(evt, entry.num, run)"
                      >
                        <span class="run-result" :class="{ dnf: run.result === -1 }">
                          {{ formatResult(run.result) }}
                        </span>
                        <span v-if="run.detail" class="run-detail">{{ run.detail }}</span>
                        <span class="run-table">{{ shortTableName(run.table_name) }}</span>
                        <span class="run-time">{{ formatTime(run.time) }}</span>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
              <tr v-if="entryList.length === 0">
                <td :colspan="3 + inspection.categories.length + visibleEvents.length" class="empty-state">
                  {{ loading ? "데이터를 불러오는 중..." : "팀 데이터가 없습니다." }}
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
.score-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  align-items: flex-end;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.filter-types {
  flex: 1;
  min-width: 0;
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

/* 경기 유형 필터 (traffic 서비스 동일 디자인) */
.type-filters {
  display: flex;
  gap: 0.75rem;
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  cursor: pointer;
}

.filter-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.filter-tag {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
}

.filter-tag.accel {
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-primary);
}

.filter-tag.gymkhana {
  background: rgba(139, 92, 246, 0.1);
  color: var(--accent-secondary);
}

.filter-tag.skidpad {
  background: rgba(245, 158, 11, 0.1);
  color: var(--accent-warning);
}

.readonly-banner {
  background: rgba(245, 158, 11, 0.15);
  color: var(--accent-warning);
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.875rem;
  text-align: center;
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

.table-body {
  padding: 0 !important;
  overflow: auto;
}

.table-container {
  overflow-x: auto;
}

.score-table {
  min-width: 700px;
}

.score-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  white-space: nowrap;
  font-size: 0.75rem;
}

.score-table th.sortable {
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}

.score-table th.sortable:hover {
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

.col-num,
.col-team,
.col-type,
.col-inspection,
.col-event {
  width: 1%;
  white-space: nowrap;
}

.col-num {
  text-align: center !important;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.score-table thead .col-num {
  z-index: 3;
}

.col-team {
  font-size: 0.8125rem;
}

.col-type,
.col-inspection,
.col-event {
  text-align: center !important;
}

.col-event {
  position: relative;
}

.entry-num {
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
}

.badge-empty {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.record-cell {
  cursor: pointer;
  user-select: none;
  position: relative;
}

.record-cell:hover {
  background: var(--bg-hover);
}

.record-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
  font-weight: 500;
}

.record-value.dnf {
  color: var(--accent-danger);
  font-weight: 700;
}

.record-value.unselected {
  color: var(--text-tertiary);
}

.record-value.dns {
  color: var(--text-tertiary);
  font-weight: 400;
}

/* Record dropdown */
.record-dropdown {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  min-width: 240px;
  max-height: 300px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.dropdown-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--border-color);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.dropdown-list {
  overflow-y: auto;
  max-height: 250px;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.875rem;
  cursor: pointer;
  transition: background 0.15s;
  font-size: 0.8125rem;
  border-bottom: 1px solid var(--border-color);
}

.dropdown-item:last-child {
  border-bottom: none;
}

.dropdown-item:hover {
  background: var(--bg-hover);
}

.dropdown-item.selected {
  background: rgba(59, 130, 246, 0.1);
}

.dropdown-item.invalidated {
  text-decoration: line-through;
  opacity: 0.5;
}

.dropdown-item.no-scoreboard {
  opacity: 0.5;
}

.run-result {
  font-family: "JetBrains Mono", monospace;
  font-weight: 500;
  min-width: 70px;
}

.run-result.dnf {
  color: var(--accent-danger);
  font-weight: 700;
}

.run-detail {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  flex-shrink: 0;
}

.run-table {
  color: var(--text-tertiary);
  font-size: 0.6875rem;
  flex-shrink: 0;
}

.run-time {
  color: var(--text-tertiary);
  font-size: 0.6875rem;
  margin-left: auto;
  white-space: nowrap;
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

.empty-state {
  text-align: center;
  color: var(--text-tertiary);
  padding: 2rem;
}

@media (max-width: 640px) {
  .filter-bar {
    flex-direction: column;
    align-items: stretch;
  }

  .filter-group {
    width: 100%;
  }

  .filter-input {
    width: 100%;
    box-sizing: border-box;
  }

  .type-filters {
    flex-wrap: wrap;
  }
}
</style>
