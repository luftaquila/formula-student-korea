<script setup>
// 무선 계측 read-only 종합 보드. 전 경기의 라이브 상태(신호등·클럭·진행 팀·컨트롤러)를
// 한 화면에 표시. 제어 없음 — 대형 스크린/관전/총괄 모니터링용. 제어는 경기별 뷰에서.
import { computed } from "vue";
import { useWirelessStore } from "../stores/wireless";

const store = useWirelessStore();
const LABEL = store.EVENT_TYPE; // { accel: "가속", ... }

const cards = computed(() =>
  store.WIRELESS_EVENTS.map((mode) => {
    const sess = store.sessions?.[LABEL[mode]] || null;
    const slot = store.timing[mode] || {};
    return {
      mode,
      label: LABEL[mode],
      color: store.lightColorFor(mode), // green | red | grey
      armed: !!sess?.armed,
      clock: slot.clockDisplay || "00:00.000",
      eventName: sess?.event_name || "",
      team: sess?.team || null,
      controller: store.controllerFor(mode),
      isPhysical: store.isPhysical(mode),
    };
  }),
);
</script>

<template>
  <div class="overview">
    <div class="overview-header">
      <h2>무선 계측 현황</h2>
      <span class="bridge-state" :class="{ online: store.bridge.online }">
        {{ store.bridge.online ? "마스터 연결됨" : "마스터 끊김" }}
      </span>
    </div>

    <div class="overview-grid">
      <div v-for="c in cards" :key="c.mode" class="ov-card card" :class="{ armed: c.armed }">
        <div class="ov-top">
          <span class="traffic-light" :class="c.color"></span>
          <h3 class="ov-title">
            {{ c.label }}
            <span v-if="c.isPhysical" class="ov-phys" title="물리 신호등 경기">🚦</span>
          </h3>
          <span class="ov-status" :class="c.armed ? 'on' : 'off'">{{ c.armed ? "측정 중" : "대기" }}</span>
        </div>

        <div class="ov-clock">{{ c.clock }}</div>

        <div class="ov-meta">
          <div class="ov-row">
            <span class="ov-k">경기</span>
            <span class="ov-v">{{ c.eventName || "—" }}</span>
          </div>
          <div class="ov-row">
            <span class="ov-k">팀</span>
            <span class="ov-v">{{ c.team ? `#${c.team.num} ${c.team.univ} ${c.team.team}` : "—" }}</span>
          </div>
          <div class="ov-row">
            <span class="ov-k">제어</span>
            <span class="ov-v">{{ c.controller || "미점유" }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overview {
  padding: 1.5rem;
  max-width: 1400px;
  margin: 0 auto;
}
.overview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}
.overview-header h2 {
  font-size: 1.5rem;
  font-weight: 700;
}
.bridge-state {
  font-size: 0.875rem;
  font-weight: 600;
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-tertiary);
}
.bridge-state.online {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
}
.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.5rem;
}
.ov-card {
  padding: 1.25rem;
  transition: border-color 0.2s ease;
}
.ov-card.armed {
  border: 1px solid rgba(16, 185, 129, 0.4);
}
.ov-top {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.traffic-light {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--text-tertiary);
  flex-shrink: 0;
}
.traffic-light.green {
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
}
.traffic-light.red {
  background: #ef4444;
}
.traffic-light.grey {
  background: var(--text-tertiary);
}
.ov-title {
  font-size: 1.125rem;
  font-weight: 700;
  flex: 1;
}
.ov-phys {
  font-size: 0.9rem;
}
.ov-status {
  font-size: 0.8125rem;
  font-weight: 600;
  padding: 0.125rem 0.625rem;
  border-radius: 999px;
}
.ov-status.on {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
}
.ov-status.off {
  background: var(--bg-secondary);
  color: var(--text-tertiary);
}
.ov-clock {
  font-family: "JetBrains Mono", monospace;
  font-size: 2rem;
  font-weight: 700;
  text-align: center;
  margin: 0.5rem 0 1rem;
}
.ov-meta {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.ov-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.875rem;
}
.ov-k {
  color: var(--text-tertiary);
}
.ov-v {
  font-weight: 600;
  text-align: right;
}
</style>
