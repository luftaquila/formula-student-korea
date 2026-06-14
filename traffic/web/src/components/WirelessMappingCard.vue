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
    notyf.success(`매핑 저장: ${node}`);
  } catch (e) { notyf.error(e.message); }
}

async function remove(node) {
  try {
    await deleteWirelessMapping(node);
    notyf.success(`매핑 삭제: ${node}`);
  } catch (e) { notyf.error(e.message); }
}
</script>

<template>
  <div class="card">
    <div class="card-header"><h3>🔗 센서 → 경기·역할 매핑</h3></div>
    <div class="card-body">
      <div v-if="!nodes.length" class="empty-state">아직 발견된 센서가 없습니다. 마스터 연결 후 센서가 동기화되면 표시됩니다.</div>
      <div v-for="node in nodes" :key="node" class="map-row" :data-testid="`mapping-row-${node}`">
        <span class="map-node">{{ node }}</span>
        <select v-model="draft[node].event_type" class="form-input" @change="markDirty(node)">
          <option v-for="et in eventTypes" :key="et" :value="et">{{ et }}</option>
        </select>
        <select v-model="draft[node].role" class="form-input" @change="markDirty(node)">
          <option v-for="r in roleOptions(draft[node].event_type)" :key="r" :value="r">{{ r }}</option>
        </select>
        <label class="map-enabled"><input type="checkbox" v-model="draft[node].enabled" @change="markDirty(node)" /> 사용</label>
        <button class="btn btn-success btn-sm" :data-testid="`mapping-save-${node}`" @click="save(node)">저장</button>
        <button class="btn btn-ghost btn-sm" @click="remove(node)">삭제</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
.map-row { display: grid; grid-template-columns: 70px 1fr 1fr auto auto auto; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
.map-node { font-family: "JetBrains Mono", monospace; font-weight: 700; }
.map-enabled { font-size: 0.8rem; white-space: nowrap; display: flex; align-items: center; gap: 0.25rem; }
.btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
@media (max-width: 768px) { .map-row { grid-template-columns: 1fr 1fr; } }
</style>
