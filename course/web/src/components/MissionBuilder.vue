<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";
import { buildSideRanks } from "@lib/cone-index.mjs";
import {
  duplicateConeIds,
  filterCones,
  groupRouteMapVisits,
  missionConeDisplayName,
  missionConeShortName,
  missionRouteDirectionArrow,
  missionRouteMapSegments,
  missionPresetRouteItems,
  moveRouteItem,
  optimizeConeRoute,
  renderMissionMapBearing,
  unavailableMissionRouteItems,
} from "../lib/mission-route.mjs";
import {
  missionEmptyRouteMode,
  MISSION_MAX_OCCURRENCES,
  missionPresetReference,
  missionRouteSubmissionAllowed,
  uncertainMissionOccurrenceIds,
} from "../lib/mission-session.mjs";

const props = defineProps({
  cones: { type: Array, default: () => [] },
  initialItems: { type: Array, default: () => [] },
  presets: { type: Array, default: () => [] },
  currentPosition: { type: Object, default: null },
  initialFinishBehavior: { type: String, default: "stop" },
  missionStart: { type: Object, default: null },
  editing: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  presetBusy: { type: Boolean, default: false },
  completedCount: { type: Number, default: 0 },
  mapBearing: { type: Number, default: 0 },
});
const emit = defineEmits(["close", "apply", "run", "save-preset", "delete-preset"]);

const query = ref("");
const side = ref("all");
const route = ref([]);
const finishBehavior = ref("stop");
const presetName = ref("");
const presetId = ref("");
const mapElement = ref(null);
const routeListElement = ref(null);
const activeRouteIndex = ref(null);
let keySequence = 0;

const SIDE_COLORS = Object.freeze({ left: "#f59e0b", center: "#94a3b8", right: "#06b6d4" });

function validPosition(position) {
  return Number.isFinite(position?.lat) && Number.isFinite(position?.lng);
}

const sideRanks = computed(() => buildSideRanks(props.cones));
const visitCounts = computed(() => {
  const counts = new Map();
  for (const item of route.value) counts.set(item.cone_id, (counts.get(item.cone_id) || 0) + 1);
  return counts;
});

function coneDisplayName(cone) {
  return missionConeDisplayName(cone, sideRanks.value);
}

function coneShortName(cone) {
  return missionConeShortName(cone, sideRanks.value);
}

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
const uncertainIds = computed(() => new Set(uncertainMissionOccurrenceIds(route.value)));
const unavailableRouteItems = computed(() => unavailableMissionRouteItems(route.value, props.cones));
const unavailableRouteKeys = computed(() => new Set(
  unavailableRouteItems.value.map((item) => item.client_key),
));
const unavailablePresetItems = computed(() => unavailableMissionRouteItems(
  route.value,
  props.cones,
  { includeStableOccurrences: true },
));
const routeSubmissionOptions = computed(() => ({
  editing: props.editing,
  routeLength: route.value.length,
  finishBehavior: finishBehavior.value,
  initialItems: props.initialItems,
  missionStart: props.missionStart,
}));
const emptyRouteMode = computed(() => missionEmptyRouteMode(routeSubmissionOptions.value));
const availableOccurrences = computed(() => Math.max(0,
  MISSION_MAX_OCCURRENCES - Math.max(0, Number(props.completedCount) || 0)));
const canSubmit = computed(() => route.value.length <= availableOccurrences.value
  && unavailableRouteKeys.value.size === 0
  && missionRouteSubmissionAllowed(routeSubmissionOptions.value));
const routeAtLimit = computed(() => route.value.length >= availableOccurrences.value);

function fromCone(cone) {
  return routeItem({
    cone_id: cone.id, lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side,
    waypoint_id: null,
  });
}

function toggleCone(cone) {
  if (selectedIds.value.has(cone.id)) {
    route.value = route.value.filter((item) => item.cone_id !== cone.id);
    activeRouteIndex.value = null;
  } else {
    if (routeAtLimit.value) return;
    route.value = [...route.value, fromCone(cone)];
    activeRouteIndex.value = route.value.length - 1;
  }
}

function selectAll() {
  route.value = props.cones.slice(0, availableOccurrences.value).map(fromCone);
  activeRouteIndex.value = null;
}

function clearRoute() {
  route.value = [];
  activeRouteIndex.value = null;
}

function optimizeFromCurrent() {
  if (route.value.length < 2 || !validPosition(props.currentPosition)) return;
  route.value = optimizeConeRoute(route.value, props.currentPosition);
  activeRouteIndex.value = null;
  nextTick(fitMapToRoute);
}

function reverseRoute() {
  route.value = [...route.value].reverse();
  activeRouteIndex.value = null;
}

function move(from, to) {
  route.value = moveRouteItem(route.value, from, to);
  const active = activeRouteIndex.value;
  if (active === from) activeRouteIndex.value = to;
  else if (from < to && active > from && active <= to) activeRouteIndex.value -= 1;
  else if (to < from && active >= to && active < from) activeRouteIndex.value += 1;
}

function moveFromInput(index, event) {
  const target = Math.max(1, Math.min(route.value.length, Number(event.target.value) || index + 1)) - 1;
  move(index, target);
  event.target.value = target + 1;
}

