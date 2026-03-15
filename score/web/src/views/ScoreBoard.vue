<script setup>
import { ref, onMounted, computed, watch } from "vue";
import * as XLSX from "xlsx";
import { fetchEntryYears, fetchScore, updateManualScore, updatePenalty, updateSetting } from "../api";
import { useNotification } from "../composables/useNotification";
import { useSSE } from "../composables/useSSE";

const { success, error } = useNotification();
const { lastInspectionUpdate, lastAnswerUpdate, lastTrafficRecordUpdate, lastManualScoreUpdate, lastPenaltyUpdate, lastSettingUpdate, lastEnduranceUpdate } = useSSE();

const selectedYear = ref(new Date().getFullYear());
const availableYears = ref([]);
const loading = ref(true);
const searchQuery = ref("");
const showInspection = ref(localStorage.getItem("score-show-inspection") !== "false");
watch(showInspection, (v) => localStorage.setItem("score-show-inspection", v));
const expandedRows = ref(new Set());
const detailExpandedTeam = ref(null);
const detailSortMode = ref("time");
const hoveredEvtGroup = ref(null);
const displayMode = ref(localStorage.getItem("score-display-mode") || "record");
watch(displayMode, (v) => localStorage.setItem("score-display-mode", v));

// 정렬 상태
const sortKey = ref(null);
const sortOrder = ref("asc");

// 성적 데이터
const entries = ref({});
const inspection = ref({ categories: [], teams: {} });
const events = ref([]); // [{ type, tables, records }]
const manualScores = ref({}); // { team_num: { report: value, energy: value } }
const penalties = ref({}); // { event_type: { cone_penalty, oc_penalty } }
const settings = ref({}); // { event_type: { total, finish, cutoff } }

const dynamicEvents = computed(() => events.value.filter((e) => e.type !== "내구"));
const enduranceEvent = computed(() => events.value.find((e) => e.type === "내구") || { type: "내구", records: {} });

const typeFilters = ref({});

const vehicleTypes = computed(() => {
  const types = new Set();
  for (const e of Object.values(entries.value)) {
    if (e.type) types.add(e.type);
  }
  return [...types].sort();
});

// 새 유형이 나타나면 기본 활성화
watch(vehicleTypes, (types) => {
  for (const t of types) {
    if (!(t in typeFilters.value)) typeFilters.value[t] = true;
  }
});

const editingSettingCell = ref(null); // "penalty:cone_penalty:가속" or "setting:total:내구"

const isReadOnly = computed(() => selectedYear.value < new Date().getFullYear());

const entryList = computed(() => {
  let list = Object.entries(entries.value).map(([num, e]) => ({ num: Number(num), ...e }));
  // 차량 유형 필터
  if (vehicleTypes.value.length > 0) {
    list = list.filter(e => !e.type || typeFilters.value[e.type] !== false);
  }
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
    } else if (sortKey.value === "totalScore") {
      aVal = getTotalScore(a.num);
      bVal = getTotalScore(b.num);
      return sortOrder.value === "asc" ? bVal - aVal : aVal - bVal;
    } else if (["report", "energy", "bonus", "deduction"].includes(sortKey.value)) {
      aVal = manualScores.value[a.num]?.[sortKey.value] ?? Infinity;
      bVal = manualScores.value[b.num]?.[sortKey.value] ?? Infinity;
    } else if (sortKey.value.startsWith("event:")) {
      const eventType = sortKey.value.slice(6);
      const evt = events.value.find(e => e.type === eventType);
      if (displayMode.value === "score") {
        aVal = getEventScore(eventType, a.num) ?? -Infinity;
        bVal = getEventScore(eventType, b.num) ?? -Infinity;
        // 점수 높은 순이 기본
        return sortOrder.value === "asc" ? bVal - aVal : aVal - bVal;
      }
      const aRec = evt?.records[a.num];
      const bRec = evt?.records[b.num];
      const aAdj = getAdjustedResult(eventType, aRec);
      const bAdj = getAdjustedResult(eventType, bRec);
      aVal = aAdj == null ? Infinity : aAdj === -1 ? Infinity - 1 : Number(aAdj);
      bVal = bAdj == null ? Infinity : bAdj === -1 ? Infinity - 1 : Number(bAdj);
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
    settings.value = data.settings || {};
    sortKey.value = null;
    sortOrder.value = "asc";
  } catch (e) {
    error("데이터를 가져올 수 없습니다.");
  }
}

