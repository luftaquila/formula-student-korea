<script setup>
import { ref, computed, watch, onMounted, onActivated, onDeactivated, onUnmounted } from "vue";
import { useEntryStore } from "../stores/entry";
import { useSerialStore, msToClockStr } from "../stores/serial";
import { useNotification } from "@shared/useNotification.js";
import { formatEnduranceDetail, enduranceTotal } from "@shared/event-timing.js";
import { addRecord, updateRecord } from "../composables/useApi";

const { notyf } = useNotification();
const entryStore = useEntryStore();
const props = defineProps({ source: { type: Object, default: null }, wireless: { type: Boolean, default: false } });
const serial = props.source ?? useSerialStore();

const eventName = ref("");
const selectedTeam = ref(null);
const targetLaps = ref(null); // 미리 정해진 목표 랩 수(표시용, 클라 로컬). 0/빈값=미설정.
const lapTimes = ref([]);
const lastTick = ref(null);

// 유선: 랩을 기록 1건에 이어붙인다. 첫 랩 INSERT 시 받은 테이블명/rowid를 보관해 이후 랩마다 UPDATE.
const recordName = ref(null);
const recordRowid = ref(null);
// 저장 직렬화: 빠른 연속 랩이 INSERT를 중복 생성하지 않도록 순차 실행(첫 INSERT 완료 후 UPDATE).
let persistChain = Promise.resolve();

function clearRun() {
  lapTimes.value = [];
  lastTick.value = null;
  recordName.value = null;
  recordRowid.value = null;
  persistChain = Promise.resolve();
}

// 유선 저장: 현재까지의 전체 랩으로 result(총합)·detail(랩 목록)을 갱신. 첫 호출 INSERT, 이후 UPDATE.
async function persistLap(entry) {
  const lapsMs = lapTimes.value.map((l) => l.time);
  const total = enduranceTotal(lapsMs);
  const detail = formatEnduranceDetail(lapsMs);
  try {
    if (recordRowid.value == null) {
      const { name, record } = await addRecord(eventName.value.trim(), {
        time: new Date(),
        type: "내구",
        entry: { num: entry.num, univ: entry.univ, team: entry.team },
        result: total,
        detail,
      });
      recordName.value = name;
      recordRowid.value = record.rowid;
    } else {
      await updateRecord(recordName.value, recordRowid.value, "result", total);
      await updateRecord(recordName.value, recordRowid.value, "detail", detail);
    }
  } catch (e) {
    notyf.error(`기록 저장 실패: ${e.message}`);
  }
}

function onSensor({ sensor, tick, startTick }) {
  if (sensor !== 1) return;

  const prevTick = lastTick.value ?? startTick;
  if (prevTick === null) {
    lastTick.value = tick; // 첫 통과 = 출발선(t0)
    return;
  }

  const lap = tick - prevTick;
  lastTick.value = tick;
  if (lap < 0) return; // 음수/역순 가드

  // 유효한 랩 측정 시 센서 쿨다운(유선만 — 무선 source는 no-op)
  serial.setSensorCooldown(sensor);
  lapTimes.value.push({ lap: lapTimes.value.length + 1, time: lap, display: msToClockStr(lap) });

  // 무선: 서버 기록 엔진이 랩을 이어붙여 저장. 클라는 표시만 — 이중 저장 방지.
  if (props.wireless) return;

  // 유선: 이벤트명+팀이 선택된 경우에만 저장. 미선택이면 표시만(테스트 모드).
  const entry = selectedEntry.value;
  if (!eventName.value.trim() || !entry) return;
  persistChain = persistChain.then(() => persistLap(entry));
}

onMounted(() => {
  serial.setMode("endurance", onSensor);
  if (!entryStore.isLoaded) entryStore.loadEntries();
});

onActivated(() => {
  serial.setMode("endurance", onSensor);
});

const currentYear = computed(() => new Date().getFullYear());
const titleText = computed(() => `${currentYear.value} FSK ${eventName.value.trim() || "Endurance"}`);
const selectedEntry = computed(() => (selectedTeam.value ? entryStore.getEntryByNum(selectedTeam.value) : null));
const isLocked = computed(() => serial.green.active);
// 컨트롤러(무선=lease 보유자, 유선=로컬)만 선택·제어. 관찰자는 read-only — 세션에서 미러.
const isController = computed(() => (props.wireless ? serial.isController : true));
const lightReady = computed(() => (props.wireless ? isController.value : serial.connected));
const canStopLight = computed(() => (props.wireless ? isController.value : serial.connected));
const session = computed(() => serial.session);
watch(session, (s) => {
  if (!props.wireless || isController.value || !s) return;
  eventName.value = s.event_name || "";
  selectedTeam.value = s.team?.num ?? null;
}, { immediate: true });
const entries = computed(() => entryStore.entries);
const canSave = computed(() => eventName.value.trim() && selectedTeam.value);

// 통계
const lapMsList = computed(() => lapTimes.value.map((l) => l.time));
const lapCount = computed(() => lapMsList.value.length);
const totalMs = computed(() => enduranceTotal(lapMsList.value));
const totalDisplay = computed(() => msToClockStr(totalMs.value));
const bestLapMs = computed(() => (lapMsList.value.length ? Math.min(...lapMsList.value) : null));
const lastLapMs = computed(() => (lapMsList.value.length ? lapMsList.value[lapMsList.value.length - 1] : null));
const avgLapMs = computed(() => (lapMsList.value.length ? Math.round(totalMs.value / lapMsList.value.length) : null));
const fmt = (ms) => (ms == null ? "—" : msToClockStr(ms));
const targetReached = computed(() => targetLaps.value > 0 && lapCount.value >= targetLaps.value);
const lapProgress = computed(() => (targetLaps.value > 0 ? `${lapCount.value} / ${targetLaps.value}` : String(lapCount.value)));
// 최고 랩과의 차이(초). 최고 랩 행은 표시 안 함.
function deltaStr(ms) {
  if (bestLapMs.value == null || ms <= bestLapMs.value) return "";
  return `+${((ms - bestLapMs.value) / 1000).toFixed(3)}`;
}

