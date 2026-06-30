<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { request, fetchEntryYears, fetchEntries, fetchVehicleTypes } from "../api.js";
import { useStickyColumns } from "@shared/useStickyColumns.js";
import StickyFreezeLine from "@shared/StickyFreezeLine.vue";
import { parseDbTimestamp } from "@shared/parse-timestamp.js";

const { notyf } = useNotification();

const tableRef = ref(null);
const { stickyCols, lineX, startDrag } = useStickyColumns({
  storageKey: "documents-admin-sticky-cols",
  tableRef,
  columnSelectors: [".col-num", ".col-team", ".col-type"],
});

const BASE_URL = import.meta.env.PROD ? "/documents" : "";
const loading = ref(true);
const years = ref([]);
const selectedYear = ref(null);
const sessions = ref([]);
const entries = ref({});
const studentTeams = ref([]);
const students = ref([]);
const searchQuery = ref("");
const showAccount = ref(localStorage.getItem("documents-show-account") !== "false");
watch(showAccount, (v) => localStorage.setItem("documents-show-account", v));

// 정렬
const sortKey = ref(null);
const sortOrder = ref("asc");

function handleSort(key) {
  if (sortKey.value === key) sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  else { sortKey.value = key; sortOrder.value = "asc"; }
}
function getSortIcon(key) {
  if (sortKey.value !== key) return "↕";
  return sortOrder.value === "asc" ? "↑" : "↓";
}

// 유형 필터
const typeFilters = ref({});
const vehicleTypes = computed(() => {
  const types = new Set();
  for (const e of Object.values(entries.value)) { if (e.type) types.add(e.type); }
  return [...types].sort();
});
watch(vehicleTypes, (types) => {
  for (const t of types) { if (!(t in typeFilters.value)) typeFilters.value[t] = true; }
});

// 유형 색상 (엔트리 서비스에서 가져옴)
const typeColorMap = ref({});
function getTypeColor(type) {
  if (!type) return "blue";
  return typeColorMap.value[type] || "blue";
}

async function loadYears() {
  try {
    years.value = await fetchEntryYears();
    if (years.value.length > 0) selectedYear.value = years.value[0];
  } catch (e) { notyf.error(e.message); }
}

async function loadData() {
  if (!selectedYear.value) { loading.value = false; return; }
  loading.value = true;
  try {
    const [sessRes, entryData, teamRes, studRes] = await Promise.all([
      request(`/api/admin/sessions?year=${selectedYear.value}`),
      fetchEntries(selectedYear.value),
      request(`/api/admin/student-teams?year=${selectedYear.value}`),
      request("/api/admin/students"),
    ]);
    sessions.value = await sessRes.json();
    entries.value = entryData;
    studentTeams.value = await teamRes.json();
    students.value = await studRes.json();

    await Promise.all(sessions.value.map(async (s) => {
      try {
        const res = await request(`/api/admin/sessions/${s.id}/status`);
        s._status = (await res.json()).status;
      } catch { s._status = []; }
    }));
  } catch (e) { notyf.error(e.message); }
  finally { loading.value = false; }
}

watch(selectedYear, () => { loadData(); loadTypeColors(); });

// 엔트리 리스트 (필터 + 검색 + 정렬)
const entryList = computed(() => {
  let list = Object.entries(entries.value)
    .map(([num, e]) => ({ num: Number(num), ...e }));

  // 유형 필터
  if (vehicleTypes.value.length > 0) {
    list = list.filter((e) => !e.type || typeFilters.value[e.type] !== false);
  }

  // 검색
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    list = list.filter((e) =>
      String(e.num).includes(q) ||
      (e.univ || "").toLowerCase().includes(q) ||
      (e.team || "").toLowerCase().includes(q),
    );
  }

  // 정렬
  if (!sortKey.value) return list.sort((a, b) => a.num - b.num);
  return [...list].sort((a, b) => {
    let aVal, bVal;
    if (sortKey.value === "num") { aVal = a.num; bVal = b.num; }
    else if (sortKey.value === "team") {
      aVal = `${a.univ || ""} ${a.team || ""}`.toLowerCase();
      bVal = `${b.univ || ""} ${b.team || ""}`.toLowerCase();
    } else if (sortKey.value === "type") {
      aVal = (a.type || "").toLowerCase();
      bVal = (b.type || "").toLowerCase();
    } else { aVal = a.num; bVal = b.num; }
    const dir = sortOrder.value === "asc" ? 1 : -1;
    return aVal < bVal ? -dir : aVal > bVal ? dir : 0;
  });
});