function duplicate(index) {
  if (routeAtLimit.value) return;
  if (!window.confirm("같은 콘을 한 번 더 방문하고 분사합니다. 반복 방문을 추가할까요?")) return;
  const copy = routeItem({
    ...route.value[index], id: undefined, waypoint_id: null,
    client_key: undefined, outcome: undefined,
  });
  const next = [...route.value];
  next.splice(index + 1, 0, copy);
  route.value = next;
  activeRouteIndex.value = index + 1;
}

function removeRouteItem(index) {
  route.value = route.value.filter((_, itemIndex) => itemIndex !== index);
  if (activeRouteIndex.value === index) activeRouteIndex.value = null;
  else if (activeRouteIndex.value > index) activeRouteIndex.value -= 1;
}

function focusRouteItem(index, { pan = true, scroll = false } = {}) {
  const item = route.value[index];
  if (!item) return;
  activeRouteIndex.value = index;
  if (pan && builderMap && validPosition(item)) builderMap.panTo([item.lat, item.lng]);
  if (scroll) {
    nextTick(() => routeListElement.value
      ?.querySelector(`[data-route-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }
}

function loadPreset() {
  const preset = props.presets.find((item) => item.id === Number(presetId.value));
  if (!preset) return;
  route.value = missionPresetRouteItems(preset)
    .map((item) => routeItem({ ...item, id: undefined, waypoint_id: null }));
  finishBehavior.value = preset.finish_behavior;
  presetName.value = preset.name;
  activeRouteIndex.value = null;
  nextTick(fitMapToRoute);
}

function payload() {
  const preset = props.presets.find((item) => item.id === Number(presetId.value));
  return {
    items: route.value.map((item) => ({ ...item })),
    finishBehavior: finishBehavior.value,
    emptyRouteMode: emptyRouteMode.value,
    presetReference: missionPresetReference({
      preset,
      items: route.value,
      finishBehavior: finishBehavior.value,
    }),
  };
}

function savePreset() {
  const name = presetName.value.trim();
  if (props.presetBusy || !name || route.value.length === 0
      || unavailablePresetItems.value.length > 0 || !canSubmit.value) return;
  emit("save-preset", { ...payload(), name });
}

function close() {
  if (!props.busy) emit("close");
}

let builderMap = null;
let coneMapLayer = null;
let routeMapLayer = null;
let positionMapLayer = null;
let mapInitCancelled = false;

function addBaseMapLayer() {
  const vworldKey = window.__VWORLD_KEY__;
  // The popup map is short-lived. Keep no off-screen tile ring and fetch after
  // movement settles so opening it does not leave a large decoded-image set in
  // the browser after teardown.
  const tileOptions = { keepBuffer: 0, updateWhenIdle: true };
  if (vworldKey) {
    L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/Satellite/{z}/{y}/{x}.jpeg`, {
      ...tileOptions, attribution: "&copy; VWorld", maxNativeZoom: 19, maxZoom: 21,
    }).addTo(builderMap);
    L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/Hybrid/{z}/{y}/{x}.png`, {
      ...tileOptions, attribution: "&copy; VWorld", maxNativeZoom: 19, maxZoom: 21,
    }).addTo(builderMap);
  } else {
    L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2", {
      ...tileOptions, subdomains: "0123", attribution: "&copy; Google", maxZoom: 21,
    }).addTo(builderMap);
  }
}

function renderConeMapLayer() {
  if (!builderMap || !coneMapLayer) return;
  coneMapLayer.clearLayers();
  for (const cone of props.cones) {
    if (!validPosition(cone)) continue;
    const selected = selectedIds.value.has(cone.id);
    const visits = visitCounts.value.get(cone.id) || 0;
    const marker = L.circleMarker([cone.lat, cone.lng], {
      radius: selected ? 9 : 7,
      color: selected ? "#ffffff" : "#0f172a",
      weight: selected ? 3 : 1.5,
      fillColor: SIDE_COLORS[cone.side] || "#64748b",
      fillOpacity: selected ? 1 : 0.82,
    });
    marker.bindTooltip(
      `<strong>${coneDisplayName(cone)}</strong><br>ID ${cone.id}${visits ? `<br>${visits}회 방문` : ""}`,
      { direction: "top", offset: [0, -8] },
    );
    marker.on("click", () => toggleCone(cone));
    marker.addTo(coneMapLayer);
  }
}

function renderRouteMapLayer() {
  if (!builderMap || !routeMapLayer) return;
  routeMapLayer.clearLayers();
  const visitsByLocation = groupRouteMapVisits(route.value);
  const segments = missionRouteMapSegments(route.value);
  if (segments.length > 0) {
    const path = [segments[0].from, ...segments.map(({ to }) => to)];
    L.polyline(path.map(({ lat, lng }) => [lat, lng]), {
      color: "#0b1021", weight: 7, opacity: 0.72, interactive: false,
      lineCap: "round", lineJoin: "round",
    }).addTo(routeMapLayer);
  }
  for (const { from, to, color } of segments) {
    L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
      color, weight: 4, opacity: 1, interactive: false,
      lineCap: "round", lineJoin: "round",
    }).addTo(routeMapLayer);
    const arrow = missionRouteDirectionArrow(from, to);
    if (arrow.length > 0) {
      const latlngs = arrow.map((point) => [point.lat, point.lng]);
      L.polygon(latlngs, {
        color: "#0b1021", weight: 1.5, opacity: 1, interactive: false,
        fillColor: color, fillOpacity: 1, lineJoin: "round",
      }).addTo(routeMapLayer);
    }
  }

  for (const visits of visitsByLocation) {
    const [{ item }] = visits;
    const indices = visits.map(({ index }) => index + 1);
    const compactIndices = indices.length > 4
      ? `${indices.slice(0, 3).join(" · ")} +${indices.length - 3}`
      : indices.join(" · ");
    const active = visits.some(({ index }) => index === activeRouteIndex.value);
    const iconWidth = Math.max(30, Math.min(112, 18 + compactIndices.length * 8));
    const marker = L.marker([item.lat, item.lng], {
      icon: L.divIcon({
        className: "mission-builder-route-icon-wrap",
        html: `<span class="mission-builder-route-icon${active ? " active" : ""}">${compactIndices}</span>`,
        iconSize: [iconWidth, 28],
        iconAnchor: [iconWidth / 2, 32],
      }),
      zIndexOffset: active ? 1200 : 1000,
    });
    marker.bindTooltip(
      `${coneDisplayName(item)} · 방문 ${indices.join(", ")}번째`,
      { direction: "top", offset: [0, -24] },
    );
    marker.on("click", () => {
      const current = visits.findIndex(({ index }) => index === activeRouteIndex.value);
      const next = visits[(current + 1) % visits.length];
      focusRouteItem(next.index, { pan: false, scroll: true });
    });
    marker.addTo(routeMapLayer);
  }
}

function renderPositionMapLayer() {
  if (!builderMap || !positionMapLayer) return;
  positionMapLayer.clearLayers();
  if (validPosition(props.currentPosition)) {
    L.marker([props.currentPosition.lat, props.currentPosition.lng], {
      icon: L.divIcon({
        className: "mission-builder-position-icon-wrap",
        html: '<span class="mission-builder-position-icon current">⌖</span>',
        iconSize: [34, 34], iconAnchor: [17, 17],
      }),
      zIndexOffset: 1500,
    }).bindTooltip("현재 로버 위치", { direction: "top" }).addTo(positionMapLayer);
  }
  if (validPosition(props.missionStart)) {
    L.marker([props.missionStart.lat, props.missionStart.lng], {
      icon: L.divIcon({
        className: "mission-builder-position-icon-wrap",
        html: '<span class="mission-builder-position-icon start">★</span>',
        iconSize: [30, 30], iconAnchor: [15, 15],
      }),
      zIndexOffset: 1400,
    }).bindTooltip("미션 시작 위치", { direction: "top" }).addTo(positionMapLayer);
  }
}

function fitPositions(positions) {
  if (!builderMap) return;
  const valid = positions.filter(validPosition);
  if (valid.length === 0) return;
  if (valid.length === 1) {
    builderMap.setView([valid[0].lat, valid[0].lng], 19);
    return;
  }
  builderMap.fitBounds(L.latLngBounds(valid.map((item) => [item.lat, item.lng])), {
    padding: [40, 40], maxZoom: 20,
  });
}

function fitMapToAll() {
  fitPositions([...props.cones, props.currentPosition, props.missionStart]);
}

function fitMapToRoute() {
  fitPositions([...route.value, props.currentPosition]);
}

function centerMapOnCurrent() {
  if (builderMap && validPosition(props.currentPosition)) {
    builderMap.setView([props.currentPosition.lat, props.currentPosition.lng], Math.max(19, builderMap.getZoom()));
  }
}

async function initBuilderMap() {
  if (!mapElement.value || builderMap) return;
  const expectedElement = mapElement.value;
  // MapView normally loaded the plugin already. Keep the conditional fallback
  // for isolated component mounts without re-running plugin initialization on
  // every popup open.
  if (typeof L.Map.prototype.setBearing !== "function") {
    globalThis.L = L;
    await import("leaflet-rotate");
  }
  if (mapInitCancelled || !mapElement.value || mapElement.value !== expectedElement || builderMap) return;
  builderMap = L.map(mapElement.value, {
    preferCanvas: true, zoomControl: true, maxZoom: 21, boxZoom: false,
    rotate: true, rotateControl: false, touchRotate: false, shiftKeyRotate: false,
    bearing: renderMissionMapBearing(props.mapBearing),
  }).setView([35.292012, 126.574415], 19);
  addBaseMapLayer();
  coneMapLayer = L.layerGroup().addTo(builderMap);
  routeMapLayer = L.layerGroup().addTo(builderMap);
  positionMapLayer = L.layerGroup().addTo(builderMap);
  renderConeMapLayer();
  renderRouteMapLayer();
  renderPositionMapLayer();
  builderMap.invalidateSize();
  fitMapToAll();
}

watch(route, () => {
  renderConeMapLayer();
  renderRouteMapLayer();
}, { deep: true });
watch(() => props.cones, () => {
  renderConeMapLayer();
  renderRouteMapLayer();
}, { deep: true });
watch(() => props.currentPosition, renderPositionMapLayer, { deep: true });
watch(() => props.missionStart, renderPositionMapLayer, { deep: true });
watch(() => props.mapBearing, (bearing) => {
  if (builderMap) builderMap.setBearing(renderMissionMapBearing(bearing));
});
watch(activeRouteIndex, renderRouteMapLayer);

onMounted(() => nextTick(() => { void initBuilderMap(); }));
onBeforeUnmount(() => {
  mapInitCancelled = true;
  coneMapLayer?.clearLayers();
  routeMapLayer?.clearLayers();
  positionMapLayer?.clearLayers();
  if (builderMap) {
    builderMap.off();
    builderMap.remove();
  }
  builderMap = null;
  coneMapLayer = null;
  routeMapLayer = null;
  positionMapLayer = null;
});

let draggedIndex = null;
function dragStart(index) { draggedIndex = index; }
function drop(index) {
  if (draggedIndex != null) move(draggedIndex, index);
  draggedIndex = null;
}
</script>

<template>
  <div class="mission-builder-backdrop" @click.self="close">
    <section class="mission-builder" role="dialog" aria-modal="true" aria-label="미션 경로 편집" :aria-busy="busy">
      <header>
        <div>
          <h2>{{ editing ? '남은 미션 경로 편집' : '새 미션 경로' }}</h2>
          <p v-if="editing">완료한 콘은 유지됩니다. 여기서는 아직 방문하지 않은 경로만 바꿉니다.</p>
          <p v-else>원하는 콘만 고르고, 방문 순서를 자유롭게 정하세요.</p>
        </div>
        <button class="close" aria-label="닫기" :disabled="busy" @click="close">×</button>
      </header>

      <div class="preset-row">
        <select v-model="presetId" :disabled="presetBusy" @change="loadPreset">
          <option value="">프리셋 불러오기</option>
          <option v-for="preset in presets" :key="preset.id" :value="preset.id">
            {{ preset.name }} ({{ preset.items.length }}){{ preset.stale ? ' — 삭제된 콘 포함' : '' }}
          </option>
        </select>
        <input v-model="presetName" :disabled="presetBusy" maxlength="100" placeholder="프리셋 이름" @keyup.enter="savePreset" />
        <button
          @click="savePreset"
          :disabled="presetBusy || !presetName.trim() || route.length === 0 || unavailablePresetItems.length > 0 || !canSubmit"
        >
          {{ presetBusy ? '저장 중…' : '저장' }}
        </button>
        <button
          class="danger-text" :disabled="presetBusy || !presetId"
          @click="emit('delete-preset', Number(presetId)); presetId = ''"
        >삭제</button>
      </div>

      <div class="builder-workspace">
        <section class="cone-picker">
          <div class="section-title">
            <div>
              <strong>코스 콘</strong>
              <small>지도나 목록을 눌러 추가·제거</small>
            </div>
            <span>{{ selectedIds.size }}/{{ cones.length }}종</span>
          </div>
          <div class="filters">
            <input v-model="query" aria-label="콘 검색" placeholder="번호·ID·좌표 검색" />
            <select v-model="side" aria-label="콘 종류 필터">
              <option value="all">모든 종류</option>
              <option value="left">왼쪽</option>
              <option value="right">오른쪽</option>
              <option value="center">중앙</option>
            </select>
          </div>
          <div class="bulk-action-grid">
            <button @click="selectAll">모든 콘 선택</button>
            <button class="danger-text" @click="clearRoute">선택 비우기</button>
          </div>
          <div class="cone-list">
            <label v-for="cone in filteredCones" :key="cone.id" class="cone-row" :class="{ selected: selectedIds.has(cone.id) }">
              <input type="checkbox" :checked="selectedIds.has(cone.id)" :disabled="!selectedIds.has(cone.id) && routeAtLimit" @change="toggleCone(cone)" />
              <span class="side-dot" :class="cone.side"></span>
              <span class="cone-description">
                <strong>{{ coneDisplayName(cone) }}</strong>
                <small>ID {{ cone.id }} · {{ Number(cone.lat).toFixed(6) }}, {{ Number(cone.lng).toFixed(6) }}</small>
              </span>
              <span v-if="visitCounts.get(cone.id)" class="visit-count">{{ visitCounts.get(cone.id) }}회</span>
            </label>
          </div>
        </section>

        <section class="builder-map-panel">
          <div class="section-title map-title">
            <div>
              <strong>경로 지도</strong>
              <small>색 점은 콘 종류, 보라색 숫자는 방문 순서</small>
            </div>
          </div>
          <div class="map-action-grid">
            <button @click="fitMapToAll">전체 콘 보기</button>
            <button @click="fitMapToRoute" :disabled="route.length === 0">선택 경로 보기</button>
            <button @click="centerMapOnCurrent" :disabled="!validPosition(currentPosition)">현재 위치</button>
          </div>
          <div class="builder-map-shell">
            <div ref="mapElement" class="builder-map" aria-label="미션 경로 지도"></div>
            <div class="map-legend" aria-hidden="true">
              <span><i class="legend-dot left"></i>왼쪽</span>
              <span><i class="legend-dot center"></i>중앙</span>
              <span><i class="legend-dot right"></i>오른쪽</span>
              <span><i class="legend-route">1</i>방문 순서</span>
              <span><i class="legend-progress"></i>초기→후반</span>
              <span><i class="legend-direction">›</i>진행 방향</span>
            </div>
          </div>
          <p class="map-help">콘을 누르면 경로에 추가·제거됩니다. 경로색은 초록에서 빨강 순서로, 화살표는 진행 방향을 나타냅니다.</p>
        </section>

        <section class="route-editor">
          <div class="section-title">
            <div>
              <strong>주행 순서</strong>
              <small>드래그하거나 순서 번호를 입력</small>
            </div>
            <span>{{ route.length }}회</span>
          </div>
          <div v-if="routeAtLimit" class="duplicate-warning">
            완료 항목을 포함해 미션당 최대 {{ MISSION_MAX_OCCURRENCES.toLocaleString() }}회 방문할 수 있습니다.
          </div>
          <div class="route-action-grid">
            <button
              class="auto-sort" :disabled="route.length < 2 || !validPosition(currentPosition)"
              :title="validPosition(currentPosition) ? '현재 로버 위치에서 가까운 순서로 정렬' : '현재 로버 위치가 필요합니다'"
              @click="optimizeFromCurrent"
            >⌖ 현재 위치부터 자동 정렬</button>
            <button :disabled="route.length < 2" @click="reverseRoute">⇅ 경로 역순</button>
            <button class="danger-text" :disabled="route.length === 0" @click="clearRoute">경로 비우기</button>
          </div>
          <div v-if="duplicateIds.size" class="duplicate-warning">
            반복 방문 콘 {{ duplicateIds.size }}종 — 각 항목에서 한 번씩 분사합니다.
          </div>
          <div v-if="uncertainIds.size" class="uncertain-warning">
            분사 결과를 확인할 수 없는 방문이 {{ uncertainIds.size }}개 있습니다.
            재분사하지 않으려면 해당 항목을 제거하고, 명시적으로 다시 분사하려면 제거 후 같은 콘을 새 방문으로 추가하세요.
          </div>
          <div v-if="unavailableRouteItems.length" class="unavailable-warning">
            현재 코스에서 삭제된 콘이 {{ unavailableRouteItems.length }}개 있습니다.
            해당 항목을 제거하거나 현재 코스 콘으로 교체해야 적용·실행·저장할 수 있습니다.
          </div>
          <div v-if="route.length === 0 && emptyRouteMode === 'return_only'" class="empty-route-notice">
            콘을 방문하지 않고 현재 위치에서 최초 미션 시작점으로 복귀합니다.
          </div>
          <div v-else-if="route.length === 0 && emptyRouteMode === 'resolve_uncertain'" class="empty-route-notice uncertain-warning">
            분사 결과가 불확실한 마지막 방문을 다시 분사하지 않고 명시적으로 완료 처리합니다.
          </div>
          <div v-else-if="route.length === 0" class="empty">
            일반 미션은 남은 콘이 하나 이상 필요합니다. 콘을 추가하거나 시작점 복귀를 명시적으로 선택하세요.
          </div>
          <div ref="routeListElement" class="route-list">
            <div
              v-for="(item, index) in route" :key="item.client_key"
              class="route-row" :class="{ active: activeRouteIndex === index, unavailable: unavailableRouteKeys.has(item.client_key) }"
              :data-route-index="index" draggable="true"
              @click="focusRouteItem(index)"
              @dragstart="dragStart(index)" @dragover.prevent @drop="drop(index)"
            >
              <span class="drag">⠿</span>
              <label class="route-position" @click.stop>
                <input
                  class="position" type="number" min="1" :max="route.length" :value="index + 1"
                  :aria-label="`${index + 1}번째 방문 순서`" title="방문 순서"
                  @change="moveFromInput(index, $event)"
                />
              </label>
              <span class="side-dot" :class="item.side"></span>
              <span class="route-description">
                <strong>{{ coneDisplayName(item) }}</strong>
                <small>ID {{ item.cone_id }} · {{ coneShortName(item) }}</small>
                <span class="route-badges">
                  <em v-if="duplicateIds.has(item.cone_id)" class="repeat">반복</em>
                  <em v-if="uncertainIds.has(item.waypoint_id || item.id)" class="uncertain">결과 확인</em>
                  <em v-if="unavailableRouteKeys.has(item.client_key)" class="unavailable">삭제된 콘</em>
                </span>
              </span>
              <span class="route-row-actions" @click.stop>
                <button title="한 칸 위로" aria-label="한 칸 위로" :disabled="index === 0" @click="move(index, index - 1)">↑</button>
                <button title="한 칸 아래로" aria-label="한 칸 아래로" :disabled="index === route.length - 1" @click="move(index, index + 1)">↓</button>
                <button title="반복 방문 추가" aria-label="반복 방문 추가" :disabled="routeAtLimit" @click="duplicate(index)">＋</button>
                <button class="remove" title="경로에서 제거" aria-label="경로에서 제거" @click="removeRouteItem(index)">×</button>
              </span>
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
          <button :disabled="busy" @click="close">취소</button>
          <button :disabled="busy || !canSubmit" @click="emit('apply', payload())">경로 적용</button>
          <button class="primary" :disabled="busy || !canSubmit" @click="emit('run', payload())">
            {{ editing ? '적용 후 이어하기' : '점검 후 실행' }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.mission-builder-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: grid;
  place-items: center;
  padding: .5rem;
  background: rgba(2, 6, 23, .78);
}

.mission-builder {
  width: min(2200px, calc(100vw - 1rem));
  height: min(1200px, calc(100dvh - 1rem));
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text-primary, #f8fafc);
  background: var(--surface, #0f172a);
  border: 1px solid var(--border, #334155);
  border-radius: 16px;
  box-shadow: 0 28px 90px rgba(0, 0, 0, .58);
}

.mission-builder > header,
.mission-builder > footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: .7rem 1rem;
  background: rgba(15, 23, 42, .98);
}

.mission-builder > header { border-bottom: 1px solid var(--border, #334155); }
.mission-builder > footer { border-top: 1px solid var(--border, #334155); }
.mission-builder > header > div { min-width: 0; }
.mission-builder h2 { margin: 0; font-size: 1.18rem; line-height: 1.3; }
.mission-builder header p {
  margin: .25rem 0 0;
  color: var(--text-secondary, #94a3b8);
  font-size: .82rem;
  line-height: 1.4;
}

.mission-builder input,
.mission-builder select,
.mission-builder button {
  min-width: 0;
  min-height: 34px;
  box-sizing: border-box;
  border: 1px solid var(--border, #475569);
  border-radius: 8px;
  color: inherit;
  background: var(--surface-alt, #1e293b);
  font: inherit;
}

.mission-builder input,
.mission-builder select { width: 100%; min-height: 36px; padding: .35rem .6rem; }
.mission-builder input:focus,
.mission-builder select:focus,
.mission-builder button:focus-visible {
  outline: 2px solid #38bdf8;
  outline-offset: 1px;
  border-color: #38bdf8;
}

.mission-builder button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .3rem;
  padding: .3rem .55rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  line-height: 1.15;
  font-size: .78rem;
  font-weight: 650;
  cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease, transform .15s ease;
}

.mission-builder button:hover:not(:disabled) {
  border-color: #64748b;
  background: #29384d;
}

.mission-builder button:active:not(:disabled) { transform: translateY(1px); }
.mission-builder button:disabled { cursor: not-allowed; opacity: .42; }
.mission-builder .primary { border-color: #3b82f6; background: #2563eb; }
.mission-builder .primary:hover:not(:disabled) { border-color: #60a5fa; background: #1d4ed8; }
.mission-builder .danger-text { color: #fecaca; }

.close {
  flex: 0 0 38px;
  width: 38px;
  padding: 0 !important;
  border-color: transparent !important;
  background: transparent !important;
  font-size: 1.7rem !important;
  font-weight: 400 !important;
}

.preset-row {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(170px, 1fr) 68px 68px;
  gap: .42rem;
  padding: .55rem 1rem;
  border-bottom: 1px solid var(--border, #334155);
  background: rgba(15, 23, 42, .9);
}

.builder-workspace {
  min-height: 0;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(280px, .78fr) minmax(430px, 1.35fr) minmax(390px, 1fr);
  overflow: hidden;
}

.cone-picker,
.builder-map-panel,
.route-editor {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: .75rem;
}

.cone-picker,
.builder-map-panel { border-right: 1px solid var(--border, #334155); }
.builder-map-panel { background: rgba(2, 6, 23, .28); }

.section-title {
  min-height: 34px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: .75rem;
  margin-bottom: .55rem;
}

.section-title > div { min-width: 0; }
.section-title strong { display: block; font-size: .98rem; line-height: 1.3; }
.section-title small {
  display: block;
  margin-top: .12rem;
  color: var(--text-secondary, #94a3b8);
  font-size: .72rem;
  line-height: 1.3;
}
.section-title > span {
  flex: 0 0 auto;
  color: #cbd5e1;
  font-size: .76rem;
  font-weight: 650;
}

.filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 112px;
  gap: .45rem;
}

.bulk-action-grid,
.route-action-grid,
.map-action-grid {
  display: grid;
  gap: .36rem;
  margin: .4rem 0;
}

.bulk-action-grid,
.route-action-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.route-action-grid .auto-sort { grid-column: 1 / -1; }
.route-action-grid .auto-sort { border-color: #475569; background: #202d42; }
.map-action-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 0; }
.map-action-grid button { padding-inline: .3rem; font-size: .74rem; }

.cone-list,
.route-list {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border: 1px solid rgba(71, 85, 105, .6);
  border-radius: 9px;
  background: rgba(2, 6, 23, .3);
}

.cone-row {
  min-width: 0;
  min-height: 58px;
  display: grid;
  grid-template-columns: 20px 12px minmax(0, 1fr) auto;
  align-items: center;
  gap: .55rem;
  padding: .5rem .6rem;
  border-bottom: 1px solid rgba(148, 163, 184, .13);
  cursor: pointer;
  transition: background-color .14s ease, box-shadow .14s ease;
}

.cone-row:last-child,
.route-row:last-child { border-bottom: 0; }
.cone-row:hover { background: rgba(51, 65, 85, .55); }
.cone-row.selected {
  background: rgba(37, 99, 235, .15);
  box-shadow: inset 3px 0 #3b82f6;
}
.cone-row input { width: 17px; min-height: 17px; margin: 0; accent-color: #3b82f6; }

.side-dot,
.legend-dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border: 2px solid rgba(255, 255, 255, .78);
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .55);
}
.side-dot.left,
.legend-dot.left { background: #f59e0b; }
.side-dot.center,
.legend-dot.center { background: #94a3b8; }
.side-dot.right,
.legend-dot.right { background: #06b6d4; }

.cone-description,
.route-description { min-width: 0; }
.cone-description strong,
.route-description strong {
  display: block;
  overflow: hidden;
  color: #f8fafc;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: .83rem;
}
.cone-description small,
.route-description > small {
  display: block;
  margin-top: .12rem;
  overflow: hidden;
  color: var(--text-secondary, #94a3b8);
  text-overflow: ellipsis;
  white-space: nowrap;
  font: .68rem/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.visit-count {
  flex: 0 0 auto;
  padding: .14rem .38rem;
  color: #ddd6fe;
  background: rgba(124, 58, 237, .3);
  border: 1px solid rgba(167, 139, 250, .4);
  border-radius: 999px;
  font-size: .67rem;
  font-weight: 700;
  white-space: nowrap;
}

.builder-map-shell {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  border: 1px solid #475569;
  border-radius: 11px;
  background: #0b1120;
}
.builder-map { width: 100%; height: 100%; min-height: 420px; background: #0b1120; }
.builder-map :deep(.leaflet-control-zoom a) { color: #0f172a; }
.builder-map :deep(.leaflet-control-attribution) { font-size: 9px; }
.builder-map :deep(.mission-builder-route-icon-wrap),
.builder-map :deep(.mission-builder-position-icon-wrap) { border: 0; background: transparent; }
.builder-map :deep(.mission-builder-route-icon) {
  width: 100%;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  box-sizing: border-box;
  color: #fff;
  background: #7c3aed;
  border: 2px solid #fff;
  border-radius: 999px;
  box-shadow: 0 3px 10px rgba(15, 23, 42, .75);
  font-size: 11px;
  font-weight: 800;
  white-space: nowrap;
}
.builder-map :deep(.mission-builder-route-icon.active) {
  color: #111827;
  background: #fbbf24;
  box-shadow: 0 0 0 3px rgba(251, 191, 36, .38), 0 3px 10px rgba(15, 23, 42, .75);
}
.builder-map :deep(.mission-builder-position-icon) {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  color: #0f172a;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 3px 10px rgba(15, 23, 42, .8);
  font-size: 18px;
  font-weight: 900;
}
.builder-map :deep(.mission-builder-position-icon.current) { background: #22d3ee; }
.builder-map :deep(.mission-builder-position-icon.start) { background: #fbbf24; font-size: 14px; }
.map-legend {
  position: absolute;
  z-index: 500;
  left: .55rem;
  bottom: .55rem;
  display: flex;
  flex-wrap: wrap;
  gap: .35rem .55rem;
  max-width: calc(100% - 1.1rem);
  padding: .4rem .5rem;
  color: #f8fafc;
  background: rgba(15, 23, 42, .88);
  border: 1px solid rgba(148, 163, 184, .45);
  border-radius: 8px;
  box-shadow: 0 3px 12px rgba(0, 0, 0, .35);
  pointer-events: none;
  font-size: .68rem;
}
.map-legend span { display: inline-flex; align-items: center; gap: .25rem; white-space: nowrap; }
.legend-route {
  min-width: 21px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  padding: 0 4px;
  color: #fff;
  background: #7c3aed;
  border: 1px solid #fff;
  border-radius: 999px;
  font-size: .62rem;
  font-style: normal;
  font-weight: 800;
}
.legend-progress {
  width: 38px;
  height: 6px;
  border: 1px solid rgba(255, 255, 255, .8);
  border-radius: 999px;
  background: linear-gradient(90deg, #22c55e, #eab308, #f97316, #ef4444);
}
.legend-direction {
  width: 18px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  color: #f8fafc;
  font-size: 20px;
  font-style: normal;
  font-weight: 900;
  line-height: 1;
}
.map-help {
  margin: .45rem 0 0;
  color: var(--text-secondary, #94a3b8);
  font-size: .7rem;
  line-height: 1.35;
}

.route-list { margin-top: .05rem; }
.route-row {
  min-width: 0;
  min-height: 50px;
  display: grid;
  grid-template-columns: 16px 44px 10px minmax(0, 1fr) 125px;
  align-items: center;
  gap: .35rem;
  padding: .25rem .4rem;
  border-bottom: 1px solid rgba(148, 163, 184, .13);
  cursor: pointer;
  transition: background-color .14s ease, box-shadow .14s ease;
}
.route-row:hover { background: rgba(51, 65, 85, .45); }
.route-row.active {
  background: rgba(124, 58, 237, .18);
  box-shadow: inset 3px 0 #a78bfa;
}
.route-row.unavailable { background: rgba(185, 28, 28, .13); }
.drag { color: #94a3b8; font-size: .9rem; cursor: grab; user-select: none; }
.route-position { display: block; }
.mission-builder .route-position .position {
  width: 44px;
  min-height: 30px;
  padding: .15rem .25rem;
  text-align: center;
  font-weight: 700;
}
.route-description {
  display: flex;
  align-items: center;
  gap: .35rem;
  overflow: hidden;
}
.route-description strong { flex: 0 1 auto; }
.route-description > small { flex: 1 1 auto; margin-top: 0; }
.route-badges { flex: 0 0 auto; display: flex; flex-wrap: nowrap; gap: .15rem; margin-top: 0; }
.route-badges em {
  padding: .06rem .24rem;
  border-radius: 999px;
  font-size: .62rem;
  font-style: normal;
  font-weight: 700;
  white-space: nowrap;
}
.route-badges .repeat { color: #fde68a; background: rgba(180, 83, 9, .42); }
.route-badges .uncertain { color: #fecaca; background: rgba(185, 28, 28, .38); }
.route-badges .unavailable { color: #fecaca; background: rgba(153, 27, 27, .48); }
.route-row-actions {
  display: grid;
  grid-template-columns: repeat(4, 29px);
  gap: 3px;
}
.mission-builder .route-row-actions button {
  width: 29px;
  min-height: 29px;
  padding: 0;
  font-size: .92rem;
}
.route-row-actions .remove { color: #fecaca; }

.duplicate-warning,
.uncertain-warning,
.unavailable-warning,
.empty-route-notice {
  flex: 0 0 auto;
  margin-bottom: .4rem;
  padding: .5rem .6rem;
  border: 1px solid rgba(245, 158, 11, .24);
  border-radius: 8px;
  color: #fde68a;
  background: rgba(180, 83, 9, .16);
  font-size: .75rem;
  line-height: 1.4;
}
.uncertain-warning,
.unavailable-warning,
.empty-route-notice.uncertain-warning {
  color: #fecaca;
  background: rgba(185, 28, 28, .18);
  border-color: rgba(248, 113, 113, .24);
}
.empty-route-notice { color: #bfdbfe; background: rgba(37, 99, 235, .16); border-color: rgba(96, 165, 250, .24); }
.empty {
  padding: 1.2rem .8rem;
  color: #94a3b8;
  text-align: center;
  font-size: .78rem;
  line-height: 1.5;
}

.mission-builder > footer > label {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: .55rem;
  color: #cbd5e1;
  font-size: .8rem;
  white-space: nowrap;
}
.mission-builder > footer select { width: auto; min-width: 210px; }
.footer-actions { display: flex; gap: .5rem; }
.footer-actions button { min-width: 82px; }
.footer-actions .primary { min-width: 124px; }

@media (max-width: 1320px) {
  .builder-workspace {
    grid-template-columns: minmax(280px, .75fr) minmax(430px, 1.25fr);
    overflow: auto;
  }
  .cone-picker,
  .builder-map-panel { min-height: 470px; }
  .builder-map-panel { border-right: 0; }
  .route-editor {
    grid-column: 1 / -1;
    min-height: 390px;
    border-top: 1px solid var(--border, #334155);
  }
  .route-list { max-height: 320px; }
  .route-row { grid-template-columns: 16px 44px 10px minmax(0, 1fr) 125px; }
}

@media (max-width: 760px) {
  .mission-builder-backdrop { padding: 0; }
  .mission-builder {
    width: 100vw;
    height: 100dvh;
    border: 0;
    border-radius: 0;
  }
  .mission-builder > header,
  .mission-builder > footer { padding: .75rem; }
  .mission-builder header p { font-size: .74rem; }
  .preset-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    padding: .6rem .75rem;
  }
  .builder-workspace { grid-template-columns: minmax(0, 1fr); }
  .cone-picker,
  .builder-map-panel,
  .route-editor {
    grid-column: auto;
    min-height: 420px;
    padding: .75rem;
    border-right: 0;
    border-bottom: 1px solid var(--border, #334155);
  }
  .builder-map-panel { min-height: 450px; }
  .route-editor { min-height: 480px; border-top: 0; }
  .builder-map { min-height: 360px; }
  .cone-list { max-height: 310px; }
  .route-list { max-height: 360px; }
  .route-row { grid-template-columns: 16px 44px 10px minmax(0, 1fr) 125px; }
  .mission-builder > footer { align-items: stretch; flex-direction: column; }
  .mission-builder > footer > label { justify-content: space-between; }
  .mission-builder > footer select { min-width: 0; flex: 1 1 auto; }
  .footer-actions { width: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .footer-actions button,
  .footer-actions .primary { min-width: 0; flex: 1 1 0; padding-inline: .35rem; }
  .footer-actions .primary { grid-column: 1 / -1; }
}

@media (max-width: 420px) {
  .filters { grid-template-columns: minmax(0, 1fr) 104px; }
  .map-action-grid button,
  .route-action-grid button,
  .bulk-action-grid button { font-size: .72rem; padding-inline: .28rem; }
  .route-row { grid-template-columns: 14px 40px 9px minmax(0, 1fr) 121px; gap: .28rem; padding-inline: .32rem; }
  .mission-builder .route-position .position { width: 40px; }
  .route-row-actions { grid-template-columns: repeat(4, 28px); }
  .mission-builder .route-row-actions button { width: 28px; min-height: 28px; }
  .map-legend { font-size: .62rem; }
}

@media (max-height: 700px) and (min-width: 1321px) {
  .builder-map { min-height: 250px; }
}
</style>
