<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import L from "leaflet";
import { request } from "../api.js";

/* ── State ─────────────────────────────────────────── */
const courses = ref([]);
const conesMap = ref({});
const visibility = ref({});
const activeCourseId = ref(null);
const loading = ref(true);
const newCourseName = ref("");
const currentSide = ref("left");
const roverLoading = ref(false);
const coneFilter = ref("all");
const selectedConeId = ref(null);
const multiSelectedIds = ref(new Set());
const editLat = ref("");
const editLng = ref("");
const editSide = ref("left");
const editingCourseId = ref(null);
const editCourseName = ref("");

// Rover control
const roverMode = ref("none"); // none | path-pick | path-ready | executing | stopped | manual
const pathWaypoints = ref([]);
const executedIndex = ref(0);
const pathProgress = ref(0);
const pathDistance = ref(0);
const manualThrottle = ref(0);
const manualSteering = ref(0);

// Mobile bottom sheet
const isMobile = ref(false);
const sheetExpanded = ref(false);
const sheetHeight = ref(52); // px — 52 = collapsed (handle only)
const sheetDragging = ref(false);
let dragStartY = 0;
let dragStartHeight = 0;
let wasDrag = false;

function onSheetTouchStart(e) {
  dragStartY = e.touches[0].clientY;
  dragStartHeight = sheetHeight.value;
  wasDrag = false;
}

function onSheetTouchMove(e) {
  const dy = dragStartY - e.touches[0].clientY;
  if (!wasDrag && Math.abs(dy) > 5) { wasDrag = true; sheetDragging.value = true; }
  if (!wasDrag) return;
  e.preventDefault();
  sheetHeight.value = Math.min(Math.max(52, dragStartHeight + dy), window.innerHeight * 0.85);
}

function onSheetTouchEnd() {
  sheetDragging.value = false;
  if (!wasDrag) {
    // tap → toggle
    sheetHeight.value = sheetHeight.value <= 52 ? window.innerHeight * 0.5 : 52;
  } else if (sheetHeight.value < 100) {
    sheetHeight.value = 52;
  }
  sheetExpanded.value = sheetHeight.value > 52;
}

let map = null;
let markers = {};
let roverMarker = null;
let pathLine = null;
let pathStartMarker = null;
let pathEndMarker = null;
let eventSource = null;
let controlInterval = null;
let suppressRebuild = false;
let isMultiDragging = false;
let dragStartPositions = null;
let dragOrigin = null;
let justFinishedBoxSelect = false;

const SIDE_COLORS = { left: "#8b5cf6", right: "#06b6d4", center: "#f59e0b" };

/* ── Computed ──────────────────────────────────────── */
const activeCourse = computed(() => courses.value.find((c) => c.id === activeCourseId.value));

const pathBtnLabel = computed(() => {
  if (roverMode.value === "executing") return `실행 중 ${pathProgress.value}%`;
  if (roverMode.value === "stopped") return "이어서 실행";
  if (roverMode.value === "path-ready") return "경로 실행";
  if (roverMode.value === "path-pick") return "계산 취소";
  return "경로 계산";
});

const pathBtnClass = computed(() => {
  if (roverMode.value === "executing") return "btn-primary";
  if (roverMode.value === "stopped") return "btn-primary";
  if (roverMode.value === "path-ready") return "btn-primary";
  if (roverMode.value === "path-pick") return "btn-danger";
  return "btn-ghost";
});
const activeCones = computed(() => conesMap.value[activeCourseId.value] || []);
const filteredCones = computed(() => {
  if (coneFilter.value === "all") return activeCones.value;
  return activeCones.value.filter((c) => c.side === coneFilter.value);
});

/* ── Icon helpers ──────────────────────────────────── */
function coneSideIndex(courseId, coneId) {
  const cones = conesMap.value[courseId] || [];
  const cone = cones.find((c) => c.id === coneId);
  if (!cone) return 0;
  return cones.filter((c) => c.side === cone.side && c.id <= coneId).length;
}

function coneIcon(side, num, active) {
  const opacity = active ? 1 : 0.45;
  return L.divIcon({
    className: "",
    html: `<div style="opacity:${opacity};position:relative;width:20px;height:20px;border-radius:50%;background:${SIDE_COLORS[side]};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:10px;font-weight:700;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,0.5);">${num}</span></div>`,
    iconSize: [20, 20], iconAnchor: [10, 10],
  });
}

function highlightIcon(side, num) {
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:24px;height:24px;border-radius:50%;background:${SIDE_COLORS[side]};border:3px solid #fbbf24;box-shadow:0 0 8px rgba(251,191,36,0.6);display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:11px;font-weight:700;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,0.5);">${num}</span></div>`,
    iconSize: [24, 24], iconAnchor: [12, 12],
  });
}

function multiSelectIcon(side, num) {
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:24px;height:24px;border-radius:50%;background:${SIDE_COLORS[side]};border:3px solid #38bdf8;box-shadow:0 0 8px rgba(56,189,248,0.6);display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:11px;font-weight:700;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,0.5);">${num}</span></div>`,
    iconSize: [24, 24], iconAnchor: [12, 12],
  });
}

