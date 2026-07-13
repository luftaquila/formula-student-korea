import { ref, onUnmounted } from "vue";
import L from "leaflet";
import { haversine } from "@lib/geo.mjs";

// Ruler / protractor measurement overlays for the course map, extracted from
// MapView. Owns its own toolMode/hint/result state + the Leaflet overlay layer.
// Deps injected by the view:
//   getMap()        -> the live Leaflet map (created after setup)
//   rebuildMarkers()-> re-render cone markers (drag is suspended while measuring)
//   isCoursesTab()  -> whether the courses tab is active (drag re-enable on exit)
//   clearOtherModes()-> drop rotate/select/multiselect so measuring is exclusive
// Taps are snapped to a cone by the caller (nearestCone) before handleMeasureClick.

// Local metric scale at a latitude — longitude degrees shrink by cos(lat), so a
// raw lat/lng angle/length would be skewed. Used for the protractor's true angle.
const M_PER_DEG_LAT = 111320;
function mPerDegLng(lat) { return M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180); }

// Angle (deg, 0–180) at `vertex` between the rays to `a` and `c`.
function angleAtVertex(vertex, a, c) {
  const mLng = mPerDegLng(vertex.lat);
  const v1 = { x: (a.lng - vertex.lng) * mLng, y: (a.lat - vertex.lat) * M_PER_DEG_LAT };
  const v2 = { x: (c.lng - vertex.lng) * mLng, y: (c.lat - vertex.lat) * M_PER_DEG_LAT };
  const m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
  if (m1 < 1e-9 || m2 < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (m1 * m2)));
  return Math.acos(cos) * 180 / Math.PI;
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(2)} m`;
}

export function useMeasureTools({ getMap, rebuildMarkers, isCoursesTab, clearOtherModes }) {
  const toolMode = ref("none");     // none | ruler | protractor
  const measureHint = ref("");      // next-step instruction for the active tool
  const measureResult = ref("");    // distance total / measured angle for the overlay
  let measureLayer = null;          // L.layerGroup holding the active tool's overlays
  let measurePoints = [];           // [L.latLng] taps collected for the active tool

  function enterToolMode(mode) {
    if (toolMode.value === mode) { exitToolMode(); return; }
    // Measuring is its own mode — drop any selection/rotation so its icons/handles don't distract.
    clearOtherModes();
    const map = getMap();
    toolMode.value = mode;
    if (!measureLayer) measureLayer = L.layerGroup();
    measureLayer.addTo(map);
    resetMeasure();
    rebuildMarkers(); // suspend per-cone drag while a tool is active
  }

  function exitToolMode() {
    if (toolMode.value === "none") return;
    toolMode.value = "none";
    measurePoints = [];
    const map = getMap();
    if (measureLayer) { measureLayer.clearLayers(); try { map.removeLayer(measureLayer); } catch {} }
    measureResult.value = "";
    measureHint.value = "";
    if (map && isCoursesTab()) rebuildMarkers();
  }

  function resetMeasure() {
    measurePoints = [];
    if (measureLayer) measureLayer.clearLayers();
    measureResult.value = "";
    updateMeasureHint();
  }

  function updateMeasureHint() {
    if (toolMode.value === "ruler") {
      measureHint.value = measurePoints.length === 0
        ? "콘을 차례로 탭해 거리를 잽니다."
        : "다음 콘을 탭하면 구간이 이어집니다.";
    } else if (toolMode.value === "protractor") {
      const steps = ["첫 번째 콘을 탭하세요.", "꼭짓점(가운데) 콘을 탭하세요.", "세 번째 콘을 탭하세요.", "측정 완료 — 탭하면 새로 시작합니다."];
      measureHint.value = steps[Math.min(measurePoints.length, 3)];
    } else {
      measureHint.value = "";
    }
  }

  function measureDot(latlng) {
    return L.marker(latlng, {
      icon: L.divIcon({ className: "", html: `<div class="measure-dot"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }),
      interactive: false, zIndexOffset: 1200,
    });
  }

  function measureLabel(latlng, text, cls) {
    return L.marker(latlng, {
      icon: L.divIcon({ className: "", html: `<div class="measure-label${cls ? " " + cls : ""}">${text}</div>`, iconSize: [0, 0] }),
      interactive: false, zIndexOffset: 1250,
    });
  }

  function handleMeasureClick(latlng) {
    if (toolMode.value === "ruler") handleRulerClick(latlng);
    else if (toolMode.value === "protractor") handleProtractorClick(latlng);
  }

  function handleRulerClick(latlng) {
    measurePoints.push(latlng);
    measureDot(latlng).addTo(measureLayer);
    const n = measurePoints.length;
    if (n >= 2) {
      const a = measurePoints[n - 2], b = measurePoints[n - 1];
      L.polyline([a, b], { color: "#22d3ee", weight: 3 }).addTo(measureLayer);
      const seg = haversine(a, b);
      measureLabel(L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2), fmtDist(seg)).addTo(measureLayer);
      let total = 0;
      for (let i = 1; i < measurePoints.length; i++) total += haversine(measurePoints[i - 1], measurePoints[i]);
      measureResult.value = n > 2 ? `구간 ${fmtDist(seg)} · 합계 ${fmtDist(total)}` : fmtDist(seg);
    }
    updateMeasureHint();
  }

  function handleProtractorClick(latlng) {
    if (measurePoints.length >= 3) resetMeasure(); // 4th tap starts a fresh measurement
    measurePoints.push(latlng);
    measureDot(latlng).addTo(measureLayer);
    if (measurePoints.length === 2) {
      L.polyline([measurePoints[0], measurePoints[1]], { color: "#f59e0b", weight: 3 }).addTo(measureLayer);
    } else if (measurePoints.length === 3) {
      const [a, b, c] = measurePoints; // b is the vertex
      L.polyline([b, c], { color: "#f59e0b", weight: 3 }).addTo(measureLayer);
      const ang = angleAtVertex(b, a, c);
      const { arc, labelAt } = angleArc(b, a, c);
      L.polyline(arc, { color: "#fbbf24", weight: 2 }).addTo(measureLayer);
      measureLabel(labelAt, `${ang.toFixed(1)}°`, "angle").addTo(measureLayer);
      measureResult.value = `∠ ${ang.toFixed(1)}°`;
    }
    updateMeasureHint();
  }

  // Arc swept from ray b→a to ray b→c (the short way, ≤180°) plus a label anchor
  // just outside it on the bisector, all in pixel space so it tracks the screen.
  function angleArc(vertex, a, c, radiusPx = 36) {
    const map = getMap();
    const vp = map.latLngToContainerPoint(vertex);
    const ap = map.latLngToContainerPoint(a);
    const cp = map.latLngToContainerPoint(c);
    const a1 = Math.atan2(ap.y - vp.y, ap.x - vp.x);
    const a2 = Math.atan2(cp.y - vp.y, cp.x - vp.x);
    let diff = a2 - a1;
    while (diff <= -Math.PI) diff += 2 * Math.PI;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    const steps = 28, arc = [];
    for (let i = 0; i <= steps; i++) {
      const ang = a1 + diff * (i / steps);
      arc.push(map.containerPointToLatLng(L.point(vp.x + radiusPx * Math.cos(ang), vp.y + radiusPx * Math.sin(ang))));
    }
    const bis = a1 + diff / 2;
    const labelAt = map.containerPointToLatLng(L.point(vp.x + (radiusPx + 22) * Math.cos(bis), vp.y + (radiusPx + 22) * Math.sin(bis)));
    return { arc, labelAt };
  }

  // The tool's overlay layer is removed on unmount (mirrors the view's old
  // onUnmounted cleanup of measureLayer).
  onUnmounted(() => {
    const map = getMap();
    if (measureLayer && map) { try { map.removeLayer(measureLayer); } catch {} }
  });

  return { toolMode, measureHint, measureResult, enterToolMode, exitToolMode, resetMeasure, handleMeasureClick };
}
