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
const CONE_FILTER_LABELS = { all: "전체", left: "L", center: "M", right: "R" };
const SIDE_LABELS = { left: "왼쪽", center: "가운데", right: "오른쪽" };
const coneFilterLabel = computed(() => CONE_FILTER_LABELS[coneFilter.value] || coneFilter.value);
const currentSideLabel = computed(() => SIDE_LABELS[currentSide.value] || "");

// Rail icon click just switches tabs; the inspector is always open.
// (We removed the click-to-collapse behaviour because it confused
//  operators who hit the current tab expecting a no-op and lost the
//  whole side panel.)
function onRailClick(key) {
  activeTab.value = key;
}

function hideLiveMapLayers() {
  if (!map) return;
  for (const m of Object.values(markers)) { try { map.removeLayer(m); } catch {} }
  if (roverMarker) { try { map.removeLayer(roverMarker); } catch {} }
  if (pathLine) { try { map.removeLayer(pathLine); } catch {} }
  if (pathStartMarker) { try { map.removeLayer(pathStartMarker); } catch {} }
  if (pathEndMarker) { try { map.removeLayer(pathEndMarker); } catch {} }
  for (const m of Object.values(sprayMarkers)) { try { map.removeLayer(m); } catch {} }
}
function restoreLiveMapLayers() {
  if (!map) return;
  rebuildAllMarkers();
  const lp = roverStatus.value.last_position;
  if (lp) updateRoverMarker(lp.lat, lp.lng);
  if (pathStart && pathWaypoints.value.length > 0) renderPath();
  renderSprayMarkers();
}

// NOTE: the tab-swap watch that swaps live ↔ mission map layers lives further
// down in this file, after `activeTab` is declared. Placing it here used to
// trip a TDZ because `activeTab` is a `const` defined below.
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
const resumeStartIdx = ref(0); // operator-chosen resume index (stopped mode)
const pathProgress = ref(0);
const pathDistance = ref(0);
const manualThrottle = ref(0);
const manualSteering = ref(0);

// Rover live status (from SSE rover:status event)
const roverStatus = ref({
  connected: false,
  last_position_at: 0,
  fix_status: null,
  nav_state: null,
  ntrip_connected: null,
  last_disconnect_reason: null,
  last_disconnect_at: 0,
  last_spray_result: null,
  battery: null,
  ntrip: null,
});
let manualFailCount = 0;

// sprayResults: Map<globalWaypointIdx, { outcome, at }>
const sprayResults = ref(new Map());
let sprayMarkers = {};

// Pre-flight checklist modal state
const showPreflight = ref(false);
const preflightForce = ref(false);
const preflightMode = ref("execute"); // "execute" | "resume"

const SPRAY_OUTCOME_SYMBOL = { success: "✓", cancelled: "⚠", timeout: "✕" };
const SPRAY_OUTCOME_COLOR = { success: "#22c55e", cancelled: "#f59e0b", timeout: "#ef4444" };

const DISCONNECT_REASON_LABEL = {
  sse_closed: "SSE 끊김",
  write_failed: "전송 실패",
  replaced: "다른 세션으로 교체됨",
};

const BATTERY_WARN_PERCENT = 30;
const BATTERY_CRIT_PERCENT = 20;

// Tick ref — bumps every second so time-ago computeds recalc even when no
// new SSE event arrives (otherwise "pos 0s" stays stale when the rover stops).
const uiTick = ref(0);
let uiTickInterval = null;

// Recent position history (for avg speed / ETA). Plain array + a bump ref so
// computeds depending on it get retriggered without making the list reactive.
const recentPositions = [];
const recentPositionsBump = ref(0);
function pushRecentPosition(lat, lng) {
  const now = Date.now();
  recentPositions.push({ lat, lng, t: now });
  const cutoff = now - 30000;
  while (recentPositions.length > 0 && recentPositions[0].t < cutoff) {
    recentPositions.shift();
  }
  recentPositionsBump.value += 1;
}

const avgSpeedMs = computed(() => {
  recentPositionsBump.value; // track
  if (recentPositions.length < 2) return null;
  const first = recentPositions[0];
  const last = recentPositions[recentPositions.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt < 0.5) return null;
  let dist = 0;
  for (let i = 1; i < recentPositions.length; i++) {
    dist += haversine(recentPositions[i - 1], recentPositions[i]);
  }
  return dist / dt;
});

// Distance from rover's last reported position to the next-target waypoint.
// Only meaningful while a mission is actually being driven.
const currentTargetDistance = computed(() => {
  if (roverMode.value !== "executing") return null;
  const idx = executedIndex.value;
  if (idx < 0 || idx >= pathWaypoints.value.length) return null;
  const lp = roverStatus.value.last_position;
  if (!lp) return null;
  return haversine(lp, pathWaypoints.value[idx]);
});

function formatDurationSec(secs) {
  if (!isFinite(secs) || secs < 1) return null;
  if (secs < 60) return `~${Math.round(secs)}초`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s === 0 ? `~${m}분` : `~${m}분 ${s}초`;
}

const missionETA = computed(() => {
  if (roverMode.value !== "executing") return null;
  if (pathTotalDist <= 0) return null;
  const speed = avgSpeedMs.value;
  if (!speed || speed < 0.05) return null;
  const remaining = pathTotalDist * Math.max(0, (100 - pathProgress.value) / 100);
  return formatDurationSec(remaining / speed);
});

// Per-chip computeds. Each chip owns its own tone (ok/warn/bad/neutral) so
// the strip's overall color band is decided separately (primary class).
// `detail` is the multi-line text shown in the hover/click popover.
const fixChip = computed(() => {
  const s = roverStatus.value;
  if (!s.connected || !s.fix_status) return null;
  const label = s.fix_status.replace(/_/g, " ").toUpperCase();
  const tone = s.fix_status === "rtk_fixed" ? "ok"
    : s.fix_status === "rtk_float" ? "warn"
    : "bad";
  const rows = [["모드", label]];
  if (lastPositionAge.value != null) rows.push(["갱신", `${lastPositionAge.value}s 전`]);
  return { label, tone, rows };
});

const navChip = computed(() => {
  const s = roverStatus.value;
  if (!s.connected || !s.nav_state) return null;
  const dist = currentTargetDistance.value;
  const label = (dist != null && dist < 50)
    ? `${s.nav_state} · #${executedIndex.value + 1} → ${dist.toFixed(1)}m`
    : s.nav_state;
  const tone = (s.nav_state === "ERROR" || s.nav_state === "EMERGENCY_STOP") ? "bad"
    : s.nav_state === "IDLE" ? "neutral"
    : "ok";
  const rows = [["상태", s.nav_state]];
  if (dist != null) rows.push(["다음", `#${executedIndex.value + 1} · ${dist.toFixed(1)} m`]);
  return { label, tone, rows };
});

const batteryChip = computed(() => {
  const s = roverStatus.value;
  if (!s.connected || !s.battery || s.battery.percent == null) return null;
  const p = s.battery.percent;
  const tone = p <= BATTERY_CRIT_PERCENT ? "bad"
    : p <= BATTERY_WARN_PERCENT ? "warn"
    : "ok";
  const rows = [["잔량", `${p}%`]];
  if (s.battery.voltage != null) rows.push(["전압", `${s.battery.voltage.toFixed(2)} V`]);
  if (s.battery.voltage_raw != null && s.battery.gain != null && Math.abs(s.battery.gain - 1.0) > 1e-4) {
    rows.push(["원시", `${s.battery.voltage_raw.toFixed(2)} V`]);
  }
  if (s.battery.gain != null) rows.push(["게인", s.battery.gain.toFixed(4)]);
  if (s.battery.calibrated_at) {
    const ago = Math.max(0, Math.round((Date.now() - s.battery.calibrated_at) / 60000));
    rows.push(["보정", ago < 1 ? "방금" : ago < 60 ? `${ago}분 전` : `${Math.round(ago / 60)}시간 전`]);
  }
  if (s.battery.source) rows.push(["측정", s.battery.source]);
  return { percent: p, voltage: s.battery.voltage, tone, rows };
});

const ntripChip = computed(() => {
  // Only surface NTRIP when it's actually streaming corrections — a
  // generic "off" chip just adds noise (the GPS fix chip already
  // signals when the rover is running unaided).
  const s = roverStatus.value;
  if (!s.connected || !s.ntrip_connected) return null;
  const mp = s.ntrip?.mountpoint;
  const rows = [];
  if (s.ntrip?.host) rows.push(["Caster", `${s.ntrip.host}${s.ntrip.port ? `:${s.ntrip.port}` : ""}`]);
  if (mp) rows.push(["Mount", mp]);
  if (ntripCorrectionAge.value != null) rows.push(["보정", `${ntripCorrectionAge.value}s 전`]);
  if (s.ntrip?.fail_count) rows.push(["재시도", `${s.ntrip.fail_count}회`]);
  if (s.ntrip?.last_error) rows.push(["오류", s.ntrip.last_error]);
  return { label: mp ? `📡 ${mp}` : "📡 ok", tone: "ok", rows };
});

const posChip = computed(() => {
  uiTick.value; // retrigger every second
  const s = roverStatus.value;
  if (!s.connected || !s.last_position_at) return null;
  const ago = Math.max(0, Math.round((Date.now() - s.last_position_at) / 1000));
  const tone = ago <= 5 ? "ok" : ago <= 15 ? "warn" : "bad";
  const rows = [["갱신", `${ago}s 전`]];
  if (s.last_position) rows.push(["좌표", `${s.last_position.lat?.toFixed(6)}, ${s.last_position.lng?.toFixed(6)}`]);
  return { ago, tone, rows };
});

const missionChip = computed(() => {
  if (roverMode.value !== "executing" && roverMode.value !== "stopped") return null;
  if (pathWaypoints.value.length === 0) return null;
  const lines = [
    `미션 진행: ${executedIndex.value} / ${pathWaypoints.value.length} (${pathProgress.value}%)`,
  ];
  if (remainingDistanceM.value != null) {
    lines.push(`남은 거리: ${remainingDistanceM.value >= 1000
      ? (remainingDistanceM.value / 1000).toFixed(2) + " km"
      : remainingDistanceM.value.toFixed(1) + " m"}`);
  }
  if (missionETA.value) lines.push(`예상 완료: ${missionETA.value} 후`);
  if (avgSpeedMs.value != null) lines.push(`최근 10초 평균 속도: ${avgSpeedMs.value.toFixed(2)} m/s`);
  return {
    current: executedIndex.value,
    total: pathWaypoints.value.length,
    percent: pathProgress.value,
    eta: missionETA.value,
    detail: lines.join("\n"),
  };
});

// Which chip is currently showing its popover via click (mobile-friendly).
// Hover handles desktop via :hover; click adds a sticky toggle for touch.
const activeChipPopover = ref(null);
function toggleChipPopover(key) {
  activeChipPopover.value = activeChipPopover.value === key ? null : key;
}
// Dismiss popover on outside click or Esc.
function onGlobalClickForChips(e) {
  if (!e.target.closest(".chip-wrapper")) activeChipPopover.value = null;
}
function onGlobalKeyForChips(e) {
  if (e.key === "Escape") activeChipPopover.value = null;
}

const disconnectInfo = computed(() => {
  uiTick.value;
  const s = roverStatus.value;
  if (s.connected) return null;
  const label = DISCONNECT_REASON_LABEL[s.last_disconnect_reason] || s.last_disconnect_reason || "원인 미상";
  let ago = null;
  if (s.last_disconnect_at) {
    const sec = Math.max(0, Math.round((Date.now() - s.last_disconnect_at) / 1000));
    if (sec < 60) ago = `${sec}초 전`;
    else {
      const m = Math.floor(sec / 60);
      const rs = sec % 60;
      ago = rs === 0 ? `${m}분 전` : `${m}분 ${rs}초 전`;
    }
  }
  return { label, ago };
});

// Expanded detail panel

const ntripCorrectionAge = computed(() => {
  uiTick.value;
  const n = roverStatus.value.ntrip;
  if (!n?.last_correction_at) return null;
  return Math.max(0, Math.round(Date.now() / 1000 - n.last_correction_at));
});

