<script setup>
import { ref, computed, watch, onMounted, onActivated, onDeactivated } from "vue";
import {
  fetchRecord,
  fetchControllers,
  deleteRecord,
  deleteControllers,
  updateRecord,
  addRecord,
  toggleEventMode,
  toggleRecordVisibility,
} from "../composables/useApi";
import { EVENT_TYPES } from "@shared/constants.js";
import { useNotification } from "@shared/useNotification.js";
import { useSSE } from "../composables/useSSE";
import { useEntryStore } from "../stores/entry";
import { msToClockStr } from "../stores/serial";
import { useRoute } from "vue-router";


const { notyf } = useNotification();
const route = useRoute();
// 같은 RecordView를 유선(/record)·무선(/wireless/record) 양쪽에서 쓰고, 토글 버튼만 방향을 바꾼다.
const measureToggle = computed(() =>
  route.path.startsWith("/wireless")
    ? { to: "/record", label: "🔌 유선 계측" }
    : { to: "/wireless/record", label: "📡 무선 계측" },
);
const { recordFiles, selectedFile, lastUpdate, eventModes, recordVisibility } = useSSE();
const entryStore = useEntryStore();

const records = ref([]);
const loading = ref(false);
const sortKey = ref("time");
const sortOrder = ref("desc");

// 수동 기록 추가 폼 상태
const showAddForm = ref(false);
const addType = ref(EVENT_TYPES[0]);
const addEntry = ref(null);
const addResult = ref("");
const addDetail = ref("");

// 인라인 편집 상태
const editingDetailId = ref(null);
const editingConesId = ref(null);
const editingOcId = ref(null);

// 유형 필터 (기본: 모두 선택)
const typeFilters = ref({
  ...Object.fromEntries(EVENT_TYPES.map(t => [t, true])),
});

// keep-alive 활성 상태 추적
const isActive = ref(true);
const missedUpdate = ref(false);
let fetchSeq = 0;

// 컴포넌트 마운트 시 엔트리 로드 및 이전에 선택한 파일이 있으면 로드
onMounted(() => {
  if (!entryStore.isLoaded) entryStore.loadEntries();
  if (selectedFile.value) {
    loadRecords();
  }
});

onActivated(() => {
  isActive.value = true;
  if (missedUpdate.value) {
    missedUpdate.value = false;
    refreshRecords();
  }
});

onDeactivated(() => {
  isActive.value = false;
  editingDetailId.value = null;
  editingConesId.value = null;
  editingOcId.value = null;
});

const isControllerLog = computed(() => selectedFile.value === "controller");

function updateMatchesSelectedFile(update) {
  if (!selectedFile.value || selectedFile.value === "controller") return false;
  if (update.name) return update.name === selectedFile.value;
  if (update.year) return selectedFile.value.startsWith(`FSK ${update.year} `);
  return false;
}

// 필터링된 레코드
const filteredRecords = computed(() => {
  if (isControllerLog.value) return records.value;
  return records.value.filter((r) => typeFilters.value[r.type]);
});

const sortedRecords = computed(() => {
  if (!sortKey.value || !filteredRecords.value.length) return filteredRecords.value;

  return [...filteredRecords.value].sort((a, b) => {
    let aVal = a[sortKey.value];
    let bVal = b[sortKey.value];

    // 시간 필드 처리
    if (sortKey.value === "time" || sortKey.value === "timestamp") {
      aVal = new Date(aVal).getTime();
      bVal = new Date(bVal).getTime();
    }
    // 숫자 필드 처리
    else if (["num", "result", "cones", "oc"].includes(sortKey.value)) {
      aVal = Number(aVal) || 0;
      bVal = Number(bVal) || 0;
    }
    // 문자열 필드 처리
    else {
      aVal = String(aVal || "").toLowerCase();
      bVal = String(bVal || "").toLowerCase();
    }

    if (aVal < bVal) return sortOrder.value === "asc" ? -1 : 1;
    if (aVal > bVal) return sortOrder.value === "asc" ? 1 : -1;
    return 0;
  });
});

function isEditingRow(rowid) {
  return editingDetailId.value === rowid || editingConesId.value === rowid || editingOcId.value === rowid;
}

// 편집 종료 시 호출: 편집 중 보류된 SSE 갱신이 있고 그 행 편집이 끝났으면 데이터 재동기.
// (낙관적 저장 PATCH 완료 후에 호출해야 refetch가 방금 저장분을 포함 — 레이스 없음.)
function flushMissedUpdate(rowid) {
  if (missedUpdate.value && !isEditingRow(rowid)) {
    missedUpdate.value = false;
    refreshRecords();
  }
}

