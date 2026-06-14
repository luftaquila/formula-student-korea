<script setup>
import { ref } from "vue";
import { useSSE } from "../composables/useSSE";
import { useWirelessStore } from "../stores/wireless";
import { ingestWireless } from "../composables/useApi";
import { EVENT_TYPE } from "../composables/useEventTiming";
import WirelessBridgeCard from "../components/WirelessBridgeCard.vue";
import WirelessMappingCard from "../components/WirelessMappingCard.vue";
import WirelessDiagnostics from "../components/WirelessDiagnostics.vue";

// 연결 유지(이 뷰가 떠 있는 동안 SSE 구독)
useSSE();
const store = useWirelessStore();

const eventLinks = [
  { key: "accel", path: "/wireless/accel", label: "🏎️ 가속" },
  { key: "skidpad", path: "/wireless/skidpad", label: "⏱️ 스키드패드" },
  { key: "autocross", path: "/wireless/autocross", label: "🚧 오토크로스" },
  { key: "gymkhana", path: "/wireless/gymkhana", label: "🏁 짐카나" },
];

// 개발용 시뮬레이션: 서버로 합성 이벤트를 ingest하여 (하드웨어 없이) 클라이언트 경로 검증
const isDev = import.meta.env.DEV;
const simNode = ref("1");
let simSeq = 1000;
async function simEvent() {
  const masterTick = String(Date.now() * 16); // 임의 마스터 tick(ms*16 → 대략적 16MHz)
  await ingestWireless({ events: [{ node_id: simNode.value, master_tick: masterTick, ev_seq: simSeq++, rssi: -62, snr: 9.5, link_state: "online" }] });
}
async function simTelemetry() {
  await ingestWireless({ telemetry: [{ node_id: simNode.value, rssi: -68, snr: 8.5, offset_us: 120, skew_ppm: 4, latency_ms: 22, link_state: "online" }] });
}
</script>

<template>
  <div class="wl-home">
    <div class="monitor-header">
      <h2 class="event-title">무선 계측 (LoRa)</h2>
      <router-link to="/record" class="btn btn-ghost">← 유선/기록으로</router-link>
    </div>

    <div class="wl-grid">
      <WirelessBridgeCard />

      <div class="card">
        <div class="card-header"><h3>🏁 경기 콘솔</h3></div>
        <div class="card-body">
          <p class="wl-lockline">
            신호등 점유:
            <strong v-if="store.ownerKey">{{ store.EVENT_TYPE[store.ownerKey] }}</strong>
            <span v-else class="muted">없음</span>
          </p>
          <div class="wl-links">
            <router-link v-for="l in eventLinks" :key="l.key" :to="l.path" class="btn btn-ghost wl-link">{{ l.label }}</router-link>
          </div>
        </div>
      </div>

      <WirelessMappingCard class="wl-wide" />
      <WirelessDiagnostics class="wl-wide" />

      <div v-if="isDev" class="card wl-wide">
        <div class="card-header"><h3>🧪 시뮬레이터 (DEV)</h3></div>
        <div class="card-body">
          <div class="sim-row">
            <label class="form-label">노드</label>
            <input v-model="simNode" class="form-input sim-node" data-testid="sim-node" />
            <button class="btn btn-primary btn-sm" data-testid="sim-event" @click="simEvent">이벤트 발생</button>
            <button class="btn btn-ghost btn-sm" data-testid="sim-telemetry" @click="simTelemetry">진단 발생</button>
          </div>
          <p class="wl-hint">서버로 합성 데이터를 보내 SSE 경로를 검증합니다(하드웨어 불필요).</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
.wl-home { max-width: 1100px; margin: 0 auto; padding: 1rem; }
.wl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
.wl-wide { grid-column: 1 / -1; }
.wl-links { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.wl-link { flex: 1 1 40%; }
.wl-lockline { margin-bottom: 0.75rem; }
.muted { color: var(--text-tertiary); }
.sim-row { display: flex; align-items: center; gap: 0.5rem; }
.sim-node { max-width: 80px; }
.btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
.wl-hint { font-size: 0.78rem; color: var(--text-tertiary); margin-top: 0.5rem; }
@media (max-width: 768px) { .wl-grid { grid-template-columns: 1fr; } }
</style>
