<script setup>
import { ref, onMounted, computed, nextTick, watch } from "vue";
import { fetchEntryYears, fetchScore, fetchTeamRecords, selectRecord, deselectRecord, updateManualScore, updatePenalty } from "../api";
import { useNotification } from "../composables/useNotification";
import { useSSE } from "../composables/useSSE";

const { success, error } = useNotification();
const { lastInspectionUpdate, lastAnswerUpdate, lastRecordAutoUpdate, lastRecordManualUpdate, lastManualScoreUpdate, lastPenaltyUpdate } = useSSE();

const selectedYear = ref(new Date().getFullYear());
const availableYears = ref([]);
const loading = ref(true);
const searchQuery = ref("");
const showInspection = ref(true);
const expandedRows = ref(new Set());

// 정렬 상태
const sortKey = ref(null);
const sortOrder = ref("asc");

// 성적 데이터
const entries = ref({});
const inspection = ref({ categories: [], teams: {} });
const events = ref([]); // [{ type, tables, records }]
const manualScores = ref({}); // { team_num: { report: value, energy: value } }
const penalties = ref({}); // { event_type: { cone_penalty, oc_penalty } }

// 기록 선택 드롭다운
const activeDropdown = ref(null); // { eventType, teamNum }

const isReadOnly = computed(() => selectedYear.value < new Date().getFullYear());

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
    } else if (sortKey.value === "cornerWeight") {
      aVal = getCurbWeight(a.num);
      bVal = getCurbWeight(b.num);
      aVal = aVal != null ? Number(aVal) : Infinity;
      bVal = bVal != null ? Number(bVal) : Infinity;
    } else if (sortKey.value === "report" || sortKey.value === "energy") {
      aVal = manualScores.value[a.num]?.[sortKey.value] ?? Infinity;
      bVal = manualScores.value[b.num]?.[sortKey.value] ?? Infinity;
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
  if (expandedRows.value.size && !e.target.closest(".col-corner-weight")) {
    expandedRows.value.clear();
  }
}

