<script setup>
import { reactive, computed, watch } from "vue";
import { useWirelessStore } from "../stores/wireless";
import { putWirelessMapping, deleteWirelessMapping } from "../composables/useApi";
import { useNotification } from "@shared/useNotification.js";
import { EVENT_TYPE } from "../composables/useEventTiming";

const { notyf } = useNotification();
const store = useWirelessStore();
const eventTypes = Object.values(EVENT_TYPE);

function roleOptions(et) {
  if (et === "가속") return ["start", "finish"];
  if (et === "짐카나") return ["lane1", "lane2"];
  return ["start"];
}
const roleLabel = { start: "출발", finish: "도착", lane1: "레인 1", lane2: "레인 2" };

// 발견된 노드 = 진단 수신 노드 ∪ 기존 매핑 노드
const nodes = computed(() => {
  const s = new Set([...Object.keys(store.telemetry), ...store.mapping.map((m) => m.node_id)]);
  return [...s].sort();
});

// 행별 편집 초안. 편집 중인 행은 서버 갱신으로 덮어쓰지 않는다.
const draft = reactive({});
function seed() {
  for (const node of nodes.value) {
    if (draft[node]?._dirty) continue;
    const m = store.mapping.find((x) => x.node_id === node);
    draft[node] = m
      ? { event_type: m.event_type, role: m.role, label: m.label || "", enabled: m.enabled !== 0, _dirty: false }
      : { event_type: eventTypes[0], role: "start", label: "", enabled: true, _dirty: false };
  }
}
watch([nodes, () => store.mapping], seed, { immediate: true, deep: true });

function markDirty(node) {
  const d = draft[node];
  if (d && !roleOptions(d.event_type).includes(d.role)) d.role = roleOptions(d.event_type)[0];
  if (d) d._dirty = true;
}

async function save(node) {
  const d = draft[node];
  try {
    await putWirelessMapping(node, { event_type: d.event_type, role: d.role, label: d.label, enabled: d.enabled ? 1 : 0 });
    d._dirty = false;
    notyf.success(`센서 ${node} 할당 저장`);
  } catch (e) { notyf.error(e.message); }
}

async function remove(node) {
  try {
    await deleteWirelessMapping(node);
    notyf.success(`센서 ${node} 할당 삭제`);
  } catch (e) { notyf.error(e.message); }
}
</script>

<template>
  <div class="card">
    <div class="card-header"><h3>🔗 센서 할당</h3></div>
    <div class="card-body">
      <div v-if="!nodes.length" class="empty-state">
        아직 발견된 센서가 없습니다. 마스터 연결 후 센서가 동기화되면 표시됩니다.
      </div>
      <table v-else class="assign-table">
        <thead>
          <tr><th>센서</th><th>경기</th><th>역할</th><th>사용</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="node in nodes" :key="node" :data-testid="`mapping-row-${node}`">
            <td class="mono node">{{ node }}</td>
            <td>
              <select v-model="draft[node].event_type" class="form-input" @change="markDirty(node)">
                <option v-for="et in eventTypes" :key="et" :value="et">{{ et }}</option>
              </select>
            </td>
            <td>
              <select v-model="draft[node].role" class="form-input" @change="markDirty(node)">
                <option v-for="r in roleOptions(draft[node].event_type)" :key="r" :value="r">{{ roleLabel[r] || r }}</option>
              </select>
            </td>
            <td class="center">
              <input type="checkbox" v-model="draft[node].enabled" @change="markDirty(node)" />
            </td>
            <td class="actions">
              <button class="btn btn-success btn-sm" :data-testid="`mapping-save-${node}`" @click="save(node)">저장</button>
              <button class="btn btn-ghost btn-sm" @click="remove(node)">삭제</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
.assign-table { width: 100%; border-collapse: collapse; }
.assign-table th, .assign-table td { padding: 0.5rem 0.6rem; text-align: left; border-bottom: 1px solid var(--border-color); vertical-align: middle; }
.assign-table th { color: var(--text-tertiary); font-weight: 600; font-size: 0.8rem; }
.assign-table tbody tr:last-child td { border-bottom: none; }
.assign-table .form-input { padding: 0.45rem 0.6rem; }
.node { font-weight: 700; }
.mono { font-family: "JetBrains Mono", monospace; }
.center { text-align: center; }
.actions { display: flex; gap: 0.4rem; justify-content: flex-end; }
.btn-sm { padding: 0.35rem 0.7rem; font-size: 0.8rem; }
@media (max-width: 640px) {
  .assign-table, .assign-table thead, .assign-table tbody, .assign-table tr, .assign-table td { display: block; }
  .assign-table thead { display: none; }
  .assign-table tr { border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 0.6rem; padding: 0.4rem; }
  .assign-table td { border: none; }
  .actions { justify-content: flex-start; }
}
</style>
