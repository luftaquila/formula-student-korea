<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useNotification } from "@shared/useNotification.js";
import { request, fetchAdminEntries, fetchVehicleTypes } from "../api.js";
import { usePersistentTypeFilters } from "@shared/usePersistentTypeFilters.js";
import { useTableHeadBand } from "@shared/useTableHeadBand.js";
import { formatDate, formatDateLines, formatSize } from "@shared/format-date.js";
import { permissionComputed } from "@shared/officialsStore.js";

const route = useRoute();
const router = useRouter();
const { notyf } = useNotification();
const canManage = permissionComputed("documents.manage");

const tableRef = ref(null);
const tableScrollerRef = ref(null);
const headBandRef = ref(null);
useTableHeadBand({ tableRef, scrollerRef: tableScrollerRef, bandRef: headBandRef });

const BASE_URL = "/competition/api/v1/documents";

const loading = ref(true);
const session = ref(null);
const status = ref([]);
const entries = ref({});
const students = ref([]);
const expandedTeams = ref(new Set());

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

// 유형 색상 (엔트리 서비스에서 가져옴)
const typeColorMap = ref({});
function getTypeColor(type) {
  if (!type) return "blue";
  return typeColorMap.value[type] || "blue";
}

const availableTypes = computed(() => [...new Set(
  status.value.map((teamStatus) => entries.value[teamStatus.team_num]?.type).filter(Boolean),
)].sort());
const typeFilters = usePersistentTypeFilters("documents-session-type-filter", availableTypes);
const filteredStatus = computed(() => status.value.filter((teamStatus) => {
  const type = entries.value[teamStatus.team_num]?.type;
  return !type || typeFilters.value[type] !== false;
}));

// 학생 디스플레이
const studentByEmail = computed(() => {
  const map = {};
  for (const s of students.value) map[s.email] = s;
  return map;
});
function studentDisplayName(email) {
  if (!email) return "-";
  const s = studentByEmail.value[email];
  if (!s) return email;
  if (s.realname) return s.phone ? `${s.realname} (${s.phone})` : s.realname;
  return s.name || email;
}

// 정렬된 status
const sortedStatus = computed(() => {
  if (!sortKey.value) return filteredStatus.value;
  const key = sortKey.value;
  const dir = sortOrder.value === "asc" ? 1 : -1;
  return [...filteredStatus.value].sort((a, b) => {
    let aVal, bVal;
    if (key === "num") { aVal = a.team_num; bVal = b.team_num; }
    else if (key === "team") {
      const ea = entries.value[a.team_num] || {};
      const eb = entries.value[b.team_num] || {};
      aVal = `${ea.univ || ""} ${ea.team || ""}`.toLowerCase();
      bVal = `${eb.univ || ""} ${eb.team || ""}`.toLowerCase();
    } else if (key === "type") {
      aVal = (entries.value[a.team_num]?.type || "").toLowerCase();
      bVal = (entries.value[b.team_num]?.type || "").toLowerCase();
    } else if (key === "status") {
      // 제출(0) < 지각(1) < 미제출(2)
      aVal = a.submission ? (a.submission.is_late ? 1 : 0) : 2;
      bVal = b.submission ? (b.submission.is_late ? 1 : 0) : 2;
    } else if (key === "count") {
      aVal = a.submissionCount || 0;
      bVal = b.submissionCount || 0;
    } else if (key === "time") {
      aVal = a.submission?.submitted_at || "";
      bVal = b.submission?.submitted_at || "";
    } else if (key === "submitter") {
      aVal = studentDisplayName(a.submission?.submitted_by).toLowerCase();
      bVal = studentDisplayName(b.submission?.submitted_by).toLowerCase();
    } else if (key === "size") {
      aVal = a.submission?.total_size || 0;
      bVal = b.submission?.total_size || 0;
    } else { aVal = a.team_num; bVal = b.team_num; }
    return aVal < bVal ? -dir : aVal > bVal ? dir : 0;
  });
});

// 카운트 칩
const submittedCount = computed(() => filteredStatus.value.filter(t => t.submission && !t.submission.is_late).length);
const lateCount = computed(() => filteredStatus.value.filter(t => t.submission && t.submission.is_late).length);
const missingCount = computed(() => filteredStatus.value.filter(t => !t.submission).length);
const totalCount = computed(() => filteredStatus.value.length);