async function onYearChange() {
  loading.value = true;
  detailExpandedTeam.value = null;
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

// 페널티 반영 기록 (ms)
function getAdjustedResult(eventType, rec) {
  if (!rec || rec.result == null || rec.result === -1) return rec?.result ?? null;
  const pen = penalties.value[eventType] || {};
  return rec.result + (rec.cones || 0) * (pen.cone_penalty || 0) * 1000 + (rec.oc || 0) * (pen.oc_penalty || 0) * 1000;
}

// 종목별 최고 페널티 반영 기록 (가장 빠른 팀)
function getBestAdjusted(eventType) {
  const evt = events.value.find((e) => e.type === eventType);
  if (!evt) return null;
  let best = null;
  for (const rec of Object.values(evt.records)) {
    const adj = getAdjustedResult(eventType, rec);
    if (adj != null && adj >= 0 && (best === null || adj < best)) best = adj;
  }
  return best;
}

// 점수 계산: (총점-완주) * ((컷오프*best/my)-1) / (컷오프-1) + 완주
function getEventScore(eventType, num) {
  const evt = events.value.find((e) => e.type === eventType);
  if (!evt) return null;
  const rec = evt.records[num];
  const my = getAdjustedResult(eventType, rec);
  if (my == null) return null;
  if (my === -1) return 0;
  const best = getBestAdjusted(eventType);
  if (best == null || best <= 0) return null;
  const s = settings.value[eventType] || {};
  const total = s.total ?? 0;
  const finish = s.finish ?? 0;
  const cutoff = (s.cutoff ?? 100) / 100;
  if (cutoff <= 1) return total;
  // 컷오프 초과 시 완주점수만 부여
  if (my > best * cutoff) return finish;
  const score = (total - finish) * ((cutoff * best / my) - 1) / (cutoff - 1) + finish;
  return Math.max(finish, Math.min(total, parseFloat(score.toFixed(2))));
}

// 총점 계산 (모든 경기 점수 + 내구 + 보고서 + 에너지)
function getTotalScore(num) {
  let total = 0;
  for (const evt of dynamicEvents.value) {
    const s = getEventScore(evt.type, num);
    if (s != null) total += s;
  }
  const endurance = getEventScore("내구", num);
  if (endurance != null) total += endurance;
  total += manualScores.value[num]?.report ?? 0;
  total += manualScores.value[num]?.energy ?? 0;
  total += manualScores.value[num]?.bonus ?? 0;
  total -= manualScores.value[num]?.deduction ?? 0;
  return parseFloat(total.toFixed(2));
}

const typeColors = ["blue", "green", "orange", "purple", "red", "teal"];
const typeColorMap = {};
function getTypeColor(type) {
  if (!type) return "blue";
  if (!typeColorMap[type]) {
    const idx = Object.keys(typeColorMap).length % typeColors.length;
    typeColorMap[type] = typeColors[idx];
  }
  return typeColorMap[type];
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
  const minutes = String(Math.floor(totalMs / 60000)).padStart(2, "0");
  const seconds = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, "0");
  const millis = String(Math.round(totalMs % 1000)).padStart(3, "0");
  return `${minutes}:${seconds}.${millis}`;
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
  editingSettingCell.value = null;
  const numValue = value === "" ? 0 : Number(value);
  if (isNaN(numValue) || numValue < 0) return;

  const current = penalties.value[eventType] || { cone_penalty: 0, oc_penalty: 0, start_delay: 0 };
  const oldValue = current[field] ?? 0;
  if (numValue === oldValue) return;

  if (!penalties.value[eventType]) penalties.value[eventType] = { cone_penalty: 0, oc_penalty: 0, start_delay: 0 };
  penalties.value[eventType][field] = numValue;

  try {
    const p = penalties.value[eventType];
    await updatePenalty(selectedYear.value, eventType, p.cone_penalty, p.oc_penalty, p.start_delay);
  } catch {
    penalties.value[eventType][field] = oldValue;
    error("페널티 설정 저장에 실패했습니다.");
  }
}