function handleConnect() {
  serial.connect();
}
function handleGreen() {
  if (!canSave.value) {
    notyf.open({ type: "warning", message: "테스트 모드 — 기록이 저장되지 않습니다" });
  }
  clearRun();
  // 무선: arm 직전 현재 선택을 서버 세션에 flush(귀속 + 관찰자 미러). 가상 경기는 sendGreen 본문으로도 바인딩.
  if (props.wireless) serial.selectEvent?.(selectedEntry.value, eventName.value.trim() || null);
  serial.sendGreen(selectedEntry.value, eventName.value.trim() || null);
}
function handleRed() {
  serial.sendRed();
}
function handleOff() {
  serial.sendOff();
}
function handleReset() {
  clearRun();
  serial.reset();
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
onDeactivated(() => clearTimeout(selectTimer));
onUnmounted(() => clearTimeout(selectTimer));

// 새 arm(green.active false→true) 시 view-local 클리어. 관찰자도 새 런마다 깨끗해진다.
watch(() => serial.green.active, (active, prev) => {
  if (active && !prev) clearRun();
});
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
            <input v-model="eventName" type="text" class="form-input" :disabled="isLocked || !isController" />
          </div>
          <div class="form-group">
            <label class="form-label">참가팀</label>
            <select v-model="selectedTeam" class="form-input" :disabled="isLocked || !isController">
              <option :value="null" disabled>팀 선택</option>
              <option v-for="entry in entries" :key="entry.num" :value="entry.num">
                {{ entry.num }} {{ entry.univ }} {{ entry.team }}
              </option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">목표 랩 수</label>
            <input v-model.number="targetLaps" type="number" min="0" class="form-input" placeholder="예: 22" />
          </div>
          <button
            class="btn btn-warning btn-block mt-1"
            :disabled="!isController || (!lapTimes.length && !serial.green.active)"
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

      <!-- 통계 패널 -->
      <div class="stats-grid">
        <div class="stat card" :class="{ done: targetReached }">
          <span class="stat-label">랩</span>
          <span class="stat-value">{{ lapProgress }}</span>
        </div>
        <div class="stat card">
          <span class="stat-label">최고 랩</span>
          <span class="stat-value">{{ fmt(bestLapMs) }}</span>
        </div>
        <div class="stat card">
          <span class="stat-label">평균 랩</span>
          <span class="stat-value">{{ fmt(avgLapMs) }}</span>
        </div>
        <div class="stat card">
          <span class="stat-label">직전 랩</span>
          <span class="stat-value">{{ fmt(lastLapMs) }}</span>
        </div>
        <div class="stat card">
          <span class="stat-label">총 시간</span>
          <span class="stat-value">{{ totalDisplay }}</span>
        </div>
      </div>

      <!-- 조밀 표(전체 랩) -->
      <div class="lap-section card">
        <div class="card-header"><h3>🏁 랩 기록</h3></div>
        <div class="card-body">
          <div v-if="lapTimes.length === 0" class="empty-state">센서 통과 대기 중...</div>
          <div v-else class="lap-table-wrap">
            <table class="lap-table">
              <thead>
                <tr>
                  <th class="col-lap">랩</th>
                  <th class="col-time">랩타임</th>
                  <th class="col-delta">+최고</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in lapTimes" :key="l.lap" :class="{ 'is-best': l.time === bestLapMs }">
                  <td class="col-lap">{{ l.lap }}</td>
                  <td class="col-time">{{ l.display }}</td>
                  <td class="col-delta">
                    <span v-if="l.time === bestLapMs" class="best-badge">BEST</span>
                    <span v-else class="delta">{{ deltaStr(l.time) }}</span>
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="total-row">
                  <td class="col-lap">TOTAL</td>
                  <td class="col-time">{{ totalDisplay }}</td>
                  <td class="col-delta"></td>
                </tr>
              </tfoot>
            </table>
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
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
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

/* 통계 패널 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.875rem 0.5rem;
}
.stat-label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}
.stat-value {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
}
.stat.done {
  border: 1px solid rgba(16, 185, 129, 0.5);
  background: rgba(16, 185, 129, 0.1);
}
.stat.done .stat-value {
  color: var(--accent-success);
}

/* 조밀 표 */
.lap-table-wrap {
  max-height: 420px;
  overflow-y: auto;
}
.lap-table {
  width: 100%;
  border-collapse: collapse;
  font-family: "JetBrains Mono", monospace;
}
.lap-table th {
  position: sticky;
  top: 0;
  background: var(--bg-card);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.lap-table td {
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.lap-table .col-lap {
  width: 4rem;
  color: var(--text-secondary);
  font-weight: 600;
}
.lap-table .col-time {
  font-weight: 700;
  color: var(--text-primary);
}
.lap-table .col-delta {
  width: 6rem;
  text-align: right;
}
.lap-table tr.is-best .col-time {
  color: var(--accent-success);
}
.best-badge {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--accent-success);
}
.delta {
  font-size: 0.8125rem;
  color: var(--text-tertiary);
}
.lap-table tfoot .total-row td {
  border-top: 1px solid rgba(94, 106, 210, 0.3);
  border-bottom: none;
  font-weight: 800;
  color: var(--accent-primary);
  position: sticky;
  bottom: 0;
  background: var(--bg-card);
}
</style>
