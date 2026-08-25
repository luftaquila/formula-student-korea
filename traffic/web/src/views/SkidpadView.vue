<script setup>
import { ref, computed, watch, onMounted, onActivated, onDeactivated, onUnmounted } from "vue";
import { useEntryStore } from "../stores/entry";
import { useSerialStore, msToClockStr } from "../stores/serial";
import { useNotification } from "@shared/useNotification.js";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { addRecord } from "../composables/useApi";
import { useAutoSavedRecord } from "../composables/useAutoSavedRecord";
import EventNameField from "../components/EventNameField.vue";
import RecordQuickEdit from "../components/RecordQuickEdit.vue";

const { notyf } = useNotification();
const entryStore = useEntryStore();
const props = defineProps({ source: { type: Object, default: null }, wireless: { type: Boolean, default: false } });
const serial = props.source ?? useSerialStore();

const eventName = ref("다이나믹");
const selectedTeam = ref(null);
const lapTimes = ref([]);
const lastTick = ref(null);
const lap2Time = ref(null);
const savedRecord = ref(null);
const quickEditSaveState = ref("ready");

async function onSensor({ sensor, tick, startTick }) {
  if (sensor !== 1) return;

  const prevTick = lastTick.value ?? startTick;
  if (prevTick === null) {
    lastTick.value = tick;
    return;
  }

  const lapTime = tick - prevTick;
  lastTick.value = tick;

  const entry = selectedEntry.value;
  const lapNumber = lapTimes.value.length + 1;

  // 유효한 기록 측정 시 센서 1초 쿨다운
  serial.setSensorCooldown(sensor);
  lapTimes.value.push({ lap: lapNumber, time: lapTime, display: msToClockStr(lapTime) });

  // 무선 클라이언트도 서버 저장 행을 현재 런과 대조할 수 있도록 랩 2는 저장 여부와 무관하게 보관한다.
  if (lapNumber === 2) lap2Time.value = lapTime;

  // 자동 저장 조건: 이벤트 이름과 참가팀 모두 선택된 경우
  if (!eventName.value.trim() || !entry) {
    return;
  }
  // 무선: 서버 기록 엔진이 lap2+lap4를 계산·저장. 클라는 랩 표시만 — 이중저장 방지.
  if (props.wireless) return;

  // 랩 2: 시간만 저장해두고 실제 저장은 하지 않음
  if (lapNumber === 2) {
    return;
  }

  // 랩 4: 랩 2와 합쳐서 저장
  if (lapNumber === 4 && lap2Time.value !== null && !savedRecord.value) {
    const totalTime = lap2Time.value + lapTime;
    const recordData = {
      time: new Date(),
      type: "스키드패드",
      entry: { id: entry.id, num: entry.num, univ: entry.univ, team: entry.team },
      result: totalTime,
      detail: `${msToClockStr(lap2Time.value)} / ${msToClockStr(lapTime)}`,
    };
    const runToken = getRunToken();

    try {
      const created = await addRecord(eventName.value.trim(), recordData);
      if (runToken !== getRunToken()) return;
      captureRecord(created, runToken);
      savedRecord.value = { total: totalTime, lap2: lap2Time.value, lap4: lapTime };
      notyf.success(`스키드패드 저장: ${msToClockStr(totalTime)}`);
    } catch (e) {
      notyf.error(`기록 저장 실패: ${e.message}`);
    }
  }
}

onMounted(() => {
  serial.setMode("skidpad", onSensor);
  if (!entryStore.isLoaded) entryStore.loadEntries();
});

onActivated(() => {
  serial.setMode("skidpad", onSensor);
});