function getPenalty(eventType, field) {
  return penalties.value[eventType]?.[field] ?? 0;
}

function startSettingEdit(key) {
  if (isReadOnly.value) return;
  editingSettingCell.value = key;
}

function settingInputRef(el) {
  if (el) { el.focus(); el.select(); }
}

// 점수 설정 저장
async function handleSettingSave(eventType, key, value) {
  editingSettingCell.value = null;
  const numValue = value === "" ? null : Number(value);
  if (numValue !== null && isNaN(numValue)) return;

  const oldValue = settings.value[eventType]?.[key] ?? null;
  if (numValue === oldValue) return;

  if (!settings.value[eventType]) settings.value[eventType] = {};
  settings.value[eventType][key] = numValue;

  try {
    await updateSetting(selectedYear.value, eventType, key, numValue);
  } catch {
    settings.value[eventType][key] = oldValue;
    error("점수 설정 저장에 실패했습니다.");
  }
}

function getSetting(eventType, key) {
  return settings.value[eventType]?.[key] ?? null;
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
  const { event_type, cone_penalty, oc_penalty, start_delay } = update;
  if (!penalties.value[event_type]) penalties.value[event_type] = {};
  penalties.value[event_type].cone_penalty = cone_penalty;
  penalties.value[event_type].oc_penalty = oc_penalty;
  penalties.value[event_type].start_delay = start_delay;
  loadData(); // 내구 result는 백엔드에서 start_delay 포함 계산되므로 재로드 필요
});

// SSE로 점수 설정 실시간 반영
watch(lastSettingUpdate, (update) => {
  if (!update || update.year !== selectedYear.value) return;
  const { event_type, setting_key, value } = update;
  if (!settings.value[event_type]) settings.value[event_type] = {};
  settings.value[event_type][setting_key] = value;
  loadData();
});

// SSE로 경기 기록 변경 시 데이터 재로드
watch(lastTrafficRecordUpdate, () => {
  loadData();
});

// SSE로 내구 기록 변경 시 데이터 재로드
watch(lastEnduranceUpdate, () => {
  loadData();
});

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

function getFRRatio(num) {
  const cw = getCornerWeight(num);
  if (!cw) return null;
  const fl = Number(cw.fl), fr = Number(cw.fr), rl = Number(cw.rl), rr = Number(cw.rr);
  if (!fl || !fr || !rl || !rr) return null;
  const total = fl + fr + rl + rr;
  const front = ((fl + fr) / total * 100).toFixed(1);
  const rear = ((rl + rr) / total * 100).toFixed(1);
  return { front, rear };
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

// 세부 기록 확장 행
const allEvents = computed(() => [...dynamicEvents.value, enduranceEvent.value]);

const totalColumns = computed(() => {
  let cols = 3; // num, team, type
  if (showInspection.value) cols += inspection.value.categories.length;
  cols += 1; // total
  cols += dynamicEvents.value.length; // dynamic events
  cols += 1; // endurance
  cols += 4; // manual scores (report, energy, bonus, deduction)
  return cols;
});

function handleRowClick(num, event) {
  if (event.target.closest(".col-corner-weight, .manual-input, .setting-cell, input, button, a")) return;
  detailExpandedTeam.value = detailExpandedTeam.value === num ? null : num;
}

function getAllRuns(eventType, num) {
  const evt = events.value.find((e) => e.type === eventType);
  return evt?.records[num]?.allRuns || [];
}

function getRunAdjusted(eventType, run) {
  if (!run || run.result == null || run.result < 0) return run?.result ?? null;
  const pen = penalties.value[eventType] || {};
  return run.result + (run.cones || 0) * (pen.cone_penalty || 0) * 1000 + (run.oc || 0) * (pen.oc_penalty || 0) * 1000;
}

function getBestRunIndex(eventType, num) {
  const runs = getAllRuns(eventType, num);
  const pen = penalties.value[eventType] || { cone_penalty: 0, oc_penalty: 0 };
  let bestIdx = -1;
  let bestAdj = Infinity;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.invalidated) continue;
    if (r.result == null || r.result < 0) continue;
    const adj = r.result + (r.cones || 0) * pen.cone_penalty * 1000 + (r.oc || 0) * pen.oc_penalty * 1000;
    if (adj < bestAdj) { bestAdj = adj; bestIdx = i; }
  }
  return bestIdx;
}