const lastPositionAge = computed(() => {
  uiTick.value;
  const at = roverStatus.value.last_position_at;
  if (!at) return null;
  return Math.max(0, Math.round((Date.now() - at) / 1000));
});

const remainingDistanceM = computed(() => {
  if (roverMode.value !== "executing") return null;
  if (pathTotalDist <= 0) return null;
  return pathTotalDist * Math.max(0, (100 - pathProgress.value) / 100);
});

const roverStatusClass = computed(() => {
  const s = roverStatus.value;
  if (!s.connected) return "rover-badge-off";
  const lowBattery = s.battery && s.battery.percent != null && s.battery.percent <= BATTERY_WARN_PERCENT;
  if (lowBattery) return "rover-badge-warn";
  if (s.fix_status === "rtk_fixed" && s.ntrip_connected !== false) return "rover-badge-ok";
  return "rover-badge-warn";
});

// Inspector (desktop right panel)
const INSPECTOR_TABS = [
  { key: "courses", label: "코스", icon: "📋" },
  { key: "cones", label: "콘", icon: "🔶" },
  { key: "rover", label: "로버", icon: "🚗" },
  { key: "logs", label: "로그", icon: "📜" },
  { key: "missions", label: "이력", icon: "📊" },
];

// Mission history state (integrated into this view so the same map + rail +
// inspector structure serves both the live operation and replay).
const missions = ref([]);
const missionTotal = ref(0);
const missionPage = 50;
const selectedMissionId = ref(null);
const missionDetail = ref(null);
const missionSamples = ref([]);
const missionLoading = ref(false);
const missionLoadingMore = ref(false);
const replayPlaying = ref(false);
const replayIdx = ref(0);
const replaySpeed = ref(1);
let playTimer = null;

const MISSION_STATUS_LABEL = { running: "진행 중", completed: "완료", stopped: "정지됨", error: "오류" };
const MISSION_STATUS_COLOR = { running: "#3b82f6", completed: "#22c55e", stopped: "#f59e0b", error: "#ef4444" };

function formatMissionDuration(started, ended) {
  if (!ended) return "—";
  const s = Math.round((ended - started) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function formatMissionTimestamp(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ko-KR", { hour12: false });
}

async function loadMissions() {
  missionLoading.value = true;
  try {
    const res = await request(`/api/missions?limit=${missionPage}&offset=0`);
    const data = await res.json();
    missions.value = data.missions || [];
    missionTotal.value = data.total || 0;
  } catch (err) { alert(err.message); }
  finally { missionLoading.value = false; }
}
async function loadMoreMissions() {
  if (missionLoadingMore.value || missions.value.length >= missionTotal.value) return;
  missionLoadingMore.value = true;
  try {
    const res = await request(`/api/missions?limit=${missionPage}&offset=${missions.value.length}`);
    const data = await res.json();
    missions.value = [...missions.value, ...(data.missions || [])];
    missionTotal.value = data.total || missions.value.length;
  } catch (err) { alert(err.message); }
  finally { missionLoadingMore.value = false; }
}

async function selectMission(id) {
  if (selectedMissionId.value === id) return;
  selectedMissionId.value = id;
  stopReplay();
  try {
    const [d, t] = await Promise.all([
      request(`/api/missions/${id}`).then((r) => r.json()),
      request(`/api/missions/${id}/telemetry`).then((r) => r.json()),
    ]);
    missionDetail.value = d;
    missionSamples.value = t.samples || [];
    replayIdx.value = 0;
    renderMissionMap();
  } catch (err) { alert(err.message); }
}

// Mission map layers — kept separate from the live cone/rover layers so
// switching tabs is a clean swap instead of overlapping paint.
let missionPlannedMarkers = [];
let missionPlannedPath = null;
let missionActualPath = null;
let missionReplayMarker = null;

function clearMissionMap() {
  if (!map) return;
  for (const m of missionPlannedMarkers) { try { map.removeLayer(m); } catch {} }
  missionPlannedMarkers = [];
  if (missionPlannedPath) { try { map.removeLayer(missionPlannedPath); } catch {} missionPlannedPath = null; }
  if (missionActualPath) { try { map.removeLayer(missionActualPath); } catch {} missionActualPath = null; }
  if (missionReplayMarker) { try { map.removeLayer(missionReplayMarker); } catch {} missionReplayMarker = null; }
}

function renderMissionMap() {
  if (!map || !missionDetail.value) return;
  clearMissionMap();

  const waypoints = missionDetail.value.waypoints || [];
  waypoints.forEach((wp, i) => {
    const marker = L.marker([wp.lat, wp.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:22px;height:22px;border-radius:50%;background:#8b5cf6;border:2px solid #fff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,0.4);">${i + 1}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
      }),
      interactive: false,
    }).addTo(map);
    missionPlannedMarkers.push(marker);
  });
  if (waypoints.length > 0) {
    missionPlannedPath = L.polyline(waypoints.map((w) => [w.lat, w.lng]), {
      color: "#8b5cf6", weight: 2, dashArray: "6 4", opacity: 0.75,
    }).addTo(map);
  }

  const validSamples = missionSamples.value.filter((s) => s.lat != null && s.lng != null);
  if (validSamples.length >= 2) {
    missionActualPath = L.polyline(validSamples.map((s) => [s.lat, s.lng]), {
      color: "#ef4444", weight: 3, opacity: 0.9,
    }).addTo(map);
  }

  const allPoints = [
    ...waypoints.map((w) => [w.lat, w.lng]),
    ...validSamples.map((s) => [s.lat, s.lng]),
  ];
  if (allPoints.length > 0) {
    map.fitBounds(L.latLngBounds(allPoints), { padding: [40, 40] });
  }
  updateReplayMarker();
}

function updateReplayMarker() {
  if (!map || missionSamples.value.length === 0) return;
  const s = missionSamples.value[replayIdx.value];
  if (!s || s.lat == null) {
    if (missionReplayMarker) { map.removeLayer(missionReplayMarker); missionReplayMarker = null; }
    return;
  }
  const color = s.nav_state === "ERROR" ? "#ef4444"
    : s.nav_state === "SPRAYING" ? "#f59e0b"
    : "#22c55e";
  if (missionReplayMarker) {
    missionReplayMarker.setLatLng([s.lat, s.lng]);
  } else {
    missionReplayMarker = L.marker([s.lat, s.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 2px ${color};"></div>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      }),
      interactive: false, zIndexOffset: 1000,
    }).addTo(map);
  }
}

watch(replayIdx, updateReplayMarker);

function scheduleReplayStep() {
  const i = replayIdx.value;
  if (i >= missionSamples.value.length - 1) { stopReplay(); return; }
  const dt = Math.max(0, (missionSamples.value[i + 1].t || 0) - (missionSamples.value[i].t || 0));
  const interval = Math.max(16, Math.min(2000, dt / Math.max(1, replaySpeed.value)));
  playTimer = setTimeout(() => {
    if (!replayPlaying.value) return;
    replayIdx.value = Math.min(missionSamples.value.length - 1, replayIdx.value + 1);
    scheduleReplayStep();
  }, interval);
}
function startReplay() {
  if (missionSamples.value.length === 0) return;
  if (replayIdx.value >= missionSamples.value.length - 1) replayIdx.value = 0;
  replayPlaying.value = true;
  scheduleReplayStep();
}
function stopReplay() {
  replayPlaying.value = false;
  if (playTimer) { clearTimeout(playTimer); playTimer = null; }
}
function togglePlay() { if (replayPlaying.value) stopReplay(); else startReplay(); }

const currentSampleTime = computed(() => {
  const s = missionSamples.value[replayIdx.value];
  return s ? formatMissionTimestamp(s.t) : "—";
});
const currentSampleState = computed(() => missionSamples.value[replayIdx.value]?.nav_state || "—");
const currentSampleFix = computed(() => missionSamples.value[replayIdx.value]?.fix_status || "—");
const activeTab = ref(loadPref("activeTab", "courses"));
// Inspector is always open now; keep the ref as a fixed `false` so any
// remaining template references compile, but stop persisting it.
const inspectorCollapsed = ref(false);
const inspectorWidth = ref(Math.max(280, Math.min(Number(loadPref("inspectorWidth", 360, Number)), 600)));
const inspectorResizing = ref(false);

function loadPref(key, fallback, parse = (x) => x) {
  try {
    const raw = localStorage.getItem(`mapview.${key}`);
    if (raw === null) return fallback;
    return parse(raw);
  } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(`mapview.${key}`, String(value)); } catch {}
}

watch(activeTab, (v) => savePref("activeTab", v));
watch(inspectorWidth, (v) => savePref("inspectorWidth", v));
// Clear any stale collapsed pref a user might have saved from the
// previous behaviour, so the inspector always starts open.
try { localStorage.removeItem("inspectorCollapsed"); } catch {}

// Tab-swap: hide live layers when entering missions, tear down replay state
// and restore the live view when leaving. Relies on `activeTab` being already
// declared just above (don't move this block up — TDZ).
watch(activeTab, (next, prev) => {
  if (next === prev || !map) return;
  if (prev === "missions") {
    stopReplay();
    clearMissionMap();
    selectedMissionId.value = null;
    missionDetail.value = null;
    missionSamples.value = [];
    restoreLiveMapLayers();
  }
  if (next === "missions") {
    hideLiveMapLayers();
    loadMissions();
  }
});

// Inspector drag-to-resize. Works for mouse and touch via Pointer Events.
let resizePointerId = null;
let resizeStartX = 0;
let resizeStartW = 360;

function onInspectorResizeStart(e) {
  resizePointerId = e.pointerId;
  resizeStartX = e.clientX;
  resizeStartW = inspectorWidth.value;
  inspectorResizing.value = true;
  e.target.setPointerCapture(e.pointerId);
  e.preventDefault();
}
function onInspectorResizeMove(e) {
  if (e.pointerId !== resizePointerId) return;
  const dx = resizeStartX - e.clientX; // drag handle is on the left edge of inspector
  inspectorWidth.value = Math.max(280, Math.min(600, resizeStartW + dx));
}
function onInspectorResizeEnd(e) {
  if (e.pointerId !== resizePointerId) return;
  resizePointerId = null;
  inspectorResizing.value = false;
}

// Mobile bottom sheet (narrow viewports) — rail becomes a bottom tab bar.
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
let pathStart = null; // { lat, lng } — preserved across compute/execute/resume for re-rendering
let pathCumDist = []; // cumulative distance to each waypoint from start (length = pathWaypoints.value.length)
let pathTotalDist = 0; // total distance including return-to-start segment
let executionStartIdx = 0; // global waypoint index the current execute/resume call started from
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
// Tracks which check keys flipped recently — used to flash the row so the
// operator notices RTK/NTRIP degrading mid-modal instead of acting on stale info.
const preflightFlash = ref({});

// Pre-flight checklist derived from current rover state + planned path.
const preflightChecks = computed(() => {
  const s = roverStatus.value;
  const first = pathWaypoints.value[0];
  const firstDist = first && s.last_position
    ? haversine({ lat: s.last_position.lat, lng: s.last_position.lng }, first)
    : null;
  const batteryOk = !s.battery || s.battery.percent == null || s.battery.percent > BATTERY_WARN_PERCENT;
  return [
    { key: "connected", label: "로버 SSE 연결", ok: !!s.connected },
    { key: "fix", label: "RTK Fixed GPS", ok: s.fix_status === "rtk_fixed",
      detail: s.fix_status ? s.fix_status.replace(/_/g, " ").toUpperCase() : "알 수 없음" },
    { key: "ntrip", label: "NTRIP 연결", ok: s.ntrip_connected === true,
      detail: (() => {
        if (s.ntrip_connected === null) return "알 수 없음";
        const caster = s.ntrip?.host ? `${s.ntrip.host}${s.ntrip.mountpoint ? '/' + s.ntrip.mountpoint : ''}` : null;
        if (s.ntrip_connected) return caster ? `${caster} · ok` : "ok";
        const retry = s.ntrip?.fail_count ? ` · 재시도 ${s.ntrip.fail_count}` : "";
        return caster ? `${caster} · off${retry}` : `off${retry}`;
      })() },
    { key: "firstwp", label: "첫 웨이포인트 거리", ok: firstDist != null && firstDist < 5,
      detail: firstDist != null ? `${firstDist.toFixed(1)} m` : "위치 미수신" },
    { key: "battery", label: "배터리", ok: batteryOk,
      detail: s.battery && s.battery.percent != null ? `${s.battery.percent}%` : "미수신" },
  ];
});
const preflightAllOk = computed(() => preflightChecks.value.every((c) => c.ok));

