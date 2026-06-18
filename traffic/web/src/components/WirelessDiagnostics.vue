<script setup>
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useWirelessStore } from "../stores/wireless";

const store = useWirelessStore();
const now = ref(Date.now());
let timer = null;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (timer) clearInterval(timer); });

const rows = computed(() =>
  Object.values(store.telemetry).sort((a, b) => String(a.node_id).localeCompare(String(b.node_id))),
);

// 서버 last_seen은 서버 시계 기준 → 클라이언트 시계와 살짝 어긋나면 음수가 될 수 있어 0으로 클램프.
function ageMs(iso) { return iso ? Math.max(0, now.value - new Date(iso).getTime()) : Infinity; }
function linkState(r) {
  const a = ageMs(r.last_seen);
  if (!isFinite(a) || a > 15000 || r.link_state === "lost") return "lost";
  if (a > 8000 || r.link_state === "degraded") return "degraded";
  return "online";
}
function fmtAge(a) {
  if (!isFinite(a)) return "-";
  if (a < 1500) return "방금";
  const s = Math.floor(a / 1000);
  return s < 60 ? `${s}s 전` : `${Math.floor(s / 60)}m 전`;
}
function fmtNum(v, d = 1) { return v == null || Number.isNaN(v) ? "-" : Number(v).toFixed(d); }
const stateLabel = { online: "연결", degraded: "지연", lost: "끊김" };
</script>

<template>
  <div class="card">
    <div class="card-header"><h3>📶 센서 진단</h3></div>
    <div class="card-body">
      <div v-if="!rows.length" class="empty-state">수신된 센서가 없습니다.</div>
      <table v-else class="diag-table">
        <thead>
          <tr>
            <th>노드</th>
            <th>상태</th>
            <th class="has-tip" title="마스터가 측정한 센서 신호 세기 (dBm). 0에 가까울수록 강함">RSSI</th>
            <th class="has-tip" title="신호 대 잡음비 (dB). 높을수록 깨끗한 수신">SNR</th>
            <th class="has-tip" title="센서 클럭의 마스터 대비 편차 (ppm). 0에 가까워야 정상">드리프트</th>
            <th class="has-tip" title="센서가 부팅 후 놓친 비콘 수. (연속 N)은 지금 연속으로 놓친 개수">누락</th>
            <th class="has-tip" title="이벤트가 마스터에 도달하기까지 걸린 시간 (ms)">지연</th>
            <th class="has-tip" title="마스터가 이 센서를 마지막으로 들은 시각">수신</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.node_id" :data-testid="`diag-row-${r.node_id}`">
            <td class="mono">{{ r.node_id }}</td>
            <td>
              <span class="badge" :class="linkState(r)" :data-testid="`diag-link-${r.node_id}`">
                {{ stateLabel[linkState(r)] }}
              </span>
            </td>
            <td class="mono">{{ fmtNum(r.rssi) }} dBm</td>
            <td class="mono">{{ fmtNum(r.snr) }} dB</td>
            <td class="mono">{{ fmtNum(r.skew_ppm) }} ppm</td>
            <td class="mono">
              {{ r.rx_miss ?? 0 }}<span v-if="r.beacon_gap" class="gap"> (연속 {{ r.beacon_gap }})</span>
            </td>
            <td class="mono">{{ fmtNum(r.latency_ms, 0) }} ms</td>
            <td class="mono">{{ fmtAge(ageMs(r.last_seen)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
/* table-layout: fixed + 고정 너비 → 셀 내용 길이가 바뀌어도 열 폭이 안 흔들림 */
.diag-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: fixed; }
.diag-table th, .diag-table td { padding: 0.55rem 0.6rem; text-align: left; border-bottom: 1px solid var(--border-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.diag-table th { color: var(--text-tertiary); font-weight: 600; }
/* 설명 툴팁(native title)이 달린 헤더 — 호버 가능함을 점선 밑줄 + help 커서로 암시 */
.diag-table th.has-tip { cursor: help; text-decoration: underline dotted; text-underline-offset: 3px; }
.diag-table tbody tr:last-child td { border-bottom: none; }
.diag-table th:nth-child(1), .diag-table td:nth-child(1) { width: 8%; }
.diag-table th:nth-child(2), .diag-table td:nth-child(2) { width: 12%; }
.diag-table th:nth-child(3), .diag-table td:nth-child(3) { width: 16%; }
.diag-table th:nth-child(4), .diag-table td:nth-child(4) { width: 13%; }
.diag-table th:nth-child(5), .diag-table td:nth-child(5) { width: 15%; }
.diag-table th:nth-child(6), .diag-table td:nth-child(6) { width: 13%; }
.diag-table th:nth-child(7), .diag-table td:nth-child(7) { width: 11%; }
.diag-table th:nth-child(8), .diag-table td:nth-child(8) { width: 12%; }
.mono { font-family: "JetBrains Mono", monospace; font-variant-numeric: tabular-nums; }
.gap { color: var(--accent-warning, #f59e0b); }
.badge { padding: 0.15rem 0.6rem; border-radius: 6px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
.badge.online { background: rgba(16,185,129,0.18); color: var(--accent-success); }
.badge.degraded { background: rgba(245,158,11,0.18); color: var(--accent-warning, #f59e0b); }
.badge.lost { background: rgba(239,68,68,0.18); color: var(--accent-danger); }
</style>
