<script setup>
import { ref, computed, onMounted, onActivated } from "vue";
import { useEntryStore } from "../stores/entry";
import { useSerialStore, msToClockStr } from "../stores/serial";
import { useNotification } from "@shared/useNotification.js";
import { addRecord } from "../composables/useApi";

const { notyf } = useNotification();
const entryStore = useEntryStore();
const props = defineProps({ source: { type: Object, default: null }, wireless: { type: Boolean, default: false } });
const serial = props.source ?? useSerialStore();

const eventName = ref("");
const selectedTeam = ref(null);
const savedRecord = ref(null);

const displayRecords = ref([]);

async function onSensor({ sensor, tick, greenTick }) {
  if (sensor !== 1) return;

  const entry = selectedEntry.value;
  const result = tick - greenTick;

  // 유효한 기록 측정 시 센서 1초 쿨다운
  serial.setSensorCooldown(sensor);
  displayRecords.value.push({ result, time: msToClockStr(result) });

  // 첫 번째 측정은 무시 (두 번째 측정부터 저장)
  if (displayRecords.value.length === 1) return;

  // 이미 저장된 경우 세션당 1회만 저장
  if (savedRecord.value) return;

  // 자동 저장 조건: 이벤트 이름과 참가팀이 선택된 경우만
  if (!eventName.value.trim() || !entry) {
    return;
  }

  const firstRecord = displayRecords.value[0];
  const recordData = {
    time: new Date(),
    type: "오토크로스",
    entry: { num: entry.num, univ: entry.univ, team: entry.team },
    result,
    detail: `${firstRecord.result} ms delay`,
  };

  try {
    await addRecord(eventName.value.trim(), recordData);
    savedRecord.value = { result, time: msToClockStr(result) };
    notyf.success(`기록 저장: ${msToClockStr(result)}`);
  } catch (e) {
    notyf.error(`기록 저장 실패: ${e.message}`);
  }
}

onMounted(() => {
  serial.setMode("autocross", onSensor);
  if (!entryStore.isLoaded) entryStore.loadEntries();
});

onActivated(() => {
  serial.setMode("autocross", onSensor);
});

const currentYear = computed(() => new Date().getFullYear());
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim() || "Autocross"}`);
const selectedEntry = computed(() => entryStore.getEntryByNum(selectedTeam.value));
const entryDisplay = computed(() =>
  selectedEntry.value ? `#${selectedEntry.value.num} ${selectedEntry.value.univ} ${selectedEntry.value.team}` : "",
);
const isLocked = computed(() => serial.green.active);
const lightReady = computed(() => (props.wireless ? serial.isBridge : serial.connected));
const canStopLight = computed(() => (props.wireless ? serial.isBridge : serial.connected));
const entries = computed(() => entryStore.entries);
const canAutoSave = computed(() => eventName.value.trim() && selectedTeam.value);

function handleConnect() {
  serial.connect();
}
function handleGreen() {
  if (!canAutoSave.value) {
    notyf.open({ type: "warning", message: "테스트 모드" });
  }
  savedRecord.value = null;
  displayRecords.value = [];
  serial.sendGreen();
}
function handleRed() {
  serial.sendRed();
}
function handleOff() {
  serial.sendOff();
}
function handleReset() {
  savedRecord.value = null;
  displayRecords.value = [];
  serial.reset();
}

async function handleDNF() {
  const entry = selectedEntry.value;
  if (!eventName.value.trim() || !entry) {
    notyf.error("이벤트 이름과 참가팀을 선택하세요.");
    return;
  }

  const recordData = {
    time: new Date(),
    type: "오토크로스",
    entry: { num: entry.num, univ: entry.univ, team: entry.team },
    result: -1,
  };

  try {
    await addRecord(eventName.value.trim(), recordData);
    notyf.success("DNF 기록 저장");
  } catch (e) {
    notyf.error(`DNF 저장 실패: ${e.message}`);
  }
}
</script>

