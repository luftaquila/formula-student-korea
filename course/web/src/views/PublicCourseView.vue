<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import L from "leaflet";
import CourseMapIcon from "../components/CourseMapIcon.vue";
import { readPublicCoursePreferences, savePublicCoursePreference, normalizeMapBearing, renderMapBearing } from "../lib/course-view-preferences.mjs";
import { useNotification } from "@shared/useNotification.js";
import { buildSideRanks } from "@lib/cone-index.mjs";
import { resolveCourseRoute } from "@lib/route-mode.mjs";
import { createCourseBaseMap, courseCenterlineLayer } from "../lib/course-map.mjs";
import { courseDirectionOptions, courseDisplayState } from "../lib/course-display.mjs";
import { LabeledConeCanvas, SIDE_COLORS } from "../lib/cone-render.mjs";
import { createPublicCourseData } from "../lib/public-course-data.mjs";
import { createPublicCourseViewport } from "../lib/public-course-viewport.mjs";
import { requestPublicCourse } from "../public-api.js";
import { useMeasureTools } from "../composables/useMeasureTools.js";

const { error: notifyError } = useNotification();
const mapElement = ref(null);
const exportingId = ref(null);
let preferenceStorage;
try { preferenceStorage = window.localStorage; } catch { /* Storage can be disabled. */ }
const preferences = readPublicCoursePreferences(preferenceStorage);
const showCenterline = ref(preferences.showCenterline);
const mapBearing = ref(preferences.mapBearing);
let map = null;
let renderer = null;
let courseLayers = null;
let viewport = null;
let unmounted = false;
const state = reactive({ courses: [], details: {}, selectedId: preferences.selectedId, overlays: preferences.overlays, loading: true, error: "" });
const data = createPublicCourseData(state, { request: requestPublicCourse });
const active = computed(() => state.details[state.selectedId]);
const geometries = computed(() => Object.fromEntries(Object.entries(state.details).map(([id, detail]) => {
  const { course, cones, route } = detail;
  try {
    const { centerline } = resolveCourseRoute(cones, route.markers, route.steps, {
      step: 1.0, fallback: courseDirectionOptions(course, cones),
    });
    return [id, centerline.ok ? { line: centerline } : { line: null }];
  } catch { return [id, { line: null }]; }
})));
const geometry = computed(() => geometries.value[state.selectedId] || { line: null });

const { toolMode, measureResult, enterToolMode, exitToolMode, resetMeasure, handleMeasureClick } = useMeasureTools({
  getMap: () => map,
  rebuildMarkers: () => {},
  isCoursesTab: () => false,
  clearOtherModes: () => {},
});

function draw() {
  if (!map) return;
  courseLayers?.remove();
  courseLayers = L.layerGroup().addTo(map);
  for (const course of state.courses) {
    const display = courseDisplayState(course.id, state.selectedId, state.overlays);
    if (display === "hidden") continue;
    const cones = state.details[course.id]?.cones || [];
    const ranks = buildSideRanks(cones);
    for (const cone of cones) {
      const opacity = display === "selected" ? 1 : 0.45;
      L.circleMarker([cone.lat, cone.lng], {
        renderer, radius: 9, color: "#fff", weight: 2,
        fillColor: SIDE_COLORS[cone.side], opacity, fillOpacity: opacity,
        interactive: false, label: ranks.get(cone.id) || 0,
      }).addTo(courseLayers);
    }
  }
  if (showCenterline.value && geometry.value.line) courseCenterlineLayer(geometry.value.line).addTo(courseLayers);
  viewport?.fit();
}

function measureAt(event) {
  if (toolMode.value === "none" || !active.value) return;
  const tap = map.latLngToContainerPoint(event.latlng);
  let point = event.latlng;
  let nearest = 24;
  for (const cone of active.value.cones) {
    const distance = map.latLngToContainerPoint([cone.lat, cone.lng]).distanceTo(tap);
    if (distance < nearest) { nearest = distance; point = L.latLng(cone.lat, cone.lng); }
  }
  handleMeasureClick(point);
}

function toggleOverlay(id) {
  if (id !== state.selectedId) state.overlays[id] = state.overlays[id] !== true;
}

