<script setup>
import { ref, computed, onMounted } from 'vue'
import { useEntryStore } from '../stores/entry'
import { useSerialStore, msToClockStr } from '../stores/serial'
import { useNotification } from '../composables/useNotification'
import { addRecord } from '../composables/useApi'

const { notyf } = useNotification()
const entryStore = useEntryStore()
const serial = useSerialStore()

const eventName = ref('')
const selectedTeam = ref(null)
const startRecord = ref(null)
const savedRecord = ref(null)
const displayRecord = ref(null)

async function onSensor({ sensor, tick, greenTick }) {
  // 모든 센서에 쿨다운 적용
  serial.setSensorCooldown(sensor)

  if (sensor === 1) {
    if (!startRecord.value) {
      startRecord.value = { tick }
    }
  } else if (sensor === 2 && startRecord.value) {
    // 이미 기록이 있으면 무시 (세션당 1회만)
    if (displayRecord.value) return

    const result = tick - startRecord.value.tick
    const entry = selectedEntry.value

    displayRecord.value = { result, time: msToClockStr(result) }

    // 자동 저장 조건: 이벤트 이름과 참가팀 모두 선택된 경우
    if (!eventName.value.trim() || !entry) {
      return
    }

    const recordData = {
      time: new Date(),
      type: 'accel',
      entry: { num: entry.num, univ: entry.univ, team: entry.team },
      result,
      detail: `${startRecord.value.tick - greenTick} ms delayed start`
    }

    try {
      await addRecord(eventName.value.trim(), recordData)
      savedRecord.value = { result, time: msToClockStr(result) }
      notyf.success(`기록 저장: ${msToClockStr(result)}`)
    } catch (e) {
      notyf.error(`기록 저장 실패: ${e.message}`)
    }
  }
}

onMounted(() => {
  serial.setMode('accel', onSensor)
  if (!entryStore.isLoaded) entryStore.loadEntries()
})

const currentYear = computed(() => new Date().getFullYear())
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim() || 'Acceleration'}`)
const selectedEntry = computed(() => selectedTeam.value ? entryStore.getEntryByNum(selectedTeam.value) : null)
const entryDisplay = computed(() => selectedEntry.value ? `#${selectedEntry.value.num} ${selectedEntry.value.univ} ${selectedEntry.value.team}` : '')
const isLocked = computed(() => serial.green.active)
const startRecords = computed(() => serial.records.filter(r => r.sensor === 1))
const endRecords = computed(() => serial.records.filter(r => r.sensor === 2))
const entries = computed(() => entryStore.entries)
const canAutoSave = computed(() => eventName.value.trim() && selectedTeam.value)

function handleConnect() { serial.connect() }
function handleGreen() {
  if (!canAutoSave.value) {
    notyf.open({ type: 'warning', message: '테스트 모드' })
  }
  startRecord.value = null
  savedRecord.value = null
  displayRecord.value = null
  serial.sendGreen()
}
function handleRed() { serial.sendRed() }
function handleOff() { serial.sendOff() }
function handleReset() {
  startRecord.value = null
  savedRecord.value = null
  displayRecord.value = null
  serial.reset()
}
</script>

