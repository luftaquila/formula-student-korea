<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch, inject } from "vue";
import { useRouter } from "vue-router";
import L from "leaflet";
import { request } from "../api.js";
import MissionBuilder from "../components/MissionBuilder.vue";
import { optimizeConeRoute } from "../lib/mission-route.mjs";
import {
  buildMissionCreatePayload,
  buildMissionCommandPayload,
  buildMissionPresetDeletePayload,
  buildMissionPresetPayload,
  buildMissionRemainingPayload,
  missionBuilderSubmission,
  missionCommandResponseDecision,
  missionCommandToken,
  missionCommandTokenAfterSync,
  missionCourseId,
  missionDraftMatches,
  missionDraftToken,
  missionEmptyResumeMode,
  missionMotionConfirmedHeld,
  missionNeedsManualRelease,
  missionPathActionDisabled,
  missionPathGeometry,
  missionPreflightCanConfirm,
  missionPreflightDistanceAllowed,
  missionPreflightRouteCheck,
  missionPreflightTarget,
  missionRestoreDecision,
  presetResponseIsCurrent,
  shouldAbandonMissionForCourseSwitch,
  shouldConsumeLegacyMissionIndexEvent,
  trackManualControlRequest,
  waitForManualControlDrain,
} from "../lib/mission-session.mjs";
import { useNotification } from "@shared/useNotification.js";
import { haversine, formatCoord, formatLatLng, formatAlt } from "@lib/geo.mjs";
import { resolveCourseRoute, ROUTE_MODE } from "@lib/route-mode.mjs";
import { buildSideRanks } from "@lib/cone-index.mjs";
import { isAdmin } from "@shared/officialsStore.js";
import { useWhepStream } from "../composables/useWhepStream.js";
import { useMeasureTools } from "../composables/useMeasureTools.js";
import { useCourseImportExport } from "../composables/useCourseImportExport.js";
import { useCourseSnapshots } from "../composables/useCourseSnapshots.js";
import {
  SPRAY_OUTCOME_SYMBOL, SPRAY_OUTCOME_COLOR, DISCONNECT_REASON_LABEL,
  BATTERY_WARN_PERCENT, BATTERY_CRIT_PERCENT, ACTIVE_NAV_STATES,
  FIX_STATUS_META, formatDurationSec, roverFaultRows,
} from "../lib/rover-ui.mjs";
import {
  SIDE_COLORS, coneIcon, highlightIcon, multiSelectIcon,
  coneDiameterForZoom, LabeledConeCanvas,
} from "../lib/cone-render.mjs";

const { success: notifySuccess, error: notifyError, warning: notifyWarn } = useNotification();
const stopping = inject("stopping", ref(false));
const sseReconnecting = inject("sseReconnecting", ref(false));
const appRoverConnected = inject("roverConnected", null);
const appNavState = inject("navState", null);

/* ── State ─────────────────────────────────────────── */
const courses = ref([]);
const conesMap = ref({});
const memosMap = ref({}); // 코스별 메모 스티커: courseId → memo[] { id, course_id, lat, lng, width, height, content }
const routeMap = ref({}); // 코스별 { markers, steps }; steps may repeat marker ids
// 지도가 움직일 때마다 올려서 지리 좌표 고정 메모의 화면 위치·크기를 재계산시키는 트리거.
const mapFrame = ref(0);
const visibility = ref(loadPref("visibility", {}, (v) => JSON.parse(v))); // per-course show/hide, persisted
const activeCourseId = ref(null);
const loading = ref(true);
const newCourseName = ref("");
// Course ZIP export / JSON import lives in a composable; destructured so the
// template keeps using importInput/exportingId/exportCourse/triggerImport/importCourse by name.
const { importInput, exportingId, exportCourse, triggerImport, importCourse } = useCourseImportExport({
  courses, conesMap, memosMap, routeMap, activeCourseId, visibility, newCourseName, courseDirOpts, notifyError,
});
const currentSide = ref("left");
const roverLoading = ref(false);
const editLocked = ref(loadPref("editLocked", true, (v) => v === "true")); // default locked; screen tap/drag can't add/move/rotate/delete cones; persisted
const showCenterline = ref(loadPref("showCenterline", true, (v) => v === "true")); // course centerline graphic; default on; persisted
const routeEditMode = ref(false); // unlocked map taps place reusable route markers
const routeError = ref("");
const routeMode = ref(ROUTE_MODE.AUTO); // which engine produced `centerline`
// Per-course start cone + travel direction live on the server course row
// (course.start_cone_id / course.reverse), shared by every operator and synced
// over the 'courses' SSE broadcast — no longer a per-device localStorage pref.
const centerline = ref(null); // computed centerline of the active course: { ok, closed, length, points } | null
const coneListEl = ref(null);         // cone-list scroll container (for scroll-to-top)
const coneListScrolled = ref(false);  // true once the list is scrolled down a bit
const coneFilter = ref("all");
const CONE_FILTER_LABELS = { all: "전체", left: "L", center: "C", right: "R" };
const coneFilterLabel = computed(() => CONE_FILTER_LABELS[coneFilter.value] || coneFilter.value);

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
  clearRouteMarkers();
  // Null the refs, not just detach: setDeviceMarker treats a non-null marker as
  // "already on the map" and only setLatLng()s it, so leaving a dangling
  // reference means restoreLiveMapLayers() can never re-add it.
  for (const k of ["rover", "receiver"]) {
    if (deviceMarkers[k]) { try { map.removeLayer(deviceMarkers[k]); } catch {} deviceMarkers[k] = null; }
  }
  if (pathLine) { try { map.removeLayer(pathLine); } catch {} }
  if (pathStartMarker) { try { map.removeLayer(pathStartMarker); } catch {} }
  if (pathEndMarker) { try { map.removeLayer(pathEndMarker); } catch {} }
  for (const m of Object.values(sprayMarkers)) { try { map.removeLayer(m); } catch {} }
}
function restoreLiveMapLayers() {
  if (!map) return;
  rebuildAllMarkers();
  rebuildRouteMarkers();
  syncDeviceMarkers(roverStatus.value);
  if (pathStart) renderPath();
  renderSprayMarkers();
}

// NOTE: the tab-swap watch that swaps live ↔ mission map layers lives further
// down in this file, after `activeTab` is declared. Placing it here used to
// trip a TDZ because `activeTab` is a `const` defined below.
const selectedConeId = ref(null);
const multiSelectedIds = ref(new Set());
// Rotate-selection state: a draggable on-map handle spins the whole selection
// around its centroid; rotateAngle is the live delta shown in the HUD (deg, CW+).
const rotateMode = ref(false);
const rotateAngle = ref(0);
const rotateInput = ref(""); // exact-angle text entry (deg, clockwise positive)
const rotateAngleAbs = computed(() => Math.abs(rotateAngle.value).toFixed(1));
const rotateDirIcon = computed(() => (rotateAngle.value < 0 ? "↺" : "↻"));
// Measurement tools — read-only, usable even when edit is locked.
// Ruler/protractor measurement overlays live in a composable; destructured here so
// the template + map click handlers keep referencing toolMode/measureHint/etc. by name.
const { toolMode, measureHint, measureResult, enterToolMode, exitToolMode, resetMeasure, handleMeasureClick } = useMeasureTools({
  getMap: () => map,
  rebuildMarkers: () => rebuildAllMarkers(),
  isCoursesTab: () => activeTab.value === "courses",
  clearOtherModes,
});
// Drop rotate/select/multiselect so an active measurement tool is the exclusive mode.
function clearOtherModes() {
  routeEditMode.value = false;
  if (rotateMode.value) exitRotateMode();
  selectMode.value = false;
  if (multiSelectedIds.value.size > 0) { multiSelectedIds.value = new Set(); updateMultiSelectIcons(); }
  selectedConeId.value = null;
}
// Box-select mode — drag-to-select that also works on touch (no Shift key needed).
const selectMode = ref(false);
// Undo stack of {label, undo} entries; each `undo` reverses one edit via the API.
const undoStack = ref([]);
const editLat = ref("");
const editLng = ref("");
const editSide = ref("left");
// 선택 시점의 좌표 원본. updateCone은 이 값과 다를 때(=조작자가 위치를 실제로 편집)만
// lat/lng를 PATCH해, 선택 후 타 조작자가 SSE로 콘을 옮긴 걸 stale 폼 값으로 되돌리지 않는다.
const editLatOrig = ref("");
const editLngOrig = ref("");
const editingCourseId = ref(null);
const editCourseName = ref("");

// Rover control
const roverMode = ref("none"); // none | path-pick | path-ready | executing | stopped | manual
const pathWaypoints = ref([]);
const missionFinishBehavior = ref("stop");
const showMissionBuilder = ref(false);
const missionBuilderItems = ref([]);
const missionBuilderEditing = ref(false);
const missionBuilderBusy = ref(false);
const missionBuilderBase = ref(null);
const missionPresets = ref([]);
const missionPresetBusy = ref(false);
const pathPresetReference = ref(null);
let missionPresetRequestSeq = 0;
const executedIndex = ref(0);
const pathProgress = ref(0);
const pathDistance = ref(0);
const manualThrottle = ref(0);
const manualSteering = ref(0);
const manualAuthorityReleaseBusy = ref(false);
// Joystick DOM refs: the knob + readout are updated imperatively while dragging
// so a pointermove (≈120Hz on mobile) doesn't re-render this whole component.
const joystickKnobEl = ref(null);
const joystickInfoEl = ref(null);
const pumpBusy = ref(false);

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
  gps: null,
  obstacle: { active: false, at: 0, nearest_m: null },
  stereo_calibration: { status: "idle" },
  ground_calibration: { status: "idle" },
  // GPS-receiver (fsk-rover-gps) sub-state — connected/mode/last_position/base.
  // Populated from the server's rover:status broadcast.
  receiver: null,
  // "receiver" | "rover" | null — which device supplies the live cone-capture
  // position right now. Drives the live marker icon + the source badge/FAB.
  position_source: null,
  // "ngii" | "base" — the rover's configured correction source (server config).
  // Used to warn when base is selected but the receiver isn't connected.
  ntrip_source: "ngii",
  active_mission: null,
  mission_protocol: { required: 2, connected: null, compatible: false, boot_id: null },
});

function syncAppRoverStatus(data) {
  if (!data || typeof data !== "object") return;
  if (appRoverConnected && typeof data.connected === "boolean") {
    appRoverConnected.value = data.connected;
  }
  if (appNavState && typeof data.nav_state === "string") {
    appNavState.value = data.nav_state;
  }
}

// Which device currently supplies the cone-capture position: the GPS receiver
// (preferred), the rover (fallback), or nothing usable. Drives the 3-state
// cone-add button icon and its disabled state.
const positionSource = computed(() => roverStatus.value.position_source || null);
const canCaptureCone = computed(() => positionSource.value != null);
const coneCaptureIcon = computed(() =>
  positionSource.value === "receiver" ? "🛰️"
  : positionSource.value === "rover" ? "🚗"
  : "⚪");
const coneCaptureTitle = computed(() =>
  positionSource.value === "receiver" ? "GPS 수신기 위치로 콘 추가 (수신기 우선 사용 중)"
  : positionSource.value === "rover" ? "로버 GPS 위치로 콘 추가"
  : "GPS 소스 없음 — 수신기 또는 로버 연결 필요");

let manualFailCount = 0;

// sprayResults: Map<globalWaypointIdx, { outcome, at }>
const sprayResults = ref(new Map());
let sprayMarkers = {};

// Pre-flight checklist modal state
const showPreflight = ref(false);
const preflightForce = ref(false);
const preflightMode = ref("execute"); // "execute" | "resume"
const preflightRouteAlreadySynced = ref(false);
const preflightMissionToken = ref(null);
const preflightMissionDraft = ref(null);
const preflightEmptyRouteMode = ref(null);

// Tick ref — bumps every second so time-ago computeds recalc even when no
// new SSE event arrives (otherwise "pos 0s" stays stale when the rover stops).
const uiTick = ref(0);
let uiTickInterval = null;

// Distance from rover's last reported position to the next-target waypoint.
// Only meaningful while a mission is actually being driven.
const currentTargetDistance = computed(() => {
  if (roverMode.value !== "executing") return null;
  const idx = executedIndex.value;
  const lp = roverStatus.value.last_position;
  if (!lp) return null;
  if (pathWaypoints.value.length === 0
      && missionFinishBehavior.value === "return_to_start" && pathStart) {
    return haversine(lp, pathStart);
  }
  if (idx < 0 || idx >= pathWaypoints.value.length) return null;
  return haversine(lp, pathWaypoints.value[idx]);
});

const missionETA = computed(() => {
  if (roverMode.value !== "executing") return null;
  if (pathTotalDist <= 0) return null;
  const speed = roverStatus.value.gps?.speed;
  if (!speed || speed < 0.05) return null;
  const remaining = pathTotalDist * Math.max(0, (100 - pathProgress.value) / 100);
  return formatDurationSec(remaining / speed);
});

// Per-chip computeds. Each chip owns its own tone (ok/warn/bad/neutral) so
// the strip's overall color band is decided separately (primary class).
// `detail` is the multi-line text shown in the hover/click popover.
const fixChip = computed(() => {
  const s = roverStatus.value;
  if (!s.connected) return null;
  // GPS may be down (no fix_status reported). Still show the chip in an error
  // state with the cause in the popover instead of hiding it — a missing chip
  // reads as "no GPS feature" rather than "GPS not working".
  const hasFix = !!s.fix_status;
  const label = hasFix ? s.fix_status.replace(/_/g, " ").toUpperCase() : "NO GPS";
  const meta = hasFix ? (FIX_STATUS_META[s.fix_status] || { tone: "bad" }) : { tone: "bad" };
  // Stale position during an active mission is a hard fail signal — operator
  // needs to see the chip degrade even when the latched fix_status looks fine.
  // 5s warn / 15s bad are aligned with the existing UPDATE-row thresholds in
  // the popover (2s/10s), but raised slightly so brief telemetry hiccups
  // don't flap the strip.
  const age = lastPositionAge.value;
  const exec = roverMode.value === "executing";
  const stale = age != null && (exec ? age >= 5 : age >= 15);
  let tone = meta.tone;
  if (stale && exec && age >= 15) tone = "bad";
  else if (stale) tone = tone === "ok" ? "warn" : tone;
  // [key, value, valTone?] — valTone (optional) colors the value text.
  const rows = [["MODE", label, tone]];
  if (!hasFix) rows.push(["GPS", "NO SIGNAL", "bad"]);
  if (s.last_position?.lat != null && s.last_position?.lng != null) {
    rows.push(["LAT", formatCoord(s.last_position.lat)]);
    rows.push(["LON", formatCoord(s.last_position.lng)]);
  }
  if (s.gps?.altitude != null) rows.push(["ALT", `${formatAlt(s.gps.altitude)} m`]);
  if (lastPositionAge.value != null) {
    const age = lastPositionAge.value;
    const ageT = age <= 2 ? "ok" : age <= 10 ? "warn" : "bad";
    rows.push(["UPDATE", `${age}s`, ageT]);
  }
  if (s.gps?.h_acc != null) {
    const a = s.gps.h_acc;
    const t = a <= 0.05 ? "ok" : a <= 0.5 ? "warn" : "bad";
    rows.push(["ACC", `±${a.toFixed(2)} m`, t]);
  }
  if (s.gps?.v_acc != null) rows.push(["V-ACC", `±${s.gps.v_acc.toFixed(2)} m`]);
  if (s.gps?.speed != null) rows.push(["SPEED", `${s.gps.speed.toFixed(2)} m/s`]);
  if (s.gps?.num_sv != null) {
    const n = s.gps.num_sv;
    const t = n >= 12 ? "ok" : n >= 6 ? "warn" : "bad";
    rows.push(["SAT", `${n}`, t]);
  }
  if (s.gps?.pdop != null) {
    const d = s.gps.pdop;
    const t = d <= 2 ? "ok" : d <= 5 ? "warn" : "bad";
    rows.push(["PDOP", d.toFixed(2), t]);
  }
  if (s.gps?.tdop != null) {
    const d = s.gps.tdop;
    const t = d <= 2 ? "ok" : d <= 5 ? "warn" : "bad";
    rows.push(["TDOP", d.toFixed(2), t]);
  }
  if (s.ntrip_connected) {
    if (s.ntrip?.mountpoint) rows.push(["NTRIP", s.ntrip.mountpoint, "ok"]);
    if (s.ntrip?.host) rows.push(["CASTER", `${s.ntrip.host}${s.ntrip.port ? `:${s.ntrip.port}` : ""}`]);
    if (ntripCorrectionAge.value != null) {
      const c = ntripCorrectionAge.value;
      const t = c <= 2 ? "ok" : c <= 10 ? "warn" : "bad";
      rows.push(["FIXED", `${c}s`, t]);
    }
    if (s.ntrip?.last_error) rows.push(["ERR", s.ntrip.last_error, "bad"]);
  } else {
    rows.push(["NTRIP", "OFF", "bad"]);
  }
  return { label, tone, rows };
});

const navChip = computed(() => {
  const s = roverStatus.value;
  if (!s.connected || !s.nav_state) return null;
  const dist = currentTargetDistance.value;
  const stateLabel = s.nav_state.replace(/_/g, " ");
  const label = (dist != null && dist < 50)
    ? `${stateLabel} · #${executedIndex.value + 1} → ${dist.toFixed(1)}m`
    : stateLabel;
  const tone = (s.nav_state === "ERROR" || s.nav_state === "EMERGENCY_STOP") ? "bad"
    : s.nav_state === "IDLE" ? "neutral"
    : "ok";
  const rows = [["STATUS", stateLabel, tone]];
  if (dist != null) rows.push(["NEXT", `#${executedIndex.value + 1} · ${dist.toFixed(1)} m`]);
  // On a fault, spell out WHY in short English bullets (the operator otherwise
  // only sees "ERROR" while the MCU LED shows the real condition).
  if (s.nav_state === "ERROR" || s.nav_state === "EMERGENCY_STOP") {
    rows.push(...roverFaultRows(s));
  }
  return { label, tone, rows };
});

const batteryChip = computed(() => {
  const s = roverStatus.value;
  if (!s.connected || !s.battery || s.battery.percent == null) return null;
  const p = s.battery.percent;
  const tone = p <= BATTERY_CRIT_PERCENT ? "bad"
    : p <= BATTERY_WARN_PERCENT ? "warn"
    : "ok";
  const rows = [["SOC", `${p}%`, tone]];
  if (s.battery.voltage != null) rows.push(["VOLT", `${s.battery.voltage.toFixed(2)} V`, tone]);
  if (s.battery.voltage_raw != null && s.battery.gain != null && Math.abs(s.battery.gain - 1.0) > 1e-4) {
    rows.push(["ADC", `${s.battery.voltage_raw.toFixed(2)} V`]);
  }
  if (s.battery.gain != null) rows.push(["GAIN", s.battery.gain.toFixed(4)]);
  if (s.battery.calibrated_at) {
    const ago = Math.max(0, Math.round((Date.now() - s.battery.calibrated_at) / 60000));
    rows.push(["FIX", ago < 1 ? "방금" : ago < 60 ? `${ago}분 전` : `${Math.round(ago / 60)}시간 전`]);
  }
  return { percent: p, voltage: s.battery.voltage, tone, rows };
});

// Nav-light pattern selector. Operator picks here; the server persists the
// choice and re-sends it to the rover on (re)connect so it sticks.
const NAV_LIGHT_MODES = [
  { mode: 0, label: "꺼짐", short: "OFF" },
  { mode: 1, label: "상시 점등", short: "STEADY" },
  { mode: 2, label: "더블 스트로브", short: "STROBE2" },
  { mode: 3, label: "1회 스트로브", short: "STROBE1" },
  { mode: 4, label: "50% 점멸", short: "BLINK" },
];
const navLightsChip = computed(() => {
  const s = roverStatus.value;
  if (!s.connected) return null;
  const mode = Number.isInteger(s.nav_lights_mode) ? s.nav_lights_mode : 2;
  return { mode, label: (NAV_LIGHT_MODES[mode] || NAV_LIGHT_MODES[2]).short };
});
const navLightsBusy = ref(false);
async function setNavLights(mode) {
  if (navLightsBusy.value) return;
  navLightsBusy.value = true;
  try {
    await request("/api/rover/nav-lights", { method: "POST", body: JSON.stringify({ mode }) });
    roverStatus.value = { ...roverStatus.value, nav_lights_mode: mode };
    activeChipPopover.value = null;
  } catch (err) {
    notifyError(`nav 라이트 설정 실패: ${err.message}`);
  } finally {
    navLightsBusy.value = false;
  }
}

// Status-LED (TSAL) global brightness 0-255, slider in the 💡 popover.
const ledBrightness = ref(255);
watch(() => roverStatus.value.led_brightness, (v) => {
  if (Number.isInteger(v)) ledBrightness.value = v;
});
let ledBrightnessTimer = null;
function onLedBrightnessInput(val) {
  ledBrightness.value = Number(val);
  if (ledBrightnessTimer) clearTimeout(ledBrightnessTimer);
  ledBrightnessTimer = setTimeout(() => {
    request("/api/rover/led-brightness", {
      method: "POST",
      body: JSON.stringify({ brightness: ledBrightness.value }),
    }).catch((err) => notifyError(`TSAL 밝기 설정 실패: ${err.message}`));
  }, 200);
}

// Peristaltic pump: manual on/off toggle (수동제어 PUMP button) + dispense-time
// slider (분사 시간, in the 💡 popover). Both mirror server rover status.
const pumpOn = computed(() => roverStatus.value.pump_on === true);
const pumpDuration = ref(2.0);
watch(() => roverStatus.value.pump_run_duration, (v) => {
  if (typeof v === "number" && v > 0) pumpDuration.value = v;
});
let pumpDurationTimer = null;
function onPumpDurationInput(val) {
  pumpDuration.value = Number(val);
  if (pumpDurationTimer) clearTimeout(pumpDurationTimer);
  pumpDurationTimer = setTimeout(() => {
    request("/api/rover/pump-duration", {
      method: "POST",
      body: JSON.stringify({ seconds: pumpDuration.value }),
    }).catch((err) => notifyError(`분사 시간 설정 실패: ${err.message}`));
  }, 200);
}

const missionChip = computed(() => {
  if (roverMode.value !== "executing" && roverMode.value !== "stopped") return null;
  const returnOnly = pathWaypoints.value.length === 0
    && missionFinishBehavior.value === "return_to_start"
    && pathStart && pathReturnOrigin;
  if (pathWaypoints.value.length === 0 && !returnOnly) return null;
  const lines = [returnOnly
    ? `최초 미션 시작점 복귀: ${pathProgress.value}%`
    : `미션 진행: ${executedIndex.value} / ${pathWaypoints.value.length} (${pathProgress.value}%)`];
  if (remainingDistanceM.value != null) {
    lines.push(`남은 거리: ${remainingDistanceM.value >= 1000
      ? (remainingDistanceM.value / 1000).toFixed(2) + " km"
      : remainingDistanceM.value.toFixed(1) + " m"}`);
  }
  if (missionETA.value) lines.push(`예상 완료: ${missionETA.value} 후`);
  if (roverStatus.value.gps?.speed != null) lines.push(`현재 속도: ${roverStatus.value.gps.speed.toFixed(2)} m/s`);
  return {
    current: returnOnly ? 0 : executedIndex.value,
    total: returnOnly ? 0 : pathWaypoints.value.length,
    percent: pathProgress.value,
    eta: missionETA.value,
    returnOnly,
    detail: lines.join("\n"),
  };
});

// Which chip is currently showing its popover via click (mobile-friendly).
const activeChipPopover = ref(null);
// On mobile the strip is overflow-x: auto, which clips absolutely-positioned
// popovers — promote to position: fixed against the chip's viewport rect.
const popoverPos = ref(null);
const popoverStyle = computed(() => {
  if (!popoverPos.value) return null;
  return {
    position: "fixed",
    top: `${popoverPos.value.top}px`,
    left: `${popoverPos.value.left}px`,
  };
});

function toggleChipPopover(key, e) {
  if (activeChipPopover.value === key) {
    activeChipPopover.value = null;
    popoverPos.value = null;
    return;
  }
  if (isMobile.value && e?.currentTarget) {
    const rect = e.currentTarget.getBoundingClientRect();
    const maxLeft = window.innerWidth - 360 - 8;
    popoverPos.value = {
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, Math.max(8, maxLeft))),
    };
  } else {
    popoverPos.value = null;
  }
  activeChipPopover.value = key;
}
function onGlobalClickForChips(e) {
  if (!e.target.closest(".chip-wrapper")) {
    activeChipPopover.value = null;
    popoverPos.value = null;
  }
}
function onGlobalKeyForChips(e) {
  if (e.key === "Escape") {
    activeChipPopover.value = null;
    popoverPos.value = null;
  }
}

const disconnectInfo = computed(() => {
  uiTick.value;
  const s = roverStatus.value;
  if (s.connected) return null;
  const label = DISCONNECT_REASON_LABEL[s.last_disconnect_reason] || s.last_disconnect_reason || "UNKNOWN";
  let ago = null;
  if (s.last_disconnect_at) {
    const sec = Math.max(0, Math.round((Date.now() - s.last_disconnect_at) / 1000));
    if (sec < 60) ago = `${sec}s`;
    else {
      const m = Math.floor(sec / 60);
      const rs = sec % 60;
      ago = rs === 0 ? `${m}m` : `${m}m ${rs}s`;
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

// Inspector (desktop right panel). Rover control and mission history are
// admin-only; chief sees only the 코스 (cone-editing) tab. The backend enforces
// the same split — /api/rover/* and /api/missions/* require admin.
const INSPECTOR_TABS = [
  { key: "rover", label: "로버", icon: "🚗", adminOnly: true },
  { key: "gps", label: "GPS", icon: "🛰️", adminOnly: true },
  { key: "courses", label: "코스", icon: "📋" },
  { key: "history", label: "기록", icon: "📊", adminOnly: true },
];
const visibleTabs = computed(() => INSPECTOR_TABS.filter((t) => isAdmin.value || !t.adminOnly));

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

const MISSION_STATUS_LABEL = { running: "진행 중", paused: "일시정지", interrupted: "중단됨", completed: "완료", stopped: "정지됨", error: "오류" };
const MISSION_STATUS_COLOR = { running: "#3b82f6", paused: "#a855f7", interrupted: "#f97316", completed: "#22c55e", stopped: "#f59e0b", error: "#ef4444" };

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
  } catch (err) { notifyError(err.message); }
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
  } catch (err) { notifyError(err.message); }
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
  } catch (err) { notifyError(err.message); }
}