async function loadStatus() {
  loading.value = true;
  try {
    const res = await request(`/api/admin/sessions/${route.params.id}/status`);
    const data = await res.json();
    session.value = data.session;
    status.value = data.status;
    const [entryData, studRes] = await Promise.all([
      fetchAdminEntries(session.value.year),
      request("/api/admin/students"),
    ]);
    entries.value = entryData;
    students.value = await studRes.json();
    try {
      const vtList = await fetchVehicleTypes(session.value.year);
      typeColorMap.value = Object.fromEntries(vtList.map(v => [v.name, v.color]));
    } catch { /* 색상 로드 실패 시 기본값 사용 */ }
  } catch {
    router.push("/admin");
  } finally {
    loading.value = false;
  }
}

function formatExts(exts) {
  if (!exts) return "";
  return exts.split(",").map((e) => e.trim().toUpperCase()).join(", ");
}

function downloadFile(subId, fileId) {
  window.open(`${BASE_URL}/admin/submissions/${subId}/files/${fileId}`, "_blank");
}

function downloadZip(subId) {
  window.open(`${BASE_URL}/admin/submissions/${subId}/zip`, "_blank");
}

function downloadSessionArchive() {
  window.open(`${BASE_URL}/admin/sessions/${route.params.id}/archive`, "_blank");
}

function toggleExpand(teamNum) {
  if (expandedTeams.value.has(teamNum)) expandedTeams.value.delete(teamNum);
  else expandedTeams.value.add(teamNum);
}

async function deleteSession() {
  if (!canManage.value) return;
  if (!confirm("이 세션을 삭제하시겠습니까? 모든 제출 파일도 삭제됩니다.")) return;
  try {
    await request(`/api/admin/sessions/${route.params.id}`, { method: "DELETE" });
    notyf.success("세션을 삭제했습니다.");
    router.push("/admin");
  } catch (e) {
    notyf.error(e.message);
  }
}

onMounted(loadStatus);
</script>

