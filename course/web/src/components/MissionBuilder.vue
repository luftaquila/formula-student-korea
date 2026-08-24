<script setup>
import { computed, ref, watch } from "vue";
import { duplicateConeIds, filterCones, moveRouteItem, optimizeConeRoute } from "../lib/mission-route.mjs";

const props = defineProps({
  cones: { type: Array, default: () => [] },
  initialItems: { type: Array, default: () => [] },
  presets: { type: Array, default: () => [] },
  currentPosition: { type: Object, default: null },
  initialFinishBehavior: { type: String, default: "stop" },
  editing: { type: Boolean, default: false },
});
const emit = defineEmits(["close", "apply", "run", "save-preset", "delete-preset"]);

const query = ref("");
const side = ref("all");
const route = ref([]);
const finishBehavior = ref("stop");
const presetName = ref("");
const presetId = ref("");
let keySequence = 0;

function routeItem(item) {
  return {
    ...item,
    waypoint_id: item.waypoint_id || (typeof item.id === "string" ? item.id : null),
    client_key: item.client_key || item.id || `route-${item.cone_id}-${keySequence++}`,
  };
}

watch(() => props.initialItems, (items) => {
  route.value = items.map(routeItem);
}, { immediate: true });
watch(() => props.initialFinishBehavior, (value) => {
  finishBehavior.value = value === "return_to_start" ? value : "stop";
}, { immediate: true });

const filteredCones = computed(() => filterCones(props.cones, { query: query.value, side: side.value }));
const selectedIds = computed(() => new Set(route.value.map((item) => item.cone_id)));
const duplicateIds = computed(() => new Set(duplicateConeIds(route.value)));

function fromCone(cone) {
  return routeItem({
    cone_id: cone.id, lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side,
    waypoint_id: null,
  });
}

function toggleCone(cone) {
  if (selectedIds.value.has(cone.id)) {
    route.value = route.value.filter((item) => item.cone_id !== cone.id);
  } else {
    route.value = [...route.value, fromCone(cone)];
  }
}

function addFiltered() {
  const existing = selectedIds.value;
  route.value = [...route.value, ...filteredCones.value.filter((cone) => !existing.has(cone.id)).map(fromCone)];
}

function selectAll() {
  route.value = props.cones.map(fromCone);
}

function move(from, to) {
  route.value = moveRouteItem(route.value, from, to);
}

function moveFromInput(index, event) {
  const target = Math.max(1, Math.min(route.value.length, Number(event.target.value) || index + 1)) - 1;
  move(index, target);
  event.target.value = target + 1;
}

function duplicate(index) {
  if (!window.confirm("같은 콘을 한 번 더 방문하고 분사합니다. 반복 방문을 추가할까요?")) return;
  const copy = routeItem({ ...route.value[index], id: undefined, waypoint_id: null, client_key: undefined });
  const next = [...route.value];
  next.splice(index + 1, 0, copy);
  route.value = next;
}

function loadPreset() {
  const preset = props.presets.find((item) => item.id === Number(presetId.value));
  if (!preset || preset.stale) return;
  route.value = preset.items.map((item) => routeItem({ ...item, id: undefined, waypoint_id: null }));
  finishBehavior.value = preset.finish_behavior;
  presetName.value = preset.name;
}

function payload() {
  return {
    items: route.value.map((item) => ({ ...item })),
    finishBehavior: finishBehavior.value,
  };
}

function savePreset() {
  const name = presetName.value.trim();
  if (!name || route.value.length === 0) return;
  emit("save-preset", { ...payload(), name });
}

let draggedIndex = null;
function dragStart(index) { draggedIndex = index; }
function drop(index) {
  if (draggedIndex != null) move(draggedIndex, index);
  draggedIndex = null;
}
</script>

