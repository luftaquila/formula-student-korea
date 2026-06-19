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

// 발견된 노드 = 진단 수신 노드 ∪ 기존 매핑 노드. node 0 = 마스터(자가진단)라 센서 할당 대상에서 제외.
const nodes = computed(() => {
  const s = new Set([...Object.keys(store.telemetry), ...store.mapping.map((m) => m.node_id)]);
  s.delete("0");
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

// 행의 저장 상태. saved = DB와 일치(저장됨), 그 외(편집 미저장 or 미할당) = 저장 필요.
function isSaved(node) {
  return store.mapping.some((m) => m.node_id === node) && !draft[node]?._dirty;
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
      <div v-else class="table-scroll">
      <table class="assign-table">
        <thead>
          <tr><th>노드</th><th>경기</th><th>역할</th><th>사용</th><th></th></tr>
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
              <button
                class="btn btn-sm save-btn"
                :class="isSaved(node) ? 'btn-ghost is-saved' : 'btn-success'"
                :disabled="isSaved(node)"
                :data-testid="`mapping-save-${node}`"
                :data-state="isSaved(node) ? 'saved' : 'unsaved'"
                @click="save(node)"
              >{{ isSaved(node) ? "✓ 저장됨" : "저장" }}</button>
              <button class="btn btn-ghost btn-sm" @click="remove(node)">삭제</button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../assets/styles/event-view.css";
/* 좁은 화면: 테이블 구조 유지하고 가로 스크롤(블록 스택 X). 다른 서비스 테이블과 동일. */
.table-scroll { overflow-x: auto; }
.assign-table { width: 100%; min-width: 32rem; border-collapse: collapse; white-space: nowrap; }
.assign-table th, .assign-table td { padding: 0.5rem 0.6rem; text-align: left; border-bottom: 1px solid var(--border-color); vertical-align: middle; }
/* 노드·사용·작업은 내용 최소 너비, 경기·역할(드롭다운)이 남는 폭을 나눠 가져 넓게 표시 → 테이블도 끝까지 참 */
.assign-table th:nth-child(1), .assign-table td:nth-child(1),
.assign-table th:nth-child(4), .assign-table td:nth-child(4),
.assign-table th:nth-child(5), .assign-table td:nth-child(5) { width: 1%; }
.assign-table th { color: var(--text-tertiary); font-weight: 600; font-size: 0.8rem; }
.assign-table tbody tr:last-child td { border-bottom: none; }
.assign-table .form-input { padding: 0.45rem 0.6rem; width: 100%; }
.node { font-weight: 700; }
.mono { font-family: "JetBrains Mono", monospace; }
.center { text-align: center; }
.actions { display: flex; gap: 0.4rem; justify-content: flex-end; }
.btn-sm { padding: 0.35rem 0.7rem; font-size: 0.8rem; }
/* 저장됨 상태: 누를 게 없음을 흐림 + 기본 커서로 표시 */
.save-btn.is-saved { opacity: 0.6; cursor: default; }
.save-btn { min-width: 4.5rem; }
</style>