<template>
  <div class="detail-container">
    <div v-if="loading" class="loading">
      <div class="loading-spinner"></div>
    </div>

    <template v-else-if="session">
      <button class="btn btn-ghost back-btn" @click="router.push('/admin')">← 목록으로</button>

      <!-- 세션 정보 카드 -->
      <div class="card team-table-card">
        <div class="card-header">
          <h3>{{ session.name }}</h3>
          <div class="header-actions">
            <button class="btn btn-sm btn-ghost" @click="downloadSessionArchive">다운로드</button>
            <router-link v-if="canManage" :to="'/admin/session/' + session.id + '/edit'" class="btn btn-sm btn-ghost">수정</router-link>
            <button v-if="canManage" class="btn btn-sm btn-danger" @click="deleteSession">삭제</button>
          </div>
        </div>
        <div class="card-body">
          <div class="info-list">
            <div class="info-row">
              <span class="info-label">시작</span>
              <span class="info-value">{{ formatDate(session.start_at) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">제출 마감</span>
              <span class="info-value">{{ formatDate(session.end_at) }}</span>
            </div>
            <div v-if="session.late_end_at && session.late_end_at !== session.end_at" class="info-row">
              <span class="info-label">지각 마감</span>
              <span class="info-value">{{ formatDate(session.late_end_at) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">용량 제한</span>
              <span class="info-value">{{ formatSize(session.max_file_size) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">허용 확장자</span>
              <span class="info-value">{{ session.allowed_extensions ? formatExts(session.allowed_extensions) : "제한 없음" }}</span>
            </div>
          </div>
          <p v-if="session.notice" class="session-notice">{{ session.notice }}</p>
        </div>
      </div>

      <!-- 제출 현황 테이블 -->
      <div class="card">
        <div class="card-header">
          <h3>팀별 제출 현황</h3>
          <div class="count-chips">
            <span v-if="submittedCount > 0" class="badge badge-success">제출 {{ submittedCount }}</span>
            <span v-if="lateCount > 0" class="badge badge-warning">지각 {{ lateCount }}</span>
            <span v-if="missingCount > 0" class="badge badge-default">미제출 {{ missingCount }}</span>
            <span class="badge badge-primary">전체 {{ totalCount }}</span>
          </div>
          <div v-if="availableTypes.length" class="team-type-filter" data-testid="documents-session-type-filter">
            <label v-for="type in availableTypes" :key="type" class="team-type-filter-label">
              <input v-model="typeFilters[type]" type="checkbox" :value="type" />
              <span class="badge" :class="'badge-type-' + getTypeColor(type)">{{ type }}</span>
            </label>
          </div>
        </div>
        <div class="card-body table-body team-table-body">
          <div class="sticky-host team-table-sticky-host">
            <div ref="headBandRef" class="team-table-head-band" data-testid="documents-session-sticky-header"></div>
            <div ref="tableScrollerRef" class="table-container team-table-scroll" data-testid="documents-session-table-scroll">
            <table ref="tableRef" class="data-table detail-table team-table">
              <thead>
                <tr>
                  <th class="col-num sortable" @click="handleSort('num')">엔트리 <span class="sort-icon">{{ getSortIcon('num') }}</span></th>
                  <th class="col-team sortable" @click="handleSort('team')">학교 / 팀 <span class="sort-icon">{{ getSortIcon('team') }}</span></th>
                  <th class="col-type sortable" @click="handleSort('type')">유형 <span class="sort-icon">{{ getSortIcon('type') }}</span></th>
                  <th class="col-status sortable" @click="handleSort('status')">상태 <span class="sort-icon">{{ getSortIcon('status') }}</span></th>
                  <th class="col-count sortable" @click="handleSort('count')">횟수 <span class="sort-icon">{{ getSortIcon('count') }}</span></th>
                  <th class="col-time sortable" aria-label="제출 일시" @click="handleSort('time')">
                    <span class="column-header-lines">
                      <span>제출</span>
                      <span>일시 <span class="sort-icon">{{ getSortIcon('time') }}</span></span>
                    </span>
                  </th>
                  <th class="col-submitter sortable" @click="handleSort('submitter')">제출자 <span class="sort-icon">{{ getSortIcon('submitter') }}</span></th>
                  <th class="col-size sortable" @click="handleSort('size')">용량 <span class="sort-icon">{{ getSortIcon('size') }}</span></th>
                  <th class="col-files">파일</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="t in sortedStatus" :key="t.team_num">
                  <tr :class="{ 'row-none': !t.submission }">
                    <td class="col-num">
                      <div class="team-entry-summary">
                        <div class="team-entry-summary-top">
                          <span class="entry-num">{{ t.team_num }}</span>
                          <span v-if="entries[t.team_num]?.type" class="badge team-mobile-entry-type" :class="'badge-type-' + getTypeColor(entries[t.team_num].type)">{{ entries[t.team_num].type }}</span>
                        </div>
                        <span class="team-mobile-entry-univ">{{ entries[t.team_num]?.univ }}</span>
                        <span class="team-mobile-entry-name">{{ entries[t.team_num]?.team }}</span>
                      </div>
                    </td>
                    <td class="col-team"><span class="entry-name">{{ entries[t.team_num]?.univ }} {{ entries[t.team_num]?.team }}</span></td>
                    <td class="col-type">
                      <span v-if="entries[t.team_num]?.type" class="badge" :class="'badge-type-' + getTypeColor(entries[t.team_num].type)">{{ entries[t.team_num].type }}</span>
                    </td>
                    <td class="col-status">
                      <span v-if="t.submission" class="badge" :class="t.submission.is_late ? 'badge-warning' : 'badge-success'">
                        {{ t.submission.is_late ? "지각" : "제출" }}
                      </span>
                      <span v-else class="badge badge-default">미제출</span>
                    </td>
                    <td class="col-count" :class="{ 'col-count-expand': t.prevSubmission }" @click="t.prevSubmission && toggleExpand(t.team_num)">
                      <span v-if="t.submissionCount > 0">#{{ t.submissionCount }}</span>
                      <span v-else class="text-muted">-</span>
                    </td>
                    <td class="col-time">
                      <span v-if="t.submission" class="date-time-lines">
                        <span>{{ formatDateLines(t.submission.submitted_at).date }}</span>
                        <span>{{ formatDateLines(t.submission.submitted_at).time }}</span>
                      </span>
                      <span v-else>-</span>
                    </td>
                    <td class="col-submitter">
                      <span v-if="t.submission?.submitted_by" :title="t.submission.submitted_by">{{ studentDisplayName(t.submission.submitted_by) }}</span>
                      <span v-else>-</span>
                    </td>
                    <td class="col-size">{{ t.submission ? formatSize(t.submission.total_size) : "-" }}</td>
                    <td class="col-files">
                      <div v-if="t.files.length > 0" class="file-list">
                        <span v-if="t.files.length > 1" class="file-link file-zip" @click="downloadZip(t.submission.id)">전체 다운로드 ({{ formatSize(t.submission.total_size) }})</span>
                        <span
                          v-for="f in t.files"
                          :key="f.id"
                          class="file-link"
                          @click="downloadFile(t.submission.id, f.id)"
                        >{{ f.original_name }} ({{ formatSize(f.size) }})</span>
                      </div>
                      <span v-else>-</span>
                    </td>
                  </tr>
                  <tr v-if="t.prevSubmission && expandedTeams.has(t.team_num)" class="row-prev">
                    <td class="col-num"></td>
                    <td class="col-team prev-label" colspan="2">이전 제출</td>
                    <td class="col-status">
                      <span class="badge" :class="t.prevSubmission.is_late ? 'badge-warning' : 'badge-success'">
                        {{ t.prevSubmission.is_late ? "지각" : "제출" }}
                      </span>
                    </td>
                    <td class="col-count"></td>
                    <td class="col-time">
                      <span class="date-time-lines">
                        <span>{{ formatDateLines(t.prevSubmission.submitted_at).date }}</span>
                        <span>{{ formatDateLines(t.prevSubmission.submitted_at).time }}</span>
                      </span>
                    </td>
                    <td class="col-submitter">
                      <span :title="t.prevSubmission.submitted_by">{{ studentDisplayName(t.prevSubmission.submitted_by) }}</span>
                    </td>
                    <td class="col-size">{{ formatSize(t.prevSubmission.total_size) }}</td>
                    <td class="col-files">
                      <div v-if="t.prevFiles.length > 0" class="file-list">
                        <span v-if="t.prevFiles.length > 1" class="file-link file-zip" @click="downloadZip(t.prevSubmission.id)">전체 다운로드 ({{ formatSize(t.prevSubmission.total_size) }})</span>
                        <span
                          v-for="f in t.prevFiles"
                          :key="f.id"
                          class="file-link"
                          @click="downloadFile(t.prevSubmission.id, f.id)"
                        >{{ f.original_name }} ({{ formatSize(f.size) }})</span>
                      </div>
                      <span v-else>-</span>
                    </td>
                  </tr>
                </template>
                <tr v-if="sortedStatus.length === 0">
                  <td colspan="9" class="empty-state">선택한 유형에 해당하는 팀이 없습니다.</td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
}

.back-btn {
  align-self: flex-start;
}

/* 세션 정보 카드 */
.card-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.header-actions {
  display: flex;
  gap: 0.375rem;
  margin-left: auto;
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.info-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  min-width: 4.5rem;
  flex-shrink: 0;
}

.info-value {
  font-size: 0.875rem;
  color: var(--text-primary);
}

.session-notice {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border-color);
  font-size: 0.875rem;
  color: var(--text-secondary);
  white-space: pre-line;
  line-height: 1.7;
}

.count-chips {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}

/* 테이블 */
.table-body {
  padding: 0 !important;
  overflow: auto;
}

.col-num,
.col-team,
.col-type,
.col-status,
.col-count,
.col-time,
.col-submitter,
.col-size,
.col-files {
  width: 1%;
  white-space: nowrap;
}

.col-num {
  text-align: left !important;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-card);
}

.detail-table thead .col-num {
  z-index: 3;
}

.sticky-host {
  position: relative;
}

.col-status,
.col-count {
  text-align: center !important;
}

.col-team {
  font-size: 0.875rem;
}

.col-time,
.col-submitter,
.col-size {
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.col-time {
  min-width: 5.75rem;
}

.column-header-lines,
.date-time-lines {
  display: inline-grid;
  gap: 0.0625rem;
  line-height: 1.2;
  white-space: nowrap;
}

.row-none {
  opacity: 0.5;
}

.text-muted {
  color: var(--text-tertiary);
  font-size: 0.8125rem;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.file-link {
  font-size: 0.8125rem;
  color: var(--accent-primary);
  cursor: pointer;
  text-decoration: none;
}

.file-link:hover {
  text-decoration: underline;
}

.file-zip {
  font-weight: 600;
  padding-bottom: 0.125rem;
  margin-bottom: 0.125rem;
  border-bottom: 1px solid var(--border-color);
}

.col-count-expand {
  cursor: pointer;
  color: var(--accent-primary);
  font-weight: 600;
}

.col-count-expand:hover {
  text-decoration: underline;
}

.col-submitter span[title] {
  cursor: help;
}

.row-prev {
  background: var(--bg-secondary);
}

.row-prev td {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  opacity: 0.8;
}

.prev-label {
  font-style: italic;
  color: var(--text-tertiary) !important;
}

/* 정렬 */
.detail-table th.sortable {
  cursor: pointer;
  user-select: none;
}
.detail-table th.sortable:hover {
  background: var(--bg-hover);
}
.sort-icon {
  opacity: 0.5;
  font-size: 0.75rem;
}
</style>
