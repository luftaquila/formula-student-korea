<script setup>
// 출발 센서 → 도착 센서 측정 경기(가속·오토크로스). 두 경기는 이름 3개(config)만 다르고
// 로직·템플릿은 동일하다. config = { mode, type, defaultTitle }.
// source 미지정 시 유선(serial) store. 무선 모드에선 wireless store의 facade가 주입됨.
import { ref, computed, watch, onMounted, onActivated, onDeactivated, onUnmounted } from "vue";
import { useEntryStore } from "../stores/entry";
import { useSerialStore, msToClockStr } from "../stores/serial";
import { useNotification } from "@shared/useNotification.js";
import { addRecord } from "../composables/useApi";
import { useAutoSavedRecord } from "../composables/useAutoSavedRecord";
import EventNameField from "../components/EventNameField.vue";
import RecordQuickEdit from "../components/RecordQuickEdit.vue";

const { notyf } = useNotification();
const entryStore = useEntryStore();
const props = defineProps({
  source: { type: Object, default: null },
  wireless: { type: Boolean, default: false },
  config: { type: Object, required: true }, // { mode, type, defaultTitle }
});
const serial = props.source ?? useSerialStore();

const eventName = ref("다이나믹");
const selectedTeam = ref(null);
const startRecord = ref(null);
const savedRecord = ref(null);
const displayRecord = ref(null);
const quickEditSaveState = ref("ready");

async function onSensor({ sensor, tick }) {
  // 모든 센서에 쿨다운 적용
  serial.setSensorCooldown(sensor);

  if (sensor === 1) {
    if (!startRecord.value) {
      startRecord.value = { tick };
    }
  } else if (sensor === 2 && startRecord.value) {
    // 이미 기록이 있으면 무시 (세션당 1회만)
    if (displayRecord.value) return;

    const result = tick - startRecord.value.tick;
    const entry = selectedEntry.value;

    displayRecord.value = { result, time: msToClockStr(result) };

    // 자동 저장 조건: 이벤트 이름과 참가팀 모두 선택된 경우
    if (!eventName.value.trim() || !entry) {
      return;
    }
    // 무선: 서버 기록 엔진이 저장(세션 선택 정보로 귀속). 클라는 표시만 — 이중저장 방지.
    if (props.wireless) return;

    const recordData = {
      time: new Date(),
      type: props.config.type,
      entry: { num: entry.num, univ: entry.univ, team: entry.team },
      result,
    };
    const runToken = getRunToken();

    try {
      const created = await addRecord(eventName.value.trim(), recordData);
      if (runToken !== getRunToken()) return;
      captureRecord(created, runToken);
      savedRecord.value = { result, time: msToClockStr(result) };
      notyf.success(`기록 저장: ${msToClockStr(result)}`);
    } catch (e) {
      notyf.error(`기록 저장 실패: ${e.message}`);
    }
  }
}

onMounted(() => {
  serial.setMode(props.config.mode, onSensor);
  if (!entryStore.isLoaded) entryStore.loadEntries();
});

onActivated(() => {
  serial.setMode(props.config.mode, onSensor);
});

const currentYear = computed(() => new Date().getFullYear());
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim() || props.config.defaultTitle}`);
const selectedEntry = computed(() => (selectedTeam.value ? entryStore.getEntryByNum(selectedTeam.value) : null));
const isLocked = computed(() => serial.green.active);
// 신호등 게이팅: 유선=연결 여부, 무선=녹색등(인수)은 브리지면 가능 / 적·소등은 점유자만.
// 컨트롤러(무선=lease 보유자, 유선=로컬)만 선택·제어. 관찰자는 read-only.
const isController = computed(() => (props.wireless ? serial.isController : true));
const lightReady = computed(() => (props.wireless ? isController.value : serial.connected));
const canStopLight = computed(() => (props.wireless ? isController.value : serial.connected));
// 무선 경기 세션(서버 권위 선택·arm). 관찰자 뷰가 컨트롤러의 팀·이벤트명을 미러.
const session = computed(() => serial.session);
const resetPending = ref(false);
function clearMeasurement() {
  startRecord.value = null;
  savedRecord.value = null;
  displayRecord.value = null;
}
watch(session, (s, previous) => {
  if (!props.wireless || !s) return;
  if (!isController.value) {
    eventName.value = s.event_name || "";
    selectedTeam.value = s.team?.num ?? null;
  }
  if (s.run_id !== previous?.run_id) clearMeasurement();
  if (resetPending.value && s.light_color === "off") {
    clearMeasurement();
    endRun();
    resetPending.value = false;
  }
}, { immediate: true });
const startRecords = computed(() => serial.records.filter((r) => r.sensor === 1));
const endRecords = computed(() => serial.records.filter((r) => r.sensor === 2));
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
  resetPending.value = true;
  if (await serial.reset() === false) resetPending.value = false;
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
    type: props.config.type,
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

// 무선: 선택(팀·이벤트명)을 세션에 공유(컨트롤러만). 타이핑 폭주 방지 위해 디바운스.
let selectTimer = null;
watch([eventName, selectedTeam], () => {
  if (!props.wireless) return;
  clearTimeout(selectTimer);
  selectTimer = setTimeout(() => {
    serial.selectEvent?.(selectedEntry.value, eventName.value.trim() || null);
  }, 400);
});
// keep-alive: 탭 이탈은 onDeactivated(언마운트 아님). 둘 다에서 디바운스 타이머 정리(이탈 후 stale select 방지).
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
            :disabled="!isController || (!serial.records.length && !serial.green.active)"
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
          <div class="btn-group">
            <button class="btn btn-primary" data-testid="manual-sensor-1" @click="serial.manualSensor(1)">센서 1 (출발선)</button>
            <button class="btn btn-primary" data-testid="manual-sensor-2" @click="serial.manualSensor(2)">센서 2 (도착선)</button>
          </div>
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
        <div class="card-header record-header">
          <h3>🏁 측정 기록</h3>
          <div v-if="recentRecord && quickEditSaveState === 'saved'" class="save-status" data-testid="quick-save-status" aria-live="polite">
            <span class="status-dot"></span>
            저장됨
          </div>
        </div>
        <div class="card-body">
          <RecordQuickEdit
            v-if="recentRecord"
            :record="recentRecord"
            @update="mergeRecord"
            @save-state="quickEditSaveState = $event"
          >
            <template #summary>
              <div class="saved-item is-saved">
                {{ displayRecord.time }}
                <span class="save-badge">💾</span>
              </div>
            </template>
          </RecordQuickEdit>
          <div v-else class="saved-item" :class="{ 'is-saved': savedRecord }">
            {{ displayRecord.time }}
            <span v-if="savedRecord" class="save-badge">💾</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";

.btn-primary {
  background: var(--accent-primary);
  color: white;
}

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
  font-family: "JetBrains Mono", monospace;
  font-size: 1.125rem;
  font-weight: 600;
  text-align: center;
}

.saved-item {
  width: 100%;
  box-sizing: border-box;
  padding: 0.75rem 1rem;
  background: var(--bg-secondary);
  border-radius: 8px;
  font-family: "JetBrains Mono", monospace;
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
  .records-section {
    grid-template-columns: 1fr;
  }
}
</style>