// 팀별 매핑
const teamStudentMap = computed(() => {
  const map = {};
  for (const st of studentTeams.value) map[st.team_num] = st.email;
  return map;
});
const assignedEmails = computed(() => new Set(studentTeams.value.map((st) => st.email)));
const studentByEmail = computed(() => {
  const map = {};
  for (const s of students.value) map[s.email] = s;
  return map;
});
function studentDisplayName(email) {
  const s = studentByEmail.value[email];
  if (!s) return email;
  if (s.realname) return s.phone ? `${s.realname} (${s.phone})` : s.realname;
  return s.name || email;
}

// 검색 가능 드롭다운
const dropdownSearch = ref({});
const dropdownOpen = ref({});

function getFilteredStudents(teamNum) {
  const q = (dropdownSearch.value[teamNum] || "").toLowerCase();
  return students.value.filter((s) => {
    if (assignedEmails.value.has(s.email) && teamStudentMap.value[teamNum] !== s.email) return false;
    if (!q) return true;
    return s.email.toLowerCase().includes(q) || (s.name || "").toLowerCase().includes(q);
  });
}

const dropdownStyle = ref({});

function openDropdown(teamNum, event) {
  dropdownOpen.value = { [teamNum]: true };
  dropdownSearch.value[teamNum] = "";

  const rect = event.currentTarget.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const style = { left: `${rect.left}px`, width: `${rect.width}px` };

  if (spaceBelow < 220) {
    style.bottom = `${window.innerHeight - rect.top + 4}px`;
  } else {
    style.top = `${rect.bottom + 4}px`;
  }
  dropdownStyle.value = style;
}

function closeAllDropdowns() {
  dropdownOpen.value = {};
}

async function reloadStudentTeams() {
  const res = await request(`/api/admin/student-teams?year=${selectedYear.value}`);
  studentTeams.value = await res.json();
}

async function assignStudent(teamNum, email) {
  dropdownOpen.value[teamNum] = false;
  const current = teamStudentMap.value[teamNum];
  if (current === email) return;
  try {
    if (current) await request(`/api/admin/student-teams/${encodeURIComponent(current)}/${selectedYear.value}`, { method: "DELETE" });
    if (email) await request("/api/admin/student-teams", {
      method: "POST",
      body: JSON.stringify({ email, team_num: teamNum, year: selectedYear.value }),
    });
    await reloadStudentTeams();
  } catch (e) { notyf.error(e.message); }
}

async function clearStudent(teamNum) {
  const current = teamStudentMap.value[teamNum];
  if (!current) return;
  try {
    await request(`/api/admin/student-teams/${encodeURIComponent(current)}/${selectedYear.value}`, { method: "DELETE" });
    await reloadStudentTeams();
  } catch (e) { notyf.error(e.message); }
}

function isTargetTeam(session, teamNum) {
  if (!session._status) return false;
  return session._status.some((s) => s.team_num === teamNum);
}

function getSubmissionForTeam(session, teamNum) {
  if (!session._status) return null;
  return session._status.find((s) => s.team_num === teamNum)?.submission || null;
}

function isSessionClosed(s) {
  const deadline = s.late_end_at || s.end_at;
  const deadlineTime = parseDbTimestamp(deadline)?.getTime();
  return deadlineTime ? Date.now() > deadlineTime : false;
}