/* ── Map markers ──────────────────────────────────── */
function rebuildAllMarkers() {
  Object.values(markers).forEach((m) => map.removeLayer(m));
  markers = {};

  for (const course of courses.value) {
    if (!visibility.value[course.id]) continue;
    const cones = conesMap.value[course.id] || [];
    const isActive = course.id === activeCourseId.value;

    for (const cone of cones) {
      const num = coneSideIndex(course.id, cone.id);
      const isMultiSelected = isActive && multiSelectedIds.value.has(cone.id);
      const isSingleSelected = isActive && selectedConeId.value === cone.id;
      const icon = isSingleSelected
        ? highlightIcon(cone.side, num)
        : isMultiSelected
          ? multiSelectIcon(cone.side, num)
          : coneIcon(cone.side, num, isActive);

      const marker = L.marker([cone.lat, cone.lng], { icon, draggable: isActive });

      if (isActive) {
        marker.on("click", (e) => {
          if (e.originalEvent && e.originalEvent.shiftKey) {
            const newSet = new Set(multiSelectedIds.value);
            if (newSet.has(cone.id)) newSet.delete(cone.id);
            else newSet.add(cone.id);
            multiSelectedIds.value = newSet;
            selectedConeId.value = null;
            updateMultiSelectIcons();
          } else {
            if (multiSelectedIds.value.size > 0) {
              multiSelectedIds.value = new Set();
              updateMultiSelectIcons();
            }
            selectedConeId.value = cone.id;
          }
        });

        marker.on("dragstart", () => {
          if (multiSelectedIds.value.has(cone.id) && multiSelectedIds.value.size > 1) {
            isMultiDragging = true;
            suppressRebuild = true;
            dragOrigin = L.latLng(cone.lat, cone.lng);
            dragStartPositions = new Map();
            for (const id of multiSelectedIds.value) {
              if (id === cone.id) continue;
              const c = (conesMap.value[activeCourseId.value] || []).find(cc => cc.id === id);
              if (c) dragStartPositions.set(id, L.latLng(c.lat, c.lng));
            }
          }
        });

        marker.on("drag", () => {
          if (!isMultiDragging) return;
          const newPos = marker.getLatLng();
          const dLat = newPos.lat - dragOrigin.lat;
          const dLng = newPos.lng - dragOrigin.lng;
          for (const [id, origPos] of dragStartPositions) {
            const key = `${activeCourseId.value}-${id}`;
            const m = markers[key];
            if (m) m.setLatLng([origPos.lat + dLat, origPos.lng + dLng]);
          }
        });

        marker.on("dragend", async () => {
          if (isMultiDragging) {
            const { lat, lng } = marker.getLatLng();
            const dLat = lat - dragOrigin.lat;
            const dLng = lng - dragOrigin.lng;

            const updates = [{ id: cone.id, lat, lng }];
            for (const [id, origPos] of dragStartPositions) {
              updates.push({ id, lat: origPos.lat + dLat, lng: origPos.lng + dLng });
            }

            isMultiDragging = false;
            dragStartPositions = null;
            dragOrigin = null;

            try {
              await Promise.all(updates.map(u =>
                request(`/api/cones/${u.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ lat: u.lat, lng: u.lng }),
                })
              ));
            } catch {}

            suppressRebuild = false;
            rebuildAllMarkers();
          } else {
            const { lat, lng } = marker.getLatLng();
            try {
              await request(`/api/cones/${cone.id}`, { method: "PATCH", body: JSON.stringify({ lat, lng }) });
            } catch {
              marker.setLatLng([cone.lat, cone.lng]);
            }
          }
        });
      }

      marker.addTo(map);
      markers[`${course.id}-${cone.id}`] = marker;
    }
  }
}

function updateMultiSelectIcons() {
  const aid = activeCourseId.value;
  if (!aid) return;
  for (const cone of (conesMap.value[aid] || [])) {
    const key = `${aid}-${cone.id}`;
    const m = markers[key];
    if (!m) continue;
    const num = coneSideIndex(aid, cone.id);
    if (selectedConeId.value === cone.id) {
      m.setIcon(highlightIcon(cone.side, num));
    } else if (multiSelectedIds.value.has(cone.id)) {
      m.setIcon(multiSelectIcon(cone.side, num));
    } else {
      m.setIcon(coneIcon(cone.side, num, true));
    }
  }
}

function clearMultiSelection() {
  multiSelectedIds.value = new Set();
  updateMultiSelectIcons();
}

/* ── Watchers ─────────────────────────────────────── */
watch(selectedConeId, (id) => {
  const aid = activeCourseId.value;
  Object.entries(markers).forEach(([key, marker]) => {
    if (!key.startsWith(`${aid}-`)) return;
    const coneId = parseInt(key.split("-")[1]);
    const cone = (conesMap.value[aid] || []).find((c) => c.id === coneId);
    if (!cone) return;
    if (coneId === id) {
      marker.setIcon(highlightIcon(cone.side, coneSideIndex(aid, cone.id)));
      map.panTo([cone.lat, cone.lng]);
      nextTick(() => {
        const el = document.querySelector(`[data-cone-id="${id}"]`);
        if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    } else if (multiSelectedIds.value.has(coneId)) {
      marker.setIcon(multiSelectIcon(cone.side, coneSideIndex(aid, cone.id)));
    } else {
      marker.setIcon(coneIcon(cone.side, coneSideIndex(aid, cone.id), true));
    }
  });

  if (id) {
    const cone = activeCones.value.find((c) => c.id === id);
    if (cone) {
      editLat.value = cone.lat.toString();
      editLng.value = cone.lng.toString();
      editSide.value = cone.side;
    }
  }
});

watch(activeCourseId, () => {
  selectedConeId.value = null;
  multiSelectedIds.value = new Set();
  coneFilter.value = "all";
  clearPath();
  if (map) rebuildAllMarkers();
});

/* ── Data fetch ───────────────────────────────────── */
async function fetchAll() {
  try {
    const res = await request("/api/courses");
    courses.value = await res.json();
    for (const c of courses.value) {
      if (visibility.value[c.id] === undefined) visibility.value[c.id] = true;
      try {
        const r = await request(`/api/courses/${c.id}/cones`);
        conesMap.value[c.id] = await r.json();
      } catch { conesMap.value[c.id] = []; }
    }
    if (!activeCourseId.value && courses.value.length) {
      activeCourseId.value = courses.value[0].id;
    }
  } catch {} finally { loading.value = false; }
}

/* ── Map init ─────────────────────────────────────── */
function initMap() {
  map = L.map("map", { zoomControl: true, maxZoom: 21, boxZoom: false }).setView([35.292012, 126.574415], 19);
  L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2", {
    subdomains: "0123", attribution: "&copy; Google", maxZoom: 21,
  }).addTo(map);

  map.on("click", onMapClick);
  setupSelectionBox();
  rebuildAllMarkers();
}

function onMapClick(e) {
  if (justFinishedBoxSelect) return;
  if (roverMode.value === "path-pick") {
    computePath(e.latlng.lat, e.latlng.lng);
    return;
  }
  if (roverMode.value === "path-ready" || roverMode.value === "stopped") {
    clearPath();
    return;
  }
  if (roverMode.value === "executing") return;
  if (multiSelectedIds.value.size > 0) {
    multiSelectedIds.value = new Set();
    updateMultiSelectIcons();
    return;
  }
  if (selectedConeId.value) { selectedConeId.value = null; return; }
  if (!activeCourseId.value || roverMode.value === "manual") return;
  addCone(e.latlng.lat, e.latlng.lng, currentSide.value);
}

/* ── Box selection (Shift+drag) ───────────────────── */
function onSelectionStart(e) {
  if (!e.shiftKey || !activeCourseId.value || e.button !== 0) return;

  map.dragging.disable();

  const container = map.getContainer();
  const containerRect = container.getBoundingClientRect();
  const startPx = { x: e.clientX - containerRect.left, y: e.clientY - containerRect.top };

  const boxEl = document.createElement("div");
  boxEl.className = "selection-box";
  container.appendChild(boxEl);

  function onMove(ev) {
    const curPx = { x: ev.clientX - containerRect.left, y: ev.clientY - containerRect.top };
    boxEl.style.left = Math.min(startPx.x, curPx.x) + "px";
    boxEl.style.top = Math.min(startPx.y, curPx.y) + "px";
    boxEl.style.width = Math.abs(curPx.x - startPx.x) + "px";
    boxEl.style.height = Math.abs(curPx.y - startPx.y) + "px";
  }

  function onUp(ev) {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);

    const endPx = { x: ev.clientX - containerRect.left, y: ev.clientY - containerRect.top };
    const bounds = {
      left: Math.min(startPx.x, endPx.x),
      top: Math.min(startPx.y, endPx.y),
      right: Math.max(startPx.x, endPx.x),
      bottom: Math.max(startPx.y, endPx.y),
    };

    if (bounds.right - bounds.left > 5 || bounds.bottom - bounds.top > 5) {
      const cones = conesMap.value[activeCourseId.value] || [];
      const newSet = new Set(multiSelectedIds.value);
      for (const cone of cones) {
        const pt = map.latLngToContainerPoint([cone.lat, cone.lng]);
        if (pt.x >= bounds.left && pt.x <= bounds.right && pt.y >= bounds.top && pt.y <= bounds.bottom) {
          newSet.add(cone.id);
        }
      }
      multiSelectedIds.value = newSet;
      selectedConeId.value = null;
      updateMultiSelectIcons();
    }

    boxEl.remove();
    map.dragging.enable();
    justFinishedBoxSelect = true;
    setTimeout(() => { justFinishedBoxSelect = false; }, 100);
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function setupSelectionBox() {
  map.getContainer().addEventListener("mousedown", onSelectionStart);
}

/* ── Course CRUD ──────────────────────────────────── */
function toggleVisibility(courseId) {
  visibility.value[courseId] = !visibility.value[courseId];
  if (map) rebuildAllMarkers();
}

function selectCourse(courseId) { activeCourseId.value = courseId; }

async function createCourse() {
  const name = newCourseName.value.trim();
  if (!name) return;
  try {
    const res = await request("/api/courses", { method: "POST", body: JSON.stringify({ name }) });
    const created = await res.json();
    newCourseName.value = "";
    activeCourseId.value = created.id;
    visibility.value[created.id] = true;
  } catch (err) { alert(err.message); }
}

function startEditCourse(course) {
  editingCourseId.value = course.id;
  editCourseName.value = course.name;
}

async function saveCourseName(id) {
  const name = editCourseName.value.trim();
  if (!name) return;
  try {
    await request(`/api/courses/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    editingCourseId.value = null;
  } catch (err) { alert(err.message); }
}

async function exportCourse(id) {
  const base = import.meta.env.PROD ? "/course" : "";
  const course = courses.value.find((c) => c.id === id);
  try {
    const res = await request(`/api/courses/${id}/export`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${course?.name || "course"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { alert(err.message); }
}

async function importCourse(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await request("/api/courses/import", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const created = await res.json();
    activeCourseId.value = created.id;
    visibility.value[created.id] = true;
  } catch (err) {
    alert(err.message);
  }
}

async function deleteCourse(id) {
  const course = courses.value.find((c) => c.id === id);
  if (!confirm(`"${course?.name}" 코스를 삭제하시겠습니까?`)) return;
  try {
    await request(`/api/courses/${id}`, { method: "DELETE" });
    if (activeCourseId.value === id) {
      activeCourseId.value = courses.value.find((c) => c.id !== id)?.id || null;
    }
  } catch (err) { alert(err.message); }
}

/* ── Cone CRUD ────────────────────────────────────── */
async function addCone(lat, lng, side) {
  if (!activeCourseId.value) return;
  try {
    await request(`/api/courses/${activeCourseId.value}/cones`, {
      method: "POST", body: JSON.stringify({ lat, lng, side }),
    });
  } catch (err) { alert(err.message); }
}

async function updateCone() {
  if (!selectedConeId.value) return;
  const lat = parseFloat(editLat.value);
  const lng = parseFloat(editLng.value);
  if (isNaN(lat) || isNaN(lng)) return;
  try {
    await request(`/api/cones/${selectedConeId.value}`, {
      method: "PATCH", body: JSON.stringify({ lat, lng, side: editSide.value }),
    });
    selectedConeId.value = null;
  } catch (err) { alert(err.message); }
}

async function deleteCone(id) {
  try {
    await request(`/api/cones/${id}`, { method: "DELETE" });
    if (selectedConeId.value === id) selectedConeId.value = null;
  } catch (err) { alert(err.message); }
}

function panToCone(cone) {
  selectedConeId.value = cone.id;
  map.setView([cone.lat, cone.lng], Math.max(map.getZoom(), 17));
}

/* ── Rover position ───────────────────────────────── */
function updateRoverMarker(lat, lng) {
  if (!map) return;
  if (roverMarker) {
    roverMarker.setLatLng([lat, lng]);
  } else {
    roverMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid #a855f7;box-shadow:0 0 8px rgba(168,85,247,0.6);"></div>`,
        iconSize: [12, 12], iconAnchor: [6, 6],
      }),
      zIndexOffset: 1000, interactive: false,
    }).addTo(map);
    roverMarker.bindTooltip("로버", { direction: "top", offset: [0, -8], permanent: true, className: "rover-tooltip" });
  }
}

async function addConeFromRover() {
  if (!activeCourseId.value) return;
  roverLoading.value = true;
  try {
    const res = await request("/api/rover/request", { method: "POST" });
    const { lat, lng } = await res.json();
    updateRoverMarker(lat, lng);
    await addCone(lat, lng, currentSide.value);
  } catch (err) {
    alert(err.message || "로버 위치 수신에 실패했습니다.");
  } finally { roverLoading.value = false; }
}

/* ── Path planning (TSP + 2-opt) ──────────────────── */
function haversine(a, b) {
  const R = 6371e3;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function turnAngle(a, b, c) {
  const ax = b.lng - a.lng, ay = b.lat - a.lat;
  const bx = c.lng - b.lng, by = c.lat - b.lat;
  const dot = ax * bx + ay * by;
  const cross = ax * by - ay * bx;
  return Math.abs(Math.atan2(cross, dot));
}

// 경로 비용: 거리 + 회전 페널티 (회전반경 ~1m, 급회전 시 감속 고려)
const TURN_PENALTY = 2.0; // 라디안당 미터 환산 페널티

function routeCost(pts) {
  let cost = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    cost += haversine(pts[i], pts[i + 1]);
    if (i > 0) cost += turnAngle(pts[i - 1], pts[i], pts[i + 1]) * TURN_PENALTY;
  }
  return cost;
}

function twoOpt(route, end) {
  const pts = [...route];
  if (pts.length <= 2) return pts;
  let improved = true;
  let iterations = 0;
  while (improved && iterations < 500) {
    iterations++;
    improved = false;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = i + 2; j < pts.length; j++) {
        // Try reversing segment [i+1 .. j]
        const newPts = [...pts.slice(0, i + 1), ...pts.slice(i + 1, j + 1).reverse(), ...pts.slice(j + 1)];
        const full = [...newPts, end];
        const fullOld = [...pts, end];
        if (routeCost(full) < routeCost(fullOld)) {
          for (let k = 0; k < pts.length; k++) pts[k] = newPts[k];
          improved = true;
        }
      }
    }
  }
  return pts;
}

function startPathPick() {
  clearPath();
  roverMode.value = "path-pick";
}

function computePath(startLat, startLng) {
  const allCones = activeCones.value;
  if (allCones.length === 0) { roverMode.value = "none"; return; }

  const start = { lat: startLat, lng: startLng };

  // Step 1: Nearest Neighbor initial solution
  const visited = new Set();
  const route = [];
  let current = start;

  while (visited.size < allCones.length) {
    let nearest = null, nearestDist = Infinity;
    for (const cone of allCones) {
      if (visited.has(cone.id)) continue;
      const d = haversine(current, cone);
      if (d < nearestDist) { nearest = cone; nearestDist = d; }
    }
    if (!nearest) break;
    visited.add(nearest.id);
    route.push({ lat: nearest.lat, lng: nearest.lng });
    current = nearest;
  }

  // Step 2: 2-opt improvement (distance + turn penalty)
  const optimized = twoOpt(route, start);

  pathWaypoints.value = optimized;

  // Compute total distance
  let dist = haversine(start, optimized[0]);
  for (let i = 0; i < optimized.length - 1; i++) dist += haversine(optimized[i], optimized[i + 1]);
  dist += haversine(optimized[optimized.length - 1], start);
  pathDistance.value = dist;

  // Draw on map
  if (pathLine) map.removeLayer(pathLine);
  if (pathStartMarker) map.removeLayer(pathStartMarker);
  if (pathEndMarker) map.removeLayer(pathEndMarker);

  const fullPath = [{ lat: startLat, lng: startLng }, ...optimized, { lat: startLat, lng: startLng }];
  const stops = [[34,197,94],[234,179,8],[249,115,22],[239,68,68]]; // green→yellow→orange→red
  const group = L.layerGroup();
  for (let i = 0; i < fullPath.length - 1; i++) {
    const t = fullPath.length <= 2 ? 0 : i / (fullPath.length - 2);
    const seg = t * (stops.length - 1);
    const idx = Math.min(Math.floor(seg), stops.length - 2);
    const lt = seg - idx;
    const r = Math.round(stops[idx][0] + (stops[idx + 1][0] - stops[idx][0]) * lt);
    const g = Math.round(stops[idx][1] + (stops[idx + 1][1] - stops[idx][1]) * lt);
    const b = Math.round(stops[idx][2] + (stops[idx + 1][2] - stops[idx][2]) * lt);
    L.polyline([[fullPath[i].lat, fullPath[i].lng], [fullPath[i + 1].lat, fullPath[i + 1].lng]], {
      color: `rgb(${r},${g},${b})`, weight: 4, opacity: 1,
    }).addTo(group);
  }
  pathLine = group.addTo(map);

  function pathLabel(text, latlng, color) {
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:11px;font-weight:800;line-height:1;">${text}</span></div>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
      }),
      interactive: false, zIndexOffset: 900,
    });
  }

  pathStartMarker = pathLabel("S", [optimized[0].lat, optimized[0].lng], "#22c55e").addTo(map);
  pathEndMarker = pathLabel("E", [startLat, startLng], "#ef4444").addTo(map);

  roverMode.value = "path-ready";
}

function clearPath() {
  if (pathLine) { map.removeLayer(pathLine); pathLine = null; }
  if (pathStartMarker) { map.removeLayer(pathStartMarker); pathStartMarker = null; }
  if (pathEndMarker) { map.removeLayer(pathEndMarker); pathEndMarker = null; }
  pathWaypoints.value = [];
  executedIndex.value = 0;
  pathProgress.value = 0;
  pathDistance.value = 0;
  if (roverMode.value !== "manual") roverMode.value = "none";
}

function onPathBtn() {
  if (roverMode.value === "executing") return; // 실행 중에는 무시
  if (roverMode.value === "stopped") { resumePath(); return; }
  if (roverMode.value === "path-ready") { executePath(); return; }
  if (roverMode.value === "path-pick") { clearPath(); return; }
  if (roverMode.value === "none") { startPathPick(); }
}

async function executePath() {
  if (pathWaypoints.value.length === 0) return;
  executedIndex.value = 0;
  pathProgress.value = 0;
  roverMode.value = "executing";
  try {
    await request("/api/rover/execute", {
      method: "POST",
      body: JSON.stringify({ waypoints: pathWaypoints.value }),
    });
  } catch (err) {
    roverMode.value = "path-ready";
    alert(err.message);
  }
}

async function resumePath() {
  const remaining = pathWaypoints.value.slice(executedIndex.value);
  if (remaining.length === 0) { clearPath(); return; }
  roverMode.value = "executing";
  try {
    await request("/api/rover/execute", {
      method: "POST",
      body: JSON.stringify({ waypoints: remaining }),
    });
  } catch (err) {
    roverMode.value = "stopped";
    alert(err.message);
  }
}

function updatePathProgress(lat, lng) {
  if (pathWaypoints.value.length === 0) return;
  // Find nearest waypoint to rover position
  let minDist = Infinity, minIdx = 0;
  for (let i = 0; i < pathWaypoints.value.length; i++) {
    const d = haversine({ lat, lng }, pathWaypoints.value[i]);
    if (d < minDist) { minDist = d; minIdx = i; }
  }
  executedIndex.value = minIdx;
  pathProgress.value = Math.round(((minIdx + 1) / pathWaypoints.value.length) * 100);
}

/* ── Emergency stop ───────────────────────────────── */
async function emergencyStop() {
  stopManualControl();
  try { await request("/api/rover/stop", { method: "POST" }); } catch (err) { alert(err.message); }
  if (roverMode.value === "executing") roverMode.value = "stopped";
}

/* ── Manual control ───────────────────────────────── */
function startManualControl() {
  clearPath();
  roverMode.value = "manual";
  manualThrottle.value = 0;
  manualSteering.value = 0;
  sendControl();
  controlInterval = setInterval(sendControl, 50);
}

function stopManualControl() {
  if (controlInterval) { clearInterval(controlInterval); controlInterval = null; }
  manualThrottle.value = 0;
  manualSteering.value = 0;
  sendControl();
  if (roverMode.value === "manual") roverMode.value = "none";
}

async function sendControl() {
  try {
    await request("/api/rover/control", {
      method: "POST",
      body: JSON.stringify({ throttle: manualThrottle.value, steering: manualSteering.value }),
    });
  } catch {}
}

// Joystick pointer handling
let joystickEl = null;
let joystickRect = null;
let activePointerId = null;

function onJoystickDown(e) {
  joystickEl = e.currentTarget;
  joystickRect = joystickEl.getBoundingClientRect();
  activePointerId = e.pointerId;
  joystickEl.setPointerCapture(e.pointerId);
  updateJoystick(e);
}

function onJoystickMove(e) {
  if (e.pointerId !== activePointerId) return;
  updateJoystick(e);
}

function onJoystickUp(e) {
  if (e.pointerId !== activePointerId) return;
  activePointerId = null;
  manualThrottle.value = 0;
  manualSteering.value = 0;
}

function updateJoystick(e) {
  if (!joystickRect) return;
  const cx = joystickRect.left + joystickRect.width / 2;
  const cy = joystickRect.top + joystickRect.height / 2;
  const maxR = joystickRect.width / 2;

  let dx = (e.clientX - cx) / maxR;
  let dy = -(e.clientY - cy) / maxR;

  // Clamp to unit circle
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 1) { dx /= len; dy /= len; }

  manualSteering.value = Math.round(dx * 100);
  manualThrottle.value = Math.round(dy * 100);
}

/* ── SSE ──────────────────────────────────────────── */
function connectSSE() {
  const base = import.meta.env.PROD ? "/course" : "";
  eventSource = new EventSource(`${base}/api/events`);

  eventSource.addEventListener("init", (e) => {
    courses.value = JSON.parse(e.data).courses;
  });

  eventSource.addEventListener("courses", (e) => {
    const data = JSON.parse(e.data);
    courses.value = data.courses;
    for (const id of Object.keys(conesMap.value)) {
      if (!data.courses.find((c) => c.id === parseInt(id))) {
        delete conesMap.value[id];
        delete visibility.value[id];
      }
    }
    for (const c of data.courses) {
      if (visibility.value[c.id] === undefined) visibility.value[c.id] = true;
    }
    if (activeCourseId.value && !data.courses.find((c) => c.id === activeCourseId.value)) {
      activeCourseId.value = data.courses[0]?.id || null;
    }
  });

  eventSource.addEventListener("cones", (e) => {
    const data = JSON.parse(e.data);
    conesMap.value[data.courseId] = data.cones;
    if (map && !suppressRebuild) rebuildAllMarkers();
  });

  eventSource.addEventListener("rover", (e) => {
    const data = JSON.parse(e.data);
    updateRoverMarker(data.lat, data.lng);
    if (roverMode.value === "executing") updatePathProgress(data.lat, data.lng);
  });
}

/* ── Mobile detection ─────────────────────────────── */
function checkMobile() { isMobile.value = window.innerWidth <= 768; }

/* ── Lifecycle ────────────────────────────────────── */
onMounted(async () => {
  checkMobile();
  window.addEventListener("resize", checkMobile);
  await fetchAll();
  await nextTick();
  initMap();
  connectSSE();
});

onUnmounted(() => {
  window.removeEventListener("resize", checkMobile);
  if (controlInterval) clearInterval(controlInterval);
  if (eventSource) eventSource.close();
  if (map) {
    map.getContainer().removeEventListener("mousedown", onSelectionStart);
    map.remove();
  }
});
</script>

<template>
  <div class="map-layout">
    <div class="content">
      <div id="map" class="map"></div>

      <!-- Path pick overlay -->
      <div v-if="roverMode === 'path-pick'" class="map-overlay">지도에서 시작점을 클릭하세요</div>

      <!-- Desktop sidebar / Mobile bottom sheet -->
      <div :class="['panel', { 'sheet': isMobile, 'sheet-dragging': sheetDragging }]"
           :style="isMobile ? { height: sheetHeight + 'px' } : {}">
        <!-- Mobile sheet handle -->
        <div v-if="isMobile" class="sheet-handle"
             @touchstart="onSheetTouchStart" @touchmove="onSheetTouchMove" @touchend="onSheetTouchEnd">
          <div class="handle-bar"></div>
          <span class="handle-label">{{ activeCourse ? activeCourse.name : '코스 관리' }}</span>
        </div>

        <div class="panel-scroll">
          <!-- Courses -->
          <div class="panel-section">
            <h3>코스</h3>
            <div class="course-add">
              <input v-model="newCourseName" placeholder="새 코스" maxlength="100" @keyup.enter="createCourse" />
              <button class="btn btn-primary btn-sm" @click="createCourse" :disabled="!newCourseName.trim()">+</button>
              <label class="btn btn-ghost btn-sm import-btn" title="JSON 가져오기">
                ↑
                <input type="file" accept=".json" hidden @change="importCourse" />
              </label>
            </div>
            <div class="course-items">
              <div v-for="c in courses" :key="c.id" :class="['course-item', { active: c.id === activeCourseId }]">
                <button class="vis-btn" @click.stop="toggleVisibility(c.id)" :title="visibility[c.id] ? '숨기기' : '표시'">
                  <svg v-if="visibility[c.id]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                </button>
                <template v-if="editingCourseId === c.id">
                  <input v-model="editCourseName" class="course-name-input" @keyup.enter="saveCourseName(c.id)" @keyup.escape="editingCourseId = null" @click.stop />
                  <button class="btn btn-primary btn-sm" @click.stop="saveCourseName(c.id)">저장</button>
                </template>
                <template v-else>
                  <span class="course-name" @click="selectCourse(c.id)" @dblclick.stop="startEditCourse(c)">
                    {{ c.name }} <span class="cone-count">({{ c.cone_count }})</span>
                  </span>
                </template>
                <button class="dl-btn" @click.stop="exportCourse(c.id)" title="JSON 내보내기">↓</button>
                <button class="del-btn" @click.stop="deleteCourse(c.id)" title="삭제">×</button>
              </div>
              <div v-if="courses.length === 0" class="empty-msg">코스를 추가하세요.</div>
            </div>
          </div>

          <template v-if="activeCourse">
            <!-- Side toggle + Rover -->
            <div class="panel-section">
              <h3>콘 추가</h3>
              <div class="side-rover-row">
                <div class="side-toggle">
                  <button :class="['side-btn', { active: currentSide === 'left' }]" @click="currentSide = 'left'" style="--side-color: #8b5cf6">L</button>
                  <button :class="['side-btn', { active: currentSide === 'center' }]" @click="currentSide = 'center'" style="--side-color: #f59e0b">M</button>
                  <button :class="['side-btn', { active: currentSide === 'right' }]" @click="currentSide = 'right'" style="--side-color: #06b6d4">R</button>
                </div>
                <button class="btn btn-primary btn-sm rover-btn" @click="addConeFromRover" :disabled="roverLoading">
                  {{ roverLoading ? '수신중...' : '위치 수신' }}
                </button>
              </div>
            </div>

            <!-- Rover controls -->
            <div class="panel-section">
              <h3>로버 제어</h3>
              <div class="rover-controls">
                <button
                  :class="['btn', 'btn-sm', pathBtnClass]"
                  @click="onPathBtn"
                  :disabled="activeCones.length === 0 || roverMode === 'manual'"
                >{{ pathBtnLabel }}</button>
                <button
                  :class="['btn', 'btn-sm', roverMode === 'manual' ? 'btn-primary' : 'btn-ghost']"
                  @click="roverMode === 'manual' ? stopManualControl() : startManualControl()"
                >{{ roverMode === 'manual' ? '수동 종료' : '수동 제어' }}</button>
                <button class="btn estop-btn-inline" @click="emergencyStop">비상정지</button>
              </div>
              <div v-if="pathDistance > 0" class="path-info">
                예상 주행 거리: {{ pathDistance >= 1000 ? (pathDistance / 1000).toFixed(2) + ' km' : pathDistance.toFixed(1) + ' m' }}
              </div>

              <!-- Manual joystick -->
              <div v-if="roverMode === 'manual'" class="joystick-area">
                <div class="joystick-info">
                  T: {{ manualThrottle }} / S: {{ manualSteering }}
                </div>
                <div
                  class="joystick"
                  @pointerdown.prevent="onJoystickDown"
                  @pointermove.prevent="onJoystickMove"
                  @pointerup.prevent="onJoystickUp"
                  @pointercancel.prevent="onJoystickUp"
                >
                  <div class="joystick-bg">
                    <div class="joystick-crosshair"></div>
                    <div
                      class="joystick-knob"
                      :style="{
                        transform: `translate(${manualSteering * 0.82}px, ${-manualThrottle * 0.82}px)`
                      }"
                    ></div>
                  </div>
                  <div class="joystick-labels">
                    <span class="jl-up">▲</span>
                    <span class="jl-down">▼</span>
                    <span class="jl-left">◄</span>
                    <span class="jl-right">►</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Multi-select info -->
            <div v-if="multiSelectedIds.size > 0" class="panel-section edit-section">
              <h3>{{ multiSelectedIds.size }}개 콘 선택</h3>
              <div class="edit-buttons">
                <span class="multi-select-hint">드래그하여 이동</span>
                <button class="btn btn-ghost btn-sm" @click="clearMultiSelection">선택 해제</button>
              </div>
            </div>

            <!-- Cone edit -->
            <div v-if="selectedConeId && multiSelectedIds.size === 0" class="panel-section edit-section">
              <h3>콘 수정 (#{{ coneSideIndex(activeCourseId, selectedConeId) }})</h3>
              <div class="coord-inputs">
                <input v-model="editLat" type="number" step="any" placeholder="위도" />
                <input v-model="editLng" type="number" step="any" placeholder="경도" />
                <select v-model="editSide"><option value="left">L</option><option value="center">M</option><option value="right">R</option></select>
              </div>
              <div class="edit-buttons">
                <button class="btn btn-primary" @click="updateCone">저장</button>
                <button class="btn btn-danger" @click="deleteCone(selectedConeId)">삭제</button>
                <button class="btn btn-ghost" @click="selectedConeId = null">취소</button>
              </div>
            </div>

            <!-- Cone list -->
            <div class="panel-section cone-list-section">
              <div class="cone-list-header">
                <h3>콘 목록 ({{ filteredCones.length }})</h3>
                <div class="cone-filter">
                  <button :class="['filter-btn', { active: coneFilter === 'all' }]" @click="coneFilter = 'all'">전체</button>
                  <button :class="['filter-btn', { active: coneFilter === 'left' }]" @click="coneFilter = 'left'" :style="{ '--fc': SIDE_COLORS.left }">L</button>
                  <button :class="['filter-btn', { active: coneFilter === 'center' }]" @click="coneFilter = 'center'" :style="{ '--fc': SIDE_COLORS.center }">M</button>
                  <button :class="['filter-btn', { active: coneFilter === 'right' }]" @click="coneFilter = 'right'" :style="{ '--fc': SIDE_COLORS.right }">R</button>
                </div>
              </div>
              <div class="cone-list">
                <div
                  v-for="cone in filteredCones" :key="cone.id"
                  :data-cone-id="cone.id"
                  :class="['cone-item', { selected: selectedConeId === cone.id }]"
                  @click="panToCone(cone)"
                >
                  <span class="cone-num" :style="{ color: SIDE_COLORS[cone.side] }">#{{ coneSideIndex(activeCourseId, cone.id) }}</span>
                  <span class="cone-coords">{{ cone.lat.toFixed(6) }}, {{ cone.lng.toFixed(6) }}</span>
                  <button class="del-btn" @click.stop="deleteCone(cone.id)">×</button>
                </div>
                <div v-if="filteredCones.length === 0" class="empty-msg">콘이 없습니다.</div>
              </div>
            </div>
          </template>

          <div v-else class="panel-section"><p class="empty-msg">코스를 선택하세요.</p></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-layout { height: 100%; overflow: hidden; padding: 1.5rem; position: relative; }

.content {
  height: 100%; display: flex; overflow: hidden;
  border-radius: 12px; border: 1px solid var(--border-primary);
  position: relative;
}

.map { flex: 1; min-height: 0; z-index: 0; }

.map-overlay {
  position: absolute; top: 1rem; left: 50%; transform: translateX(-50%);
  background: rgba(0,0,0,0.75); color: #fff; padding: 0.5rem 1.25rem;
  border-radius: 8px; font-size: 0.9rem; font-weight: 500; z-index: 500;
  pointer-events: none;
}

/* Emergency stop inline */
.estop-btn-inline {
  background: #dc2626; color: #fff; border: none;
  font-size: 0.8rem; font-weight: 700;
  padding: 0.375rem 0.75rem; border-radius: 6px;
  cursor: pointer; box-shadow: 0 2px 8px rgba(220,38,38,0.4);
}
.estop-btn-inline:active { opacity: 0.8; }

/* Panel (desktop sidebar) */
.panel {
  width: 320px; flex-shrink: 0;
  background: var(--bg-primary);
  border-left: 1px solid var(--border-primary);
  display: flex; flex-direction: column;
  overflow: hidden;
}

.panel-scroll {
  flex: 1; overflow: hidden;
  display: flex; flex-direction: column;
}

.panel-section {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-primary);
}