// Flash a check row when it changes ok-state during an open modal so the
// operator sees the transition even if they're focused on the button.
let lastPreflightOk = {};
watch(preflightChecks, (next) => {
  if (!showPreflight.value) {
    lastPreflightOk = Object.fromEntries(next.map((c) => [c.key, c.ok]));
    return;
  }
  const flashes = {};
  for (const c of next) {
    const prev = lastPreflightOk[c.key];
    if (prev !== undefined && prev !== c.ok) flashes[c.key] = Date.now();
  }
  lastPreflightOk = Object.fromEntries(next.map((c) => [c.key, c.ok]));
  if (Object.keys(flashes).length > 0) {
    preflightFlash.value = { ...preflightFlash.value, ...flashes };
    // Clear the flash class after the animation completes so a second
    // transition can re-trigger it.
    setTimeout(() => {
      const stale = Date.now() - 1200;
      preflightFlash.value = Object.fromEntries(
        Object.entries(preflightFlash.value).filter(([, at]) => at > stale)
      );
    }, 1300);
  }
}, { deep: true });

watch(showPreflight, (open) => {
  if (open) {
    lastPreflightOk = Object.fromEntries(preflightChecks.value.map((c) => [c.key, c.ok]));
    preflightFlash.value = {};
  }
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
  nextTick(() => {
    const el = document.querySelector(`.course-item.editing .course-name-input`);
    if (el) { el.focus(); el.select(); }
  });
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

/* ── Battery calibration ──────────────────────────── */
const showBatteryCal = ref(false);
const batteryCalInput = ref("");
const batteryCalSubmitting = ref(false);

function openBatteryCal() {
  // Pre-fill with the current corrected voltage as a sane starting point —
  // operator only has to nudge the digits to match the multimeter.
  const v = roverStatus.value.battery?.voltage;
  batteryCalInput.value = (typeof v === "number") ? v.toFixed(2) : "";
  showBatteryCal.value = true;
  activeChipPopover.value = null;
}

async function submitBatteryCal() {
  const measured_v = Number(batteryCalInput.value);
  if (!Number.isFinite(measured_v) || measured_v < 15 || measured_v > 32) {
    alert("측정값은 15~32 V 범위 안의 숫자여야 합니다.");
    return;
  }
  batteryCalSubmitting.value = true;
  try {
    await request("/api/rover/calibrate-battery", {
      method: "POST",
      body: JSON.stringify({ measured_v }),
    });
    showBatteryCal.value = false;
  } catch (err) {
    alert(err.message);
  } finally {
    batteryCalSubmitting.value = false;
  }
}

/* ── Rover log viewer ─────────────────────────────── */
const showLogs = ref(false);
const logEntries = ref([]);
const logUploadedAt = ref(0);
const logFetching = ref(false);

async function openLogs() {
  showLogs.value = true;
  await refreshLogs();
}

async function refreshLogs() {
  try {
    const res = await request("/api/rover/logs");
    const data = await res.json();
    logEntries.value = data.entries || [];
    logUploadedAt.value = data.uploaded_at || 0;
  } catch (err) { alert(err.message); }
}

async function requestLogs() {
  logFetching.value = true;
  try {
    await request("/api/rover/logs/fetch", { method: "POST" });
    // Wait briefly for rover to upload, then refresh.
    setTimeout(async () => {
      await refreshLogs();
      logFetching.value = false;
    }, 1500);
  } catch (err) {
    logFetching.value = false;
    alert(err.message);
  }
}

function formatLogTime(ms) {
  if (!ms) return "—";
  // ko-KR locale already produces "YYYY. M. D. 오전/오후 H:MM:SS"
  // — match the OS default rather than rebuilding it by hand.
  return new Date(ms).toLocaleString("ko-KR");
}

function downloadLogs() {
  const text = logEntries.value
    .map((e) => `${formatLogTime(e.t)} [${e.level}] [${e.node}] ${e.msg}`)
    .join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rover-log-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Snapshots ────────────────────────────────────── */
const showSnapshots = ref(false);
const snapshotList = ref([]);
const snapshotReason = ref("");

async function openSnapshots() {
  if (!activeCourseId.value) return;
  snapshotReason.value = "";
  showSnapshots.value = true;
  await loadSnapshots();
}

async function loadSnapshots() {
  if (!activeCourseId.value) return;
  try {
    const res = await request(`/api/courses/${activeCourseId.value}/snapshots`);
    const data = await res.json();
    snapshotList.value = data.snapshots || [];
  } catch (err) { alert(err.message); }
}

async function createSnapshot() {
  if (!activeCourseId.value) return;
  try {
    await request(`/api/courses/${activeCourseId.value}/snapshots`, {
      method: "POST",
      body: JSON.stringify({ reason: snapshotReason.value || null }),
    });
    snapshotReason.value = "";
    await loadSnapshots();
  } catch (err) { alert(err.message); }
}

async function restoreSnapshot(sid) {
  if (!activeCourseId.value) return;
  if (!confirm("현재 콘을 모두 지우고 이 스냅샷 상태로 되돌립니다. 계속하시겠습니까?\n(되돌리기 직전 상태가 자동으로 스냅샷됩니다.)")) return;
  try {
    await request(`/api/courses/${activeCourseId.value}/snapshots/${sid}/restore`, { method: "POST" });
    await loadSnapshots();
    showSnapshots.value = false;
  } catch (err) { alert(err.message); }
}

function formatSnapshotTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ko-KR", { hour12: false });
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

  pathStart = { lat: startLat, lng: startLng };
  pathWaypoints.value = optimized;
  renderPath();

  roverMode.value = "path-ready";
}

function renderPath() {
  if (!map || !pathStart || pathWaypoints.value.length === 0) return;

  // Cumulative distance from start to each waypoint + total (including return-to-start)
  pathCumDist = new Array(pathWaypoints.value.length);
  let acc = haversine(pathStart, pathWaypoints.value[0]);
  pathCumDist[0] = acc;
  for (let i = 1; i < pathWaypoints.value.length; i++) {
    acc += haversine(pathWaypoints.value[i - 1], pathWaypoints.value[i]);
    pathCumDist[i] = acc;
  }
  pathTotalDist = acc + haversine(pathWaypoints.value[pathWaypoints.value.length - 1], pathStart);
  pathDistance.value = pathTotalDist;

  if (pathLine) map.removeLayer(pathLine);
  if (pathStartMarker) map.removeLayer(pathStartMarker);
  if (pathEndMarker) map.removeLayer(pathEndMarker);

  const fullPath = [pathStart, ...pathWaypoints.value, pathStart];
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

  const first = pathWaypoints.value[0];
  pathStartMarker = pathLabel("S", [first.lat, first.lng], "#22c55e").addTo(map);
  pathEndMarker = pathLabel("E", [pathStart.lat, pathStart.lng], "#ef4444").addTo(map);
}

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

function moveWaypoint(idx, delta) {
  const target = idx + delta;
  if (target < 0 || target >= pathWaypoints.value.length) return;
  const next = [...pathWaypoints.value];
  [next[idx], next[target]] = [next[target], next[idx]];
  pathWaypoints.value = next;
  renderPath();
}

function clearPath() {
  if (pathLine) { map.removeLayer(pathLine); pathLine = null; }
  if (pathStartMarker) { map.removeLayer(pathStartMarker); pathStartMarker = null; }
  if (pathEndMarker) { map.removeLayer(pathEndMarker); pathEndMarker = null; }
  pathStart = null;
  pathWaypoints.value = [];
  pathCumDist = [];
  pathTotalDist = 0;
  executionStartIdx = 0;
  executedIndex.value = 0;
  resumeStartIdx.value = 0;
  pathProgress.value = 0;
  pathDistance.value = 0;
  clearSprayMarkers();
  if (roverMode.value !== "manual") roverMode.value = "none";
}

function onPathBtn() {
  if (roverMode.value === "executing") return; // 실행 중에는 무시
  if (roverMode.value === "stopped") { openPreflight("resume"); return; }
  if (roverMode.value === "path-ready") { openPreflight("execute"); return; }
  if (roverMode.value === "path-pick") { clearPath(); return; }
  if (roverMode.value === "none") { startPathPick(); }
}

function openPreflight(mode) {
  preflightMode.value = mode;
  preflightForce.value = false;
  showPreflight.value = true;
}

function cancelPreflight() {
  showPreflight.value = false;
}

async function confirmPreflight() {
  const force = preflightForce.value && !preflightAllOk.value;
  showPreflight.value = false;
  if (preflightMode.value === "resume") {
    await resumePath({ force });
  } else {
    await executePath({ force });
  }
}

async function executePath(opts = {}) {
  if (pathWaypoints.value.length === 0) return;
  executedIndex.value = 0;
  executionStartIdx = 0;
  pathProgress.value = 0;
  clearSprayMarkers();
  roverMode.value = "executing";
  try {
    const res = await request("/api/rover/execute", {
      method: "POST",
      body: JSON.stringify({ waypoints: pathWaypoints.value, force: !!opts.force }),
    });
    const data = await res.json();
    if (Array.isArray(data.waypoints) && data.waypoints.length !== pathWaypoints.value.length) {
      pathWaypoints.value = data.waypoints;
      renderPath();
    }
  } catch (err) {
    roverMode.value = "path-ready";
    alert(err.message);
  }
}

async function resumePath(opts = {}) {
  const startIdx = Math.max(0, Math.min(resumeStartIdx.value, pathWaypoints.value.length));
  const prefix = pathWaypoints.value.slice(0, startIdx);
  const remaining = pathWaypoints.value.slice(startIdx);
  if (remaining.length === 0) { clearPath(); return; }
  executionStartIdx = startIdx;
  executedIndex.value = startIdx;
  roverMode.value = "executing";
  try {
    const res = await request("/api/rover/execute", {
      method: "POST",
      body: JSON.stringify({ waypoints: remaining, force: !!opts.force }),
    });
    const data = await res.json();
    if (Array.isArray(data.waypoints) && data.waypoints.length !== remaining.length) {
      pathWaypoints.value = [...prefix, ...data.waypoints];
      renderPath();
    }
  } catch (err) {
    roverMode.value = "stopped";
    alert(err.message);
  }
}

function updatePathProgress(lat, lng) {
  if (pathWaypoints.value.length === 0 || pathTotalDist === 0) return;
  // Interpolate progress using cumulative segment distance. executedIndex is
  // advanced monotonically by the rover:waypoint SSE event, never by proximity.
  const idx = executedIndex.value;
  const prevPoint = idx === 0 ? pathStart : pathWaypoints.value[idx - 1];
  const prevCum = idx === 0 ? 0 : pathCumDist[idx - 1];
  const nextPoint = idx < pathWaypoints.value.length ? pathWaypoints.value[idx] : pathStart;
  const segLen = haversine(prevPoint, nextPoint);
  const traversed = segLen > 0 ? Math.min(segLen, haversine(prevPoint, { lat, lng })) : 0;
  const walked = prevCum + traversed;
  pathProgress.value = Math.min(100, Math.round((walked / pathTotalDist) * 100));
}

function onWaypointReached(localIdx) {
  // Navigator reports local indices into the waypoint list it received; map
  // those back onto the global list and advance monotonically.
  const globalIdx = executionStartIdx + localIdx;
  if (globalIdx + 1 > executedIndex.value && globalIdx < pathWaypoints.value.length) {
    executedIndex.value = globalIdx + 1;
    if (pathTotalDist > 0) {
      const walked = pathCumDist[executedIndex.value - 1] ?? pathTotalDist;
      pathProgress.value = Math.min(100, Math.round((walked / pathTotalDist) * 100));
    }
  }
}

/* ── Emergency stop ───────────────────────────────── */
async function emergencyStop() {
  stopManualControl();
  try { await request("/api/rover/stop", { method: "POST" }); } catch (err) { alert(err.message); }
  if (roverMode.value === "executing") {
    roverMode.value = "stopped";
    resumeStartIdx.value = executedIndex.value; // default to "where the rover left off"
  }
}

/* ── Manual control ───────────────────────────────── */
function startManualControl() {
  if (!roverStatus.value.connected) {
    alert("로버가 연결되어 있지 않습니다.");
    return;
  }
  clearPath();
  roverMode.value = "manual";
  manualThrottle.value = 0;
  manualSteering.value = 0;
  manualFailCount = 0;
  sendControl();
  controlInterval = setInterval(sendControl, 50);
}

function stopManualControl() {
  if (controlInterval) { clearInterval(controlInterval); controlInterval = null; }
  manualThrottle.value = 0;
  manualSteering.value = 0;
  manualFailCount = 0;
  sendControl();
  if (roverMode.value === "manual") roverMode.value = "none";
}

async function sendControl() {
  try {
    await request("/api/rover/control", {
      method: "POST",
      body: JSON.stringify({ throttle: manualThrottle.value, steering: manualSteering.value }),
    });
    manualFailCount = 0;
  } catch {
    manualFailCount++;
    // 5 consecutive failures (~250ms) → auto-release manual control
    if (manualFailCount >= 5 && roverMode.value === "manual") {
      stopManualControl();
      alert("로버 연결이 끊어져 수동 제어를 해제했습니다.");
    }
  }
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
    pushRecentPosition(data.lat, data.lng);
    if (roverMode.value === "executing") updatePathProgress(data.lat, data.lng);
  });

  eventSource.addEventListener("rover:status", (e) => {
    const data = JSON.parse(e.data);
    roverStatus.value = { ...roverStatus.value, ...data };
    // Live-update the rover marker on the map whenever the server
    // forwards a fresh position (rover→server SSE is the truth).
    const lp = data.last_position;
    if (lp && typeof lp.lat === "number" && typeof lp.lng === "number") {
      updateRoverMarker(lp.lat, lp.lng);
    }
    // If the rover disconnected mid-manual-control, release immediately.
    if (!data.connected && roverMode.value === "manual") {
      stopManualControl();
    }
  });

  eventSource.addEventListener("rover:waypoint", (e) => {
    const data = JSON.parse(e.data);
    if (roverMode.value === "executing" && Number.isInteger(data?.index)) {
      onWaypointReached(data.index);
    }
  });

  eventSource.addEventListener("rover:spray", (e) => {
    const data = JSON.parse(e.data);
    if (!Number.isInteger(data?.waypoint) || !data.outcome) return;
    onSprayResult(data.waypoint, data.outcome);
  });
}