// SSE 업데이트 시 부분 갱신 (편집 보호, 비활성 시 defer)
watch(lastUpdate, (update) => {
  if (!update || !updateMatchesSelectedFile(update)) return;

  if (!isActive.value) {
    missedUpdate.value = true;
    return;
  }

  if (update.type === "add" && update.record) {
    // rowid 중복 방어: 로컬 refetch와 add SSE가 겹치면 같은 행이 두 번 들어올 수 있다.
    if (!records.value.some((r) => r.rowid === update.record.rowid)) {
      records.value = [...records.value, update.record];
    }
  } else if (update.type === "update" && update.record) {
    if (isEditingRow(update.record.rowid)) {
      missedUpdate.value = true;
      return;
    }
    const idx = records.value.findIndex((r) => r.rowid === update.record.rowid);
    if (idx !== -1) {
      records.value[idx] = { ...records.value[idx], ...update.record };
      records.value = [...records.value];
    } else {
      refreshRecords();
    }
  } else if (update.type === "delete") {
    if (!recordFiles.value.includes(selectedFile.value)) {
      selectedFile.value = null;
      records.value = [];
    }
  } else {
    refreshRecords();
  }
});

// 데이터만 갱신 (정렬 상태 유지, fetch 순서 역전 방지)
async function refreshRecords() {
  if (!selectedFile.value) return;
  const seq = ++fetchSeq;
  try {
    const data = selectedFile.value === "controller"
      ? await fetchControllers()
      : await fetchRecord(selectedFile.value);
    if (seq === fetchSeq) records.value = data;
  } catch (e) {
    if (seq === fetchSeq) notyf.error(`기록을 불러오지 못했습니다.`);
  }
}

// 파일 선택 시 데이터 로드 (정렬 상태 초기화, fetch 순서 역전 방지)
async function loadRecords() {
  if (!selectedFile.value) return;
  loading.value = true;
  sortKey.value = "time";
  sortOrder.value = "desc";
  const seq = ++fetchSeq;
  try {
    const data = selectedFile.value === "controller"
      ? await fetchControllers()
      : await fetchRecord(selectedFile.value);
    if (seq === fetchSeq) records.value = data;
  } catch (e) {
    if (seq === fetchSeq) {
      notyf.error(`기록을 불러오지 못했습니다.`);
      records.value = [];
    }
  } finally {
    if (seq === fetchSeq) loading.value = false;
  }
}

async function handleDelete() {
  if (!selectedFile.value) return;
  if (!confirm(`"${selectedFile.value}" 기록을 삭제하시겠습니까?`)) return;

  try {
    if (isControllerLog.value) {
      await deleteControllers();
    } else {
      await deleteRecord(selectedFile.value);
    }
    notyf.success("기록이 삭제되었습니다.");
    selectedFile.value = null;
    records.value = [];
  } catch (e) {
    notyf.error(`삭제 실패: ${e.message}`);
  }
}

