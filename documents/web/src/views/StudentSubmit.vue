<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useNotification } from "@shared/useNotification.js";
import { request } from "../api.js";

const route = useRoute();
const router = useRouter();
const { notyf } = useNotification();

const BASE_URL = import.meta.env.PROD ? "/documents" : "";

const loading = ref(true);
const uploading = ref(false);
const uploadProgress = ref(0);
const session = ref(null);
const teamNum = ref(null);
const submission = ref(null);
const existingFiles = ref([]);
const selectedFiles = ref([]);
const dragOver = ref(false);

async function fetchSession() {
  loading.value = true;
  try {
    const res = await request(`/api/sessions/${route.params.id}`);
    const data = await res.json();
    session.value = data.session;
    teamNum.value = data.team_num;
    submission.value = data.submission;
    existingFiles.value = data.files;
  } catch {
    router.push("/");
  } finally {
    loading.value = false;
  }
}

// DB에 "pdf,docx" 형태로 저장됨
const allowedExts = computed(() => {
  if (!session.value?.allowed_extensions) return [];
  return session.value.allowed_extensions.split(",").map((e) => e.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
});
const acceptAttr = computed(() => allowedExts.value.map((e) => `.${e}`).join(",") || undefined);

const now = ref(Date.now());
const nowTimer = setInterval(() => { now.value = Date.now(); }, 60000);
onUnmounted(() => clearInterval(nowTimer));
function parseDbTimestamp(value) {
  const s = String(value || "");
  if (!s) return null;
  const d = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function timestampMs(value) {
  return parseDbTimestamp(value)?.getTime() ?? 0;
}

const isUpcoming = computed(() => {
  if (!session.value) return false;
  return now.value < timestampMs(session.value.start_at);
});
const canSubmit = computed(() => {
  if (!session.value) return false;
  const deadline = session.value.late_end_at || session.value.end_at;
  return now.value >= timestampMs(session.value.start_at) && now.value <= timestampMs(deadline);
});
const isLate = computed(() => {
  if (!session.value) return false;
  return !!session.value.late_end_at && now.value > timestampMs(session.value.end_at);
});

function formatDate(d) {
  const date = parseDbTimestamp(d);
  return date ? date.toLocaleString("ko-KR") : "-";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function handleDrop(e) {
  dragOver.value = false;
  addFiles(e.dataTransfer.files);
}

function handleFileInput(e) {
  addFiles(e.target.files);
  e.target.value = "";
}

function getExt(name) {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function addFiles(fileList) {
  const files = Array.from(fileList);
  if (allowedExts.value.length > 0) {
    const rejected = files.filter((f) => !allowedExts.value.includes(getExt(f.name)));
    if (rejected.length > 0) {
      notyf.error(`허용되지 않는 파일: ${rejected.map((f) => f.name).join(", ")}`);
      const valid = files.filter((f) => allowedExts.value.includes(getExt(f.name)));
      selectedFiles.value = [...selectedFiles.value, ...valid];
      return;
    }
  }
  selectedFiles.value = [...selectedFiles.value, ...files];
}

function removeFile(index) {
  selectedFiles.value = selectedFiles.value.filter((_, i) => i !== index);
}

async function submit() {
  if (selectedFiles.value.length === 0) {
    notyf.error("파일을 선택하세요.");
    return;
  }

  const totalSize = selectedFiles.value.reduce((sum, f) => sum + f.size, 0);
  if (session.value && totalSize > session.value.max_file_size) {
    notyf.error(`파일 용량 제한(${formatSize(session.value.max_file_size)})을 초과했습니다. (선택: ${formatSize(totalSize)})`);
    return;
  }

  if (submission.value) {
    if (!confirm("기존 제출을 교체합니다. 계속하시겠습니까?")) return;
  }

  uploading.value = true;
  uploadProgress.value = 0;

  const formData = new FormData();
  for (const f of selectedFiles.value) {
    formData.append("files", f);
  }

  try {
    const xhr = new XMLHttpRequest();
    const result = await new Promise((resolve, reject) => {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) uploadProgress.value = Math.round((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        if (xhr.status === 401) {
          window.location.href = `/auth/api/login?redirect=${encodeURIComponent(window.location.pathname)}`;
          reject(new Error("인증이 필요합니다."));
          return;
        }
        if (xhr.status >= 400) {
          reject(new Error(xhr.responseText || `업로드 실패 (${xhr.status})`));
          return;
        }
        resolve(JSON.parse(xhr.responseText));
      };
      xhr.onerror = () => reject(new Error("네트워크 오류"));
      xhr.open("POST", `${BASE_URL}/api/sessions/${route.params.id}/submit`);
      xhr.send(formData);
    });

    notyf.success("제출 완료");
    selectedFiles.value = [];
    await fetchSession();
  } catch (e) {
    notyf.error(e.message);
  } finally {
    uploading.value = false;
    uploadProgress.value = 0;
  }
}

function onBeforeUnload(e) {
  e.preventDefault();
}

watch(uploading, (val) => {
  if (val) window.addEventListener("beforeunload", onBeforeUnload);
  else window.removeEventListener("beforeunload", onBeforeUnload);
});

onUnmounted(() => window.removeEventListener("beforeunload", onBeforeUnload));

function downloadFile(fileId) {
  if (!submission.value) return;
  window.open(`${BASE_URL}/api/submissions/${submission.value.id}/files/${fileId}`, "_blank");
}

function downloadAll() {
  if (!submission.value) return;
  window.open(`${BASE_URL}/api/submissions/${submission.value.id}/zip`, "_blank");
}

onMounted(fetchSession);
</script>

<template>
  <div class="submit-container">
    <button class="btn btn-ghost back-btn" @click="router.push('/')">← 목록으로</button>

    <div v-if="loading" class="loading">
      <div class="loading-spinner"></div>
    </div>

    <template v-else-if="session">
      <div class="card">
        <div class="card-header">
          <h3>{{ session.name }}</h3>
        </div>
        <div class="card-body">
          <div class="info-list">
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
              <span class="info-label">허용 형식</span>
              <span class="info-value">{{ allowedExts.length > 0 ? allowedExts.map(e => e.toUpperCase()).join(", ") : "제한 없음" }}</span>
            </div>
          </div>
          <div v-if="session.notice" class="notice-box">{{ session.notice }}</div>
        </div>
      </div>

      <!-- 기존 제출 -->
      <div v-if="submission" class="card">
        <div class="card-header">
          <h3>현재 제출</h3>
          <span class="badge sub-badge" :class="submission.is_late ? 'badge-warning' : 'badge-success'">
            {{ submission.is_late ? "지각 제출" : "제출 완료" }}
          </span>
        </div>
        <div class="card-body">
          <div class="info-list sub-info">
            <div class="info-row">
              <span class="info-label">제출일</span>
              <span class="info-value">{{ formatDate(submission.submitted_at) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">용량</span>
              <span class="info-value">{{ formatSize(submission.total_size) }}</span>
            </div>
          </div>
          <div class="file-list">
            <div v-if="existingFiles.length > 1" class="file-item file-zip" @click="downloadAll">
              <span class="file-name">📦 전체 다운로드</span>
              <span class="file-size">{{ formatSize(submission.total_size) }}</span>
            </div>
            <div v-for="f in existingFiles" :key="f.id" class="file-item" @click="downloadFile(f.id)">
              <span class="file-name">{{ f.original_name }}</span>
              <span class="file-size">{{ formatSize(f.size) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 업로드 영역 -->
      <div v-if="canSubmit" class="card">
        <div class="card-header">
          <h3>{{ submission ? "새 제출" : "파일 업로드" }}</h3>
          <span v-if="isLate" class="badge badge-warning sub-badge">지각 제출 기간</span>
        </div>
        <div class="card-body">

        <div
          class="drop-zone"
          :class="{ 'drag-over': dragOver, disabled: uploading }"
          @dragover.prevent="!uploading && (dragOver = true)"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="dragOver = false; !uploading && handleDrop($event)"
          @click="!uploading && $refs.fileInput.click()"
        >
          <input ref="fileInput" type="file" multiple hidden :accept="acceptAttr" @change="handleFileInput" />
          <div class="drop-content">
            <span class="drop-icon">📁</span>
            <p>파일을 드래그하거나 클릭하여 선택</p>
            <p v-if="allowedExts.length > 0" class="drop-hint">{{ allowedExts.map(e => e.toUpperCase()).join(", ") }} 파일만 허용</p>
          </div>
        </div>

        <div v-if="selectedFiles.length > 0" class="selected-files">
          <div v-for="(f, i) in selectedFiles" :key="i" class="selected-file">
            <span class="file-name">{{ f.name }}</span>
            <span class="file-size">{{ formatSize(f.size) }}</span>
            <button class="btn btn-sm btn-danger" :disabled="uploading" @click="removeFile(i)">삭제</button>
          </div>
        </div>

        <div v-if="uploading" class="progress-bar">
          <div class="progress-fill" :style="{ width: uploadProgress + '%' }"></div>
          <span class="progress-text">{{ uploadProgress }}%</span>
        </div>

        <button
          class="btn btn-primary submit-btn"
          :disabled="selectedFiles.length === 0 || uploading"
          @click="submit"
        >
          {{ uploading ? "업로드 중..." : "제출" }}
        </button>
        </div>
      </div>

      <div v-else-if="isUpcoming" class="card">
        <div class="card-body"><p class="closed-notice">제출 기간이 아직 시작되지 않았습니다.</p></div>
      </div>

      <div v-else-if="!submission" class="card">
        <div class="card-body"><p class="closed-notice">제출 기간이 종료되었습니다.</p></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.submit-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
}

.back-btn {
  align-self: flex-start;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.sub-badge {
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

.sub-info {
  margin-bottom: 0.75rem;
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
  color: var(--text-secondary);
}

.notice-box {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border-color);
  font-size: 0.875rem;
  color: var(--text-secondary);
  white-space: pre-line;
  line-height: 1.7;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.file-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  background: var(--bg-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.file-item:hover {
  background: var(--bg-hover);
}

.file-zip .file-name,
.file-zip .file-size {
  color: var(--accent-primary);
  font-weight: 600;
}

.file-name {
  font-size: 0.875rem;
  color: var(--text-primary);
  word-break: break-all;
}

.file-size {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  white-space: nowrap;
  margin-left: 0.5rem;
}

.drop-zone {
  border: 2px dashed var(--border-color);
  border-radius: 12px;
  padding: 2rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.drop-zone:hover,
.drop-zone.drag-over {
  border-color: var(--accent-primary);
  background: rgba(94, 106, 210, 0.05);
}

.drop-zone.disabled {
  opacity: 0.5;
  pointer-events: none;
  cursor: default;
}

.drop-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary);
}

.drop-icon {
  font-size: 2rem;
}

.drop-content p {
  margin: 0;
  font-size: 0.875rem;
}

.drop-hint {
  font-size: 0.75rem !important;
  color: var(--text-tertiary);
}

.selected-files {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.75rem;
}

.selected-file {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  background: var(--bg-secondary);
  border-radius: 6px;
}

.selected-file .file-name {
  flex: 1;
}

.progress-bar {
  position: relative;
  height: 1.5rem;
  background: var(--bg-secondary);
  border-radius: 8px;
  overflow: hidden;
  margin-top: 0.75rem;
}

.progress-fill {
  height: 100%;
  background: var(--accent-primary);
  transition: width 0.2s ease;
}

.progress-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-primary);
}

.submit-btn {
  margin-top: 0.75rem;
  width: 100%;
}

.closed-notice {
  text-align: center;
  color: var(--text-tertiary);
  padding: 1rem;
  margin: 0;
}
</style>