function onSprayResult(localIdx, outcome) {
  // Navigator/spray_node publish local indices; translate to the global list.
  const globalIdx = executionStartIdx + localIdx;
  if (globalIdx < 0 || globalIdx >= pathWaypoints.value.length) return;
  sprayResults.value.set(globalIdx, { outcome, at: Date.now() });
  // Trigger reactive update for Map
  sprayResults.value = new Map(sprayResults.value);
  renderSprayMarkers();
}

function renderSprayMarkers() {
  if (!map) return;
  for (const [idx, marker] of Object.entries(sprayMarkers)) {
    if (!sprayResults.value.has(Number(idx))) {
      map.removeLayer(marker);
      delete sprayMarkers[idx];
    }
  }
  for (const [idx, result] of sprayResults.value.entries()) {
    if (idx >= pathWaypoints.value.length) continue;
    const wp = pathWaypoints.value[idx];
    const color = SPRAY_OUTCOME_COLOR[result.outcome] || "#888";
    const symbol = SPRAY_OUTCOME_SYMBOL[result.outcome] || "?";
    if (sprayMarkers[idx]) map.removeLayer(sprayMarkers[idx]);
    sprayMarkers[idx] = L.marker([wp.lat, wp.lng], {
      icon: L.divIcon({
        className: "",
        // White halo + dark drop shadow so the marker stays legible over green
        // satellite terrain or the planned-path polyline.
        html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:3px solid #fff;outline:1px solid rgba(0,0,0,0.55);box-shadow:0 2px 6px rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.6);">${symbol}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 26], // above the waypoint
      }),
      interactive: false, zIndexOffset: 950,
    }).addTo(map);
  }
}

function clearSprayMarkers() {
  for (const marker of Object.values(sprayMarkers)) {
    try { map.removeLayer(marker); } catch {}
  }
  sprayMarkers = {};
  sprayResults.value = new Map();
}

async function fetchRoverStatus() {
  try {
    const res = await request("/api/rover/status", { method: "GET" });
    const data = await res.json();
    roverStatus.value = { ...roverStatus.value, ...data };
    // Sync the rover marker with the cached server-side position on
    // first load — without this the map only shows the rover after the
    // next live SSE update, which can be 1+ seconds away.
    const lp = data.last_position;
    if (lp && typeof lp.lat === "number" && typeof lp.lng === "number") {
      updateRoverMarker(lp.lat, lp.lng);
    }
    // Restore in-flight mission so a tab reload during a mission doesn't lose
    // the path overlay, waypoint counter, or spray markers.
    restoreMissionProgress(data.mission_progress);
  } catch { /* best-effort */ }
}

function restoreMissionProgress(mp) {
  if (!mp || !mp.mission_id || !Array.isArray(mp.waypoints) || mp.waypoints.length === 0) return;
  if (pathWaypoints.value.length > 0) return; // user already has local state; don't clobber

  pathWaypoints.value = mp.waypoints;
  executedIndex.value = Math.max(0, Math.min(mp.current_waypoint_idx || 0, mp.waypoints.length));
  executionStartIdx = 0; // server's waypoints are the active execution's full list
  pathStart = roverStatus.value.last_position || mp.waypoints[0];

  // Rebuild path geometry + progress bar using renderPath's cumulative math.
  renderPath();
  if (pathTotalDist > 0 && executedIndex.value > 0) {
    const walked = pathCumDist[executedIndex.value - 1] ?? pathTotalDist;
    pathProgress.value = Math.min(100, Math.round((walked / pathTotalDist) * 100));
  }

  // Rehydrate spray markers from server-side results map.
  const restored = new Map();
  for (const [k, outcome] of Object.entries(mp.spray_results || {})) {
    const idx = Number(k);
    if (Number.isInteger(idx)) restored.set(idx, { outcome, at: 0 });
  }
  sprayResults.value = restored;
  renderSprayMarkers();

  // If the rover is in any active nav state, mirror that locally so the Resume /
  // Stop controls make sense on the restored view.
  const ACTIVE_STATES = new Set(["CALIBRATING", "NAVIGATING", "SETTLING", "SPRAYING", "RETURNING"]);
  if (ACTIVE_STATES.has(roverStatus.value.nav_state)) {
    roverMode.value = "executing";
  } else if (roverStatus.value.nav_state === "EMERGENCY_STOP" || roverStatus.value.nav_state === "ERROR") {
    roverMode.value = "stopped";
    resumeStartIdx.value = executedIndex.value;
  } else {
    roverMode.value = "path-ready";
  }
}

/* ── Mobile detection ─────────────────────────────── */
function checkMobile() { isMobile.value = window.innerWidth <= 768; }

function onGlobalKeydown(e) {
  if (e.key !== "Escape") return;
  // Highest-open modal wins; others remain so a stack of prompts collapses one level at a time.
  if (showLogs.value) { showLogs.value = false; e.preventDefault(); return; }
  if (showSnapshots.value) { showSnapshots.value = false; e.preventDefault(); return; }
  if (showBatteryCal.value) { showBatteryCal.value = false; e.preventDefault(); return; }
  if (showPreflight.value) { cancelPreflight(); e.preventDefault(); return; }
}

/* ── Lifecycle ────────────────────────────────────── */
onMounted(async () => {
  checkMobile();
  window.addEventListener("resize", checkMobile);
  window.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("click", onGlobalClickForChips);
  document.addEventListener("keydown", onGlobalKeyForChips);
  // 1Hz tick so time-ago chips and disconnect-ago refresh without new SSE events.
  uiTickInterval = setInterval(() => { uiTick.value = (uiTick.value + 1) % 3600; }, 1000);
  await fetchAll();
  await nextTick();
  initMap();
  connectSSE();
  fetchRoverStatus();
});