// Mission map layers — kept separate from the live cone/rover layers so
// switching tabs is a clean swap instead of overlapping paint.
let missionPlannedMarkers = [];
let missionPlannedPath = null;
let missionActualPath = null;
let centerlineLayer = null;   // Leaflet layer group drawing the active course centerline
let routeMarkerLayers = [];   // reusable ordered-route markers for the active course
let centerlineTimer = null;   // debounce handle for recompute
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
  // Planned waypoints (one per cone on the spray path) render to the shared
  // cone canvas instead of a DOM marker each, so a course with many cones stays
  // smooth on pan/zoom — same approach as the live cone dots (coneCircle).
  waypoints.forEach((wp, i) => {
    const marker = L.circleMarker([wp.lat, wp.lng], {
      renderer: coneRenderer,
      radius: 9,
      color: "#fff",
      weight: 2,
      fillColor: "#8b5cf6",
      interactive: false,
      label: i + 1,
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
const activeTab = ref((() => {
  let v = loadPref("activeTab", "courses");
  // Migrate stale tab keys from the pre-merge layout.
  if (v === "cones") v = "courses";
  if (v === "logs" || v === "missions") v = "history";
  // Rover/history are admin-only — a non-admin (chief) only ever lands on 코스,
  // even if a stale localStorage pref from a prior admin session says otherwise.
  if (!isAdmin.value && v !== "courses") v = "courses";
  return v;
})());
const historyView = ref(loadPref("historyView", "missions"));
const inspectorWidth = ref(Math.max(280, Math.min(Number(loadPref("inspectorWidth", 360, Number)), 600)));
const inspectorResizing = ref(false);
// Map rotation (leaflet-rotate). 90° steps only, persisted, shared by all tabs
// (one map instance). Snapped to {0,90,180,270} so the button always lands on a
// clean quarter-turn after a reload.
const mapBearing = ref(((Number(loadPref("mapBearing", 0, Number)) % 360) + 360) % 360);

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
watch(historyView, (v) => savePref("historyView", v));

// The modal owns another rotated satellite map. Suspend painting the covered
// main map while it is open, then refresh its viewport once after teardown.
// State/SSE updates still land on the same main map instance throughout.
watch(showMissionBuilder, (open) => {
  if (!map) return;
  if (open) {
    map.stop();
    return;
  }
  nextTick(() => {
    if (map) map.invalidateSize({ pan: false, animate: false });
  });
});

// Cone draggability is gated on the courses tab — rebuild markers when
// crossing that boundary. Skip missions transitions; isMissionsView owns those.
watch(activeTab, (next, prev) => {
  if (!map) return;
  // Leaving the editing tab tears down its rotate/measure/select overlays.
  if (prev === "courses" && next !== "courses") {
    if (rotateMode.value) exitRotateMode();
    if (toolMode.value !== "none") exitToolMode();
    selectMode.value = false;
    routeEditMode.value = false;
  }
  const prevWasMissions = prev === "history" && historyView.value === "missions";
  const nextIsMissions = next === "history" && historyView.value === "missions";
  if (prevWasMissions || nextIsMissions) return;
  if ((next === "courses") !== (prev === "courses")) {
    rebuildAllMarkers();
    rebuildRouteMarkers();
  }
});
watch(inspectorWidth, (v) => savePref("inspectorWidth", v));

/* ── GPS 관리 (수신기 소스 선택 + base station 측량점) ─────────────────── */
const gpsConfig = ref({ ntrip_source: "ngii", active_base_point_id: null });
const surveyPoints = ref([]);
const gpsSaving = ref(false);
const newSurveyName = ref("");
const surveyDuration = ref(60); // fixed base-station survey window (no UI selector)
const selectedBasePointId = ref(null);
// Survey point whose card the operator tapped to center the map on it (list
// highlight). Cleared when its point disappears from the list.
const selectedSurveyPointId = ref(null);

// 수신기 상태 편의 접근자 (rover:status의 receiver 서브블록).
const receiver = computed(() => roverStatus.value.receiver || null);
const receiverConnected = computed(() => !!receiver.value?.connected);
const baseState = computed(() => receiver.value?.base?.state || "idle");
const surveyingPointId = computed(() =>
  baseState.value === "surveying" ? (receiver.value?.base?.point_id ?? null) : null);

// Live survey progress (1Hz via uiTick) from receiver.base.survey — elapsed /
// remaining / percent of the survey window. null when not surveying.
const surveyProgress = computed(() => {
  uiTick.value;
  const s = receiver.value?.base?.survey;
  if (!s || !s.started_at || !s.duration_s) return null;
  const elapsed = Math.max(0, (Date.now() - s.started_at) / 1000);
  return {
    pct: Math.min(100, Math.round((elapsed / s.duration_s) * 100)),
    remaining: Math.max(0, Math.ceil(s.duration_s - elapsed)),
    elapsed: Math.floor(elapsed),
    duration: s.duration_s,
    samples: s.samples ?? 0,
  };
});

// Receiver position / NTRIP-correction ages (1Hz via uiTick), mirroring the
// rover's lastPositionAge / ntripCorrectionAge for the UPDATE / FIXED rows.
const receiverPositionAge = computed(() => {
  uiTick.value;
  const at = receiver.value?.last_position_at;
  if (!at) return null;
  return Math.max(0, Math.round((Date.now() - at) / 1000));
});
const receiverCorrectionAge = computed(() => {
  uiTick.value;
  const n = receiver.value?.ntrip;
  if (!n?.last_correction_at) return null;
  return Math.max(0, Math.round(Date.now() / 1000 - n.last_correction_at));
});

// Receiver GPS detail — the SAME rows, order, and value tones as the rover's
// fix-chip popover, rendered inline with the popover's key/value grid style. The
// only receiver-specific difference: NTRIP is skipped in base mode (a fixed base
// generates its own corrections rather than pulling a caster).
const receiverGpsRows = computed(() => {
  const r = receiver.value;
  const connected = !!r?.connected;
  // Device (network) connection as the first row — same grid style as the GPS rows.
  const rows = [["DEVICE", connected ? "ONLINE" : "OFFLINE", connected ? "ok" : "bad"]];
  if (!connected || !r) return rows;
  const g = r.gps || {};
  const hasFix = !!r.fix_status;
  rows.push(["MODE", hasFix ? r.fix_status.replace(/_/g, " ").toUpperCase() : "NO GPS",
    hasFix ? (FIX_STATUS_META[r.fix_status]?.tone || "bad") : "bad"]);
  if (!hasFix) rows.push(["GPS", "NO SIGNAL", "bad"]);
  if (r.last_position?.lat != null && r.last_position?.lng != null) {
    rows.push(["LAT", formatCoord(r.last_position.lat)]);
    rows.push(["LON", formatCoord(r.last_position.lng)]);
  }
  if (g.altitude != null) rows.push(["ALT", `${formatAlt(g.altitude)} m`]);
  if (receiverPositionAge.value != null) {
    const a = receiverPositionAge.value;
    rows.push(["UPDATE", `${a}s`, a <= 2 ? "ok" : a <= 10 ? "warn" : "bad"]);
  }
  if (g.h_acc != null) { const a = g.h_acc; rows.push(["ACC", `±${a.toFixed(2)} m`, a <= 0.05 ? "ok" : a <= 0.5 ? "warn" : "bad"]); }
  if (g.v_acc != null) rows.push(["V-ACC", `±${g.v_acc.toFixed(2)} m`]);
  if (g.speed != null) rows.push(["SPEED", `${g.speed.toFixed(2)} m/s`]);
  if (g.num_sv != null) { const n = g.num_sv; rows.push(["SAT", `${n}`, n >= 12 ? "ok" : n >= 6 ? "warn" : "bad"]); }
  if (g.pdop != null) { const d = g.pdop; rows.push(["PDOP", d.toFixed(2), d <= 2 ? "ok" : d <= 5 ? "warn" : "bad"]); }
  if (g.tdop != null) { const d = g.tdop; rows.push(["TDOP", d.toFixed(2), d <= 2 ? "ok" : d <= 5 ? "warn" : "bad"]); }
  if (r.mode !== "base") {
    if (r.ntrip_connected) {
      if (r.ntrip?.mountpoint) rows.push(["NTRIP", r.ntrip.mountpoint, "ok"]);
      if (r.ntrip?.host) rows.push(["CASTER", `${r.ntrip.host}${r.ntrip.port ? `:${r.ntrip.port}` : ""}`]);
      if (receiverCorrectionAge.value != null) {
        const c = receiverCorrectionAge.value;
        rows.push(["FIXED", `${c}s`, c <= 2 ? "ok" : c <= 10 ? "warn" : "bad"]);
      }
      if (r.ntrip?.last_error) rows.push(["ERR", r.ntrip.last_error, "bad"]);
    } else {
      rows.push(["NTRIP", "OFF", "bad"]);
    }
  }
  return rows;
});
// Only surveyed points (with recorded coordinates) can serve as a base station.
const surveyedPoints = computed(() => surveyPoints.value.filter((p) => p.lat != null && p.lng != null));
const hasSurveyedPoint = computed(() => surveyedPoints.value.length > 0);

// Base source selected but the receiver isn't connected → the rover suppresses
// NGII yet no base RTCM flows, so it silently drops from RTK-fixed to standalone.
// Surface it loudly: a persistent GPS-tab banner + a toast when it first happens.
const baseNoReceiver = computed(() =>
  roverStatus.value.ntrip_source === "base" && !(roverStatus.value.receiver?.connected));
watch(baseNoReceiver, (now, prev) => {
  // Admin-only feature: only the operator who can set/fix the base source should
  // get this toast (the persistent banner lives in the admin GPS tab anyway).
  if (now && !prev && isAdmin.value) {
    notifyWarn("GPS 수신기가 연결되지 않았습니다. 로버에 RTK 보정이 전달되지 않습니다.");
  }
});

// Keep the base-point dropdown pinned to the configured active point, else the
// first surveyed point, so switching to "base" always has a valid selection.
watch([gpsConfig, surveyedPoints], () => {
  if (gpsConfig.value.active_base_point_id != null) {
    selectedBasePointId.value = gpsConfig.value.active_base_point_id;
  } else if (selectedBasePointId.value == null && surveyedPoints.value.length) {
    selectedBasePointId.value = surveyedPoints.value[0].id;
  }
}, { deep: true });

async function loadGps() {
  try {
    const [cfgRes, spRes] = await Promise.all([
      request("/api/gps/config"),
      request("/api/gps/survey-points"),
    ]);
    gpsConfig.value = await cfgRes.json();
    surveyPoints.value = (await spRes.json()).points || [];
  } catch (err) {
    notifyError(err.message || "GPS 설정을 불러오지 못했습니다.");
  }
}

async function setNtripSource(source, pointId = null) {
  const body = { ntrip_source: source };
  if (source === "base") {
    const pid = pointId != null ? pointId : (selectedBasePointId.value ?? gpsConfig.value.active_base_point_id);
    if (pid == null) { notifyError("먼저 측량점을 선택하세요."); return; }
    body.active_base_point_id = pid;
  }
  gpsSaving.value = true;
  try {
    const res = await request("/api/gps/config", { method: "PUT", body: JSON.stringify(body) });
    gpsConfig.value = await res.json();
    notifySuccess(source === "base" ? "수신기를 기준국으로 설정했습니다." : "NGII 보정 소스로 전환했습니다.");
  } catch (err) {
    notifyError(err.message || "GPS 소스 변경에 실패했습니다.");
  } finally {
    gpsSaving.value = false;
  }
}

async function addSurveyPoint() {
  const name = newSurveyName.value.trim();
  if (!name) return;
  try {
    await request("/api/gps/survey-points", { method: "POST", body: JSON.stringify({ name }) });
    newSurveyName.value = "";
    await loadGps();
  } catch (err) {
    notifyError(err.message || "측량점 추가에 실패했습니다.");
  }
}

async function deleteSurveyPoint(p) {
  if (!window.confirm(`측량점 "${p.name}"을(를) 삭제할까요?`)) return;
  try {
    await request(`/api/gps/survey-points/${p.id}`, { method: "DELETE" });
    if (selectedSurveyPointId.value === p.id) selectedSurveyPointId.value = null;
    await loadGps();
  } catch (err) {
    notifyError(err.message || "측량점 삭제에 실패했습니다.");
  }
}

async function startSurvey(p) {
  try {
    await request(`/api/gps/survey-points/${p.id}/survey`, {
      method: "POST",
      body: JSON.stringify({ duration_s: surveyDuration.value }),
    });
    notifySuccess(`"${p.name}" 측량을 시작했습니다.`);
  } catch (err) {
    notifyError(err.message || "측량 시작에 실패했습니다.");
  }
}

async function cancelSurvey(p) {
  try {
    await request(`/api/gps/survey-points/${p.id}/survey/cancel`, { method: "POST" });
  } catch (err) {
    notifyError(err.message || "측량 취소에 실패했습니다.");
  }
}

// Auto-refresh (no manual button): reload on survey completion, on receiver
// (re)connect, and on GPS-tab entry — whenever state relevant to the tab changes.
watch(baseState, (now, prev) => {
  // Admin-only: base.state rides rover:status to every operator, but loadGps()
  // hits admin-only /api/gps/* (a non-admin would just get 403 + an error toast).
  if (prev === "surveying" && now !== "surveying" && isAdmin.value) loadGps();
});
watch(receiverConnected, (now, prev) => {
  if (now && !prev && activeTab.value === "gps" && isAdmin.value) loadGps();
});
watch(activeTab, (v) => { if (v === "gps" && isAdmin.value) loadGps(); });

// Tab-swap: hide live layers when entering the missions sub-view of the
// history tab, tear down replay state and restore the live view when leaving.
const isMissionsView = computed(
  () => activeTab.value === "history" && historyView.value === "missions"
);
watch(isMissionsView, (next, prev) => {
  if (next === prev || !map) return;
  if (prev) {
    stopReplay();
    clearMissionMap();
    selectedMissionId.value = null;
    missionDetail.value = null;
    missionSamples.value = [];
    restoreLiveMapLayers();
  }
  if (next) {
    hideLiveMapLayers();
    loadMissions();
  }
});

// Redraw the GPS-tab survey-point markers whenever their coordinates, the active
// base, the list selection, the active tab, or the missions view change. Placed
// after isMissionsView's declaration to avoid the TDZ noted at the top of file.
watch(
  [surveyedPoints, () => gpsConfig.value, selectedSurveyPointId, activeTab, isMissionsView],
  () => renderSurveyPoints(),
);

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

// Cap so the sheet can't slide up past the status-strip; remeasured every
// drag in case chip-row wrapping changed the strip's height.
function maxSheetHeight() {
  const strip = document.querySelector(".status-strip");
  const rail = document.querySelector(".rail");
  if (!strip || !rail) return window.innerHeight * 0.85;
  const stripBottom = strip.getBoundingClientRect().bottom;
  const railTop = rail.getBoundingClientRect().top;
  const gap = 8;
  return Math.max(52, railTop - stripBottom - gap);
}

function onSheetTouchStart(e) {
  // Cancel the touch's default action so the browser doesn't emit the
  // compatibility mouse/click ("ghost click") for this tap. Without this, a
  // tap-to-expand fires a synthetic click at the original touch point AFTER the
  // sheet has grown — landing on whatever course/cone list row now sits there
  // and selecting it. (A drag is already covered by preventDefault in touchmove.)
  if (e.cancelable) e.preventDefault();
  dragStartY = e.touches[0].clientY;
  dragStartHeight = sheetHeight.value;
  wasDrag = false;
}

function onSheetTouchMove(e) {
  const dy = dragStartY - e.touches[0].clientY;
  if (!wasDrag && Math.abs(dy) > 5) { wasDrag = true; sheetDragging.value = true; }
  if (!wasDrag) return;
  e.preventDefault();
  sheetHeight.value = Math.min(Math.max(52, dragStartHeight + dy), maxSheetHeight());
}

function onSheetTouchEnd() {
  sheetDragging.value = false;
  if (!wasDrag) {
    // tap → toggle (capped same as drag so it can't cover the chip bar)
    sheetHeight.value = sheetHeight.value <= 52
      ? Math.min(window.innerHeight * 0.5, maxSheetHeight())
      : 52;
  } else if (sheetHeight.value < 100) {
    sheetHeight.value = 52;
  }
  sheetExpanded.value = sheetHeight.value > 52;
}

let map = null;
let markers = {};
// One live marker per device — the rover (purple) and the GPS receiver (teal) —
// so BOTH show at once when both are connected. position_source still governs
// cone-capture priority and which one follow tracks.
let deviceMarkers = { rover: null, receiver: null };
let surveyPointLayer = null;   // L.layerGroup of surveyed base-station point markers (GPS tab only)
let pathLine = null;
let pathStartMarker = null;
let pathEndMarker = null;
let pathStart = null; // { lat, lng } — preserved across compute/execute/resume for re-rendering
let pathReturnOrigin = null; // fixed origin for an empty return-only leg; never chase live GPS while rendering
let pathCumDist = []; // cumulative distance to each waypoint from start (length = pathWaypoints.value.length)
let pathTotalDist = 0; // total distance including return-to-start segment
let executionStartIdx = 0; // global waypoint index the current execute/resume call started from
let displayedMissionId = null;
let pathMissionBase = null;
let localMissionCreatePending = false;
let eventSource = null;
let controlInterval = null;
const pendingManualControlRequests = new Set();
let suppressRebuild = false;
let coneRenderer = null;       // shared <canvas> renderer for cone dots (rover/history tabs)
let followTimer = null;        // throttle handle: at most one follow-pan per FOLLOW_MIN_MS
let followTarget = null;       // latest { lat, lng } to recentre on
let followLastPan = 0;         // timestamp of the last follow-pan
const FOLLOW_MIN_MS = 150;     // cap follow-pans to ~6-7/s — each pan redraws the cone canvas
let isMultiDragging = false;
let dragStartPositions = null;
let dragOrigin = null;
let justFinishedBoxSelect = false;

// Rotate-selection layers + drag bookkeeping. Rotation is done in container-pixel
// space (Web Mercator is locally conformal) so the on-screen shape is preserved
// exactly; the rotated pixel points are converted back to lat/lng on commit.
let rotatePivot = null;          // L.latLng centroid of the selection
let rotatePivotMarker = null;
let rotateHandleMarker = null;
let rotateLine = null;           // pivot → handle guide line
let rotateStartVectors = null;   // Map<id, {x,y}> cone offset from pivot (px) at drag start
let rotateStartPositions = null; // Map<id, {lat,lng}> for rollback on save failure
let rotateStartBearing = 0;      // pivot→handle bearing (rad) at drag start
const ROTATE_RADIUS_PX = 72;     // resting screen distance of the handle from the pivot


// Visible-area center of the map: container center on desktop (sibling
// layout), but on mobile the inspector overlays the bottom of the
// viewport, so we shorten the visible region accordingly.
function getVisibleMapCenter() {
  if (!map) return null;
  const mapEl = map.getContainer();
  if (!mapEl) return null;
  const rect = mapEl.getBoundingClientRect();
  let cy = rect.height / 2;
  if (isMobile.value) {
    const insEl = document.querySelector(".inspector");
    if (insEl) {
      const insRect = insEl.getBoundingClientRect();
      const overlapTop = Math.max(rect.top, insRect.top);
      if (overlapTop > rect.top) cy = (overlapTop - rect.top) / 2;
    }
  }
  return L.point(rect.width / 2, cy);
}

// Keep whatever is at the visible-area center pinned across drawer /
// inspector resizes. flush:'pre' lets us read the OLD layout (and so the
// OLD visible-center lat/lng) before Vue applies the new width/height,
// then nextTick reapplies after the DOM is patched.
watch([inspectorWidth, sheetHeight, isMobile], () => {
  if (!map) return;
  const beforePx = getVisibleMapCenter();
  if (!beforePx) return;
  const anchor = map.containerPointToLatLng(beforePx);
  nextTick(() => {
    if (!map) return;
    map.invalidateSize({ pan: false });
    const afterPx = getVisibleMapCenter();
    if (!afterPx) return;
    const curPx = map.latLngToContainerPoint(anchor);
    const dx = curPx.x - afterPx.x;
    const dy = curPx.y - afterPx.y;
    if (dx !== 0 || dy !== 0) map.panBy([dx, dy], { animate: false });
  });
}, { flush: "pre" });

/* ── Computed ──────────────────────────────────────── */
const activeCourse = computed(() => courses.value.find((c) => c.id === activeCourseId.value));
const activeMission = computed(() => roverStatus.value.active_mission || null);
const missionHeld = computed(() => missionMotionConfirmedHeld(activeMission.value));
const emergencyStopLatched = computed(() =>
  roverStatus.value.nav_state === "EMERGENCY_STOP" || roverStatus.value.stop_requested === true);
const pathButtonDisabled = computed(() => missionPathActionDisabled({
  activeConeCount: activeCones.value.length,
  activeMission: activeMission.value,
  roverMode: roverMode.value,
  stopping: stopping.value,
  emergencyStopped: emergencyStopLatched.value,
}));

const pathBtnLabel = computed(() => {
  // 글로벌 비상정지 래치가 잡혀 있는 동안에는 모든 미션 버튼이 정지 명령이
  // 텔레메트리로 확인될 때까지 같은 상태로 보여야 운영자가 두 버튼을 보고
  // 모순된 단계로 오해하지 않는다.
  if (stopping.value && (roverMode.value === "executing" || roverMode.value === "stopped")) {
    return "정지 요청 중...";
  }
  if (emergencyStopLatched.value && (roverMode.value === "stopped" || roverMode.value === "path-ready")) {
    return "비상정지 해제 필요";
  }
  if (roverMode.value === "executing") {
    // 일시정지 중에는 메인 버튼이 상태만 표시하고, 재개는 전용 버튼이 담당.
    if (roverStatus.value.nav_state === "PAUSED") return "일시정지됨";
    // executePath 직후 nav_state 가 IDLE 인 ~수초 동안은 0% 가 아니라 "시작
    // 요청 중..." 으로 노출. rover 가 CALIBRATING 으로 들어가면 화해 함수가
    // 진행률 라벨을 자동 갱신.
    if (!ACTIVE_NAV_STATES.has(roverStatus.value.nav_state)) return "시작 요청 중...";
    return `실행 중 ${pathProgress.value}%`;
  }
  if (roverMode.value === "stopped") return activeMission.value?.status === "ready" ? "미션 시작" : "이어서 실행";
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
  const wps = pathWaypoints.value;
  // Resume always starts at the first server-authoritative pending occurrence;
  // an empty return-only mission instead checks the current-to-start leg, while
  // an uncertainty resolution explicitly performs no motion.
  const targetDecision = missionPreflightTarget({
    mode: preflightMode.value,
    waypoints: wps,
    finishBehavior: missionFinishBehavior.value,
    missionStart: activeMission.value?.start_position,
    emptyRouteMode: preflightEmptyRouteMode.value,
  });
  const first = targetDecision.target;
  const firstDist = first && s.last_position
    ? haversine({ lat: s.last_position.lat, lng: s.last_position.lng }, first)
    : null;
  const batteryOk = !s.battery || s.battery.percent == null || s.battery.percent > BATTERY_WARN_PERCENT;
  const resolvingUncertain = targetDecision.kind === "resolve_uncertain";
  const returningOnly = targetDecision.kind === "return_only";
  const routeCheck = missionPreflightRouteCheck({
    mode: preflightMode.value === "execute" ? "execute" : "resume",
    waypoints: wps,
    finishBehavior: missionFinishBehavior.value,
    returnPoint: activeMission.value?.start_position || s.last_position,
  });
  return [
    { key: "connected", label: "로버 SSE 연결", ok: !!s.connected, blocking: true },
    { key: "estop", label: "비상정지 해제", ok: !emergencyStopLatched.value, blocking: true,
      detail: emergencyStopLatched.value ? "비상정지가 래치되어 있습니다. 먼저 물리 상태를 확인하고 해제하세요." : "해제됨" },
    { key: "protocol", label: "미션 프로토콜 v2", ok: s.mission_protocol?.compatible === true, blocking: true,
      detail: s.mission_protocol?.connected == null
        ? "버전 미수신"
        : `rover v${s.mission_protocol.connected} / required v${s.mission_protocol.required}` },
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
    { key: "firstwp", label: resolvingUncertain ? "불확실 분사 결과 해소"
      : (returningOnly ? "시작점 복귀 거리" : "첫 웨이포인트 거리"),
      ok: missionPreflightDistanceAllowed({ kind: targetDecision.kind, distance: firstDist }),
      detail: resolvingUncertain ? "추가 이동·재분사 없이 운영자가 결과 불확실성을 해소합니다."
        : (firstDist != null ? `${firstDist.toFixed(1)} m${returningOnly ? " · 최초 미션 시작점" : ""}` : "위치 미수신") },
    { key: "route", label: "경로 구간 거리", ok: routeCheck.ok,
      detail: routeCheck.ok ? "모든 구간 50 m 이내"
        : (Number.isFinite(routeCheck.distance)
          ? `${routeCheck.reason === "return_segment_too_long" ? "복귀 구간" : `${routeCheck.index + 1}번 콘까지`} ${routeCheck.distance.toFixed(1)} m`
          : "경로 좌표 확인 필요") },
    { key: "battery", label: "배터리", ok: batteryOk,
      detail: s.battery && s.battery.percent != null ? `${s.battery.percent}%` : "미수신" },
  ];
});
const preflightAllOk = computed(() => preflightChecks.value.every((c) => c.ok));
const preflightHasBlockingFailure = computed(() =>
  preflightChecks.value.some((check) => check.blocking === true && !check.ok));
const preflightCanConfirm = computed(() =>
  missionPreflightCanConfirm(preflightChecks.value, preflightForce.value));

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
    if (c.blocking === true && !c.ok) preflightForce.value = false;
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

// 메모는 콘 숨김(visibility)과 무관하다 — 코스가 선택돼 있으면 항상 그린다.
const activeMemos = computed(() => {
  const id = activeCourseId.value;
  if (!id) return [];
  return memosMap.value[id] || [];
});

const activeRoute = computed(() => routeMap.value[activeCourseId.value] || { markers: [], steps: [] });
const routeMarkerById = computed(() => new Map(activeRoute.value.markers.map((marker) => [marker.id, marker])));
// Two or more visits mean the markers, not the stored course row, decide the
// start and the travel direction — whether they merely orient the loop or need
// the marker router. `routeMode` records which of the two actually ran.
const hasMarkerRoute = computed(() => activeRoute.value.steps.length >= 2);
// An oriented route is still the automatic centerline; only saying "마커 경로"
// there would suggest the marker router drew it.
const ROUTE_MODE_LABEL = {
  [ROUTE_MODE.AUTO]: "자동 중심선",
  [ROUTE_MODE.ORIENTED]: "자동 중심선 · 마커 기준",
  [ROUTE_MODE.GUIDED]: "마커 경로",
};
const routeModeLabel = computed(() => ROUTE_MODE_LABEL[routeMode.value] || ROUTE_MODE_LABEL[ROUTE_MODE.AUTO]);
const ROUTE_MODE_SUFFIX = {
  [ROUTE_MODE.AUTO]: "",
  [ROUTE_MODE.ORIENTED]: " · 마커 기준",
  [ROUTE_MODE.GUIDED]: " · 마커 경로",
};
const routeModeSuffix = computed(() => ROUTE_MODE_SUFFIX[routeMode.value] ?? "");

async function fetchRoute(courseId) {
  if (!courseId) return;
  try {
    const res = await request(`/api/courses/${courseId}/route`);
    routeMap.value[courseId] = await res.json();
  } catch (err) {
    notifyError(err.message);
  }
}

async function addRouteMarker(lat, lng) {
  const courseId = activeCourseId.value;
  if (!courseId) return;
  try {
    const n = activeRoute.value.markers.length + 1;
    await request(`/api/courses/${courseId}/route/markers`, {
      method: "POST",
      body: JSON.stringify({ lat, lng, label: `M${n}` }),
    });
    await fetchRoute(courseId);
  } catch (err) { notifyError(err.message); }
}

async function updateRouteMarker(marker, patch) {
  try {
    await request(`/api/route/markers/${marker.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    await fetchRoute(marker.course_id);
  } catch (err) {
    notifyError(err.message);
    const current = routeMap.value[marker.course_id] || { markers: [], steps: [] };
    routeMap.value[marker.course_id] = { markers: current.markers.map((item) => ({ ...item })), steps: current.steps.slice() };
  }
}

async function deleteRouteMarker(marker) {
  if (!confirm(`주행 마커 "${marker.label || marker.id}"와 모든 방문 단계를 삭제하시겠습니까?`)) return;
  try {
    const res = await request(`/api/route/markers/${marker.id}`, { method: "DELETE" });
    routeMap.value[marker.course_id] = await res.json();
  } catch (err) { notifyError(err.message); }
}

async function saveRouteSteps(steps) {
  const courseId = activeCourseId.value;
  if (!courseId) return;
  try {
    const res = await request(`/api/courses/${courseId}/route/steps`, {
      method: "PUT", body: JSON.stringify({ steps }),
    });
    routeMap.value[courseId] = await res.json();
  } catch (err) { notifyError(err.message); }
}

function appendRouteVisit(markerId) {
  saveRouteSteps([...activeRoute.value.steps, markerId]);
}

function moveRouteVisit(index, delta) {
  const steps = activeRoute.value.steps.slice();
  const target = index + delta;
  if (target < 0 || target >= steps.length) return;
  [steps[index], steps[target]] = [steps[target], steps[index]];
  saveRouteSteps(steps);
}

function removeRouteVisit(index) {
  const steps = activeRoute.value.steps.slice();
  steps.splice(index, 1);
  saveRouteSteps(steps);
}

function toggleRouteEditMode() {
  if (editLocked.value) return;
  const next = !routeEditMode.value;
  clearOtherModes();
  routeEditMode.value = next;
}

// EPSG:3857(웹 메르카토르) 기준 위도별 m/px 해상도. 회전과 무관한 스칼라라
// leaflet-rotate 상태에서도 m↔px 변환이 정확하다.
function metersPerPixel(lat) {
  return (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) / Math.pow(2, map.getZoom() + 8);
}

// 메모 스티커의 화면상 위치(중심 좌표)·크기(m→px)를 현재 지도 상태로 계산한다.
// mapFrame을 읽어 지도 이동/줌/회전 때마다 다시 평가된다. 중심 정렬은 CSS translate.
function memoStyle(m) {
  void mapFrame.value; // 반응성 의존성 등록
  if (!map) return { display: "none" };
  const pt = map.latLngToContainerPoint([m.lat, m.lng]); // 회전 반영된 화면 좌표
  const mpp = metersPerPixel(m.lat);
  const wpx = m.width / mpp;
  const hpx = m.height / mpp;
  // 글씨도 라벨 크기(=줌)에 맞춰 스케일한다 — 고정 px면 줌아웃 때 라벨은 작아지는데
  // 글씨는 그대로라 잘린다. 높이·너비에 비례시키고 상·하한만 둔다.
  const fontPx = Math.max(8, Math.min(hpx * 0.5, wpx * 0.6, 40));
  return {
    left: `${pt.x}px`,
    top: `${pt.y}px`,
    width: `${wpx}px`,
    height: `${hpx}px`,
    fontSize: `${fontPx}px`,
    // 중심 정렬(translate) + 사용자 회전. 인라인이라 CSS transform을 덮어쓴다.
    transform: `translate(-50%, -50%) rotate(${m.rotation || 0}deg)`,
  };
}

const selectedCone = computed(() =>
  selectedConeId.value ? activeCones.value.find((c) => c.id === selectedConeId.value) : null
);

/* ── Course centerline (ported from centerline.py → course/lib/centerline.mjs) ──
   Computed client-side from the active course's cones; the toggle only controls
   the on-map graphic, not the (always-computed) header length. Recompute is
   debounced and rides cone/course changes (edit commit / SSE), never mid-drag. */
function scheduleCenterline() {
  if (centerlineTimer) clearTimeout(centerlineTimer);
  centerlineTimer = setTimeout(recomputeCenterline, 250);
}
// Start-point + direction options for a course, shared by the on-map graphic and
// the ZIP export so they always agree. start = the station nearest the chosen
// cone; reverse = flipped travel direction.
function courseDirOpts(courseId, cones) {
  const opts = {};
  const course = courses.value.find((c) => c.id === courseId);
  if (!course) return opts;
  const startId = course.start_cone_id;
  const startCone = startId != null ? cones.find((c) => c.id === startId) : null;
  if (startCone) opts.start = { lat: startCone.lat, lng: startCone.lng };
  if (course.reverse) opts.reverse = true;
  return opts;
}
function recomputeCenterline() {
  centerlineTimer = null;
  const cones = activeCones.value;
  routeError.value = "";
  if (cones.length < 6) {
    centerline.value = null;
    routeMode.value = ROUTE_MODE.AUTO;
  } else {
    // resolveCourseRoute picks the engine: markers that only orient one loop keep
    // the established centerline path (start/reverse derived from them), markers
    // that re-use pavement go to the router. Courses with no markers fall back to
    // the stored course row, so nothing changes until markers are placed.
    try {
      const resolved = resolveCourseRoute(cones, activeRoute.value.markers, activeRoute.value.steps, {
        step: 1.0,
        fallback: courseDirOpts(activeCourseId.value, cones),
      });
      centerline.value = resolved.centerline;
      routeMode.value = resolved.mode;
    } catch (err) {
      centerline.value = null;
      routeMode.value = ROUTE_MODE.GUIDED;
      routeError.value = err?.message || String(err);
    }
  }
  drawCenterline();
}
function drawCenterline() {
  if (centerlineLayer) { try { map.removeLayer(centerlineLayer); } catch {} centerlineLayer = null; }
  if (!map || activeTab.value !== "courses" || !showCenterline.value || !centerline.value?.ok) return;
  const pts = centerline.value.points;
  const latlngs = pts.map((p) => [p.lat, p.lng]);
  // Dark casing under a light dashed line so the centerline reads over satellite tiles.
  const guided = !!centerline.value.metric?.routeNodeIds;
  const layers = [
    L.polyline(latlngs, { color: "#0b1021", weight: 5, opacity: 0.45, interactive: false }),
    L.polyline(latlngs, {
      color: guided ? "#34d399" : "#f8fafc",
      weight: 2.5,
      opacity: 0.95,
      dashArray: "7 6",
      interactive: false,
    }),
  ];
  const arrow = startArrow(pts);
  if (arrow) layers.push(...arrow);
  centerlineLayer = L.layerGroup(layers).addTo(map);
}

// Start marker + a travel-direction arrow at points[0], drawn in geographic
// coordinates (metres → lat/lng) so it scales and rotates with the map. The
// heading is taken a few points ahead for stability; flips with reverse.
function startArrow(pts) {
  if (!pts || pts.length < 3) return null;
  const a = pts[0];
  const b = pts[Math.min(6, pts.length - 1)];
  const latRad = (a.lat * Math.PI) / 180;
  const mLat = 110540, mLng = 111320 * Math.cos(latRad);
  let fe = (b.lng - a.lng) * mLng, fn = (b.lat - a.lat) * mLat;   // forward (east, north) metres
  const fm = Math.hypot(fe, fn);
  if (fm < 1e-6) return null;
  fe /= fm; fn /= fm;
  const toLL = (em, nm) => [a.lat + nm / mLat, a.lng + em / mLng];
  const pe = -fn, pn = fe;                                        // left-perpendicular unit
  // ONE arrow polygon (shaft + head): a single continuous outline, so there is
  // no seam between the stem and the triangle and no stem poking past the tip.
  const HEAD = 7, HEADLEN = 3.2, HW = 1.5, SW = 0.55;            // metres: tip dist, head length, head/shaft half-width
  const B = HEAD - HEADLEN;                                       // head base distance from start
  const pt = (along, off) => toLL(along * fe + off * pe, along * fn + off * pn);
  const arrow = [pt(0, SW), pt(B, SW), pt(B, HW), pt(HEAD, 0), pt(B, -HW), pt(B, -SW), pt(0, -SW)];
  const C = "#2fe36a";                                            // bright green
  const EDGE = "#0b1021";                                         // dark casing so it reads on any basemap
  return [
    L.polygon(arrow, { color: EDGE, weight: 2, lineJoin: "round", fillColor: C, fillOpacity: 1, interactive: false }),
    // start dot in METRES (like the shaft) with radius = shaft half-width, so it
    // is exactly as wide as the stem at every zoom (a pixel circleMarker wasn't).
    L.circle([a.lat, a.lng], { radius: SW, color: EDGE, weight: 2, fillColor: C, fillOpacity: 1, interactive: false }),
  ];
}
watch(showCenterline, (v) => {
  savePref("showCenterline", v);
  drawCenterline();
  rebuildRouteMarkers();
});
watch(activeCones, scheduleCenterline);
watch(activeRoute, () => {
  scheduleCenterline();
  rebuildRouteMarkers();
}, { deep: true });
watch(activeTab, drawCenterline);
// Start/direction now live on the server course row. Recompute the centerline
// whenever the active course's reverse/start changes — this client's own edit or
// another operator's, both echoed through the 'courses' SSE broadcast.
watch(
  () => {
    const c = courses.value.find((cc) => cc.id === activeCourseId.value);
    return c ? `${c.reverse}|${c.start_cone_id}` : "";
  },
  scheduleCenterline,
);
// (course switches already recompute via the activeCones watcher above, which
//  reads the newly-active course's stored start/direction.)

// The currently selected cone is this course's start line.
const isStartCone = computed(() =>
  selectedConeId.value != null && activeCourse.value?.start_cone_id === selectedConeId.value
);
// Persist start/direction to the server course row, applying the change to local
// state IMMEDIATELY (before the round-trip) so the toggle button and on-map arrow
// respond on tap and a rapid second tap toggles from the new state — the PATCH and
// the 'courses' SSE echo that reconciles other clients can lag on a flaky field
// link. Only the field(s) being changed are touched (reverse stored 0/1 to match
// the server row), so a concurrent SSE echo updating the other field isn't
// clobbered. On failure, roll back just those field(s).
async function saveCourseDirection(id, patch) {
  const i = courses.value.findIndex((c) => c.id === id);
  if (i < 0) return;
  const before = courses.value[i];
  const next = { ...before };
  if ("reverse" in patch) next.reverse = patch.reverse ? 1 : 0;
  if ("start_cone_id" in patch) next.start_cone_id = patch.start_cone_id;
  courses.value[i] = next;
  try {
    await request(`/api/courses/${id}/direction`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  } catch (err) {
    const j = courses.value.findIndex((c) => c.id === id);
    if (j >= 0) {
      const rolled = { ...courses.value[j] };
      if ("reverse" in patch) rolled.reverse = before.reverse;
      if ("start_cone_id" in patch) rolled.start_cone_id = before.start_cone_id;
      courses.value[j] = rolled;
    }
    notifyWarn(err.message || "진행 방향을 저장하지 못했습니다.");
  }
}
// Set the selected cone as the start (or clear it back to the auto start gate).
function setStartCone() {
  const id = activeCourseId.value;
  if (id == null || selectedConeId.value == null) return;
  // toggle off -> null (auto gate) if this cone is already the start
  const next = activeCourse.value?.start_cone_id === selectedConeId.value ? null : selectedConeId.value;
  saveCourseDirection(id, { start_cone_id: next });
}
// Travel direction is no longer a separate toggle: the marker visit order is the
// only way to set it. `course.reverse` stays readable for courses that predate
// markers (applied through courseDirOpts) and is still written by the import path.

/* ── Icon helpers ──────────────────────────────────── */
// Per-side #N for each cone of the active course, precomputed once (O(n)) into a
// Map for O(1) lookup. Replaces coneSideIndex()'s per-cone find+filter, which was
// O(n²) per render and re-ran on every map pan (via mapFrame). Recomputes only
// when the active course's cones change. Imperative marker code that needs ranks
// for a non-active course builds its own map with buildSideRanks(cones).
const activeConeSideRanks = computed(() => buildSideRanks(activeCones.value));

// Canvas-rendered cone for read-only contexts: the rover/history tabs and the
// LOCKED courses tab. A coloured dot with its side-index number, matching the
// editable DOM marker but drawn to the shared canvas (no per-cone DOM node to
// reposition on every pan). Click/drag belong to the unlocked courses tab; the
// current selection is shown here by the ring colour instead — amber for the
// single selection, sky for the multi-selection — mirroring highlightIcon /
// multiSelectIcon. Only the active course on the courses tab has a selection.
function coneCircle(cone, num, isActive) {
  let ringColor = "#fff", ringRatio = 0.1;
  if (isActive && activeTab.value === "courses") {
    if (selectedConeId.value === cone.id) { ringColor = "#fbbf24"; ringRatio = 0.16; }
    else if (multiSelectedIds.value.has(cone.id)) { ringColor = "#38bdf8"; ringRatio = 0.16; }
  }
  return L.circleMarker([cone.lat, cone.lng], {
    renderer: coneRenderer,
    radius: 9,
    color: "#fff",
    weight: 2,
    fillColor: SIDE_COLORS[cone.side],
    fillOpacity: isActive ? 1 : 0.45,
    opacity: isActive ? 1 : 0.45,
    interactive: false,
    label: num,
    ringColor,
    ringRatio,
  });
}

/* ── Map markers ──────────────────────────────────── */
function rebuildAllMarkers(onlyCourseId = null) {
  // Targeted rebuild: when a single course changed (e.g. a `cones` SSE update for
  // one course), remove and re-add only that course's markers instead of tearing
  // down and rebuilding every course's markers on the map each time.
  if (onlyCourseId != null) {
    for (const key of Object.keys(markers)) {
      if (key.startsWith(`${onlyCourseId}-`)) { map.removeLayer(markers[key]); delete markers[key]; }
    }
  } else {
    Object.values(markers).forEach((m) => map.removeLayer(m));
    markers = {};
  }

  // DOM markers (one node per cone — expensive) exist only for editing:
  // draggable, clickable, re-iconnable. We only pay that on the UNLOCKED courses
  // tab. When the courses tab is locked (the default) cones can't be added/moved/
  // rotated by gesture, so — like the read-only rover/history tabs — they render
  // as canvas dots: one redraw for hundreds of cones instead of hundreds of DOM
  // transforms. Tap-to-select and the selection highlight are still preserved on
  // the canvas (see onMapClick's locked branch and coneCircle).
  const editing = activeTab.value === "courses" && !editLocked.value;

  for (const course of courses.value) {
    if (onlyCourseId != null && course.id !== onlyCourseId) continue;
    if (!visibility.value[course.id]) continue;
    const cones = conesMap.value[course.id] || [];
    const isActive = course.id === activeCourseId.value;
    const ranks = buildSideRanks(cones);

    if (!editing) {
      for (const cone of cones) {
        const num = ranks.get(cone.id) || 0;
        const marker = coneCircle(cone, num, isActive).addTo(map);
        markers[`${course.id}-${cone.id}`] = marker;
      }
      continue;
    }

    for (const cone of cones) {
      const num = ranks.get(cone.id) || 0;
      const isMultiSelected = isActive && multiSelectedIds.value.has(cone.id);
      const isSingleSelected = isActive && selectedConeId.value === cone.id;
      const icon = isSingleSelected
        ? highlightIcon(cone.side, num)
        : isMultiSelected
          ? multiSelectIcon(cone.side, num)
          : coneIcon(cone.side, num, isActive);

      // Drag is courses-tab only; non-active cones opt out of hit-testing so
      // Leaflet doesn't probe every marker on every touchmove (mobile jank).
      // Per-cone drag is also suspended while rotating or measuring so those
      // gestures don't accidentally move a single cone.
      const canDrag = isActive && activeTab.value === "courses" && !editLocked.value && !routeEditMode.value
        && !rotateMode.value && toolMode.value === "none" && !selectMode.value;
      const marker = L.marker([cone.lat, cone.lng], {
        icon,
        draggable: canDrag,
        interactive: isActive,
      });

      if (isActive) {
        marker.on("click", (e) => {
          if (routeEditMode.value) return;
          // A measurement tool consumes cone taps as measurement points.
          if (toolMode.value !== "none") { handleMeasureClick(L.latLng(cone.lat, cone.lng)); return; }
          // While rotating, cone taps are ignored — the selection is locked in.
          if (rotateMode.value) return;
          // Select mode (and Shift+click) toggle the cone in/out of the multi-selection.
          if (selectMode.value || (e.originalEvent && e.originalEvent.shiftKey)) {
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

            const rollbackPositions = dragStartPositions;
            // Pre-move positions for undo: the dragged cone's origin + the others'.
            const courseId = activeCourseId.value;
            const before = [{ id: cone.id, lat: dragOrigin.lat, lng: dragOrigin.lng }];
            for (const [id, origPos] of dragStartPositions) before.push({ id, lat: origPos.lat, lng: origPos.lng });
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
              pushUndo(`콘 ${before.length}개 이동`, () => Promise.all(
                before.map((b) => request(`/api/cones/${b.id}`, { method: "PATCH", body: JSON.stringify({ lat: b.lat, lng: b.lng }) }))
              ));
            } catch (err) {
              notifyError(`콘 위치 저장 실패: ${err.message}`);
              marker.setLatLng([cone.lat, cone.lng]);
              for (const [id, origPos] of rollbackPositions || []) {
                const key = `${activeCourseId.value}-${id}`;
                const m = markers[key];
                if (m) m.setLatLng([origPos.lat, origPos.lng]);
              }
            }

            suppressRebuild = false;
            rebuildAllMarkers();
          } else {
            const before = { lat: cone.lat, lng: cone.lng };
            const { lat, lng } = marker.getLatLng();
            try {
              await request(`/api/cones/${cone.id}`, { method: "PATCH", body: JSON.stringify({ lat, lng }) });
              pushUndo("콘 이동", () => request(`/api/cones/${cone.id}`, { method: "PATCH", body: JSON.stringify({ lat: before.lat, lng: before.lng }) }));
            } catch (err) {
              notifyError(`콘 위치 저장 실패: ${err.message}`);
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

function clearRouteMarkers() {
  if (map) for (const marker of routeMarkerLayers) { try { map.removeLayer(marker); } catch {} }
  routeMarkerLayers = [];
}

// Route markers are distinct from cones: one physical marker can appear in the
// visit list several times. The icon therefore shows visit ranks, not a copied
// marker per lap. Markers become interactive only in route-edit mode so normal
// cone selection and map panning retain their existing behavior.
function rebuildRouteMarkers() {
  clearRouteMarkers();
  if (!map || activeTab.value !== "courses" || !activeCourseId.value) return;
  // Route markers are part of the active course graphic. Keep them out of the
  // map when that course is hidden, and hide them with the centerline unless
  // the operator explicitly entered route-marker edit mode.
  if (!visibility.value[activeCourseId.value] || (!showCenterline.value && !routeEditMode.value)) return;
  const visits = new Map();
  activeRoute.value.steps.forEach((id, index) => {
    const ranks = visits.get(id) || [];
    ranks.push(index + 1);
    visits.set(id, ranks);
  });
  const interactive = routeEditMode.value && !editLocked.value;
  activeRoute.value.markers.forEach((routeMarker, markerIndex) => {
    const ranks = visits.get(routeMarker.id) || [];
    const visibleRanks = ranks.length > 3 ? `${ranks.slice(0, 2).join("·")}…` : ranks.join("·");
    const text = visibleRanks || `M${markerIndex + 1}`;
    const marker = L.marker([routeMarker.lat, routeMarker.lng], {
      draggable: interactive,
      interactive,
      zIndexOffset: 900,
      icon: L.divIcon({
        className: "route-marker-host",
        html: `<div class="route-marker-pin${ranks.length ? " has-visits" : ""}"><span>${text}</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
    });
    if (interactive) {
      marker.on("click", (event) => {
        if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
        appendRouteVisit(routeMarker.id);
      });
      marker.on("dragend", async () => {
        const { lat, lng } = marker.getLatLng();
        await updateRouteMarker(routeMarker, { lat, lng });
      });
    }
    marker.addTo(map);
    routeMarkerLayers.push(marker);
  });
}

function updateMultiSelectIcons() {
  const aid = activeCourseId.value;
  if (!aid) return;
  // Locked courses tab: cones are canvas dots with no setIcon — repaint their
  // rings by rebuilding (cheap for canvas markers, unlike DOM ones).
  if (activeTab.value === "courses" && editLocked.value) { rebuildAllMarkers(); return; }
  const ranks = activeConeSideRanks.value; // aid === active course; reuse the memoized map
  for (const cone of (conesMap.value[aid] || [])) {
    const key = `${aid}-${cone.id}`;
    const m = markers[key];
    if (!m || !m.setIcon) continue; // canvas dots (non-editing tab) have no icon
    const num = ranks.get(cone.id) || 0;
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
  if (rotateMode.value) exitRotateMode();
  multiSelectedIds.value = new Set();
  updateMultiSelectIcons();
}

function onConeListScroll(e) {
  coneListScrolled.value = e.target.scrollTop > 200;
}

function scrollConeListTop() {
  coneListEl.value?.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── Watchers ─────────────────────────────────────── */
// Toggling the edit lock flips cones between DOM markers (unlocked: draggable,
// clickable, re-iconnable) and fast canvas dots (locked: read-only), so the
// marker layer has to be rebuilt on every toggle.
watch(editLocked, (v) => {
  savePref("editLocked", v);
  if (v && rotateMode.value) exitRotateMode(); // rotate is an edit op — locking exits it
  if (v) routeEditMode.value = false;
  if (map && activeTab.value === "courses") {
    rebuildAllMarkers();
    rebuildRouteMarkers();
  }
});
watch(routeEditMode, () => {
  if (!map || activeTab.value !== "courses") return;
  rebuildAllMarkers();
  rebuildRouteMarkers();
});
// Keep the rotate handle pinned to the selection's centroid. If the selection
// drops below two cones there's nothing to rotate, so leave rotate mode.
watch(multiSelectedIds, (set) => {
  if (!rotateMode.value) return;
  if (set.size < 2) exitRotateMode();
  else setupRotateHandle();
});
// Box-select mode is mutually exclusive with rotate/measure; toggling it changes
// cone draggability and the container's touch-action, so rebuild the markers.
watch(selectMode, (on) => {
  if (on) {
    routeEditMode.value = false;
    if (rotateMode.value) exitRotateMode();
    if (toolMode.value !== "none") exitToolMode();
  }
  if (map) {
    // Pin the map while selecting so a drag draws a box instead of panning;
    // touch-action:none (via the class) stops the browser scrolling the page.
    if (on) map.dragging.disable(); else map.dragging.enable();
    map.getContainer().classList.toggle("select-mode-active", on);
    if (activeTab.value === "courses") rebuildAllMarkers();
  }
});
// Filter change reflows the list — jump back to the top and hide the button.
watch(coneFilter, () => { coneListScrolled.value = false; coneListEl.value?.scrollTo({ top: 0 }); });
// Persist per-course show/hide across reloads (course selection already persists
// via activeCourseId). Deep watch since visibility is a per-id map.
watch(visibility, (v) => savePref("visibility", JSON.stringify(v)), { deep: true });
watch(selectedConeId, (id) => {
  const aid = activeCourseId.value;
  // Locked courses tab draws canvas dots (no setIcon); rebuild so the newly
  // selected cone picks up its amber highlight ring. The unlocked tab re-icons
  // only the affected DOM markers (no full rebuild).
  if (activeTab.value === "courses" && editLocked.value) {
    rebuildAllMarkers();
  } else {
    const ranks = activeConeSideRanks.value; // aid === active course; reuse the memoized map
    Object.entries(markers).forEach(([key, marker]) => {
      if (!key.startsWith(`${aid}-`) || !marker.setIcon) return; // skip canvas dots
      const coneId = parseInt(key.split("-")[1]);
      const cone = (conesMap.value[aid] || []).find((c) => c.id === coneId);
      if (!cone) return;
      const num = ranks.get(coneId) || 0;
      if (coneId === id) marker.setIcon(highlightIcon(cone.side, num));
      else if (multiSelectedIds.value.has(coneId)) marker.setIcon(multiSelectIcon(cone.side, num));
      else marker.setIcon(coneIcon(cone.side, num, true));
    });
  }

  if (id) {
    // Scroll the list to the selected cone — for list clicks and (now) map taps.
    // panToCone() owns map re-centering; selecting via a map tap doesn't pan.
    nextTick(() => {
      const el = document.querySelector(`[data-cone-id="${id}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    const cone = activeCones.value.find((c) => c.id === id);
    if (cone) {
      editLat.value = cone.lat.toString();
      editLng.value = cone.lng.toString();
      editLatOrig.value = editLat.value;
      editLngOrig.value = editLng.value;
      editSide.value = cone.side;
    }
  }
});

// 미션 취소로 코스 전환을 되돌릴 때 재할당이 이 watcher 를 다시 트리거하므로,
// 그 1회는 플래그로 무시한다 (되돌림에 clearPath/미션 폐기가 돌면 안 된다).
let revertingCourseSwitch = false;
let aligningMissionCourse = false;

function alignCourseToMission(mission) {
  const nextCourseId = missionCourseId(activeCourseId.value, mission);
  if (nextCourseId === activeCourseId.value) return;
  if (!courses.value.some((course) => course.id === nextCourseId)) return;
  aligningMissionCourse = true;
  activeCourseId.value = nextCourseId;
}

watch(activeCourseId, async (v, prev) => {
  if (revertingCourseSwitch) { revertingCourseSwitch = false; return; }
  const missionAlignment = aligningMissionCourse;
  aligningMissionCourse = false;
  // 미션 진행(executing)·중단(stopped) 중의 코스 전환은 아래 clearPath() 가 서버
  // 미션까지 폐기하는 파괴적 작업 — abandonMission 과 동일하게 반드시 확인을 받고,
  // 취소하거나 서버 종료가 실패하면 전환 자체를 이전 코스로 되돌린다.
  let missionEnded = false;
  if (shouldAbandonMissionForCourseSwitch({ missionAlignment, roverMode: roverMode.value })) {
    const revert = () => { revertingCourseSwitch = true; activeCourseId.value = prev; };
    if (!window.confirm("코스를 전환하면 진행 중인 미션을 종료하고 폐기합니다.\n'이어서 실행'할 수 없게 됩니다. 계속하시겠습니까?")) { revert(); return; }
    // abandonMission 과 동일하게 서버 종료를 먼저 await 한다 — 응답 전에 로컬
    // 정리를 하면 다음 status tick 의 reconcileRoverMode 가 "stopped" 로 되튕긴다.
    if (activeMission.value?.id) {
      try { await request(`/api/missions/${activeMission.value.id}/end`, { method: "POST" }); }
      catch (err) { notifyWarn(`미션 종료 실패: ${err.message}`); revert(); return; }
    }
    missionEnded = true;
  }
  if (rotateMode.value) exitRotateMode();
  if (toolMode.value !== "none") exitToolMode();
  selectMode.value = false;
  routeEditMode.value = false;
  undoStack.value = []; // undo entries reference cone ids of the old course
  selectedConeId.value = null;
  multiSelectedIds.value = new Set();
  coneFilter.value = "all";
  coneListScrolled.value = false;
  missionPresets.value = [];
  missionPresetRequestSeq += 1;
  // A server-active mission owns both route and course. Its internal course
  // alignment must refresh course-scoped UI without clearing or abandoning the
  // mission path that restoreActiveMission is installing in the same tick.
  if (!missionAlignment) clearPath({ endMissionOnServer: !missionEnded });
  if (map) {
    rebuildAllMarkers();
    rebuildRouteMarkers();
  }
  if (v != null) {
    savePref("activeCourseId", v);
    // Pan to the newly selected course so the operator doesn't hand-pan: the
    // designated start cone if one is set, else the first cone in the data.
    const cones = conesMap.value[v] || [];
    if (cones.length > 0 && map) {
      const startId = courses.value.find((c) => c.id === v)?.start_cone_id;
      const startCone = cones.find((c) => c.id === startId) || cones[0];
      panToVisibleCenter(startCone.lat, startCone.lng);
    }
  }
});

/* ── Data fetch ───────────────────────────────────── */
async function fetchAll() {
  try {
    const res = await request("/api/courses");
    courses.value = await res.json();
    // Load every course's cones + memos concurrently. The old loop blocked each
    // course on the previous one (1 + 2N serial round-trips); fan them out so
    // first paint waits only on the slowest single course, not their sum.
    await Promise.all(courses.value.map(async (c) => {
      if (visibility.value[c.id] === undefined) visibility.value[c.id] = true;
      const [cones, memos, route] = await Promise.all([
        request(`/api/courses/${c.id}/cones`).then((r) => r.json()).catch(() => []),
        request(`/api/courses/${c.id}/memos`).then((r) => r.json()).catch(() => []),
        request(`/api/courses/${c.id}/route`).then((r) => r.json()).catch(() => ({ markers: [], steps: [] })),
      ]);
      conesMap.value[c.id] = cones;
      memosMap.value[c.id] = memos;
      routeMap.value[c.id] = route;
    }));
    if (!activeCourseId.value && courses.value.length) {
      // Restore the last-used course so a refresh doesn't silently drop
      // the operator back to courses[0] (which then requires re-clicking
      // the actually-wanted course every time the page reloads).
      const saved = Number(loadPref("activeCourseId", null));
      const match = Number.isInteger(saved) && courses.value.find((c) => c.id === saved);
      activeCourseId.value = match ? saved : courses.value[0].id;
    }
  } catch {} finally { loading.value = false; }
}

/* ── Map init ─────────────────────────────────────── */
async function initMap() {
  // leaflet-rotate is a UMD plugin that patches the global `L`. Expose L on
  // globalThis first, then dynamically import it (a static import is hoisted
  // above this assignment and would run with L undefined). After this, the map
  // supports map.setBearing() and rotates tiles/cones/paths together.
  globalThis.L = L;
  await import("leaflet-rotate");
  map = L.map("map", {
    // Render vector layers (centerline, direction arrow, mission/rotate/measure
    // paths) on a single shared <canvas> instead of one SVG node each — the
    // 850+-point centerline was re-projected as SVG on every pan under
    // leaflet-rotate, which janks the drag. (Locked/read-only cone dots already
    // use their own canvas renderer, so canvas + rotation is proven here.)
    preferCanvas: true,
    zoomControl: true, maxZoom: 21, boxZoom: false,
    // Button-driven 90° rotation only — no built-in compass control, no
    // two-finger free rotation (that would desync the snapped mapBearing).
    rotate: true, rotateControl: false, touchRotate: false,
    bearing: renderBearing(mapBearing.value),
  }).setView([35.292012, 126.574415], 19);
  // One canvas for all cone dots on non-editing tabs — hundreds of cones become
  // a single redraw on pan/zoom instead of hundreds of DOM marker transforms.
  coneRenderer = new LabeledConeCanvas({ padding: 0.5 });

  // Basemap. VWorld satellite when a key is configured (window.__VWORLD_KEY__,
  // injected at container start by entrypoint.sh from $VWORLD_KEY). VWorld's
  // imagery is georeferenced to the Korean national datum, so RTK WGS84 points
  // land where they actually are — Google's Korea satellite tiles are offset
  // several meters. Falls back to Google where no key is set (local dev,
  // production) so those environments stay unchanged.
  // VWorld tiles top out at native zoom 19; maxNativeZoom upscales 19→21 so the
  // map's 21 max stays usable (blurry past 19, but no blank tiles).
  const vworldKey = window.__VWORLD_KEY__;
  if (vworldKey) {
    L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/Satellite/{z}/{y}/{x}.jpeg`, {
      attribution: "&copy; VWorld", maxNativeZoom: 19, maxZoom: 21,
    }).addTo(map);
    // Transparent road/place-label overlay, matching Google hybrid's labels.
    L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/Hybrid/{z}/{y}/{x}.png`, {
      attribution: "&copy; VWorld", maxNativeZoom: 19, maxZoom: 21,
    }).addTo(map);
  } else {
    L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2", {
      subdomains: "0123", attribution: "&copy; Google", maxZoom: 21,
    }).addTo(map);
  }

  // Keep the DOM cone-icon size (--cone-px) in step with zoom so courses-tab
  // cones scale like the canvas dots on the other tabs.
  const applyConeScale = () => map.getContainer().style.setProperty("--cone-px", coneDiameterForZoom(map.getZoom()).toFixed(1) + "px");
  applyConeScale();
  map.on("zoomend", applyConeScale);

  map.on("click", onMapClick);
  // Coordinate popover is gated on long-press / right-click — Leaflet's
  // `contextmenu` fires on a 500ms touch hold (mobile) or right-click
  // (desktop), so a tap can't accidentally drop a popup mid-pan.
  map.on("contextmenu", (e) => {
    L.DomEvent.preventDefault(e.originalEvent);
    showCoordPopover(e.latlng);
  });
  // User-initiated drag should disable follow so the operator isn't
  // fighting an auto-recentre. Programmatic panTo doesn't fire dragstart.
  map.on("dragstart", () => {
    if (followRover.value) followRover.value = false;
    if (followReceiver.value) followReceiver.value = false;
  });
  // 메모 스티커는 지리 좌표 고정 HTML 오버레이라 지도가 움직일 때마다 화면 위치·크기를
  // 다시 계산해야 한다. move/zoom은 애니메이션 중에도 반복 발생하므로 팬·줌 동안에도
  // 메모가 붙어 따라간다. rotate는 leaflet-rotate의 회전 이벤트.
  for (const ev of ["move", "zoom", "moveend", "zoomend", "viewreset", "resize", "rotate"]) {
    map.on(ev, () => { mapFrame.value++; });
  }
  setupSelectionBox();
  rebuildAllMarkers();
  rebuildRouteMarkers();
  renderSurveyPoints();
}


// An exact 180° rotation renders as the matrix [-1,0,0,-1] (a pure x/y flip).
// Browsers snap transforms within ~0.05° of that to an "axis-aligned" fast path
// that fails to paint the rotated raster tiles (verified empirically: 179.9°
// paints fine, 179.99° and 180° break; 90°/270° are axis-swap rotations and are
// unaffected, and the cones are positioned in the non-rotated pane so they never
// depended on this). Nudge an exact 180° by 0.1° — past the snap threshold but
// ~1.7px at the screen edge, visually indistinguishable.
function renderBearing(deg) {
  return deg === 180 ? 179.9 : deg;
}

// Floating bottom-left button: each press turns the map a quarter-turn
// counter-clockwise (matching the ↺ icon) and persists the angle so it survives
// reloads and is shared across all tabs.
function rotateMap() {
  if (!map) return;
  mapBearing.value = (((mapBearing.value - 90) % 360) + 360) % 360;
  map.setBearing(renderBearing(mapBearing.value));
  savePref("mapBearing", mapBearing.value);
  mapFrame.value++; // 회전 후 메모 스티커 재배치
}

function onMapClick(e) {
  if (justFinishedBoxSelect) return;
  // Measurement tools claim map taps (snapping to the nearest cone if one is close).
  if (toolMode.value !== "none") {
    const c = nearestCone(e.latlng);
    handleMeasureClick(c ? L.latLng(c.lat, c.lng) : e.latlng);
    return;
  }
  // While rotating, map taps are inert so a stray tap can't add a cone or drop the selection.
  if (rotateMode.value) return;
  // In select mode, taps only toggle cones / draw boxes — never add or clear on empty space.
  if (selectMode.value) return;
  if (roverMode.value === "path-pick") {
    computePath(e.latlng.lat, e.latlng.lng);
    return;
  }
  if (roverMode.value === "path-ready") {
    clearPath();
    return;
  }
  // 'stopped' = 비상정지/중단으로 서버에 보존된 재개 가능한 미션("이어서 실행").
  // 여기서 clearPath()가 돌면 /api/rover/end-mission 이 POST 되어 미션이 폐기되고
  // 재개가 불가능해진다. 실수 탭 하나가 미션을 날리지 않도록 무시하고(executing 과
  // 동일), 폐기는 전용 "미션 종료" 버튼으로만 수행한다.
  if (roverMode.value === "stopped") return;
  if (roverMode.value === "executing") return;
  if (routeEditMode.value) {
    if (activeTab.value === "courses" && activeCourseId.value && !editLocked.value) {
      addRouteMarker(e.latlng.lat, e.latlng.lng);
    }
    return;
  }
  // Locked courses tab: cones are canvas dots (no per-marker click), so the map
  // tap does the selection the DOM marker normally would — snap to the nearest
  // cone to select it (the inspector can still edit/delete a selected cone while
  // locked). A tap on empty space clears the current selection.
  if (activeTab.value === "courses" && editLocked.value && activeCourseId.value) {
    const c = nearestCone(e.latlng);
    if (c) {
      if (multiSelectedIds.value.size > 0) multiSelectedIds.value = new Set();
      selectedConeId.value = c.id;
      return;
    }
    if (multiSelectedIds.value.size > 0) { multiSelectedIds.value = new Set(); updateMultiSelectIcons(); return; }
    if (selectedConeId.value) selectedConeId.value = null;
    return;
  }
  if (multiSelectedIds.value.size > 0) {
    multiSelectedIds.value = new Set();
    updateMultiSelectIcons();
    return;
  }
  if (selectedConeId.value) { selectedConeId.value = null; return; }
  // Cone-add fires on a tap only when the courses tab is active and a course
  // is selected. Other contexts (other tabs, no course) ignore the tap —
  // long-press shows a coordinate popover instead.
  if (activeTab.value === "courses" && activeCourseId.value && roverMode.value !== "manual" && !editLocked.value) {
    addCone(e.latlng.lat, e.latlng.lng, currentSide.value);
  }
}

function showCoordPopover(latlng) {
  if (!map) return;
  L.popup({ closeOnClick: true, autoClose: true, className: "coord-popup" })
    .setLatLng(latlng)
    .setContent(`<div class="coord-popover-body">${formatLatLng(latlng.lat, latlng.lng)}</div>`)
    .openOn(map);
}

/* ── Box selection (Shift+drag, or touch in select mode) ── */
// Pointer Events so the same path covers mouse, touch, and pen. Triggers on
// Shift+left-mouse (desktop) or whenever select mode is on (works on touch).
let selectionActive = false;
function onSelectionStart(e) {
  if (!activeCourseId.value || selectionActive) return;
  if (rotateMode.value || toolMode.value !== "none") return; // off while rotating/measuring
  const isMouse = (e.pointerType || "mouse") === "mouse";
  const viaShift = isMouse && e.shiftKey && e.button === 0;
  if (!selectMode.value && !viaShift) return;
  if (isMouse && e.button !== 0) return;

  selectionActive = true;
  const pointerId = e.pointerId;
  // In select mode the map is already pinned (dragging disabled globally); for the
  // Shift path we disable it just for this gesture.
  if (!selectMode.value) map.dragging.disable();

  const container = map.getContainer();
  const containerRect = container.getBoundingClientRect();
  const startPx = { x: e.clientX - containerRect.left, y: e.clientY - containerRect.top };
  let endPx = { ...startPx };

  const boxEl = document.createElement("div");
  boxEl.className = "selection-box";
  container.appendChild(boxEl);

  function draw() {
    boxEl.style.left = Math.min(startPx.x, endPx.x) + "px";
    boxEl.style.top = Math.min(startPx.y, endPx.y) + "px";
    boxEl.style.width = Math.abs(endPx.x - startPx.x) + "px";
    boxEl.style.height = Math.abs(endPx.y - startPx.y) + "px";
  }

  function onMove(ev) {
    if (ev.pointerId !== pointerId) return;
    endPx = { x: ev.clientX - containerRect.left, y: ev.clientY - containerRect.top };
    draw();
  }

  function finish(applySelection) {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);

    if (applySelection && (Math.abs(endPx.x - startPx.x) > 5 || Math.abs(endPx.y - startPx.y) > 5)) {
      const bounds = {
        left: Math.min(startPx.x, endPx.x), top: Math.min(startPx.y, endPx.y),
        right: Math.max(startPx.x, endPx.x), bottom: Math.max(startPx.y, endPx.y),
      };
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
    if (!selectMode.value) map.dragging.enable();
    selectionActive = false;
    justFinishedBoxSelect = true;
    setTimeout(() => { justFinishedBoxSelect = false; }, 100);
  }
  function onUp(ev) { if (ev.pointerId === pointerId) finish(true); }
  function onCancel(ev) { if (ev.pointerId === pointerId) finish(false); }

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

function setupSelectionBox() {
  map.getContainer().addEventListener("pointerdown", onSelectionStart);
}

/* ── Course CRUD ──────────────────────────────────── */
function toggleVisibility(courseId) {
  visibility.value[courseId] = !visibility.value[courseId];
  if (map) {
    rebuildAllMarkers();
    if (courseId === activeCourseId.value) rebuildRouteMarkers();
  }
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
  } catch (err) { notifyError(err.message); }
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
  } catch (err) { notifyError(err.message); }
}

async function deleteCourse(id) {
  const course = courses.value.find((c) => c.id === id);
  if (!confirm(`"${course?.name}" 코스를 삭제하시겠습니까?`)) return;
  try {
    await request(`/api/courses/${id}`, { method: "DELETE" });
    if (activeCourseId.value === id) {
      activeCourseId.value = courses.value.find((c) => c.id !== id)?.id || null;
    }
  } catch (err) { notifyError(err.message); }
}

/* ── Calibration popup (antenna + wheel encoder) ───── */
// One modal hosts both rover calibrations. The rover persists each
// offset on its end (/var/lib/pilot/{antenna_offset,wheel_cal}.json)
// and reports every attempt back via SSE — so the chief can spot a
// stale or wildly wrong value before a mission. Both triggers are
// gated on roverStatus (connected + IDLE); mid-mission calibration
// would require interrupting the rover and is intentionally not allowed.
const showCalibration = ref(false);
const antennaCalSubmitting = ref(false);
const wheelCalSubmitting = ref(false);
const wheelCalResetSubmitting = ref(false);

const antennaCalRunning = computed(() => roverStatus.value.nav_state === "CAL_ANTENNA");
const wheelCalRunning = computed(() => roverStatus.value.nav_state === "CAL_WHEELS");

const antennaCalCanStart = computed(() => {
  return roverStatus.value.connected
      && (roverStatus.value.nav_state === "IDLE" || roverStatus.value.nav_state == null);
});
const wheelCalCanStart = computed(() => {
  return roverStatus.value.connected
      && (roverStatus.value.nav_state === "IDLE" || roverStatus.value.nav_state == null);
});

const antennaCalBtnLabel = computed(() => {
  if (antennaCalRunning.value) return "진행 중";
  if (!roverStatus.value.connected) return "로버 연결 필요";
  if (roverStatus.value.nav_state && roverStatus.value.nav_state !== "IDLE") {
    return "IDLE 상태에서만 가능";
  }
  return "시작";
});
const wheelCalBtnLabel = computed(() => {
  if (wheelCalRunning.value) return "진행 중";
  if (!roverStatus.value.connected) return "로버 연결 필요";
  if (roverStatus.value.nav_state && roverStatus.value.nav_state !== "IDLE") {
    return "IDLE 상태에서만 가능";
  }
  return "시작";
});

const antennaCalDisplay = computed(() => {
  const cal = roverStatus.value.antenna_calibration;
  const fmt = (v) => (typeof v === "number" ? v.toFixed(3) + " m" : "—");
  const fmtRms = (v) => (typeof v === "number" ? (v * 100).toFixed(1) + " cm" : "—");
  let calibratedAgo = "—";
  if (cal?.calibrated_at) {
    const ago = Math.max(0, Math.round((Date.now() - cal.calibrated_at) / 60000));
    calibratedAgo = ago < 1 ? "방금" : `${ago}분 전`;
  }
  return {
    a_x: fmt(cal?.a_x),
    a_y: fmt(cal?.a_y),
    rms: fmtRms(cal?.rms_residual_m),
    calibratedAgo,
    errorReason: cal && !cal.ok ? cal.reason : null,
    source: cal?.source || null,
    sourceLabel: cal?.source === "manual" ? "수동" : (cal?.source === "auto" ? "자동" : null),
  };
});

const wheelCalDisplay = computed(() => {
  const cal = roverStatus.value.wheel_calibration;
  const fmtScale = (v) => (typeof v === "number" ? v.toFixed(4) : "—");
  const fmtTrim = (v) => (typeof v === "number"
    ? `${v >= 0 ? "+" : ""}${v.toFixed(1)} µs` : "—");
  // radius_m comes back null when the rover drove straight enough that
  // the trim solver returned 0 (>100 m radius). Show "직선" then so the
  // operator sees at a glance that no correction was needed.
  let radiusLabel = "—";
  if (typeof cal?.radius_m === "number") {
    radiusLabel = `${cal.radius_m.toFixed(1)} m`;
  } else if (typeof cal?.trim_us === "number") {
    radiusLabel = "직선";
  }
  let calibratedAgo = "—";
  if (cal?.calibrated_at) {
    const ago = Math.max(0, Math.round((Date.now() - cal.calibrated_at) / 60000));
    calibratedAgo = ago < 1 ? "방금" : `${ago}분 전`;
  }
  return {
    scale_l: fmtScale(cal?.scale_l),
    scale_r: fmtScale(cal?.scale_r),
    samples: typeof cal?.samples === "number" ? String(cal.samples) : "—",
    trim: fmtTrim(cal?.trim_us),
    radius: radiusLabel,
    calibratedAgo,
    errorReason: cal && !cal.ok ? cal.reason : null,
    // Soft warn when wheel scales applied but steering-trim solve refused
    // to persist (e.g. slip, GPS noise) — the wheel cal still succeeded.
    steeringWarning: cal && cal.ok && cal.steering_reason ? cal.steering_reason : null,
  };
});

// While the cal modal is open we poll the server-side rover status so a
// silently dropped SSE event (background tab / caddy buffering / network
// blip that didn't trip the browser's 'error' handler) can't leave the
// button disabled because nav_state is stuck at CAL_* in the local view.
// Browser refresh used to be the operator's only escape; this poll
// reproduces that effect every couple seconds without the F5 dance.
let calStatusPollHandle = null;

function openCalibration() {
  // Manual control runs a 20 Hz timer that keeps the mcu_bridge's
  // manual-priority window alive on every tick. If the operator opens
  // cal while still in manual mode, the navigator's autonomous Twist
  // for the cal drive gets silently dropped on every tick because
  // mcu_bridge sees a fresh manual command less than manual_priority_s
  // ago — the rover sits in CAL_ANTENNA state but never moves, until
  // the operator closes the page (clearing the interval) and reloads.
  // Opening the cal modal is an implicit "I want to autonomously drive"
  // gesture, so release manual control first.
  if (roverMode.value === "manual") stopManualControl();
  showCalibration.value = true;
  activeChipPopover.value = null;
  // Sync once on open so a stale local state is corrected before the
  // operator's first click, then keep refreshing every 2 s while the
  // modal stays open.
  fetchRoverStatus();
  if (calStatusPollHandle == null) {
    calStatusPollHandle = setInterval(fetchRoverStatus, 2000);
  }
}

function closeCalibration() {
  if (antennaCalSubmitting.value || wheelCalSubmitting.value) return;
  showCalibration.value = false;
  if (calStatusPollHandle != null) {
    clearInterval(calStatusPollHandle);
    calStatusPollHandle = null;
  }
}

// Print the stereo-calibration checkerboard. Geometry MUST match the command
// shown in the modal: 9×6 inner corners = 10×7 squares, 25 mm. Squares are
// foreground SVG <rect> fills (print regardless of the dialog's "Background
// graphics" toggle) sized in mm via the viewBox, so they come out at true
// scale when printed at 100%. Rendered in a hidden iframe (its own @page A4
// landscape) so it doesn't disturb the app and isn't blocked like window.open.
function printCheckerboard() {
  const COLS = 10, ROWS = 7, SQ = 25;          // squares; 25 mm each
  const W = COLS * SQ, H = ROWS * SQ;          // 250 × 175 mm
  let rects = `<rect width="${W}" height="${H}" fill="#fff"/>`;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if ((r + c) % 2 === 0) {
        rects += `<rect x="${c * SQ}" y="${r * SQ}" width="${SQ}" height="${SQ}" `
               + `fill="#000" shape-rendering="crispEdges"/>`;
      }
    }
  }
  const board = `<svg class="board" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" `
    + `xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  // Verification bar: line + ticks on top, label well below — one SVG, so the
  // label can't overlap the line.
  const ruler = `<svg class="ruler" viewBox="0 0 100 9" width="100mm" height="9mm" `
    + `xmlns="http://www.w3.org/2000/svg">`
    + `<line x1="0" y1="2.5" x2="100" y2="2.5" stroke="#000" stroke-width="0.4" shape-rendering="crispEdges"/>`
    + `<line x1="0" y1="0.5" x2="0" y2="4.5" stroke="#000" stroke-width="0.4"/>`
    + `<line x1="50" y1="1.2" x2="50" y2="3.8" stroke="#000" stroke-width="0.4"/>`
    + `<line x1="100" y1="0.5" x2="100" y2="4.5" stroke="#000" stroke-width="0.4"/>`
    + `<text x="50" y="8" text-anchor="middle" font-family="monospace" font-size="3" fill="#000">100 mm</text>`
    + `</svg>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>checkerboard</title>`
    + `<style>`
    + `@page { size: A4 landscape; margin: 0; }`
    + `html,body { margin:0; background:#fff; }`
    + `.sheet { display:flex; flex-direction:column; align-items:center; padding-top:10mm; }`
    + `.ruler { margin-top:6mm; }`
    + `svg { display:block; print-color-adjust:exact; -webkit-print-color-adjust:exact; }`
    + `</style></head><body><div class="sheet">${board}${ruler}</div></body></html>`;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  iframe.onload = () => {
    const cleanup = () => iframe.remove();
    try {
      iframe.contentWindow.onafterprint = cleanup;
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch { /* ignore */ }
    // Fallback only — remove well after any print dialog, never mid-preview.
    setTimeout(cleanup, 60000);
  };
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
}

// Stereo calibration is triggered here and runs on the rover (perception owns
// the cameras). Progress/result arrive via roverStatus.stereo_calibration.
const stereoSquareMm = ref("25");
const stereoSquareValid = computed(() => {
  const v = parseFloat(stereoSquareMm.value);
  return Number.isFinite(v) && v >= 5 && v <= 200;
});
const stereoCal = computed(() => roverStatus.value.stereo_calibration || { status: "idle" });

async function startStereoCalibration() {
  if (!stereoSquareValid.value) {
    notifyWarn("한 칸 길이를 5~200 mm 범위로 입력하세요.");
    return;
  }
  const square_m = parseFloat(stereoSquareMm.value) / 1000;
  // Open the live view so the operator can aim the board while it collects.
  startCamera();
  try {
    await request("/api/rover/calibrate-stereo", {
      method: "POST",
      body: JSON.stringify({ square_m }),
    });
  } catch (err) {
    notifyError(`교정 시작 실패: ${err.message}`);
  }
}

// Ground calibration fits the above-ground detector's per-row ground-depth curve
// on flat empty ground. Needs a stereo calibration first (metric depth). Runs on
// the rover; progress/result arrive via roverStatus.ground_calibration.
const groundCal = computed(() => roverStatus.value.ground_calibration || { status: "idle" });

// The calibration modal is tabbed (antenna / wheel / stereo / ground) so it no
// longer scrolls as one long stack; this tracks the visible tab.
const calTab = ref("antenna");

async function startGroundCalibration() {
  // Live view so the operator can confirm the corridor is clean flat ground (an
  // obstacle in view would corrupt the curve).
  startCamera();
  try {
    await request("/api/rover/calibrate-ground", {
      method: "POST",
      body: JSON.stringify({ frames: 30 }),
    });
  } catch (err) {
    notifyError(`지면 교정 시작 실패: ${err.message}`);
  }
}

// Proximity (obstacle) detection master on/off — operator toggle in the ground
// tab. Server-stored (roverState.obstacle_detection_enabled), so it rides the
// rover:status broadcast; the ref below is synced from it and flipped
// optimistically like toggleDepth, reverting if the server call fails. Default
// OFF (opt-in per mission) — reconciled to the server's truth on first status.
const obstacleDetectOn = ref(false);
// The operator's in-flight intent (true/false) while a toggle POST is pending,
// else null. rover:status broadcasts arrive at GPS rate and also carry
// obstacle_detection_enabled, so without this guard an in-flight status frame
// (still carrying the pre-toggle value) would snap the checkbox back mid-toggle.
let detectTogglePending = null;
async function setObstacleDetection(on) {
  const prev = obstacleDetectOn.value;
  detectTogglePending = on;
  obstacleDetectOn.value = on;               // optimistic
  try {
    await request("/api/rover/camera/detection", {
      method: "POST",
      body: JSON.stringify({ on }),
    });
  } catch (err) {
    obstacleDetectOn.value = prev;
    if (detectTogglePending === on) detectTogglePending = null;
    notifyError(`근접 감지 설정 실패: ${err.message}`);
  }
}
// Apply the server's detection state from a rover:status/status snapshot. While a
// toggle is pending, ignore a stale frame that still carries the old value; clear
// the guard once the server confirms the intended value (so a later real change
// from another operator still syncs).
function syncObstacleDetect(data) {
  if (data.obstacle_detection_enabled === undefined) return;
  const v = data.obstacle_detection_enabled !== false;
  if (detectTogglePending === null) {
    obstacleDetectOn.value = v;
  } else if (v === detectTogglePending) {
    obstacleDetectOn.value = v;
    detectTogglePending = null;
  }
  // else: stale pre-toggle frame → ignore until the server catches up.
}

async function submitAntennaCal() {
  if (!antennaCalCanStart.value) return;
  antennaCalSubmitting.value = true;
  try {
    await request("/api/rover/calibrate-antenna", { method: "POST" });
    // Leave the modal open so the operator sees the running status; the
    // result row updates from SSE independently.
  } catch (err) {
    notifyError(err.message);
  } finally {
    antennaCalSubmitting.value = false;
  }
}

// Manual antenna offset entry. The recommended path: tape-measure rear
// axle centre → antenna phase centre, type the cm values here. Saves
// to the same antenna_offset.json the auto-cal writes (with source
// 'manual'), applies live in the navigator without restart.
const antennaManualX = ref("");
const antennaManualY = ref("");
const antennaManualSubmitting = ref(false);

// Operator types in mm (cm-precision tape measure → mm input is natural).
// We convert to m before sending; server-side validation is in m bounds.
const antennaManualValid = computed(() => {
  const x_mm = parseFloat(antennaManualX.value);
  const y_mm = parseFloat(antennaManualY.value);
  return Number.isFinite(x_mm) && Number.isFinite(y_mm)
    && Math.abs(x_mm) <= 1000 && Math.abs(y_mm) <= 1000;
});

async function submitAntennaManual() {
  if (!antennaManualValid.value || !roverStatus.value.connected) return;
  antennaManualSubmitting.value = true;
  try {
    await request("/api/rover/set-antenna-offset", {
      method: "POST",
      body: JSON.stringify({
        a_x: parseFloat(antennaManualX.value) / 1000,
        a_y: parseFloat(antennaManualY.value) / 1000,
      }),
    });
    antennaManualX.value = "";
    antennaManualY.value = "";
  } catch (err) {
    notifyError(err.message);
  } finally {
    antennaManualSubmitting.value = false;
  }
}

async function submitWheelCal() {
  if (!wheelCalCanStart.value) return;
  wheelCalSubmitting.value = true;
  try {
    await request("/api/rover/calibrate-wheels", { method: "POST" });
  } catch (err) {
    notifyError(err.message);
  } finally {
    wheelCalSubmitting.value = false;
  }
}

async function submitWheelCalReset() {
  if (!roverStatus.value.connected || wheelCalResetSubmitting.value) return;
  if (!window.confirm("휠 보정을 초기화합니다 (scale_l/r=1.0, trim=0 µs). 계속하시겠습니까?")) {
    return;
  }
  wheelCalResetSubmitting.value = true;
  try {
    await request("/api/rover/reset-wheel-cal", { method: "POST" });
  } catch (err) {
    notifyError(err.message);
  } finally {
    wheelCalResetSubmitting.value = false;
  }
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
    notifyWarn("측정값은 15~32 V 범위 안의 숫자여야 합니다.");
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
    notifyError(err.message);
  } finally {
    batteryCalSubmitting.value = false;
  }
}

/* ── Rover log viewer ─────────────────────────────── */
const showLogs = ref(false);
const logEntries = ref([]);
// Newest first for the operator: ROS log buffer arrives oldest-first,
// but the inspector and full-screen viewer show the most recent first.
const logsNewestFirst = computed(() => [...logEntries.value].reverse());
const logsNewestFirstTrimmed = computed(() => [...logEntries.value].slice(-50).reverse());
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
  } catch (err) { notifyError(err.message); }
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
    notifyError(err.message);
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
// Snapshot create/list/restore/delete + modal state live in a composable;
// destructured so the template keeps referencing them by name.
const { showSnapshots, snapshotList, snapshotReason, openSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } =
  useCourseSnapshots({ activeCourseId, notifyError });

// Shared time formatter (also used for the log-upload timestamp), so it stays here.
function formatSnapshotTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ko-KR", { hour12: false });
}

/* ── Undo ─────────────────────────────────────────── */
// Each edit records an inverse closure. Undo functions hit the API directly so
// they don't re-enter the recording paths (no redo is tracked). Deleted cones
// are restored by re-creating them, so they come back with fresh ids.
const MAX_UNDO = 50;
function pushUndo(label, undo) {
  undoStack.value.push({ label, undo });
  if (undoStack.value.length > MAX_UNDO) undoStack.value.shift();
}
async function performUndo() {
  if (editLocked.value) return;
  const entry = undoStack.value.pop();
  if (!entry) return;
  try { await entry.undo(); }
  catch (err) { notifyError(`실행취소 실패: ${err.message}`); }
}

/* ── Cone CRUD ────────────────────────────────────── */
async function addCone(lat, lng, side, alt) {
  if (!activeCourseId.value) return;
  try {
    // alt가 undefined면 JSON.stringify가 키를 빼므로 수동(지도 클릭) 콘은 고도 없이
    // 저장되고, 로버에서 받은 콘만 RTK 고도(m)를 함께 보존한다.
    const res = await request(`/api/courses/${activeCourseId.value}/cones`, {
      method: "POST", body: JSON.stringify({ lat, lng, side, alt }),
    });
    const created = await res.json().catch(() => null);
    if (created && created.id != null) {
      const cid = created.id;
      pushUndo("콘 추가", () => request(`/api/cones/${cid}`, { method: "DELETE" }));
    }
  } catch (err) { notifyError(err.message); }
}

async function updateCone() {
  if (!selectedConeId.value) return;
  const id = selectedConeId.value;
  const before = (conesMap.value[activeCourseId.value] || []).find((c) => c.id === id);
  // 위치를 실제로 편집한 경우에만 lat/lng를 보낸다. side만 바꿨는데 stale 폼 좌표를 함께
  // 보내면, 선택 후 타 조작자가 SSE로 옮긴 콘 위치를 되돌린다(동시 편집 데이터 손실).
  const positionEdited = editLat.value !== editLatOrig.value || editLng.value !== editLngOrig.value;
  const body = { side: editSide.value };
  if (positionEdited) {
    const lat = parseFloat(editLat.value);
    const lng = parseFloat(editLng.value);
    if (isNaN(lat) || isNaN(lng)) return;
    body.lat = lat;
    body.lng = lng;
  }
  try {
    await request(`/api/cones/${id}`, {
      method: "PATCH", body: JSON.stringify(body),
    });
    if (before) pushUndo("콘 수정", () => request(`/api/cones/${id}`, {
      method: "PATCH", body: JSON.stringify({ lat: before.lat, lng: before.lng, side: before.side }),
    }));
    selectedConeId.value = null;
  } catch (err) { notifyError(err.message); }
}

async function deleteCone(id) {
  const courseId = activeCourseId.value;
  const before = (conesMap.value[courseId] || []).find((c) => c.id === id);
  try {
    await request(`/api/cones/${id}`, { method: "DELETE" });
    if (selectedConeId.value === id) selectedConeId.value = null;
    if (before) pushUndo("콘 삭제", () => request(`/api/courses/${courseId}/cones`, {
      method: "POST", body: JSON.stringify({ lat: before.lat, lng: before.lng, side: before.side, alt: before.alt }),
    }));
  } catch (err) { notifyError(err.message); }
}

// Delete every cone in the multi-selection. SSE `cones` deletes rebuild the
// marker layer, so we only have to fire the requests and clear local state.
async function deleteSelected() {
  const ids = [...multiSelectedIds.value];
  if (ids.length === 0 || editLocked.value) return;
  if (!confirm(`선택한 콘 ${ids.length}개를 삭제하시겠습니까?`)) return;
  if (rotateMode.value) exitRotateMode();
  const courseId = activeCourseId.value;
  const removed = (conesMap.value[courseId] || [])
    .filter((c) => multiSelectedIds.value.has(c.id))
    .map((c) => ({ lat: c.lat, lng: c.lng, side: c.side }));
  try {
    await Promise.all(ids.map((id) => request(`/api/cones/${id}`, { method: "DELETE" })));
    if (removed.length) pushUndo(`콘 ${removed.length}개 삭제`, () => Promise.all(
      removed.map((r) => request(`/api/courses/${courseId}/cones`, { method: "POST", body: JSON.stringify(r) }))
    ));
  } catch (err) {
    notifyError(`콘 삭제 실패: ${err.message}`);
  }
  if (ids.includes(selectedConeId.value)) selectedConeId.value = null;
  multiSelectedIds.value = new Set();
  updateMultiSelectIcons();
}

// Wipe every cone in the active course in one request. Undo re-adds them (with
// fresh ids); the SSE `cones` clear rebuilds the marker layer for everyone.
async function deleteAllCones() {
  const courseId = activeCourseId.value;
  if (!courseId) return;
  const all = (conesMap.value[courseId] || []).map((c) => ({ lat: c.lat, lng: c.lng, side: c.side, alt: c.alt }));
  if (all.length === 0) return;
  if (!confirm(`이 코스의 콘 ${all.length}개를 모두 삭제하시겠습니까? 되돌리기 전까지 지도에서 사라집니다.`)) return;
  if (rotateMode.value) exitRotateMode();
  try {
    await request(`/api/courses/${courseId}/cones`, { method: "DELETE" });
    selectedConeId.value = null;
    multiSelectedIds.value = new Set();
    pushUndo(`콘 ${all.length}개 전체 삭제`, () => Promise.all(
      all.map((c) => request(`/api/courses/${courseId}/cones`, { method: "POST", body: JSON.stringify(c) }))
    ));
  } catch (err) {
    notifyError(`전체 삭제 실패: ${err.message}`);
  }
}

/* ── Memo stickers ────────────────────────────────── */
// 메모는 콘과 별개의 주석 레이어다 — 편집 잠금(콘 오조작 방지)과 무관하게 항상
// 추가·이동·리사이즈·수정·삭제할 수 있다. 중심 좌표(lat/lng)와 실측 크기(width/
// height, m)로 서버에 저장하고, 서버가 'memos' SSE로 되쏘면 모든 조작자가 공유한다.
// 드래그/리사이즈/입력 중에는 memoBusy로 SSE 에코를 막아 조작이 끊기지 않게 한다.
let memoBusy = false;
let memoDrag = null;   // { id, startLat, startLng, origLat, origLng }
let memoResize = null; // { id, startX, startY, origW, origH, mpp }
let memoRotate = null; // { id, cx, cy, startAngle, orig, wasDragging }
let memoEditOrig = null; // 입력 시작 시점의 내용(undo·변경감지용)

function findMemo(id) {
  return (memosMap.value[activeCourseId.value] || []).find((m) => m.id === id);
}

// 지도 중앙에 기본 크기(대략 화면 170×120px 상당)의 빈 메모를 추가하고 바로 포커스.
async function addMemo() {
  const courseId = activeCourseId.value;
  if (!courseId || !map) return;
  const center = map.getCenter();
  const mpp = metersPerPixel(center.lat);
  try {
    const res = await request(`/api/courses/${courseId}/memos`, {
      method: "POST",
      body: JSON.stringify({ lat: center.lat, lng: center.lng, width: 150 * mpp, height: 48 * mpp, content: "" }),
    });
    const created = await res.json().catch(() => null);
    if (created && created.id != null) {
      // SSE 에코 전에 즉시 보이도록 낙관적 추가(에코가 같은 배열로 덮어써도 무해).
      const list = memosMap.value[courseId] || (memosMap.value[courseId] = []);
      if (!list.some((x) => x.id === created.id)) list.push(created);
      pushUndo("메모 추가", () => request(`/api/memos/${created.id}`, { method: "DELETE" }));
      nextTick(() => {
        document.querySelector(`.memo-label[data-id="${created.id}"] .memo-text`)?.focus();
      });
    }
  } catch (err) { notifyError(err.message); }
}

async function deleteMemo(id) {
  const before = findMemo(id);
  try {
    await request(`/api/memos/${id}`, { method: "DELETE" });
    if (before) pushUndo("메모 삭제", () => request(`/api/courses/${before.course_id}/memos`, {
      method: "POST",
      body: JSON.stringify({ lat: before.lat, lng: before.lng, width: before.width, height: before.height, content: before.content }),
    }));
  } catch (err) { notifyError(err.message); }
}

// 내용 편집: 포커스 동안 SSE 에코를 막고, blur 때 바뀐 경우에만 저장.
function onMemoFocus(m) { memoEditOrig = m.content; memoBusy = true; }
async function onMemoBlur(m) {
  memoBusy = false;
  const before = memoEditOrig;
  memoEditOrig = null;
  if (before === null || m.content === before) return;
  try {
    await request(`/api/memos/${m.id}`, { method: "PATCH", body: JSON.stringify({ content: m.content }) });
    pushUndo("메모 수정", () => request(`/api/memos/${m.id}`, { method: "PATCH", body: JSON.stringify({ content: before }) }));
  } catch (err) { m.content = before; notifyError(err.message); }
}

function memoContainerPoint(e) {
  const rect = map.getContainer().getBoundingClientRect();
  return L.point(e.clientX - rect.left, e.clientY - rect.top);
}

// 이동: 헤더 드래그. 잡은 지점의 위경도 이동량을 중심에 더해 그랩 지점이 안 튀게 한다.
function onMemoDragStart(m, e) {
  if (!map) return;
  e.preventDefault(); e.stopPropagation();
  memoBusy = true;
  const ll = map.containerPointToLatLng(memoContainerPoint(e));
  // 잡은 순간의 지도 드래그 활성 상태를 기억해 끝날 때 그대로 되돌린다 — 영역 선택
  // 모드는 지도 드래그를 꺼 두므로 무조건 enable()하면 그 모드가 깨진다.
  memoDrag = { id: m.id, startLat: ll.lat, startLng: ll.lng, origLat: m.lat, origLng: m.lng, wasDragging: map.dragging.enabled() };
  map.dragging.disable();
  window.addEventListener("pointermove", onMemoDragMove);
  window.addEventListener("pointerup", onMemoDragEnd);
}
function onMemoDragMove(e) {
  if (!memoDrag || !map) return;
  const ll = map.containerPointToLatLng(memoContainerPoint(e));
  const m = findMemo(memoDrag.id);
  if (!m) return;
  m.lat = memoDrag.origLat + (ll.lat - memoDrag.startLat);
  m.lng = memoDrag.origLng + (ll.lng - memoDrag.startLng);
  mapFrame.value++;
}
async function onMemoDragEnd() {
  window.removeEventListener("pointermove", onMemoDragMove);
  window.removeEventListener("pointerup", onMemoDragEnd);
  if (map && memoDrag?.wasDragging) map.dragging.enable();
  const d = memoDrag; memoDrag = null; memoBusy = false;
  if (!d) return;
  const m = findMemo(d.id);
  if (!m || (m.lat === d.origLat && m.lng === d.origLng)) return;
  try {
    await request(`/api/memos/${d.id}`, { method: "PATCH", body: JSON.stringify({ lat: m.lat, lng: m.lng }) });
    pushUndo("메모 이동", () => request(`/api/memos/${d.id}`, { method: "PATCH", body: JSON.stringify({ lat: d.origLat, lng: d.origLng }) }));
  } catch (err) { notifyError(err.message); }
}

// 크기 조절: 우하단 핸들 드래그. 중심 고정이라 코너를 dx px 끌면 좌우가 함께 벌어져
// 너비는 2·dx px 증가한다("중심 좌표 기준" 크기와 일관).
function onMemoResizeStart(m, e) {
  if (!map) return;
  e.preventDefault(); e.stopPropagation();
  memoBusy = true;
  memoResize = { id: m.id, startX: e.clientX, startY: e.clientY, origW: m.width, origH: m.height, mpp: metersPerPixel(m.lat), wasDragging: map.dragging.enabled() };
  map.dragging.disable();
  window.addEventListener("pointermove", onMemoResizeMove);
  window.addEventListener("pointerup", onMemoResizeEnd);
}
function onMemoResizeMove(e) {
  if (!memoResize) return;
  const m = findMemo(memoResize.id);
  if (!m) return;
  const min = memoResize.mpp * 30; // 최소 대략 30px
  m.width = Math.max(min, memoResize.origW + (e.clientX - memoResize.startX) * memoResize.mpp * 2);
  m.height = Math.max(min, memoResize.origH + (e.clientY - memoResize.startY) * memoResize.mpp * 2);
  mapFrame.value++;
}
async function onMemoResizeEnd() {
  window.removeEventListener("pointermove", onMemoResizeMove);
  window.removeEventListener("pointerup", onMemoResizeEnd);
  if (map && memoResize?.wasDragging) map.dragging.enable();
  const r = memoResize; memoResize = null; memoBusy = false;
  if (!r) return;
  const m = findMemo(r.id);
  if (!m || (m.width === r.origW && m.height === r.origH)) return;
  try {
    await request(`/api/memos/${r.id}`, { method: "PATCH", body: JSON.stringify({ width: m.width, height: m.height }) });
    pushUndo("메모 크기 조절", () => request(`/api/memos/${r.id}`, { method: "PATCH", body: JSON.stringify({ width: r.origW, height: r.origH }) }));
  } catch (err) { notifyError(err.message); }
}

// 회전: 좌하단 핸들 드래그. 칩 중심 기준 포인터 각도의 변화량을 현재 각도에 더한다.
// 중심은 회전 중에도 고정(transform-origin=center)이라 시작 시 한 번만 구한다.
function onMemoRotateStart(m, e) {
  if (!map) return;
  e.preventDefault(); e.stopPropagation();
  memoBusy = true;
  const chip = e.currentTarget.closest(".memo-label");
  const box = chip.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const startAngle = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  // sx/sy + dragged는 클릭(=초기화)과 드래그(=회전)를 구분하기 위한 것. 이동이
  // 임계값 미만이면 클릭으로 보고 회전을 0으로 초기화한다.
  memoRotate = { id: m.id, cx, cy, startAngle, orig: m.rotation || 0, wasDragging: map.dragging.enabled(), sx: e.clientX, sy: e.clientY, dragged: false };
  map.dragging.disable();
  window.addEventListener("pointermove", onMemoRotateMove);
  window.addEventListener("pointerup", onMemoRotateEnd);
}
function onMemoRotateMove(e) {
  if (!memoRotate) return;
  const m = findMemo(memoRotate.id);
  if (!m) return;
  if (!memoRotate.dragged) {
    const dx = e.clientX - memoRotate.sx, dy = e.clientY - memoRotate.sy;
    if (dx * dx + dy * dy > 9) memoRotate.dragged = true; // 3px 초과 이동 → 드래그
  }
  const a = (Math.atan2(e.clientY - memoRotate.cy, e.clientX - memoRotate.cx) * 180) / Math.PI;
  m.rotation = memoRotate.orig + (a - memoRotate.startAngle);
  mapFrame.value++;
}
async function onMemoRotateEnd() {
  window.removeEventListener("pointermove", onMemoRotateMove);
  window.removeEventListener("pointerup", onMemoRotateEnd);
  if (map && memoRotate?.wasDragging) map.dragging.enable();
  const rr = memoRotate; memoRotate = null; memoBusy = false;
  if (!rr) return;
  const m = findMemo(rr.id);
  if (!m) return;

  // 클릭(드래그 아님) → 회전 0으로 초기화.
  if (!rr.dragged) {
    m.rotation = 0;
    mapFrame.value++;
    if (rr.orig === 0) return; // 이미 0이면 저장 불필요
    try {
      await request(`/api/memos/${rr.id}`, { method: "PATCH", body: JSON.stringify({ rotation: 0 }) });
      pushUndo("메모 회전 초기화", () => request(`/api/memos/${rr.id}`, { method: "PATCH", body: JSON.stringify({ rotation: rr.orig }) }));
    } catch (err) { notifyError(err.message); }
    return;
  }

  // 드래그 → 회전 각도 저장.
  const norm = (((m.rotation || 0) % 360) + 360) % 360;
  m.rotation = norm;
  if (norm === rr.orig) return;
  try {
    await request(`/api/memos/${rr.id}`, { method: "PATCH", body: JSON.stringify({ rotation: norm }) });
    pushUndo("메모 회전", () => request(`/api/memos/${rr.id}`, { method: "PATCH", body: JSON.stringify({ rotation: rr.orig }) }));
  } catch (err) { notifyError(err.message); }
}

/* ── Rotate selection ─────────────────────────────── */
// All rotation is geometric on the cone *positions* (cones have no orientation
// field) — the whole selection spins rigidly around its centroid.
function selectionCentroid() {
  const cones = (conesMap.value[activeCourseId.value] || []).filter((c) => multiSelectedIds.value.has(c.id));
  if (cones.length === 0) return null;
  let lat = 0, lng = 0;
  for (const c of cones) { lat += c.lat; lng += c.lng; }
  return L.latLng(lat / cones.length, lng / cones.length);
}

function normalizeDeg(d) {
  d = d % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function enterRotateMode() {
  if (rotateMode.value) { exitRotateMode(); return; }
  if (editLocked.value) return;
  if (multiSelectedIds.value.size < 2) { notifyWarn("회전하려면 콘을 2개 이상 선택하세요."); return; }
  if (toolMode.value !== "none") exitToolMode(); // mutually exclusive with measurement tools
  selectMode.value = false;
  rotateMode.value = true;
  rotateAngle.value = 0;
  rotateInput.value = "";
  rebuildAllMarkers();      // drops per-cone draggability while rotating
  setupRotateHandle();
}

function exitRotateMode() {
  if (!rotateMode.value) return;
  rotateMode.value = false;
  rotateAngle.value = 0;
  suppressRebuild = false;
  teardownRotateHandle();
  if (map && activeTab.value === "courses") rebuildAllMarkers();
}

function teardownRotateHandle() {
  for (const layer of [rotateLine, rotatePivotMarker, rotateHandleMarker]) {
    if (layer) { try { map.removeLayer(layer); } catch {} }
  }
  rotateLine = rotatePivotMarker = rotateHandleMarker = null;
  rotateStartVectors = null;
  rotateStartPositions = null;
}

function setupRotateHandle() {
  teardownRotateHandle();
  if (!map) return;
  rotatePivot = selectionCentroid();
  if (!rotatePivot) return;

  const pivotPt = map.latLngToContainerPoint(rotatePivot);
  const handleLatLng = map.containerPointToLatLng(L.point(pivotPt.x, pivotPt.y - ROTATE_RADIUS_PX));

  rotateLine = L.polyline([rotatePivot, handleLatLng], {
    color: "#38bdf8", weight: 2, dashArray: "4 4", interactive: false,
  }).addTo(map);

  rotatePivotMarker = L.marker(rotatePivot, {
    icon: L.divIcon({ className: "", html: `<div class="rotate-pivot"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
    interactive: false, zIndexOffset: 900,
  }).addTo(map);

  rotateHandleMarker = L.marker(handleLatLng, {
    icon: L.divIcon({ className: "", html: `<div class="rotate-handle">↻</div>`, iconSize: [32, 32], iconAnchor: [16, 16] }),
    draggable: true, zIndexOffset: 1100,
  }).addTo(map);
  rotateHandleMarker.on("dragstart", onRotateDragStart);
  rotateHandleMarker.on("drag", onRotateDrag);
  rotateHandleMarker.on("dragend", onRotateDragEnd);
}

function onRotateDragStart() {
  if (!rotatePivot) return;
  const pivotPt = map.latLngToContainerPoint(rotatePivot);
  const hPt = map.latLngToContainerPoint(rotateHandleMarker.getLatLng());
  rotateStartBearing = Math.atan2(hPt.y - pivotPt.y, hPt.x - pivotPt.x);
  rotateStartVectors = new Map();
  rotateStartPositions = new Map();
  for (const c of (conesMap.value[activeCourseId.value] || [])) {
    if (!multiSelectedIds.value.has(c.id)) continue;
    const pt = map.latLngToContainerPoint([c.lat, c.lng]);
    rotateStartVectors.set(c.id, { x: pt.x - pivotPt.x, y: pt.y - pivotPt.y });
    rotateStartPositions.set(c.id, { lat: c.lat, lng: c.lng });
  }
  suppressRebuild = true; // hold off SSE-driven rebuilds until we commit
}

function onRotateDrag(e) {
  if (!rotateStartVectors || !rotatePivot) return;
  const pivotPt = map.latLngToContainerPoint(rotatePivot);
  const handleLatLng = rotateHandleMarker.getLatLng();
  const hPt = map.latLngToContainerPoint(handleLatLng);
  let delta = Math.atan2(hPt.y - pivotPt.y, hPt.x - pivotPt.x) - rotateStartBearing;
  let deg = delta * 180 / Math.PI;
  if (e?.originalEvent?.shiftKey) { deg = Math.round(deg / 5) * 5; delta = deg * Math.PI / 180; } // Shift → 5° steps
  rotateAngle.value = normalizeDeg(deg);

  const cos = Math.cos(delta), sin = Math.sin(delta);
  for (const [id, v] of rotateStartVectors) {
    const nx = v.x * cos - v.y * sin;
    const ny = v.x * sin + v.y * cos;
    const m = markers[`${activeCourseId.value}-${id}`];
    if (m) m.setLatLng(map.containerPointToLatLng(L.point(pivotPt.x + nx, pivotPt.y + ny)));
  }
  if (rotateLine) rotateLine.setLatLngs([rotatePivot, handleLatLng]);
}

async function onRotateDragEnd() {
  if (!rotateStartVectors) return;
  const startPositions = rotateStartPositions;
  const updates = [];
  for (const [id] of rotateStartVectors) {
    const m = markers[`${activeCourseId.value}-${id}`];
    if (m) { const { lat, lng } = m.getLatLng(); updates.push({ id, lat, lng }); }
  }
  rotateStartVectors = null;
  rotateStartPositions = null;

  const undoPositions = startPositions ? [...startPositions].map(([id, p]) => ({ id, lat: p.lat, lng: p.lng })) : [];
  try {
    await Promise.all(updates.map((u) =>
      request(`/api/cones/${u.id}`, { method: "PATCH", body: JSON.stringify({ lat: u.lat, lng: u.lng }) })
    ));
    if (undoPositions.length) pushUndo("콘 회전", () => Promise.all(
      undoPositions.map((p) => request(`/api/cones/${p.id}`, { method: "PATCH", body: JSON.stringify({ lat: p.lat, lng: p.lng }) }))
    ));
  } catch (err) {
    notifyError(`콘 회전 저장 실패: ${err.message}`);
    for (const [id, p] of (startPositions || [])) {
      const m = markers[`${activeCourseId.value}-${id}`];
      if (m) m.setLatLng([p.lat, p.lng]);
    }
  }
  suppressRebuild = false;
  rotateAngle.value = 0;
  rebuildAllMarkers();
  if (rotateMode.value) setupRotateHandle(); // re-anchor handle to the new centroid
}

// Rotate the selection by an exact angle (clockwise positive) typed into the panel.
async function rotateByDegrees(deg) {
  if (editLocked.value || multiSelectedIds.value.size < 2 || !map) return;
  const pivot = selectionCentroid();
  if (!pivot) return;
  const pivotPt = map.latLngToContainerPoint(pivot);
  const delta = deg * Math.PI / 180;
  const cos = Math.cos(delta), sin = Math.sin(delta);
  const cones = (conesMap.value[activeCourseId.value] || []).filter((c) => multiSelectedIds.value.has(c.id));
  const startPositions = cones.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng }));
  const updates = [];
  for (const c of cones) {
    const pt = map.latLngToContainerPoint([c.lat, c.lng]);
    const vx = pt.x - pivotPt.x, vy = pt.y - pivotPt.y;
    const nx = vx * cos - vy * sin, ny = vx * sin + vy * cos;
    const ll = map.containerPointToLatLng(L.point(pivotPt.x + nx, pivotPt.y + ny));
    updates.push({ id: c.id, lat: ll.lat, lng: ll.lng });
  }
  suppressRebuild = true;
  for (const u of updates) { const m = markers[`${activeCourseId.value}-${u.id}`]; if (m) m.setLatLng([u.lat, u.lng]); }
  try {
    await Promise.all(updates.map((u) =>
      request(`/api/cones/${u.id}`, { method: "PATCH", body: JSON.stringify({ lat: u.lat, lng: u.lng }) })
    ));
    pushUndo("콘 회전", () => Promise.all(
      startPositions.map((p) => request(`/api/cones/${p.id}`, { method: "PATCH", body: JSON.stringify({ lat: p.lat, lng: p.lng }) }))
    ));
  } catch (err) {
    notifyError(`콘 회전 저장 실패: ${err.message}`);
    for (const p of startPositions) { const m = markers[`${activeCourseId.value}-${p.id}`]; if (m) m.setLatLng([p.lat, p.lng]); }
  }
  suppressRebuild = false;
  rebuildAllMarkers();
  if (rotateMode.value) setupRotateHandle();
}

function applyRotateInput() {
  const deg = parseFloat(rotateInput.value);
  if (isNaN(deg) || deg === 0) return;
  rotateByDegrees(deg);
  rotateInput.value = "";
}

// Snap a tap to the nearest active-course cone within `maxPx` screen pixels.
function nearestCone(latlng, maxPx = 24) {
  const cones = conesMap.value[activeCourseId.value] || [];
  if (!cones.length || !map) return null;
  const p = map.latLngToContainerPoint(latlng);
  let best = null, bestD = maxPx;
  for (const c of cones) {
    const d = p.distanceTo(map.latLngToContainerPoint([c.lat, c.lng]));
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best;
}

function panToCone(cone) {
  selectedConeId.value = cone.id;
  map.setView([cone.lat, cone.lng], Math.max(map.getZoom(), 17));
}

// Pan so the given latLng lands at the visible-area center, not the
// raw container center. On mobile the inspector overlays the bottom
// half of the map — panTo([lat,lng]) puts the target behind the
// inspector. Computing the offset from container center to visible
// center and panBy that delta keeps the target visually centered.
function panToVisibleCenter(lat, lng, opts = {}) {
  if (!map) return;
  const animate = opts.animate ?? true;
  const zoom = opts.zoom ?? map.getZoom();
  const visible = getVisibleMapCenter();
  if (!visible) {
    map.setView([lat, lng], zoom, { animate });
    return;
  }
  // Place the target at the visible center by computing the new map center and
  // setView-ing to it — never panBy. For a target far from the current view
  // (e.g. a course far from where the map is looking) the pan offset exceeds
  // the map size, and Leaflet's panBy then takes a shortcut that adds a
  // screen-space offset to a world-space center. Under a non-zero map bearing
  // (leaflet-rotate) screen space ≠ world space, so that shortcut sends the
  // center tens of km off — into the sea, where the satellite basemap has no
  // tiles and the view renders blank grey. containerPointToLatLng applies the
  // inverse rotation correctly, so this is exact for any bearing, container
  // size, or target distance. On desktop (visible == size/2) it reduces to
  // centering on the target; the offset only bites on mobile, where the
  // inspector overlay shifts the visible center up.
  const targetPt = map.latLngToContainerPoint([lat, lng]);
  const centerPt = targetPt.add(map.getSize().divideBy(2)).subtract(visible);
  map.setView(map.containerPointToLatLng(centerPt), zoom, { animate });
}

/* ── Rover position ───────────────────────────────── */
const followRover = ref(loadPref("followRover", false, (v) => v === "true"));
watch(followRover, (v) => savePref("followRover", v));

// A rover with no GPS fix reports (0, 0); trusting it would drop the marker on
// — and pan the map to — Null Island, where the satellite basemap has no tiles
// and the whole view renders blank grey. Reject the null-island sentinel and
// any non-finite coordinate before touching the marker or the map. (The rover
// also gates its position POSTs on a 2D fix, so this is defense-in-depth for
// the live SSE stream.)
function isValidRoverPos(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
}

function centerOnRover() {
  // Follow always tracks the ROVER (the receiver is a handheld, not a chase
  // target), so recenter on the rover's position when follow is enabled.
  const lp = roverStatus.value.last_position;
  if (!lp || !map || !isValidRoverPos(lp.lat, lp.lng)) return;
  panToVisibleCenter(lp.lat, lp.lng);
}

function toggleFollowRover() {
  followRover.value = !followRover.value;
  if (followRover.value) { followReceiver.value = false; centerOnRover(); }
}

// GPS-tab-only "track receiver" toggle — mirrors 로버 추적 but centers on the
// receiver's position, and only acts while the GPS tab is open. Mutually
// exclusive with rover-follow so the map never chases two targets at once.
const followReceiver = ref(loadPref("followReceiver", false, (v) => v === "true"));
watch(followReceiver, (v) => savePref("followReceiver", v));

const receiverCanTrack = computed(() => {
  const r = receiver.value;
  const lp = r?.last_position;
  return !!(r?.mode === "capture" && lp && isValidRoverPos(lp.lat, lp.lng));
});

function centerOnReceiver() {
  const lp = receiver.value?.last_position;
  if (!lp || !map || !isValidRoverPos(lp.lat, lp.lng)) return;
  panToVisibleCenter(lp.lat, lp.lng);
}

function toggleFollowReceiver() {
  followReceiver.value = !followReceiver.value;
  if (followReceiver.value) { followRover.value = false; centerOnReceiver(); }
}

// Tap a surveyed point's card to center the map on it. Only surveyed points
// carry coordinates, so unsurveyed ones are inert. Turns off receiver tracking
// first — otherwise the next streamed receiver fix would immediately yank the
// map back to the receiver, undoing the recenter.
function panToSurveyPoint(p) {
  if (!map || p.lat == null || p.lng == null || !isValidRoverPos(p.lat, p.lng)) return;
  if (followReceiver.value) followReceiver.value = false;
  selectedSurveyPointId.value = p.id;
  panToVisibleCenter(p.lat, p.lng, { zoom: Math.max(map.getZoom(), 17) });
}

// Follow-pan, throttled and non-animated. Each pan moves the map, which forces
// a redraw of the cone canvas (hundreds of cones), so doing it on every rover
// position event (the rover + rover:status SSE pair can fire >10×/s) is what
// makes manual control lag on mobile. Cap to one pan per FOLLOW_MIN_MS, always
// using the latest position; animate:false avoids per-frame redraws.
function scheduleFollow(lat, lng) {
  // No follow-panning while the missions-history view owns the map (live layers
  // are torn down there); otherwise a streamed position yanks the replay away.
  if (!isValidRoverPos(lat, lng) || isMissionsView.value) return;
  followTarget = { lat, lng };
  if (followTimer != null) return;
  const wait = Math.max(0, FOLLOW_MIN_MS - (performance.now() - followLastPan));
  followTimer = setTimeout(() => {
    followTimer = null;
    followLastPan = performance.now();
    if (!map || !followTarget) return;
    const t = followTarget;
    followTarget = null;
    panToVisibleCenter(t.lat, t.lng, { animate: false });
  }, wait);
}

// Live-marker colours/labels per position source. The GPS receiver (teal) is the
// preferred cone-capture source; the rover (purple) is the fallback.
const ROVER_MARKER_COLORS = { rover: "#a855f7", receiver: "#14b8a6" };
const ROVER_MARKER_LABELS = { rover: "로버", receiver: "수신기" };

function roverSourceIcon(source) {
  const color = ROVER_MARKER_COLORS[source] || ROVER_MARKER_COLORS.rover;
  return L.divIcon({
    className: "",
    html: `<div style="width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid ${color};"></div>`,
    iconSize: [12, 12], iconAnchor: [6, 6],
  });
}

// Create / move / remove one device's live marker. Pass a null/invalid position
// to remove it (device disconnected, or not a live position source). Live layers
// are torn down in the missions-history view; don't resurrect from a stray frame.
function setDeviceMarker(kind, lat, lng) {
  if (!map || isMissionsView.value) return;
  const existing = deviceMarkers[kind];
  if (!isValidRoverPos(lat, lng)) {
    if (existing) { try { map.removeLayer(existing); } catch {} deviceMarkers[kind] = null; }
    return;
  }
  // Track-receiver follows the receiver marker's moves, but ONLY on the GPS tab.
  if (kind === "receiver" && followReceiver.value && activeTab.value === "gps") {
    scheduleFollow(lat, lng);
  }
  if (existing) { existing.setLatLng([lat, lng]); return; }
  const m = L.marker([lat, lng], {
    icon: roverSourceIcon(kind), zIndexOffset: 1000, interactive: false,
  }).addTo(map);
  m.bindTooltip(ROVER_MARKER_LABELS[kind] || ROVER_MARKER_LABELS.rover,
    { direction: "top", offset: [0, -8], permanent: true, className: "rover-tooltip" });
  deviceMarkers[kind] = m;
}

// Show/hide both device markers from a status snapshot. Each marker shows wherever
// its device has a valid last position — NOT gated on `connected`, matching the
// original behavior (the marker persists across a brief disconnect, and a one-shot
// position POST with no SSE stream still shows it). The receiver is a position
// source only in CAPTURE mode; in base mode it is a stationary RTCM source, so its
// marker is hidden there. Both show at once when both apply.
function syncDeviceMarkers(s) {
  if (!s) return;
  setDeviceMarker("rover", s.last_position?.lat, s.last_position?.lng);
  const rc = s.receiver;
  const recv = rc && rc.mode === "capture" ? rc.last_position : null;
  setDeviceMarker("receiver", recv?.lat, recv?.lng);
}

// Clicking a point's map marker selects it in the side list (and scrolls the
// list to it) without moving the map — the marker is already in view.
function selectSurveyPointFromMarker(p) {
  selectedSurveyPointId.value = p.id;
  nextTick(() => {
    const el = document.querySelector(`.gps-point-card[data-survey-id="${p.id}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

// Fixed magenta diamond marking a surveyed base-station point. The active base
// gets an amber ring; the point selected in the list gets a sky-blue ring
// (selection wins over the base ring when both apply). Distinct shape AND colour
// from the round cones (incl. the cyan right-side cone) and device markers so a
// base point never reads as a cone.
function surveyPointIcon(isBase, isSelected) {
  const size = isBase ? 18 : 14;
  const cls = ["survey-marker", isBase && "is-base", isSelected && "selected"]
    .filter(Boolean).join(" ");
  return L.divIcon({
    className: "",
    html: `<div class="${cls}"></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
}

// Draw one label + diamond per surveyed point. Visible only on the GPS tab (a
// base station is a GPS-management concept, not course-editing furniture) and
// never in the missions-history view, where live layers are torn down. Cheap to
// rebuild wholesale — there are only ever a handful of survey points.
function renderSurveyPoints() {
  if (!map) return;
  if (surveyPointLayer) {
    surveyPointLayer.clearLayers();
    try { map.removeLayer(surveyPointLayer); } catch {}
    surveyPointLayer = null;
  }
  if (activeTab.value !== "gps" || isMissionsView.value) return;
  const layer = L.layerGroup();
  for (const p of surveyedPoints.value) {
    if (!isValidRoverPos(p.lat, p.lng)) continue;
    const isBase = gpsConfig.value.ntrip_source === "base"
      && gpsConfig.value.active_base_point_id === p.id;
    const m = L.marker([p.lat, p.lng], {
      icon: surveyPointIcon(isBase, selectedSurveyPointId.value === p.id),
      zIndexOffset: 900, interactive: true, keyboard: false,
    });
    m.on("click", () => selectSurveyPointFromMarker(p));
    // 측량점 이름은 사용자 입력이다. Leaflet 툴팁은 문자열 content를 innerHTML로 삽입하므로
    // 텍스트 노드로 감싸 저장 XSS를 막는다.
    const tipEl = document.createElement("span");
    tipEl.textContent = p.name;
    m.bindTooltip(tipEl, {
      direction: "top", offset: [0, -12], permanent: true, className: "survey-tooltip",
    });
    layer.addLayer(m);
  }
  surveyPointLayer = layer.addTo(map);
}

async function addConeFromRover() {
  if (!activeCourseId.value) return;
  roverLoading.value = true;
  try {
    const res = await request("/api/rover/request", { method: "POST" });
    const { lat, lng, alt, source } = await res.json();
    // Use the source the server actually answered from (not the live, possibly
    // just-flipped position_source) so the cone lands on the right device marker.
    setDeviceMarker(source === "receiver" ? "receiver" : "rover", lat, lng);
    await addCone(lat, lng, currentSide.value, alt);
  } catch (err) {
    notifyError(err.message || "로버 위치 수신에 실패했습니다.");
  } finally { roverLoading.value = false; }
}

/* ── Path planning (TSP + 2-opt) ──────────────────── */

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

// 닫힌 루프 seq(= [start, ...route, start], 양 끝 start 고정)에서 seq[i..j]를
// 뒤집을 때 값이 바뀌는 비용 항(끊기는 두 변 + 이음매 4개 꼭짓점의 회전 페널티)
// 만 합산한다. 뒤집힌 구간 내부의 변 길이와 회전각은 보존되므로 이 항들만
// before/after로 비교하면 한 번의 reverse를 O(1)로 정확히 평가할 수 있다.
function loopLocalCost(seq, i, j) {
  const last = seq.length - 1;
  let s = 0;
  // 바뀌는 변: (i-1,i), (j,j+1)
  for (const e of [i - 1, j]) {
    if (e >= 0 && e < last) s += haversine(seq[e], seq[e + 1]);
  }
  // 바뀌는 회전 꼭짓점: i-1, i, j, j+1 (start 꼭짓점 0·last 제외)
  for (const v of [i - 1, i, j, j + 1]) {
    if (v >= 1 && v <= last - 1) s += turnAngle(seq[v - 1], seq[v], seq[v + 1]) * TURN_PENALTY;
  }
  return s;
}

// start에서 출발해 모든 콘을 한 번씩 찍고 start로 돌아오는 닫힌 루프에 대한
// 2-opt. 변경마다 전체 비용을 다시 계산하던 기존 구현은 O(passes·n^3)이라 콘이
// 수백 개면 브라우저가 멈췄다 → loopLocalCost로 한 수를 O(1)에 평가하여
// O(passes·n^2)로 낮췄다. first-improvement + 패스/시간 상한으로 항상 종료.
function twoOptLoop(route, start, budgetMs = 2000, maxPasses = 40) {
  const n = route.length;
  if (n < 3) return route.map((p) => ({ lat: p.lat, lng: p.lng }));
  const seq = [start, ...route.map((p) => ({ lat: p.lat, lng: p.lng })), start];
  const reverse = (lo, hi) => {
    while (lo < hi) { const t = seq[lo]; seq[lo] = seq[hi]; seq[hi] = t; lo++; hi--; }
  };
  const t0 = performance.now();
  let improved = true, passes = 0;
  while (improved && passes < maxPasses && performance.now() - t0 < budgetMs) {
    improved = false; passes++;
    for (let i = 1; i <= n; i++) {
      for (let j = i + 1; j <= n; j++) {
        const before = loopLocalCost(seq, i, j);
        reverse(i, j);
        if (loopLocalCost(seq, i, j) < before - 1e-9) improved = true;
        else reverse(i, j); // 개선 없으면 원복
      }
      if (performance.now() - t0 >= budgetMs) break;
    }
  }
  return seq.slice(1, n + 1);
}

// 한 경계선(같은 side의 콘들)을 거리 기준 최근접 이웃으로 잇는 열린 체인.
// 극단점(무게중심에서 가장 먼 콘)에서 출발 — 경계가 1차원 곡선이라 NN이 곧
// 경계 순서를 복원한다.
function nnChain(pts) {
  const n = pts.length;
  if (n <= 2) return pts.map((p) => ({ lat: p.lat, lng: p.lng }));
  const clat = pts.reduce((s, p) => s + p.lat, 0) / n;
  const clng = pts.reduce((s, p) => s + p.lng, 0) / n;
  const cen = { lat: clat, lng: clng };
  let s = 0, sd = -1;
  for (let k = 0; k < n; k++) { const d = haversine(pts[k], cen); if (d > sd) { sd = d; s = k; } }
  const used = new Array(n).fill(false);
  const order = [s]; used[s] = true; let cur = s;
  for (let step = 0; step < n - 1; step++) {
    let best = -1, bd = Infinity;
    for (let k = 0; k < n; k++) {
      if (used[k]) continue;
      const d = haversine(pts[cur], pts[k]);
      if (d < bd) { bd = d; best = k; }
    }
    used[best] = true; order.push(best); cur = best;
  }
  return order.map((i) => ({ lat: pts[i].lat, lng: pts[i].lng }));
}

// 열린 경로 2-opt(거리만, 회전 페널티 없음): 경계 체인의 꼬임을 편다. 한 수를
// 양 끝 두 변의 길이로 O(1) 평가.
function twoOptOpen(route, budgetMs = 800, maxPasses = 40) {
  const pts = route.map((p) => ({ lat: p.lat, lng: p.lng }));
  const n = pts.length;
  if (n < 4) return pts;
  const t0 = performance.now();
  let improved = true, passes = 0;
  while (improved && passes < maxPasses && performance.now() - t0 < budgetMs) {
    improved = false; passes++;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n; j++) {
        const a = pts[i], b = pts[i + 1], c = pts[j], dn = j + 1 < n ? pts[j + 1] : null;
        const oldD = haversine(a, b) + (dn ? haversine(c, dn) : 0);
        const newD = haversine(a, c) + (dn ? haversine(b, dn) : 0);
        if (newD < oldD - 1e-9) {
          let lo = i + 1, hi = j;
          while (lo < hi) { const t = pts[lo]; pts[lo] = pts[hi]; pts[hi] = t; lo++; hi--; }
          improved = true;
        }
      }
    }
  }
  return pts;
}

// 재구성한 경계 체인들을 start에서부터 그리디로 연결. 각 체인은 양방향 모두
// 시도해 가까운 끝에서 진입 → 연결 구간(경계 사이 이동)을 최소화.
function stitchChains(start, chains) {
  const remaining = chains.filter((c) => c.length > 0);
  const route = [];
  let cur = start;
  while (remaining.length) {
    let bestIdx = -1, bestDist = Infinity, bestRev = false;
    for (let idx = 0; idx < remaining.length; idx++) {
      const ch = remaining[idx];
      const d0 = haversine(cur, ch[0]);
      const d1 = haversine(cur, ch[ch.length - 1]);
      if (d0 < bestDist) { bestDist = d0; bestIdx = idx; bestRev = false; }
      if (d1 < bestDist) { bestDist = d1; bestIdx = idx; bestRev = true; }
    }
    const seg = remaining.splice(bestIdx, 1)[0];
    const ordered = bestRev ? [...seg].reverse() : seg;
    for (const p of ordered) route.push({ lat: p.lat, lng: p.lng });
    cur = route[route.length - 1];
  }
  return route;
}

function startPathPick() {
  openMissionBuilder();
}

async function loadMissionPresets() {
  const courseId = activeCourseId.value;
  const requestId = ++missionPresetRequestSeq;
  missionPresets.value = [];
  if (!courseId) return;
  try {
    const response = await request(`/api/rover/mission-presets?course_id=${courseId}`);
    const presets = (await response.json()).presets || [];
    if (presetResponseIsCurrent({
      requestId,
      latestRequestId: missionPresetRequestSeq,
      requestedCourseId: courseId,
      activeCourseId: activeCourseId.value,
    })) missionPresets.value = presets;
  } catch (error) {
    if (presetResponseIsCurrent({
      requestId,
      latestRequestId: missionPresetRequestSeq,
      requestedCourseId: courseId,
      activeCourseId: activeCourseId.value,
    })) notifyError(`프리셋을 불러오지 못했습니다: ${error.message}`);
  }
}

function coneRouteItem(cone) {
  return {
    cone_id: cone.id, lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side,
  };
}

function openMissionBuilder() {
  if (!activeCourseId.value) return;
  const mission = activeMission.value;
  missionBuilderEditing.value = !!mission && missionHeld.value;
  missionBuilderBusy.value = false;
  missionBuilderBase.value = missionBuilderEditing.value ? missionDraftToken(mission) : null;
  if (missionBuilderEditing.value) {
    missionBuilderItems.value = mission.waypoints
      .filter((waypoint) => waypoint.state === "pending" || waypoint.state === "active")
      .map((waypoint) => ({ ...waypoint, waypoint_id: waypoint.id }));
    missionFinishBehavior.value = mission.finish_behavior;
  } else if (pathWaypoints.value.length > 0) {
    missionBuilderItems.value = pathWaypoints.value.map((waypoint) => ({ ...waypoint }));
  } else {
    const start = roverStatus.value.last_position || activeCones.value[0] || null;
    missionBuilderItems.value = optimizeConeRoute(activeCones.value, start).map(coneRouteItem);
    missionFinishBehavior.value = "stop";
  }
  showMissionBuilder.value = true;
  loadMissionPresets();
}

function installMissionBuilderPayload({ items, finishBehavior, presetReference = null }) {
  const editing = missionBuilderEditing.value;
  const completed = editing && activeMission.value
    ? activeMission.value.waypoints.filter((waypoint) => waypoint.state === "completed")
    : [];
  pathWaypoints.value = [
    ...completed,
    ...items.map((item) => ({ ...item, state: item.state === "active" ? "active" : "pending" })),
  ];
  missionFinishBehavior.value = finishBehavior;
  pathPresetReference.value = presetReference
    ? { ...presetReference, courseId: activeCourseId.value }
    : null;
  const start = activeMission.value?.start_position || roverStatus.value.last_position || pathWaypoints.value[0];
  pathStart = start ? { lat: start.lat, lng: start.lng } : null;
  pathReturnOrigin = pathWaypoints.value.length === 0 && finishBehavior === "return_to_start"
    ? (roverStatus.value.last_position ? { ...roverStatus.value.last_position } : null)
    : null;
  executedIndex.value = completed.length;
  executionStartIdx = completed.length;
  pathMissionBase = editing ? missionBuilderBase.value : null;
  roverMode.value = editing ? "stopped" : "path-ready";
  renderPath();
}

async function submitMissionBuilder(payload, { run = false } = {}) {
  if (missionBuilderBusy.value) return;
  const submission = missionBuilderSubmission({ editing: missionBuilderEditing.value, run });
  if (!submission.persist) {
    installMissionBuilderPayload(payload);
    showMissionBuilder.value = false;
    missionBuilderBase.value = null;
    if (submission.next === "execute") openPreflight("execute");
    return;
  }

  const mission = activeMission.value;
  const draft = missionBuilderBase.value;
  missionBuilderBusy.value = true;
  // Close before the request so an incoming authoritative mission response
  // cannot leave an editable stale copy mounted behind the result.
  showMissionBuilder.value = false;
  try {
    const edited = await syncMissionRemaining(mission, {
      draft,
      items: payload.items,
      finishBehavior: payload.finishBehavior,
    });
    missionBuilderBase.value = missionDraftToken(edited);
    notifySuccess("남은 미션 경로를 저장했습니다.");
    if (submission.next === "resume") {
      openPreflight(edited.status === "ready" ? "start-existing" : "resume", {
        routeAlreadySynced: submission.routeAlreadySynced,
        emptyRouteMode: payload.emptyRouteMode,
      });
    }
  } catch (error) {
    missionBuilderBase.value = null;
    notifyError(`남은 경로 저장 실패: ${error.message}`);
    // A 409 response intentionally contains no route body. Fetch the current
    // authority before allowing any further start/resume action.
    await fetchRoverStatus();
  } finally {
    missionBuilderBusy.value = false;
  }
}

async function applyMissionBuilder(payload) {
  await submitMissionBuilder(payload);
}

async function runMissionBuilder(payload) {
  await submitMissionBuilder(payload, { run: true });
}

async function saveMissionPreset({ name, items, finishBehavior }) {
  if (missionPresetBusy.value) return;
  missionPresetBusy.value = true;
  try {
    const existing = missionPresets.value.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
    await request(existing ? `/api/rover/mission-presets/${existing.id}` : "/api/rover/mission-presets", {
      method: existing ? "PUT" : "POST",
      body: JSON.stringify(buildMissionPresetPayload({
        courseId: activeCourseId.value,
        name,
        finishBehavior,
        items,
        existing,
      })),
    });
    notifySuccess(`미션 프리셋 '${name}'을 ${existing ? "갱신" : "저장"}했습니다.`);
    await loadMissionPresets();
  } catch (error) {
    notifyError(`프리셋 저장 실패: ${error.message}`);
    await loadMissionPresets();
  } finally {
    missionPresetBusy.value = false;
  }
}

async function deleteMissionPreset(id) {
  if (missionPresetBusy.value) return;
  if (!window.confirm("이 미션 프리셋을 삭제할까요?")) return;
  const preset = missionPresets.value.find((item) => item.id === id);
  if (!preset) {
    notifyWarn("프리셋 목록이 변경되었습니다. 최신 목록을 다시 불러옵니다.");
    await loadMissionPresets();
    return;
  }
  missionPresetBusy.value = true;
  try {
    await request(`/api/rover/mission-presets/${id}`, {
      method: "DELETE",
      body: JSON.stringify(buildMissionPresetDeletePayload(preset)),
    });
    await loadMissionPresets();
  } catch (error) {
    notifyError(`프리셋 삭제 실패: ${error.message}`);
    await loadMissionPresets();
  } finally {
    missionPresetBusy.value = false;
  }
}

function computePathFromRover() {
  const lp = roverStatus.value.last_position;
  if (!lp || lp.lat == null || lp.lng == null) {
    notifyWarn("로버 위치를 알 수 없습니다.");
    return;
  }
  computePath(lp.lat, lp.lng);
}

function computePath(startLat, startLng) {
  const allCones = activeCones.value;
  if (allCones.length === 0) { roverMode.value = "none"; return; }

  const start = { lat: startLat, lng: startLng };

  // 콘 등록(id) 순서는 신뢰할 수 없다(좌/우 블록이 섞이고 큰 점프 존재). 따라서
  // 순서에 의존하지 않고 기하학으로 경로를 만든다.
  //   1) side별로 묶어 각 경계선을 NN 체인 + 열린 2-opt로 순서 복원
  //   2) start에서부터 체인들을 그리디로 이어 붙여 시드 경로 구성
  //   3) 닫힌 루프 2-opt(거리 + 회전 페널티)로 연결 구간을 다듬어 거리 단축
  const chains = ["left", "right", "center"]
    .map((side) => allCones.filter((c) => c.side === side))
    .filter((g) => g.length > 0)
    .map((g) => twoOptOpen(nnChain(g)));

  const seed = stitchChains(start, chains);
  const optimized = twoOptLoop(seed, start);

  pathStart = { lat: startLat, lng: startLng };
  pathReturnOrigin = null;
  pathPresetReference.value = null;
  pathWaypoints.value = optimized;
  renderPath();

  roverMode.value = "path-ready";
}

function renderPath() {
  if (!map) return;

  if (pathLine) { map.removeLayer(pathLine); pathLine = null; }
  if (pathStartMarker) { map.removeLayer(pathStartMarker); pathStartMarker = null; }
  if (pathEndMarker) { map.removeLayer(pathEndMarker); pathEndMarker = null; }
  pathCumDist = [];
  pathTotalDist = 0;
  pathDistance.value = 0;
  const geometry = missionPathGeometry({
    pathStart,
    waypoints: pathWaypoints.value,
    finishBehavior: missionFinishBehavior.value,
    returnOrigin: pathReturnOrigin,
  });
  if (!geometry) return;

  if (geometry.returnOnly) {
    pathTotalDist = haversine(geometry.points[0], geometry.points[1]);
    pathDistance.value = pathTotalDist;
  } else {
    // Cumulative distance from the original mission start. A return leg is only
    // drawn and counted when the mission explicitly requests it.
    pathCumDist = new Array(pathWaypoints.value.length);
    let acc = haversine(pathStart, pathWaypoints.value[0]);
    pathCumDist[0] = acc;
    for (let i = 1; i < pathWaypoints.value.length; i++) {
      acc += haversine(pathWaypoints.value[i - 1], pathWaypoints.value[i]);
      pathCumDist[i] = acc;
    }
    pathTotalDist = acc + (missionFinishBehavior.value === "return_to_start"
      ? haversine(pathWaypoints.value[pathWaypoints.value.length - 1], pathStart) : 0);
    pathDistance.value = pathTotalDist;
  }

  const fullPath = geometry.points;
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

  const origin = fullPath[0];
  pathStartMarker = pathLabel(geometry.returnOnly ? "R" : "S", [origin.lat, origin.lng], "#22c55e").addTo(map);
  const end = fullPath[fullPath.length - 1];
  pathEndMarker = pathLabel("E", [end.lat, end.lng], "#ef4444").addTo(map);
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
  pathPresetReference.value = null;
  pathWaypoints.value = next;
  renderPath();
}

function clearPath({ endMissionOnServer = true } = {}) {
  // Local overlays are never allowed to destroy server mission state. Ending a
  // mission is only performed by the explicit, confirmed abandon action.
  void endMissionOnServer;
  if (pathLine) { map.removeLayer(pathLine); pathLine = null; }
  if (pathStartMarker) { map.removeLayer(pathStartMarker); pathStartMarker = null; }
  if (pathEndMarker) { map.removeLayer(pathEndMarker); pathEndMarker = null; }
  pathStart = null;
  pathReturnOrigin = null;
  pathPresetReference.value = null;
  pathWaypoints.value = [];
  pathCumDist = [];
  pathTotalDist = 0;
  pathMissionBase = null;
  displayedMissionId = null;
  executionStartIdx = 0;
  executedIndex.value = 0;
  pathProgress.value = 0;
  pathDistance.value = 0;
  missionFinishBehavior.value = "stop";
  showMissionBuilder.value = false;
  missionBuilderBase.value = null;
  clearSprayMarkers();
  if (roverMode.value !== "manual") roverMode.value = "none";
}

// "미션 종료" 버튼 핸들러. 보존된(비상정지·중단) 미션을 폐기하는 파괴적 작업이라
// 반드시 확인을 받는다.
async function abandonMission() {
  if (!window.confirm("진행 중인 미션을 종료하고 폐기합니다.\n'이어서 실행'할 수 없게 됩니다. 계속하시겠습니까?")) return;
  // 서버 미션 종료를 먼저 await 한다. 비상정지 래치가 걸려 있으면 nav_state 는
  // 계속 EMERGENCY_STOP 이므로, reconcileRoverMode 가 mission_progress 가 비워진
  // (hasMission=false) 상태를 확인하기 전에 로컬 정리를 하면 다음 status tick 에서
  // 다시 "stopped" 로 튕겨, 미션이 비상정지 해제 후에야 종료되는 것처럼 보인다.
  // 종료 응답을 받은 뒤 로컬 정리를 해야 그 즉시 종료가 반영된다.
  if (activeMission.value?.id) {
    try { await request(`/api/missions/${activeMission.value.id}/end`, { method: "POST" }); }
    catch (err) { notifyWarn(`미션 종료 실패: ${err.message}`); return; }
  }
  roverStatus.value = { ...roverStatus.value, active_mission: null };
  clearPath({ endMissionOnServer: false });
}

function onPathBtn() {
  if (roverMode.value === "executing") return; // 실행 중에는 무시
  if (roverMode.value === "stopped") {
    openPreflight(activeMission.value?.status === "ready" ? "start-existing" : "resume");
    return;
  }
  if (roverMode.value === "path-ready") { openPreflight("execute"); return; }
  if (roverMode.value === "path-pick") { clearPath(); return; }
  if (roverMode.value === "none") { startPathPick(); }
}

function openPreflight(mode, { routeAlreadySynced = false, emptyRouteMode = null } = {}) {
  preflightMode.value = mode;
  preflightRouteAlreadySynced.value = routeAlreadySynced;
  preflightMissionToken.value = mode === "execute" ? null : missionCommandToken(activeMission.value);
  preflightMissionDraft.value = mode === "execute" ? null : missionDraftToken(activeMission.value);
  preflightEmptyRouteMode.value = emptyRouteMode || missionEmptyResumeMode(activeMission.value);
  preflightForce.value = false;
  showPreflight.value = true;
}

function cancelPreflight() {
  showPreflight.value = false;
  preflightMissionToken.value = null;
  preflightMissionDraft.value = null;
  preflightEmptyRouteMode.value = null;
}

async function confirmPreflight() {
  if (!preflightCanConfirm.value) {
    notifyError(preflightHasBlockingFailure.value
      ? "비상정지가 해제되기 전에는 미션을 시작하거나 재개할 수 없습니다."
      : "점검 항목을 확인하거나 허용 가능한 경고를 명시적으로 승인하세요.");
    return;
  }
  const force = preflightForce.value && !preflightAllOk.value;
  showPreflight.value = false;
  const commandToken = preflightMissionToken.value;
  const commandDraft = preflightMissionDraft.value;
  const emptyRouteMode = preflightEmptyRouteMode.value;
  preflightMissionToken.value = null;
  preflightMissionDraft.value = null;
  preflightEmptyRouteMode.value = null;
  if (preflightMode.value === "resume") {
    await resumePath({ force, routeAlreadySynced: preflightRouteAlreadySynced.value, commandToken, commandDraft, emptyRouteMode });
  } else if (preflightMode.value === "start-existing") {
    await startExistingPath({ force, routeAlreadySynced: preflightRouteAlreadySynced.value, commandToken, commandDraft, emptyRouteMode });
  } else {
    await executePath({ force });
  }
}

async function syncMissionRemaining(mission, {
  draft = pathMissionBase,
  items = null,
  finishBehavior = missionFinishBehavior.value,
} = {}) {
  const remaining = items || pathWaypoints.value.filter((waypoint) =>
    waypoint.state === "pending" || waypoint.state === "active");
  const body = buildMissionRemainingPayload({
    draft,
    mission,
    finishBehavior,
    items: remaining,
  });
  const response = await request(`/api/missions/${mission.id}/remaining`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  const edited = await response.json();
  roverStatus.value = { ...roverStatus.value, active_mission: edited };
  restoreActiveMission(edited);
  return edited;
}

const MISSION_COMMAND_LABELS = {
  start: "미션 시작",
  resume: "미션 재개",
  pause: "미션 일시정지",
};

function applyMissionCommandResponse(data, action) {
  const decision = missionCommandResponseDecision(data);
  if (decision.mission) {
    roverStatus.value = { ...roverStatus.value, active_mission: decision.mission };
    restoreActiveMission(decision.mission);
    reconcileRoverMode(roverStatus.value);
  }
  if (decision.failed) {
    notifyError(`${MISSION_COMMAND_LABELS[action] || "미션 명령"}이 로버에 전달되지 않았습니다. `
      + "로버가 계속 움직일 수 있으므로 화면과 현장 상태를 확인하고 안전 정지를 준비하세요.");
    if (!decision.mission) void fetchRoverStatus();
    return false;
  }
  return true;
}

async function startExistingPath(opts = {}) {
  const mission = activeMission.value;
  if (!mission) return;
  try {
    const preflightCommandBody = buildMissionCommandPayload({
      token: opts.commandToken,
      missionId: mission.id,
      force: opts.force,
    });
    roverMode.value = "executing";
    const edited = opts.routeAlreadySynced ? mission : await syncMissionRemaining(mission, { draft: opts.commandDraft });
    const commandBody = opts.routeAlreadySynced ? preflightCommandBody : buildMissionCommandPayload({
      token: missionCommandTokenAfterSync({
        routeAlreadySynced: opts.routeAlreadySynced,
        preflightToken: opts.commandToken,
        editedMission: edited,
      }),
      missionId: edited.id,
      force: opts.force,
    });
    const response = await request(`/api/missions/${edited.id}/start`, {
      method: "POST",
      body: JSON.stringify(commandBody),
    });
    const data = await response.json();
    applyMissionCommandResponse(data, "start");
  } catch (error) {
    roverMode.value = "stopped";
    notifyError(error.message);
  }
}

async function executePath(opts = {}) {
  if (pathWaypoints.value.length === 0) return;
  executedIndex.value = 0;
  executionStartIdx = 0;
  pathProgress.value = 0;
  clearSprayMarkers();
  roverMode.value = "executing";
  localMissionCreatePending = true;
  try {
    const createResponse = await request("/api/missions", {
      method: "POST",
      body: JSON.stringify(buildMissionCreatePayload({
        courseId: activeCourseId.value,
        finishBehavior: missionFinishBehavior.value,
        items: pathWaypoints.value,
        presetReference: pathPresetReference.value?.courseId === activeCourseId.value
          ? pathPresetReference.value : null,
      })),
    });
    const mission = await createResponse.json();
    roverStatus.value = { ...roverStatus.value, active_mission: mission };
    restoreActiveMission(mission, { expectedLocalMission: true });
    const startResponse = await request(`/api/missions/${mission.id}/start`, {
      method: "POST",
      body: JSON.stringify(buildMissionCommandPayload({
        token: missionCommandToken(mission),
        missionId: mission.id,
        force: opts.force,
      })),
    });
    const started = await startResponse.json();
    applyMissionCommandResponse(started, "start");
  } catch (err) {
    roverMode.value = activeMission.value ? "stopped" : "path-ready";
    notifyError(err.message);
  } finally {
    localMissionCreatePending = false;
  }
}

async function resumePath(opts = {}) {
  const mission = activeMission.value;
  if (!mission) {
    notifyError("이어갈 활성 미션이 없습니다.");
    return;
  }
  try {
    const preflightCommandBody = buildMissionCommandPayload({
      token: opts.commandToken,
      missionId: mission.id,
      force: opts.force,
    });
    const remaining = pathWaypoints.value.filter((waypoint) =>
      waypoint.state === "pending" || waypoint.state === "active");
    executionStartIdx = pathWaypoints.value.length - remaining.length;
    executedIndex.value = executionStartIdx;
    roverMode.value = "executing";
    const edited = opts.routeAlreadySynced ? mission : await syncMissionRemaining(mission, { draft: opts.commandDraft });
    const commandBody = opts.routeAlreadySynced ? preflightCommandBody : buildMissionCommandPayload({
      token: missionCommandTokenAfterSync({
        routeAlreadySynced: opts.routeAlreadySynced,
        preflightToken: opts.commandToken,
        editedMission: edited,
      }),
      missionId: edited.id,
      force: opts.force,
    });
    const resumeResponse = await request(`/api/missions/${edited.id}/resume`, {
      method: "POST",
      body: JSON.stringify(commandBody),
    });
    const resumed = await resumeResponse.json();
    applyMissionCommandResponse(resumed, "resume");
  } catch (err) {
    roverMode.value = "stopped";
    notifyError(err.message);
  }
}

function updatePathProgress(lat, lng) {
  if (pathTotalDist === 0) return;
  if (pathWaypoints.value.length === 0) {
    if (missionFinishBehavior.value !== "return_to_start" || !pathStart) return;
    const remaining = haversine({ lat, lng }, pathStart);
    const walked = Math.max(0, pathTotalDist - remaining);
    pathProgress.value = Math.min(100, Math.round((walked / pathTotalDist) * 100));
    return;
  }
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

/* ── Soft pause / resume ──────────────────────────────
   A soft pause holds the mission WITHOUT the E-Stop latch, so the operator can
   drive manually (e.g. around an obstacle) and then resume from the current
   waypoint. Pause is only meaningful while the rover is actually driving the
   mission; resume is offered whenever nav_state is PAUSED. */
const PAUSABLE_NAV = new Set(["CALIBRATING", "NAVIGATING", "SETTLING", "SPRAYING"]);
const pauseBusy = ref(false);
async function pauseMission() {
  if (pauseBusy.value) return;
  if (!activeMission.value?.id) return;
  pauseBusy.value = true;
  try {
    const response = await request(`/api/missions/${activeMission.value.id}/pause`, { method: "POST" });
    const data = await response.json();
    applyMissionCommandResponse(data, "pause");
  } catch (err) {
    notifyError(`일시정지 실패: ${err.message}`);
  } finally {
    pauseBusy.value = false;
  }
}
async function resumeMission() {
  if (pauseBusy.value || !activeMission.value?.id) return;
  openPreflight("resume");
}

// Perception flagged a driving-corridor obstacle. The rover ALREADY paused
// itself locally over ROS (this is just the operator-facing half): jump to the
// rover tab and auto-open the camera so the operator can see what's blocking,
// then drive manually around it and resume. The persistent banner is driven by
// roverStatus.obstacle.active (server-side, so a late-joining tab still sees it).
function onObstacle(data) {
  const dist = typeof data?.nearest_m === "number" ? ` (~${data.nearest_m.toFixed(1)} m)` : "";
  notifyWarn(`주행 경로 장애물 감지${dist} — 미션 자동 일시정지. 카메라로 확인 후 수동으로 비켜 운전하고 재개하세요.`);
  if (activeTab.value !== "rover") activeTab.value = "rover";
  startCamera();
}

/* ── Manual control ───────────────────────────────── */
function startManualControl() {
  if (manualAuthorityReleaseBusy.value) return;
  if (!roverStatus.value.connected) {
    notifyWarn("로버가 연결되어 있지 않습니다.");
    return;
  }
  // During a soft pause the operator drives manually to clear an obstacle, then
  // resumes — so KEEP the mission overlay/progress. clearPath() would not only
  // wipe the overlay (only rebuilt on mount/SSE-reconnect) but also POST
  // /api/rover/end-mission, abandoning the very mission we want to resume.
  // Outside a pause, manual mode discards any in-progress path pick as before.
  if (!missionHeld.value) clearPath();
  roverMode.value = "manual";
  manualThrottle.value = 0;
  manualSteering.value = 0;
  manualFailCount = 0;
  sendControl();
  controlInterval = setInterval(sendControl, 50);
}

function stopManualControl() {
  if (manualAuthorityReleaseBusy.value) return;
  if (controlInterval) { clearInterval(controlInterval); controlInterval = null; }
  manualThrottle.value = 0;
  manualSteering.value = 0;
  manualFailCount = 0;
  sendControl();
  if (roverMode.value === "manual") {
    // Fail the pump off when leaving manual mode. The PUMP toggle only
    // exists in manual mode, so exiting it (operator click OR the 5-fail
    // auto-release above) must not strand a running liquid pump — the same
    // asymmetry we avoid on E-Stop / heartbeat loss. Best-effort: on a lost
    // link this POST also fails, but then the MCU heartbeat fail-safe stops
    // the pump anyway.
    if (pumpOn.value) {
      request("/api/rover/pump", {
        method: "POST",
        body: JSON.stringify({ on: false }),
      }).catch(() => {});
    }
    roverMode.value = "none";
    // Snap straight back to the server-truth mode — e.g. if the operator was
    // manually clearing an obstacle during a soft pause, this re-shows the
    // 재개 button immediately instead of waiting for the next status tick.
    reconcileRoverMode(roverStatus.value);
  }
}

async function releaseManualForMissionAuthority() {
  if (manualAuthorityReleaseBusy.value) return;
  manualAuthorityReleaseBusy.value = true;
  if (controlInterval) { clearInterval(controlInterval); controlInterval = null; }
  activePointerId = null;
  manualThrottle.value = 0;
  manualSteering.value = 0;
  manualFailCount = 0;
  syncJoystickDom();
  // A slow non-zero POST may already be in flight when the remote mission
  // snapshot arrives. Wait for every request issued before interval shutdown,
  // then make zero the final manual command observed by the server.
  await waitForManualControlDrain(pendingManualControlRequests);
  try {
    await request("/api/rover/control", {
      method: "POST",
      body: JSON.stringify({ throttle: 0, steering: 0 }),
    });
  } catch (error) {
    notifyError(`다른 운영자가 미션을 재개해 수동 제어 송신을 중단했지만 0 명령은 확인되지 않았습니다: ${error.message}. `
      + "로버의 자율 주행 상태와 현장을 즉시 확인하세요.");
  }
  if (pumpOn.value) {
    try {
      await request("/api/rover/pump", {
        method: "POST",
        body: JSON.stringify({ on: false }),
      });
    } catch (error) {
      notifyError(`서버 미션 권한 전환 중 펌프 정지를 확인하지 못했습니다: ${error.message}`);
    }
  }
  manualThrottle.value = 0;
  manualSteering.value = 0;
  roverMode.value = "none";
  manualAuthorityReleaseBusy.value = false;
  reconcileRoverMode(roverStatus.value);
}

async function sendControl() {
  try {
    await trackManualControlRequest(pendingManualControlRequests, request("/api/rover/control", {
      method: "POST",
      body: JSON.stringify({ throttle: manualThrottle.value, steering: manualSteering.value }),
    }));
    manualFailCount = 0;
  } catch {
    manualFailCount++;
    // 5 consecutive failures (~250ms) → auto-release manual control
    if (manualFailCount >= 5 && roverMode.value === "manual") {
      stopManualControl();
      notifyWarn("로버 연결이 끊어져 수동 제어를 해제했습니다.");
    }
  }
}

/* ── Live camera (MJPEG) ──────────────────────────────
   The <img> points at the server's multipart relay. Mounting it opens the
   stream (server tells the rover to start capturing); unmounting closes it
   (rover stops). cameraReqId cache-busts so re-opening starts a fresh stream. */
const cameraOn = ref(false);
const cameraError = ref(false);
const cameraReqId = ref(0);
// WebRTC is the PRIMARY 2D source (H.264, ~5-10× less uplink than MJPEG). We go
// straight to it — no MJPEG-first hop. The MJPEG <img> is a pure fallback, opened
// ONLY if WebRTC can't establish within a grace window or drops mid-session (e.g.
// a restrictive network with no viable ICE path). `mjpegFallback` gates that.
const mjpegFallback = ref(false);
let webrtcFallbackTimer = null;
const WEBRTC_FALLBACK_MS = 8000;   // WebRTC connect grace before falling back to MJPEG
// Low-latency WebRTC (rover-2d mono/composite). Preferred when connected; the
// MJPEG <img> stays as the fallback. The depth composite still works (the rover
// renders it into this stream too, same as MJPEG).
const cameraVideoEl = ref(null);
const cameraImgEl = ref(null);   // MJPEG fallback — needs an explicit src-clear to abort
const webrtc = useWhepStream();
// Top-level ref so the template/watch auto-unwrap it. `connected` (track
// negotiated, stable — no videoWidth blips) drives the MJPEG fallback and the
// "no signal" notice, so both settle the instant the WebRTC track arrives/dies.
const webrtcConnected = webrtc.connected;
// Both-eyes depth composite toggle (rendered on the rover). Only meaningful while
// the camera is on; the server resets it when the last viewer leaves. Kept in
// sync with the server's reported state via pollCameraStatus (s.depth).
const cameraDepthOn = ref(false);
let cameraStatusPoll = null;
let cameraLastOkAt = 0;            // last poll that saw fresh frames (ms)
// 1×1 transparent GIF. Assigning this as the <img> src replaces (and thus aborts)
// the in-flight MJPEG multipart load — a reliable teardown Chrome does NOT do when
// the element is merely removed from the DOM.
const BLANK_IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const cameraStreamUrl = computed(() => {
  // Open the MJPEG <img> ONLY as a fallback: WebRTC not negotiated AND the grace
  // window elapsed / it dropped (mjpegFallback). Once WebRTC is `connected`, the
  // fallback drops (→ mjpeg-off, rover stops JPEG) so a normal 2D session pays only
  // the low-bandwidth H.264 and never the MJPEG-first hop.
  if (!cameraOn.value || webrtc.connected.value || !mjpegFallback.value) return "";
  const base = import.meta.env.PROD ? "/course" : "";
  // cameraReqId is the cache-bust AND the reconnect lever: bumping it makes the
  // <img> re-request a fresh stream (multipart/x-mixed-replace does NOT
  // auto-reconnect after a server restart / dropped socket).
  return `${base}/api/rover/camera/stream?t=${cameraReqId.value}`;
});
// Text shown over the (black) video box while nothing is rendering yet. Hidden once
// WebRTC is PLAYING or the MJPEG fallback is visible; surfaces "연결 중…" during the
// normal WebRTC negotiate/decode window and "카메라 신호 없음" when everything is dead.
const cameraOverlayText = computed(() => {
  if (!cameraOn.value || webrtc.playing.value) return "";
  if (cameraError.value) return "카메라 신호 없음";
  if (cameraStreamUrl.value) return "";   // MJPEG fallback is on-screen
  return "연결 중…";
});
// The MJPEG <img> only fires `error` if the HTTP connection breaks — when it
// stays open but no frames arrive (no camera / server restarted and the <img>
// is now a dead socket) the box just sits black. Poll the status endpoint
// (server-computed frame age, clock-skew-proof) to surface "신호 없음" AND to
// self-heal a dead <img> by re-requesting the stream.
async function pollCameraStatus() {
  if (!cameraOn.value) return;
  try {
    const res = await request("/api/rover/camera/status", { method: "GET" });
    const s = await res.json();
    // Reflect the server's authoritative depth-mode state (it resets to off when
    // the last viewer leaves, and a mid-session perception reconnect restores it).
    cameraDepthOn.value = !!s.depth;
    if (webrtc.connected.value) {
      // WebRTC track negotiated — the MJPEG frame-age (stale by design once mjpeg
      // is off) says nothing about health. Use `connected` (stable), not `playing`
      // (videoWidth, which blips to 0 on a resolution change) so a momentary blip
      // can't surface a phantom "카메라 신호 없음" behind the live video.
      cameraError.value = false;
      cameraLastOkAt = Date.now();
    } else if (mjpegFallback.value) {
      // MJPEG fallback is the active source — now its frame-age reflects health.
      const healthy = s.camera_connected
        && s.last_frame_age_ms != null && s.last_frame_age_ms < 3000;
      cameraError.value = !healthy;
      if (healthy) {
        cameraLastOkAt = Date.now();
      } else if (s.camera_connected && s.viewers === 0 && Date.now() - cameraLastOkAt > 5000) {
        // Rover connected but server has ZERO viewers — our <img> socket died
        // server-side (restart / proxy drop). Re-request to re-register + resume.
        cameraReqId.value = Date.now();
        cameraLastOkAt = Date.now();
      }
    } else {
      // WebRTC still negotiating (no fallback yet) — a stale MJPEG age is expected
      // (mjpeg is off), not a fault. Stay in the "연결 중…" state, not "신호 없음".
      cameraError.value = false;
    }
  } catch { /* keep last known state */ }
}
function stopCameraStream() {
  // Abort the MJPEG <img> BEFORE v-if unmounts it: Chrome does NOT cancel an
  // in-flight multipart/x-mixed-replace load when the element is merely removed
  // from the DOM, so a stop during the pre-WebRTC MJPEG phase would otherwise leak
  // the socket (rover keeps sending JPEG) — and each reopen stacks another one.
  // Swapping src to a blank data URI is a load the browser DOES abort the prior one for.
  if (cameraImgEl.value) cameraImgEl.value.src = BLANK_IMG;
  cameraOn.value = false;
  cameraError.value = false;
  mjpegFallback.value = false;
  if (webrtcFallbackTimer) { clearTimeout(webrtcFallbackTimer); webrtcFallbackTimer = null; }
  cameraDepthOn.value = false;   // server drops the depth mode when the last viewer leaves
  if (cameraStatusPoll) { clearInterval(cameraStatusPoll); cameraStatusPoll = null; }
  webrtc.stop();
}
// Idempotent "ensure the stream is on" — used by the toggle and by the obstacle
// auto-open, which must not toggle a manually-opened stream back off.
function startCamera() {
  if (cameraOn.value) return;
  cameraOn.value = true;
  cameraError.value = false;
  mjpegFallback.value = false;   // go straight to WebRTC; no MJPEG-first hop
  cameraReqId.value = Date.now();
  cameraLastOkAt = Date.now();   // grace the cold-start window before reconnecting
  pollCameraStatus();
  cameraStatusPoll = setInterval(pollCameraStatus, 2000);
  // Fall back to the MJPEG <img> only if WebRTC hasn't negotiated within the grace
  // window (e.g. a network with no viable ICE path) — the operator must never be
  // left blind. Cleared the instant WebRTC connects (watch below).
  if (webrtcFallbackTimer) clearTimeout(webrtcFallbackTimer);
  webrtcFallbackTimer = setTimeout(() => {
    if (cameraOn.value && !webrtc.connected.value) mjpegFallback.value = true;
  }, WEBRTC_FALLBACK_MS);
  // WebRTC (rover-2d) primary + gating hold. nextTick so the <video> ref exists
  // (the panel is v-if="cameraOn").
  const base = import.meta.env.PROD ? "/course" : "";
  nextTick(() => {
    webrtc.start(cameraVideoEl.value,
      `${base}/api/rtc/rover-2d/whep`,
      `${base}/api/rover/camera/hold?mode=2d`);
  });
}
// WebRTC connect state drives the MJPEG fallback: connected → drop it (WebRTC is
// the source); a mid-session DROP (was connected, now terminal failed/closed) →
// re-raise it so the operator keeps a picture while WebRTC retries in the background.
watch(webrtcConnected, (isConnected, was) => {
  if (isConnected) mjpegFallback.value = false;
  else if (was && cameraOn.value) mjpegFallback.value = true;
});
const router = useRouter();
function goVr() { router.push("/vr"); }

// Fullscreen toggle (status-strip button). The only way a normal tab can hide
// the mobile browser chrome; hidden entirely where the API is absent (iOS
// Safari has no Fullscreen API for non-video elements). isFullscreen tracks the
// real state via `fullscreenchange` so the icon/label stay correct even when
// the user exits via a system gesture (swipe / Esc).
const fullscreenSupported = typeof document !== "undefined" && !!document.documentElement.requestFullscreen;
const isFullscreen = ref(false);
function onFullscreenChange() { isFullscreen.value = !!document.fullscreenElement; }
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) {
    notifyWarn(`전체화면 전환 실패: ${e?.message || e}`);
  }
}
// Single camera button cycles three modes so there's no separate 거리 오버레이
// button: off → plain 2D → depth overlay → off. Each mode has a distinct fill
// (off = ghost, 2D = blue btn-primary, depth = violet) so switching to the
// depth map gives feedback (the video plain-vs-heatmap corroborates it).
function cycleCamera() {
  if (!cameraOn.value) { startCamera(); return; }        // off → plain 2D
  if (!cameraDepthOn.value) { toggleDepth(); return; }   // 2D → depth overlay
  stopCameraStream();                                     // depth → off
}
// Toggle the both-eyes depth composite (rectified left + depth heatmap + nearest
// distance). The rover renders it; this just flips the stream mode. Optimistic UI
// update, corrected by the next status poll. No-op on the pixels if the rover has
// no stereo calibration loaded (it falls back to the plain stream).
async function toggleDepth() {
  const next = !cameraDepthOn.value;
  // Flip optimistically so the button colour changes the instant it's pressed
  // (the request + rover re-render take a beat); revert if the server rejects.
  // The next status poll reconciles with the rover's authoritative state.
  cameraDepthOn.value = next;
  try {
    await request("/api/rover/camera/depth", {
      method: "POST",
      body: JSON.stringify({ on: next }),
    });
  } catch (e) {
    cameraDepthOn.value = !next;
    notifyWarn(`깊이 뷰 전환 실패: ${e?.message || e}`);
  }
}
function onCameraError() {
  cameraError.value = true;
}
// NOTE: camera health is judged solely by pollCameraStatus (the camera relay's own
// status) — NOT by the mission SSE's rover.connected. Those are independent channels:
// a transient mission-SSE blip used to eagerly paint the opaque "카메라 신호 없음"
// over a perfectly healthy live feed until the next 2s poll cleared it. pollCameraStatus
// (WebRTC connected → clear; MJPEG fallback → frame-age) already covers a real outage.
// The rover panel is v-show (stays mounted), so leaving the tab would keep the
// MJPEG <img> connected and the rover capturing invisibly. Stop on tab-leave.
watch(activeTab, (tab) => {
  if (tab !== "rover" && cameraOn.value) stopCameraStream();
});

async function togglePump() {
  if (pumpBusy.value) return;
  pumpBusy.value = true;
  const next = !pumpOn.value;
  try {
    await request("/api/rover/pump", {
      method: "POST",
      body: JSON.stringify({ on: next }),
    });
  } catch (e) {
    notifyWarn(`펌프 제어 실패: ${e?.message || e}`);
  } finally {
    pumpBusy.value = false;
  }
}

// Joystick pointer handling
let joystickEl = null;
let joystickRect = null;
let activePointerId = null;

function onJoystickDown(e) {
  if (manualAuthorityReleaseBusy.value) return;
  joystickEl = e.currentTarget;
  joystickRect = joystickEl.getBoundingClientRect();
  activePointerId = e.pointerId;
  joystickEl.setPointerCapture(e.pointerId);
  updateJoystick(e);
}

function onJoystickMove(e) {
  if (manualAuthorityReleaseBusy.value) return;
  if (e.pointerId !== activePointerId) return;
  updateJoystick(e);
}

function onJoystickUp(e) {
  if (e.pointerId !== activePointerId) return;
  activePointerId = null;
  manualThrottle.value = 0;
  manualSteering.value = 0;
  syncJoystickDom();
}

// Push the current throttle/steering to the knob + readout imperatively.
// These are intentionally NOT reactive template bindings — at pointer-event
// rates a reactive write would re-render the entire MapView component and make
// the joystick stutter. sendControl still reads the refs at 20Hz.
function syncJoystickDom() {
  const knob = joystickKnobEl.value;
  if (knob) knob.style.transform = `translate(${manualSteering.value * 0.82}px, ${-manualThrottle.value * 0.82}px)`;
  const info = joystickInfoEl.value;
  if (info) info.textContent = `T: ${manualThrottle.value} / S: ${manualSteering.value}`;
}

function updateJoystick(e) {
  if (manualAuthorityReleaseBusy.value || !joystickRect) return;
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
  syncJoystickDom();
}

/* ── SSE ──────────────────────────────────────────── */
// Tracks whether the SSE link recently dropped. Browser auto-reconnects, but
// any rover:status events emitted during the gap are lost — fetch a snapshot
// once the link is back so the reconciler can absorb missed transitions.
let sseHadError = false;

// 손상된 SSE 프레임 하나가 해당 리스너를 통째로 죽이고 이벤트를 조용히 삼키지
// 않도록, 파싱 실패는 null로 처리하고 리스너가 조기 반환한다 (traffic useSSE 관행).
function parseSSE(e) {
  try { return JSON.parse(e.data); } catch { return null; }
}

function connectSSE() {
  const base = import.meta.env.PROD ? "/course" : "";
  eventSource = new EventSource(`${base}/api/events`);

  eventSource.addEventListener("error", () => {
    sseHadError = true;
    sseReconnecting.value = true;
  });
  eventSource.addEventListener("open", () => {
    if (sseHadError) {
      sseHadError = false;
      sseReconnecting.value = false;
      fetchRoverStatus();
      // 단절 중 놓친 코스/콘/메모 편집을 다시 동기화한다(SSE는 끊긴 동안의 이벤트를 유실).
      fetchAll().then(() => { if (map && !isMissionsView.value) rebuildAllMarkers(); });
    }
  });

  eventSource.addEventListener("init", (e) => {
    const data = parseSSE(e);
    if (data) courses.value = data.courses;
  });

  eventSource.addEventListener("courses", (e) => {
    const data = parseSSE(e);
    if (!data) return;
    courses.value = data.courses;
    for (const id of Object.keys(conesMap.value)) {
      if (!data.courses.find((c) => c.id === parseInt(id))) {
        delete conesMap.value[id];
        delete memosMap.value[id];
        delete routeMap.value[id];
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
    const data = parseSSE(e);
    if (!data) return;
    conesMap.value[data.courseId] = data.cones;
    // Keep the course list's "(N)" count live. Cone add/delete only broadcasts
    // `cones` (not `courses`), so without this the count would go stale.
    const course = courses.value.find((c) => c.id === data.courseId);
    if (course) course.cone_count = data.cones.length;
    // 리플레이(기록) 뷰에서는 라이브 콘 마커를 다시 그리지 않는다(라이브 복귀 시 재구축).
    // 변경된 코스만 타겟 재구축 — 다른 코스의 마커는 건드리지 않는다.
    if (map && !suppressRebuild && !isMissionsView.value) rebuildAllMarkers(data.courseId);
  });

  eventSource.addEventListener("memos", (e) => {
    const data = parseSSE(e);
    if (!data) return;
    // 내가 드래그/리사이즈/입력 중인 코스면 에코로 편집 중 배열이 교체돼 조작이
    // 끊긴다. 그 경우 건너뛰고, 조작 종료 후의 PATCH 에코가 최종 상태로 맞춘다.
    if (memoBusy && data.courseId === activeCourseId.value) return;
    memosMap.value[data.courseId] = data.memos;
  });

  eventSource.addEventListener("route", (e) => {
    const data = parseSSE(e);
    if (!data) return;
    routeMap.value[data.courseId] = { markers: data.markers || [], steps: data.steps || [] };
  });

  eventSource.addEventListener("rover", (e) => {
    const data = parseSSE(e);
    if (!data || !isValidRoverPos(data.lat, data.lng)) return;
    // Move only this device's own marker (leaving the other device's in place).
    const evSrc = data.source === "receiver" ? "receiver" : "rover";
    setDeviceMarker(evSrc, data.lat, data.lng);
    // Follow tracks the ROVER only — the receiver is a handheld, not a chase target.
    if (followRover.value && evSrc === "rover") scheduleFollow(data.lat, data.lng);
    // Mission path progress is a rover-only concern; a receiver capture position
    // must not be mistaken for mission movement.
    if (roverMode.value === "executing" && data.source !== "receiver") updatePathProgress(data.lat, data.lng);
  });

  eventSource.addEventListener("rover:status", (e) => {
    const data = parseSSE(e);
    if (!data) return;
    roverStatus.value = { ...roverStatus.value, ...data };
    // Keep the proximity-detection toggle in sync with the server's stored truth
    // (covers another operator flipping it, or the initial snapshot), guarded
    // against a stale frame snapping the checkbox back mid-toggle.
    syncObstacleDetect(data);
    syncAppRoverStatus(data);
    // Draw BOTH device markers (rover + receiver) from the snapshot.
    syncDeviceMarkers(roverStatus.value);
    // Follow + mission path-progress track the ROVER's position. Doing path
    // progress here (not only in the "rover" event) keeps the executing overlay
    // advancing even when the receiver is the active source — the server then
    // suppresses the rover's live "rover" event, but rover:status still fires.
    const rlp = data.last_position;
    if (rlp && typeof rlp.lat === "number" && typeof rlp.lng === "number") {
      if (followRover.value) scheduleFollow(rlp.lat, rlp.lng);
      if (roverMode.value === "executing") updatePathProgress(rlp.lat, rlp.lng);
    }
    // If the rover disconnected mid-manual-control, release immediately.
    if (!data.connected && roverMode.value === "manual") {
      stopManualControl();
    }
    reconcileRoverMode(roverStatus.value);
  });

  eventSource.addEventListener("rover:mission", (e) => {
    const data = parseSSE(e);
    const mission = data?.mission;
    if (!mission) return;
    if (mission.status === "completed") {
      notifySuccess("미션을 완료했습니다.");
      roverStatus.value = { ...roverStatus.value, active_mission: null };
      clearPath({ endMissionOnServer: false });
      return;
    }
    if (mission.status === "cancelled") {
      roverStatus.value = { ...roverStatus.value, active_mission: null };
      clearPath({ endMissionOnServer: false });
      return;
    }
    roverStatus.value = { ...roverStatus.value, active_mission: mission };
    restoreActiveMission(mission);
    reconcileRoverMode(roverStatus.value);
  });

  eventSource.addEventListener("rover:waypoint", (e) => {
    const data = parseSSE(e);
    if (!shouldConsumeLegacyMissionIndexEvent({
      activeMission: activeMission.value,
      connectedProtocol: roverStatus.value.mission_protocol?.connected,
    })) return;
    if (roverMode.value === "executing" && Number.isInteger(data?.index)) {
      onWaypointReached(data.index);
    }
  });

  eventSource.addEventListener("rover:skipped", (e) => {
    const data = parseSSE(e);
    if (!shouldConsumeLegacyMissionIndexEvent({
      activeMission: activeMission.value,
      connectedProtocol: roverStatus.value.mission_protocol?.connected,
    })) return;
    if (roverMode.value === "executing" && Number.isInteger(data?.index)) {
      // Stuck-skip: navigator advanced _cur_seg_idx past this waypoint
      // without firing waypoint_reached. Advance executedIndex the same
      // way the reached event would, otherwise the counter sits on the
      // skipped index until the *next* waypoint reports reached — at
      // which point it jumps by 2 and the skip becomes invisible.
      onWaypointReached(data.index);
      notifyWarn(`웨이포인트 #${data.index + 1} 건너뜀 (stuck)`);
    }
  });

  eventSource.addEventListener("rover:spray", (e) => {
    const data = parseSSE(e);
    if (!shouldConsumeLegacyMissionIndexEvent({
      activeMission: activeMission.value,
      connectedProtocol: roverStatus.value.mission_protocol?.connected,
    })) return;
    if (!Number.isInteger(data?.waypoint) || !data.outcome) return;
    onSprayResult(data.waypoint, data.outcome);
  });

  eventSource.addEventListener("rover:obstacle", (e) => {
    const data = parseSSE(e);
    if (data) onObstacle(data);
  });

  // Base-station survey outcome — surface success/failure to the operator (a
  // failed survey otherwise just silently reverts to "미측량").
  eventSource.addEventListener("gps:survey_result", (e) => {
    const data = parseSSE(e);
    if (!data) return;
    // Survey is an admin-only workflow; don't toast its outcome to other operators.
    if (!isAdmin.value) return;
    if (data.ok) {
      notifySuccess(`측량 완료: ${data.name}${data.samples != null ? ` (${data.samples} 샘플)` : ""}`);
    } else {
      const reason = {
        insufficient_samples: "RTK 고정 샘플이 부족합니다.",
        unstable: "위치가 안정되지 않았습니다. 수신기 설치를 확인하세요.",
      }[data.error] || "RTK 고정 샘플을 확보하지 못했습니다.";
      notifyError(`측량 실패: ${data.name || "측량점"} — ${reason}`);
    }
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
    syncObstacleDetect(data);
    syncAppRoverStatus(data);
    // Draw both device markers from the cached server-side snapshot on first
    // load — without this the map only shows them after the next live SSE frame.
    syncDeviceMarkers(roverStatus.value);
    // Restore in-flight mission so a tab reload during a mission doesn't lose
    // the path overlay, waypoint counter, or spray markers.
    restoreActiveMission(data.active_mission);
    reconcileRoverMode(roverStatus.value);
  } catch { /* best-effort */ }
}

function restoreActiveMission(mission, { expectedLocalMission = false } = {}) {
  const missionChanged = displayedMissionId !== mission?.id;
  const decision = missionRestoreDecision({
    mission,
    displayedMissionId,
    localWaypointCount: pathWaypoints.value.length,
  });
  if (!decision.restore) return;

  alignCourseToMission(mission);
  const builderMissionEditable = missionMotionConfirmedHeld(mission);
  if (showMissionBuilder.value
      && (!builderMissionEditable || !missionDraftMatches(missionBuilderBase.value, mission))) {
    showMissionBuilder.value = false;
    missionBuilderBase.value = null;
    notifyWarn("서버의 미션 경로가 변경되어 열려 있던 초안을 닫았습니다. 최신 경로를 확인하세요.");
  } else if (decision.discardsLocalDraft && !expectedLocalMission && !localMissionCreatePending) {
    notifyWarn("다른 운영자가 활성화한 서버 미션으로 로컬 경로 초안을 교체했습니다.");
  }

  displayedMissionId = mission.id;
  pathPresetReference.value = null;
  pathWaypoints.value = mission.waypoints
    .filter((waypoint) => waypoint.state !== "skipped")
    .map((waypoint) => ({ ...waypoint, waypoint_id: waypoint.id }));
  executedIndex.value = pathWaypoints.value.filter((waypoint) => waypoint.state === "completed").length;
  pathMissionBase = missionDraftToken(mission);
  missionFinishBehavior.value = mission.finish_behavior || "stop";
  const lp = roverStatus.value.last_position;
  pathStart = mission.start_position
    || ((lp && isValidRoverPos(lp.lat, lp.lng)) ? lp : pathWaypoints.value[0]);
  if (pathWaypoints.value.length === 0 && missionFinishBehavior.value === "return_to_start" && pathStart) {
    if (missionChanged || !pathReturnOrigin) {
      pathReturnOrigin = lp && isValidRoverPos(lp.lat, lp.lng) ? { lat: lp.lat, lng: lp.lng } : null;
    }
  } else {
    pathReturnOrigin = null;
  }

  // Rebuild path geometry + progress bar using renderPath's cumulative math.
  renderPath();
  if (pathTotalDist > 0 && executedIndex.value > 0) {
    const walked = pathCumDist[executedIndex.value - 1] ?? pathTotalDist;
    pathProgress.value = Math.min(100, Math.round((walked / pathTotalDist) * 100));
  }

  const restored = new Map();
  pathWaypoints.value.forEach((waypoint, index) => {
    if (waypoint.outcome) restored.set(index, { outcome: waypoint.outcome, at: waypoint.completed_at || 0 });
  });
  sprayResults.value = restored;
  renderSprayMarkers();
}

// The durable mission record is the only lifecycle/progress authority. Generic
// nav telemetry is deliberately ignored here: a delayed IDLE frame cannot
// complete or restart a mission without a correlated protocol-v2 report.
function reconcileRoverMode(s) {
  const mission = s?.active_mission;
  const held = missionMotionConfirmedHeld(mission);
  if (missionNeedsManualRelease({ roverMode: roverMode.value, mission, held })) {
    restoreActiveMission(mission);
    void releaseManualForMissionAuthority();
    return;
  }
  if (roverMode.value === "manual" && (!mission || missionHeld.value)) {
    // Keep the joystick visible while an allowed held-mission reposition is in
    // progress, but never let manual UI suppress a newer server route/course.
    if (mission) restoreActiveMission(mission);
    return;
  }
  if (mission) {
    restoreActiveMission(mission);
    if (["starting", "running", "pausing", "resuming"].includes(mission.status)) {
      roverMode.value = "executing";
    } else if (["ready", "paused", "interrupted"].includes(mission.status)) {
      roverMode.value = "stopped";
    }
    return;
  }
  displayedMissionId = null;
  if (roverMode.value === "executing" || roverMode.value === "stopped") {
    roverMode.value = pathWaypoints.value.length ? "path-ready" : "none";
    pathProgress.value = 0;
  }
}

/* ── Mobile detection ─────────────────────────────── */
function checkMobile() {
  isMobile.value = window.innerWidth <= 768;
  // Reflow can change strip height and chip rects — reclamp / dismiss popover.
  if (isMobile.value && sheetHeight.value > 52) {
    sheetHeight.value = Math.min(sheetHeight.value, maxSheetHeight());
  }
  if (activeChipPopover.value) {
    activeChipPopover.value = null;
    popoverPos.value = null;
  }
}

// Popover is position: fixed; close it on scroll so it doesn't drift.
function onChipStripScroll() {
  if (activeChipPopover.value) {
    activeChipPopover.value = null;
    popoverPos.value = null;
  }
}

function onGlobalKeydown(e) {
  if (e.key === "Escape") {
    // Highest-open modal wins; others remain so a stack of prompts collapses one level at a time.
    if (showMissionBuilder.value) { showMissionBuilder.value = false; e.preventDefault(); return; }
    if (showLogs.value) { showLogs.value = false; e.preventDefault(); return; }
    if (showSnapshots.value) { showSnapshots.value = false; e.preventDefault(); return; }
    if (showBatteryCal.value) { showBatteryCal.value = false; e.preventDefault(); return; }
    if (showCalibration.value) { closeCalibration(); e.preventDefault(); return; }
    if (showPreflight.value) { cancelPreflight(); e.preventDefault(); return; }
    // Then back out of the editing modes.
    if (rotateMode.value) { exitRotateMode(); e.preventDefault(); return; }
    if (routeEditMode.value) { routeEditMode.value = false; e.preventDefault(); return; }
    if (selectMode.value) { selectMode.value = false; e.preventDefault(); return; }
    if (toolMode.value !== "none") { exitToolMode(); e.preventDefault(); return; }
    return;
  }
  const t = e.target;
  const tag = t && t.tagName;
  const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable);
  // Ctrl/Cmd+Z undoes the last cone edit (not while typing or locked).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
    if (inField) return;
    if (activeTab.value === "courses" && !editLocked.value && undoStack.value.length > 0) {
      e.preventDefault();
      performUndo();
    }
    return;
  }
  // Delete key removes the multi-selection.
  if (e.key === "Delete") {
    if (inField) return;
    if (activeTab.value === "courses" && !editLocked.value && multiSelectedIds.value.size > 0) {
      e.preventDefault();
      deleteSelected();
    }
  }
}

/* ── Lifecycle ────────────────────────────────────── */
onMounted(async () => {
  checkMobile();
  window.addEventListener("resize", checkMobile);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  window.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("click", onGlobalClickForChips);
  document.addEventListener("keydown", onGlobalKeyForChips);
  // 1Hz tick so time-ago chips and disconnect-ago refresh without new SSE events.
  uiTickInterval = setInterval(() => { uiTick.value = (uiTick.value + 1) % 3600; }, 1000);
  await fetchAll();
  await nextTick();
  await initMap();
  // Make the map measure its container before the first programmatic centre.
  // On first paint the flex layout may not have given #map its height yet;
  // centring against a 0×0 container corrupts the (rotated) projection. This
  // refreshes the cached size when it's available; if the container is still
  // 0×0, panToVisibleCenter's own guard falls back to a direct setView.
  map.invalidateSize({ pan: false, animate: false });
  // fetchAll restores activeCourseId before initMap exists, so the
  // course watcher's pan was a no-op. Re-apply once the map is ready
  // so a refresh lands centered on the restored course's start (or first cone).
  if (activeCourseId.value != null) {
    const cones = conesMap.value[activeCourseId.value] || [];
    if (cones.length > 0) {
      const startId = courses.value.find((c) => c.id === activeCourseId.value)?.start_cone_id;
      const startCone = cones.find((c) => c.id === startId) || cones[0];
      panToVisibleCenter(startCone.lat, startCone.lng, { animate: false });
    }
  }
  recomputeCenterline(); // draw the restored course's centerline on first paint
  connectSSE();
  // /api/rover/status is admin-only; chief never opens the rover tab, so skip it.
  if (isAdmin.value) fetchRoverStatus();
  // Prime the GPS-management tab if it's the persisted active tab on load.
  if (isAdmin.value && activeTab.value === "gps") loadGps();
});

onUnmounted(() => {
  // Route navigation (e.g. the VR button → /vr) unmounts this view. Without this,
  // the camera's WebRTC hold SSE + retry intervals + peer connection leak and the
  // rover keeps encoding rover-2d with nobody watching (each open→leave→return
  // stacks another orphan toward MAX_CAMERA_VIEWERS). watch(activeTab) only covers
  // in-page tab switches, not route changes.
  if (cameraOn.value) stopCameraStream();
  stopReplay();
  // MapView is the sole writer of the App-owned sseReconnecting ref; clear it
  // so the "reconnecting" badge can't stick on after this view tears down.
  sseReconnecting.value = false;
  window.removeEventListener("resize", checkMobile);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  window.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("click", onGlobalClickForChips);
  document.removeEventListener("keydown", onGlobalKeyForChips);
  if (uiTickInterval) clearInterval(uiTickInterval);
  if (controlInterval) clearInterval(controlInterval);
  if (cameraStatusPoll) clearInterval(cameraStatusPoll);
  if (calStatusPollHandle) clearInterval(calStatusPollHandle);
  if (ledBrightnessTimer) clearTimeout(ledBrightnessTimer);
  if (pumpDurationTimer) clearTimeout(pumpDurationTimer);
  if (centerlineTimer) clearTimeout(centerlineTimer);
  if (followTimer != null) clearTimeout(followTimer);
  if (eventSource) eventSource.close();
  if (map) {
    teardownRotateHandle();
    map.getContainer().removeEventListener("pointerdown", onSelectionStart);
    map.remove();
  }
});
</script>

<template>
  <div class="map-layout">
    <div class="content">
      <MissionBuilder
        v-if="showMissionBuilder"
        :cones="activeCones"
        :initial-items="missionBuilderItems"
        :presets="missionPresets"
        :current-position="roverStatus.last_position"
        :initial-finish-behavior="missionFinishBehavior"
        :mission-start="activeMission && activeMission.start_position"
        :editing="missionBuilderEditing"
        :completed-count="activeMission ? activeMission.waypoints.filter((waypoint) => waypoint.state === 'completed').length : 0"
        :busy="missionBuilderBusy"
        :preset-busy="missionPresetBusy"
        :map-bearing="mapBearing"
        @close="showMissionBuilder = false"
        @apply="applyMissionBuilder"
        @run="runMissionBuilder"
        @save-preset="saveMissionPreset"
        @delete-preset="deleteMissionPreset"
      />
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
              v-for="(e, i) in logsNewestFirst" :key="i"
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

      <!-- Combined calibration modal (antenna + wheel encoder) -->
      <div v-if="showCalibration" class="preflight-backdrop" @click.self="closeCalibration">
        <div class="preflight-modal calibration-modal">
          <div class="modal-titlebar">
            <h3>보정</h3>
            <button
              class="modal-close-x"
              :disabled="antennaCalSubmitting || wheelCalSubmitting"
              aria-label="닫기"
              @click="closeCalibration"
            >×</button>
          </div>

          <div class="cal-tabs">
            <button class="cal-tab" :class="{ active: calTab === 'antenna' }" @click="calTab = 'antenna'">
              안테나<span v-if="antennaCalRunning" class="cal-tab-dot" title="진행 중"></span>
            </button>
            <button class="cal-tab" :class="{ active: calTab === 'wheel' }" @click="calTab = 'wheel'">
              휠<span v-if="wheelCalRunning" class="cal-tab-dot" title="진행 중"></span>
            </button>
            <button class="cal-tab" :class="{ active: calTab === 'stereo' }" @click="calTab = 'stereo'">
              스테레오<span v-if="stereoCal.status === 'running'" class="cal-tab-dot" title="진행 중"></span>
            </button>
            <button class="cal-tab" :class="{ active: calTab === 'ground' }" @click="calTab = 'ground'">
              지면<span v-if="groundCal.status === 'running'" class="cal-tab-dot" title="진행 중"></span>
            </button>
          </div>

          <section class="cal-section" v-show="calTab === 'antenna'">
            <div class="cal-section-title">
              안테나 오프셋
              <span v-if="antennaCalDisplay.sourceLabel" class="cal-source-tag">
                {{ antennaCalDisplay.sourceLabel }}
              </span>
            </div>
            <div class="cal-when">재실행 조건: GPS 안테나를 옮기거나 다시 장착했을 때</div>
            <div class="cal-current">
              <span class="cal-key">a_x</span>
              <span class="cal-val">{{ antennaCalDisplay.a_x }}</span>
              <span class="cal-key">a_y</span>
              <span class="cal-val">{{ antennaCalDisplay.a_y }}</span>
              <span class="cal-key">RMS</span>
              <span class="cal-val">{{ antennaCalDisplay.rms }}</span>
              <span class="cal-key">갱신</span>
              <span class="cal-val">{{ antennaCalDisplay.calibratedAgo }}</span>
            </div>
            <div v-if="antennaCalDisplay.errorReason" class="cal-error">
              마지막 시도 실패: {{ antennaCalDisplay.errorReason }}
            </div>

            <div class="cal-subsection">
              <div class="cal-subsection-title">수동 입력</div>
              <div class="cal-manual-row">
                <label class="cal-manual-field">
                  <span>a_x (mm)</span>
                  <input
                    type="number" step="1" inputmode="numeric"
                    v-model="antennaManualX" placeholder="300"
                  />
                </label>
                <label class="cal-manual-field">
                  <span>a_y (mm)</span>
                  <input
                    type="number" step="1" inputmode="numeric"
                    v-model="antennaManualY" placeholder="50"
                  />
                </label>
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="!antennaManualValid || antennaManualSubmitting || !roverStatus.connected"
                  @click="submitAntennaManual"
                >{{ antennaManualSubmitting ? '저장 중...' : '저장' }}</button>
              </div>
            </div>

            <div class="cal-subsection">
              <div class="cal-subsection-title">자동 보정</div>
              <div class="cal-space-req-row">
                <span class="cal-space-req">필요 공간: 전후좌우 5 m</span>
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="antennaCalSubmitting || antennaCalRunning || !antennaCalCanStart"
                  @click="submitAntennaCal"
                >{{ antennaCalSubmitting ? '전송 중...' : (antennaCalRunning ? '진행 중' : antennaCalBtnLabel) }}</button>
              </div>
              <div v-if="antennaCalRunning" class="modal-status">진행 중...</div>
            </div>
          </section>

          <section class="cal-section" v-show="calTab === 'wheel'">
            <div class="cal-section-title">휠 인코더 스케일</div>
            <div class="cal-when">재실행 조건: 타이어·휠 교체 후 · 주행거리/직진성이 GPS와 어긋날 때</div>
            <div class="cal-space-req">필요 공간: 전방 12 m</div>
            <div class="cal-current">
              <span class="cal-key">scale_l</span>
              <span class="cal-val">{{ wheelCalDisplay.scale_l }}</span>
              <span class="cal-key">scale_r</span>
              <span class="cal-val">{{ wheelCalDisplay.scale_r }}</span>
              <span class="cal-key">샘플</span>
              <span class="cal-val">{{ wheelCalDisplay.samples }}</span>
              <span class="cal-key">조향 트림</span>
              <span class="cal-val">{{ wheelCalDisplay.trim }}</span>
              <span class="cal-key">arc 반경</span>
              <span class="cal-val">{{ wheelCalDisplay.radius }}</span>
              <span class="cal-key">갱신</span>
              <span class="cal-val">{{ wheelCalDisplay.calibratedAgo }}</span>
            </div>
            <div v-if="wheelCalDisplay.errorReason" class="cal-error">
              마지막 시도 실패: {{ wheelCalDisplay.errorReason }}
            </div>
            <div v-if="wheelCalDisplay.steeringWarning" class="cal-error cal-warn">
              조향 트림 미적용: {{ wheelCalDisplay.steeringWarning }} (휠 스케일은 적용됨)
            </div>
            <div v-if="wheelCalRunning" class="modal-status">진행 중...</div>
            <div class="cal-section-actions">
              <button
                class="btn btn-ghost btn-sm"
                :disabled="wheelCalResetSubmitting || wheelCalRunning || !roverStatus.connected"
                @click="submitWheelCalReset"
              >{{ wheelCalResetSubmitting ? '초기화 중...' : '초기화' }}</button>
              <button
                class="btn btn-primary btn-sm"
                :disabled="wheelCalSubmitting || wheelCalRunning || !wheelCalCanStart"
                @click="submitWheelCal"
              >{{ wheelCalSubmitting ? '전송 중...' : (wheelCalRunning ? '진행 중' : (wheelCalCanStart ? '시작' : wheelCalBtnLabel)) }}</button>
            </div>
          </section>

          <section class="cal-section" v-show="calTab === 'stereo'">
            <div class="cal-section-title">스테레오 카메라 교정</div>
            <div class="cal-when">재실행 조건: 카메라를 다시 달거나 부딪혀 두 눈 위치가 틀어졌을 때</div>
            <div class="cal-when">절차:</div>
            <ol class="cal-steps">
              <li>체커보드를 <b>A4 Landscape, 100% scale</b>로 인쇄.</li>
              <li><b>100 mm 바</b> 길이를 자로 확인. 불일치 시 한 칸 길이를 아래에 입력.</li>
              <li>휘지 않도록 단단하게 고정 후 <b>교정 실행</b>. 보드를 양쪽 카메라에 다양한 거리·각도로 비춤.</li>
            </ol>
            <label class="cal-manual-field cal-square-field">
              <span>한 칸 길이 (mm)</span>
              <input
                type="number" step="0.1" min="5" max="200" inputmode="decimal"
                v-model="stereoSquareMm" placeholder="25"
              />
            </label>
            <div v-if="stereoCal.status === 'running'" class="modal-status">
              교정 중… {{ stereoCal.captured != null
                ? `수집 ${stereoCal.captured}${stereoCal.target ? ' / ' + stereoCal.target : ''} 쌍`
                : '카메라 준비 중' }} — 보드를 양쪽 카메라에 다양한 각도로 비추세요.
            </div>
            <div v-else-if="stereoCal.status === 'done'" class="modal-status">
              교정 완료 — RMS {{ stereoCal.rms ?? '—' }} px · baseline {{ stereoCal.baseline_mm ?? '—' }} mm · {{ stereoCal.pairs ?? '—' }}쌍
            </div>
            <div v-else-if="stereoCal.status === 'failed'" class="cal-error">
              교정 실패: {{ stereoCal.error || '알 수 없는 오류' }}
            </div>
            <div class="cal-section-actions">
              <button class="btn btn-ghost btn-sm" @click="printCheckerboard">
                체커보드 인쇄
              </button>
              <button
                class="btn btn-primary btn-sm"
                :disabled="!roverStatus.connected || stereoCal.status === 'running' || !stereoSquareValid"
                @click="startStereoCalibration"
              >{{ stereoCal.status === 'running' ? '교정 중…' : '교정' }}</button>
            </div>
          </section>

          <section class="cal-section" v-show="calTab === 'ground'">
            <div class="cal-section-title">지면 교정 (장애물 감지 기준면)</div>
            <label class="cal-toggle-field">
              <span>근접 충돌 감지</span>
              <input
                type="checkbox"
                :checked="obstacleDetectOn"
                @change="setObstacleDetection($event.target.checked)"
              />
            </label>
            <div class="cal-when">끄면 주행 중 스테레오 근접 장애물 감지와 자동 일시정지가 비활성화됩니다. (env <code>OBSTACLE_DETECTION=false</code>로 완전히 꺼둔 경우 여기서 켤 수 없습니다.)</div>
            <div class="cal-when">재실행 조건: 카메라 높이·각도 변경 후 · 스테레오 재교정 후 · 새 노면 첫 주행</div>
            <div class="cal-when">절차:</div>
            <ol class="cal-steps">
              <li><b>스테레오 카메라 교정</b>이 먼저 완료돼 있어야 합니다 (미터 깊이 필요).</li>
              <li>로버를 <b>평평하고 빈 주행 노면</b>에 주행 자세로 두기 — 앞에 장애물·사람이 없어야 합니다.</li>
              <li><b>지면 교정</b> 실행 — 카메라가 보는 노면의 행별 기대 깊이를 학습해, 그보다 가까운(솟은) 것만 장애물로 판정합니다.</li>
            </ol>
            <div v-if="groundCal.status === 'running'" class="modal-status">
              지면 교정 중… {{ groundCal.captured != null
                ? `수집 ${groundCal.captured}${groundCal.target ? ' / ' + groundCal.target : ''} 프레임`
                : '카메라 준비 중' }} — 장애물 없는 빈 노면을 비추세요.
            </div>
            <div v-else-if="groundCal.status === 'done'" class="modal-status">
              지면 교정 완료 — 근거리 {{ groundCal.near_m ?? '—' }} m · 원거리 {{ groundCal.far_m ?? '—' }} m · {{ groundCal.rows ?? '—' }}행
            </div>
            <div v-else-if="groundCal.status === 'failed'" class="cal-error">
              지면 교정 실패: {{ groundCal.error || '알 수 없는 오류' }}
            </div>
            <div class="cal-section-actions">
              <button
                class="btn btn-primary btn-sm"
                :disabled="!roverStatus.connected || groundCal.status === 'running'"
                @click="startGroundCalibration"
              >{{ groundCal.status === 'running' ? '교정 중…' : '지면 교정' }}</button>
            </div>
          </section>
        </div>
      </div>

      <!-- Battery calibration modal -->
      <div v-if="showBatteryCal" class="preflight-backdrop" @click.self="showBatteryCal = false">
        <div class="preflight-modal">
          <h3>배터리 전압 보정</h3>
          <div class="cal-current">
            <span class="cal-key">표시 전압</span>
            <span class="cal-val">{{ roverStatus.battery?.voltage != null ? roverStatus.battery.voltage.toFixed(2) + ' V' : '—' }}</span>
            <template v-if="roverStatus.battery?.voltage_raw != null">
              <span class="cal-key">ADC 측정 전압</span>
              <span class="cal-val">{{ roverStatus.battery.voltage_raw.toFixed(2) }} V</span>
            </template>
            <span class="cal-key">GAIN</span>
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
                <button class="btn btn-ghost btn-sm snapshot-delete" @click="deleteSnapshot(s.id)">삭제</button>
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
          <h3>{{ preflightMode === 'resume' ? '재개 전 점검' : '경로 실행 전 점검' }}</h3>
          <div v-if="preflightMode === 'resume'" class="resume-selector">
            완료된 {{ executedIndex }}개 항목은 자동으로 제외하고, 서버에 저장된 남은 경로만 이어갑니다.
          </div>
          <div v-if="preflightEmptyRouteMode === 'return_only'" class="resume-selector">
            콘 방문 없이 현재 위치에서 최초 미션 시작점으로 복귀합니다.
          </div>
          <div v-else-if="preflightEmptyRouteMode === 'resolve_uncertain'" class="resume-selector">
            불확실한 마지막 분사 결과를 운영자 판단으로 해소하고 추가 이동 없이 미션을 완료합니다.
          </div>
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
          <label v-if="!preflightAllOk && !preflightHasBlockingFailure" class="preflight-override">
            <input type="checkbox" v-model="preflightForce" />
            경고를 이해했고, 강제 실행합니다
          </label>
          <div class="preflight-actions">
            <button class="btn btn-ghost btn-sm" @click="cancelPreflight">취소</button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!preflightCanConfirm"
              @click="confirmPreflight"
            >{{ preflightMode === 'resume' ? '이어서 실행' : '실행' }}</button>
          </div>
        </div>
      </div>

      <!-- Workspace: top status strip + body(rail + map + inspector) -->
      <div class="workspace">

        <!-- Persistent status strip (always visible across tabs). Chips live in
             an inner scroller so they scroll horizontally up to — but never
             under — the fullscreen button pinned at the far right. -->
        <div class="status-strip">
          <div class="status-strip-chips" @scroll.passive="onChipStripScroll">
          <template v-if="!roverStatus.connected">
            <span
              :class="['chip-wrapper', { active: activeChipPopover === 'disconnect' }]"
              @click.stop="toggleChipPopover('disconnect', $event)"
            >
              <span class="chip chip-bad">DISCONNECTED</span>
              <span class="chip-popover chip-popover-inline" :style="popoverStyle">
                <span v-if="disconnectInfo">
                  {{ disconnectInfo.label }}<template v-if="disconnectInfo.ago"> · {{ disconnectInfo.ago }}</template>
                </span>
              </span>
            </span>
          </template>

          <!-- Connected: three zones (primary / mission / vitals) of chips -->
          <template v-else>
            <div class="chip-row primary-zone">
              <span
                v-if="fixChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'fix' }]"
                @click.stop="toggleChipPopover('fix', $event)"
              >
                <span :class="['chip', `chip-${fixChip.tone}`]">🛰️ {{ fixChip.label }}</span>
                <span class="chip-popover" :style="popoverStyle">
                  <span class="popover-row" v-for="r in fixChip.rows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span :class="['popover-val', r[2] && `popover-val-${r[2]}`]">{{ r[1] }}</span></span>
                </span>
              </span>
              <span
                v-if="navChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'nav' }]"
                @click.stop="toggleChipPopover('nav', $event)"
              >
                <span :class="['chip', `chip-${navChip.tone}`]">🧭 {{ navChip.label }}</span>
                <span class="chip-popover" :style="popoverStyle">
                  <span class="popover-row" v-for="r in navChip.rows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span :class="['popover-val', r[2] && `popover-val-${r[2]}`]">{{ r[1] }}</span></span>
                </span>
              </span>
            </div>
            <div
              v-if="missionChip"
              :class="['chip-wrapper', 'mission-wrapper', { active: activeChipPopover === 'mission' }]"
              @click.stop="toggleChipPopover('mission', $event)"
            >
              <div class="mission-inline">
                <span class="mission-emoji">🚩</span>
                <div class="mission-bar"><div class="mission-fill" :style="{ width: missionChip.percent + '%' }"></div></div>
                <span class="mission-counts">
                  {{ missionChip.returnOnly ? `시작점 복귀 · ${missionChip.percent}%` : `${missionChip.current}/${missionChip.total} · ${missionChip.percent}%` }}
                </span>
                <span v-if="missionChip.eta" class="mission-eta">ETA {{ missionChip.eta }}</span>
              </div>
              <span class="chip-popover" :style="popoverStyle">
                <span class="popover-row"><span class="popover-key">PROGRESS</span><span class="popover-val">
                  {{ missionChip.returnOnly ? `최초 시작점 복귀 (${missionChip.percent}%)` : `${missionChip.current} / ${missionChip.total} (${missionChip.percent}%)` }}
                </span></span>
                <span v-if="missionChip.eta" class="popover-row"><span class="popover-key">ETA</span><span class="popover-val">{{ missionChip.eta }}</span></span>
              </span>
            </div>
            <div class="chip-row vitals-zone">
              <span
                v-if="batteryChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'battery' }]"
                @click.stop="toggleChipPopover('battery', $event)"
              >
                <span :class="['chip', `chip-${batteryChip.tone}`]">
                  🔋 {{ batteryChip.percent }}%<template v-if="batteryChip.voltage != null"> · {{ batteryChip.voltage.toFixed(1) }}V</template>
                </span>
                <span class="chip-popover" :style="popoverStyle">
                  <span class="popover-row" v-for="r in batteryChip.rows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span :class="['popover-val', r[2] && `popover-val-${r[2]}`]">{{ r[1] }}</span></span>
                  <span class="popover-row popover-actions">
                    <button class="btn btn-ghost btn-sm" @click.stop="openBatteryCal">전압 보정</button>
                  </span>
                </span>
              </span>
              <span
                v-if="navLightsChip"
                :class="['chip-wrapper', { active: activeChipPopover === 'navlights' }]"
                @click.stop="toggleChipPopover('navlights', $event)"
              >
                <span class="chip chip-neutral">💡 {{ navLightsChip.label }}</span>
                <span class="chip-popover navlight-popover" :style="popoverStyle">
                  <button
                    v-for="m in NAV_LIGHT_MODES" :key="m.mode"
                    type="button"
                    :class="['navlight-option', { active: m.mode === navLightsChip.mode }]"
                    :disabled="navLightsBusy"
                    @click.stop="setNavLights(m.mode)"
                  >
                    <span class="navlight-dot">{{ m.mode === navLightsChip.mode ? '●' : '○' }}</span>
                    {{ m.label }}
                  </button>
                  <div class="navlight-bright" @click.stop>
                    <span class="navlight-bright-label">TSAL 밝기 {{ Math.round(ledBrightness / 255 * 100) }}%</span>
                    <input
                      type="range" min="0" max="255" step="5"
                      :value="ledBrightness"
                      @input="onLedBrightnessInput($event.target.value)"
                    />
                  </div>
                  <div class="navlight-bright" @click.stop>
                    <span class="navlight-bright-label">분사 시간 {{ pumpDuration.toFixed(1) }}s</span>
                    <input
                      type="range" min="0.5" max="10" step="0.5"
                      :value="pumpDuration"
                      @input="onPumpDurationInput($event.target.value)"
                    />
                  </div>
                </span>
              </span>
            </div>
          </template>
          </div>
          <button
            v-if="fullscreenSupported"
            class="fullscreen-btn"
            :title="isFullscreen ? '전체화면 종료' : '전체화면'"
            :aria-label="isFullscreen ? '전체화면 종료' : '전체화면'"
            @click="toggleFullscreen"
          >
            <svg v-if="!isFullscreen" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          </button>
        </div>

        <div class="workspace-body">
          <div v-if="!isMobile" class="edge-spacer"></div>
          <!-- Left icon rail -->
          <nav class="rail" aria-label="인스펙터 카테고리">
            <button
              v-for="t in visibleTabs" :key="t.key"
              :class="['rail-btn', { active: activeTab === t.key }]"
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
          <div :class="['map-wrap', { 'map-suspended': showMissionBuilder }]">
            <div id="map" class="map"></div>
            <!-- Map rotation — bottom-left, available on every tab. Each press
                 turns the whole map (tiles + cones + paths) 90° counter-clockwise. -->
            <button
              class="fab-icon-btn map-fab-rotate"
              :style="isMobile ? { position: 'fixed', left: '0.75rem', bottom: `calc(${sheetHeight}px + env(safe-area-inset-bottom) + 70px)`, zIndex: 650 } : null"
              @click="rotateMap"
              aria-label="지도 90° 회전"
              title="지도 90° 회전 (반시계방향)"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
            <!-- Path pick overlay stays inside the map area -->
            <div v-if="roverMode === 'path-pick'" class="map-overlay map-overlay-row">
              <span>시작점을 지도에서 클릭하거나</span>
              <button
                class="btn btn-primary btn-sm"
                :disabled="!roverStatus.connected || !roverStatus.last_position"
                @click="computePathFromRover"
              >현재 로버 위치에서 시작</button>
            </div>

            <!-- Cone-add edit controls (courses tab) — bottom-right of the map. -->
            <div
              v-if="activeTab === 'courses' && activeCourse"
              class="map-fab-panel map-fab-edit"
              :style="isMobile ? { position: 'fixed', right: '0.75rem', bottom: `calc(${sheetHeight}px + env(safe-area-inset-bottom) + 70px)`, zIndex: 650 } : null"
            >
              <button
                :class="['fab-icon-btn', 'fab-lock', { locked: editLocked }]"
                @click="editLocked = !editLocked"
                :aria-label="editLocked ? '편집 잠김 (눌러서 해제)' : '편집 가능 (눌러서 잠금)'"
                :title="editLocked ? '편집 잠김 — 화면 탭/드래그로 콘 추가·이동 불가 (눌러서 해제)' : '편집 가능 — 눌러서 잠그면 화면 탭/드래그 편집 방지'"
              >{{ editLocked ? '🔒' : '🔓' }}</button>
              <button
                class="fab-icon-btn fab-undo"
                :disabled="editLocked || undoStack.length === 0"
                @click="performUndo"
                aria-label="실행취소"
                title="마지막 작업 실행취소 (Ctrl+Z)"
              >↩</button>
              <div class="side-toggle">
                <button :class="['side-btn', { active: currentSide === 'left' }]" @click="currentSide = 'left'" style="--side-color: #f59e0b" title="왼쪽">L</button>
                <button :class="['side-btn', { active: currentSide === 'center' }]" @click="currentSide = 'center'" style="--side-color: #ef4444" title="가운데">C</button>
                <button :class="['side-btn', { active: currentSide === 'right' }]" @click="currentSide = 'right'" style="--side-color: #06b6d4" title="오른쪽">R</button>
              </div>
              <button
                :class="['fab-icon-btn', 'fab-rover', { 'src-receiver': positionSource === 'receiver', 'src-rover': positionSource === 'rover' }]"
                @click="addConeFromRover" :disabled="roverLoading || !canCaptureCone"
                :aria-label="coneCaptureTitle"
                :title="coneCaptureTitle"
              >{{ roverLoading ? '⏳' : coneCaptureIcon }}</button>
            </div>

            <!-- Measurement / selection tools (영역 · 자 · 각도기) — separate
                 top-right panel. Read-only, usable even when editing is locked. -->
            <div
              v-if="activeTab === 'courses' && activeCourse"
              class="map-fab-panel map-fab-tools"
            >
              <button
                :class="['fab-icon-btn', 'fab-tool', { active: routeEditMode }]"
                :disabled="editLocked"
                @click="toggleRouteEditMode"
                aria-label="주행 순서 마커 편집"
                :title="editLocked ? '편집 잠금을 해제해야 주행 마커를 배치할 수 있습니다' : '주행 순서 — 지도에 마커 배치·이동, 마커 탭으로 방문 추가'"
              >🚩</button>
              <button
                :class="['fab-icon-btn', 'fab-tool', { active: showCenterline }]"
                @click="showCenterline = !showCenterline"
                aria-label="중심선 표시"
                title="중심선 — 코스 중심선 표시/숨김"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 18c4 0 5-12 9-12s5 12 9 12" stroke-dasharray="3 3" />
                  <circle cx="3" cy="18" r="1.7" fill="currentColor" stroke="none" />
                  <circle cx="21" cy="18" r="1.7" fill="currentColor" stroke="none" />
                </svg>
              </button>
              <button
                :class="['fab-icon-btn', 'fab-tool', { active: selectMode }]"
                @click="selectMode = !selectMode"
                aria-label="영역 선택 모드"
                title="영역 — 드래그로 여러 콘 선택 (터치 지원)"
              >⬚</button>
              <button
                :class="['fab-icon-btn', 'fab-tool', { active: toolMode === 'ruler' }]"
                @click="enterToolMode('ruler')"
                aria-label="거리 측정"
                title="자 — 콘 사이 거리 측정"
              >📏</button>
              <button
                :class="['fab-icon-btn', 'fab-tool', { active: toolMode === 'protractor' }]"
                @click="enterToolMode('protractor')"
                aria-label="각도 측정"
                title="각도기 — 콘 3개의 각도 측정"
              >📐</button>
              <button
                class="fab-icon-btn fab-tool"
                @click="addMemo"
                aria-label="메모 추가"
                title="메모 — 지도 중앙에 메모 스티커 추가"
              >📝</button>
            </div>

            <!-- Rotation angle HUD — visible while rotating so the operator can stop at an exact angle. -->
            <div v-if="rotateMode" class="rotate-hud">
              <span class="rotate-hud-icon">{{ rotateDirIcon }}</span>
              <span class="rotate-hud-val">{{ rotateAngleAbs }}°</span>
              <span class="rotate-hud-hint">핸들을 돌려 회전 · Shift: 5° 단위</span>
            </div>

            <!-- Measurement tool overlay (distance / angle). -->
            <div v-if="toolMode !== 'none'" class="map-overlay map-overlay-row measure-overlay">
              <span class="measure-tool-name">{{ toolMode === 'ruler' ? '📏 거리' : '📐 각도' }}</span>
              <span class="measure-hint">{{ measureHint }}</span>
              <span v-if="measureResult" class="measure-result">{{ measureResult }}</span>
              <button class="btn btn-ghost btn-sm" @click="resetMeasure">초기화</button>
              <button class="btn btn-ghost btn-sm" @click="exitToolMode">닫기</button>
            </div>

            <!-- Box-select mode overlay. -->
            <div v-if="selectMode" class="map-overlay map-overlay-row measure-overlay">
              <span class="measure-tool-name">⬚ 선택</span>
              <span class="measure-hint">드래그로 영역 선택 · 콘 탭으로 토글</span>
              <span v-if="multiSelectedIds.size" class="measure-result">{{ multiSelectedIds.size }}개</span>
              <button v-if="multiSelectedIds.size" class="btn btn-ghost btn-sm" @click="clearMultiSelection">해제</button>
              <button class="btn btn-ghost btn-sm" @click="selectMode = false">닫기</button>
            </div>

            <!-- Reusable marker placement: tapping empty pavement creates one
                 physical marker; tapping an existing marker appends a visit. -->
            <div v-if="routeEditMode" class="map-overlay map-overlay-row measure-overlay route-overlay">
              <span class="measure-tool-name">🚩 주행 순서</span>
              <span class="measure-hint">빈 곳 탭: 마커 추가 · 마커 탭: 방문 추가 · 드래그: 이동</span>
              <span class="measure-result">{{ activeRoute.markers.length }}개 / {{ activeRoute.steps.length }}단계</span>
              <button class="btn btn-ghost btn-sm" @click="routeEditMode = false">닫기</button>
            </div>

            <!-- Memo label layer — geo-anchored text annotations over the map.
                 The layer is inert (map stays draggable); each label re-enables
                 pointer events. Positions/sizes recompute via mapFrame on every
                 map move/zoom/rotate. Move/delete/resize float in on hover/focus. -->
            <div v-if="activeTab === 'courses' && activeCourse" class="memo-layer">
              <div
                v-for="m in activeMemos"
                :key="m.id"
                class="memo-label"
                :data-id="m.id"
                :style="memoStyle(m)"
              >
                <input
                  class="memo-text"
                  type="text"
                  v-model="m.content"
                  placeholder="라벨"
                  @focus="onMemoFocus(m)"
                  @blur="onMemoBlur(m)"
                  @pointerdown.stop
                />
                <span class="memo-move" @pointerdown="onMemoDragStart(m, $event)" title="드래그하여 이동" aria-label="이동">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
                </span>
                <button class="memo-del" @pointerdown.stop @click="deleteMemo(m.id)" title="라벨 삭제" aria-label="삭제">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <span class="memo-rotate" @pointerdown="onMemoRotateStart(m, $event)" title="드래그하여 회전 · 클릭하면 초기화" aria-label="회전 (클릭 시 초기화)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                </span>
                <span class="memo-resize" @pointerdown="onMemoResizeStart(m, $event)" title="드래그하여 크기 조절" aria-label="크기 조절">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                </span>
              </div>
            </div>
          </div>

          <!-- Resize handle (desktop only) -->
          <div
            v-if="!isMobile"
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

              <!-- Courses tab (merged with cones) -->
              <section v-show="activeTab === 'courses'" class="tab-pane">
                <header class="tab-header">
                  <h3>코스 관리</h3>
                </header>
                <div class="course-add">
                  <input v-model="newCourseName" placeholder="새 코스 이름" maxlength="100" @keyup.enter="createCourse" />
                  <button class="btn btn-primary btn-lg-touch btn-icon-only" @click="createCourse" :disabled="!newCourseName.trim()" title="코스 추가">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </button>
                  <button class="btn btn-ghost btn-lg-touch btn-icon-only" @click="triggerImport" :disabled="!newCourseName.trim()" title="JSON 가져오기 (입력한 이름으로 추가)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  </button>
                  <input ref="importInput" type="file" accept=".json" hidden @change="importCourse" />
                </div>
                <div class="course-toolbar" v-if="isAdmin">
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
                    @click="selectCourse(c.id)"
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
                      <span class="course-name" @dblclick.stop="startEditCourse(c)">
                        {{ c.name }} <span class="cone-count">({{ c.cone_count }})</span>
                      </span>
                    </template>
                    <button class="dl-btn" @click.stop="exportCourse(c.id)" :disabled="exportingId === c.id" :title="exportingId === c.id ? '내보내는 중…' : 'ZIP 내보내기 (AC 트랙 + JSON + 미리보기)'">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    </button>
                    <button v-if="isAdmin" class="del-btn" @click.stop="deleteCourse(c.id)" title="삭제">×</button>
                  </div>
                  <div v-if="courses.length === 0" class="empty-msg">코스를 추가하세요.</div>
                </div>

                <!-- Cones panel for the selected course -->
                <template v-if="activeCourse">
                  <header class="tab-header tab-header-sub">
                    <h3>{{ activeCourse.name }}<span v-if="centerline?.ok" class="centerline-len"> ({{ Math.round(centerline.length) }} m{{ routeModeSuffix }})</span><span v-if="editLocked" class="lock-badge" title="편집 잠김">🔒</span></h3>
                  </header>

                  <div class="inspector-group route-editor">
                    <div class="route-editor-heading">
                      <div class="group-title">주행 순서 마커</div>
                      <span :class="['route-mode-badge', { guided: routeMode === ROUTE_MODE.GUIDED, oriented: routeMode === ROUTE_MODE.ORIENTED }]">{{ routeModeLabel }}</span>
                    </div>
                    <p class="hint">마커가 2단계 이상이면 표시 순서대로 중심선을 만듭니다. 같은 마커를 반복 방문에 여러 번 사용할 수 있습니다.</p>
                    <p v-if="routeError" class="route-error">{{ routeError }}</p>
                    <div class="route-marker-list">
                      <div v-for="(marker, markerIndex) in activeRoute.markers" :key="marker.id" class="route-marker-row">
                        <span class="route-marker-index">M{{ markerIndex + 1 }}</span>
                        <input
                          :value="marker.label"
                          maxlength="50"
                          :disabled="editLocked"
                          aria-label="주행 마커 이름"
                          @change="updateRouteMarker(marker, { label: $event.target.value })"
                        />
                        <button class="btn btn-ghost btn-sm route-icon-action" :disabled="editLocked" @click="appendRouteVisit(marker.id)" title="방문 단계 맨 뒤에 추가">＋</button>
                        <button class="del-btn" :disabled="editLocked" @click="deleteRouteMarker(marker)" title="마커와 해당 방문 삭제">×</button>
                      </div>
                      <div v-if="activeRoute.markers.length === 0" class="empty-msg">잠금을 풀고 🚩 도구로 노면 위에 마커를 배치하세요.</div>
                    </div>
                    <div v-if="activeRoute.steps.length" class="route-step-list">
                      <div v-for="(markerId, index) in activeRoute.steps" :key="`${index}-${markerId}`" class="route-step-row">
                        <span class="route-step-rank">{{ index + 1 }}</span>
                        <span class="route-step-name">{{ routeMarkerById.get(markerId)?.label || `M${markerId}` }}</span>
                        <button class="route-step-action" :disabled="editLocked || index === 0" @click="moveRouteVisit(index, -1)" title="앞으로">↑</button>
                        <button class="route-step-action" :disabled="editLocked || index === activeRoute.steps.length - 1" @click="moveRouteVisit(index, 1)" title="뒤로">↓</button>
                        <button class="route-step-action danger" :disabled="editLocked" @click="removeRouteVisit(index)" title="이 방문만 삭제">×</button>
                      </div>
                    </div>
                    <div class="route-editor-actions">
                      <button class="btn btn-ghost btn-sm" :disabled="editLocked" @click="toggleRouteEditMode">{{ routeEditMode ? '배치 종료' : '지도에서 배치' }}</button>
                      <button class="btn btn-ghost btn-sm" :disabled="editLocked || activeRoute.steps.length === 0" @click="saveRouteSteps([])">순서 초기화</button>
                    </div>
                  </div>

                  <div v-if="multiSelectedIds.size > 0" class="inspector-group selected">
                    <div class="group-title">{{ multiSelectedIds.size }}개 선택됨</div>
                    <p class="multi-select-hint" v-if="!editLocked">드래그로 이동 · 회전 · 삭제(Del)</p>
                    <p class="multi-select-hint locked-note" v-else>🔒 편집 잠김 — 이동·회전·삭제 불가</p>
                    <div class="edit-buttons">
                      <button
                        :class="['btn', 'btn-lg-touch', rotateMode ? 'btn-primary' : 'btn-ghost']"
                        :disabled="editLocked || multiSelectedIds.size < 2"
                        @click="enterRotateMode"
                        title="선택한 콘을 중심점 기준으로 회전"
                      >{{ rotateMode ? '회전 종료' : '회전' }}</button>
                      <button class="btn btn-danger btn-lg-touch" :disabled="editLocked" @click="deleteSelected">삭제 ({{ multiSelectedIds.size }})</button>
                      <button class="btn btn-ghost btn-lg-touch" @click="clearMultiSelection">선택 해제</button>
                    </div>
                    <div v-if="rotateMode" class="rotate-controls">
                      <label>정확한 각도</label>
                      <input v-model="rotateInput" type="number" step="any" placeholder="시계방향 +, 예: 90" @keyup.enter="applyRotateInput" />
                      <button class="btn btn-ghost btn-sm" @click="applyRotateInput">적용</button>
                    </div>
                  </div>

                  <div v-if="selectedConeId && multiSelectedIds.size === 0" class="inspector-group selected">
                    <div class="group-title">콘 수정 #{{ activeConeSideRanks.get(selectedConeId) || 0 }}</div>
                    <div class="coord-inputs">
                      <input v-model="editLat" type="number" step="any" placeholder="위도" />
                      <input v-model="editLng" type="number" step="any" placeholder="경도" />
                      <select v-model="editSide">
                        <option value="left">L 왼쪽</option>
                        <option value="center">C 가운데</option>
                        <option value="right">R 오른쪽</option>
                      </select>
                    </div>
                    <div v-if="selectedCone && selectedCone.alt != null" class="cone-alt-readout" title="고도 (MSL) — RTK 측정값, 편집 불가">
                      고도 {{ formatAlt(selectedCone.alt) }} m
                    </div>
                    <div class="edit-buttons">
                      <button class="btn btn-primary btn-lg-touch" @click="updateCone">저장</button>
                      <button class="btn btn-danger btn-lg-touch" @click="deleteCone(selectedConeId)">삭제</button>
                      <button class="btn btn-ghost btn-lg-touch" @click="selectedConeId = null">취소</button>
                    </div>
                    <div v-if="!hasMarkerRoute" class="edit-buttons">
                      <button
                        :class="['btn', 'btn-lg-touch', isStartCone ? 'btn-primary' : 'btn-ghost']"
                        @click="setStartCone"
                        title="이 콘에서 가장 가까운 센터라인 지점을 코스 시작점으로 지정"
                      >{{ isStartCone ? '시작점 해제' : '시작점 지정' }}</button>
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
                        <button :class="['filter-btn', { active: coneFilter === 'center' }]" @click="coneFilter = 'center'" :style="{ '--fc': SIDE_COLORS.center }" title="가운데">C</button>
                        <button :class="['filter-btn', { active: coneFilter === 'right' }]" @click="coneFilter = 'right'" :style="{ '--fc': SIDE_COLORS.right }" title="오른쪽">R</button>
                      </div>
                    </div>
                    <div class="cone-list" ref="coneListEl" @scroll="onConeListScroll">
                      <div
                        v-for="cone in filteredCones" :key="cone.id"
                        :data-cone-id="cone.id"
                        :class="['cone-item', { selected: selectedConeId === cone.id }]"
                        @click="panToCone(cone)"
                      >
                        <span class="cone-num" :style="{ color: SIDE_COLORS[cone.side] }">#{{ activeConeSideRanks.get(cone.id) || 0 }}</span>
                        <span class="cone-coords">{{ formatLatLng(cone.lat, cone.lng) }}</span>
                        <span v-if="cone.alt != null" class="cone-alt" title="고도 (MSL)">{{ formatAlt(cone.alt) }} m</span>
                        <button class="del-btn" @click.stop="deleteCone(cone.id)" title="삭제">×</button>
                      </div>
                      <div v-if="filteredCones.length === 0" class="empty-msg">콘이 없습니다.</div>
                    </div>
                    <button
                      v-show="coneListScrolled"
                      class="cone-scrolltop"
                      @click="scrollConeListTop"
                      title="목록 맨 위로"
                    >↑</button>
                    <button
                      class="btn btn-danger cone-delete-all"
                      :disabled="activeCones.length === 0"
                      @click="deleteAllCones"
                    >전체 삭제</button>
                  </div>
                </template>
              </section>

              <!-- Rover tab — header/divider intentionally omitted to save
                   vertical space; the active tab already identifies the pane. -->
              <section v-show="activeTab === 'rover'" class="tab-pane">
                <div v-if="roverStatus.connected" class="inspector-group gps-block">
                  <div class="group-title">GPS</div>
                  <div class="gps-grid">
                    <div class="gps-cell">
                      <span class="gps-label">HEAD</span>
                      <span class="gps-val">
                        <span
                          class="compass-arrow"
                          :style="{
                            transform: `rotate(${roverStatus.gps?.heading ?? 0}deg)`,
                            opacity: roverStatus.gps?.heading == null ? 0.25 : 1,
                          }"
                        >▲</span>
                        {{ roverStatus.gps?.heading != null ? roverStatus.gps.heading.toFixed(0) + '°' : '—' }}
                      </span>
                    </div>
                    <div class="gps-cell">
                      <span class="gps-label">SPEED</span>
                      <span class="gps-val">{{ roverStatus.gps?.speed != null ? roverStatus.gps.speed.toFixed(2) + ' m/s' : '—' }}</span>
                    </div>
                    <div class="gps-cell">
                      <span class="gps-label">ACC</span>
                      <span class="gps-val">{{ roverStatus.gps?.h_acc != null ? '±' + roverStatus.gps.h_acc.toFixed(2) + ' m' : '—' }}</span>
                    </div>
                    <div class="gps-cell">
                      <span class="gps-label">SAT</span>
                      <span class="gps-val">{{ roverStatus.gps?.num_sv ?? '—' }}</span>
                    </div>
                    <div class="gps-cell">
                      <span class="gps-label">ALT</span>
                      <span class="gps-val">{{ roverStatus.gps?.altitude != null ? formatAlt(roverStatus.gps.altitude) + ' m' : '—' }}</span>
                    </div>
                    <div class="gps-cell">
                      <span class="gps-label">PDOP</span>
                      <span class="gps-val">{{ roverStatus.gps?.pdop != null ? roverStatus.gps.pdop.toFixed(2) : '—' }}</span>
                    </div>
                  </div>
                </div>

                <div v-if="!activeCourse" class="empty-msg large">
                  <div v-if="roverStatus.connected" class="rover-controls rover-controls-grid follow-only">
                    <button
                      :class="['btn', 'btn-lg-touch', followRover ? 'btn-primary' : 'btn-ghost']"
                      @click="toggleFollowRover"
                    >로버 추적</button>
                  </div>
                  <button
                    v-if="roverStatus.connected"
                    class="btn btn-lg-touch btn-ghost manual-btn-row"
                    @click="openCalibration"
                  >보정</button>
                  코스를 먼저 선택하세요.
                  <button class="btn btn-ghost btn-lg-touch" @click="activeTab = 'courses'">코스 탭으로</button>
                </div>
                <template v-else>
                  <!-- All always-on rover controls share ONE grid so they lay
                       out 3 per row. The 카메라 button cycles off → 2D → depth
                       overlay → off (blue = 2D, violet = depth); VR opens the
                       headset teleop view (enabled even while offline). -->
                  <div class="rover-controls rover-controls-grid">
                    <!-- Row 1: 로버 추적 · 카메라 · 수동 제어 -->
                    <button
                      :class="['btn', 'btn-lg-touch', followRover ? 'btn-primary' : 'btn-ghost']"
                      :disabled="!roverStatus.connected"
                      @click="toggleFollowRover"
                    >로버 추적</button>
                    <button
                      :class="['btn', 'btn-lg-touch', !cameraOn ? 'btn-ghost' : (cameraDepthOn ? 'camera-btn-depth' : 'btn-primary')]"
                      :disabled="!roverStatus.connected"
                      @click="cycleCamera"
                    >카메라</button>
                    <button
                      :class="['btn', 'btn-lg-touch', roverMode === 'manual' ? 'btn-primary' : 'btn-ghost']"
                      :disabled="manualAuthorityReleaseBusy || (roverMode !== 'manual' && (!roverStatus.connected || (activeMission && !missionHeld) || roverStatus.nav_state === 'EMERGENCY_STOP'))"
                      @click="roverMode === 'manual' ? stopManualControl() : startManualControl()"
                    >{{ manualAuthorityReleaseBusy ? '서버 제어 전환 중…' : '수동 제어' }}</button>
                    <!-- Row 2: VR · 보정 · 경로 계산 -->
                    <button
                      class="btn btn-lg-touch btn-ghost"
                      @click="goVr"
                    >VR</button>
                    <button
                      class="btn btn-lg-touch btn-ghost"
                      :disabled="!roverStatus.connected"
                      @click="openCalibration"
                    >보정</button>
                    <button
                      :class="['btn', 'btn-lg-touch', pathBtnClass]"
                      @click="onPathBtn"
                      :disabled="pathButtonDisabled"
                    >{{ pathBtnLabel }}</button>
                  </div>

                  <!-- Obstacle alert — the rover auto-paused on a corridor
                       obstacle. Persistent (driven by server state) so a tab
                       opened after the event still sees it; clears on resume. -->
                  <div v-if="roverStatus.obstacle && roverStatus.obstacle.active" class="obstacle-alert">
                    <div class="obstacle-alert-title">
                      ⚠ 주행 경로 장애물 — 미션 자동 일시정지됨<span
                        v-if="roverStatus.obstacle.nearest_m != null"> (약 {{ roverStatus.obstacle.nearest_m.toFixed(1) }} m 앞)</span>
                    </div>
                    <div class="obstacle-alert-hint">카메라로 확인 후 수동 제어로 비켜 운전하고 재개하세요.</div>
                  </div>

                  <!-- Soft pause / resume — shown while a mission is in progress.
                       Pause holds without E-Stop so the operator can drive
                       manually around an obstacle, then resume from the cone. -->
                  <div v-if="roverMode === 'executing'" class="rover-controls">
                    <button
                      v-if="roverStatus.nav_state === 'PAUSED'"
                      class="btn btn-lg-touch btn-primary"
                      :disabled="pauseBusy || !roverStatus.connected"
                      @click="resumeMission"
                    >▶ 재개</button>
                    <button
                      v-else
                      class="btn btn-lg-touch btn-ghost"
                      :disabled="pauseBusy || !roverStatus.connected || !PAUSABLE_NAV.has(roverStatus.nav_state)"
                      @click="pauseMission"
                    >⏸ 일시정지</button>
                  </div>
                  <div v-if="cameraOn" class="camera-view">
                    <!-- WebRTC (low-latency H.264) is the PRIMARY source — we connect
                         straight to it ("연결 중…" over black during the brief
                         negotiate/decode). The MJPEG <img> only appears as a fallback
                         (mjpegFallback) if WebRTC can't establish or drops. The video
                         is always rendered so it decodes (a display:none video may
                         never reach playing). -->
                    <video ref="cameraVideoEl" autoplay muted playsinline></video>
                    <!-- The <img> stays MOUNTED; when WebRTC is playing we swap its
                         src to a 1×1 blank so Chrome ABORTS the multipart/x-mixed-replace
                         request (removing the element via v-if leaves that sticky
                         connection open → the rover keeps sending JPEG = wasted uplink). -->
                    <img ref="cameraImgEl" v-show="cameraStreamUrl" :src="cameraStreamUrl || BLANK_IMG" class="camera-fallback" alt="rover camera" @error="onCameraError" />
                    <div v-if="cameraOverlayText" class="camera-error">{{ cameraOverlayText }}</div>
                  </div>

                  <div v-if="pathDistance > 0" class="path-info">
                    <div>예상 주행 거리: {{ pathDistance >= 1000 ? (pathDistance / 1000).toFixed(2) + ' km' : pathDistance.toFixed(1) + ' m' }}</div>
                    <div v-if="roverMode === 'executing' || roverMode === 'stopped'">
                      <template v-if="pathWaypoints.length === 0 && missionFinishBehavior === 'return_to_start'">최초 미션 시작점 복귀</template>
                      <template v-else>웨이포인트 {{ executedIndex }}/{{ pathWaypoints.length }}</template>
                      <span v-if="pathProgress > 0" class="path-info-progress">({{ pathProgress }}%)</span>
                    </div>
                  </div>

                  <!-- Waypoint reorder (path-ready only) -->
                  <div v-if="roverMode === 'path-ready'" class="rover-controls">
                    <button class="btn btn-lg-touch btn-ghost btn-block" @click="openMissionBuilder">
                      콘 선택·순서·종료 동작 편집
                    </button>
                  </div>
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
                      <span class="waypoint-coord">{{ formatLatLng(wp.lat, wp.lng) }}</span>
                      <div class="waypoint-arrows">
                        <button class="arrow-btn" :disabled="idx === 0" @click="moveWaypoint(idx, -1)" title="위로">↑</button>
                        <button class="arrow-btn" :disabled="idx === pathWaypoints.length - 1" @click="moveWaypoint(idx, 1)" title="아래로">↓</button>
                      </div>
                    </div>
                  </div>

                  <!-- Abandon the preserved (e-stop/interrupted) mission. Map taps
                       no longer do this — only this explicit button — so a stray
                       tap can't wipe "이어서 실행". -->
                  <div v-if="roverMode === 'stopped'" class="rover-controls mission-held-actions">
                    <button
                      class="btn btn-lg-touch btn-ghost"
                      :disabled="!missionHeld"
                      @click="openMissionBuilder"
                    >남은 경로 편집</button>
                    <button
                      class="btn btn-lg-touch btn-danger btn-block"
                      :disabled="stopping"
                      @click="abandonMission"
                    >미션 종료</button>
                  </div>

                  <!-- Manual joystick -->
                  <div v-if="roverMode === 'manual'" class="joystick-area">
                    <div class="joystick-info" ref="joystickInfoEl">T: 0 / S: 0</div>
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
                          ref="joystickKnobEl"
                          style="transform: translate(0px, 0px)"
                        ></div>
                      </div>
                      <div class="joystick-labels">
                        <span class="jl-up">▲</span><span class="jl-down">▼</span>
                        <span class="jl-left">◄</span><span class="jl-right">►</span>
                      </div>
                    </div>
                    <div class="pump-control">
                      <button
                        class="pump-btn"
                        :class="{ active: pumpOn }"
                        :disabled="pumpBusy"
                        @click="togglePump"
                      >PUMP</button>
                    </div>
                  </div>
                </template>
              </section>

              <!-- History tab (missions + logs) -->
              <section v-show="activeTab === 'history'" class="tab-pane">
                <header class="tab-header">
                  <h3>{{ historyView === 'missions' ? '미션 이력' : '로버 로그' }}</h3>
                  <div class="history-switcher">
                    <button :class="['history-switch-btn', { active: historyView === 'missions' }]" @click="historyView = 'missions'">이력</button>
                    <button :class="['history-switch-btn', { active: historyView === 'logs' }]" @click="historyView = 'logs'">로그</button>
                  </div>
                </header>

                <template v-if="historyView === 'missions'">
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
                </template>

                <template v-else>
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
                      v-for="(e, i) in logsNewestFirstTrimmed" :key="i"
                      :class="['log-row', `log-${(e.level || '').toLowerCase()}`]"
                    >
                      <span class="log-time">{{ formatLogTime(e.t) }}</span>
                      <span class="log-level">{{ e.level }}</span>
                      <span class="log-msg">{{ e.msg }}</span>
                    </div>
                  </div>
                </template>
              </section>

              <!-- GPS tab (receiver source + base-station survey points) -->
              <section v-show="activeTab === 'gps'" class="tab-pane">
                <!-- Receiver status — DEVICE + GPS rows in one popover-style grid -->
                <div class="inspector-group">
                  <div class="group-title">GPS 수신기</div>
                  <div class="gps-detail">
                    <span class="popover-row" v-for="r in receiverGpsRows" :key="r[0]"><span class="popover-key">{{ r[0] }}</span><span :class="['popover-val', r[2] && `popover-val-${r[2]}`]">{{ r[1] }}</span></span>
                  </div>
                  <button
                    class="btn btn-lg-touch gps-track-btn"
                    :class="followReceiver ? 'btn-primary' : 'btn-ghost'"
                    :disabled="!receiverCanTrack"
                    @click="toggleFollowReceiver"
                  >수신기 추적</button>
                </div>

                <!-- NTRIP source selection -->
                <div class="inspector-group">
                  <div class="group-title">로버 NTRIP 보정 소스</div>
                  <div v-if="baseNoReceiver" class="gps-alert">
                    ⚠️ GPS 수신기가 연결되지 않았습니다. 수신기를 연결하거나 NGII로 전환하세요.
                  </div>
                  <div class="gps-source-choices">
                    <label :class="['gps-source-opt', { active: gpsConfig.ntrip_source === 'ngii' }]">
                      <input type="radio" :checked="gpsConfig.ntrip_source === 'ngii'"
                             :disabled="gpsSaving" @change="setNtripSource('ngii')" />
                      <div>
                        <strong>NGII (국토지리정보원)</strong>
                        <div class="gps-sub">NTRIP 캐스터에서 최근접 기준국 자동 선택</div>
                      </div>
                    </label>
                    <label :class="['gps-source-opt', { active: gpsConfig.ntrip_source === 'base', disabled: !hasSurveyedPoint }]">
                      <input type="radio" :checked="gpsConfig.ntrip_source === 'base'"
                             :disabled="gpsSaving || !hasSurveyedPoint" @change="setNtripSource('base', selectedBasePointId)" />
                      <div>
                        <strong>RTK 수신기</strong>
                        <div class="gps-sub">측량점에 배치한 수신기를 고정 기준국으로 사용</div>
                      </div>
                    </label>
                  </div>
                  <div v-if="gpsConfig.ntrip_source === 'base'" class="gps-base-select">
                    <label>기준점</label>
                    <select v-model.number="selectedBasePointId" :disabled="gpsSaving"
                            @change="setNtripSource('base', selectedBasePointId)">
                      <option v-for="p in surveyedPoints" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </select>
                  </div>
                </div>

                <!-- Survey points -->
                <div class="inspector-group">
                  <div class="group-title">측량점 (기준국 위치)</div>
                  <div class="gps-add-row">
                    <input v-model="newSurveyName" type="text" placeholder="측량점 이름"
                           maxlength="100" @keyup.enter="addSurveyPoint" />
                    <button class="btn btn-primary btn-sm" :disabled="!newSurveyName.trim()" @click="addSurveyPoint">추가</button>
                  </div>
                  <div v-if="surveyPoints.length === 0" class="empty-msg">측량점이 없습니다.</div>
                  <div v-else class="gps-point-list">
                    <div v-for="p in surveyPoints" :key="p.id"
                         :data-survey-id="p.id"
                         :class="['gps-point-card', {
                           'is-base': gpsConfig.ntrip_source === 'base' && gpsConfig.active_base_point_id === p.id,
                           clickable: p.lat != null && p.lng != null,
                           selected: selectedSurveyPointId === p.id,
                         }]"
                         :title="p.lat != null && p.lng != null ? '지도에서 이 측량점으로 이동' : ''"
                         @click="panToSurveyPoint(p)">
                      <div class="gps-point-head">
                        <strong class="gps-point-name">{{ p.name }}</strong>
                        <span v-if="gpsConfig.ntrip_source === 'base' && gpsConfig.active_base_point_id === p.id" class="gps-tag gps-tag-base">기준국</span>
                        <span v-else-if="p.lat == null" class="gps-tag gps-tag-warn">미측량</span>
                        <span v-else class="gps-tag gps-tag-ok">측량점</span>
                      </div>
                      <div v-if="p.lat != null && p.lng != null" class="gps-point-coord">
                        <span class="gps-point-latlng">{{ formatLatLng(p.lat, p.lng) }}<template v-if="p.alt != null"> · {{ formatAlt(p.alt) }} m</template></span>
                        <span class="gps-sub" v-if="p.h_acc_m != null || p.surveyed_at">
                          <template v-if="p.h_acc_m != null">±{{ (p.h_acc_m * 100).toFixed(1) }} cm</template><template v-if="p.surveyed_at">{{ p.h_acc_m != null ? ' · ' : '' }}{{ formatSnapshotTime(p.surveyed_at) }}</template>
                        </span>
                      </div>

                      <!-- Surveying: survey-specific progress (samples averaged + time) -->
                      <template v-if="surveyingPointId === p.id">
                        <div class="gps-survey-live">
                          <div class="gps-survey-meta">
                            <span class="gps-surveying">측량 중</span>
                            <span v-if="surveyProgress" class="gps-sub">{{ surveyProgress.samples }}개 수집 · {{ surveyProgress.remaining }}s 남음</span>
                          </div>
                          <div class="gps-progress"><div class="gps-progress-bar" :style="{ width: (surveyProgress ? surveyProgress.pct : 0) + '%' }"></div></div>
                        </div>
                        <div class="gps-point-actions">
                          <button class="btn btn-ghost btn-sm gps-btn-danger" @click.stop="cancelSurvey(p)">측량 취소</button>
                        </div>
                      </template>
                      <!-- Idle: survey / delete actions -->
                      <div v-else class="gps-point-actions">
                        <button class="btn btn-ghost btn-sm"
                                :disabled="!receiverConnected || baseState !== 'idle'"
                                @click.stop="startSurvey(p)">{{ p.lat != null ? '재측량' : '측량' }}</button>
                        <button class="btn btn-ghost btn-sm gps-btn-danger"
                                :disabled="gpsConfig.ntrip_source === 'base' && gpsConfig.active_base_point_id === p.id"
                                @click.stop="deleteSurveyPoint(p)">삭제</button>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

            </div>
          </aside>
          <div v-if="!isMobile" class="edge-spacer"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-layout { height: 100%; overflow: hidden; padding: 0 0 1rem; position: relative; }

.content {
  height: 100%; display: flex; flex-direction: column; overflow: hidden;
  position: relative;
  background: var(--bg-primary);
}

.workspace { flex: 1; display: flex; flex-direction: column; min-height: 0; }

/* ── Top status strip ─────────────────────────────── */
.status-strip {
  display: flex; align-items: center; gap: 0.75rem;
  /* Equal padding all round so the left edge and the fullscreen button's right
     edge sit the same distance from the border as the top/bottom. */
  padding: 0.875rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary); color: var(--text-primary);
  font-size: 0.85rem;
  /* No wrap here: the chips scroller (flex: 1) and the pinned fullscreen button
     stay on one row. z-index 999: above Leaflet panes (max 700), below the
     NavMenu drawer (1000). */
  position: relative;
  z-index: 999;
}

/* Inner chip scroller — grows to fill the strip and (on mobile) scrolls
   horizontally, leaving the fullscreen button pinned at the far right. The
   0.75rem gap matches .chip-row so spacing is uniform across zone boundaries. */
.status-strip-chips {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 0.75rem;
  flex-wrap: wrap;
}

.fullscreen-btn {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  border: 1px solid var(--border-color); border-radius: 8px;
  background: var(--bg-secondary); color: var(--text-secondary);
  cursor: pointer; transition: background-color 0.15s, color 0.15s;
}
.fullscreen-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.chip-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.primary-zone { flex: 0 1 auto; }
.vitals-zone { flex: 0 1 auto; }

/* Popover: :hover on desktop, .active toggle on touch. */
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
  max-width: min(360px, calc(100vw - 1.5rem));
  padding: 0.55rem 0.75rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
  font-size: 0.9rem;
  line-height: 1.5;
  cursor: default;
}
.chip-wrapper:hover > .chip-popover,
.chip-wrapper.active > .chip-popover {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 0.85rem;
  row-gap: 0.18rem;
  align-items: baseline;
}
.chip-wrapper:hover > .chip-popover.chip-popover-inline,
.chip-wrapper.active > .chip-popover.chip-popover-inline {
  display: block;
  font-family: "JetBrains Mono", monospace;
}
.popover-row { display: contents; }
.popover-key {
  color: var(--text-secondary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.popover-val {
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.9rem;
  font-weight: 600;
  word-break: keep-all;
  overflow-wrap: anywhere;
}
.popover-val-ok { color: #22c55e; }
.popover-val-warn { color: #f59e0b; }
.popover-val-bad { color: #ef4444; }
.popover-val-neutral { color: var(--text-secondary); }

/* Popover action row (e.g. battery 보정 button) — span both grid columns
   and switch back to flex so the button can right-align inside the box. */
.popover-row.popover-actions {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  padding-top: 0.4rem;
  margin-top: 0.3rem;
  border-top: 1px solid var(--border-color, rgba(0, 0, 0, 0.08));
}

/* Battery cal modal — borrows the preflight modal frame, just adds
   the layout for the current-state grid + the input row. */
.cal-current {
  display: grid;
  grid-template-columns: max-content 1fr max-content 1fr;
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
/* Antenna-cal modal: same frame as battery, plus a yellow warning callout
   for the "drive pattern needs clear space" notice and a reason line for
   failed calibrations. */
.modal-warning {
  margin: 0 0 0.75rem 0;
  padding: 0.6rem 0.75rem;
  background: rgba(234, 179, 8, 0.12);
  border: 1px solid rgba(234, 179, 8, 0.5);
  border-radius: 6px;
  font-size: 0.85rem;
  color: var(--text-primary);
  line-height: 1.45;
}
.modal-status {
  margin: 0 0 0.75rem 0;
  padding: 0.5rem 0.75rem;
  background: rgba(59, 130, 246, 0.10);
  border: 1px solid rgba(59, 130, 246, 0.4);
  border-radius: 6px;
  font-size: 0.85rem;
  color: var(--text-primary);
}
.cal-error {
  margin: 0.5rem 0 0 0;
  padding: 0.4rem 0.6rem;
  background: rgba(239, 68, 68, 0.10);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 4px;
  font-size: 0.8rem;
  color: var(--text-primary);
}

/* Stereo-calibration section: terse method steps + the shell command. */
.cal-steps {
  margin: 0.25rem 0 0.6rem;
  padding-left: 1.2rem;
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--text-primary);
}
.cal-steps li { margin: 0.2rem 0; }
.cal-square-field { max-width: 12rem; margin: 0.3rem 0 0.6rem; }

/* Tabbed calibration modal: one row of tabs switches between antenna / wheel /
   stereo / ground so the modal no longer scrolls as one long stack. */
.cal-tabs {
  display: flex;
  gap: 0.15rem;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 0.7rem;
}
.cal-tab {
  flex: 1;
  padding: 0.45rem 0.3rem;
  font-size: 0.82rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;                 /* overlap the tab strip's border */
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.cal-tab:hover { color: var(--text-primary); }
.cal-tab.active {
  color: var(--accent-primary);
  border-bottom-color: var(--accent-primary);
  font-weight: 600;
}
/* Running indicator so switching tabs never hides an in-progress calibration. */
.cal-tab-dot {
  display: inline-block;
  width: 6px; height: 6px;
  margin-left: 0.3rem;
  border-radius: 50%;
  background: #f59e0b;
  vertical-align: middle;
}
/* Terse "when to re-run" hint under each section title. */
.cal-when {
  font-size: 0.78rem;
  color: var(--text-secondary);
  margin: 0.1rem 0 0.55rem;
}

/* The cal modal can grow taller than the mobile viewport (two long
   warnings + scale rows + trim rows + a status line each). Cap its
   height to the visible viewport, scroll the body, and pin the title
   bar on top so the X close button is always reachable — the bottom
   close button used to fall below the fold on phones. */
.calibration-modal {
  display: flex; flex-direction: column;
  max-height: calc(100dvh - 2rem);
  overflow: hidden;
}
.calibration-modal > .modal-titlebar { flex: 0 0 auto; }
.calibration-modal > .preflight-actions { flex: 0 0 auto; }
/* Tabs are v-show (only one section visible at a time), so a per-section
   top divider renders as a stray rule at the top of each tab. Drop it and
   give every tab the same top padding for a consistent header gap. */
.calibration-modal .cal-section {
  padding: 0.5rem 0 0.75rem;
}
/* Body sections scroll independently of the title bar / footer. */
.calibration-modal > .cal-section { overflow-y: auto; }
.cal-warn {
  background: rgba(234, 179, 8, 0.12) !important;
  border-color: rgba(234, 179, 8, 0.5) !important;
}
.modal-titlebar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem;
  margin: 0 0 0.5rem 0;
}
.modal-titlebar h3 { margin: 0; }
.modal-close-x {
  appearance: none; background: transparent; border: none;
  font-size: 1.6rem; line-height: 1; cursor: pointer;
  color: var(--text-secondary);
  padding: 0.25rem 0.6rem; border-radius: 6px;
}
.modal-close-x:hover { background: var(--bg-secondary); color: var(--text-primary); }
.modal-close-x:disabled { cursor: not-allowed; opacity: 0.5; }
.cal-source-tag {
  font-size: 0.7rem; font-weight: 500;
  margin-left: 0.4rem; padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-secondary); color: var(--text-secondary);
  vertical-align: middle;
}
.cal-subsection {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px dashed color-mix(in srgb, var(--border-color) 60%, transparent);
}
.cal-subsection-title {
  font-size: 0.85rem; font-weight: 600;
  margin-bottom: 0.35rem;
  color: var(--text-primary);
}
.cal-help {
  margin: 0 0 0.5rem 0;
  font-size: 0.78rem; line-height: 1.4;
  color: var(--text-secondary);
}
.cal-manual-row {
  display: flex; gap: 0.5rem; align-items: flex-end;
  flex-wrap: wrap;
}
.cal-manual-field {
  display: flex; flex-direction: column; gap: 0.15rem;
  font-size: 0.75rem; color: var(--text-secondary);
  flex: 1 1 5em; min-width: 5em;
}
.cal-manual-field input {
  font-family: "JetBrains Mono", monospace;
  padding: 0.3rem 0.4rem;
  border-radius: 4px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary); color: var(--text-primary);
  width: 100%; box-sizing: border-box;
}
/* Proximity-detection on/off row: label left, checkbox right (horizontal,
   unlike .cal-manual-field's stacked number inputs). */
.cal-toggle-field {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem;
  margin: 0.1rem 0 0.4rem;
  font-size: 0.9rem; font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
}
.cal-toggle-field input {
  width: 1.15rem; height: 1.15rem; flex: 0 0 auto; cursor: pointer;
}
.cal-section-title {
  font-size: 0.95rem; font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}
.cal-section-actions {
  margin-top: 0.5rem;
  display: flex; justify-content: flex-end;
  gap: 0.5rem;
}
.cal-space-req {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 0.4rem;
}
/* Auto-cal: keep the space-requirement text and the start button on one
   row, vertically centred, so the button sits at the text's height. */
.cal-space-req-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}
.cal-space-req-row .cal-space-req {
  margin-bottom: 0;
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
  padding: 0.25rem 0.7rem; border-radius: 999px;
  font-size: 0.85rem; font-weight: 600;
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
  border-color: var(--border-color);
  color: var(--text-secondary);
}

/* Nav-light selector popover: vertical list of clickable options, overriding
   the default 2-column key/value popover grid. */
.chip-wrapper:hover > .chip-popover.navlight-popover,
.chip-wrapper.active > .chip-popover.navlight-popover {
  display: flex; flex-direction: column; gap: 2px; padding: 0.3rem;
}
.navlight-option {
  display: flex; align-items: center; gap: 0.4rem;
  width: 100%; text-align: left; white-space: nowrap;
  padding: 0.3rem 0.6rem; border-radius: 4px;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-primary); font: inherit; font-size: 0.85rem;
}
.navlight-option:hover { background: var(--bg-secondary); }
.navlight-option.active { color: #3b82f6; font-weight: 600; }
.navlight-option:disabled { opacity: 0.5; cursor: default; }
.navlight-dot { font-size: 0.7rem; line-height: 1; }
.navlight-bright {
  display: flex; flex-direction: column; gap: 4px;
  padding: 0.45rem 0.6rem 0.25rem; margin-top: 2px;
  border-top: 1px solid var(--border-color);
}
.navlight-bright-label { font-size: 0.75rem; color: var(--text-secondary); }
.navlight-bright input[type="range"] { width: 100%; cursor: pointer; margin: 0; }
@keyframes chip-attention {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.75; }
}

/* Mission progress inline between primary + vitals */
.mission-inline {
  display: flex; align-items: center; gap: 0.5rem;
  flex: 1 1 220px; min-width: 0;
  padding: 0.25rem 0.7rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-family: "JetBrains Mono", monospace; font-size: 0.85rem;
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
.mission-counts { font-weight: 600; color: var(--text-primary); white-space: nowrap; }
.mission-eta { font-weight: 600; color: var(--text-secondary); white-space: nowrap; }

/* ── Body: rail + map + inspector ─────────────────── */
.workspace-body { flex: 1; display: flex; min-height: 0; }

.rail {
  width: 72px; flex-shrink: 0;
  display: flex; flex-direction: column;
  padding: 0.5rem 0; gap: 0.375rem;
  background: var(--bg-primary);
}
/* Mirrors inspector-handle width on the rail side. Visual only. */
.rail-spacer {
  width: 8px; flex-shrink: 0;
  background: var(--border-color);
}
/* Mirrors rail-spacer / inspector-handle widths so rail and inspector
   have equal whitespace on both sides. Desktop only. */
.edge-spacer {
  width: 8px; flex-shrink: 0;
}
.rail-divider {
  height: 1px; margin: 0.25rem 0.75rem;
  background: var(--border-color);
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
.map-wrap.map-suspended .map { visibility: hidden; }

.map-overlay {
  position: absolute; top: 1rem; left: 50%; transform: translateX(-50%);
  background: rgba(0,0,0,0.75); color: #fff; padding: 0.5rem 1.25rem;
  border-radius: 8px; font-size: 0.9rem; font-weight: 500; z-index: 500;
  pointer-events: none;
}
.map-overlay-row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  pointer-events: auto;
  max-width: calc(100vw - 2rem);
}
.map-overlay-row > span { white-space: nowrap; }
.map-overlay-row .btn { white-space: nowrap; }
.route-overlay { flex-wrap: wrap; justify-content: center; }
.route-overlay .measure-hint { white-space: normal; text-align: center; }

/* Floating map controls (courses tab). Two panels share this base look:
   the edit panel (bottom-right) and the tools panel (top-right). Theme-aware
   so the surface follows light/dark like the buttons it holds. */
.map-fab-panel {
  position: absolute; bottom: 1.5rem; right: 0.75rem; z-index: 500;
  display: flex; align-items: center; gap: 0.4rem;
  flex-wrap: wrap; justify-content: flex-end; max-width: calc(100vw - 1.5rem);
  background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
  backdrop-filter: blur(6px);
  padding: 0.4rem; border-radius: 10px;
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-hover);
  pointer-events: auto;
}
/* 영역 · 자 · 각도기 tools live in their own panel, pinned top-right. */
.map-fab-tools { top: 0.75rem; bottom: auto; }
.map-fab-panel .side-toggle { flex: none; gap: 0.25rem; }
/* Every control in the panels is the same square so a row reads as one set. */
.map-fab-panel .side-btn {
  flex: none; width: 38px; height: 38px; min-width: 0; padding: 0;
  border: 2px solid var(--border-color); border-radius: 8px;
  font-size: 1rem; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
.fab-icon-btn {
  flex: none; width: 38px; height: 38px;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid var(--border-color); border-radius: 8px;
  background: var(--bg-secondary); color: var(--text-primary);
  font-size: 1.1rem; line-height: 1; cursor: pointer; transition: all 0.15s;
}
.fab-icon-btn:disabled { opacity: 0.55; cursor: default; }
.fab-lock.locked {
  border-color: #f59e0b;
  background: color-mix(in srgb, #f59e0b 22%, var(--bg-secondary));
}
.fab-rover { border-color: var(--accent-primary); }
/* Cone-capture source: teal when the GPS receiver is active (preferred), purple
   when falling back to the rover. Disabled (grey) when neither is available. */
.fab-rover.src-receiver {
  border-color: #14b8a6;
  background: color-mix(in srgb, #14b8a6 22%, var(--bg-secondary));
}
.fab-rover.src-rover {
  border-color: #a855f7;
  background: color-mix(in srgb, #a855f7 22%, var(--bg-secondary));
}
.fab-tool.active {
  border-color: #38bdf8;
  background: color-mix(in srgb, #38bdf8 24%, var(--bg-secondary));
}
/* Standalone rotation button — bottom-left, on every tab (not in a panel). */
.map-fab-rotate {
  position: absolute; bottom: 1.5rem; left: 0.75rem; z-index: 500;
  box-shadow: var(--shadow-hover); pointer-events: auto;
  font-size: 1.3rem;
}
/* Bigger touch targets on coarse pointers, kept uniform across both panels. */
@media (any-pointer: coarse) {
  .map-fab-panel .fab-icon-btn,
  .map-fab-panel .side-btn,
  .map-fab-rotate { width: 44px; height: 44px; min-height: 0; }
}

/* Memo CHIP layer — geo-anchored map labels styled as a UI chip: pill shape,
   translucent plate, centred label text that reads over satellite imagery. Text
   scales with zoom (font-size from memoStyle) so it never clips. No window
   chrome — move (✜), delete (×) and the resize grip appear ONLY on hover/focus,
   so at rest it is just a clean centred chip. Chips are centred on their
   coordinate (translate) and sized in meters, so they pan/zoom/rotate with the
   course like cones. */
.memo-layer { position: absolute; inset: 0; z-index: 450; overflow: hidden; pointer-events: none; }
.memo-label {
  position: absolute; transform: translate(-50%, -50%);
  display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  min-width: 32px; min-height: 20px;
  background: rgba(17, 24, 39, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 999px;
  -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.memo-label:hover, .memo-label:focus-within {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 1px var(--accent-primary), 0 2px 8px rgba(0, 0, 0, 0.5);
}
/* Hover-bridge: the corner controls sit OUTSIDE the pill (negative offsets), so
   moving the cursor from the pill to a control crosses a gap and drops :hover,
   hiding the control before you reach it. This transparent halo (18px past every
   edge, past the 11px controls) is part of the label, so hovering it keeps the
   label hovered. It only captures pointer events WHILE hovered/focused, so at
   rest it never blocks the map; z-index keeps it behind the text and controls. */
.memo-label::after {
  content: ""; position: absolute; inset: -18px; z-index: -1; pointer-events: none;
}
.memo-label:hover::after, .memo-label:focus-within::after { pointer-events: auto; }
.memo-text {
  flex: 1; width: 100%; min-width: 0; box-sizing: border-box;
  border: none; outline: none; background: transparent;
  color: #fff; font-family: inherit; font-weight: 600; line-height: 1.1;
  padding: 4px 12px; cursor: text; text-align: center;
  text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
  /* font-size is set inline by memoStyle so it scales with zoom */
}
.memo-text::placeholder { color: rgba(255, 255, 255, 0.6); font-weight: 400; }
/* Floating controls — hidden (and non-interactive) until hover/focus. */
.memo-move, .memo-del, .memo-rotate, .memo-resize {
  position: absolute; opacity: 0; pointer-events: none; transition: opacity 0.12s ease; z-index: 1;
}
.memo-label:hover .memo-move, .memo-label:hover .memo-del, .memo-label:hover .memo-rotate, .memo-label:hover .memo-resize,
.memo-label:focus-within .memo-move, .memo-label:focus-within .memo-del, .memo-label:focus-within .memo-rotate, .memo-label:focus-within .memo-resize {
  opacity: 1; pointer-events: auto;
}
.memo-move {
  top: -11px; left: -11px; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-primary); color: #fff; font-size: 13px; line-height: 1;
  cursor: move; touch-action: none; user-select: none; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
.memo-del {
  top: -11px; right: -11px; width: 22px; height: 22px; border-radius: 50%; padding: 0; border: none;
  display: flex; align-items: center; justify-content: center;
  background: #ef4444; color: #fff; font-size: 15px; line-height: 1;
  cursor: pointer; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
.memo-rotate {
  bottom: -11px; left: -11px; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-primary); color: #fff; font-size: 13px; line-height: 1;
  cursor: grab; touch-action: none; user-select: none; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
.memo-resize {
  right: -11px; bottom: -11px; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-primary); color: #fff;
  cursor: nwse-resize; touch-action: none; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
/* SVG glyphs render crisp and perfectly centred by the flex box (no font-glyph
   baseline drift like the old ✜/↻/× text icons). */
.memo-move svg, .memo-del svg, .memo-rotate svg, .memo-resize svg {
  display: block; width: 13px; height: 13px;
}

/* Live rotation angle readout — pinned top-centre of the map while rotating. */
.rotate-hud {
  position: absolute; top: 1rem; left: 50%; transform: translateX(-50%);
  display: flex; align-items: baseline; gap: 0.5rem; z-index: 600;
  background: rgba(8, 15, 30, 0.88); border: 1px solid #38bdf8; border-radius: 10px;
  padding: 0.4rem 0.9rem; pointer-events: none;
  font-variant-numeric: tabular-nums;
}
.rotate-hud-icon { font-size: 1.1rem; color: #38bdf8; }
.rotate-hud-val { font-size: 1.6rem; font-weight: 700; color: #fff; }
.rotate-hud-hint { font-size: 0.72rem; color: var(--text-secondary); }
.rotate-controls { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.5rem; }
.rotate-controls label { font-size: 0.78rem; color: var(--text-secondary); white-space: nowrap; }
.rotate-controls input { flex: 1; min-width: 0; }

/* Measurement tool overlay (distance / angle), top-centre of the map. */
.measure-overlay { top: 1rem; }
.measure-tool-name { font-weight: 700; white-space: nowrap; }
.measure-hint { color: #cbd5e1; font-size: 0.82rem; }
.measure-result { font-weight: 700; color: #22d3ee; font-variant-numeric: tabular-nums; white-space: nowrap; }

.coord-popover-body {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.8rem;
  white-space: nowrap;
}

.gps-block .gps-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.375rem 0.75rem;
  font-family: "JetBrains Mono", monospace;
}
.gps-cell {
  display: flex; align-items: baseline; gap: 0.5rem;
  min-width: 0;
}
.gps-label {
  font-size: 0.7rem; font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
  flex: 0 0 auto;
}
.gps-val {
  font-size: 0.85rem; font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  display: inline-flex; align-items: center; gap: 0.25rem;
}
.compass-arrow {
  display: inline-block;
  width: 1em;
  text-align: center;
  transition: transform 0.2s ease, opacity 0.2s ease;
  color: var(--accent-primary);
}

.manual-btn-row {
  width: 100%;
  display: block;
}

.inspector-handle {
  width: 8px; flex-shrink: 0;
  background: var(--border-color);
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
  border-bottom: 1px solid var(--border-color);
}
.tab-header h3 { margin: 0; font-size: 1rem; font-weight: 700; }
.tab-header-sub h3 .centerline-len { font-weight: 400; font-size: 0.85em; color: var(--text-secondary); }
.tab-header-sub h3 .lock-badge { margin-left: 0.3rem; font-size: 0.85em; opacity: 0.85; }
.tab-header-sub {
  margin-top: 0.875rem;
  border-top: 1px solid var(--border-color);
  padding-top: 0.625rem;
  border-bottom: 1px solid var(--border-color);
}
.history-switcher {
  display: inline-flex;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}
.history-switch-btn {
  padding: 0.25rem 0.625rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  border: 0;
  font-size: 0.8rem;
  cursor: pointer;
}
.history-switch-btn + .history-switch-btn { border-left: 1px solid var(--border-color); }
.history-switch-btn.active {
  background: var(--accent-primary);
  color: var(--accent-primary-fg, #fff);
  font-weight: 600;
}
.history-switch-btn:hover:not(.active) { background: var(--bg-secondary); color: var(--text-primary); }

.inspector-group {
  padding: 0.625rem 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.inspector-group.selected {
  background: color-mix(in srgb, var(--accent-primary) 7%, var(--bg-primary));
  border-color: var(--accent-primary);
}
.route-editor-heading,
.route-editor-actions,
.route-marker-row,
.route-step-row {
  display: flex; align-items: center; gap: 0.35rem;
}
.route-editor-heading { justify-content: space-between; }
.route-mode-badge {
  border-radius: 999px; padding: 0.1rem 0.45rem;
  background: var(--bg-primary); color: var(--text-secondary);
  font-size: 0.68rem; font-weight: 700;
}
.route-mode-badge.guided { background: rgba(16, 185, 129, 0.18); color: #10b981; }
.route-mode-badge.oriented { background: rgba(59, 130, 246, 0.18); color: #3b82f6; }
.route-error {
  margin: 0; padding: 0.4rem 0.5rem; border-radius: 5px;
  background: rgba(239, 68, 68, 0.12); color: #ef4444;
  font-size: 0.75rem; line-height: 1.35;
}
.route-marker-list,
.route-step-list { display: flex; flex-direction: column; gap: 0.25rem; }
.route-step-list {
  max-height: 13rem; overflow-y: auto; padding-top: 0.4rem;
  border-top: 1px solid var(--border-color);
}
.route-marker-index,
.route-step-rank {
  flex: 0 0 2rem; color: #10b981; font: 700 0.72rem/1 "JetBrains Mono", monospace;
}
.route-marker-row input {
  min-width: 0; flex: 1; padding: 0.3rem 0.4rem;
  border: 1px solid var(--border-color); border-radius: 4px;
  background: var(--bg-primary); color: var(--text-primary); font-size: 0.76rem;
}
.route-icon-action { min-width: 2rem; padding: 0.2rem; }
.route-step-name {
  min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 0.75rem; color: var(--text-primary);
}
.route-step-action {
  width: 1.7rem; height: 1.7rem; padding: 0; border: 0; border-radius: 4px;
  background: var(--bg-primary); color: var(--text-secondary); cursor: pointer;
}
.route-step-action.danger { color: #ef4444; }
.route-step-action:disabled { opacity: 0.35; cursor: default; }
.route-editor-actions { justify-content: flex-end; flex-wrap: wrap; }
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

/* Icon-only action button: square tap target, no text padding. */
.btn-icon-only { padding: 0.5rem; min-width: 44px; flex-shrink: 0; }

/* Course list */
.course-add { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }

.course-add input {
  flex: 1; min-width: 0; padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-color); border-radius: 4px;
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
  display: inline-flex; align-items: center; justify-content: center;
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

/* Side toggle (L/C/R) */
.side-toggle { display: flex; gap: 0.25rem; flex: 1; }

.side-btn {
  flex: 1; padding: 0.375rem;
  border: 2px solid var(--border-color); border-radius: 6px;
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
.obstacle-alert {
  margin: 0.5rem 0;
  padding: 0.6rem 0.75rem;
  border: 2px solid #ef4444;
  border-radius: 6px;
  background: color-mix(in srgb, #ef4444 14%, var(--bg-secondary));
  color: var(--text-primary);
}
.obstacle-alert-title { font-weight: 700; font-size: 0.9rem; }
.obstacle-alert-hint { margin-top: 0.25rem; font-size: 0.82rem; color: var(--text-secondary); }
.camera-view {
  margin-top: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  background: #000;
  min-height: 80px;
  position: relative;
}
/* Video always fills a 16:9 box (sized even with no frames yet, so the container
   doesn't collapse); the MJPEG fallback overlays it until WebRTC is playing. */
.camera-view video { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #000; }
.camera-view img.camera-fallback { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
/* Overlay (absolute), NOT normal-flow: a normal-flow block would add its own
   height to .camera-view, making the container taller than the video's 16:9 box —
   the absolute MJPEG <img> (object-fit:contain) would then letterbox top/bottom
   inside the taller box. Absolute inset:0 keeps the container at the video's
   height, so no phantom bars whether or not this notice is shown. */
.camera-error {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-align: center;
}
.rover-controls-grid {
  /* minmax(0, 1fr) keeps all three columns equal even when a label is wide,
     instead of a long button stretching its column and breaking the row. */
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem;
}
.rover-controls-grid .btn { width: 100%; }

/* Depth-map mode fill: a distinct violet so the camera button visibly changes
   when cycling plain 2D (blue btn-primary) → depth overlay. */
.camera-btn-depth {
  background: #7c3aed;
  color: #fff;
  border-color: #7c3aed;
}
.camera-btn-depth:hover:not(:disabled) {
  background: #8b5cf6;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(124, 58, 237, 0.4);
}

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
  border: 1px solid var(--border-color);
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
  border: 1px solid var(--border-color); border-radius: 6px;
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
  border: 1px solid var(--border-color); border-radius: 10px;
  padding: 1rem 1.25rem; min-width: 320px; max-width: 440px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.preflight-modal h3 { margin: 0 0 0.75rem 0; }
.preflight-modal .resume-selector { margin-top: 0; margin-bottom: 0.75rem; }
.preflight-list { list-style: none; padding: 0; margin: 0 0 0.75rem 0; }
.preflight-item {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.25rem; border-bottom: 1px solid var(--border-color);
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
  border-top: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
}

.logs-modal { max-width: 800px; width: 90vw; max-height: 85vh; display: flex; flex-direction: column; }
.logs-toolbar {
  display: flex; align-items: center; gap: 0.5rem;
  margin-bottom: 0.5rem; flex-wrap: wrap;
}
.logs-meta { font-size: 0.75rem; color: var(--text-secondary); margin-left: auto; }
.logs-view {
  flex: 1; overflow-y: auto;
  background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px;
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
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 30%, transparent);
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
  border: 1px solid var(--border-color); border-radius: 6px;
}
.snapshot-list { flex: 1; overflow-y: auto; margin-bottom: 0.75rem; }
.snapshot-item {
  padding: 0.5rem; border-bottom: 1px solid var(--border-color);
  font-size: 0.85rem;
}
.snapshot-top { display: flex; justify-content: space-between; align-items: center; }
.snapshot-time { font-family: "JetBrains Mono", monospace; color: var(--text-primary); }
.snapshot-count { color: var(--text-secondary); font-size: 0.8rem; }
.snapshot-reason { color: var(--text-secondary); font-size: 0.8rem; margin-top: 0.15rem; }
.snapshot-actor { color: var(--text-secondary); font-size: 0.75rem; margin-top: 0.15rem; }
.snapshot-actions { margin-top: 0.3rem; display: flex; justify-content: flex-end; gap: 0.4rem; }
.snapshot-delete { color: #ef4444; }

.waypoint-list {
  margin-top: 0.5rem; max-height: 250px; overflow-y: auto;
  border: 1px solid var(--border-color); border-radius: 6px;
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
  padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--border-color);
  font-size: 0.8rem;
}
.waypoint-item:last-child { border-bottom: none; }
.waypoint-num { font-family: "JetBrains Mono", monospace; font-weight: 600; min-width: 2em; }
.waypoint-coord { flex: 1; font-family: "JetBrains Mono", monospace; color: var(--text-secondary); font-size: 0.75rem; }
.waypoint-arrows { display: flex; gap: 0.15rem; }
.arrow-btn {
  width: 22px; height: 22px; padding: 0;
  background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 4px;
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
  border: 1px solid var(--border-color); border-radius: 6px;
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
  border: 2px solid var(--border-color);
  display: flex; align-items: center; justify-content: center;
}

.joystick-crosshair {
  width: 1px; height: 100%; background: var(--border-color);
  position: absolute;
}
.joystick-crosshair::after {
  content: ""; display: block;
  width: 100%; height: 1px; background: var(--border-color);
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

.pump-control {
  display: flex; justify-content: center;
  margin-top: 0.75rem;
}
.pump-btn {
  flex: 1; max-width: 160px;
  padding: 0.5rem 0.8rem;
  border: 1px solid var(--border-color); border-radius: 4px;
  background: var(--bg-secondary); color: var(--text-primary);
  font-size: 0.85rem; font-weight: 600; letter-spacing: 0.02em; cursor: pointer;
}
.pump-btn:hover:not(:disabled) { background: var(--bg-tertiary); }
.pump-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pump-btn.active {
  background: #2e7d32; border-color: #2e7d32; color: #fff;
}
/* Keep the ON (active) green while hovered — the generic :hover:not(:disabled)
   above is more specific than .active, so without this the background reverts to
   the inactive hover colour right after clicking (looks off while still on). */
.pump-btn.active:hover:not(:disabled) { background: #388e3c; border-color: #388e3c; }

/* Cone edit */
.coord-inputs { display: flex; flex-direction: column; gap: 0.5rem; }

.coord-inputs input, .coord-inputs select {
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-color); border-radius: 4px;
  background: var(--bg-secondary); color: var(--text-primary);
  font-size: 0.8rem; font-family: "JetBrains Mono", monospace;
}
.coord-inputs input:focus, .coord-inputs select:focus { outline: none; border-color: var(--accent-primary); }

.edit-buttons { display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: center; }
.multi-select-hint { font-size: 0.8rem; color: var(--text-secondary); flex: 1; margin: 0 0 0.4rem; }
.multi-select-hint.locked-note { color: #f59e0b; font-weight: 600; }
.edit-section { background: color-mix(in srgb, var(--accent-primary) 5%, var(--bg-primary)); }

/* Cone list */
.cone-list-section { position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

/* One-tap jump to the top of a long cone list. */
.cone-scrolltop {
  position: absolute; right: 0.7rem; bottom: 1rem; z-index: 5;
  width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-color);
  background: rgba(17, 24, 39, 0.9); color: var(--text-primary);
  font-size: 1.1rem; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.cone-scrolltop:hover { background: rgba(31, 41, 55, 0.95); }


.cone-list-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem; }
.cone-list-header h3 { margin: 0; }

.cone-filter { display: flex; gap: 0.25rem; }

.filter-btn {
  padding: 0.3rem 0.6rem; border: 1px solid var(--border-color);
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
/* Full-width destructive action pinned below the cone list. */
.cone-delete-all { width: 100%; margin-top: 0.5rem; flex: none; }

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

.cone-alt {
  flex-shrink: 0; font-family: "JetBrains Mono", monospace;
  font-size: 0.75rem; color: var(--text-secondary);
}

.cone-alt-readout {
  margin-top: 0.4rem; font-family: "JetBrains Mono", monospace;
  font-size: 0.8rem; color: var(--text-secondary);
}

.empty-msg { text-align: center; padding: 1rem 0; color: var(--text-secondary); font-size: 0.85rem; }
.empty-msg.large { padding: 2rem 0; font-size: 0.95rem; display: flex; flex-direction: column; align-items: center; gap: 0.75rem; }

/* ── GPS 관리 탭 ─────────────────────────────────────────── */
.gps-status-row { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; flex-wrap: wrap; }
/* Inline key/value grid mirroring the fix-chip popover (.chip-popover active state). */
.gps-detail {
  display: grid; grid-template-columns: max-content 1fr;
  column-gap: 0.85rem; row-gap: 0.18rem; align-items: baseline;
  margin-top: 0.5rem;
}
.gps-track-btn { width: 100%; margin-top: 0.6rem; }
.gps-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.gps-dot.on { background: #22c55e; }
.gps-dot.off { background: var(--border-color); }
.gps-sub { color: var(--text-secondary); font-size: 0.82rem; }
.gps-hint { margin-top: 0.4rem; }
.gps-alert {
  margin-bottom: 0.6rem; padding: 0.5rem 0.6rem; border-radius: 8px;
  font-size: 0.82rem; line-height: 1.35;
  border: 1px solid #ef4444;
  background: color-mix(in srgb, #ef4444 14%, var(--bg-secondary));
  color: var(--text-primary);
}
.gps-source-choices { display: flex; flex-direction: column; gap: 0.5rem; }
.gps-source-opt {
  display: flex; align-items: flex-start; gap: 0.55rem;
  padding: 0.6rem; border: 1px solid var(--border-color); border-radius: 8px; cursor: pointer;
}
.gps-source-opt.active { border-color: #14b8a6; background: color-mix(in srgb, #14b8a6 12%, var(--bg-secondary)); }
.gps-source-opt.disabled { opacity: 0.55; cursor: not-allowed; }
.gps-source-opt input { margin-top: 0.2rem; }
.gps-base-select { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.6rem; }
.gps-add-row { display: flex; gap: 0.5rem; }
/* Match the course-add input styling; min-width:0 lets flex items shrink so a
   long placeholder doesn't push the row past the inspector panel edge. */
.gps-add-row input,
.gps-base-select select {
  flex: 1; min-width: 0; padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-color); border-radius: 4px;
  background: var(--bg-secondary); color: var(--text-primary); font-size: 0.8rem;
}
.gps-add-row input:focus,
.gps-base-select select:focus { outline: none; border-color: var(--accent-primary); }
.gps-point-list { display: flex; flex-direction: column; gap: 0.5rem; }
.gps-point-card {
  padding: 0.55rem 0.65rem; border: 1px solid var(--border-color); border-radius: 8px;
  background: var(--bg-secondary); display: flex; flex-direction: column; gap: 0.4rem;
}
.gps-point-card.is-base { border-color: #14b8a6; background: color-mix(in srgb, #14b8a6 8%, var(--bg-secondary)); }
/* surveyed cards center the map on tap; ring the tapped one (layered over the
   base tint via box-shadow so a base+selected card shows both cues) */
.gps-point-card.clickable { cursor: pointer; transition: border-color 0.1s, box-shadow 0.1s; }
.gps-point-card.clickable:hover { border-color: var(--accent-primary); }
.gps-point-card.selected { border-color: var(--accent-primary); box-shadow: 0 0 0 1px var(--accent-primary); }
.gps-point-head { display: flex; align-items: center; gap: 0.4rem; }
.gps-point-name { font-size: 0.9rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* status tag pushed to the right of the name */
.gps-tag {
  margin-left: auto; flex: none; font-size: 0.68rem; font-weight: 700;
  padding: 0.1rem 0.45rem; border-radius: 999px; letter-spacing: 0.02em;
}
.gps-tag-base { background: color-mix(in srgb, #14b8a6 26%, var(--bg-secondary)); color: #14b8a6; }
.gps-tag-ok { background: color-mix(in srgb, #22c55e 18%, var(--bg-secondary)); color: #22c55e; }
.gps-tag-warn { background: color-mix(in srgb, #f59e0b 18%, var(--bg-secondary)); color: #f59e0b; }
.gps-point-coord { display: flex; flex-direction: column; gap: 0.1rem; }
.gps-point-latlng { font-family: "JetBrains Mono", monospace; font-size: 0.8rem; }
/* survey progress + live status */
.gps-survey-live { display: flex; flex-direction: column; gap: 0.3rem; }
.gps-survey-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.78rem; }
.gps-surveying { color: #14b8a6; font-weight: 700; font-size: 0.8rem; }
.gps-progress { height: 5px; border-radius: 999px; background: var(--border-color); overflow: hidden; }
.gps-progress-bar { height: 100%; background: #14b8a6; border-radius: 999px; transition: width 0.4s linear; }
/* actions: extra separation from the content above, delete/cancel to the right */
.gps-point-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.4rem; }
.gps-point-actions .gps-btn-danger { margin-left: auto; }

/* ── Mobile: rail → bottom tab bar, inspector → bottom drawer ────────── */
@media (max-width: 768px) {
  .map-layout { padding: 0; }
  .content { border-radius: 0; border: none; }

  /* Chips scroll horizontally (up to the pinned fullscreen button); popovers go
     position: fixed (see toggleChipPopover) since overflow-x: auto clips them. */
  .status-strip { padding: 0.75rem; }
  .status-strip-chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: visible;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .status-strip-chips::-webkit-scrollbar { display: none; }
  .chip-row { flex-wrap: nowrap; flex: 0 0 auto; }
  .mission-wrapper { flex: 0 0 auto; }
  .mission-inline { flex: 0 0 auto; min-width: 180px; }
  .chip { padding: 0.2rem 0.6rem; font-size: 0.8rem; }
  .mission-inline { padding: 0.2rem 0.6rem; font-size: 0.8rem; }

  .workspace-body {
    flex-direction: column;
    position: relative;
    min-height: 0;
  }

  .rail {
    /* Pinned to visual viewport so address-bar reflow never hides it. */
    position: fixed;
    left: 0; right: 0; bottom: 0;
    width: 100%;
    flex-direction: row;
    border-top: 1px solid var(--border-color);
    padding: 0.25rem 0.5rem; gap: 0.25rem;
    justify-content: space-around;
    background: var(--bg-primary);
    z-index: 700;
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

  /* Keep the top-right tools in a single horizontal row on mobile (they were
     stacked vertically before). Drop the centred active-tool overlay / rotation
     HUD below the tool row so they don't collide on narrow screens. */
  /* Overflow must run off the END of the row: with the panel's flex-end packing
     the extra buttons pile up past the start edge, where horizontal scrolling
     cannot reach them (a 375 px phone fits six 44 px buttons, no more). */
  .map-fab-tools { flex-direction: row; flex-wrap: nowrap; overflow-x: auto; justify-content: flex-start; }
  .measure-overlay, .rotate-hud { top: 4.5rem; }

  .inspector-handle { display: none; }

  /* Pinned to visual viewport (same as rail) so address-bar reflow
     can't shift the drawer off-screen. */
  .inspector {
    position: fixed !important;
    left: 0; right: 0;
    bottom: calc(60px + env(safe-area-inset-bottom));
    width: 100% !important;
    max-width: 100%; min-width: 0;
    max-height: 75vh;
    border-top: 1px solid var(--border-color);
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
    padding: 0.6rem 1rem;
    cursor: pointer; flex-shrink: 0;
    touch-action: none;
  }
  .handle-bar {
    width: 56px; height: 6px; border-radius: 3px;
    background: var(--text-secondary); opacity: 0.5;
  }

  .tab-pane { padding: 0.4rem 0.875rem 0.6rem; }
  .joystick-area { display: flex; flex-direction: column; align-items: center; }
  .joystick { max-width: 220px; width: 100%; }

  .preflight-modal, .logs-modal, .snapshots-modal {
    width: calc(100vw - 1.5rem); max-width: calc(100vw - 1.5rem);
    max-height: calc(100dvh - 2rem);
  }

  /* Mobile log viewer: stack rows so messages wrap instead of being clipped. */
  .logs-view:not(.logs-view-inline) .log-row {
    display: flex; flex-wrap: wrap;
    column-gap: 0.5rem; row-gap: 0.05rem;
    padding: 0.2rem 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border-color) 30%, transparent);
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

  .chip-popover { font-size: 0.9rem; min-width: 200px; max-width: calc(100vw - 2rem); }
}

@media (min-width: 769px) {
  .sheet-handle { display: none; }
}
</style>

<style>
.route-marker-host { background: transparent; border: 0; }
.route-marker-pin {
  width: 30px; height: 30px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #fff; border-radius: 50%;
  background: #64748b; color: #fff;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.55);
  font: 700 9px/1 "JetBrains Mono", ui-monospace, monospace;
}
.route-marker-pin.has-visits { background: #10b981; }
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

/* Surveyed base-station point markers (L.divIcon, outside scoped styles). Magenta
   diamond — deliberately unlike the cyan right-side cone the operator flagged as
   too similar; amber ring = active base, sky-blue ring = selected in the list. */
.survey-marker {
  width: 14px; height: 14px; box-sizing: border-box; cursor: pointer;
  background: #ec4899; border: 2px solid #fff; transform: rotate(45deg);
  box-shadow: 0 1px 4px rgba(0,0,0,0.5);
}
.survey-marker.is-base {
  width: 18px; height: 18px;
  box-shadow: 0 0 0 3px rgba(245,158,11,0.9), 0 1px 4px rgba(0,0,0,0.5);
}
.survey-marker.selected {
  box-shadow: 0 0 0 3px #38bdf8, 0 1px 4px rgba(0,0,0,0.5);
}
.survey-tooltip {
  background: #be185d; color: #fff; border: none;
  font-size: 11px; font-weight: 600; padding: 2px 6px;
  border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.survey-tooltip::before { border-top-color: #be185d; }

/* Rotation handle/pivot + measurement overlays are drawn into Leaflet's DOM via
   L.divIcon, so they live outside the component's scoped styles. */
.rotate-pivot {
  width: 14px; height: 14px; border-radius: 50%; box-sizing: border-box;
  border: 2px solid #38bdf8; background: rgba(56, 189, 248, 0.35);
}
.rotate-handle {
  width: 32px; height: 32px; border-radius: 50%; box-sizing: border-box;
  border: 2px solid #38bdf8; background: #0b1220; color: #38bdf8;
  display: flex; align-items: center; justify-content: center;
  font-size: 17px; line-height: 1; cursor: grab;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
}
.rotate-handle:active { cursor: grabbing; }
.measure-dot {
  width: 12px; height: 12px; border-radius: 50%; box-sizing: border-box;
  background: #fff; border: 2px solid #0ea5e9; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}
.measure-label {
  position: absolute; transform: translate(-50%, -50%); white-space: nowrap;
  background: rgba(8, 15, 30, 0.92); color: #e2e8f0;
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px;
  padding: 1px 6px; font: 600 12px/1.3 "JetBrains Mono", ui-monospace, monospace;
}
.measure-label.angle { color: #fbbf24; border-color: #f59e0b; }

/* In select mode the map is pinned; stop the browser from scrolling/zooming the
   page so a touch drag draws a selection box instead. */
.select-mode-active { touch-action: none !important; }
</style>