.panel-section h3 {
  margin: 0 0 0.5rem; font-size: 0.9rem; font-weight: 700;
  color: var(--text-primary);
}

/* Course list */
.course-add { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }

.course-add input {
  flex: 1; min-width: 0; padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-primary); border-radius: 4px;
  background: var(--bg-secondary); color: var(--text-primary); font-size: 0.8rem;
}
.course-add input:focus { outline: none; border-color: var(--accent-primary); }

.course-items { display: flex; flex-direction: column; gap: 2px; }

.course-item {
  display: flex; align-items: center; gap: 0.375rem;
  padding: 0.375rem 0.25rem; border-radius: 4px;
  border: 1px solid transparent; transition: background 0.1s;
}
.course-item:hover { background: var(--bg-secondary); }
.course-item.active { background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-primary)); border-color: var(--accent-primary); }

.vis-btn {
  border: none; background: none; cursor: pointer;
  color: var(--text-secondary); padding: 2px;
  display: flex; align-items: center; flex-shrink: 0;
}
.vis-btn:hover { color: var(--text-primary); }

.course-name {
  flex: 1; font-size: 0.85rem; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-primary);
}
.cone-count { color: var(--text-secondary); font-size: 0.75rem; }

.course-name-input {
  flex: 1; padding: 0.25rem 0.375rem; font-size: 0.8rem;
  border: 1px solid var(--accent-primary); border-radius: 4px;
  background: var(--bg-secondary); color: var(--text-primary); min-width: 0;
}