onUnmounted(() => {
  window.removeEventListener("resize", checkMobile);
  window.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("click", onGlobalClickForChips);
  document.removeEventListener("keydown", onGlobalKeyForChips);
  if (uiTickInterval) clearInterval(uiTickInterval);
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
      <!-- Rover log viewer modal -->
      <div v-if="showLogs" class="preflight-backdrop" @click.self="showLogs = false">
        <div class="preflight-modal logs-modal">
          <h3>로버 로그</h3>
          <div class="logs-toolbar">
            <button class="btn btn-primary btn-sm" :disabled="logFetching" @click="requestLogs">
              {{ logFetching ? '가져오는 중...' : '로버에서 가져오기' }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="refreshLogs">↻ 새로고침</button>
            <button class="btn btn-ghost btn-sm" :disabled="logEntries.length === 0" @click="downloadLogs">↓ 다운로드</button>
            <span class="logs-meta">
              {{ logEntries.length }}줄
              <template v-if="logUploadedAt">· {{ formatSnapshotTime(logUploadedAt) }}</template>
            </span>
          </div>
          <div class="logs-view">
            <div v-if="logEntries.length === 0" class="empty-msg">업로드된 로그가 없습니다. "로버에서 가져오기"를 눌러주세요.</div>
            <div
              v-for="(e, i) in logEntries" :key="i"
              :class="['log-row', `log-${(e.level || '').toLowerCase()}`]"
            >
              <span class="log-time">{{ formatLogTime(e.t) }}</span>
              <span class="log-level">{{ e.level }}</span>
              <span class="log-node">{{ e.node }}</span>
              <span class="log-msg">{{ e.msg }}</span>
            </div>
          </div>
          <div class="preflight-actions">
            <button class="btn btn-ghost btn-sm" @click="showLogs = false">닫기</button>
          </div>
        </div>
      </div>

      <!-- Battery calibration modal -->
      <div v-if="showBatteryCal" class="preflight-backdrop" @click.self="showBatteryCal = false">
        <div class="preflight-modal">
          <h3>배터리 전압 보정</h3>
          <p class="cal-help">
            멀티미터로 측정한 실제 배터리 전압을 입력하세요.
            로버가 같은 시점의 ADC 값과 비교해 게인을 갱신·저장합니다.
            온도 환경이 바뀌면 다시 누르면 됩니다.
          </p>
          <div class="cal-current">
            <span class="cal-key">현재 표시</span>
            <span class="cal-val">{{ roverStatus.battery?.voltage != null ? roverStatus.battery.voltage.toFixed(2) + ' V' : '—' }}</span>
            <template v-if="roverStatus.battery?.voltage_raw != null">
              <span class="cal-key">원시(보정 전)</span>
              <span class="cal-val">{{ roverStatus.battery.voltage_raw.toFixed(2) }} V</span>
            </template>
            <span class="cal-key">현재 게인</span>
            <span class="cal-val">{{ roverStatus.battery?.gain != null ? roverStatus.battery.gain.toFixed(4) : '—' }}</span>
          </div>
          <div class="cal-input-row">
            <label for="battery-cal-input">실측 전압 (V)</label>
            <input
              id="battery-cal-input"
              v-model="batteryCalInput"
              type="number"
              step="0.01"
              min="15"
              max="32"
              :disabled="batteryCalSubmitting"
              @keyup.enter="submitBatteryCal"
            />
          </div>
          <div class="preflight-actions">
            <button class="btn btn-ghost btn-sm" :disabled="batteryCalSubmitting" @click="showBatteryCal = false">취소</button>
            <button class="btn btn-primary btn-sm" :disabled="batteryCalSubmitting || !batteryCalInput" @click="submitBatteryCal">
              {{ batteryCalSubmitting ? '저장 중...' : '저장' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Snapshots modal -->
      <div v-if="showSnapshots" class="preflight-backdrop" @click.self="showSnapshots = false">
        <div class="preflight-modal snapshots-modal">
          <h3>{{ activeCourse?.name }} 스냅샷</h3>
          <div class="snapshot-create">
            <input v-model="snapshotReason" placeholder="메모 (선택)" maxlength="200" />
            <button class="btn btn-primary btn-sm" @click="createSnapshot">저장</button>
          </div>
          <div class="snapshot-list">
            <div v-if="snapshotList.length === 0" class="empty-msg">스냅샷이 없습니다.</div>
            <div v-for="s in snapshotList" :key="s.id" class="snapshot-item">
              <div class="snapshot-top">
                <span class="snapshot-time">{{ formatSnapshotTime(s.taken_at) }}</span>
                <span class="snapshot-count">{{ s.cone_count }}개</span>
              </div>
              <div v-if="s.reason" class="snapshot-reason">{{ s.reason }}</div>
              <div v-if="s.actor" class="snapshot-actor">{{ s.actor }}</div>
              <div class="snapshot-actions">
                <button class="btn btn-ghost btn-sm" @click="restoreSnapshot(s.id)">되돌리기</button>
              </div>
            </div>
          </div>
          <div class="preflight-actions">
            <button class="btn btn-ghost btn-sm" @click="showSnapshots = false">닫기</button>
          </div>
        </div>
      </div>

      <!-- Pre-flight checklist modal -->
      <div v-if="showPreflight" class="preflight-backdrop" @click.self="cancelPreflight">
        <div class="preflight-modal">
          <h3>{{ preflightMode === 'resume' ? '재시작 전 점검' : '경로 실행 전 점검' }}</h3>
          <ul class="preflight-list">
            <li
              v-for="c in preflightChecks" :key="c.key"
              :class="['preflight-item', c.ok ? 'ok' : 'fail', { flash: preflightFlash[c.key] }]"
            >
              <span class="preflight-mark">{{ c.ok ? '✓' : '✗' }}</span>
              <span class="preflight-label">{{ c.label }}</span>
              <span v-if="c.detail" class="preflight-detail">{{ c.detail }}</span>
            </li>
          </ul>
          <label v-if="!preflightAllOk" class="preflight-override">
            <input type="checkbox" v-model="preflightForce" />
            경고를 이해했고, 강제 실행합니다
          </label>
          <div class="preflight-actions">
            <button class="btn btn-ghost btn-sm" @click="cancelPreflight">취소</button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!preflightAllOk && !preflightForce"
              @click="confirmPreflight"
            >{{ preflightMode === 'resume' ? '이어서 실행' : '실행' }}</button>
          </div>
        </div>
      </div>

      <!-- Workspace: top status strip + body(rail + map + inspector) -->
      <div class="workspace" :class="{ 'inspector-collapsed': inspectorCollapsed }">

        <!-- Persistent status strip (always visible across tabs) -->
        <div :class="['status-strip', roverStatusClass]">
          <!-- Disconnected: prominent single line with reason + ago -->
          <template v-if="!roverStatus.connected">
            <span class="status-dot"></span>
            <div class="status-disconnect">
              <span class="status-disconnect-main">⊘ 로버 미연결</span>
              <span v-if="disconnectInfo" class="status-disconnect-sub">
                {{ disconnectInfo.label }}<template v-if="disconnectInfo.ago"> · {{ disconnectInfo.ago }}</template>
              </span>
            </div>
            <span class="status-reconnect-hint">재연결 대기 중…</span>
          </template>

          <!-- Connected: three zones (primary / mission / vitals) of chips -->
          <template v-else>
            <span class="status-dot"></span>
            <div class="chip-row primary-zone">
              <span
                v-if="fixChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'fix' }]"
                @click.stop="toggleChipPopover('fix')"
              >
                <span :class="['chip', `chip-${fixChip.tone}`]">{{ fixChip.label }}</span>
                <span class="chip-popover">
                  <span class="popover-row" v-for="r in fixChip.rows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span class="popover-val">{{ r[1] }}</span></span>
                </span>
              </span>
              <span
                v-if="navChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'nav' }]"
                @click.stop="toggleChipPopover('nav')"
              >
                <span :class="['chip', `chip-${navChip.tone}`]">🧭 {{ navChip.label }}</span>
                <span class="chip-popover">
                  <span class="popover-row" v-for="r in navChip.rows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span class="popover-val">{{ r[1] }}</span></span>
                </span>
              </span>
            </div>
            <div
              v-if="missionChip"
              :class="['chip-wrapper', 'mission-wrapper', { active: activeChipPopover === 'mission' }]"
              @click.stop="toggleChipPopover('mission')"
            >
              <div class="mission-inline">
                <div class="mission-bar"><div class="mission-fill" :style="{ width: missionChip.percent + '%' }"></div></div>
                <span class="mission-counts">{{ missionChip.current }}/{{ missionChip.total }} · {{ missionChip.percent }}%</span>
                <span v-if="missionChip.eta" class="mission-eta">ETA {{ missionChip.eta }}</span>
              </div>
              <span class="chip-popover">
                <span class="popover-row"><span class="popover-key">진행</span><span class="popover-val">{{ missionChip.current }} / {{ missionChip.total }} ({{ missionChip.percent }}%)</span></span>
                <span v-if="missionChip.eta" class="popover-row"><span class="popover-key">ETA</span><span class="popover-val">{{ missionChip.eta }}</span></span>
              </span>
            </div>
            <div class="chip-row vitals-zone">
              <span
                v-if="batteryChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'battery' }]"
                @click.stop="toggleChipPopover('battery')"
              >
                <span :class="['chip', `chip-${batteryChip.tone}`]">
                  🔋 {{ batteryChip.percent }}%<template v-if="batteryChip.voltage != null"> · {{ batteryChip.voltage.toFixed(1) }}V</template>
                </span>
                <span class="chip-popover">
                  <span class="popover-row" v-for="r in batteryChip.rows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span class="popover-val">{{ r[1] }}</span></span>
                  <span class="popover-row popover-actions">
                    <button class="btn btn-ghost btn-sm" @click.stop="openBatteryCal">전압 보정</button>
                  </span>
                </span>
              </span>
              <span
                v-if="ntripChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'ntrip' }]"
                @click.stop="toggleChipPopover('ntrip')"
              >
                <span :class="['chip', `chip-${ntripChip.tone}`]">{{ ntripChip.label }}</span>
                <span class="chip-popover">
                  <span class="popover-row" v-for="r in ntripChip.rows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span class="popover-val">{{ r[1] }}</span></span>
                </span>
              </span>
              <span
                v-if="posChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'pos' }]"
                @click.stop="toggleChipPopover('pos')"
              >
                <span :class="['chip', `chip-${posChip.tone}`]">📍 {{ posChip.ago }}s</span>
                <span class="chip-popover">
                  <span class="popover-row" v-for="r in posChip.rows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span class="popover-val">{{ r[1] }}</span></span>
                </span>
              </span>
            </div>
          </template>

        </div>

        <div class="workspace-body">
          <!-- Left icon rail -->
          <nav class="rail" aria-label="인스펙터 카테고리">
            <button
              v-for="t in INSPECTOR_TABS" :key="t.key"
              :class="['rail-btn', { active: activeTab === t.key && !inspectorCollapsed }]"
              @click="onRailClick(t.key)"
              :title="t.label"
            >
              <span class="rail-icon">{{ t.icon }}</span>
              <span class="rail-label">{{ t.label }}</span>
            </button>
          </nav>

          <!-- Visual separator matching the inspector resize handle width. -->
          <div class="rail-spacer"></div>

          <!-- Map (center) -->
          <div class="map-wrap">
            <div id="map" class="map"></div>
            <!-- Path pick overlay stays inside the map area -->
            <div v-if="roverMode === 'path-pick'" class="map-overlay">지도에서 시작점을 클릭하세요</div>
          </div>

          <!-- Resize handle (desktop only) -->
          <div
            v-if="!inspectorCollapsed && !isMobile"
            class="inspector-handle"
            :class="{ dragging: inspectorResizing }"
            @pointerdown="onInspectorResizeStart"
            @pointermove="onInspectorResizeMove"
            @pointerup="onInspectorResizeEnd"
            @pointercancel="onInspectorResizeEnd"
            aria-label="인스펙터 너비 조절"
          ></div>

          <!-- Inspector -->
          <aside
            v-show="!inspectorCollapsed"
            class="inspector"
            :style="!isMobile ? { width: inspectorWidth + 'px' } : { height: sheetHeight + 'px' }"
          >
            <!-- Mobile: grab handle at top -->
            <div
              v-if="isMobile"
              class="sheet-handle"
              @touchstart="onSheetTouchStart" @touchmove="onSheetTouchMove" @touchend="onSheetTouchEnd"
            >
              <div class="handle-bar"></div>
            </div>

            <div class="inspector-body">

              <!-- Courses tab -->
              <section v-show="activeTab === 'courses'" class="tab-pane">
                <header class="tab-header">
                  <h3>코스 관리</h3>
                </header>
                <div class="course-add">
                  <input v-model="newCourseName" placeholder="새 코스 이름" maxlength="100" @keyup.enter="createCourse" />
                  <button class="btn btn-primary btn-lg-touch" @click="createCourse" :disabled="!newCourseName.trim()">추가</button>
                </div>
                <div class="course-toolbar">
                  <label class="btn btn-ghost btn-lg-touch import-btn" title="JSON 가져오기">
                    ↑ 가져오기
                    <input type="file" accept=".json" hidden @change="importCourse" />
                  </label>
                  <button
                    class="btn btn-ghost btn-lg-touch"
                    :disabled="!activeCourseId"
                    @click="openSnapshots"
                    title="스냅샷"
                  >📸 스냅샷</button>
                </div>
                <div class="course-items">
                  <div
                    v-for="c in courses" :key="c.id"
                    :class="['course-item', { active: c.id === activeCourseId, editing: editingCourseId === c.id }]"
                  >
                    <button class="vis-btn" @click.stop="toggleVisibility(c.id)" :title="visibility[c.id] ? '숨기기' : '표시'">
                      <svg v-if="visibility[c.id]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
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
              </section>

              <!-- Cones tab -->
              <section v-show="activeTab === 'cones'" class="tab-pane">
                <header class="tab-header">
                  <h3>{{ activeCourse ? activeCourse.name + ' 콘' : '콘' }}</h3>
                </header>
                <div v-if="!activeCourse" class="empty-msg large">
                  코스를 먼저 선택하세요.
                  <button class="btn btn-ghost btn-lg-touch" @click="activeTab = 'courses'">코스 탭으로</button>
                </div>
                <template v-else>
                  <div class="inspector-group">
                    <div class="group-title">콘 추가</div>
                    <div class="side-rover-row">
                      <div class="side-toggle">
                        <button :class="['side-btn', { active: currentSide === 'left' }]" @click="currentSide = 'left'" style="--side-color: #8b5cf6" title="왼쪽">L</button>
                        <button :class="['side-btn', { active: currentSide === 'center' }]" @click="currentSide = 'center'" style="--side-color: #f59e0b" title="가운데">M</button>
                        <button :class="['side-btn', { active: currentSide === 'right' }]" @click="currentSide = 'right'" style="--side-color: #06b6d4" title="오른쪽">R</button>
                      </div>
                      <button class="btn btn-primary btn-lg-touch rover-btn" @click="addConeFromRover" :disabled="roverLoading">
                        {{ roverLoading ? '수신중...' : '로버 위치' }}
                      </button>
                    </div>
                    <p class="hint">지도 클릭으로도 현재 <b>{{ coneFilterLabel === '전체' ? currentSideLabel : '' }}</b> 콘을 놓을 수 있습니다.</p>
                  </div>

                  <div v-if="multiSelectedIds.size > 0" class="inspector-group selected">
                    <div class="group-title">{{ multiSelectedIds.size }}개 선택됨</div>
                    <div class="edit-buttons">
                      <span class="multi-select-hint">드래그로 일괄 이동</span>
                      <button class="btn btn-ghost btn-lg-touch" @click="clearMultiSelection">선택 해제</button>
                    </div>
                  </div>

                  <div v-if="selectedConeId && multiSelectedIds.size === 0" class="inspector-group selected">
                    <div class="group-title">콘 수정 #{{ coneSideIndex(activeCourseId, selectedConeId) }}</div>
                    <div class="coord-inputs">
                      <input v-model="editLat" type="number" step="any" placeholder="위도" />
                      <input v-model="editLng" type="number" step="any" placeholder="경도" />
                      <select v-model="editSide">
                        <option value="left">L 왼쪽</option>
                        <option value="center">M 가운데</option>
                        <option value="right">R 오른쪽</option>
                      </select>
                    </div>
                    <div class="edit-buttons">
                      <button class="btn btn-primary btn-lg-touch" @click="updateCone">저장</button>
                      <button class="btn btn-danger btn-lg-touch" @click="deleteCone(selectedConeId)">삭제</button>
                      <button class="btn btn-ghost btn-lg-touch" @click="selectedConeId = null">취소</button>
                    </div>
                  </div>

                  <div class="inspector-group cone-list-section">
                    <div class="cone-list-header">
                      <div class="group-title">
                        목록 ({{ filteredCones.length }})
                        <span v-if="coneFilter !== 'all'" class="filter-tag" :style="{ '--fc': SIDE_COLORS[coneFilter] }">{{ coneFilterLabel }}</span>
                      </div>
                      <div class="cone-filter">
                        <button :class="['filter-btn', { active: coneFilter === 'all' }]" @click="coneFilter = 'all'" title="전체 콘 표시">전체</button>
                        <button :class="['filter-btn', { active: coneFilter === 'left' }]" @click="coneFilter = 'left'" :style="{ '--fc': SIDE_COLORS.left }" title="왼쪽">L</button>
                        <button :class="['filter-btn', { active: coneFilter === 'center' }]" @click="coneFilter = 'center'" :style="{ '--fc': SIDE_COLORS.center }" title="가운데">M</button>
                        <button :class="['filter-btn', { active: coneFilter === 'right' }]" @click="coneFilter = 'right'" :style="{ '--fc': SIDE_COLORS.right }" title="오른쪽">R</button>
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
                        <button class="del-btn" @click.stop="deleteCone(cone.id)" title="삭제">×</button>
                      </div>
                      <div v-if="filteredCones.length === 0" class="empty-msg">콘이 없습니다.</div>
                    </div>
                  </div>
                </template>
              </section>

              <!-- Rover tab -->
              <section v-show="activeTab === 'rover'" class="tab-pane">
                <header class="tab-header">
                  <h3>로버 제어</h3>
                </header>
                <div v-if="!activeCourse" class="empty-msg large">
                  코스를 먼저 선택하세요.
                  <button class="btn btn-ghost btn-lg-touch" @click="activeTab = 'courses'">코스 탭으로</button>
                </div>
                <template v-else>
                  <div class="rover-controls rover-controls-grid">
                    <button
                      :class="['btn', 'btn-lg-touch', pathBtnClass]"
                      @click="onPathBtn"
                      :disabled="activeCones.length === 0 || roverMode === 'manual'"
                    >{{ pathBtnLabel }}</button>
                    <button
                      :class="['btn', 'btn-lg-touch', roverMode === 'manual' ? 'btn-primary' : 'btn-ghost']"
                      :disabled="roverMode !== 'manual' && !roverStatus.connected"
                      @click="roverMode === 'manual' ? stopManualControl() : startManualControl()"
                    >{{ roverMode === 'manual' ? '수동 종료' : '수동 제어' }}</button>
                  </div>

                  <div v-if="pathDistance > 0" class="path-info">
                    <div>예상 주행 거리: {{ pathDistance >= 1000 ? (pathDistance / 1000).toFixed(2) + ' km' : pathDistance.toFixed(1) + ' m' }}</div>
                    <div v-if="roverMode === 'executing' || roverMode === 'stopped'">
                      웨이포인트 {{ executedIndex }}/{{ pathWaypoints.length }}
                      <span v-if="pathProgress > 0" class="path-info-progress">({{ pathProgress }}%)</span>
                    </div>
                  </div>

                  <!-- Waypoint reorder (path-ready only) -->
                  <div v-if="roverMode === 'path-ready' && pathWaypoints.length > 1" class="inspector-group waypoint-list">
                    <div class="waypoint-list-header">
                      <span>웨이포인트 ({{ pathWaypoints.length }})</span>
                      <span class="waypoint-hint">↑↓로 순서 변경</span>
                    </div>
                    <div
                      v-for="(wp, idx) in pathWaypoints" :key="`${wp.lat}-${wp.lng}-${idx}`"
                      class="waypoint-item"
                    >
                      <span class="waypoint-num">#{{ idx + 1 }}</span>
                      <span class="waypoint-coord">{{ wp.lat.toFixed(5) }}, {{ wp.lng.toFixed(5) }}</span>
                      <div class="waypoint-arrows">
                        <button class="arrow-btn" :disabled="idx === 0" @click="moveWaypoint(idx, -1)" title="위로">↑</button>
                        <button class="arrow-btn" :disabled="idx === pathWaypoints.length - 1" @click="moveWaypoint(idx, 1)" title="아래로">↓</button>
                      </div>
                    </div>
                  </div>

                  <!-- Resume waypoint selector (stopped only) -->
                  <div v-if="roverMode === 'stopped' && pathWaypoints.length > 0" class="resume-selector">
                    <label class="resume-label">재시작 위치:</label>
                    <select v-model.number="resumeStartIdx" class="resume-select">
                      <option v-for="(wp, idx) in pathWaypoints" :key="idx" :value="idx">
                        #{{ idx + 1 }}{{ idx < executedIndex ? ' (완료)' : '' }}{{ idx === executedIndex ? ' (다음)' : '' }}
                      </option>
                    </select>
                  </div>

                  <!-- Manual joystick -->
                  <div v-if="roverMode === 'manual'" class="joystick-area">
                    <div class="joystick-info">T: {{ manualThrottle }} / S: {{ manualSteering }}</div>
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
                          :style="{ transform: `translate(${manualSteering * 0.82}px, ${-manualThrottle * 0.82}px)` }"
                        ></div>
                      </div>
                      <div class="joystick-labels">
                        <span class="jl-up">▲</span><span class="jl-down">▼</span>
                        <span class="jl-left">◄</span><span class="jl-right">►</span>
                      </div>
                    </div>
                  </div>
                </template>
              </section>

              <!-- Logs tab -->
              <section v-show="activeTab === 'logs'" class="tab-pane">
                <header class="tab-header">
                  <h3>로버 로그</h3>
                </header>
                <div class="rover-controls rover-controls-grid">
                  <button class="btn btn-primary btn-lg-touch" :disabled="logFetching" @click="requestLogs">
                    {{ logFetching ? '가져오는 중...' : '로버에서 가져오기' }}
                  </button>
                  <button class="btn btn-ghost btn-lg-touch" @click="refreshLogs">↻ 새로고침</button>
                  <button class="btn btn-ghost btn-lg-touch" :disabled="logEntries.length === 0" @click="downloadLogs">↓ 다운로드</button>
                  <button class="btn btn-ghost btn-lg-touch" :disabled="logEntries.length === 0" @click="showLogs = true">전체 보기</button>
                </div>
                <div class="logs-meta">
                  {{ logEntries.length }}줄
                  <template v-if="logUploadedAt">· {{ formatSnapshotTime(logUploadedAt) }}</template>
                </div>
                <div v-if="logEntries.length === 0" class="empty-msg">업로드된 로그가 없습니다.</div>
                <div v-else class="logs-view logs-view-inline">
                  <div
                    v-for="(e, i) in logEntries.slice(-50)" :key="i"
                    :class="['log-row', `log-${(e.level || '').toLowerCase()}`]"
                  >
                    <span class="log-time">{{ formatLogTime(e.t) }}</span>
                    <span class="log-level">{{ e.level }}</span>
                    <span class="log-msg">{{ e.msg }}</span>
                  </div>
                </div>
              </section>

              <!-- Missions tab (integrated; map shows replay layers while active) -->
              <section v-show="activeTab === 'missions'" class="tab-pane">
                <header class="tab-header">
                  <h3>미션 이력</h3>
                  <button class="btn btn-ghost btn-sm" @click="loadMissions" title="새로고침">↻</button>
                </header>
                <div v-if="missionLoading" class="empty-msg">불러오는 중...</div>
                <div v-else-if="missions.length === 0" class="empty-msg">기록된 미션이 없습니다.</div>
                <div v-else class="missions-list-inline">
                  <div
                    v-for="m in missions" :key="m.id"
                    :class="['mission-card', { selected: selectedMissionId === m.id }]"
                    @click="selectMission(m.id)"
                  >
                    <div class="mission-top">
                      <span class="mission-id">#{{ m.id }}</span>
                      <span class="mission-status-badge" :style="{ background: MISSION_STATUS_COLOR[m.status] }">
                        {{ MISSION_STATUS_LABEL[m.status] || m.status }}
                      </span>
                    </div>
                    <div class="mission-meta">
                      <span>{{ formatMissionTimestamp(m.started_at) }}</span>
                      <span>· {{ formatMissionDuration(m.started_at, m.ended_at) }}</span>
                      <span v-if="m.course_name">· {{ m.course_name }}</span>
                    </div>
                    <div class="mission-meta-sub">{{ m.sample_count }}개 샘플</div>
                  </div>
                  <div v-if="missions.length < missionTotal" class="load-more">
                    <button class="btn btn-ghost btn-lg-touch" :disabled="missionLoadingMore" @click="loadMoreMissions">
                      {{ missionLoadingMore ? "불러오는 중..." : `더 보기 (${missions.length}/${missionTotal})` }}
                    </button>
                  </div>
                </div>

                <!-- Replay controls for the selected mission -->
                <div v-if="missionDetail" class="inspector-group mission-replay">
                  <div class="group-title">
                    #{{ missionDetail.id }}
                    <span class="replay-state">{{ currentSampleState }} · {{ currentSampleFix }}</span>
                  </div>
                  <div class="replay-controls-touch">
                    <button class="btn btn-primary btn-lg-touch replay-play" @click="togglePlay" :disabled="missionSamples.length === 0">
                      {{ replayPlaying ? '⏸ 일시정지' : '▶ 재생' }}
                    </button>
                    <input
                      type="range" class="replay-slider"
                      :min="0" :max="Math.max(0, missionSamples.length - 1)" :step="1"
                      v-model.number="replayIdx"
                      :disabled="missionSamples.length === 0"
                    />
                    <select v-model.number="replaySpeed" class="replay-speed">
                      <option :value="1">1× 실시간</option>
                      <option :value="4">4×</option>
                      <option :value="16">16×</option>
                      <option :value="64">64×</option>
                    </select>
                  </div>
                  <div class="replay-time">{{ currentSampleTime }}</div>
                </div>
              </section>

            </div>
          </aside>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-layout { height: 100%; overflow: hidden; padding: 1rem; position: relative; }

.content {
  height: 100%; display: flex; flex-direction: column; overflow: hidden;
  border-radius: 12px; border: 1px solid var(--border-primary);
  position: relative;
  background: var(--bg-primary);
}

.workspace { flex: 1; display: flex; flex-direction: column; min-height: 0; }

/* ── Top status strip ─────────────────────────────── */
.status-strip {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.75rem; min-height: 48px;
  border-bottom: 1px solid var(--border-primary);
  background: var(--bg-primary); color: var(--text-primary);
  font-size: 0.85rem;
  flex-wrap: wrap;
  /* New stacking context comfortably above Leaflet's panes/controls
     (max 1000) so chip popovers anchored inside it always escape the
     map. The inline E-Stop button still wins at z-index 2000. */
  position: relative;
  z-index: 1500;
}
.status-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: #94a3b8; flex-shrink: 0;
}
.status-strip.rover-badge-ok .status-dot { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.status-strip.rover-badge-warn .status-dot { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
.status-strip.rover-badge-off .status-dot { background: #94a3b8; }

.chip-row { display: flex; align-items: center; gap: 0.375rem; flex-wrap: wrap; }
.primary-zone { flex: 0 1 auto; }
.vitals-zone { flex: 0 1 auto; }

/* Hover-/click-toggled popover for any status chip. The wrapper holds
   the chip element and an absolutely-positioned bubble that appears on
   :hover (desktop) or when .active is set (click toggle, mobile). */
.chip-wrapper {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}
.chip-popover {
  display: none;
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 1600;          /* above status-strip's stacking context */
  width: max-content;
  max-width: min(320px, calc(100vw - 1.5rem));
  padding: 0.45rem 0.65rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
  font-size: 0.74rem;
  line-height: 1.45;
  cursor: default;
}
/* Compact two-column rows.  `max-content 1fr` lets the key column hug
   its widest label across rows while the value column takes the rest;
   `keep-all` stops Korean text from breaking inside syllables and
   `nowrap` keeps short data on one line — long values still wrap on
   word boundaries because `flex-wrap: wrap` is implicit on rows. */
.popover-row {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 0.6rem;
  align-items: baseline;
  padding: 0.05rem 0;
}
.popover-key {
  color: var(--text-secondary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.7rem;
  white-space: nowrap;
}
.popover-val {
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.74rem;
  word-break: keep-all;
  overflow-wrap: anywhere;
}
.chip-wrapper:hover > .chip-popover,
.chip-wrapper.active > .chip-popover { display: block; }

/* Popover action row (e.g. battery 보정 button) — single-cell, padded so
   the button sits inside the popover's bottom border, not glued to it. */
.popover-row.popover-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 0.4rem;
  margin-top: 0.3rem;
  border-top: 1px solid var(--border-color, rgba(0, 0, 0, 0.08));
}

/* Battery cal modal — borrows the preflight modal frame, just adds
   the layout for the current-state grid + the input row. */
.cal-help {
  margin: 0 0 0.75rem 0;
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.cal-current {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 0.75rem;
  row-gap: 0.25rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-secondary, rgba(0, 0, 0, 0.03));
  border-radius: 6px;
}
.cal-current .cal-key {
  color: var(--text-secondary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.78rem;
}
.cal-current .cal-val {
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.85rem;
}
.cal-input-row {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}
.cal-input-row label {
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.cal-input-row input {
  padding: 0.5rem 0.6rem;
  font-family: "JetBrains Mono", monospace;
  font-size: 1rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
}

/* The mission progress bar needs to grow to fill the strip's middle,
   so override the chip-wrapper's tighter inline-flex sizing. */
.mission-wrapper { flex: 1 1 220px; min-width: 0; display: flex; }
.mission-wrapper > .mission-inline { flex: 1 1 auto; min-width: 0; }

.chip {
  display: inline-flex; align-items: center;
  padding: 0.2rem 0.6rem; border-radius: 999px;
  font-size: 0.78rem; font-weight: 600;
  font-family: "JetBrains Mono", monospace;
  border: 1px solid transparent; white-space: nowrap;
  line-height: 1.4;
}
.chip-ok {
  background: color-mix(in srgb, #22c55e 15%, var(--bg-primary));
  border-color: color-mix(in srgb, #22c55e 40%, transparent);
  color: color-mix(in srgb, #22c55e 80%, var(--text-primary));
}
.chip-warn {
  background: color-mix(in srgb, #f59e0b 18%, var(--bg-primary));
  border-color: color-mix(in srgb, #f59e0b 50%, transparent);
  color: color-mix(in srgb, #f59e0b 85%, var(--text-primary));
}
.chip-bad {
  background: color-mix(in srgb, #ef4444 20%, var(--bg-primary));
  border-color: color-mix(in srgb, #ef4444 55%, transparent);
  color: color-mix(in srgb, #ef4444 85%, var(--text-primary));
  animation: chip-attention 2s ease-in-out infinite;
}
.chip-neutral {
  background: var(--bg-secondary);
  border-color: var(--border-primary);
  color: var(--text-secondary);
}
@keyframes chip-attention {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.75; }
}

/* Mission progress inline between primary + vitals */
.mission-inline {
  display: flex; align-items: center; gap: 0.5rem;
  flex: 1 1 220px; min-width: 0;
  padding: 0.2rem 0.6rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 999px;
  font-family: "JetBrains Mono", monospace; font-size: 0.78rem;
}
.mission-bar {
  flex: 1; min-width: 60px; height: 6px;
  background: color-mix(in srgb, var(--accent-primary) 15%, var(--bg-primary));
  border-radius: 3px; overflow: hidden;
}
.mission-fill {
  height: 100%;
  background: var(--accent-primary);
  transition: width 0.3s ease;
}
.mission-counts { font-weight: 700; color: var(--text-primary); white-space: nowrap; }
.mission-eta { color: var(--text-secondary); white-space: nowrap; }

/* Disconnected layout */
.status-disconnect {
  display: flex; flex-direction: column; gap: 0.1rem;
  flex: 1; min-width: 0;
}
.status-disconnect-main { font-size: 0.95rem; font-weight: 700; color: var(--text-primary); }
.status-disconnect-sub { font-size: 0.78rem; color: var(--text-secondary); }
.status-reconnect-hint {
  font-size: 0.75rem; color: var(--text-secondary);
  font-style: italic;
  padding: 0.2rem 0.6rem;
  background: var(--bg-secondary); border-radius: 999px;
}

/* (status-expand / inspector-toggle / status-detail removed — operator
   uses inspector tabs for detail and rail icon click to dock/undock.) */

/* ── Body: rail + map + inspector ─────────────────── */
.workspace-body { flex: 1; display: flex; min-height: 0; }

.rail {
  width: 72px; flex-shrink: 0;
  display: flex; flex-direction: column;
  padding: 0.5rem 0; gap: 0.375rem;
  background: var(--bg-primary);
}
/* Match the 8px inspector resize handle on the left side so the map has
   symmetric breathing room. Purely visual — no drag affordance here. */
.rail-spacer {
  width: 8px; flex-shrink: 0;
  background: var(--border-primary);
}
.rail-divider {
  height: 1px; margin: 0.25rem 0.75rem;
  background: var(--border-primary);
}
.rail-btn {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 2px;
  min-height: 60px; padding: 0.4rem 0.25rem;
  margin: 0 0.25rem; border: none; border-radius: 8px;
  background: transparent; color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.rail-btn:hover { background: var(--bg-secondary); color: var(--text-primary); }
.rail-btn.active {
  background: var(--accent-primary); color: #fff;
  box-shadow: 0 2px 6px color-mix(in srgb, var(--accent-primary) 50%, transparent);
}
.rail-icon { font-size: 1.5rem; line-height: 1; }
.rail-label { font-size: 0.7rem; font-weight: 600; }

.map-wrap { flex: 1; position: relative; min-width: 0; min-height: 0; }
.map { width: 100%; height: 100%; z-index: 0; }

.map-overlay {
  position: absolute; top: 1rem; left: 50%; transform: translateX(-50%);
  background: rgba(0,0,0,0.75); color: #fff; padding: 0.5rem 1.25rem;
  border-radius: 8px; font-size: 0.9rem; font-weight: 500; z-index: 500;
  pointer-events: none;
}

.inspector-handle {
  width: 8px; flex-shrink: 0;
  background: var(--border-primary);
  cursor: col-resize;
  touch-action: none;
  transition: background 0.12s;
}
.inspector-handle:hover, .inspector-handle.dragging { background: var(--accent-primary); }

.inspector {
  flex-shrink: 0; min-width: 280px; max-width: 600px;
  background: var(--bg-primary);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.inspector-body {
  flex: 1; overflow-y: auto;
  display: flex; flex-direction: column;
}

/* Tab panes */
.tab-pane {
  display: flex; flex-direction: column;
  gap: 0.75rem;
  padding: 0.875rem 1rem 1.5rem;
}
.tab-header {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 0.5rem; margin-bottom: 0.25rem;
  border-bottom: 1px solid var(--border-primary);
}
.tab-header h3 { margin: 0; font-size: 1rem; font-weight: 700; }

.inspector-group {
  padding: 0.625rem 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.inspector-group.selected {
  background: color-mix(in srgb, var(--accent-primary) 7%, var(--bg-primary));
  border-color: var(--accent-primary);
}
.group-title {
  font-size: 0.85rem; font-weight: 700; color: var(--text-primary);
}
.hint { font-size: 0.75rem; color: var(--text-secondary); margin: 0; }

/* Large touch-friendly button variant — min 44x44. */
.btn-lg-touch {
  min-height: 44px;
  padding: 0.5rem 0.875rem;
  font-size: 0.9rem;
  font-weight: 600;
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

/* Touch-friendly tap targets per WCAG 2.5.5 / Apple HIG 44pt when any coarse
   pointer (touchscreen, stylus, or external touch surface) is present. A
   hybrid laptop gets the bigger targets even when the user is on the mouse —
   that's a deliberate trade so switching to touch mid-task isn't fiddly. */
@media (any-pointer: coarse) {
  .dl-btn, .del-btn, .vis-btn, .arrow-btn {
    min-width: 44px;
    min-height: 44px;
  }
  .side-btn, .filter-btn {
    min-height: 44px;
    padding: 0.6rem 0.75rem;
  }
  .status-inspector-toggle { min-height: 44px; min-width: 56px; }
  .inspector-handle { width: 14px; }
  .course-item { min-height: 44px; padding: 0.5rem 0.375rem; }
  .cone-item { min-height: 44px; padding: 0.5rem 0.375rem; }
  .waypoint-item { min-height: 44px; padding: 0.5rem 0.6rem; }
}

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
.rover-controls { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.rover-controls-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem;
}
.rover-controls-grid .btn { width: 100%; }

.course-toolbar { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
.course-toolbar .btn { flex: 1; min-width: 120px; }

.logs-view-inline {
  flex: none; max-height: 50vh;
}
/* Sidebar log row: time + level on the first line, message wraps below.
   Lays out as a flex grid with a hard line break before the message. */
.logs-view-inline .log-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 0.5rem;
  row-gap: 0.1rem;
  padding: 0.2rem 0;
}
.logs-view-inline .log-time { white-space: nowrap; }
.logs-view-inline .log-level { white-space: nowrap; }
.logs-view-inline .log-msg {
  flex-basis: 100%;        /* force msg onto its own line */
  word-break: break-word;
  color: var(--text-primary);
}

/* ── Mission history (inside the missions inspector tab) ─────────── */
.missions-list-inline { display: flex; flex-direction: column; gap: 0.5rem; }
.mission-card {
  padding: 0.6rem 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.mission-card:hover { background: var(--bg-primary); }
.mission-card.selected {
  background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-primary));
  border-color: var(--accent-primary);
}
.mission-top {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 0.25rem;
}
.mission-id { font-weight: 700; font-family: "JetBrains Mono", monospace; }
.mission-status-badge {
  padding: 0.1rem 0.5rem; border-radius: 4px;
  font-size: 0.7rem; font-weight: 600; color: #fff;
}
.mission-meta {
  font-size: 0.8rem; color: var(--text-secondary);
  display: flex; gap: 0.3rem; flex-wrap: wrap;
}
.mission-meta-sub { font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.2rem; }
.load-more { display: flex; justify-content: center; padding: 0.5rem; }

.mission-replay { position: sticky; bottom: 0; background: var(--bg-primary); z-index: 1; }
.replay-controls-touch { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
.replay-play { min-width: 120px; }
.replay-slider { flex: 1; min-width: 0; accent-color: var(--accent-primary); height: 28px; }
.replay-speed {
  padding: 0.4rem 0.5rem; min-height: 36px;
  background: var(--bg-primary); color: var(--text-primary);
  border: 1px solid var(--border-primary); border-radius: 6px;
  font-family: "JetBrains Mono", monospace;
}
.replay-state {
  font-family: "JetBrains Mono", monospace; font-size: 0.75rem;
  color: var(--text-secondary); font-weight: 400;
}
.replay-time {
  font-family: "JetBrains Mono", monospace; font-size: 0.8rem;
  color: var(--text-secondary); margin-top: 0.25rem;
}

.path-info {
  margin-top: 0.5rem; padding: 0.375rem 0.5rem;
  background: var(--bg-secondary); border-radius: 6px;
  font-size: 0.8rem; color: var(--text-secondary);
  font-family: "JetBrains Mono", monospace;
  display: flex; flex-direction: column; gap: 0.15rem;
}
.path-info-progress { color: var(--accent-primary); margin-left: 0.25rem; }

.preflight-backdrop {
  position: absolute; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  padding: 1rem;
}
.preflight-modal {
  background: var(--bg-primary); color: var(--text-primary);
  border: 1px solid var(--border-primary); border-radius: 10px;
  padding: 1rem 1.25rem; min-width: 320px; max-width: 440px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.preflight-modal h3 { margin: 0 0 0.75rem 0; }
.preflight-list { list-style: none; padding: 0; margin: 0 0 0.75rem 0; }
.preflight-item {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.25rem; border-bottom: 1px solid var(--border-primary);
  font-size: 0.9rem;
}
.preflight-item:last-child { border-bottom: none; }
.preflight-item.ok .preflight-mark { color: #22c55e; }
.preflight-item.fail .preflight-mark { color: #ef4444; }
.preflight-item.flash { animation: preflight-flash 1.2s ease-out; }

@keyframes preflight-flash {
  0%   { background: color-mix(in srgb, #f59e0b 40%, transparent); }
  100% { background: transparent; }
}
.preflight-mark { font-weight: 800; width: 1em; text-align: center; }
.preflight-label { flex: 1; }
.preflight-detail { color: var(--text-secondary); font-family: "JetBrains Mono", monospace; font-size: 0.8rem; }
.preflight-override {
  display: flex; align-items: center; gap: 0.4rem;
  padding: 0.5rem; margin-bottom: 0.5rem;
  background: color-mix(in srgb, #ef4444 12%, var(--bg-secondary));
  border-radius: 6px; font-size: 0.85rem; color: var(--text-primary);
}
.preflight-override input { margin: 0; }
.preflight-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem;
  /* Breathing room above the close/confirm buttons in every modal. */
  margin-top: 1rem;
  padding-top: 0.5rem;
  border-top: 1px solid color-mix(in srgb, var(--border-primary) 50%, transparent);
}

.logs-modal { max-width: 800px; width: 90vw; max-height: 85vh; display: flex; flex-direction: column; }
.logs-toolbar {
  display: flex; align-items: center; gap: 0.5rem;
  margin-bottom: 0.5rem; flex-wrap: wrap;
}
.logs-meta { font-size: 0.75rem; color: var(--text-secondary); margin-left: auto; }
.logs-view {
  flex: 1; overflow-y: auto;
  background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 6px;
  padding: 0.5rem; font-family: "JetBrains Mono", monospace; font-size: 0.75rem;
  line-height: 1.45;
}
/* Modal full-screen log viewer: rows are table-rows with cells
   sizing to their content (the classic "width: 1%" trick on the
   fixed columns) so nothing wraps and the message column takes
   whatever's left. The browser auto-generates the anonymous table
   wrapper around the consecutive table-rows, so .logs-view stays a
   regular flex/scroll container. */
.logs-view:not(.logs-view-inline) .log-row {
  display: table-row;
}
.logs-view:not(.logs-view-inline) .log-row > span {
  display: table-cell;
  padding: 0.1rem 0.5rem 0.1rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border-primary) 30%, transparent);
  vertical-align: top;
}
.logs-view:not(.logs-view-inline) .log-time,
.logs-view:not(.logs-view-inline) .log-level,
.logs-view:not(.logs-view-inline) .log-node {
  width: 1%;             /* shrink to content */
  white-space: nowrap;
}
.logs-view:not(.logs-view-inline) .log-msg {
  width: auto; word-break: break-word;
}
.log-time { color: var(--text-secondary); }
.log-level { font-weight: 700; }
.log-node { color: var(--text-secondary); }
.log-warn .log-level { color: #f59e0b; }
.log-error .log-level, .log-fatal .log-level { color: #ef4444; }
.log-info .log-level { color: #22c55e; }

.snapshots-modal { max-width: 500px; max-height: 80vh; display: flex; flex-direction: column; }
.snapshot-create {
  display: flex; gap: 0.5rem; margin-bottom: 0.75rem;
}
.snapshot-create input {
  flex: 1; padding: 0.4rem 0.6rem;
  background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-primary); border-radius: 6px;
}
.snapshot-list { flex: 1; overflow-y: auto; margin-bottom: 0.75rem; }
.snapshot-item {
  padding: 0.5rem; border-bottom: 1px solid var(--border-primary);
  font-size: 0.85rem;
}
.snapshot-top { display: flex; justify-content: space-between; align-items: center; }
.snapshot-time { font-family: "JetBrains Mono", monospace; color: var(--text-primary); }
.snapshot-count { color: var(--text-secondary); font-size: 0.8rem; }
.snapshot-reason { color: var(--text-secondary); font-size: 0.8rem; margin-top: 0.15rem; }
.snapshot-actor { color: var(--text-secondary); font-size: 0.75rem; margin-top: 0.15rem; }
.snapshot-actions { margin-top: 0.3rem; display: flex; justify-content: flex-end; }

.waypoint-list {
  margin-top: 0.5rem; max-height: 250px; overflow-y: auto;
  border: 1px solid var(--border-primary); border-radius: 6px;
  background: var(--bg-primary);
}
.waypoint-list-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.4rem 0.6rem; background: var(--bg-secondary);
  font-size: 0.8rem; font-weight: 600;
  position: sticky; top: 0;
}
.waypoint-hint { color: var(--text-secondary); font-weight: 400; font-size: 0.75rem; }
.waypoint-item {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--border-primary);
  font-size: 0.8rem;
}
.waypoint-item:last-child { border-bottom: none; }
.waypoint-num { font-family: "JetBrains Mono", monospace; font-weight: 600; min-width: 2em; }
.waypoint-coord { flex: 1; font-family: "JetBrains Mono", monospace; color: var(--text-secondary); font-size: 0.75rem; }
.waypoint-arrows { display: flex; gap: 0.15rem; }
.arrow-btn {
  width: 22px; height: 22px; padding: 0;
  background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-primary); border-radius: 4px;
  font-size: 0.8rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.arrow-btn:hover:not(:disabled) { background: var(--accent-primary); color: #fff; }
.arrow-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.resume-selector {
  margin-top: 0.5rem;
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.85rem;
}
.resume-label { color: var(--text-secondary); flex-shrink: 0; }
.resume-select {
  flex: 1; min-width: 0;
  padding: 0.3rem 0.5rem;
  background: var(--bg-primary); color: var(--text-primary);
  border: 1px solid var(--border-primary); border-radius: 6px;
  font-family: "JetBrains Mono", monospace; font-size: 0.8rem;
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
  color: #fff;
  background: var(--fc, var(--accent-primary));
  font-weight: 700;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fc, var(--accent-primary)) 25%, transparent);
}

.filter-tag {
  margin-left: 0.4rem;
  padding: 0.1rem 0.4rem;
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: 4px;
  color: #fff;
  background: var(--fc, var(--accent-primary));
  vertical-align: middle;
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

.empty-msg { text-align: center; padding: 1rem 0; color: var(--text-secondary); font-size: 0.85rem; }
.empty-msg.large { padding: 2rem 0; font-size: 0.95rem; display: flex; flex-direction: column; align-items: center; gap: 0.75rem; }

/* ── Mobile: rail → bottom tab bar, inspector → bottom drawer ────────── */
@media (max-width: 768px) {
  .map-layout { padding: 0; }
  .content { border-radius: 0; border: none; }

  /* Status strip: allow chips to wrap onto a second row when needed.
     We can't use overflow-x: auto here because that clips the chip
     popovers (top: 100%) that hang below the strip. Wrapping eats one
     extra row at most, while the map still fills below — acceptable
     trade for popovers that actually display. */
  .status-strip {
    padding: 0.3rem 0.6rem;
    min-height: 40px;
    flex-wrap: wrap;
    row-gap: 0.25rem;
    overflow: visible;
  }
  .chip-row { flex-wrap: wrap; }
  .mission-inline { flex: 1 1 100%; min-width: 0; }
  .status-reconnect-hint { display: none; }
  .chip { padding: 0.15rem 0.5rem; font-size: 0.72rem; }

  .workspace-body {
    flex-direction: column;
    position: relative;
    min-height: 0;
  }

  .rail {
    /* Pin the tab nav to the bottom of the visual viewport so it's
       always visible — address-bar reflow never hides it. */
    position: fixed;
    left: 0; right: 0; bottom: 0;
    width: 100%;
    flex-direction: row;
    border-top: 1px solid var(--border-primary);
    padding: 0.25rem 0.5rem; gap: 0.25rem;
    justify-content: space-around;
    background: var(--bg-primary);
    z-index: 700;
    /* Respect iOS home-indicator safe-area so labels stay tappable. */
    padding-bottom: max(0.25rem, env(safe-area-inset-bottom));
  }
  .rail-spacer { display: none; }
  .rail-divider {
    width: 1px; height: 28px; margin: 0 0.25rem;
    align-self: center;
  }
  .rail-btn { flex: 1; min-height: 52px; margin: 0; padding: 0.3rem 0.2rem; }
  .rail-icon { font-size: 1.2rem; }
  .rail-label { font-size: 0.68rem; }

  .map-wrap { flex: 1; min-height: 220px; }

  .inspector-handle { display: none; }

  /* Bottom drawer pinned to the visual viewport (same coord space as
     the fixed rail). Anchoring against `bottom` rather than relying
     on flex layout means the drawer sits just above the rail no
     matter how the address bar reflows the layout viewport — the bug
     where the drawer only became visible after the address bar
     hid was caused by laying it out against the layout viewport. */
  .inspector {
    position: fixed !important;
    left: 0; right: 0;
    bottom: calc(60px + env(safe-area-inset-bottom));
    width: 100% !important;
    max-width: 100%; min-width: 0;
    max-height: 75vh;
    border-top: 1px solid var(--border-primary);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -4px 20px rgba(0,0,0,0.25);
    z-index: 600;
    background: var(--bg-primary);
    overflow: hidden;
  }
  .inspector-body { overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .map-wrap { flex: 1; min-height: 220px; }

  .sheet-handle {
    display: flex; align-items: center; justify-content: center;
    padding: 0.5rem 1rem;
    cursor: pointer; flex-shrink: 0;
    touch-action: none;
  }
  .handle-bar {
    width: 44px; height: 5px; border-radius: 3px;
    background: var(--text-secondary); opacity: 0.4;
  }

  /* Drawer content needs breathing room on touch and the joystick
     should always be centred and large enough to grip. */
  .tab-pane { padding: 0.75rem 0.875rem 1.25rem; }
  .rover-controls-grid { grid-template-columns: 1fr; gap: 0.5rem; }
  .joystick-area { display: flex; flex-direction: column; align-items: center; }
  .joystick { max-width: 220px; width: 100%; }

  /* Modals: full-bleed with side margin so they fit phone screens. */
  .preflight-modal, .logs-modal, .snapshots-modal {
    width: calc(100vw - 1.5rem); max-width: calc(100vw - 1.5rem);
    max-height: calc(100dvh - 2rem);
  }

  /* Modal log viewer on mobile: drop the table-row layout (which gets
     clipped at the viewport edge with `width: 1%; nowrap`) and stack
     each row like the inline sidebar — time + level on one line, the
     message wrapped onto its own. */
  .logs-view:not(.logs-view-inline) .log-row {
    display: flex; flex-wrap: wrap;
    column-gap: 0.5rem; row-gap: 0.05rem;
    padding: 0.2rem 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border-primary) 30%, transparent);
  }
  .logs-view:not(.logs-view-inline) .log-row > span {
    display: inline; padding: 0; border: none; vertical-align: baseline;
  }
  .logs-view:not(.logs-view-inline) .log-time,
  .logs-view:not(.logs-view-inline) .log-level,
  .logs-view:not(.logs-view-inline) .log-node {
    width: auto; white-space: nowrap;
  }
  .logs-view:not(.logs-view-inline) .log-msg {
    flex-basis: 100%; word-break: break-word;
  }

  /* Popovers: fall back to wider, lower-density layout for thumb taps. */
  .chip-popover { font-size: 0.78rem; min-width: 200px; max-width: calc(100vw - 2rem); }
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