<template>
  <div class="page-layout">
    <aside class="sidebar">
      <!-- 컨트롤러 연결 카드 (무선 모드에선 숨김 — 마스터 연결은 무선 설정 탭) -->
      <div v-if="!wireless" class="card">
        <div class="card-header">
          <h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M12 3v4M8 7V5M16 7V5" />
            </svg>
            컨트롤러
          </h3>
        </div>
        <div class="card-body">
          <button
            class="btn btn-block"
            :class="serial.connected && !serial.manualMode ? 'btn-success' : 'btn-danger'"
            :disabled="serial.connected"
            @click="handleConnect"
          >
            {{ serial.connected && !serial.manualMode ? "연결됨" : "컨트롤러 연결" }}
          </button>
          <button
            class="btn btn-block mt-1"
            :class="serial.manualMode ? 'btn-success' : 'btn-ghost'"
            :disabled="serial.connected && !serial.manualMode"
            @click="serial.manualMode ? serial.disableManualMode() : serial.enableManualMode()"
            data-testid="manual-mode-toggle"
          >
            {{ serial.manualMode ? "매뉴얼 모드 ON" : "매뉴얼 모드" }}
          </button>
        </div>
      </div>

      <!-- 신호등 제어 카드 -->
      <div class="card">
        <div class="card-header">
          <h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="header-icon">
              <rect x="6" y="2" width="12" height="20" rx="2" />
              <circle cx="12" cy="8" r="2" />
              <circle cx="12" cy="16" r="2" />
            </svg>
            신호등 제어<span v-if="wireless"> ({{ serial.isPhysical ? "물리" : "가상" }})</span>
          </h3>
        </div>
        <div class="card-body">
          <div class="btn-group">
            <button class="btn btn-success" :disabled="!lightReady || serial.green.active" @click="handleGreen">
              녹색등
            </button>
            <button
              class="btn btn-ghost"
              :disabled="!canStopLight || serial.lightColor === 'grey'"
              @click="handleOff"
            >
              OFF
            </button>
            <button
              class="btn btn-danger"
              :disabled="!canStopLight || serial.lightColor === 'red'"
              @click="handleRed"
            >
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
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
              />
            </svg>
            경기 설정
          </h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">이벤트 이름</label>
            <input v-model="eventName" type="text" class="form-input" :disabled="isLocked" />
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
          <button
            class="btn btn-danger btn-block"
            :disabled="!eventName.trim() || !selectedTeam || (!serial.records.length && !serial.green.active)"
            @click="handleDNF"
          >
            DNF
          </button>
          <button
            class="btn btn-warning btn-block mt-1"
            :disabled="!serial.records.length && !serial.green.active"
            @click="handleReset"
          >
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

      <div v-if="serial.manualMode && serial.green.active" class="manual-sensors card">
        <div class="card-body">
          <button class="btn btn-primary btn-block" data-testid="manual-sensor-1" @click="serial.manualSensor(1)">센서 1 (통과)</button>
        </div>
      </div>

      <div v-if="selectedTeam" class="team-card card">
        <div class="card-header">
          <h3>{{ entryDisplay }}</h3>
        </div>
        <div class="card-body">
          <div v-if="displayRecords.length" class="record-list">
            <div
              v-for="(r, i) in displayRecords"
              :key="i"
              class="record-item"
              :class="{ 'is-saved': savedRecord && savedRecord.result === r.result }"
            >
              +{{ r.time }}
              <span v-if="savedRecord && savedRecord.result === r.result" class="save-indicator">💾</span>
            </div>
          </div>
          <div v-else class="empty-state">대기 중...</div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";

.record-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.record-item {
  padding: 0.5rem 1rem;
  background: var(--bg-secondary);
  border-radius: 8px;
  font-family: "JetBrains Mono", monospace;
  font-size: 1.125rem;
  font-weight: 600;
  text-align: center;
}

.record-item.is-saved {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.save-indicator {
  margin-left: 0.5rem;
}
</style>