.dl-btn, .del-btn {
  border: none; background: none; cursor: pointer;
  color: var(--text-secondary); font-size: 0.85rem; padding: 0 0.2rem;
  line-height: 1; flex-shrink: 0;
}
.dl-btn:hover { color: var(--accent-primary); }
.del-btn:hover { color: var(--accent-danger, #ef4444); }

.import-btn { cursor: pointer; }

/* Side + Rover row */
.side-rover-row { display: flex; gap: 0.5rem; align-items: stretch; }
.side-toggle { display: flex; gap: 0.25rem; flex: 1; }
.rover-btn { white-space: nowrap; }

.side-btn {
  flex: 1; padding: 0.375rem;
  border: 2px solid var(--border-primary); border-radius: 6px;
  background: var(--bg-secondary); color: var(--text-primary);
  cursor: pointer; font-size: 0.85rem; font-weight: 500; transition: all 0.15s;
}
.side-btn.active {
  border-color: var(--side-color);
  background: color-mix(in srgb, var(--side-color) 15%, var(--bg-secondary));
  font-weight: 600;
}

.btn-block { width: 100%; }

/* Rover controls */
.rover-controls { display: flex; flex-wrap: wrap; gap: 0.375rem; }

.path-info {
  margin-top: 0.5rem; padding: 0.375rem 0.5rem;
  background: var(--bg-secondary); border-radius: 6px;
  font-size: 0.8rem; color: var(--text-secondary);
  font-family: "JetBrains Mono", monospace;
}

/* Joystick */
.joystick-area { margin-top: 0.75rem; }

.joystick-info {
  text-align: center; font-family: "JetBrains Mono", monospace;
  font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 0.375rem;
}

.joystick {
  position: relative; width: 100%; aspect-ratio: 1;
  max-width: 200px; margin: 0 auto;
  touch-action: none; user-select: none;
}

.joystick-bg {
  position: absolute; inset: 0;
  background: var(--bg-secondary); border-radius: 50%;
  border: 2px solid var(--border-primary);
  display: flex; align-items: center; justify-content: center;
}

.joystick-crosshair {
  width: 1px; height: 100%; background: var(--border-primary);
  position: absolute;
}
.joystick-crosshair::after {
  content: ""; display: block;
  width: 100%; height: 1px; background: var(--border-primary);
  position: absolute; top: 50%; left: -9900%;
  width: 20000%;
}

.joystick-knob {
  width: 36px; height: 36px; border-radius: 50%;
  background: var(--accent-primary); opacity: 0.8;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  transition: transform 0.02s linear;
  position: relative; z-index: 1;
}

.joystick-labels {
  position: absolute; inset: 0; pointer-events: none;
  color: var(--text-secondary); font-size: 0.7rem;
}
.jl-up { position: absolute; top: 4px; left: 50%; transform: translateX(-50%); }
.jl-down { position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); }
.jl-left { position: absolute; left: 6px; top: 50%; transform: translateY(-50%); }
.jl-right { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); }

