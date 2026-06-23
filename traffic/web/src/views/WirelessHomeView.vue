<script setup>
import { ref } from "vue";
import { useSSE } from "../composables/useSSE";
import { useWirelessStore } from "../stores/wireless";
import { ingestWireless } from "../composables/useApi";
import WirelessBridgeCard from "../components/WirelessBridgeCard.vue";
import WirelessMappingCard from "../components/WirelessMappingCard.vue";
import WirelessDiagnostics from "../components/WirelessDiagnostics.vue";
import WirelessOverviewView from "./WirelessOverviewView.vue";

// 연결 유지(이 뷰가 떠 있는 동안 SSE 구독)
useSSE();
const store = useWirelessStore();

function onPhysical(e) {
  store.setPhysicalEvent(e.target.value || null);
}

function onDebounce(e) {
  const v = Math.max(0, Math.min(5000, parseInt(e.target.value, 10) || 0));
  store.setDebounceMs(v);
}

// 개발용 시뮬레이션: 서버로 합성 데이터를 ingest해 (하드웨어 없이) 클라이언트 경로 검증
const isDev = import.meta.env.DEV;
const simNode = ref("1");
let simSeq = 1000;
async function simEvent() {
  // master_tick은 16MHz tick(16000/ms). 합성값도 실제 스케일에 맞춰야 클라 변환(tickToMs)이 맞다.
  await ingestWireless({ events: [{ node_id: simNode.value, master_tick: String(Date.now() * 16000), ev_seq: simSeq++, rssi: -62, snr: 9.5, link_state: "online" }] });
}
async function simTelemetry() {
  await ingestWireless({ telemetry: [{ node_id: simNode.value, rssi: -68, snr: 8.5, offset_us: 120, skew_ppm: 4, latency_ms: 22, rx_miss: 0, beacon_gap: 0, link_state: "online" }] });
}
</script>

<template>
  <div class="wl-settings">
    <div class="wl-row">
      <WirelessBridgeCard />

      <div class="card">
        <div class="card-header"><h3>🚦 물리 신호등</h3></div>
        <div class="card-body">
          <div class="form-group">
            <select class="form-input" :value="store.physicalKey || ''" data-testid="physical-event" @change="onPhysical">
              <option value="">없음 (전부 가상)</option>
              <option v-for="k in store.WIRELESS_EVENTS" :key="k" :value="k">{{ store.EVENT_TYPE[k] }}</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>⏱️ 센서 디바운스</h3></div>
      <div class="card-body">
        <div class="debounce-row">
          <input
            type="number" class="form-input debounce-input" min="0" max="5000" step="50"
            :value="store.debounceMs" data-testid="debounce-ms" @change="onDebounce"
          />
          <span class="unit">ms</span>
        </div>
      </div>
    </div>

    <WirelessMappingCard />
    <WirelessDiagnostics />

    <div v-if="isDev" class="card">
      <div class="card-header"><h3>🧪 시뮬레이터 (개발용)</h3></div>
      <div class="card-body">
        <div class="sim-row">
          <label class="form-label">노드</label>
          <input v-model="simNode" class="form-input sim-node" data-testid="sim-node" />
          <button class="btn btn-success btn-sm" data-testid="sim-event" @click="simEvent">이벤트 발생</button>
          <button class="btn btn-ghost btn-sm" data-testid="sim-telemetry" @click="simTelemetry">진단 발생</button>
        </div>
      </div>
    </div>

    <!-- 전 경기 라이브 현황(읽기 전용) — 무선 설정 하단에 통합. -->
    <WirelessOverviewView class="wl-overview-embed" />
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
.wl-settings {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 920px;
  margin: 0 auto;
  width: 100%;
}
.wl-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: start;
}
.sim-row { display: flex; align-items: center; gap: 0.6rem; }
.sim-node { max-width: 90px; }
.debounce-row { display: flex; align-items: center; gap: 0.5rem; }
.debounce-input { max-width: 120px; }
.debounce-row .unit { color: var(--text-muted, #888); font-size: 0.9rem; }
.btn-sm { padding: 0.4rem 0.8rem; font-size: 0.8rem; }
/* 임베드된 현황: 자체 페이지 패딩/최대폭/auto 마진 제거. (마진 auto가 남으면 flex 열에서
   stretch 대신 shrink-to-fit 되어 auto-fit 그리드가 1열로 collapse된다.)
   선택자는 조상 .wl-settings 기준 — 클래스 wl-overview-embed는 .overview 루트 자신이라
   ".wl-overview-embed .overview"(하위 탐색)로는 매칭되지 않는다. */
.wl-settings :deep(.overview) { padding: 0; max-width: none; margin: 0; }
/* 한 줄에 최대 2열(데스크탑/태블릿), 좁은 화면에선 단일열. */
.wl-settings :deep(.overview-grid) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}
@media (max-width: 768px) {
  .wl-row { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .wl-settings :deep(.overview-grid) { grid-template-columns: 1fr; }
}
</style>