<template>
  <div class="page-layout">
    <aside class="sidebar">
      <!-- 컨트롤러 연결 카드 -->
      <div class="card">
        <div class="card-header">
          <h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
              <rect x="2" y="7" width="20" height="14" rx="2"/>
              <path d="M12 3v4M8 7V5M16 7V5"/>
            </svg>
            컨트롤러
          </h3>
        </div>
        <div class="card-body">
          <button 
            class="btn btn-block" 
            :class="serial.connected ? 'btn-success' : 'btn-danger'"
            :disabled="serial.connected"
            @click="handleConnect"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <path d="M6 5v14M18 5v14M6 5a2 2 0 012-2h8a2 2 0 012 2M6 19a2 2 0 002 2h8a2 2 0 002-2M9 9h1M9 12h1M9 15h1M14 9h1M14 12h1M14 15h1"/>
            </svg>
            {{ serial.connected ? '연결됨' : '컨트롤러 연결' }}
          </button>
        </div>
      </div>

      <!-- 신호등 제어 카드 -->
      <div class="card">
        <div class="card-header">
          <h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
              <rect x="6" y="2" width="12" height="20" rx="2"/>
              <circle cx="12" cy="8" r="2"/>
              <circle cx="12" cy="16" r="2"/>
            </svg>
            신호등 제어
          </h3>
        </div>
        <div class="card-body">
          <div class="btn-group">
            <button class="btn btn-success" :disabled="!serial.connected || serial.green.active" @click="handleGreen">
              녹색등
            </button>
            <button class="btn btn-ghost" :disabled="!serial.connected || serial.lightColor === 'grey'" @click="handleOff">
              OFF
            </button>
            <button class="btn btn-danger" :disabled="!serial.connected || serial.lightColor === 'red'" @click="handleRed">
              적색등
            </button>
          </div>
        </div>
      </div>

      <!-- 경기 설정 카드 -->
      <div class="card">
        <div class="card-header">
          <h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
            경기 설정
          </h3>
        </div>
        <div class="card-body">
          <p class="hint-text">이벤트 이름이 같은 경기는 같은 파일에 기록됩니다.</p>
          <div class="form-group">
            <label class="form-label">이벤트 이름</label>
            <input v-model="eventName" type="text" class="form-input" :disabled="isLocked">
          </div>
          <div class="form-group">
            <label class="form-label">참가팀</label>
            <select v-model="selectedTeam" class="form-input" :disabled="isLocked">
              <option :value="null" disabled>팀 선택</option>
              <option v-for="entry in entries" :key="entry.num" :value="entry.num">
                {{ entry.num }} {{ entry.univ }} {{ entry.team }}
              </option>
            </select>
          </div>
          <button class="btn btn-warning btn-block" :disabled="!serial.records.length" @click="handleReset">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon">
              <path d="M3 12a9 9 0 019-9 9.75 9.75 0 016.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
              <path d="M21 12a9 9 0 01-9 9 9.75 9.75 0 01-6.74-2.74L3 16"/>
              <path d="M3 21v-5h5"/>
            </svg>
            초기화
          </button>
        </div>
      </div>
    </aside>

    <section class="content">
      <div class="monitor-header">
        <h2 class="event-title">{{ titleText }}</h2>
      </div>

      <div class="timer-section card">
        <div class="timer-display">
          <span class="traffic-light" :class="serial.lightColor"></span>
          <span class="clock">{{ serial.clockDisplay }}</span>
        </div>
      </div>

      <div class="team-card card">
        <div class="card-header">
          <h3 v-if="selectedEntry">
            <span class="team-badge">#{{ selectedEntry.num }}</span>
            {{ selectedEntry.univ }} {{ selectedEntry.team }}
          </h3>
          <h3 v-else class="team-placeholder">팀을 선택하세요</h3>
        </div>
      </div>

      <div class="records-section">
        <div class="record-card card">
          <div class="card-header"><h3>🚀 출발점 (센서 1)</h3></div>
          <div class="card-body">
            <div v-if="startRecords.length" class="record-list">
              <div v-for="(r, i) in startRecords" :key="i" class="record-item">+{{ msToClockStr(r.time) }}</div>
            </div>
            <div v-else class="empty-state">대기 중...</div>
          </div>
        </div>
        
        <div class="record-card card">
          <div class="card-header"><h3>🏁 도착점 (센서 2)</h3></div>
          <div class="card-body">
            <div v-if="endRecords.length" class="record-list">
              <div v-for="(r, i) in endRecords" :key="i" class="record-item">+{{ msToClockStr(r.time) }}</div>
            </div>
            <div v-else class="empty-state">대기 중...</div>
          </div>
        </div>
      </div>

      <div v-if="displayRecord" class="saved-section card">
        <div class="card-header"><h3>🏁 측정 기록</h3></div>
        <div class="card-body">
          <div class="saved-item" :class="{ 'is-saved': savedRecord }">
            {{ displayRecord.time }}
            <span v-if="savedRecord" class="save-badge">💾</span>
          </div>
        </div>
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
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* Cards */
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

/* Form */
.form-group {
  margin-bottom: 1rem;
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

.hint-text {
  font-size: 0.8125rem;
  color: var(--text-tertiary);
  margin-bottom: 1rem;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.625rem 1.25rem;
  border: none;
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-icon {
  width: 16px;
  height: 16px;
}

.btn-block {
  width: 100%;
}

.btn-primary {
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  color: white;
}

.btn-success {
  background: var(--accent-success);
  color: white;
}

.btn-danger {
  background: var(--accent-danger);
  color: white;
}

.btn-warning {
  background: var(--accent-warning);
  color: white;
}

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}

.btn-group {
  display: flex;
  gap: 0.5rem;
}

.btn-group .btn {
  flex: 1;
}

/* Monitor */
.monitor-header {
  text-align: center;
}

.event-title {
  font-size: 2.5rem;
  margin: 0 0 0.5rem;
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.team-card {
  text-align: center;
}

.team-card .card-header {
  border-bottom: none;
}

.team-card .card-header h3 {
  font-size: 1.25rem;
  justify-content: center;
}

.team-badge {
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-primary);
}

.team-placeholder {
  color: var(--text-tertiary);
  font-weight: 400;
}

.timer-section {
  text-align: center;
}

.timer-display {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  padding: 1rem;
}

.traffic-light {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #6b7280;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
  transition: background-color 0.2s ease;
}

.traffic-light.green {
  background: #10b981;
  box-shadow: 0 0 20px rgba(16, 185, 129, 0.5);
}

.traffic-light.red {
  background: #ef4444;
  box-shadow: 0 0 20px rgba(239, 68, 68, 0.5);
}

.clock {
  font-size: 3rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-primary);
}

/* Records */
.records-section {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

.record-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.record-item {
  padding: 0.5rem 1rem;
  background: var(--bg-secondary);
  border-radius: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.125rem;
  font-weight: 600;
  text-align: center;
}

.empty-state {
  padding: 1rem;
  text-align: center;
  color: var(--text-tertiary);
  font-style: italic;
}

/* Saved */
.saved-section .card-header {
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.2);
}

.saved-section .card-header h3 {
  color: var(--accent-success);
}

.saved-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.saved-item {
  padding: 0.75rem 1rem;
  background: var(--bg-secondary);
  border-radius: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.5rem;
  font-weight: 700;
  text-align: center;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.saved-item.is-saved {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: var(--accent-success);
}

.save-badge {
  font-size: 1rem;
}

@media (max-width: 1024px) {
  .page-layout {
    grid-template-columns: 1fr;
  }
  
  .sidebar {
    flex-direction: row;
    flex-wrap: wrap;
  }
  
  .sidebar .card {
    flex: 1;
    min-width: 280px;
  }
  
  .records-section {
    grid-template-columns: 1fr;
  }
}
</style>