const currentYear = computed(() => currentCompetitionYear());
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim() || "Skidpad"}`);
const selectedEntry = computed(() => (selectedTeam.value ? entryStore.getEntryByNum(selectedTeam.value) : null));
const isLocked = computed(() => serial.green.active);
// 컨트롤러(무선=lease 보유자, 유선=로컬)만 선택·제어. 관찰자는 read-only — 세션에서 미러.
const isController = computed(() => (props.wireless ? serial.isController : true));
const lightReady = computed(() => (props.wireless ? isController.value : serial.connected));
const canStopLight = computed(() => (props.wireless ? isController.value : serial.connected));
const session = computed(() => serial.session);
const resetSubmitting = ref(false);
const resetInProgress = computed(() => props.wireless && (resetSubmitting.value || !!session.value?.reset_pending));
function clearMeasurement() {
  lapTimes.value = [];
  lastTick.value = null;
  lap2Time.value = null;
  savedRecord.value = null;
}
watch(session, (s, previous) => {
  if (!props.wireless || !s) return;
  if (!isController.value) {
    eventName.value = s.event_name || "";
    selectedTeam.value = s.team?.num ?? null;
  }
  if (s.run_id !== previous?.run_id) clearMeasurement();
}, { immediate: true });
const totalTime = computed(() => msToClockStr(lapTimes.value.reduce((sum, lap) => sum + lap.time, 0)));
const entries = computed(() => entryStore.entries);
const canAutoSave = computed(() => eventName.value.trim() && selectedTeam.value);
const {
  recentRecord,
  captureRecord,
  mergeRecord,
  beginRun,
  endRun,
  getRunToken,
} = useAutoSavedRecord({
  wireless: () => props.wireless,
  session: () => serial.session,
});

function handleConnect() {
  serial.connect();
}
function handleGreen() {
  if (!canAutoSave.value) {
    notyf.open({ type: "warning", message: "테스트 모드" });
  }
  if (!props.wireless) {
    clearMeasurement();
    beginRun();
  }
  // 무선: arm 직전 현재 선택을 서버 세션에 flush(물리 경기 귀속 + 관찰자 미러). 가상 경기는
  // 추가로 sendGreen에 선택을 실어 arm 본문으로 bind-at-arm(레이스 무관 귀속 고정).
  if (props.wireless) serial.selectEvent?.(selectedEntry.value, eventName.value.trim() || null);
  serial.sendGreen(selectedEntry.value, eventName.value.trim() || null);
}
function handleRed() {
  serial.sendRed();
}
function handleOff() {
  serial.sendOff();
}
async function handleReset() {
  if (!props.wireless) {
    clearMeasurement();
    endRun();
    serial.reset();
    return;
  }
  resetSubmitting.value = true;
  try {
    await serial.reset();
  } finally {
    resetSubmitting.value = false;
  }
}

async function handleDNF() {
  const entry = selectedEntry.value;
  if (!eventName.value.trim() || !entry) {
    notyf.error("이벤트 이름과 팀을 선택하세요.");
    return;
  }

  // 무선: 서버가 세션 선택 정보로 DNF 저장. 유선: 로컬 저장.
  if (props.wireless) {
    try { await serial.dnf(); notyf.success("DNF 기록 저장"); }
    catch (e) { notyf.error(`DNF 저장 실패: ${e.message}`); }
    return;
  }

  const recordData = {
    time: new Date(),
    type: "스키드패드",
    entry: { id: entry.id, num: entry.num, univ: entry.univ, team: entry.team },
    result: -1,
  };

  try {
    await addRecord(eventName.value.trim(), recordData);
    notyf.success("DNF 기록 저장");
  } catch (e) {
    notyf.error(`DNF 저장 실패: ${e.message}`);
  }
}

// 무선: 선택(팀·이벤트명)을 세션에 공유(컨트롤러만). 디바운스.
let selectTimer = null;
watch([eventName, selectedTeam], () => {
  if (!props.wireless) return;
  clearTimeout(selectTimer);
  selectTimer = setTimeout(() => {
    serial.selectEvent?.(selectedEntry.value, eventName.value.trim() || null);
  }, 400);
});
// keep-alive: 탭 이탈은 onDeactivated(언마운트 아님). 둘 다에서 디바운스 타이머 정리.
onDeactivated(() => clearTimeout(selectTimer));
onUnmounted(() => clearTimeout(selectTimer));

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
          <!-- 경기 제어권(lease): 보유자만 제어. 비-브리지 PC도 제어권을 잡아 네트워크 제어 가능. -->
          <div v-if="wireless" class="lease-row">
            <button v-if="!serial.controller" class="btn btn-block btn-ghost" @click="serial.claimLease()">제어</button>
            <button v-else-if="isController" class="btn btn-block btn-success" @click="serial.releaseLease()">제어 해제</button>
            <div v-else class="lease-locked">
              🔒 {{ serial.controller }} 제어 중
              <button class="btn btn-ghost lease-take" @click="serial.takeoverLease()">가로채기</button>
            </div>
          </div>
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
            <EventNameField v-model="eventName" :disabled="isLocked || !isController" />
          </div>
          <div class="form-group">
            <label class="form-label">참가팀</label>
            <select v-model="selectedTeam" class="form-input" data-testid="event-team" :disabled="isLocked || !isController">
              <option :value="null">팀 선택</option>
              <option v-for="entry in entries" :key="entry.num" :value="entry.num">
                {{ entry.num }} {{ entry.univ }} {{ entry.team }}
              </option>
            </select>
          </div>
          <button
            class="btn btn-danger btn-block"
            :disabled="!isController || !canAutoSave || (!serial.records.length && !serial.green.active)"
            @click="handleDNF"
          >
            DNF
          </button>
          <button
            class="btn btn-warning btn-block mt-1"
            :disabled="!isController || resetSubmitting || (!serial.records.length && !serial.green.active && !recentRecord)"
            @click="handleReset"
          >
            {{ resetSubmitting ? "초기화 요청 중…" : (session?.reset_pending ? "OFF 확인 대기 · 다시 전송" : "초기화") }}
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
          <button class="btn btn-primary btn-block" data-testid="manual-sensor-1" @click="serial.manualSensor(1)">센서 1 (랩 통과)</button>
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

      <div class="lap-section card">
        <div class="card-header record-header">
          <h3>💾 랩 타임</h3>
          <div v-if="recentRecord && quickEditSaveState === 'saved'" class="save-status" data-testid="quick-save-status" aria-live="polite">
            <span class="status-dot"></span>
            저장됨
          </div>
        </div>
        <div class="card-body">
          <div v-if="lapTimes.length === 0" class="empty-state">센서 통과 대기 중...</div>
          <div v-else class="lap-list">
            <div
              v-for="lap in lapTimes"
              :key="lap.lap"
              class="lap-item"
              :class="{ 'is-saved': savedRecord && (lap.lap === 2 || lap.lap === 4) }"
            >
              <span class="lap-number"
                >Lap {{ lap.lap }} <span v-if="savedRecord && (lap.lap === 2 || lap.lap === 4)">💾</span></span
              >
              <span class="lap-time">{{ lap.display }}</span>
            </div>
            <div class="total-row">
              <span class="total-label">TOTAL</span>
              <span class="total-value">{{ totalTime }}</span>
            </div>
          </div>
          <RecordQuickEdit
            v-if="recentRecord"
            :record="recentRecord"
            :disabled="resetInProgress"
            :disabled-message="resetInProgress ? '마스터의 OFF 확인을 기다리는 중입니다. 기록 편집은 확인 후 종료됩니다.' : ''"
            @update="mergeRecord"
            @save-state="quickEditSaveState = $event"
          />
        </div>
      </div>

      <div v-if="serial.records.length" class="sensor-section card">
        <div class="card-header"><h3>📡 센서 기록</h3></div>
        <div class="card-body">
          <div class="sensor-list">
            <span v-for="(r, i) in serial.records" :key="i" class="sensor-item">+{{ msToClockStr(r.time) }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";

.lease-row {
  margin-bottom: 0.75rem;
}
.lease-locked {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-tertiary);
  font-size: 0.875rem;
}
.lease-take {
  padding: 0.4rem 0.85rem;
  font-size: 0.8125rem;
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
  font-family: "JetBrains Mono", monospace;
  color: var(--text-primary);
}

.team-placeholder {
  color: var(--text-tertiary);
  font-weight: 400;
}

.lap-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.lap-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.lap-item.is-saved {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.lap-number {
  font-weight: 600;
  color: var(--text-secondary);
}

.lap-time {
  font-size: 1.125rem;
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: var(--accent-success);
}

.total-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  margin-top: 0.5rem;
  background: rgba(94, 106, 210, 0.1);
  border-radius: 8px;
  border: 1px solid rgba(94, 106, 210, 0.2);
}

.total-label {
  font-weight: 800;
  letter-spacing: 0.1em;
  color: var(--accent-primary);
}

.total-value {
  font-size: 1.25rem;
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  color: var(--accent-primary);
}

.sensor-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.sensor-item {
  padding: 0.375rem 0.75rem;
  background: var(--bg-secondary);
  border-radius: 6px;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  color: var(--text-secondary);
}
</style>
