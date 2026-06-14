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

function ageMs(iso) { return iso ? now.value - new Date(iso).getTime() : Infinity; }
function linkState(r) {
  const a = ageMs(r.last_seen);
  if (!isFinite(a) || a > 15000 || r.link_state === "lost") return "lost";
  if (a > 8000 || r.link_state === "degraded") return "degraded";
  return "online";
}
function fmtAge(a) {
  if (!isFinite(a)) return "-";
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
          <tr><th>노드</th><th>상태</th><th>RSSI</th><th>SNR</th><th>offset</th><th>skew</th><th>지연</th><th>수신</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.node_id" :data-testid="`diag-row-${r.node_id}`">
            <td>{{ r.node_id }}</td>
            <td>
              <span class="badge" :class="linkState(r)" :data-testid="`diag-link-${r.node_id}`">
                {{ stateLabel[linkState(r)] }}
              </span>
            </td>
            <td>{{ fmtNum(r.rssi) }} dBm</td>
            <td>{{ fmtNum(r.snr) }} dB</td>
            <td>{{ r.offset_us == null ? "-" : (r.offset_us / 1000).toFixed(2) + " ms" }}</td>
            <td>{{ fmtNum(r.skew_ppm) }} ppm</td>
            <td>{{ fmtNum(r.latency_ms, 0) }} ms</td>
            <td>{{ fmtAge(ageMs(r.last_seen)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
.diag-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.diag-table th, .diag-table td { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08)); }
.diag-table th { color: var(--text-tertiary); font-weight: 600; }
.badge { padding: 0.1rem 0.5rem; border-radius: 6px; font-size: 0.75rem; font-weight: 600; }
.badge.online { background: rgba(16,185,129,0.18); color: var(--accent-success); }
.badge.degraded { background: rgba(245,158,11,0.18); color: var(--accent-warning, #f59e0b); }
.badge.lost { background: rgba(239,68,68,0.18); color: var(--accent-danger); }
</style>
