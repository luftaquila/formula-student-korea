<script setup>
import { ref } from 'vue'
import { getDownloadUrl } from '../api'

const emit = defineEmits(['upload'])

const fileInput = ref(null)
const selectedFile = ref(null)
const isUploading = ref(false)
const isDragging = ref(false)

function handleFileSelect(e) {
  const file = e.target.files?.[0]
  if (file) {
    selectedFile.value = file
  }
}

function handleDrop(e) {
  isDragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file && file.type === 'application/json') {
    selectedFile.value = file
  }
}

function handleDragOver(e) {
  isDragging.value = true
}

function handleDragLeave() {
  isDragging.value = false
}

function clearFile() {
  selectedFile.value = null
  if (fileInput.value) {
    fileInput.value.value = ''
  }
}

async function handleUpload() {
  if (!selectedFile.value) return
  
  isUploading.value = true
  
  try {
    const text = await selectedFile.value.text()
    emit('upload', text)
    clearFile()
  } finally {
    isUploading.value = false
  }
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h3>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        파일 관리
      </h3>
    </div>
    <div class="card-body">
      <!-- Upload Section -->
      <div class="section">
        <label class="form-label">엔트리 업로드</label>
        <div 
          class="drop-zone"
          :class="{ 'dragging': isDragging, 'has-file': selectedFile }"
          @drop.prevent="handleDrop"
          @dragover.prevent="handleDragOver"
          @dragleave="handleDragLeave"
          @click="fileInput?.click()"
        >
          <input 
            ref="fileInput"
            type="file" 
            accept=".json"
            @change="handleFileSelect"
            hidden
          />
          <template v-if="selectedFile">
            <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="file-name">{{ selectedFile.name }}</span>
            <button class="clear-btn" @click.stop="clearFile" title="제거">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </template>
          <template v-else>
            <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span class="drop-text">JSON 파일을 드래그하거나 클릭</span>
          </template>
        </div>
        <button 
          class="btn btn-success upload-btn"
          :disabled="!selectedFile || isUploading"
          @click="handleUpload"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          {{ isUploading ? '업로드 중...' : '업로드' }}
        </button>
      </div>

      <!-- Download Section -->
      <div class="section">
        <label class="form-label">엔트리 다운로드</label>
        <a :href="getDownloadUrl()" class="btn btn-ghost download-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          JSON 다운로드
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.header-icon {
  width: 18px;
  height: 18px;
}

.section {
  margin-bottom: 1.25rem;
}

.section:last-child {
  margin-bottom: 0;
}

.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 1.5rem;
  border: 2px dashed var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 0.75rem;
  background: var(--bg-input);
}

.drop-zone:hover {
  border-color: var(--accent-primary);
  background: rgba(59, 130, 246, 0.05);
}

.drop-zone.dragging {
  border-color: var(--accent-primary);
  background: rgba(59, 130, 246, 0.1);
  transform: scale(1.02);
}

.drop-zone.has-file {
  border-style: solid;
  border-color: var(--accent-success);
  background: rgba(16, 185, 129, 0.05);
}

.upload-icon {
  width: 32px;
  height: 32px;
  color: var(--text-tertiary);
}

.drop-text {
  font-size: 0.8125rem;
  color: var(--text-tertiary);
}

.file-icon {
  width: 28px;
  height: 28px;
  color: var(--accent-success);
}

.file-name {
  font-size: 0.875rem;
  color: var(--text-primary);
  font-weight: 500;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clear-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  width: 24px;
  height: 24px;
  padding: 0;
  background: var(--bg-hover);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: all 0.15s ease;
}

.clear-btn:hover {
  background: var(--accent-danger);
  color: white;
}

.clear-btn svg {
  width: 14px;
  height: 14px;
}

.drop-zone.has-file {
  position: relative;
}

.upload-btn,
.download-btn {
  width: 100%;
}

.upload-btn svg,
.download-btn svg {
  width: 18px;
  height: 18px;
}
</style>