/* Cone edit */
.coord-inputs { display: flex; flex-direction: column; gap: 0.5rem; }

.coord-inputs input, .coord-inputs select {
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-primary); border-radius: 4px;
  background: var(--bg-secondary); color: var(--text-primary);
  font-size: 0.8rem; font-family: "JetBrains Mono", monospace;
}
.coord-inputs input:focus, .coord-inputs select:focus { outline: none; border-color: var(--accent-primary); }

.edit-buttons { display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center; }
.multi-select-hint { font-size: 0.8rem; color: var(--text-secondary); flex: 1; }
.edit-section { background: color-mix(in srgb, var(--accent-primary) 5%, var(--bg-primary)); }

/* Cone list */
.cone-list-section { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

.cone-list-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem; }
.cone-list-header h3 { margin: 0; }

.cone-filter { display: flex; gap: 0.25rem; }

.filter-btn {
  padding: 0.3rem 0.6rem; border: 1px solid var(--border-primary);
  border-radius: 6px; background: var(--bg-secondary);
  color: var(--text-secondary); cursor: pointer;
  font-size: 0.8rem; font-weight: 500; transition: all 0.15s;
}
.filter-btn.active {
  border-color: var(--fc, var(--accent-primary));
  color: var(--fc, var(--accent-primary));
  background: color-mix(in srgb, var(--fc, var(--accent-primary)) 10%, var(--bg-secondary));
  font-weight: 600;
}