function submissionCellClass(session, sub) {
  if (sub) return sub.is_late ? "cell-late" : "cell-submitted";
  if (isSessionClosed(session)) return "cell-missed";
  return "cell-none";
}

function formatDate(d) {
  const date = parseDbTimestamp(d);
  return date ? date.toLocaleString("ko-KR") : "-";
}

async function loadTypeColors() {
  if (!selectedYear.value) return;
  try {
    const vtList = await fetchVehicleTypes(selectedYear.value);
    typeColorMap.value = Object.fromEntries(vtList.map(v => [v.name, v.color]));
  } catch { /* 색상 로드 실패 시 기본값 사용 */ }
}

const purging = ref(false);

async function purgeYearFiles() {
  if (!selectedYear.value) return;
  if (!confirm(`${selectedYear.value}년도의 모든 제출 파일을 삭제합니다. 제출 기록은 유지됩니다. 계속하시겠습니까?`)) return;
  purging.value = true;
  try {
    const res = await request(`/api/admin/years/${selectedYear.value}/files`, { method: "DELETE" });
    const data = await res.json();
    notyf.success(`파일 데이터를 삭제했습니다. (세션 ${data.sessions}개, 파일 ${data.files}건)`);
    await loadData();
  } catch (e) { notyf.error(e.message); }
  finally { purging.value = false; }
}

function downloadYearArchive() {
  if (!selectedYear.value) return;
  window.open(`${BASE_URL}/api/admin/years/${selectedYear.value}/archive`, "_blank");
}

onMounted(async () => {
  await loadYears();
  await loadTypeColors();
  document.addEventListener("click", closeAllDropdowns);
});
onUnmounted(() => {
  document.removeEventListener("click", closeAllDropdowns);
});
</script>

