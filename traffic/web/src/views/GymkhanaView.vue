<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useEntryStore } from '../stores/entry'
import { useSerialStore, msToClockStr } from '../stores/serial'
import { useNotification } from '../composables/useNotification'
import { addRecord } from '../composables/useApi'

const { notyf } = useNotification()
const entryStore = useEntryStore()
const serial = useSerialStore()

const eventName = ref('')
const selectedTeamLane1 = ref(null)
const selectedTeamLane2 = ref(null)
const savedRecords = ref({ 1: null, 2: null })

const displayRecords = ref({ 1: [], 2: [] })

async function onSensor({ sensor, tick, greenTick }) {
  const entry = sensor === 1 ? entry1.value : entry2.value
  const result = tick - greenTick

  // 유효한 기록 측정 시 센서 1초 쿨다운
  serial.setSensorCooldown(sensor)
  displayRecords.value[sensor].push({ result, time: msToClockStr(result) })

  // 이미 저장된 경우 세션당 1회만 저장
  if (savedRecords.value[sensor]) return

  // 자동 저장 조건: 이벤트 이름과 해당 레인의 참가팀이 선택된 경우만
  if (!eventName.value.trim() || !entry) {
    return
  }

  const recordData = {
    time: new Date(),
    type: 'gymkhana',
    entry: { num: entry.num, univ: entry.univ, team: entry.team },
    result,
    detail: `레인 ${sensor}`
  }

  try {
    await addRecord(eventName.value.trim(), recordData)
    savedRecords.value[sensor] = { result, time: msToClockStr(result) }
    notyf.success(`${sensor}번 레인 기록 저장: ${msToClockStr(result)}`)
  } catch (e) {
    notyf.error(`기록 저장 실패: ${e.message}`)
  }
}

onMounted(() => {
  serial.setMode('gymkhana', onSensor)
  if (!entryStore.isLoaded) entryStore.loadEntries()
})

const currentYear = computed(() => new Date().getFullYear())
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim() || 'Gymkhana'}`)
const entry1 = computed(() => entryStore.getEntryByNum(selectedTeamLane1.value))
const entry2 = computed(() => entryStore.getEntryByNum(selectedTeamLane2.value))
const entryDisplay1 = computed(() => entry1.value ? `#${entry1.value.num} ${entry1.value.univ} ${entry1.value.team}` : '')
const entryDisplay2 = computed(() => entry2.value ? `#${entry2.value.num} ${entry2.value.univ} ${entry2.value.team}` : '')
const isLocked = computed(() => serial.green.active)
const entries = computed(() => entryStore.entries)
const canAutoSave = computed(() => eventName.value.trim() && (selectedTeamLane1.value || selectedTeamLane2.value))

watch(selectedTeamLane1, (newVal) => {
  if (newVal && newVal === selectedTeamLane2.value) {
    selectedTeamLane1.value = null
    notyf.error('이미 다른 레인에 선택된 팀입니다.')
  }
})

watch(selectedTeamLane2, (newVal) => {
  if (newVal && newVal === selectedTeamLane1.value) {
    selectedTeamLane2.value = null
    notyf.error('이미 다른 레인에 선택된 팀입니다.')
  }
})

