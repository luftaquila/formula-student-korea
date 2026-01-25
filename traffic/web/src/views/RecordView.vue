<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { fetchRecord, fetchControllers, deleteRecord, deleteControllers } from "../composables/useApi";
import { useNotification } from "../composables/useNotification";
import { useSSE } from "../composables/useSSE";
import { msToClockStr } from "../stores/serial";
import ExcelJS from "exceljs";

const { notyf } = useNotification();
const { recordFiles, selectedFile, lastUpdate } = useSSE();

const records = ref([]);
const loading = ref(false);
const sortKey = ref(null);
const sortOrder = ref("asc");

// 유형 필터 (기본: 모두 선택)
const typeFilters = ref({
  가속: true,
  짐카나: true,
  스키드패드: true,
});

// 컴포넌트 마운트 시 이전에 선택한 파일이 있으면 로드
onMounted(() => {
  if (selectedFile.value) {
    loadRecords();
  }
});

const currentYear = computed(() => new Date().getFullYear());
const isControllerLog = computed(() => selectedFile.value === "controller");

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
    else if (sortKey.value === "num" || sortKey.value === "result") {
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

// 새 기록이 추가되면 자동으로 새로고침
watch(lastUpdate, (update) => {
  if (update && selectedFile.value && update.name === selectedFile.value) {
    loadRecords();
  }
});

async function loadRecords() {
  if (!selectedFile.value) return;

  loading.value = true;
  sortKey.value = null;
  sortOrder.value = "asc";
  try {
    if (selectedFile.value === "controller") {
      records.value = await fetchControllers();
    } else {
      records.value = await fetchRecord(selectedFile.value);
    }
  } catch (e) {
    notyf.error(`기록을 불러오지 못했습니다.`);
    records.value = [];
  } finally {
    loading.value = false;
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
    headers = ["시간", "엔트리", "학교", "팀", "경기", "기록", "상세"];
    rows = sortedRecords.value.map((r) => [
      formatTime(r.time),
      r.num,
      r.univ,
      r.team,
      r.type,
      formatResult(r.result),
      r.detail || "",
    ]);
  }

  const csvContent = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
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
    headers = ["시간", "엔트리", "학교", "팀", "경기", "기록", "상세"];
    rows = sortedRecords.value.map((r) => [
      formatTime(r.time),
      r.num,
      r.univ,
      r.team,
      r.type,
      formatResult(r.result),
      r.detail || "",
    ]);
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Records");

  ws.addRow(headers);
  ws.addRows(rows);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const filename = `${selectedFile.value}.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

function getTypeClass(type) {
  const typeMap = { 가속: "accel", 짐카나: "gymkhana", 스키드패드: "skidpad" };
  return typeMap[type] || type;
}
</script>

<template>
  <div class="page-layout">
    <aside class="sidebar">
      <div class="card">
        <div class="card-header">
          <h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            기록 파일 선택
          </h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">기록 파일</label>
            <select v-model="selectedFile" class="form-input" @change="loadRecords">
              <option disabled :value="null">파일을 선택하세요</option>
              <option v-for="file in recordFiles" :key="file" :value="file">{{ file }}</option>
            </select>
          </div>

          <div v-if="records.length" class="action-buttons">
            <div class="btn-row">
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
            </div>
            <button class="btn btn-danger btn-block" @click="handleDelete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
              삭제
            </button>
          </div>
        </div>
      </div>
    </aside>

    <section class="content">
      <div class="table-header">
        <div class="table-title-area">
          <h2>{{ selectedFile || "기록" }}</h2>
          <span v-if="filteredRecords.length" class="entry-count">{{ filteredRecords.length }}개</span>
        </div>
        <div v-if="records.length && !isControllerLog" class="type-filters">
          <label class="filter-checkbox">
            <input type="checkbox" v-model="typeFilters['가속']" />
            <span class="filter-label accel">가속</span>
          </label>
          <label class="filter-checkbox">
            <input type="checkbox" v-model="typeFilters['짐카나']" />
            <span class="filter-label gymkhana">짐카나</span>
          </label>
          <label class="filter-checkbox">
            <input type="checkbox" v-model="typeFilters['스키드패드']" />
            <span class="filter-label skidpad">스키드패드</span>
          </label>
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
              <th class="sortable center" @click="handleSort('num')">
                엔트리 <span class="sort-icon">{{ getSortIcon("num") }}</span>
              </th>
              <th class="sortable" @click="handleSort('univ')">
                학교 <span class="sort-icon">{{ getSortIcon("univ") }}</span>
              </th>
              <th class="sortable" @click="handleSort('team')">
                팀 <span class="sort-icon">{{ getSortIcon("team") }}</span>
              </th>
              <th class="sortable center" @click="handleSort('type')">
                경기 <span class="sort-icon">{{ getSortIcon("type") }}</span>
              </th>
              <th class="sortable center" @click="handleSort('result')">
                기록 <span class="sort-icon">{{ getSortIcon("result") }}</span>
              </th>
              <th class="sortable" @click="handleSort('detail')">
                상세 <span class="sort-icon">{{ getSortIcon("detail") }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(record, index) in sortedRecords" :key="index">
              <td class="time-cell">{{ formatTime(record.time) }}</td>
              <td class="center">
                <span class="entry-number">{{ record.num }}</span>
              </td>
              <td>{{ record.univ }}</td>
              <td>{{ record.team }}</td>
              <td class="center">
                <span class="type-badge" :class="getTypeClass(record.type)">{{ record.type }}</span>
              </td>
              <td class="result-cell center" :class="{ 'is-dnf': record.result < 0 }">{{ formatResult(record.result) }}</td>
              <td class="detail-cell">{{ record.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="empty-state-container">
        <div class="empty-icon">📂</div>
        <p>기록 파일을 선택하세요</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 2rem;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.content {
  background: var(--bg-card);
  border-radius: 16px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.card {
  background: var(--bg-card);
  border-radius: 16px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.card-header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.card-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.header-icon {
  width: 18px;
  height: 18px;
}
.card-body {
  padding: 1.25rem;
}

.form-group {
  margin-bottom: 1rem;
}

.action-buttons {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.btn-row {
  display: flex;
  gap: 0.5rem;
}

.btn-row .btn {
  flex: 1;
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

.btn-block {
  width: 100%;
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

.form-label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 0.375rem;
}

.form-input {
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.form-input:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
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
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-primary);
}

.filter-label.gymkhana {
  background: rgba(139, 92, 246, 0.1);
  color: var(--accent-secondary);
}

.filter-label.skidpad {
  background: rgba(245, 158, 11, 0.1);
  color: var(--accent-warning);
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
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
}

.data-table tbody tr {
  transition: background-color 0.15s ease;
}

.data-table tbody tr:hover {
  background: var(--bg-hover);
}

.time-cell {
  font-size: 0.875rem;
  color: var(--text-primary);
}

.entry-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  padding: 0.25rem 0.5rem;
  background: var(--bg-primary);
  border-radius: 6px;
  font-family: "JetBrains Mono", monospace;
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--accent-primary);
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
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-primary);
}
.type-badge.gymkhana {
  background: rgba(139, 92, 246, 0.1);
  color: var(--accent-secondary);
}
.type-badge.skidpad {
  background: rgba(245, 158, 11, 0.1);
  color: var(--accent-warning);
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
}

.controller-data {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8125rem;
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

@media (max-width: 1024px) {
  .page-layout {
    grid-template-columns: 1fr;
  }
}
</style>