<template>
  <div class="admin-container">
    <div class="top-row">
      <div class="filter-bar">
        <div class="filter-group">
          <label class="filter-label">엔트리</label>
          <select class="filter-input" v-model="selectedYear">
            <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label class="filter-label">검색</label>
          <input class="filter-input" v-model="searchQuery" placeholder="번호 / 학교 / 팀명" />
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
          <label class="filter-checkbox">
            <input type="checkbox" v-model="showAccount" />
            <span>계정</span>
          </label>
        </div>
        <div class="filter-group action-group">
          <label class="filter-label">&nbsp;</label>
          <div class="action-buttons">
            <button class="btn btn-ghost btn-sm" :disabled="!selectedYear" @click="downloadYearArchive">전체 다운로드</button>
            <router-link to="/admin/create" class="btn btn-primary btn-sm">세션 생성</router-link>
          </div>
        </div>
      </div>
    </div>

    <div v-if="loading" class="loading">
      <div class="loading-spinner"></div>
    </div>

    <template v-else>
      <div class="card">
        <div class="card-header header-row">
          <h3>팀 목록 <span class="count-badge">{{ entryList.length }}</span></h3>
        </div>
        <div class="card-body table-body">
          <div class="sticky-host">
            <div class="table-container">
            <table ref="tableRef" class="data-table main-table" :data-sticky-cols="stickyCols">
              <thead>
                <tr>
                  <th class="col-num sortable" @click="handleSort('num')">번호 <span class="sort-icon">{{ getSortIcon('num') }}</span></th>
                  <th class="col-team sortable" @click="handleSort('team')">학교 / 팀 <span class="sort-icon">{{ getSortIcon('team') }}</span></th>
                  <th class="col-type sortable" @click="handleSort('type')">유형 <span class="sort-icon">{{ getSortIcon('type') }}</span></th>
                  <th v-if="showAccount" class="col-account">계정</th>
                  <th v-for="s in sessions" :key="s.id" class="col-session">
                    <router-link :to="'/admin/session/' + s.id" class="session-link">{{ s.name }}</router-link>
                    <div class="session-date">{{ formatDate(s.end_at) }}</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in entryList" :key="e.num">
                  <td class="col-num"><span class="entry-num">{{ e.num }}</span></td>
                  <td class="col-team">{{ e.univ }} {{ e.team }}</td>
                  <td class="col-type">
                    <span v-if="e.type" class="badge" :class="'badge-type-' + getTypeColor(e.type)">{{ e.type }}</span>
                  </td>
                  <td v-if="showAccount" class="col-account">
                    <div class="student-select">
                      <div class="select-display" @click.stop="openDropdown(e.num, $event)">
                        <span v-if="teamStudentMap[e.num]" class="selected-email">{{ studentDisplayName(teamStudentMap[e.num]) }}</span>
                        <span v-else class="select-placeholder">-</span>
                        <button v-if="teamStudentMap[e.num]" class="clear-btn" @click.stop="clearStudent(e.num)" title="해제">&times;</button>
                      </div>
                      <div v-if="dropdownOpen[e.num]" class="select-dropdown" :style="dropdownStyle" @click.stop>
                        <input
                          class="select-search"
                          type="text"
                          v-model="dropdownSearch[e.num]"
                          placeholder="검색..."
                          autofocus
                        />
                        <div class="select-options">
                          <div
                            v-for="st in getFilteredStudents(e.num)"
                            :key="st.email"
                            class="select-option"
                            @mousedown.prevent="assignStudent(e.num, st.email)"
                          >
                            <span class="option-name">{{ st.realname ? (st.phone ? `${st.realname} (${st.phone})` : st.realname) : st.name || st.email }}</span>
                            <span v-if="st.realname" class="option-email">{{ st.email }}</span>
                          </div>
                          <div v-if="getFilteredStudents(e.num).length === 0" class="select-empty">결과 없음</div>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td
                    v-for="s in sessions"
                    :key="s.id"
                    class="col-session"
                    :class="[isTargetTeam(s, e.num) ? ['cell-clickable', submissionCellClass(s, getSubmissionForTeam(s, e.num))] : 'cell-not-target']"
                    @click="isTargetTeam(s, e.num) && $router.push('/admin/session/' + s.id)"
                  >
                    <template v-if="!isTargetTeam(s, e.num)">
                      <span class="cell-empty"></span>
                    </template>
                    <template v-else-if="getSubmissionForTeam(s, e.num)">
                      <span class="cell-time">{{ formatDate(getSubmissionForTeam(s, e.num).submitted_at) }}</span>
                    </template>
                    <template v-else>
                      <span v-if="isSessionClosed(s)" class="cell-time">미제출</span>
                      <span v-else class="cell-empty">-</span>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
            <StickyFreezeLine :line-x="lineX" :active="stickyCols > 1" @pointerdown="startDrag" />
          </div>
        </div>
      </div>

      <!-- 파일 관리 -->
      <div class="card danger-card">
        <div class="card-header">
          <h3>파일 관리</h3>
        </div>
        <div class="card-body danger-card-body">
          <p class="danger-description">선택한 연도의 모든 제출 파일을 삭제합니다. 제출 기록(시간, 제출자 등)은 유지되지만, 파일 데이터는 복구할 수 없습니다.</p>
          <button class="btn btn-danger btn-sm" :disabled="!selectedYear || purging" @click="purgeYearFiles">{{ purging ? "삭제 중..." : "파일 정리" }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.admin-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* 필터 바 (성적표 동일) */
.top-row {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  flex-wrap: wrap;
}

.filter-bar {
  display: flex;
  gap: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  align-items: center;
  align-content: center;
  flex-wrap: wrap;
  flex: 1;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.filter-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
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

.type-filter-gap {
  margin-left: 1rem;
}

.type-filter-group {
  display: flex;
  gap: 0.375rem;
  align-items: center;
  height: 2.125rem;
}

.filter-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
  font-size: 0.8125rem;
  height: 2.125rem;
}

.filter-checkbox input { cursor: pointer; }

.action-group {
  margin-left: auto;
}

.action-buttons {
  display: flex;
  gap: 0.375rem;
  height: 2.125rem;
}

.count-badge {
  background: var(--accent-primary);
  color: white;
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 12px;
  margin-left: 0.5rem;
}

/* 테이블 */
.table-body {
  padding: 0 !important;
  overflow: auto;
}

.main-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-secondary);
}