function handleConnect() { serial.connect() }
function handleGreen() {
  if (!canAutoSave.value) {
    notyf.open({ type: 'warning', message: '테스트 모드' })
  }
  savedRecords.value = { 1: null, 2: null }
  displayRecords.value = { 1: [], 2: [] }
  serial.sendGreen()
}
function handleRed() { serial.sendRed() }
function handleOff() { serial.sendOff() }
function handleReset() {
  savedRecords.value = { 1: null, 2: null }
  displayRecords.value = { 1: [], 2: [] }
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
            <button class="btn btn-success" :disabled="!serial.connected || serial.green.active" @click="handleGreen">녹색등</button>
            <button class="btn btn-ghost" :disabled="!serial.connected || serial.lightColor === 'grey'" @click="handleOff">OFF</button>
            <button class="btn btn-danger" :disabled="!serial.connected || serial.lightColor === 'red'" @click="handleRed">적색등</button>
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
          <div class="form-group">
            <label class="form-label">이벤트 이름</label>
            <input v-model="eventName" type="text" class="form-input" :disabled="isLocked">
          </div>
          <div class="form-group">
            <label class="form-label">레인 1 참가팀</label>
            <select v-model="selectedTeamLane1" class="form-input" :disabled="isLocked">
              <option :value="null" disabled>팀 선택</option>
              <option v-for="entry in entries" :key="entry.num" :value="entry.num">
                {{ entry.num }} {{ entry.univ }} {{ entry.team }}
              </option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">레인 2 참가팀</label>
            <select v-model="selectedTeamLane2" class="form-input" :disabled="isLocked">
              <option :value="null" disabled>팀 선택</option>
              <option v-for="entry in entries" :key="entry.num" :value="entry.num">
                {{ entry.num }} {{ entry.univ }} {{ entry.team }}
              </option>
            </select>
          </div>
          <button class="btn btn-warning btn-block" :disabled="!serial.records.length" @click="handleReset">초기화</button>
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

      <div class="lanes-section">
        <div v-if="selectedTeamLane1" class="lane-card card">
          <div class="card-header">
            <h3>
              <span class="lane-badge">1</span>
              {{ entryDisplay1 }}
            </h3>
          </div>
          <div class="card-body">
            <div v-if="displayRecords[1].length" class="record-list">
              <div v-for="(r, i) in displayRecords[1]" :key="i" class="record-item" :class="{ 'is-saved': savedRecords[1] && savedRecords[1].result === r.result }">
                +{{ r.time }}
                <span v-if="savedRecords[1] && savedRecords[1].result === r.result" class="save-indicator">💾</span>
              </div>
            </div>
            <div v-else class="empty-state">대기 중...</div>
          </div>
        </div>
        
        <div v-if="selectedTeamLane2" class="lane-card card">
          <div class="card-header">
            <h3>
              <span class="lane-badge">2</span>
              {{ entryDisplay2 }}
            </h3>
          </div>
          <div class="card-body">
            <div v-if="displayRecords[2].length" class="record-list">
              <div v-for="(r, i) in displayRecords[2]" :key="i" class="record-item" :class="{ 'is-saved': savedRecords[2] && savedRecords[2].result === r.result }">
                +{{ r.time }}
                <span v-if="savedRecords[2] && savedRecords[2].result === r.result" class="save-indicator">💾</span>
              </div>
            </div>
            <div v-else class="empty-state">대기 중...</div>
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

.header-icon { width: 18px; height: 18px; }
.card-body { padding: 1.25rem; }

.form-group { margin-bottom: 1rem; }
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

.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-block { width: 100%; }
.btn-icon { width: 16px; height: 16px; }
.btn-success { background: var(--accent-success); color: white; }
.btn-danger { background: var(--accent-danger); color: white; }
.btn-warning { background: var(--accent-warning); color: white; }
.btn-ghost { background: transparent; color: var(--text-secondary); border: 1px solid var(--border-color); }
.btn-group { display: flex; gap: 0.5rem; }
.btn-group .btn { flex: 1; }

.monitor-header { text-align: center; }

.event-title {
  font-size: 2.5rem;
  margin: 0 0 0.5rem;
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
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

.traffic-light.green { background: #10b981; box-shadow: 0 0 20px rgba(16, 185, 129, 0.5); }
.traffic-light.red { background: #ef4444; box-shadow: 0 0 20px rgba(239, 68, 68, 0.5); }

.clock {
  font-size: 3rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-primary);
}

.lanes-section {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

.lane-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  border-radius: 8px;
  color: white;
  font-weight: 700;
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

.record-item.is-saved {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.save-indicator {
  margin-left: 0.5rem;
}

@media (max-width: 1024px) {
  .page-layout { grid-template-columns: 1fr; }
  .sidebar { flex-direction: row; flex-wrap: wrap; }
  .sidebar .card { flex: 1; min-width: 280px; }
  .lanes-section { grid-template-columns: 1fr; }
}
</style>