async function download(id) {
  if (exportingId.value != null) return;
  exportingId.value = id;
  try {
    const { buildCourseArchive, downloadCourseArchive } = await import("../export/course-archive.mjs");
    const archive = await data.exportCourse(id, buildCourseArchive);
    downloadCourseArchive(archive);
  } catch (error) { if (!unmounted) notifyError(error.message || "다운로드에 실패했습니다."); }
  finally { exportingId.value = null; }
}

function rotateMap() {
  if (!map) return;
  mapBearing.value = normalizeMapBearing(mapBearing.value - 90);
  map.setBearing(renderMapBearing(mapBearing.value));
  savePublicCoursePreference(preferenceStorage, "mapBearing", mapBearing.value);
}

watch(() => state.selectedId, (id) => {
  savePublicCoursePreference(preferenceStorage, "selectedId", id);
  exitToolMode();
  draw();
});
watch(() => state.details, () => { resetMeasure(); draw(); });
watch(showCenterline, (value) => {
  savePublicCoursePreference(preferenceStorage, "showCenterline", value);
  draw();
});
watch(() => state.overlays, (overlays) => {
  savePublicCoursePreference(preferenceStorage, "overlays", overlays);
  draw();
}, { deep: true });

onMounted(async () => {
  try {
    map = await createCourseBaseMap(mapElement.value, { bearing: renderMapBearing(mapBearing.value) });
    if (unmounted) { map.remove(); map = null; return; }
    viewport = createPublicCourseViewport(map, () => ({ id: state.selectedId, cones: active.value?.cones }));
    renderer = new LabeledConeCanvas({ padding: 0.5 });
    map.on("click", measureAt);
    await data.refresh();
  } catch (error) { state.loading = false; state.error = error.message || "지도를 불러오지 못했습니다."; }
});
onUnmounted(() => {
  unmounted = true;
  data.dispose();
  viewport?.dispose();
  map?.remove();
  map = null;
});
</script>

<template>
  <div class="public-course">
    <div class="public-body">
      <div class="public-map-wrap">
        <div ref="mapElement" class="public-map" aria-label="경기 코스 지도"></div>
        <div v-if="active" class="map-fab-panel map-fab-tools" role="group" aria-label="코스 도구">
          <button :class="['fab-icon-btn', 'fab-tool', { active: showCenterline }]" aria-label="중심선 표시" title="중심선" :aria-pressed="showCenterline" @click="showCenterline = !showCenterline"><CourseMapIcon name="centerline" /></button>
          <button :class="['fab-icon-btn', 'fab-tool', { active: toolMode === 'ruler' }]" aria-label="거리 측정" title="자" :aria-pressed="toolMode === 'ruler'" @click="enterToolMode('ruler')"><CourseMapIcon name="ruler" /></button>
          <button :class="['fab-icon-btn', 'fab-tool', { active: toolMode === 'protractor' }]" aria-label="각도 측정" title="각도기" :aria-pressed="toolMode === 'protractor'" @click="enterToolMode('protractor')"><CourseMapIcon name="protractor" /></button>
          <button class="fab-icon-btn" aria-label="지도 90° 회전" title="지도 90° 회전" @click="rotateMap"><CourseMapIcon name="rotate" /></button>
        </div>
        <div v-if="toolMode !== 'none' && active" class="public-measure" role="status">
          <strong v-if="measureResult">{{ measureResult }}</strong>
          <button class="fab-icon-btn" aria-label="측정 초기화" title="초기화" @click="resetMeasure"><CourseMapIcon name="reset" /></button>
          <button class="fab-icon-btn" aria-label="측정 닫기" title="닫기" @click="exitToolMode"><CourseMapIcon name="close" /></button>
        </div>
      </div>
      <aside class="public-inspector" aria-label="공개 코스">
        <div class="public-list-heading">
          <h2>코스 목록</h2>
        </div>
        <p v-if="state.loading" role="status">코스를 불러오는 중…</p>
        <div v-else-if="state.error" role="alert">
          <p>{{ state.error }}</p>
          <button class="btn btn-ghost" @click="data.refresh">다시 불러오기</button>
        </div>
        <p v-else-if="!state.courses.length">공개된 코스가 없습니다.</p>
        <ul class="public-course-list">
          <li v-for="course in state.courses" :key="course.id" class="public-course-item" :class="{ selected: state.selectedId === course.id }">
            <button class="btn public-select" :title="course.name" :aria-pressed="state.selectedId === course.id" @click="state.selectedId = course.id">
              <span class="public-course-name">{{ course.name }}</span> <span class="public-course-length" v-if="geometries[course.id]?.line">({{ Math.round(geometries[course.id].line.length) }}m)</span>
            </button>
            <div class="public-course-actions">
              <button class="fab-icon-btn public-download" aria-label="Asseto Corsa 트랙 다운로드" title="다운로드" :aria-busy="exportingId === course.id" :disabled="state.loading || !state.details[course.id] || exportingId != null" @click="download(course.id)">
                <CourseMapIcon name="download" />
                <span>Asseto Corsa 트랙</span>
              </button>
              <button class="fab-icon-btn" aria-label="코스 표시" title="코스 표시" :disabled="state.selectedId === course.id" :aria-pressed="state.selectedId === course.id || state.overlays[course.id] === true" @click="toggleOverlay(course.id)">
                <CourseMapIcon :name="state.selectedId === course.id || state.overlays[course.id] === true ? 'eye' : 'eye-off'" />
              </button>
            </div>
          </li>
        </ul>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.public-course { height: 100%; display: flex; flex-direction: column; }