function getSortedRuns(eventType, num) {
  const runs = getAllRuns(eventType, num);
  const indexed = runs.map((r, i) => ({ ...r, origIndex: i }));
  if (detailSortMode.value === "score") {
    const pen = penalties.value[eventType] || { cone_penalty: 0, oc_penalty: 0 };
    indexed.sort((a, b) => {
      if (a.invalidated && !b.invalidated) return 1;
      if (!a.invalidated && b.invalidated) return -1;
      const aAdj = a.result != null && a.result >= 0 ? a.result + (a.cones || 0) * pen.cone_penalty * 1000 + (a.oc || 0) * pen.oc_penalty * 1000 : Infinity;
      const bAdj = b.result != null && b.result >= 0 ? b.result + (b.cones || 0) * pen.cone_penalty * 1000 + (b.oc || 0) * pen.oc_penalty * 1000 : Infinity;
      return aAdj - bAdj;
    });
  }
  return indexed;
}

function hasAnyRuns(num) {
  return allEvents.value.some((evt) => getAllRuns(evt.type, num).length > 0);
}

function toggleCornerWeight(num) {
  if (expandedRows.value.has(num)) {
    expandedRows.value.delete(num);
  } else {
    expandedRows.value.add(num);
  }
}

function exportData(format) {
  const headers = ["번호", "학교", "팀", "유형"];
  if (showInspection.value) {
    for (const cat of inspection.value.categories) headers.push(cat.name);
  }
  headers.push("총점");
  for (const evt of dynamicEvents.value) headers.push(evt.type);
  headers.push("내구", "보고서", "에너지", "가점", "감점");

  const rows = entryList.value.map((entry) => {
    const row = [entry.num, entry.univ || "", entry.team || "", entry.type || ""];
    if (showInspection.value) {
      for (const cat of inspection.value.categories) {
        row.push(isOverriddenCategory(cat.id) ? (getCurbWeight(entry.num) ?? "") : (getInspectionResult(entry.num, cat.id) || ""));
      }
    }
    row.push(getTotalScore(entry.num));
    for (const evt of dynamicEvents.value) {
      row.push(displayMode.value === "score" ? (getEventScore(evt.type, entry.num) ?? "") : (formatResult(getAdjustedResult(evt.type, getTeamEvent(evt, entry.num)))));
    }
    const endRec = getTeamEvent(enduranceEvent.value, entry.num);
    row.push(displayMode.value === "score" ? (getEventScore("내구", entry.num) ?? "") : formatResult(getAdjustedResult("내구", endRec)));
    row.push(getManualScore(entry.num, "report") ?? "", getManualScore(entry.num, "energy") ?? "", getManualScore(entry.num, "bonus") ?? "", getManualScore(entry.num, "deduction") ?? "");
    return row;
  });

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "성적표");
  XLSX.writeFile(wb, `성적표_${selectedYear.value}.${format === "csv" ? "csv" : "xlsx"}`);
}
</script>