.cone-list { flex: 1; overflow-y: auto; padding-bottom: 1rem; }

.cone-item {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.375rem 0.25rem; border-radius: 4px;
  cursor: pointer; transition: background 0.1s;
}
.cone-item:hover { background: var(--bg-secondary); }
.cone-item.selected { background: color-mix(in srgb, var(--accent-primary) 15%, var(--bg-primary)); }

.cone-num { font-size: 0.85rem; font-weight: 600; min-width: 2em; flex-shrink: 0; }

.cone-coords {
  flex: 1; font-family: "JetBrains Mono", monospace;
  font-size: 0.8rem; color: var(--text-primary);
}

.empty-msg { text-align: center; padding: 1rem 0; color: var(--text-secondary); font-size: 0.8rem; }

/* ── Mobile bottom sheet ───────────────────── */
@media (max-width: 768px) {
  .map-layout { padding: 0; }

  .content {
    border-radius: 0; border: none;
    position: relative;
  }

  .map { height: 100%; }

  .panel.sheet {
    position: fixed; bottom: 0; left: 0; right: 0;
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--border-primary);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -4px 20px rgba(0,0,0,0.15);
    transition: height 0.3s ease;
    z-index: 600;
  }

  .panel.sheet.sheet-dragging {
    transition: none;
  }

  .panel-scroll {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .cone-list-section { flex: none; overflow: visible; }
  .cone-list { overflow-y: visible; }

  .sheet-handle {
    display: flex; align-items: center; justify-content: center;
    gap: 0.5rem; padding: 0.5rem 1rem;
    cursor: pointer; flex-shrink: 0;
    flex-direction: column;
  }

  .handle-bar {
    width: 36px; height: 4px; border-radius: 2px;
    background: var(--text-secondary); opacity: 0.4;
  }

  .handle-label {
    font-size: 0.8rem; font-weight: 600; color: var(--text-primary);
  }

  .joystick { max-width: 160px; }
}

/* Desktop: hide sheet handle */
@media (min-width: 769px) {
  .sheet-handle { display: none; }
}
</style>

<style>
.selection-box {
  position: absolute;
  border: 2px dashed #38bdf8;
  background: rgba(56, 189, 248, 0.1);
  pointer-events: none;
  z-index: 1000;
}
.rover-tooltip {
  background: #a855f7; color: #fff; border: none;
  font-size: 11px; font-weight: 600; padding: 2px 6px;
  border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.rover-tooltip::before { border-top-color: #a855f7; }
</style>