function downloadCSV() {
  if (!sortedRecords.value.length) return;

  let headers, rows;
  if (isControllerLog.value) {
    headers = ["시간", "데이터"];
    rows = sortedRecords.value.map((r) => [formatTime(r.timestamp), r.data]);
  } else {
    headers = ["시간", "엔트리", "팀", "경기", "기록", "콘터치", "코스 이탈", "상세", "무효화", "전광판"];
    rows = sortedRecords.value.map((r) => [
      formatTime(r.time),
      r.num,
      `${r.univ} ${r.team}`,
      r.type,
      formatResult(r.result),
      r.cones || 0,
      r.oc || 0,
      r.detail || "",
      r.invalidated ? "Y" : "N",
      r.scoreboard ? "Y" : "N",
    ]);
  }

  // CSV 셀: 수식 인젝션 방지 — =,+,-,@,tab,CR로 시작하면 텍스트 마커(')를 접두.
  const csvCell = (cell) => {
    let s = String(cell ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csvContent = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, `${selectedFile.value}.csv`);
}

async function downloadXLSX() {
  if (!sortedRecords.value.length) return;

  let headers, rows;

  if (isControllerLog.value) {
    headers = ["시간", "데이터"];
    rows = sortedRecords.value.map((r) => [formatTime(r.timestamp), r.data]);
  } else {
    headers = ["시간", "엔트리", "팀", "경기", "기록", "콘터치", "코스 이탈", "상세", "무효화", "전광판"];
    rows = sortedRecords.value.map((r) => [
      formatTime(r.time),
      r.num,
      `${r.univ} ${r.team}`,
      r.type,
      formatResult(r.result),
      r.cones || 0,
      r.oc || 0,
      r.detail || "",
      r.invalidated ? "Y" : "N",
      r.scoreboard ? "Y" : "N",
    ]);
  }

  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Records");

  ws.addRow(headers);
  ws.addRows(rows);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(blob, `${selectedFile.value}.xlsx`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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

function formatTime(time) {
  return new Date(time).toLocaleString("ko-KR");
}

function formatResult(result) {
  if (result < 0) return "DNF";
  return msToClockStr(result);
}

const typeMap = { [EVENT_TYPES[0]]: "accel", [EVENT_TYPES[1]]: "skidpad", [EVENT_TYPES[2]]: "autocross", [EVENT_TYPES[3]]: "endurance" };

function getTypeClass(type) {
  return typeMap[type] || type;
}

function applyUpdateResult(record, result) {
  const idx = records.value.findIndex((r) => r.rowid === record.rowid);
  if (idx !== -1) {
    records.value[idx].invalidated = result.invalidated;
    records.value[idx].scoreboard = result.scoreboard;
  }
}

async function handleInvalidate(record) {
  try {
    const result = await updateRecord(selectedFile.value, record.rowid, "invalidated");
    applyUpdateResult(record, result);
  } catch (e) {
    notyf.error(`무효화 실패: ${e.message}`);
  }
}

// 내구 기록의 detail은 랩 목록 문자열("MM:SS.mmm / ..."). 요약 표시 + 클릭 팝업용으로 파싱.
const ENDURANCE_TYPE = "내구";
const lapPopup = ref(null); // { num, team, laps[], count, best, bestIdx, avg, total } | null
function clockToMs(s) {
  const m = /^(\d+):(\d{2})\.(\d{3})$/.exec((s || "").trim());
  return m ? (+m[1]) * 60000 + (+m[2]) * 1000 + (+m[3]) : null;
}
function enduranceStats(record) {
  if (record.type !== ENDURANCE_TYPE || !record.detail) return null;
  const laps = record.detail.split("/").map(clockToMs).filter((n) => n != null);
  if (!laps.length) return null;
  let best = laps[0], bestIdx = 0, sum = 0;
  laps.forEach((ms, i) => { sum += ms; if (ms < best) { best = ms; bestIdx = i; } });
  return { laps, count: laps.length, best, bestIdx: bestIdx + 1, avg: Math.round(sum / laps.length), total: sum };
}
// 내구 detail 셀 요약: "Best: MM:SS.mmm (#최고랩번호/총랩수)". 파싱 실패 시 원문 폴백.
function enduranceSummary(record) {
  const s = enduranceStats(record);
  return s ? `Best: ${msToClockStr(s.best)} (#${s.bestIdx}/${s.count})` : (record.detail || "");
}
// 내구 detail 셀 클릭: 인라인 편집 대신 랩 목록 팝업. 그 외 종목은 기존 인라인 편집.
function onDetailCellClick(record) {
  if (record.type === ENDURANCE_TYPE) openLapPopup(record);
  else startDetailEdit(record.rowid);
}
function openLapPopup(record) {
  const s = enduranceStats(record);
  if (!s) return;
  lapPopup.value = { num: record.num, team: `${record.univ} ${record.team}`, ...s };
}
function closeLapPopup() { lapPopup.value = null; }

function startDetailEdit(rowid) {
  editingDetailId.value = rowid;
}

function detailInputRef(el) {
  if (el) el.focus();
}

async function handleDetailChange(record, value) {
  editingDetailId.value = null;
  if (value !== (record.detail || '')) {
    try {
      const result = await updateRecord(selectedFile.value, record.rowid, "detail", value);
      const idx = records.value.findIndex((r) => r.rowid === record.rowid);
      if (idx !== -1) {
        records.value[idx].detail = result.detail;
      }
    } catch (e) {
      notyf.error(`상세 저장 실패: ${e.message}`);
    }
  }
  // 쓰기 완료 후에 편집 중 보류된 SSE 갱신 반영(refetch가 방금 저장분을 포함 → 레이스 없음).
  flushMissedUpdate(record.rowid);
}

function startConesEdit(rowid) {
  editingConesId.value = rowid;
}

function conesInputRef(el) {
  if (el) { el.focus(); el.select(); }
}

async function handleConesChange(record, value) {
  editingConesId.value = null;
  const numValue = parseInt(value, 10) || 0;
  if (numValue !== (record.cones || 0)) {
    try {
      const result = await updateRecord(selectedFile.value, record.rowid, "cones", String(numValue));
      const idx = records.value.findIndex((r) => r.rowid === record.rowid);
      if (idx !== -1) {
        records.value[idx].cones = result.cones;
      }
    } catch (e) {
      notyf.error(`콘터치 저장 실패: ${e.message}`);
    }
  }
  flushMissedUpdate(record.rowid);
}

function startOcEdit(rowid) {
  editingOcId.value = rowid;
}

function ocInputRef(el) {
  if (el) { el.focus(); el.select(); }
}

async function handleOcChange(record, value) {
  editingOcId.value = null;
  const numValue = parseInt(value, 10) || 0;
  if (numValue !== (record.oc || 0)) {
    try {
      const result = await updateRecord(selectedFile.value, record.rowid, "oc", String(numValue));
      const idx = records.value.findIndex((r) => r.rowid === record.rowid);
      if (idx !== -1) {
        records.value[idx].oc = result.oc;
      }
    } catch (e) {
      notyf.error(`코스 이탈 저장 실패: ${e.message}`);
    }
  }
  flushMissedUpdate(record.rowid);
}

async function handleScoreboardToggle(record) {
  try {
    const result = await updateRecord(selectedFile.value, record.rowid, "scoreboard");
    applyUpdateResult(record, result);
  } catch (e) {
    notyf.error(`전광판 설정 실패: ${e.message}`);
  }
}

async function handleToggleVisibility() {
  if (!selectedFile.value || isControllerLog.value) return;
  try {
    await toggleRecordVisibility(selectedFile.value);
  } catch (e) {
    notyf.error(`성적 반영 변경 실패: ${e.message}`);
  }
}

async function handleToggleEventMode(eventType) {
  try {
    await toggleEventMode(eventType);
  } catch (e) {
    notyf.error(`경기 모드 변경 실패: ${e.message}`);
  }
}

async function handleAddRecord() {
  if (!selectedFile.value || !addEntry.value) return;

  const entry = entryStore.getEntryByNum(addEntry.value);
  if (!entry) {
    notyf.error("엔트리를 찾을 수 없습니다.");
    return;
  }

  const resultValue = Number(addResult.value);
  if (isNaN(resultValue)) {
    notyf.error("기록은 숫자로 입력해야 합니다.");
    return;
  }

  try {
    // 서버가 "FSK {year} " 접두사를 자동으로 붙이므로 제거
    const nameForApi = selectedFile.value.replace(/^FSK \d{4} /, "");
    await addRecord(nameForApi, {
      time: new Date().toISOString(),
      type: addType.value,
      entry: { num: entry.num, univ: entry.univ, team: entry.team },
      result: resultValue,
      detail: addDetail.value ? `${addDetail.value} (수동)` : "(수동)",
    });
    notyf.success("기록이 추가되었습니다.");
    // 폼 초기화
    addType.value = EVENT_TYPES[0];
    addEntry.value = null;
    addResult.value = "";
    addDetail.value = "";
    showAddForm.value = false;
  } catch (e) {
    notyf.error(`기록 추가 실패: ${e.message}`);
  }
}
</script>

<template>
  <div class="page-layout">
    <!-- 경기 모드 활성화/비활성화 -->
    <section class="event-mode-card">
      <div class="card-header record-header-row">
        <h3>경기 모드 활성화</h3>
        <router-link :to="measureToggle.to" class="wireless-switch" data-testid="wireless-switch">{{ measureToggle.label }}</router-link>
      </div>
      <div class="event-mode-body">
        <button
          v-for="(enabled, type) in eventModes"
          :key="type"
          class="event-mode-btn"
          :class="[getTypeClass(type), { disabled: !enabled }]"
          @click="handleToggleEventMode(type)"
        >{{ type }}</button>
      </div>
    </section>


    <section class="content">
      <!-- 파일 선택 툴바 -->
      <div class="file-toolbar">
        <div class="toolbar-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="toolbar-icon">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <select v-model="selectedFile" class="form-select" @change="loadRecords">
            <option disabled :value="null">파일을 선택하세요</option>
            <option v-for="file in recordFiles" :key="file" :value="file">{{ file }}</option>
          </select>
        </div>
        <div v-if="records.length" class="toolbar-right">
          <button class="btn btn-secondary" @click="downloadCSV" title="CSV 다운로드">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            CSV
          </button>
          <button class="btn btn-secondary" @click="downloadXLSX" title="Excel 다운로드">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            XLSX
          </button>
          <button
            v-if="!isControllerLog"
            class="btn-visibility"
            :class="{ active: recordVisibility[selectedFile] !== false }"
            @click="handleToggleVisibility"
            :title="recordVisibility[selectedFile] !== false ? '성적에 반영 중' : '성적에 미반영'"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <path v-if="recordVisibility[selectedFile] !== false" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle v-if="recordVisibility[selectedFile] !== false" cx="12" cy="12" r="3" /><line v-if="recordVisibility[selectedFile] === false" x1="1" y1="1" x2="23" y2="23" /><path v-if="recordVisibility[selectedFile] === false" d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
            </svg>
            성적 반영
          </button>
          <button v-if="!isControllerLog" class="btn btn-primary" @click="showAddForm = !showAddForm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            기록 추가
          </button>
          <button class="btn btn-danger" @click="handleDelete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
            전체 삭제
          </button>
        </div>
      </div>

      <div class="table-header">
        <div class="table-title-area">
          <h2>{{ selectedFile || "기록" }}</h2>
          <span v-if="filteredRecords.length" class="entry-count">{{ filteredRecords.length }}개</span>
        </div>
        <div v-if="records.length && !isControllerLog" class="type-filters">
          <label v-for="t in EVENT_TYPES" :key="t" class="filter-checkbox">
            <input type="checkbox" v-model="typeFilters[t]" />
            <span class="filter-label" :class="typeMap[t]">{{ t }}</span>
          </label>
        </div>
      </div>

      <!-- 수동 기록 추가 폼 -->
      <div v-if="showAddForm && !isControllerLog" class="add-form">
        <div class="add-form-fields">
          <div class="form-group">
            <label class="form-label">경기 유형</label>
            <select v-model="addType" class="form-select">
              <option v-for="t in EVENT_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">엔트리</label>
            <select v-model="addEntry" class="form-select">
              <option disabled :value="null">선택</option>
              <option v-for="e in entryStore.entries" :key="e.num" :value="e.num">
                {{ e.num }} {{ e.univ }} {{ e.team }}
              </option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">기록 (ms)</label>
            <input
              v-model="addResult"
              type="number"
              class="form-input"
              placeholder="밀리초 (-1 = DNF)"
            />
          </div>
          <div class="form-group">
            <label class="form-label">상세</label>
            <input
              v-model="addDetail"
              type="text"
              class="form-input"
              placeholder="선택 사항"
            />
          </div>
          <button class="btn btn-primary add-form-submit" @click="handleAddRecord" :disabled="!addEntry || addResult === ''">
            추가
          </button>
        </div>
      </div>

      <div v-if="loading" class="loading-container">
        <div class="loading-spinner"></div>
        <p>데이터를 불러오는 중...</p>
      </div>

      <div v-else-if="records.length > 0" class="table-wrapper">
        <!-- 컨트롤러 로그 테이블 -->
        <table v-if="isControllerLog" class="data-table">
          <thead>
            <tr>
              <th class="sortable" @click="handleSort('timestamp')">
                시간 <span class="sort-icon">{{ getSortIcon("timestamp") }}</span>
              </th>
              <th class="sortable" @click="handleSort('data')">
                데이터 <span class="sort-icon">{{ getSortIcon("data") }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(record, index) in sortedRecords" :key="index">
              <td class="time-cell">{{ formatTime(record.timestamp) }}</td>
              <td class="controller-data">{{ record.data }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 경기 기록 테이블 -->
        <table v-else class="data-table">
          <thead>
            <tr>
              <th class="sortable" @click="handleSort('time')">
                시간 <span class="sort-icon">{{ getSortIcon("time") }}</span>
              </th>
              <th class="sortable center col-shrink" @click="handleSort('num')">
                번호 <span class="sort-icon">{{ getSortIcon("num") }}</span>
              </th>
              <th class="sortable col-team" @click="handleSort('univ')">
                팀 <span class="sort-icon">{{ getSortIcon("univ") }}</span>
              </th>
              <th class="sortable center col-shrink" @click="handleSort('type')">
                경기 <span class="sort-icon">{{ getSortIcon("type") }}</span>
              </th>
              <th class="sortable center col-shrink" @click="handleSort('result')">
                기록 <span class="sort-icon">{{ getSortIcon("result") }}</span>
              </th>
              <th class="sortable center col-shrink" @click="handleSort('cones')">
                콘터치 <span class="sort-icon">{{ getSortIcon("cones") }}</span>
              </th>
              <th class="sortable center col-shrink" @click="handleSort('oc')">
                코스 이탈 <span class="sort-icon">{{ getSortIcon("oc") }}</span>
              </th>
              <th class="sortable" @click="handleSort('detail')">
                상세 <span class="sort-icon">{{ getSortIcon("detail") }}</span>
              </th>
              <th class="center col-shrink">무효화</th>
              <th class="center col-shrink">전광판</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(record, index) in sortedRecords"
              :key="record.rowid"
              :class="{ 'is-invalidated': record.invalidated }"
            >
              <td class="time-cell">{{ formatTime(record.time) }}</td>
              <td class="center col-shrink">
                <span class="entry-number">{{ record.num }}</span>
              </td>
              <td class="col-team">{{ record.univ }} {{ record.team }}</td>
              <td class="center col-shrink">
                <span class="type-badge" :class="getTypeClass(record.type)">{{ record.type }}</span>
              </td>
              <td class="result-cell center col-shrink" :class="{ 'is-dnf': record.result < 0 }">
                {{ formatResult(record.result) }}
              </td>
              <td class="penalty-cell center col-shrink" @click="startConesEdit(record.rowid)">
                <input
                  v-if="editingConesId === record.rowid"
                  :ref="conesInputRef"
                  class="penalty-input"
                  type="number"
                  min="0"
                  :value="record.cones || 0"
                  @blur="handleConesChange(record, $event.target.value)"
                  @keyup.enter="$event.target.blur()"
                />
                <span v-else class="penalty-text">{{ record.cones || 0 }}</span>
              </td>
              <td class="penalty-cell center col-shrink" @click="startOcEdit(record.rowid)">
                <input
                  v-if="editingOcId === record.rowid"
                  :ref="ocInputRef"
                  class="penalty-input"
                  type="number"
                  min="0"
                  :value="record.oc || 0"
                  @blur="handleOcChange(record, $event.target.value)"
                  @keyup.enter="$event.target.blur()"
                />
                <span v-else class="penalty-text">{{ record.oc || 0 }}</span>
              </td>
              <td class="detail-cell" @click="onDetailCellClick(record)">
                <span
                  v-if="record.type === ENDURANCE_TYPE"
                  class="endurance-summary"
                  title="랩 상세 보기"
                >{{ enduranceSummary(record) }}</span>
                <template v-else>
                  <input
                    v-if="editingDetailId === record.rowid"
                    :ref="detailInputRef"
                    class="detail-input"
                    type="text"
                    :value="record.detail || ''"
                    @blur="handleDetailChange(record, $event.target.value)"
                    @keyup.enter="$event.target.blur()"
                  />
                  <span v-else class="detail-text">{{ record.detail || '' }}</span>
                </template>
              </td>
              <td class="center col-shrink">
                <button
                  class="btn-invalidate"
                  :class="{ active: record.invalidated }"
                  @click="handleInvalidate(record)"
                  :title="record.invalidated ? '복원' : '무효화'"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                  </svg>
                </button>
              </td>
              <td class="center col-shrink">
                <button
                  class="btn-scoreboard"
                  :class="{ active: record.scoreboard }"
                  @click="handleScoreboardToggle(record)"
                  :title="record.scoreboard ? '전광판 숨김' : '전광판 표시'"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="empty-state-container">
        <div class="empty-icon">📂</div>
        <p>기록 파일을 선택하세요</p>
      </div>
    </section>

    <!-- 내구 랩 상세 팝업 -->
    <div v-if="lapPopup" class="lap-popup-overlay" @click.self="closeLapPopup">
      <div class="lap-popup">
        <div class="lap-popup-header">
          <div class="lap-popup-titles">
            <h3>🏁 내구 랩 기록</h3>
            <p class="lap-popup-team">#{{ lapPopup.num }} {{ lapPopup.team }}</p>
          </div>
          <button class="lap-popup-close" title="닫기" @click="closeLapPopup">✕</button>
        </div>
        <div class="lap-popup-stats">
          <div class="lps-item"><span class="lps-k">총 랩</span><span class="lps-v">{{ lapPopup.count }}</span></div>
          <div class="lps-item"><span class="lps-k">최고 랩</span><span class="lps-v">{{ msToClockStr(lapPopup.best) }} (#{{ lapPopup.bestIdx }})</span></div>
          <div class="lps-item"><span class="lps-k">평균 랩</span><span class="lps-v">{{ msToClockStr(lapPopup.avg) }}</span></div>
          <div class="lps-item"><span class="lps-k">총 시간</span><span class="lps-v">{{ msToClockStr(lapPopup.total) }}</span></div>
        </div>
        <div class="lap-popup-list">
          <div
            v-for="(ms, i) in lapPopup.laps"
            :key="i"
            class="lap-popup-row"
            :class="{ best: i + 1 === lapPopup.bestIdx }"
          >
            <span class="lpr-no">Lap {{ i + 1 }}</span>
            <span class="lpr-t">{{ msToClockStr(ms) }}</span>
            <span class="lpr-tag">{{ i + 1 === lapPopup.bestIdx ? 'BEST' : '' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-layout {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* Event Mode Card */
.event-mode-card {
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.event-mode-card .card-header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border-color);
}

.record-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.wireless-switch {
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.4rem 0.85rem;
  white-space: nowrap;
  transition: all 0.2s ease;
}

.wireless-switch:hover {
  background: var(--bg-hover);
}

.event-mode-card .card-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.event-mode-body {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 1rem 1.5rem;
}

.event-mode-btn {
  padding: 0.375rem 0.75rem;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.event-mode-btn.accel {
  background: rgba(94, 106, 210, 0.15);
  color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.event-mode-btn.skidpad {
  background: rgba(245, 158, 11, 0.15);
  color: var(--accent-warning);
  border-color: var(--accent-warning);
}

.event-mode-btn.autocross {
  background: rgba(255, 107, 107, 0.15);
  color: #ff6b6b;
  border-color: #ff6b6b;
}

.event-mode-btn.endurance {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
  border-color: var(--accent-success);
}

.event-mode-btn.disabled {
  background: var(--bg-hover);
  color: var(--text-tertiary);
  border-color: var(--border-color);
  opacity: 0.6;
}

.event-mode-btn:hover {
  opacity: 0.8;
}

.content {
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

/* File Toolbar */
.file-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.toolbar-icon {
  width: 20px;
  height: 20px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.form-select {
  min-width: 240px;
  padding: 0.5rem 0.875rem;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.form-select:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.btn-visibility {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.2s ease;
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.btn-visibility.active {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
  border-color: var(--accent-success);
}

.btn-visibility:hover {
  opacity: 0.8;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  border: none;
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn:hover {
  opacity: 0.9;
}

.btn-icon {
  width: 16px;
  height: 16px;
}

.btn-secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.btn-secondary:hover {
  background: var(--bg-hover);
}

.btn-danger {
  background: var(--accent-danger);
  color: white;
}

.table-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.table-title-area {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.table-title-area h2 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-primary);
}

.entry-count {
  background: var(--accent-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 12px;
  font-family: "JetBrains Mono", monospace;
}

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

.filter-label {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
}

.filter-label.accel {
  background: rgba(94, 106, 210, 0.1);
  color: var(--accent-primary);
}

.filter-label.skidpad {
  background: rgba(245, 158, 11, 0.1);
  color: var(--accent-warning);
}

.filter-label.autocross {
  background: rgba(255, 107, 107, 0.1);
  color: #ff6b6b;
}

.filter-label.endurance {
  background: rgba(16, 185, 129, 0.12);
  color: var(--accent-success);
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem;
  color: var(--text-secondary);
}

.table-wrapper {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.data-table th {
  padding: 0.875rem 1rem;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.data-table th.center,
.data-table td.center {
  text-align: center;
}

.data-table th.sortable {
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}

.data-table th.sortable:hover {
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

.data-table td {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  vertical-align: middle;
  white-space: nowrap;
}

.data-table tbody tr {
  transition: background-color 0.15s ease;
}

.data-table tbody tr:hover {
  background: var(--bg-hover);
}

.time-cell {
  width: 1%;
  white-space: nowrap;
  font-size: 0.875rem;
  color: var(--text-primary);
}

.entry-number {
  font-weight: 700;
  font-size: 1rem;
  font-family: "JetBrains Mono", monospace;
}

.type-badge {
  display: inline-flex;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}

.type-badge.accel {
  background: rgba(94, 106, 210, 0.1);
  color: var(--accent-primary);
}
.type-badge.skidpad {
  background: rgba(245, 158, 11, 0.1);
  color: var(--accent-warning);
}
.type-badge.autocross {
  background: rgba(255, 107, 107, 0.1);
  color: #ff6b6b;
}
.type-badge.endurance {
  background: rgba(16, 185, 129, 0.12);
  color: var(--accent-success);
}

.result-cell {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: var(--accent-success);
}

.result-cell.is-dnf {
  color: var(--accent-danger);
}

.detail-cell {
  color: var(--text-primary);
  font-size: 0.875rem;
  cursor: text;
  /* 긴 detail(내구 랩 목록 등)이 열을 무한정 넓혀 우측 액션 버튼을 밀어내지 않도록 폭을 제한. */
  max-width: 320px;
}

.detail-text {
  display: block;
  min-width: 2em;
  min-height: 1.25em;
  max-width: 320px;
  /* 길면 가로로 늘어나지 않고 줄바꿈 + 세로 스크롤(셀 안에서 처리). */
  max-height: 3.4em;
  overflow-y: auto;
  white-space: normal;
  overflow-wrap: anywhere;
}

.detail-input {
  width: 100%;
  padding: 0.25rem 0.5rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.875rem;
  transition: all 0.2s ease;
}

.detail-input:hover {
  border-color: var(--border-color);
}

.detail-input:focus {
  outline: none;
  background: var(--bg-input);
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
}

/* 내구 detail 요약(클릭 → 팝업) */
.endurance-summary {
  cursor: pointer;
  color: var(--accent-success);
  font-weight: 600;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
  white-space: nowrap;
}
.endurance-summary:hover {
  text-decoration: underline;
}

/* 내구 랩 상세 팝업 */
.lap-popup-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}
.lap-popup {
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card), 0 12px 40px rgba(0, 0, 0, 0.4);
  width: 100%;
  max-width: 420px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.lap-popup-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.lap-popup-titles {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.lap-popup-header h3 {
  font-size: 1rem;
  font-weight: 700;
}
.lap-popup-team {
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.875rem;
}
.lap-popup-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary);
  font-size: 1.1rem;
  line-height: 1;
  padding: 0.25rem;
  flex-shrink: 0;
}
.lap-popup-close:hover {
  color: var(--text-primary);
}
.lap-popup-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem 1rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.lps-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.lps-k {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}
.lps-v {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: var(--text-primary);
}
.lap-popup-list {
  overflow-y: auto;
  padding: 0.5rem 1.25rem 1rem;
}
.lap-popup-row {
  display: grid;
  grid-template-columns: 4rem 1fr 3.5rem;
  align-items: center;
  padding: 0.4rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  font-family: "JetBrains Mono", monospace;
}
.lpr-no {
  color: var(--text-secondary);
  font-weight: 600;
}
.lpr-t {
  font-weight: 700;
  color: var(--text-primary);
}
.lpr-tag {
  text-align: right;
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--accent-success);
}
.lap-popup-row.best .lpr-t {
  color: var(--accent-success);
}

.penalty-cell {
  cursor: text;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  color: var(--text-primary);
}

.penalty-text {
  display: inline-block;
  min-width: 1.5em;
  min-height: 1.25em;
}

.penalty-input {
  width: 4em;
  padding: 0.25rem 0.375rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  text-align: center;
  transition: all 0.2s ease;
  -moz-appearance: textfield;
}

.penalty-input::-webkit-outer-spin-button,
.penalty-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.penalty-input:hover {
  border-color: var(--border-color);
}

.penalty-input:focus {
  outline: none;
  background: var(--bg-input);
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
}

.col-shrink {
  width: 1%;
  white-space: nowrap;
}

.col-team {
  width: 1%;
  white-space: nowrap;
  font-size: 0.875rem;
}

/* 무효화된 행 스타일 */
.data-table tbody tr.is-invalidated {
  opacity: 0.4;
}

.data-table tbody tr.is-invalidated td {
  text-decoration: line-through;
  text-decoration-color: var(--text-tertiary);
}

.data-table tbody tr.is-invalidated .btn-invalidate,
.data-table tbody tr.is-invalidated .btn-scoreboard,
.data-table tbody tr.is-invalidated .detail-input,
.data-table tbody tr.is-invalidated .penalty-input {
  text-decoration: none;
}

/* 무효화 버튼 */
.btn-invalidate {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-invalidate svg {
  width: 16px;
  height: 16px;
}

.btn-invalidate:hover {
  background: var(--bg-hover);
  color: var(--accent-danger);
  border-color: var(--accent-danger);
}

.btn-invalidate.active {
  background: var(--accent-danger);
  color: white;
  border-color: var(--accent-danger);
}

.btn-invalidate.active:hover {
  background: var(--accent-success);
  border-color: var(--accent-success);
}

/* 전광판 버튼 */
.btn-scoreboard {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none !important;
}

.btn-scoreboard svg {
  width: 16px;
  height: 16px;
}

.btn-scoreboard:hover {
  background: var(--bg-hover);
  color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.btn-scoreboard.active {
  background: var(--accent-primary);
  color: white;
  border-color: var(--accent-primary);
}

.btn-scoreboard.active:hover {
  opacity: 0.8;
}

.controller-data {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.empty-state-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem;
  color: var(--text-tertiary);
}

.empty-icon {
  font-size: 4rem;
  opacity: 0.5;
  margin-bottom: 1rem;
}

/* 추가 버튼 */
.btn-primary {
  background: var(--accent-primary);
  color: white;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 수동 기록 추가 폼 */
.add-form {
  padding: 1rem 1.5rem;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.add-form-fields {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0;
}

.form-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0;
}

.form-input {
  padding: 0.5rem 0.875rem;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.form-input:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.15);
}

.add-form-fields .form-select,
.add-form-fields .form-input {
  line-height: 1.2;
}

.add-form-submit {
  align-self: flex-end;
  white-space: nowrap;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--accent-primary);
  font-size: 0.875rem;
  margin: 0;
}

@media (max-width: 768px) {
  .file-toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
  }

  .toolbar-left {
    width: 100%;
  }

  .form-select {
    flex: 1;
    min-width: 0;
  }

  .toolbar-right {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .type-filters {
    flex-wrap: wrap;
  }

  .add-form-fields {
    flex-direction: column;
    align-items: stretch;
  }

  .form-group {
    width: 100%;
  }

  .form-group .form-select,
  .form-group .form-input {
    width: 100%;
  }
}
</style>