<template>
  <div class="score-page">
    <div class="top-row">
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
        <div class="filter-group type-filter-gap">
          <label class="filter-label">필터</label>
          <label class="filter-checkbox">
            <input type="checkbox" v-model="showInspection" />
            <span>검차</span>
          </label>
        </div>
        <div class="filter-group type-filter-gap" v-if="vehicleTypes.length > 1">
          <label class="filter-label">유형</label>
          <div class="type-filter-group">
            <label v-for="t in vehicleTypes" :key="t" class="filter-checkbox">
              <input type="checkbox" v-model="typeFilters[t]" />
              <span class="badge" :class="'badge-type-' + getTypeColor(t)">{{ t }}</span>
            </label>
          </div>
        </div>
        <div class="filter-group type-filter-gap">
          <label class="filter-label">표시</label>
          <div class="mode-toggle">
            <button class="mode-btn" :class="{ active: displayMode === 'record' }" @click="displayMode = 'record'">기록</button>
            <button class="mode-btn" :class="{ active: displayMode === 'score' }" @click="displayMode = 'score'">점수</button>
          </div>
        </div>
        <div class="filter-group action-group">
          <label class="filter-label">&nbsp;</label>
          <div class="action-buttons">
            <button class="action-link" @click="exportData('csv')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>CSV</button>
            <button class="action-link" @click="exportData('xlsx')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>XLSX</button>
            <router-link to="/endurance" class="action-link nav-link">내구 입력</router-link>
          </div>
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
                  :class="{ sortable: isOverriddenCategory(cat.id) }"
                  v-show="showInspection"
                  @click="isOverriddenCategory(cat.id) && handleSort(getOverrideKey(cat.id))"
                >{{ cat.name }} <span v-if="isOverriddenCategory(cat.id)" class="sort-icon">{{ getSortIcon(getOverrideKey(cat.id)) }}</span></th>
                <th class="col-total sortable" @click="handleSort('totalScore')">총점 <span class="sort-icon">{{ getSortIcon('totalScore') }}</span></th>
                <th
                  v-for="evt in dynamicEvents"
                  :key="'h-evt-'+evt.type"
                  class="col-event sortable"
                  @click="handleSort('event:' + evt.type)"
                >{{ evt.type }} <span class="sort-icon">{{ getSortIcon('event:' + evt.type) }}</span></th>
                <th class="col-event sortable" @click="handleSort('event:내구')">내구 <span class="sort-icon">{{ getSortIcon('event:내구') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('report')">보고서 <span class="sort-icon">{{ getSortIcon('report') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('energy')">에너지 <span class="sort-icon">{{ getSortIcon('energy') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('bonus')">가점 <span class="sort-icon">{{ getSortIcon('bonus') }}</span></th>
                <th class="col-manual sortable" @click="handleSort('deduction')">감점 <span class="sort-icon">{{ getSortIcon('deduction') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="entry in entryList" :key="entry.num">
              <tr class="team-row" :class="{ 'expanded-row': detailExpandedTeam === entry.num }" @click="handleRowClick(entry.num, $event)">
                  <td class="col-num"><span class="entry-num">{{ entry.num }}</span></td>
                  <td class="col-team">{{ entry.univ }} {{ entry.team }}</td>
                  <td class="col-type"><span class="badge" :class="'badge-type-' + getTypeColor(entry.type)" v-if="entry.type">{{ entry.type }}</span></td>
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
                          <template v-if="getFRRatio(entry.num)">
                            <hr class="cw-divider">
                            <div class="cw-cell"><span class="cw-label">F</span><span class="cw-val">{{ getFRRatio(entry.num).front }}%</span></div>
                            <div class="cw-cell"><span class="cw-label">R</span><span class="cw-val">{{ getFRRatio(entry.num).rear }}%</span></div>
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
                  <td class="col-total">
                    <span class="total-value">{{ getTotalScore(entry.num) }}</span>
                  </td>
                  <td
                    v-for="evt in dynamicEvents"
                    :key="'evt-'+evt.type+'-'+entry.num"
                    class="col-event"
                  >
                    <template v-if="displayMode === 'record'">
                      <span
                        v-if="getAdjustedResult(evt.type, getTeamEvent(evt, entry.num)) != null"
                        class="record-value"
                        :class="{ dnf: getAdjustedResult(evt.type, getTeamEvent(evt, entry.num)) === -1 }"
                      >{{ formatResult(getAdjustedResult(evt.type, getTeamEvent(evt, entry.num))) }}</span>
                      <span v-else class="record-value dns">-</span>
                    </template>
                    <template v-else>
                      <span v-if="getEventScore(evt.type, entry.num) != null" class="score-value">{{ getEventScore(evt.type, entry.num) }}</span>
                      <span v-else class="record-value dns">-</span>
                    </template>
                  </td>
                  <td class="col-event">
                    <template v-if="displayMode === 'record'">
                      <span
                        v-if="getAdjustedResult('내구', getTeamEvent(enduranceEvent, entry.num)) != null"
                        class="record-value"
                        :class="{ dnf: getAdjustedResult('내구', getTeamEvent(enduranceEvent, entry.num)) === -1 }"
                      >{{ formatResult(getAdjustedResult('내구', getTeamEvent(enduranceEvent, entry.num))) }}</span>
                      <span v-else class="record-value dns">-</span>
                    </template>
                    <template v-else>
                      <span v-if="getEventScore('내구', entry.num) != null" class="score-value">{{ getEventScore('내구', entry.num) }}</span>
                      <span v-else class="record-value dns">-</span>
                    </template>
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
                  <td class="col-manual">
                    <input
                      class="manual-input"
                      type="number"
                      :value="getManualScore(entry.num, 'bonus')"
                      :readonly="isReadOnly"
                      @blur="handleManualSave(entry.num, 'bonus', $event.target.value)"
                      @keyup.enter="$event.target.blur()"
                      placeholder="-"
                    />
                  </td>
                  <td class="col-manual">
                    <input
                      class="manual-input"
                      type="number"
                      :value="getManualScore(entry.num, 'deduction')"
                      :readonly="isReadOnly"
                      @blur="handleManualSave(entry.num, 'deduction', $event.target.value)"
                      @keyup.enter="$event.target.blur()"
                      placeholder="-"
                    />
                  </td>
              </tr>
              <tr v-if="detailExpandedTeam === entry.num" class="detail-row">
                <td :colspan="totalColumns">
                  <div class="detail-content" v-if="hasAnyRuns(entry.num)">
                    <table class="detail-runs-table">
                      <thead>
                        <tr>
                          <th>종목</th>
                          <th>시각</th>
                          <th>기록</th>
                          <th>콘터치</th>
                          <th>코스 이탈</th>
                          <th>최종</th>
                          <th>
                            <div class="detail-sort-toggle" @click.stop>
                              <button class="detail-sort-btn" :class="{ active: detailSortMode === 'time' }" @click="detailSortMode = 'time'">시간순</button>
                              <button class="detail-sort-btn" :class="{ active: detailSortMode === 'score' }" @click="detailSortMode = 'score'">성적순</button>
                            </div>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <template v-for="evt in allEvents" :key="evt.type">
                          <tr
                            v-for="(run, idx) in getSortedRuns(evt.type, entry.num)"
                            :key="evt.type + '-' + idx"
                            :data-evt-group="entry.num + ':' + evt.type"
                            :class="{ 'run-best': !run.invalidated && run.origIndex === getBestRunIndex(evt.type, entry.num), 'evt-first-row': idx === 0 }"
                            @mouseenter="hoveredEvtGroup = entry.num + ':' + evt.type"
                            @mouseleave="hoveredEvtGroup = null"
                          >
                            <td v-if="idx === 0" class="col-evt-type" :class="{ 'evt-group-hover': hoveredEvtGroup === entry.num + ':' + evt.type }" :rowspan="getSortedRuns(evt.type, entry.num).length">{{ evt.type }}</td>
                            <td :class="{ 'run-invalidated': run.invalidated }">{{ run.time ? formatTime(run.time) : '-' }}</td>
                            <td class="run-time" :class="{ 'run-invalidated': run.invalidated, 'run-dnf': run.result === -1 }">{{ run.result != null && run.result >= 0 ? formatResult(run.result) : (run.result === -1 ? 'DNF' : '-') }}</td>
                            <td :class="{ 'run-invalidated': run.invalidated }">{{ run.cones || 0 }}</td>
                            <td :class="{ 'run-invalidated': run.invalidated }">{{ run.oc || 0 }}</td>
                            <td class="run-time" :class="{ 'run-invalidated': run.invalidated }">{{ !run.invalidated && run.result != null && run.result >= 0 ? formatResult(getRunAdjusted(evt.type, run)) : '-' }}</td>
                            <td :class="{ 'run-invalidated': run.invalidated }">
                              <span v-if="!run.invalidated && run.origIndex === getBestRunIndex(evt.type, entry.num)" class="badge badge-success">최고</span>
                              <span v-else-if="run.invalidated" class="badge badge-danger">무효</span>
                            </td>
                          </tr>
                        </template>
                      </tbody>
                    </table>
                  </div>
                  <div v-else class="detail-empty">경기 기록이 없습니다</div>
                </td>
              </tr>
              </template>
              <tr v-if="entryList.length === 0">
                <td :colspan="9 + inspection.categories.length + dynamicEvents.length" class="empty-state">
                  {{ loading ? "데이터를 불러오는 중..." : "팀 데이터가 없습니다." }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 페널티 + 점수 설정 -->
    <div class="bottom-row" v-if="events.length > 0">
      <div class="card setting-card">
        <div class="card-body table-body">
          <div class="table-container">
            <table class="data-table setting-table">
              <thead>
                <tr>
                  <th class="col-setting-label">페널티 (초)</th>
                  <th v-for="evt in dynamicEvents" :key="'penalty-h-'+evt.type" class="col-setting-value">{{ evt.type }}</th>
                  <th class="col-setting-value">내구</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="{ field, label } in [{ field: 'cone_penalty', label: '콘터치' }, { field: 'oc_penalty', label: '코스이탈' }, { field: 'start_delay', label: '출발지연' }]" :key="field">
                  <td class="col-setting-label">{{ label }}</td>
                  <template v-for="evtType in [...dynamicEvents.map(e => e.type), '내구']" :key="'p-'+field+'-'+evtType">
                    <td class="col-setting-value setting-cell" @click="startSettingEdit('p:'+field+':'+evtType)">
                      <input
                        v-if="editingSettingCell === 'p:'+field+':'+evtType"
                        :ref="settingInputRef"
                        class="setting-input"
                        type="number"
                        step="any"
                        min="0"
                        :value="getPenalty(evtType, field)"
                        @blur="handlePenaltySave(evtType, field, $event.target.value)"
                        @keyup.enter="$event.target.blur()"
                      />
                      <span v-else class="setting-text">{{ getPenalty(evtType, field) || 0 }}</span>
                    </td>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="card setting-card">
        <div class="card-body table-body">
          <div class="table-container">
            <table class="data-table setting-table">
              <thead>
                <tr>
                  <th class="col-setting-label">점수</th>
                  <th v-for="evt in dynamicEvents" :key="'score-h-'+evt.type" class="col-setting-value">{{ evt.type }}</th>
                  <th class="col-setting-value">내구</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="{ key, label } in [{ key: 'total', label: '총점' }, { key: 'finish', label: '완주점수' }, { key: 'cutoff', label: '컷오프 (%)' }]" :key="key">
                  <td class="col-setting-label">{{ label }}</td>
                  <template v-for="evtType in [...dynamicEvents.map(e => e.type), '내구']" :key="'s-'+key+'-'+evtType">
                    <td class="col-setting-value setting-cell" @click="startSettingEdit('s:'+key+':'+evtType)">
                      <input
                        v-if="editingSettingCell === 's:'+key+':'+evtType"
                        :ref="settingInputRef"
                        class="setting-input"
                        type="number"
                        step="any"
                        min="0"
                        :value="getSetting(evtType, key)"
                        @blur="handleSettingSave(evtType, key, $event.target.value)"
                        @keyup.enter="$event.target.blur()"
                      />
                      <span v-else class="setting-text">{{ getSetting(evtType, key) ?? '-' }}</span>
                    </td>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>
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

.top-row {
  display: flex;
  gap: 1rem;
  align-items: stretch;
}

.top-row > .filter-bar {
  flex: 1;
  min-width: 0;
  align-items: center;
  align-content: center;
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
  font-size: 0.875rem;
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
  font-size: 0.875rem;
}

.col-type,
.col-inspection,
.col-event,
.col-manual {
  text-align: center !important;
}

.entry-num {
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
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

.badge-empty {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.col-total {
  text-align: center !important;
  white-space: nowrap;
  width: 1%;
  background: rgba(59, 130, 246, 0.04);
}

.score-table thead .col-total {
  font-weight: 700;
}

.total-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--accent-primary);
}

.record-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--accent-success);
}

.record-value.dnf {
  color: var(--accent-danger);
}

.record-value.dns {
  color: var(--text-tertiary);
  font-weight: 400;
}

.type-filter-gap {
  margin-left: 1rem;
}

.type-filter-group {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  height: 2.125rem;
}

.action-group {
  margin-left: auto;
}

.action-buttons {
  display: flex;
  gap: 0.375rem;
  height: 2.125rem;
}

/* Mode toggle */
.mode-toggle {
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  height: 2.125rem;
}

.mode-btn {
  padding: 0 0.75rem;
  border: none;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-btn + .mode-btn {
  border-left: 1px solid var(--border-color);
}

.mode-btn.active {
  background: var(--accent-primary);
  color: white;
}

.action-link {
  display: inline-flex;
  align-items: center;
  padding: 0 0.75rem;
  height: 100%;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-link:hover {
  background: var(--accent-primary);
  color: white;
  border-color: var(--accent-primary);
}

.nav-link {
  width: 5.5rem;
  justify-content: center;
}

.action-icon {
  width: 14px;
  height: 14px;
  margin-right: 0.25rem;
  flex-shrink: 0;
}

.score-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--accent-primary);
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
  height: 2.125rem;
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
  font-size: 0.875rem;
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
  font-size: 0.875rem;
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
  font-size: 0.875rem;
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

/* Bottom row: penalty + score settings */
.bottom-row {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}

.bottom-row > .setting-card {
  flex: 1;
  min-width: 0;
}

.setting-table {
  min-width: 0;
}

.col-setting-label {
  white-space: nowrap;
}

.setting-table thead .col-setting-label {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.setting-table tbody .col-setting-label {
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.col-setting-value {
  text-align: center !important;
  white-space: nowrap;
}

.setting-input {
  width: 3.5rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
}

.setting-input:focus {
  border-color: var(--accent-primary);
}

.setting-input::placeholder {
  color: var(--text-tertiary);
}

.setting-input::-webkit-outer-spin-button,
.setting-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.setting-cell {
  cursor: pointer;
}

.setting-cell:hover {
  background: var(--bg-hover);
}

.setting-text {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
}


/* Team row expandable */
.team-row {
  cursor: pointer;
}

.team-row:hover {
  background: var(--bg-hover);
}

.expanded-row {
  background: rgba(59, 130, 246, 0.04);
}

.expanded-row .col-num {
  background: rgba(59, 130, 246, 0.04);
}

/* Detail row */
.detail-row {
  background: var(--bg-secondary);
}

.detail-row:hover {
  background: var(--bg-secondary);
}

.detail-row > td {
  padding: 1.5rem 0 !important;
}

.detail-row .detail-content,
.detail-row .detail-empty {
  position: sticky;
  left: 0;
  width: 100vw;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 2rem;
  box-sizing: border-box;
}

.detail-sort-toggle {
  display: inline-flex;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}

.detail-sort-btn {
  padding: 0.125rem 0.5rem;
  border: none;
  background: var(--bg-input);
  color: var(--text-tertiary);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.detail-sort-btn + .detail-sort-btn {
  border-left: 1px solid var(--border-color);
}

.detail-sort-btn.active {
  background: var(--accent-primary);
  color: white;
}

.detail-runs-table {
  border-collapse: collapse;
  font-size: 0.875rem;
}

.detail-runs-table th,
.detail-runs-table td {
  padding: 0.375rem 1rem;
  text-align: center;
  white-space: nowrap;
  border-bottom: 1px solid var(--border-color);
}

.detail-runs-table .evt-first-row td {
  border-top: 2px solid var(--border-color);
}

.detail-runs-table .evt-first-row .col-evt-type {
  border-top: 2px solid var(--border-color);
}

.detail-runs-table th {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-tertiary);
}

.detail-runs-table .col-evt-type {
  font-weight: 600;
  color: var(--text-secondary);
  border-right: 1px solid var(--border-color);
  vertical-align: middle;
}

.detail-runs-table .col-evt-type.evt-group-hover {
  background: var(--bg-hover);
}

.detail-runs-table .run-time,
.detail-runs-table .run-event-time {
  font-family: "JetBrains Mono", monospace;
  font-weight: 500;
}

.run-best td:not(.col-evt-type) {
  background: rgba(34, 197, 94, 0.08);
}

td.run-invalidated {
  opacity: 0.45;
  text-decoration: line-through;
}

td.run-dnf {
  color: var(--accent-danger);
  font-weight: 700;
}

.detail-empty {
  text-align: center;
  color: var(--text-tertiary);
  padding: 1rem;
  font-size: 0.9375rem;
}

@media (max-width: 640px) {
  .top-row,
  .bottom-row {
    flex-direction: column;
  }

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