<template>
  <div class="mission-builder-backdrop" @click.self="emit('close')">
    <section class="mission-builder" role="dialog" aria-modal="true" aria-label="미션 경로 편집">
      <header>
        <div>
          <h2>{{ editing ? '남은 미션 경로 편집' : '새 미션 경로' }}</h2>
          <p v-if="editing">완료한 콘은 유지됩니다. 여기서는 아직 방문하지 않은 경로만 바꿉니다.</p>
          <p v-else>원하는 콘만 고르고, 방문 순서를 자유롭게 정하세요.</p>
        </div>
        <button class="close" aria-label="닫기" @click="emit('close')">×</button>
      </header>

      <div class="preset-row">
        <select v-model="presetId" @change="loadPreset">
          <option value="">프리셋 불러오기</option>
          <option v-for="preset in presets" :key="preset.id" :value="preset.id">
            {{ preset.name }} ({{ preset.items.length }}){{ preset.stale ? ' — 삭제된 콘 포함' : '' }}
          </option>
        </select>
        <input v-model="presetName" maxlength="100" placeholder="프리셋 이름" @keyup.enter="savePreset" />
        <button @click="savePreset" :disabled="!presetName.trim() || route.length === 0">저장</button>
        <button
          class="danger-text" :disabled="!presetId"
          @click="emit('delete-preset', Number(presetId)); presetId = ''"
        >삭제</button>
      </div>

      <div class="builder-grid">
        <section class="cone-picker">
          <div class="section-title">코스 콘 <span>{{ selectedIds.size }}/{{ cones.length }}종 선택</span></div>
          <div class="filters">
            <input v-model="query" placeholder="번호·ID·좌표 검색" />
            <select v-model="side">
              <option value="all">모든 종류</option>
              <option value="left">왼쪽</option>
              <option value="right">오른쪽</option>
              <option value="center">중앙</option>
            </select>
          </div>
          <div class="bulk-actions">
            <button @click="addFiltered">검색 결과 추가</button>
            <button @click="selectAll">전체로 교체</button>
            <button @click="route = []">전부 비우기</button>
          </div>
          <div class="cone-list">
            <label v-for="(cone, index) in filteredCones" :key="cone.id" class="cone-row">
              <input type="checkbox" :checked="selectedIds.has(cone.id)" @change="toggleCone(cone)" />
              <span class="cone-index">#{{ cones.indexOf(cone) + 1 }}</span>
              <span class="side" :class="cone.side">{{ cone.side }}</span>
              <span class="cone-id">ID {{ cone.id }}</span>
            </label>
          </div>
        </section>

        <section class="route-editor">
          <div class="section-title">주행 순서 <span>{{ route.length }}회 방문</span></div>
          <div class="bulk-actions">
            <button @click="route = optimizeConeRoute(route, currentPosition)">현재 위치부터 자동 정렬</button>
            <button @click="route = [...route].reverse()">역순</button>
          </div>
          <div v-if="duplicateIds.size" class="duplicate-warning">
            반복 방문 콘 {{ duplicateIds.size }}종 — 각 항목에서 한 번씩 분사합니다.
          </div>
          <div v-if="route.length === 0" class="empty">왼쪽 목록에서 방문할 콘을 추가하세요.</div>
          <div class="route-list">
            <div
              v-for="(item, index) in route" :key="item.client_key"
              class="route-row" draggable="true"
              @dragstart="dragStart(index)" @dragover.prevent @drop="drop(index)"
            >
              <span class="drag">⠿</span>
              <input class="position" type="number" min="1" :max="route.length" :value="index + 1" @change="moveFromInput(index, $event)" />
              <span class="side" :class="item.side">{{ item.side }}</span>
              <span class="route-name">콘 ID {{ item.cone_id }}</span>
              <span v-if="duplicateIds.has(item.cone_id)" class="repeat">반복</span>
              <button title="위로" :disabled="index === 0" @click="move(index, index - 1)">↑</button>
              <button title="아래로" :disabled="index === route.length - 1" @click="move(index, index + 1)">↓</button>
              <button title="반복 방문 추가" @click="duplicate(index)">＋</button>
              <button title="제거" @click="route.splice(index, 1)">×</button>
            </div>
          </div>
        </section>
      </div>

      <footer>
        <label>마지막 콘 이후
          <select v-model="finishBehavior">
            <option value="stop">그 자리에서 정지</option>
            <option value="return_to_start">최초 미션 시작점으로 복귀</option>
          </select>
        </label>
        <div class="footer-actions">
          <button @click="emit('close')">취소</button>
          <button :disabled="route.length === 0" @click="emit('apply', payload())">경로 적용</button>
          <button class="primary" :disabled="route.length === 0" @click="emit('run', payload())">
            {{ editing ? '적용 후 이어하기' : '점검 후 실행' }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.mission-builder-backdrop { position: fixed; inset: 0; z-index: 3000; background: rgba(5,10,20,.72); display: grid; place-items: center; padding: 1rem; }
.mission-builder { width: min(1120px, 100%); height: min(820px, calc(100vh - 2rem)); background: var(--surface, #111827); color: var(--text-primary, #f8fafc); border: 1px solid var(--border, #334155); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.5); }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.2rem; border-bottom: 1px solid var(--border, #334155); }
header h2 { margin: 0; font-size: 1.15rem; } header p { margin: .25rem 0 0; color: var(--text-secondary, #94a3b8); font-size: .82rem; }
.close { font-size: 1.6rem; background: transparent; border: 0; color: inherit; }
.preset-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(140px, 1fr) auto auto; gap: .5rem; padding: .75rem 1.2rem; border-bottom: 1px solid var(--border, #334155); }
.builder-grid { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(280px, .8fr) minmax(420px, 1.2fr); }
.cone-picker, .route-editor { min-height: 0; display: flex; flex-direction: column; padding: 1rem; }
.cone-picker { border-right: 1px solid var(--border, #334155); }
.section-title { font-weight: 700; display: flex; justify-content: space-between; margin-bottom: .6rem; }.section-title span { color: var(--text-secondary, #94a3b8); font-size: .78rem; font-weight: 500; }
.filters { display: grid; grid-template-columns: 1fr auto; gap: .5rem; }.bulk-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin: .55rem 0; }
input, select, button { min-height: 36px; border: 1px solid var(--border, #475569); border-radius: 7px; background: var(--surface-alt, #1e293b); color: inherit; padding: .35rem .55rem; }
button { cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .45; }.primary { background: #2563eb; border-color: #3b82f6; }.danger-text { color: #fca5a5; }
.cone-list, .route-list { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.cone-row, .route-row { min-height: 42px; display: flex; align-items: center; gap: .45rem; border-bottom: 1px solid rgba(148,163,184,.15); }
.cone-row { cursor: pointer; }.cone-index, .cone-id { color: var(--text-secondary, #94a3b8); font: .75rem monospace; }.cone-id { margin-left: auto; }
.side { border-radius: 999px; padding: .12rem .42rem; font-size: .7rem; text-transform: uppercase; background: #475569; }.side.left { background: #b45309; }.side.right { background: #0891b2; }.side.center { background: #64748b; }
.drag { cursor: grab; color: #94a3b8; }.position { width: 56px; }.route-name { flex: 1; font: .78rem monospace; }.repeat { color: #fbbf24; font-size: .7rem; }.route-row button { min-width: 34px; padding: .2rem; }
.duplicate-warning { color: #fbbf24; background: rgba(245,158,11,.12); padding: .5rem; border-radius: 7px; font-size: .8rem; margin-bottom: .4rem; }.empty { color: #94a3b8; padding: 2rem; text-align: center; }
footer { border-top: 1px solid var(--border, #334155); border-bottom: 0; flex-wrap: wrap; }.footer-actions { display: flex; gap: .5rem; }
@media (max-width: 760px) { .mission-builder-backdrop { padding: 0; }.mission-builder { height: 100vh; border-radius: 0; }.preset-row { grid-template-columns: 1fr 1fr; }.builder-grid { grid-template-columns: 1fr; overflow: auto; }.cone-picker { border-right: 0; border-bottom: 1px solid var(--border, #334155); min-height: 280px; }.route-editor { min-height: 380px; }.cone-list, .route-list { max-height: 330px; } footer { position: sticky; bottom: 0; background: var(--surface, #111827); }.footer-actions { width: 100%; }.footer-actions button { flex: 1; } }
</style>