.public-body { flex: 1; min-height: 0; display: flex; }
.public-map-wrap { position: relative; flex: 1; min-width: 0; min-height: 0; }
.public-map { width: 100%; height: 100%; }
.public-measure { position: absolute; z-index: 800; bottom: 25px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 24px); background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 10px; padding: .5rem; display: flex; flex-wrap: nowrap; gap: .5rem; align-items: center; box-shadow: var(--shadow-hover); }
.public-measure strong { margin: 0 .5rem; white-space: nowrap; }
.public-measure .fab-icon-btn { width: 44px; height: 44px; }
.public-inspector { --course-action-size: 28px; --course-title-size: 28px; flex: 0 0 320px; min-height: 0; display: flex; flex-direction: column; gap: .625rem; padding: .875rem; overflow: hidden; background: var(--bg-primary); }
.public-list-heading { flex: none; }
.public-list-heading h2 { margin: 0; font-size: .95rem; font-weight: 600; }
.public-course-list { list-style: none; min-height: 0; overflow-y: auto; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .375rem; }
.public-course-item { flex: none; display: flex; flex-direction: column; gap: 0; padding: .25rem .625rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); transition: border-color .15s, background .15s; }
.public-course-item.selected { border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-color)); background: color-mix(in srgb, var(--accent-primary) 7%, var(--bg-primary)); }
.public-select { width: 100%; min-width: 0; min-height: var(--course-title-size); text-align: left; justify-content: flex-start; padding: 0; gap: .375rem; white-space: nowrap; overflow: hidden; border-radius: 6px; background: transparent; color: var(--text-primary); font-weight: 600; }
.public-course-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.public-course-length { flex: none; font-size: .85em; font-weight: 400; color: var(--text-secondary); }
.public-course-actions { display: flex; justify-content: space-between; gap: .375rem; }
.public-course-actions .fab-icon-btn { width: var(--course-action-size); height: var(--course-action-size); border: 0; background: transparent; color: var(--text-secondary); }
.public-course-actions .fab-icon-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.public-course-actions .fab-icon-btn[aria-pressed="true"] { color: var(--accent-primary); }
.public-course-actions .public-download { width: auto; gap: .375rem; padding: 0 .25rem; font-size: .75rem; white-space: nowrap; }
@media (any-pointer: coarse) {
  .public-inspector { --course-action-size: 32px; }
}
@media (max-width: 768px) {
  .public-body { flex-direction: column; }
  .public-map-wrap { flex: 1; }
  .public-inspector { --course-action-size: 32px; flex: 0 1 auto; max-height: 38dvh; gap: .5rem; padding: .625rem .75rem; border-top: 1px solid var(--border-color); }
  /* Keep two complete cards visible before scrolling. */
  .public-course-list { max-height: calc((var(--course-title-size) + var(--course-action-size) + .5rem + 2px) * 2 + .375rem); }
}
</style>
