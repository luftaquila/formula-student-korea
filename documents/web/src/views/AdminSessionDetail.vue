<script setup>
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Notyf } from "notyf";
import { request, fetchEntries } from "../api.js";

const route = useRoute();
const router = useRouter();
const notyf = new Notyf({ duration: 3000, position: { x: "right", y: "top" } });

const BASE_URL = import.meta.env.PROD ? "/documents" : "";

const loading = ref(true);
const session = ref(null);
const status = ref([]);
const entries = ref({});

async function loadStatus() {
  loading.value = true;
  try {
    const res = await request(`/api/admin/sessions/${route.params.id}/status`);
    const data = await res.json();
    session.value = data.session;
    status.value = data.status;
    entries.value = await fetchEntries(session.value.year);
  } catch {
    router.push("/admin");
  } finally {
    loading.value = false;
  }
}

function formatDate(d) {
  if (!d) return "-";
  return new Date(d + "Z").toLocaleString("ko-KR");
}

function formatSize(bytes) {
  if (!bytes) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatExts(exts) {
  if (!exts) return "";
  return exts.split(",").map((e) => e.trim().toUpperCase()).join(", ");
}

function downloadFile(subId, fileId) {
  window.open(`${BASE_URL}/api/admin/submissions/${subId}/files/${fileId}`, "_blank");
}

async function deleteSession() {
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
      <div class="card">
        <div class="card-header">
          <h3>{{ session.name }}</h3>
          <div class="header-actions">
            <router-link :to="'/admin/session/' + session.id + '/edit'" class="btn btn-sm btn-ghost">수정</router-link>
            <button class="btn btn-sm btn-danger" @click="deleteSession">삭제</button>
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
          <h3>팀별 제출 현황 <span class="count-badge">{{ status.filter(t => t.submission).length }} / {{ status.length }}</span></h3>
        </div>
        <div class="card-body table-body">
          <div class="table-container">
            <table class="data-table detail-table">
              <thead>
                <tr>
                  <th class="col-num">번호</th>
                  <th class="col-team">학교 / 팀</th>
                  <th class="col-status">상태</th>
                  <th class="col-time">제출 시간</th>
                  <th class="col-submitter">제출자</th>
                  <th class="col-size">용량</th>
                  <th class="col-files">파일</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="t in status" :key="t.team_num" :class="{ 'row-none': !t.submission }">
                  <td class="col-num"><span class="entry-num">{{ t.team_num }}</span></td>
                  <td class="col-team">{{ entries[t.team_num]?.univ }} {{ entries[t.team_num]?.team }}</td>
                  <td class="col-status">
                    <template v-if="t.submission">
                      <span class="badge" :class="t.submission.is_late ? 'badge-warning' : 'badge-success'">
                        {{ t.submission.is_late ? "지각" : "제출" }}
                      </span>
                    </template>
                    <span v-else class="text-muted">미제출</span>
                  </td>
                  <td class="col-time">{{ t.submission ? formatDate(t.submission.submitted_at) : "-" }}</td>
                  <td class="col-submitter">{{ t.submission?.submitted_by || "-" }}</td>
                  <td class="col-size">{{ t.submission ? formatSize(t.submission.total_size) : "-" }}</td>
                  <td class="col-files">
                    <div v-if="t.files.length > 0" class="file-list">
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
              </tbody>
            </table>
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

.table-container {
  overflow-x: auto;
}

.col-num,
.col-team,
.col-status,
.col-time,
.col-submitter,
.col-size,
.col-files {
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

.detail-table thead .col-num {
  z-index: 3;
}

.col-status {
  text-align: center !important;
}

.entry-num {
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
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

@keyframes spin { to { transform: rotate(360deg); } }

</style>