async function loadData() {
  try {
    const data = await fetchScore(selectedYear.value);
    entries.value = data.entries;
    inspection.value = data.inspection;
    events.value = data.events;
    manualScores.value = data.manualScores || {};
    penalties.value = data.penalties || {};
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

// 수동 점수 저장
async function handleManualSave(teamNum, scoreType, value) {
  const numValue = value === "" ? null : Number(value);
  const oldValue = manualScores.value[teamNum]?.[scoreType] ?? null;
  if (numValue === oldValue) return;

  if (!manualScores.value[teamNum]) manualScores.value[teamNum] = {};
  manualScores.value[teamNum][scoreType] = numValue;

  try {
    await updateManualScore(selectedYear.value, teamNum, scoreType, numValue);
  } catch {
    manualScores.value[teamNum][scoreType] = oldValue;
    error("점수 저장에 실패했습니다.");
  }
}

function getManualScore(teamNum, scoreType) {
  return manualScores.value[teamNum]?.[scoreType] ?? null;
}

// 페널티 설정 저장
async function handlePenaltySave(eventType, field, value) {
  const numValue = value === "" ? 0 : Number(value);
  if (isNaN(numValue) || numValue < 0) return;

  const current = penalties.value[eventType] || { cone_penalty: 0, oc_penalty: 0 };
  const oldValue = current[field] ?? 0;
  if (numValue === oldValue) return;

  if (!penalties.value[eventType]) penalties.value[eventType] = { cone_penalty: 0, oc_penalty: 0 };
  penalties.value[eventType][field] = numValue;

  try {
    await updatePenalty(selectedYear.value, eventType, penalties.value[eventType].cone_penalty, penalties.value[eventType].oc_penalty);
  } catch {
    penalties.value[eventType][field] = oldValue;
    error("페널티 설정 저장에 실패했습니다.");
  }
}

function getPenalty(eventType, field) {
  return penalties.value[eventType]?.[field] ?? 0;
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

// SSE로 검차 답변(코너웨이트) 실시간 반영
watch(lastAnswerUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { team_num, item_id, value } = update;

  // 코너웨이트 항목 매칭
  const cw = inspection.value.cornerWeight;
  if (cw) {
    const keyMap = { [cw.items.curb]: "curb", [cw.items.fl]: "fl", [cw.items.fr]: "fr", [cw.items.rl]: "rl", [cw.items.rr]: "rr" };
    const key = keyMap[item_id];
    if (key) {
      if (!cw.teams[team_num]) cw.teams[team_num] = {};
      cw.teams[team_num][key] = value;
    }
  }

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

// SSE로 수동 점수 실시간 반영
watch(lastManualScoreUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { team_num, score_type, value } = update;
  if (!manualScores.value[team_num]) manualScores.value[team_num] = {};
  manualScores.value[team_num][score_type] = value;
});

// SSE로 페널티 설정 실시간 반영
watch(lastPenaltyUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { event_type, cone_penalty, oc_penalty } = update;
  if (!penalties.value[event_type]) penalties.value[event_type] = {};
  penalties.value[event_type].cone_penalty = cone_penalty;
  penalties.value[event_type].oc_penalty = oc_penalty;
});

// 여러 테이블이 합쳐진 경우 짧은 테이블명
function shortTableName(tableName) {
  const parts = tableName.split(" ");
  return parts.length > 2 ? parts.slice(2).join(" ") : tableName;
}

// 카테고리 오버라이드 판별
function isOverriddenCategory(catId) {
  return catId === inspection.value.cornerWeight?.categoryId;
}

function getOverrideKey(catId) {
  if (catId === inspection.value.cornerWeight?.categoryId) return "cornerWeight";
  return null;
}

// 코너웨이트 헬퍼
function getCurbWeight(num) {
  return inspection.value.cornerWeight?.teams[num]?.curb ?? null;
}

function getCornerWeight(num) {
  return inspection.value.cornerWeight?.teams[num] ?? null;
}

function getLRRatio(num) {
  const cw = getCornerWeight(num);
  if (!cw) return null;
  const fl = Number(cw.fl), fr = Number(cw.fr), rl = Number(cw.rl), rr = Number(cw.rr);
  if (!fl || !fr || !rl || !rr) return null;
  const total = fl + fr + rl + rr;
  const left = ((fl + rl) / total * 100).toFixed(1);
  const right = ((fr + rr) / total * 100).toFixed(1);
  return { left, right };
}

function toggleCornerWeight(num) {
  if (expandedRows.value.has(num)) {
    expandedRows.value.delete(num);
  } else {
    expandedRows.value.add(num);
  }
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
      <div class="filter-group">
        <label class="filter-label">필터</label>
        <label class="filter-checkbox">
          <input type="checkbox" v-model="showInspection" />
          <span>검차</span>
        </label>
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
                  :class="{ sortable: isOverriddenCategory(cat.id) }"
                  v-show="showInspection"
                  @click="isOverriddenCategory(cat.id) && handleSort(getOverrideKey(cat.id))"
                >{{ cat.name }} <span v-if="isOverriddenCategory(cat.id)" class="sort-icon">{{ getSortIcon(getOverrideKey(cat.id)) }}</span></th>
                <th
                  v-for="evt in events"
                  :key="'h-evt-'+evt.type"
                  class="col-event sortable"
                  @click="handleSort('event:' + evt.type)"
                >{{ evt.type }} <span class="sort-icon">{{ getSortIcon('event:' + evt.type) }}</span></th>
                <th class="col-manual sortable" @click="handleSort('report')">보고서 <span class="sort-icon">{{ getSortIcon('report') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('energy')">에너지 <span class="sort-icon">{{ getSortIcon('energy') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in entryList" :key="entry.num">
                  <td class="col-num"><span class="entry-num">{{ entry.num }}</span></td>
                  <td class="col-team">{{ entry.univ }} {{ entry.team }}</td>
                  <td class="col-type"><span class="badge badge-primary" v-if="entry.type">{{ entry.type }}</span></td>
                  <template v-for="cat in inspection.categories" :key="'insp-'+cat.id+'-'+entry.num">
                    <!-- 코너웨이트 카테고리 → 공차중량 값 + 드롭다운 -->
                    <td
                      v-if="inspection.cornerWeight?.categoryId === cat.id"
                      v-show="showInspection"
                      class="col-inspection col-corner-weight"
                      @click="toggleCornerWeight(entry.num)"
                    >
                      <span v-if="getCurbWeight(entry.num)" class="cw-value">{{ getCurbWeight(entry.num) }} kg</span>
                      <span v-else class="badge badge-empty">-</span>
                      <div
                        v-if="expandedRows.has(entry.num) && getCornerWeight(entry.num)"
                        class="cw-dropdown"
                        @click.stop
                      >
                        <div class="cw-dropdown-grid">
                          <div class="cw-cell"><span class="cw-label">FL</span><span class="cw-val">{{ getCornerWeight(entry.num).fl ? getCornerWeight(entry.num).fl + ' kg' : '-' }}</span></div>
                          <div class="cw-cell"><span class="cw-label">FR</span><span class="cw-val">{{ getCornerWeight(entry.num).fr ? getCornerWeight(entry.num).fr + ' kg' : '-' }}</span></div>
                          <div class="cw-cell"><span class="cw-label">RL</span><span class="cw-val">{{ getCornerWeight(entry.num).rl ? getCornerWeight(entry.num).rl + ' kg' : '-' }}</span></div>
                          <div class="cw-cell"><span class="cw-label">RR</span><span class="cw-val">{{ getCornerWeight(entry.num).rr ? getCornerWeight(entry.num).rr + ' kg' : '-' }}</span></div>
                          <template v-if="getLRRatio(entry.num)">
                            <hr class="cw-divider">
                            <div class="cw-cell"><span class="cw-label">L</span><span class="cw-val">{{ getLRRatio(entry.num).left }}%</span></div>
                            <div class="cw-cell"><span class="cw-label">R</span><span class="cw-val">{{ getLRRatio(entry.num).right }}%</span></div>
                          </template>
                        </div>
                      </div>
                    </td>
                    <!-- 일반 카테고리 → PASS/FAIL -->
                    <td
                      v-else
                      v-show="showInspection"
                      class="col-inspection"
                    >
                      <span
                        v-if="getInspectionResult(entry.num, cat.id)"
                        class="badge"
                        :class="getInspectionResult(entry.num, cat.id) === 'PASS' ? 'badge-success' : 'badge-danger'"
                      >{{ getInspectionResult(entry.num, cat.id) }}</span>
                      <span v-else class="badge badge-empty">-</span>
                    </td>
                  </template>
                  <td
                    v-for="evt in events"
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
                  <td class="col-manual">
                    <input
                      class="manual-input"
                      type="number"
                      :value="getManualScore(entry.num, 'report')"
                      :readonly="isReadOnly"
                      @blur="handleManualSave(entry.num, 'report', $event.target.value)"
                      @keyup.enter="$event.target.blur()"
                      placeholder="-"
                    />
                  </td>
                  <td class="col-manual">
                    <input
                      class="manual-input"
                      type="number"
                      :value="getManualScore(entry.num, 'energy')"
                      :readonly="isReadOnly"
                      @blur="handleManualSave(entry.num, 'energy', $event.target.value)"
                      @keyup.enter="$event.target.blur()"
                      placeholder="-"
                    />
                  </td>
              </tr>
              <tr v-if="entryList.length === 0">
                <td :colspan="5 + inspection.categories.length + events.length" class="empty-state">
                  {{ loading ? "데이터를 불러오는 중..." : "팀 데이터가 없습니다." }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <!-- 페널티 설정 카드 -->
    <div class="card" v-if="events.length > 0">
      <div class="card-header">
        <h3>페널티 설정</h3>
      </div>
      <div class="card-body table-body">
        <div class="table-container">
          <table class="data-table penalty-table">
            <thead>
              <tr>
                <th class="col-penalty-label"></th>
                <th v-for="evt in events" :key="'penalty-h-'+evt.type" class="col-penalty-value">{{ evt.type }}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="col-penalty-label">콘터치 (초/개)</td>
                <td v-for="evt in events" :key="'penalty-cone-'+evt.type" class="col-penalty-value">
                  <input
                    class="penalty-input"
                    type="number"
                    step="any"
                    min="0"
                    :value="getPenalty(evt.type, 'cone_penalty')"
                    :readonly="isReadOnly"
                    @blur="handlePenaltySave(evt.type, 'cone_penalty', $event.target.value)"
                    @keyup.enter="$event.target.blur()"
                    placeholder="0"
                  />
                </td>
              </tr>
              <tr>
                <td class="col-penalty-label">코스이탈 (초/건)</td>
                <td v-for="evt in events" :key="'penalty-oc-'+evt.type" class="col-penalty-value">
                  <input
                    class="penalty-input"
                    type="number"
                    step="any"
                    min="0"
                    :value="getPenalty(evt.type, 'oc_penalty')"
                    :readonly="isReadOnly"
                    @blur="handlePenaltySave(evt.type, 'oc_penalty', $event.target.value)"
                    @keyup.enter="$event.target.blur()"
                    placeholder="0"
                  />
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
.col-event,
.col-manual {
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
.col-event,
.col-manual {
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

/* Filter checkbox */
.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
  user-select: none;
  padding: 0.5rem 0;
}

.filter-checkbox input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  accent-color: var(--accent-primary);
  cursor: pointer;
}

/* Corner weight */
.col-corner-weight {
  cursor: pointer;
  user-select: none;
  position: relative;
}

.col-corner-weight:hover {
  background: var(--bg-hover);
}

.cw-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
  font-weight: 500;
}

.cw-dropdown {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  padding: 0.625rem 0.875rem;
  min-width: 160px;
}

.cw-dropdown-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 1rem;
}

.cw-cell {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.cw-label {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.cw-val {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
  font-weight: 500;
}

.cw-divider {
  grid-column: 1 / -1;
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 0.125rem 0;
}

/* Manual score inline edit */
.manual-input {
  width: 4rem;
  padding: 0.125rem 0.25rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
  font-weight: 500;
  text-align: center;
  outline: none;
  cursor: pointer;
  -moz-appearance: textfield;
}

.manual-input:focus {
  border-color: var(--accent-primary);
  background: var(--bg-input);
  cursor: text;
}

.manual-input::placeholder {
  color: var(--text-tertiary);
}

.manual-input::-webkit-outer-spin-button,
.manual-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
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

/* Penalty settings */
.penalty-table {
  min-width: 0;
}

.col-penalty-label {
  white-space: nowrap;
  font-weight: 600;
}

.col-penalty-value {
  text-align: center !important;
  white-space: nowrap;
}

.penalty-input {
  width: 5rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
  font-weight: 500;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
}

.penalty-input:focus {
  border-color: var(--accent-primary);
}

.penalty-input::placeholder {
  color: var(--text-tertiary);
}

.penalty-input::-webkit-outer-spin-button,
.penalty-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
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

}
</style>
