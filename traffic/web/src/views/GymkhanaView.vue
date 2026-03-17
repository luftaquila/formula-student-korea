<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useEntryStore } from "../stores/entry";
import { useSerialStore, msToClockStr } from "../stores/serial";
import { useNotification } from "@shared/useNotification.js";
import { addRecord } from "../composables/useApi";

const { notyf } = useNotification();
const entryStore = useEntryStore();
const serial = useSerialStore();

const eventName = ref("");
const selectedTeamLane1 = ref(null);
const selectedTeamLane2 = ref(null);
const savedRecords = ref({ 1: null, 2: null });

const displayRecords = ref({ 1: [], 2: [] });

async function onSensor({ sensor, tick, greenTick }) {
  const entry = sensor === 1 ? entry1.value : entry2.value;
  const result = tick - greenTick;

  // 유효한 기록 측정 시 센서 1초 쿨다운
  serial.setSensorCooldown(sensor);
  displayRecords.value[sensor].push({ result, time: msToClockStr(result) });

  // 첫 번째 측정은 무시 (두 번째 측정부터 저장)
  if (displayRecords.value[sensor].length === 1) return;

  // 이미 저장된 경우 세션당 1회만 저장
  if (savedRecords.value[sensor]) return;

  // 자동 저장 조건: 이벤트 이름과 해당 레인의 참가팀이 선택된 경우만
  if (!eventName.value.trim() || !entry) {
    return;
  }

  const firstRecord = displayRecords.value[sensor][0];
  const recordData = {
    time: new Date(),
    type: "짐카나",
    entry: { num: entry.num, univ: entry.univ, team: entry.team },
    result,
    detail: `레인 ${sensor} / ${firstRecord.result} ms delay`,
  };

  try {
    await addRecord(eventName.value.trim(), recordData);
    savedRecords.value[sensor] = { result, time: msToClockStr(result) };
    notyf.success(`${sensor}번 레인 기록 저장: ${msToClockStr(result)}`);
  } catch (e) {
    notyf.error(`기록 저장 실패: ${e.message}`);
  }
}

onMounted(() => {
  serial.setMode("gymkhana", onSensor);
  if (!entryStore.isLoaded) entryStore.loadEntries();
});

const currentYear = computed(() => new Date().getFullYear());
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim() || "Gymkhana"}`);
const entry1 = computed(() => entryStore.getEntryByNum(selectedTeamLane1.value));
const entry2 = computed(() => entryStore.getEntryByNum(selectedTeamLane2.value));
const entryDisplay1 = computed(() =>
  entry1.value ? `#${entry1.value.num} ${entry1.value.univ} ${entry1.value.team}` : "",
);
const entryDisplay2 = computed(() =>
  entry2.value ? `#${entry2.value.num} ${entry2.value.univ} ${entry2.value.team}` : "",
);
const isLocked = computed(() => serial.green.active);
const entries = computed(() => entryStore.entries);
const canAutoSave = computed(() => eventName.value.trim() && (selectedTeamLane1.value || selectedTeamLane2.value));

watch(selectedTeamLane1, (newVal) => {
  if (newVal && newVal === selectedTeamLane2.value) {
    selectedTeamLane1.value = null;
    notyf.error("이미 다른 레인에 선택된 팀입니다.");
  }
});

watch(selectedTeamLane2, (newVal) => {
  if (newVal && newVal === selectedTeamLane1.value) {
    selectedTeamLane2.value = null;
    notyf.error("이미 다른 레인에 선택된 팀입니다.");
  }
});

function handleConnect() {
  serial.connect();
}
function handleGreen() {
  if (!canAutoSave.value) {
    notyf.open({ type: "warning", message: "테스트 모드" });
  }
  savedRecords.value = { 1: null, 2: null };
  displayRecords.value = { 1: [], 2: [] };
  serial.sendGreen();
}
function handleRed() {
  serial.sendRed();
}
function handleOff() {
  serial.sendOff();
}
function handleReset() {
  savedRecords.value = { 1: null, 2: null };
  displayRecords.value = { 1: [], 2: [] };
  serial.reset();
}

async function handleDNF(lane) {
  const entry = lane === 1 ? entry1.value : entry2.value;
  if (!eventName.value.trim() || !entry) {
    notyf.error("이벤트 이름과 해당 레인의 팀을 선택하세요.");
    return;
  }

  const recordData = {
    time: new Date(),
    type: "짐카나",
    entry: { num: entry.num, univ: entry.univ, team: entry.team },
    result: -1,
  };

  try {
    await addRecord(eventName.value.trim(), recordData);
    notyf.success(`${lane}번 레인 DNF 기록 저장`);
  } catch (e) {
    notyf.error(`DNF 저장 실패: ${e.message}`);
  }
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
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M12 3v4M8 7V5M16 7V5" />
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
            {{ serial.connected ? "연결됨" : "컨트롤러 연결" }}
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
            신호등 제어
          </h3>
        </div>
        <div class="card-body">
          <div class="btn-group">
            <button class="btn btn-success" :disabled="!serial.connected || serial.green.active" @click="handleGreen">
              녹색등
            </button>
            <button
              class="btn btn-ghost"
              :disabled="!serial.connected || serial.lightColor === 'grey'"
              @click="handleOff"
            >
              OFF
            </button>
            <button
              class="btn btn-danger"
              :disabled="!serial.connected || serial.lightColor === 'red'"
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
          <div class="btn-group">
            <button
              class="btn btn-danger"
              :disabled="!eventName.trim() || !selectedTeamLane1 || (!serial.records.length && !serial.green.active)"
              @click="handleDNF(1)"
            >
              1번 DNF
            </button>
            <button
              class="btn btn-danger"
              :disabled="!eventName.trim() || !selectedTeamLane2 || (!serial.records.length && !serial.green.active)"
              @click="handleDNF(2)"
            >
              2번 DNF
            </button>
          </div>
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
              <div
                v-for="(r, i) in displayRecords[1]"
                :key="i"
                class="record-item"
                :class="{ 'is-saved': savedRecords[1] && savedRecords[1].result === r.result }"
              >
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
              <div
                v-for="(r, i) in displayRecords[2]"
                :key="i"
                class="record-item"
                :class="{ 'is-saved': savedRecords[2] && savedRecords[2].result === r.result }"
              >
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
@import "../assets/styles/event-view.css";

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

@media (max-width: 1024px) {
  .lanes-section {
    grid-template-columns: 1fr;
  }
}
</style>
