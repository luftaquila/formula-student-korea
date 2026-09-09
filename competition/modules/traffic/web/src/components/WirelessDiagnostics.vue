<script setup>
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useWirelessStore } from "../stores/wireless";

const store = useWirelessStore();
// 서버 보정 현재시각으로 1초마다 갱신(재렌더 트리거 + last_seen 경과 계산 기준).
const now = ref(store.serverNow());
let timer = null;
onMounted(() => { timer = setInterval(() => { now.value = store.serverNow(); }, 1000); });
onUnmounted(() => { if (timer) clearInterval(timer); });

// node "0" = 마스터(자체 진단), 그 외 = 센서(칩 ID 16-hex). 마스터를 맨 위로, 센서는 ID 문자열 순.
const rows = computed(() =>
  Object.values(store.telemetry).sort((a, b) => {
    const am = String(a.node_id) === "0", bm = String(b.node_id) === "0";
    if (am !== bm) return am ? -1 : 1; // 마스터 먼저
    return String(a.node_id).localeCompare(String(b.node_id));
  }),
);

function isMaster(r) { return String(r.node_id) === "0"; }
const nodeLabel = (r) => (isMaster(r) ? "마스터" : r.node_id);

// last_seen은 서버 시계 기준 → now도 서버 보정시각(store.serverNow)이라 클라 PC 시계 오차와
// 무관하게 경과가 정확하다. 미세 음수는 0으로 클램프.
function ageMs(iso) { return iso ? Math.max(0, now.value - new Date(iso).getTime()) : Infinity; }
// STATUS는 5초마다 도착한다. 비콘-앵커 STATUS라 정상이면 유실이 없어 경과는 5초 이내를
// 오간다. 임계를 빡빡하게 둬(지연 >8s, 끊김 >15s) STATUS 한 번이라도 빠지면 즉시 드러나게
// 한다 — 너그러운 창으로 누락을 가리지 않는다. 펌웨어가 보낸 link_state도 OR로 존중.
function linkState(r) {
  const a = ageMs(r.last_seen);
  if (!isFinite(a) || a > 15000 || r.link_state === "lost") return "lost";
  if (a > 8000 || r.link_state === "degraded") return "degraded";
  return "online";
}
function fmtAge(a) {
  if (!isFinite(a)) return "-";
  const s = Math.floor(a / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}
function fmtNum(v, d = 1) { return v == null || Number.isNaN(v) ? "-" : Number(v).toFixed(d); }
function fmtTemp(v) { return v == null || Number.isNaN(v) ? "—" : `${(Number(v) / 10).toFixed(1)} °C`; }
function fmtVolt(mv) { return mv == null || Number.isNaN(mv) ? "—" : `${(Number(mv) / 1000).toFixed(3)} V`; }
function clockDrift(r) {
  if (isMaster(r)) return r.usb_ref_valid === 1 ? `${fmtNum(r.usb_ref_ppm, 0)} ppm (USB)` : "SOF 측정 중";
  return `${fmtNum(r.skew_ppm)} ppm`;
}
function timingHealth(r) {
  if (r.provisioned !== 1) return { state: "bad", label: "키 없음" };
  if (r.clock_source !== "xtal") return { state: "bad", label: "RC 차단" };
  if (isMaster(r)) {
    if (r.queue_overflow !== 0) return { state: "bad", label: "큐 오류" };
    return { state: r.usb_ref_valid === 1 ? "good" : "warn", label: r.usb_ref_valid === 1 ? "정상" : "SOF 대기" };
  }
  if (r.capture_overflow !== 0 || r.event_drop !== 0) return { state: "bad", label: "캡처/전달 오류" };
  if (r.sync_valid !== 1 || r.skew_valid !== 1) return { state: "bad", label: "동기 불량" };
  return { state: "good", label: `정상 · ${r.sync_age_ms ?? "-"} ms` };
}
// 대략적 Li-ion SoC: 3.3 V→0 %, 4.2 V→100 % (clamp). 정밀 게이지 아님.
function socPct(mv) {
  return Math.max(0, Math.min(100, Math.round(((mv - 3300) / (4200 - 3300)) * 100)));
}
// 배터리 보조 라벨: 마스터는 USB(충전 레일)라 "충전", 센서는 셀 SoC %(꽉 찬 셀 4.2 V≈100%).
function battTag(r) {
  if (r.batt_mv == null || Number.isNaN(r.batt_mv)) return "";
  return isMaster(r) ? "충전" : `${socPct(r.batt_mv)}%`;
}
const stateLabel = { online: "연결", degraded: "지연", lost: "끊김" };
</script>

<template>
  <div class="card">
    <div class="card-header"><h3>📶 센서 진단</h3></div>
    <div class="card-body">
      <div v-if="!rows.length" class="empty-state">수신된 센서가 없습니다.</div>
      <div v-else class="table-scroll">
      <table class="diag-table">
        <thead>
          <tr>
            <th>노드</th>
            <th>상태</th>
            <th class="has-tip" title="HFXO·동기·캡처·이벤트 큐를 합친 계측 가능 상태">계측</th>
            <th class="has-tip" title="마스터가 측정한 센서 신호 세기 (dBm). 0에 가까울수록 강함">RSSI</th>
            <th class="has-tip" title="신호 대 잡음비 (dB). 높을수록 깨끗한 수신">SNR</th>
            <th class="has-tip" title="센서=마스터 대비 skew, 마스터=USB SOF 대비 HFXO 관측값(교정에는 사용하지 않음)">클럭 편차</th>
            <th class="has-tip" title="센서가 부팅 후 놓친 비콘 수. (N)은 지금 연속으로 놓친 개수">누락</th>
            <th class="has-tip" title="이벤트가 마스터에 도달하기까지 걸린 시간 (ms)">지연</th>
            <th class="has-tip" title="nRF 다이(칩) 온도. 주변 온도보다 몇 °C 높게 나옴">온도</th>
            <th class="has-tip batt-col" title="센서=배터리 셀 추정치, 마스터=충전 레일 전압 (mV)">배터리</th>
            <th class="has-tip" title="마스터가 이 노드를 마지막으로 들은 시각">수신</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.node_id" :data-testid="`diag-row-${r.node_id}`" :class="{ 'master-row': isMaster(r) }">
            <td class="mono node">{{ nodeLabel(r) }}</td>
            <td>
              <span class="badge" :class="linkState(r)" :data-testid="`diag-link-${r.node_id}`">
                {{ stateLabel[linkState(r)] }}
              </span>
            </td>
            <td><span class="health" :class="timingHealth(r).state">{{ timingHealth(r).label }}</span></td>
            <td class="mono">{{ isMaster(r) ? "—" : `${fmtNum(r.rssi)} dBm` }}</td>
            <td class="mono">{{ isMaster(r) ? "—" : `${fmtNum(r.snr)} dB` }}</td>
            <td class="mono" :data-testid="`diag-clock-${r.node_id}`">{{ clockDrift(r) }}</td>
            <td class="mono">
              <template v-if="isMaster(r)">—</template>
              <template v-else>{{ r.rx_miss ?? 0 }}<span :class="{ gap: r.beacon_gap }"> ({{ r.beacon_gap ?? 0 }})</span></template>
            </td>
            <td class="mono">{{ isMaster(r) ? "—" : `${fmtNum(r.latency_ms, 0)} ms` }}</td>
            <td class="mono" :data-testid="`diag-temp-${r.node_id}`">{{ fmtTemp(r.temp_c10) }}</td>
            <td class="mono batt-col" :data-testid="`diag-batt-${r.node_id}`">
              <template v-if="r.batt_mv == null">—</template>
              <template v-else>{{ fmtVolt(r.batt_mv) }}<span class="batt-tag">{{ battTag(r) }}</span></template>
            </td>
            <td class="mono">{{ fmtAge(ageMs(r.last_seen)) }}</td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
/* 좁은 화면에선 가로 스크롤(테이블 구조 유지) — 다른 서비스 테이블과 동일 패턴. */
.table-scroll { overflow-x: auto; }
/* 카드 전체 폭을 채우되(width:100%) 각 열은 내용 최소 너비(width:1%)로, 배터리 열만
   width:100%로 남는 공간을 흡수한다(auth 계정관리 테이블과 동일 관용구). 남는 공간이 없는
   좁은 화면에선 모든 열이 내용 너비가 돼 .table-scroll로 가로 스크롤(기존 동작 유지). */
.diag-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.diag-table th, .diag-table td { padding: 0.55rem 0.8rem; text-align: left; border-bottom: 1px solid var(--border-color); white-space: nowrap; }
.diag-table th:not(.batt-col), .diag-table td:not(.batt-col) { width: 1%; }
.diag-table th.batt-col, .diag-table td.batt-col { width: 100%; }
.diag-table th { color: var(--text-tertiary); font-weight: 600; }
/* 설명 툴팁(native title)이 달린 헤더 — 호버 가능함을 점선 밑줄 + help 커서로 암시 */
.diag-table th.has-tip { cursor: help; text-decoration: underline dotted; text-underline-offset: 3px; }
.diag-table tbody tr:last-child td { border-bottom: none; }
.diag-table td.node { font-weight: 700; }
/* 마스터 행 강조 */
.diag-table tr.master-row td { background: var(--bg-secondary, rgba(127,127,127,0.06)); }
.mono { font-family: "JetBrains Mono", monospace; font-variant-numeric: tabular-nums; }
.gap { color: var(--accent-warning, #f59e0b); }
.batt-tag { margin-left: 0.45rem; color: var(--text-tertiary); }
.badge { padding: 0.15rem 0.6rem; border-radius: 6px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
.badge.online { background: rgba(16,185,129,0.18); color: var(--accent-success); }
.badge.degraded { background: rgba(245,158,11,0.18); color: var(--accent-warning, #f59e0b); }
.badge.lost { background: rgba(239,68,68,0.18); color: var(--accent-danger); }
.health.good { color: var(--accent-success); }
.health.warn { color: var(--accent-warning, #f59e0b); }
.health.bad { color: var(--accent-danger); font-weight: 700; }
</style>