.main-table th.sortable {
  cursor: pointer;
  user-select: none;
}

.main-table th.sortable:hover {
  background: var(--bg-hover);
}

.sort-icon {
  display: inline-block;
  width: 1em;
  text-align: center;
  opacity: 0.5;
  font-size: 0.75rem;
}

.col-num,
.col-team,
.col-type,
.col-account,
.col-session {
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

.main-table thead .col-num {
  z-index: 3;
}

.sticky-host {
  position: relative;
}

.main-table[data-sticky-cols="2"] .col-team,
.main-table[data-sticky-cols="3"] .col-team {
  position: sticky;
  left: var(--sticky-l1, 0);
  z-index: 1;
  background: var(--bg-card);
}

.main-table[data-sticky-cols="3"] .col-type {
  position: sticky;
  left: var(--sticky-l2, 0);
  z-index: 1;
  background: var(--bg-card);
}

.main-table[data-sticky-cols="2"] thead .col-team,
.main-table[data-sticky-cols="3"] thead .col-team,
.main-table[data-sticky-cols="3"] thead .col-type {
  z-index: 3;
}

.col-type,
.col-session {
  text-align: center !important;
}

.col-team {
  font-size: 0.875rem;
}

.header-row {
  display: flex;
  align-items: center;
}

.col-account {
  min-width: 180px;
  position: relative;
}

/* 세션 헤더 */
.session-link {
  color: var(--accent-primary);
  text-decoration: none;
  font-weight: 600;
  white-space: nowrap;
}

.session-link:hover {
  text-decoration: underline;
}

.session-date {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  font-weight: 400;
  margin-top: 0.125rem;
}

/* 검색 가능 드롭다운 */
.student-select { position: relative; }

.select-display {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.75rem;
  min-height: 1.75rem;
  background: var(--bg-input);
  transition: border-color 0.15s ease;
}

.select-display:hover { border-color: var(--accent-primary); }

.selected-email {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.select-placeholder { color: var(--text-tertiary); flex: 1; }

.clear-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0 0.125rem;
  flex-shrink: 0;
}

.clear-btn:hover { color: var(--accent-danger); }

.select-dropdown {
  position: fixed;
  z-index: 100;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.select-search {
  width: 100%;
  padding: 0.5rem;
  border: none;
  border-bottom: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-primary);
  font-size: 0.75rem;
  outline: none;
}

.select-options { max-height: 160px; overflow-y: auto; }

.select-option {
  padding: 0.375rem 0.5rem;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
  transition: background 0.1s ease;
}

.select-option:hover { background: var(--bg-hover); }
.option-name { font-size: 0.75rem; color: var(--text-primary); }
.option-email { font-size: 0.6875rem; color: var(--text-tertiary); }
.select-empty { padding: 0.5rem; text-align: center; font-size: 0.75rem; color: var(--text-tertiary); }

/* 제출 상태 셀 */
.cell-submitted { background: rgba(34, 197, 94, 0.08); }
.cell-late { background: rgba(234, 179, 8, 0.08); }
.cell-missed { background: rgba(239, 68, 68, 0.08); }
.cell-none { color: var(--text-tertiary); }
.cell-not-target {
  background: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 4px,
    var(--bg-hover) 4px,
    var(--bg-hover) 5px
  );
}
.cell-time { font-size: 0.8125rem; display: block; }
.cell-empty { font-size: 0.8125rem; }
.cell-clickable { cursor: pointer; }

/* 파일 관리 카드 */
.danger-card {
  border-color: rgba(239, 68, 68, 0.2);
}

.danger-card-body {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.danger-description {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  flex: 1;
}

@media (max-width: 640px) {
  .filter-bar { flex-direction: column; align-items: stretch; }
  .action-group { margin-left: 0; }
}
</style>
