<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch, inject } from "vue";
import L from "leaflet";
import { request } from "../api.js";
import { useNotification } from "@shared/useNotification.js";
import { haversine } from "@lib/geo.mjs";
import { computeCenterline } from "@lib/centerline.mjs";
import { buildRoadEdges } from "@lib/road-edges.mjs";
import { buildTrackModel } from "@lib/track-build.mjs";
import { packTrackEntries, safeTrackName } from "@lib/pack-track.mjs";
import { buildEnrichedJSON } from "@lib/course-export.mjs";
import { renderTwoPanelPNG } from "../export/panel-canvas.js";
import JSZip from "jszip";
import { isAdmin } from "@shared/officialsStore.js";

const { error: notifyError, warning: notifyWarn } = useNotification();
const stopping = inject("stopping", ref(false));
const sseReconnecting = inject("sseReconnecting", ref(false));
const appRoverConnected = inject("roverConnected", null);
const appNavState = inject("navState", null);

/* ── State ─────────────────────────────────────────── */
const courses = ref([]);
const conesMap = ref({});
const memosMap = ref({}); // 코스별 메모 스티커: courseId → memo[] { id, course_id, lat, lng, width, height, content }
// 지도가 움직일 때마다 올려서 지리 좌표 고정 메모의 화면 위치·크기를 재계산시키는 트리거.
const mapFrame = ref(0);
const visibility = ref(loadPref("visibility", {}, (v) => JSON.parse(v))); // per-course show/hide, persisted
const activeCourseId = ref(null);
const loading = ref(true);
const newCourseName = ref("");
const importInput = ref(null);
const currentSide = ref("left");
const roverLoading = ref(false);
const editLocked = ref(loadPref("editLocked", true, (v) => v === "true")); // default locked; screen tap/drag can't add/move/rotate/delete cones; persisted
const showCenterline = ref(loadPref("showCenterline", true, (v) => v === "true")); // course centerline graphic; default on; persisted
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
// Rotate-selection state: a draggable on-map handle spins the whole selection
// around its centroid; rotateAngle is the live delta shown in the HUD (deg, CW+).
const rotateMode = ref(false);
const rotateAngle = ref(0);
const rotateInput = ref(""); // exact-angle text entry (deg, clockwise positive)
const rotateAngleAbs = computed(() => Math.abs(rotateAngle.value).toFixed(1));
const rotateDirIcon = computed(() => (rotateAngle.value < 0 ? "↺" : "↻"));
// Measurement tools — read-only, usable even when edit is locked.
const toolMode = ref("none");   // none | ruler | protractor
const measureHint = ref("");    // next-step instruction for the active tool
const measureResult = ref("");  // distance total / measured angle for the overlay
// Box-select mode — drag-to-select that also works on touch (no Shift key needed).
const selectMode = ref(false);
// Undo stack of {label, undo} entries; each `undo` reverses one edit via the API.
const undoStack = ref([]);
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
// Joystick DOM refs: the knob + readout are updated imperatively while dragging
// so a pointermove (≈120Hz on mobile) doesn't re-render this whole component.
const joystickKnobEl = ref(null);
const joystickInfoEl = ref(null);
const dispenserBusy = ref(false);

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
  sse_closed: "SSE LOST",
  write_failed: "SSE PUSH FAILED",
  replaced: "SESSION REPLACED",
};

const BATTERY_WARN_PERCENT = 30;
const BATTERY_CRIT_PERCENT = 20;

// Tick ref — bumps every second so time-ago computeds recalc even when no
// new SSE event arrives (otherwise "pos 0s" stays stale when the rover stops).
const uiTick = ref(0);
let uiTickInterval = null;

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
  if (secs < 60) return `~${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s === 0 ? `~${m}m` : `~${m}m ${s}s`;
}

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
// Fix-status tone. RTK is ok/warn, plain 3D is warn (no corrections),
// 2D / time-only / no-fix are all bad. Dead-reckoning variants are folded
// into no_fix at the rover, so they don't appear here.
const FIX_STATUS_META = {
  rtk_fixed: { tone: "ok" },
  rtk_float: { tone: "warn" },
  "3d_fix": { tone: "warn" },
  "2d_fix": { tone: "bad" },
  time_only: { tone: "bad" },
  no_fix: { tone: "bad" },
};

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
  if (!hasFix) rows.push(["GPS", "신호 없음", "bad"]);
  if (s.last_position?.lat != null && s.last_position?.lng != null) {
    rows.push(["POS", `${s.last_position.lat.toFixed(6)}, ${s.last_position.lng.toFixed(6)}`]);
  }
  if (s.gps?.altitude != null) rows.push(["ALT", `${s.gps.altitude.toFixed(2)} m`]);
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

// MCU status-flag bits (rover/mcu T-frame `flags`, see rover README).
// The MCU status LED encodes these by colour (red=e-stop, magenta=undervolt,
// yellow=heartbeat/batt-warn, orange=nav-GPS-lost); the chip only said
// "ERROR", so we decode them into a plain-English cause list.
const MCU_FLAG = {
  ESTOP: 0x01,        // combined sw+hw E-stop latch
  HEARTBEAT: 0x02,    // Pi↔MCU heartbeat timeout (motors gated)
  UNDERVOLT: 0x04,    // battery ≤20 V (motors gated)
  BATT_WARN: 0x08,    // battery ≤22 V
  NAV_GPS_LOST: 0x40, // Pi-reported navigation GPS loss
  ESTOP_LINE: 0x80,   // raw physical E-stop button line
};

// Short, bullet-style English explanations for why the rover is in ERROR /
// EMERGENCY_STOP, decoded from MCU flags + GPS/NTRIP/battery state. Each row is
// [key, phrase, tone]; keys are unique so they survive the popover v-for :key.
function roverFaultRows(s) {
  const rows = [];
  const flags = Number.isInteger(s.battery?.flags) ? s.battery.flags : 0;
  const estop = s.nav_state === "EMERGENCY_STOP";

  // E-stop (LED: red blink).
  if (estop || (flags & MCU_FLAG.ESTOP)) {
    rows.push((flags & MCU_FLAG.ESTOP_LINE)
      ? ["E-STOP", "Hardware E-stop button pressed", "bad"]
      : ["E-STOP", "Software E-stop (operator or server)", "bad"]);
  }
  // Pi↔MCU link (LED: yellow).
  if (flags & MCU_FLAG.HEARTBEAT) {
    rows.push(["LINK", "Pi↔MCU heartbeat timeout — motors gated", "bad"]);
  }
  // Battery (LED: magenta = undervolt, yellow = warn).
  if (flags & MCU_FLAG.UNDERVOLT) {
    rows.push(["BATTERY", "Undervolt cutoff (≤20 V) — motors gated", "bad"]);
  } else if (flags & MCU_FLAG.BATT_WARN) {
    rows.push(["BATTERY", "Low-battery warning (≤22 V)", "warn"]);
  } else if (s.battery?.percent != null && s.battery.percent <= BATTERY_CRIT_PERCENT) {
    rows.push(["BATTERY", `Battery critically low (${s.battery.percent}%)`, "bad"]);
  }
  // Navigation GPS loss (LED: orange blink). Infer from fix status too, since
  // the navigator can raise ERROR Pi-side before the MCU bit propagates.
  const fixBad = s.fix_status && s.fix_status !== "rtk_fixed";
  if ((flags & MCU_FLAG.NAV_GPS_LOST) || (s.nav_state === "ERROR" && fixBad)) {
    const fixLabel = s.fix_status ? s.fix_status.replace(/_/g, " ").toUpperCase() : "UNKNOWN";
    rows.push(["GPS", `RTK fix lost (now ${fixLabel}); holds until rtk_fixed`, "bad"]);
  }
  // NTRIP corrections offline — the usual root cause of an RTK-fix drop.
  if (s.ntrip_connected === false) {
    const err = s.ntrip?.last_error ? `: ${s.ntrip.last_error}` : "";
    rows.push(["NTRIP", `RTK corrections offline${err}`, "bad"]);
  }
  // Never leave a fault popover empty.
  if (rows.length === 0 && (s.nav_state === "ERROR" || estop)) {
    rows.push(["CAUSE", "Cause unclear — check rover logs", "warn"]);
  }
  return rows;
}

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
  if (roverStatus.value.gps?.speed != null) lines.push(`현재 속도: ${roverStatus.value.gps.speed.toFixed(2)} m/s`);
  return {
    current: executedIndex.value,
    total: pathWaypoints.value.length,
    percent: pathProgress.value,
    eta: missionETA.value,
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

// Cone draggability is gated on the courses tab — rebuild markers when
// crossing that boundary. Skip missions transitions; isMissionsView owns those.
watch(activeTab, (next, prev) => {
  if (!map) return;
  // Leaving the editing tab tears down its rotate/measure/select overlays.
  if (prev === "courses" && next !== "courses") {
    if (rotateMode.value) exitRotateMode();
    if (toolMode.value !== "none") exitToolMode();
    selectMode.value = false;
  }
  const prevWasMissions = prev === "history" && historyView.value === "missions";
  const nextIsMissions = next === "history" && historyView.value === "missions";
  if (prevWasMissions || nextIsMissions) return;
  if ((next === "courses") !== (prev === "courses")) rebuildAllMarkers();
});
watch(inspectorWidth, (v) => savePref("inspectorWidth", v));

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

// Measurement tools (ruler / protractor) overlays.
let measureLayer = null;         // L.layerGroup holding the active tool's overlays
let measurePoints = [];          // [L.latLng] taps collected for the active tool

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

const SIDE_COLORS = { left: "#f59e0b", right: "#06b6d4", center: "#ef4444" };

/* ── Computed ──────────────────────────────────────── */
const activeCourse = computed(() => courses.value.find((c) => c.id === activeCourseId.value));

const pathBtnLabel = computed(() => {
  // 글로벌 비상정지 래치가 잡혀 있는 동안에는 모든 미션 버튼이 정지 명령이
  // 텔레메트리로 확인될 때까지 같은 상태로 보여야 운영자가 두 버튼을 보고
  // 모순된 단계로 오해하지 않는다.
  if (stopping.value && (roverMode.value === "executing" || roverMode.value === "stopped")) {
    return "정지 요청 중...";
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

// 메모는 활성 코스의 것만, 그 코스가 표시 상태일 때만 지도에 그린다.
const activeMemos = computed(() => {
  const id = activeCourseId.value;
  if (!id || visibility.value[id] === false) return [];
  return memosMap.value[id] || [];
});

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
  return {
    left: `${pt.x}px`,
    top: `${pt.y}px`,
    width: `${m.width / mpp}px`,
    height: `${m.height / mpp}px`,
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
  centerline.value = cones.length >= 6
    ? computeCenterline(cones, { step: 1.0, ...courseDirOpts(activeCourseId.value, cones) })
    : null;
  drawCenterline();
}
function drawCenterline() {
  if (centerlineLayer) { try { map.removeLayer(centerlineLayer); } catch {} centerlineLayer = null; }
  if (!map || activeTab.value !== "courses" || !showCenterline.value || !centerline.value?.ok) return;
  const pts = centerline.value.points;
  const latlngs = pts.map((p) => [p.lat, p.lng]);
  // Dark casing under a light dashed line so the centerline reads over satellite tiles.
  const layers = [
    L.polyline(latlngs, { color: "#0b1021", weight: 5, opacity: 0.45, interactive: false }),
    L.polyline(latlngs, { color: "#f8fafc", weight: 2.5, opacity: 0.95, dashArray: "7 6", interactive: false }),
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
watch(showCenterline, (v) => { savePref("showCenterline", v); drawCenterline(); });
watch(activeCones, scheduleCenterline);
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
// Flip the course's travel direction.
function toggleReverse() {
  const id = activeCourseId.value;
  if (id == null) return;
  saveCourseDirection(id, { reverse: !isReversed.value });
}
const isReversed = computed(() => !!activeCourse.value?.reverse);

/* ── Icon helpers ──────────────────────────────────── */
function coneSideIndex(courseId, coneId) {
  const cones = conesMap.value[courseId] || [];
  const cone = cones.find((c) => c.id === coneId);
  if (!cone) return 0;
  return cones.filter((c) => c.side === cone.side && c.id <= coneId).length;
}

// No box-shadow/text-shadow on cone icons — they cause mobile pan jank with
// dozens of markers (each becomes its own GPU compositing layer).
// The dot sizes off the --cone-px CSS variable (set on the map container per
// zoom level, see applyConeScale), so cones shrink when zoomed out instead of
// staying a fixed pixel size that blankets the map. A fixed 26px wrapper keeps
// the dot centred on the cone's latlng regardless of the inner size.
function coneDot(side, num, borderColor, borderRatio, opacity) {
  // content-box + a border that scales with --cone-px, so a fixed-thickness
  // outline never eats the number when the dot is small (zoomed out).
  const border = `max(1px, calc(var(--cone-px,18px) * ${borderRatio}))`;
  return `<div style="opacity:${opacity};width:100%;height:100%;display:flex;align-items:center;justify-content:center;"><div style="box-sizing:content-box;width:var(--cone-px,18px);height:var(--cone-px,18px);border-radius:50%;background:${SIDE_COLORS[side]};border:${border} solid ${borderColor};display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:calc(var(--cone-px,18px)*0.5);font-weight:700;line-height:1;">${num}</span></div></div>`;
}
function coneIcon(side, num, active) {
  return L.divIcon({ className: "", html: coneDot(side, num, "#fff", 0.1, active ? 1 : 0.45), iconSize: [26, 26], iconAnchor: [13, 13] });
}

function highlightIcon(side, num) {
  return L.divIcon({ className: "", html: coneDot(side, num, "#fbbf24", 0.16, 1), iconSize: [26, 26], iconAnchor: [13, 13] });
}

function multiSelectIcon(side, num) {
  return L.divIcon({ className: "", html: coneDot(side, num, "#38bdf8", 0.16, 1), iconSize: [26, 26], iconAnchor: [13, 13] });
}

// Canvas renderer that also paints each circleMarker's `label` (the cone's
// side index) in the centre — so non-editing tabs keep the numbers while still
// drawing hundreds of cones in a single canvas pass instead of hundreds of DOM
// nodes. Overrides L.Canvas._updateCircle (Leaflet 1.9), drawing the number
// right after the base circle while the layer's canvas point is current.
const CONE_MIN_R = 2.5, CONE_MAX_R = 9; // dot radius (px), scaled by zoom
// A Leaflet circleMarker is a fixed pixel size, so when you zoom out the dots
// stay 9px and pack into a solid blanket that hides the map. Scale the radius
// with zoom (≈halving per zoom level out) so dots stay roughly proportional to
// cone spacing, and clamp to a sane range.
function coneRadiusForZoom(zoom) {
  return Math.max(CONE_MIN_R, Math.min(CONE_MAX_R, CONE_MAX_R * Math.pow(2, zoom - 20)));
}
// DOM cone-icon diameter (courses tab) — same zoom curve as the canvas dots.
function coneDiameterForZoom(zoom) {
  return 2 * coneRadiusForZoom(zoom);
}
// Draw each cone pixel-identical to the courses-tab DOM marker (coneDot): a
// coloured disc of radius r, a white ring of thickness max(1px, diameter*0.1)
// sitting OUTSIDE it (the DOM uses a content-box border), and a centred number
// at font = 0.5*diameter in the app font. All on one shared canvas so the
// non-editing tabs stay smooth with hundreds of cones.
// The courses-tab DOM cone number inherits Leaflet's `.leaflet-container` font,
// not the app body font — so the canvas labels must use the SAME stack to look
// identical. (Verified at runtime: the DOM cone computes to this family, and the
// canvas cannot render the app's Noto Sans KR web font, so reusing that would
// diverge.) Match Leaflet's default exactly.
const CONE_FONT = `"Helvetica Neue", Arial, Helvetica, sans-serif`;
const LabeledConeCanvas = L.Canvas.extend({
  _updateCircle(layer) {
    const r = coneRadiusForZoom(this._map.getZoom());
    layer._radius = r;
    // No centred stroke — the base call paints only the coloured fill (radius r);
    // we add the white ring OUTSIDE it below to mirror the DOM's content-box border.
    layer.options.weight = 0;
    L.Canvas.prototype._updateCircle.call(this, layer);
    if (!this._drawing || layer._empty()) return;
    const p = layer._point, ctx = this._ctx;
    // Ring thickness/colour mirror the DOM cone: white at ratio 0.1 by default,
    // but a selected/multi-selected cone on the locked courses tab gets the same
    // amber/sky highlight ring the DOM markers use (set via coneCircle options).
    const ratio = layer.options.ringRatio ?? 0.1;
    const border = Math.max(1, 2 * r * ratio); // = DOM border: max(1px, --cone-px*ratio)
    ctx.save();
    ctx.globalAlpha = layer.options.opacity ?? 1;
    // Border ring, just outside the coloured fill (so the fill stays a full
    // radius r, exactly like the DOM circle whose border is added outside it).
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + border / 2, 0, Math.PI * 2);
    ctx.lineWidth = border;
    ctx.strokeStyle = layer.options.ringColor || "#fff";
    ctx.stroke();
    // Centred number at the DOM font size/family. Counter-rotate by the current
    // bearing so it stays upright while the canvas pane is rotated.
    if (layer.options.label != null) {
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${r.toFixed(1)}px ${CONE_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.translate(p.x, p.y);
      ctx.rotate(-(this._map._bearing || 0));
      ctx.fillText(String(layer.options.label), 0, 0);
    }
    ctx.restore();
  },
});

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
function rebuildAllMarkers() {
  Object.values(markers).forEach((m) => map.removeLayer(m));
  markers = {};

  // DOM markers (one node per cone — expensive) exist only for editing:
  // draggable, clickable, re-iconnable. We only pay that on the UNLOCKED courses
  // tab. When the courses tab is locked (the default) cones can't be added/moved/
  // rotated by gesture, so — like the read-only rover/history tabs — they render
  // as canvas dots: one redraw for hundreds of cones instead of hundreds of DOM
  // transforms. Tap-to-select and the selection highlight are still preserved on
  // the canvas (see onMapClick's locked branch and coneCircle).
  const editing = activeTab.value === "courses" && !editLocked.value;

  for (const course of courses.value) {
    if (!visibility.value[course.id]) continue;
    const cones = conesMap.value[course.id] || [];
    const isActive = course.id === activeCourseId.value;

    if (!editing) {
      for (const cone of cones) {
        const num = coneSideIndex(course.id, cone.id);
        const marker = coneCircle(cone, num, isActive).addTo(map);
        markers[`${course.id}-${cone.id}`] = marker;
      }
      continue;
    }

    for (const cone of cones) {
      const num = coneSideIndex(course.id, cone.id);
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
      const canDrag = isActive && activeTab.value === "courses" && !editLocked.value
        && !rotateMode.value && toolMode.value === "none" && !selectMode.value;
      const marker = L.marker([cone.lat, cone.lng], {
        icon,
        draggable: canDrag,
        interactive: isActive,
      });

      if (isActive) {
        marker.on("click", (e) => {
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

function updateMultiSelectIcons() {
  const aid = activeCourseId.value;
  if (!aid) return;
  // Locked courses tab: cones are canvas dots with no setIcon — repaint their
  // rings by rebuilding (cheap for canvas markers, unlike DOM ones).
  if (activeTab.value === "courses" && editLocked.value) { rebuildAllMarkers(); return; }
  for (const cone of (conesMap.value[aid] || [])) {
    const key = `${aid}-${cone.id}`;
    const m = markers[key];
    if (!m || !m.setIcon) continue; // canvas dots (non-editing tab) have no icon
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
  if (map && activeTab.value === "courses") rebuildAllMarkers();
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
    Object.entries(markers).forEach(([key, marker]) => {
      if (!key.startsWith(`${aid}-`) || !marker.setIcon) return; // skip canvas dots
      const coneId = parseInt(key.split("-")[1]);
      const cone = (conesMap.value[aid] || []).find((c) => c.id === coneId);
      if (!cone) return;
      if (coneId === id) marker.setIcon(highlightIcon(cone.side, coneSideIndex(aid, cone.id)));
      else if (multiSelectedIds.value.has(coneId)) marker.setIcon(multiSelectIcon(cone.side, coneSideIndex(aid, cone.id)));
      else marker.setIcon(coneIcon(cone.side, coneSideIndex(aid, cone.id), true));
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
      editSide.value = cone.side;
    }
  }
});

watch(activeCourseId, (v) => {
  if (rotateMode.value) exitRotateMode();
  if (toolMode.value !== "none") exitToolMode();
  selectMode.value = false;
  undoStack.value = []; // undo entries reference cone ids of the old course
  selectedConeId.value = null;
  multiSelectedIds.value = new Set();
  coneFilter.value = "all";
  coneListScrolled.value = false;
  clearPath();
  if (map) rebuildAllMarkers();
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
    for (const c of courses.value) {
      if (visibility.value[c.id] === undefined) visibility.value[c.id] = true;
      try {
        const r = await request(`/api/courses/${c.id}/cones`);
        conesMap.value[c.id] = await r.json();
      } catch { conesMap.value[c.id] = []; }
      try {
        const rm = await request(`/api/courses/${c.id}/memos`);
        memosMap.value[c.id] = await rm.json();
      } catch { memosMap.value[c.id] = []; }
    }
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
  map.on("dragstart", () => { if (followRover.value) followRover.value = false; });
  // 메모 스티커는 지리 좌표 고정 HTML 오버레이라 지도가 움직일 때마다 화면 위치·크기를
  // 다시 계산해야 한다. move/zoom은 애니메이션 중에도 반복 발생하므로 팬·줌 동안에도
  // 메모가 붙어 따라간다. rotate는 leaflet-rotate의 회전 이벤트.
  for (const ev of ["move", "zoom", "moveend", "zoomend", "viewreset", "resize", "rotate"]) {
    map.on(ev, () => { mapFrame.value++; });
  }
  setupSelectionBox();
  rebuildAllMarkers();
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
  if (roverMode.value === "path-ready" || roverMode.value === "stopped") {
    clearPath();
    return;
  }
  if (roverMode.value === "executing") return;
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
  const lat = latlng.lat.toFixed(6);
  const lng = latlng.lng.toFixed(6);
  L.popup({ closeOnClick: true, autoClose: true, className: "coord-popup" })
    .setLatLng(latlng)
    .setContent(`<div class="coord-popover-body">${lat}, ${lng}</div>`)
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

// Fixed per-file timestamp so a re-export of the same course is reproducible
// (JSZip otherwise stamps the current time into every entry).
const EXPORT_DATE = new Date("2020-01-01T00:00:00Z");
const exportingId = ref(null);

// Export a course as a ZIP holding three items:
//   <name>.json        enriched, re-importable course record (every numeric artifact)
//   <name>_width.png   2-panel preview (centerline | road width)
//   <name>_track.zip   installable Assetto Corsa track (extracts into AC content/)
// The whole pipeline runs client-side (native JS in shared/), no server compute.
async function exportCourse(id) {
  if (exportingId.value) return;
  const course = courses.value.find((c) => c.id === id);
  const name = course?.name || "course";       // in-game display name (kept as-is)
  const safeName = safeTrackName(name);         // path-safe base for file/folder names
  exportingId.value = id;
  try {
    // cones: prefer the already-loaded map, else fetch (allows a non-active course)
    let cones = conesMap.value[id];
    if (!cones || !cones.length) {
      const res = await request(`/api/courses/${id}/cones`);
      cones = await res.json();
    }

    // same start/direction as the on-map centerline so the export matches
    const cl = computeCenterline(cones, { step: 1.0, metric: true, ...courseDirOpts(id, cones) });
    if (!cl.ok) { notifyError(`중심선 생성 실패: ${cl.reason}`); return; }

    const edges = buildRoadEdges(cl);   // AC track road: widened +1 m/side (except slalom)
    const track = buildTrackModel(cl, edges, { name: safeName });

    // inner Assetto Corsa track zip (content/tracks/<safeName>/...); the in-game
    // UI name (ui_track.json) keeps the original, spaces and all.
    const entries = packTrackEntries(cl, edges, track, { name: safeName, uiName: name });
    const trackZip = new JSZip();
    for (const [path, content] of Object.entries(entries)) {
      trackZip.file(path, content, { date: EXPORT_DATE });
    }
    const trackZipBlob = await trackZip.generateAsync({ type: "blob", compression: "DEFLATE" });

    const enriched = buildEnrichedJSON({ name, cones, cl, edges, track });
    // Preview PNG shows the cone-true road width (survey), unaffected by the AC
    // drivability widening above.
    const pngEdges = buildRoadEdges(cl, { extraWidthPerSide: 0 });
    const png = await renderTwoPanelPNG(cl, pngEdges, { name });

    // outer zip with the three deliverables (path-safe file names)
    const outer = new JSZip();
    outer.file(`${safeName}.json`, JSON.stringify(enriched), { date: EXPORT_DATE });
    outer.file(`${safeName}.png`, png, { date: EXPORT_DATE });
    outer.file(`${safeName}-track.zip`, trackZipBlob, { date: EXPORT_DATE });
    const blob = await outer.generateAsync({ type: "blob", compression: "DEFLATE" });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    notifyError(err?.message || String(err));
  } finally {
    exportingId.value = null;
  }
}

function triggerImport() {
  if (!newCourseName.value.trim()) return;
  importInput.value?.click();
}

async function importCourse(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  // The imported course takes the name typed in the new-course input, not the
  // name baked into the file — so the operator names it on the spot and avoids
  // UNIQUE collisions with an existing course of the same exported name.
  const name = newCourseName.value.trim();
  if (!name) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await request("/api/courses/import", {
      method: "POST",
      body: JSON.stringify({ name, cones: data.cones }),
    });
    const created = await res.json();
    newCourseName.value = "";
    activeCourseId.value = created.id;
    visibility.value[created.id] = true;
  } catch (err) {
    notifyError(err.message);
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
  if (!window.confirm("휠 캘리브레이션을 초기화합니다 (scale_l/r=1.0, trim=0 µs). 계속하시겠습니까?")) {
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
  } catch (err) { notifyError(err.message); }
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
  } catch (err) { notifyError(err.message); }
}

async function restoreSnapshot(sid) {
  if (!activeCourseId.value) return;
  if (!confirm("현재 콘을 모두 지우고 이 스냅샷 상태로 되돌립니다. 계속하시겠습니까?\n(되돌리기 직전 상태가 자동으로 스냅샷됩니다.)")) return;
  try {
    await request(`/api/courses/${activeCourseId.value}/snapshots/${sid}/restore`, { method: "POST" });
    await loadSnapshots();
    showSnapshots.value = false;
  } catch (err) { notifyError(err.message); }
}

async function deleteSnapshot(sid) {
  if (!activeCourseId.value) return;
  if (!confirm("이 스냅샷을 삭제합니다. 계속하시겠습니까?")) return;
  try {
    await request(`/api/courses/${activeCourseId.value}/snapshots/${sid}`, { method: "DELETE" });
    await loadSnapshots();
  } catch (err) { notifyError(err.message); }
}

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
  const lat = parseFloat(editLat.value);
  const lng = parseFloat(editLng.value);
  if (isNaN(lat) || isNaN(lng)) return;
  const id = selectedConeId.value;
  const before = (conesMap.value[activeCourseId.value] || []).find((c) => c.id === id);
  try {
    await request(`/api/cones/${id}`, {
      method: "PATCH", body: JSON.stringify({ lat, lng, side: editSide.value }),
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

/* ── Memo stickers ────────────────────────────────── */
// 메모는 콘과 별개의 주석 레이어다 — 편집 잠금(콘 오조작 방지)과 무관하게 항상
// 추가·이동·리사이즈·수정·삭제할 수 있다. 중심 좌표(lat/lng)와 실측 크기(width/
// height, m)로 서버에 저장하고, 서버가 'memos' SSE로 되쏘면 모든 조작자가 공유한다.
// 드래그/리사이즈/입력 중에는 memoBusy로 SSE 에코를 막아 조작이 끊기지 않게 한다.
let memoBusy = false;
let memoDrag = null;   // { id, startLat, startLng, origLat, origLng }
let memoResize = null; // { id, startX, startY, origW, origH, mpp }
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
      body: JSON.stringify({ lat: center.lat, lng: center.lng, width: 170 * mpp, height: 120 * mpp, content: "" }),
    });
    const created = await res.json().catch(() => null);
    if (created && created.id != null) {
      // SSE 에코 전에 즉시 보이도록 낙관적 추가(에코가 같은 배열로 덮어써도 무해).
      const list = memosMap.value[courseId] || (memosMap.value[courseId] = []);
      if (!list.some((x) => x.id === created.id)) list.push(created);
      pushUndo("메모 추가", () => request(`/api/memos/${created.id}`, { method: "DELETE" }));
      nextTick(() => {
        document.querySelector(`.memo-sticker[data-id="${created.id}"] .memo-text`)?.focus();
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

/* ── Measurement tools (ruler / protractor) ───────── */
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

function enterToolMode(mode) {
  if (toolMode.value === mode) { exitToolMode(); return; }
  if (rotateMode.value) exitRotateMode();
  selectMode.value = false;
  // Measuring is its own mode — drop any selection so its icons/handles don't distract.
  if (multiSelectedIds.value.size > 0) { multiSelectedIds.value = new Set(); updateMultiSelectIcons(); }
  selectedConeId.value = null;
  toolMode.value = mode;
  if (!measureLayer) measureLayer = L.layerGroup();
  measureLayer.addTo(map);
  resetMeasure();
  rebuildAllMarkers(); // suspend per-cone drag while a tool is active
}

function exitToolMode() {
  if (toolMode.value === "none") return;
  toolMode.value = "none";
  measurePoints = [];
  if (measureLayer) { measureLayer.clearLayers(); try { map.removeLayer(measureLayer); } catch {} }
  measureResult.value = "";
  measureHint.value = "";
  if (map && activeTab.value === "courses") rebuildAllMarkers();
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
  const visible = getVisibleMapCenter();
  if (!visible) {
    map.panTo([lat, lng], { animate: opts.animate ?? true });
    return;
  }
  const targetPx = map.latLngToContainerPoint([lat, lng]);
  const dx = targetPx.x - visible.x;
  const dy = targetPx.y - visible.y;
  if (dx === 0 && dy === 0) return;
  map.panBy([dx, dy], { animate: opts.animate ?? true });
}

/* ── Rover position ───────────────────────────────── */
const followRover = ref(loadPref("followRover", false, (v) => v === "true"));
watch(followRover, (v) => savePref("followRover", v));

function centerOnRover() {
  const lp = roverStatus.value.last_position;
  if (!lp || !map) return;
  panToVisibleCenter(lp.lat, lp.lng);
}

function toggleFollowRover() {
  followRover.value = !followRover.value;
  if (followRover.value) centerOnRover();
}

// Follow-pan, throttled and non-animated. Each pan moves the map, which forces
// a redraw of the cone canvas (hundreds of cones), so doing it on every rover
// position event (the rover + rover:status SSE pair can fire >10×/s) is what
// makes manual control lag on mobile. Cap to one pan per FOLLOW_MIN_MS, always
// using the latest position; animate:false avoids per-frame redraws.
function scheduleFollow(lat, lng) {
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

function updateRoverMarker(lat, lng) {
  if (!map) return;
  if (roverMarker) {
    roverMarker.setLatLng([lat, lng]);
  } else {
    roverMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid #a855f7;"></div>`,
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
    const { lat, lng, alt } = await res.json();
    updateRoverMarker(lat, lng);
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
  clearPath();
  roverMode.value = "path-pick";
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
  // EMERGENCY_STOP 동안 서버에 보존되어 있던 미션 레코드를 명시적으로 마감.
  // (D1) clear-emergency 가 더 이상 자동으로 끝내지 않으므로, path 폐기 시
  // dangling running 레코드가 남지 않도록 best-effort 로 정리한다.
  if (roverStatus.value.mission_progress?.mission_id) {
    request("/api/rover/end-mission", { method: "POST" }).catch(() => {});
  }
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
    notifyError(err.message);
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
    notifyError(err.message);
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

/* ── Soft pause / resume ──────────────────────────────
   A soft pause holds the mission WITHOUT the E-Stop latch, so the operator can
   drive manually (e.g. around an obstacle) and then resume from the current
   waypoint. Pause is only meaningful while the rover is actually driving the
   mission; resume is offered whenever nav_state is PAUSED. */
const PAUSABLE_NAV = new Set(["NAVIGATING", "SETTLING", "SPRAYING"]);
const pauseBusy = ref(false);
async function pauseMission() {
  if (pauseBusy.value) return;
  pauseBusy.value = true;
  try {
    await request("/api/rover/pause", { method: "POST" });
  } catch (err) {
    notifyError(`일시정지 실패: ${err.message}`);
  } finally {
    pauseBusy.value = false;
  }
}
async function resumeMission() {
  if (pauseBusy.value) return;
  pauseBusy.value = true;
  try {
    await request("/api/rover/resume", { method: "POST" });
  } catch (err) {
    notifyError(`재개 실패: ${err.message}`);
  } finally {
    pauseBusy.value = false;
  }
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
  if (!roverStatus.value.connected) {
    notifyWarn("로버가 연결되어 있지 않습니다.");
    return;
  }
  // During a soft pause the operator drives manually to clear an obstacle, then
  // resumes — so KEEP the mission overlay/progress. clearPath() would not only
  // wipe the overlay (only rebuilt on mount/SSE-reconnect) but also POST
  // /api/rover/end-mission, abandoning the very mission we want to resume.
  // Outside a pause, manual mode discards any in-progress path pick as before.
  if (roverStatus.value.nav_state !== "PAUSED") clearPath();
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
  if (roverMode.value === "manual") {
    roverMode.value = "none";
    // Snap straight back to the server-truth mode — e.g. if the operator was
    // manually clearing an obstacle during a soft pause, this re-shows the
    // 재개 button immediately instead of waiting for the next status tick.
    reconcileRoverMode(roverStatus.value);
  }
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
let cameraStatusPoll = null;
let cameraLastOkAt = 0;            // last poll that saw fresh frames (ms)
const cameraStreamUrl = computed(() => {
  if (!cameraOn.value) return "";
  const base = import.meta.env.PROD ? "/course" : "";
  // cameraReqId is the cache-bust AND the reconnect lever: bumping it makes the
  // <img> re-request a fresh stream (multipart/x-mixed-replace does NOT
  // auto-reconnect after a server restart / dropped socket).
  return `${base}/api/rover/camera/stream?t=${cameraReqId.value}`;
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
    const healthy = s.camera_connected
      && s.last_frame_age_ms != null && s.last_frame_age_ms < 3000;
    cameraError.value = !healthy;
    if (healthy) {
      cameraLastOkAt = Date.now();
    } else if (s.camera_connected && s.viewers === 0 && Date.now() - cameraLastOkAt > 5000) {
      // The rover is connected but the server has ZERO viewers — our <img>
      // socket died server-side (server restart / proxy drop) while we still
      // think it's open. Re-request the stream to re-register and resume.
      // (If viewers > 0 the server still has us and frames are merely absent —
      // a dead/unplugged camera — so reconnecting wouldn't help; we just show
      // "신호 없음" and avoid churning the control channel.)
      cameraReqId.value = Date.now();
      cameraLastOkAt = Date.now();
    }
  } catch { /* keep last known state */ }
}
function stopCameraStream() {
  cameraOn.value = false;
  cameraError.value = false;
  if (cameraStatusPoll) { clearInterval(cameraStatusPoll); cameraStatusPoll = null; }
}
// Idempotent "ensure the stream is on" — used by the toggle and by the obstacle
// auto-open, which must not toggle a manually-opened stream back off.
function startCamera() {
  if (cameraOn.value) return;
  cameraOn.value = true;
  cameraError.value = false;
  cameraReqId.value = Date.now();
  cameraLastOkAt = Date.now();   // grace the cold-start window before reconnecting
  pollCameraStatus();
  cameraStatusPoll = setInterval(pollCameraStatus, 2000);
}
function toggleCamera() {
  if (cameraOn.value) { stopCameraStream(); return; }
  startCamera();
}
function onCameraError() {
  cameraError.value = true;
}
// A rover SSE drop flips connected false→true; just flag the gap. Do NOT tear
// the stream down — the operator's intent (cameraOn) is preserved and
// pollCameraStatus auto-reconnects the <img> once the rover is back, instead of
// leaving them with a permanently black box after a transient blip.
watch(() => roverStatus.value.connected, (connected) => {
  if (!connected && cameraOn.value) cameraError.value = true;
});
// The rover panel is v-show (stays mounted), so leaving the tab would keep the
// MJPEG <img> connected and the rover capturing invisibly. Stop on tab-leave.
watch(activeTab, (tab) => {
  if (tab !== "rover" && cameraOn.value) stopCameraStream();
});

async function setDispenserPosition(position) {
  if (dispenserBusy.value) return;
  dispenserBusy.value = true;
  try {
    await request("/api/rover/dispenser", {
      method: "POST",
      body: JSON.stringify({ position }),
    });
  } catch (e) {
    notifyWarn(`디스펜서 제어 실패: ${e?.message || e}`);
  } finally {
    dispenserBusy.value = false;
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
    if (map && !suppressRebuild) rebuildAllMarkers();
  });

  eventSource.addEventListener("memos", (e) => {
    const data = parseSSE(e);
    if (!data) return;
    // 내가 드래그/리사이즈/입력 중인 코스면 에코로 편집 중 배열이 교체돼 조작이
    // 끊긴다. 그 경우 건너뛰고, 조작 종료 후의 PATCH 에코가 최종 상태로 맞춘다.
    if (memoBusy && data.courseId === activeCourseId.value) return;
    memosMap.value[data.courseId] = data.memos;
  });

  eventSource.addEventListener("rover", (e) => {
    const data = parseSSE(e);
    if (!data) return;
    updateRoverMarker(data.lat, data.lng);
    if (followRover.value) scheduleFollow(data.lat, data.lng);
    if (roverMode.value === "executing") updatePathProgress(data.lat, data.lng);
  });

  eventSource.addEventListener("rover:status", (e) => {
    const data = parseSSE(e);
    if (!data) return;
    roverStatus.value = { ...roverStatus.value, ...data };
    syncAppRoverStatus(data);
    // Live-update the rover marker on the map whenever the server
    // forwards a fresh position (rover→server SSE is the truth).
    const lp = data.last_position;
    if (lp && typeof lp.lat === "number" && typeof lp.lng === "number") {
      updateRoverMarker(lp.lat, lp.lng);
      if (followRover.value) scheduleFollow(lp.lat, lp.lng);
    }
    // If the rover disconnected mid-manual-control, release immediately.
    if (!data.connected && roverMode.value === "manual") {
      stopManualControl();
    }
    reconcileRoverMode(roverStatus.value);
  });

  eventSource.addEventListener("rover:waypoint", (e) => {
    const data = parseSSE(e);
    if (roverMode.value === "executing" && Number.isInteger(data?.index)) {
      onWaypointReached(data.index);
    }
  });

  eventSource.addEventListener("rover:skipped", (e) => {
    const data = parseSSE(e);
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
    if (!Number.isInteger(data?.waypoint) || !data.outcome) return;
    onSprayResult(data.waypoint, data.outcome);
  });

  eventSource.addEventListener("rover:obstacle", (e) => {
    const data = parseSSE(e);
    if (data) onObstacle(data);
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
    syncAppRoverStatus(data);
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
    reconcileRoverMode(roverStatus.value);
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
}

// Server is the source of truth for nav_state / connected / mission_progress.
// Every code path that ingests fresh server state (initial fetch, live SSE,
// post-reconnect refetch) routes through this so the button label can never
// diverge from reality. User-driven modes (path-pick, manual) are orthogonal
// to server state and preserved.
const ACTIVE_NAV_STATES = new Set(["CALIBRATING", "NAVIGATING", "SETTLING", "SPRAYING", "CAL_ANTENNA", "CAL_WHEELS"]);

function reconcileRoverMode(s) {
  if (roverMode.value === "path-pick" || roverMode.value === "manual") return;

  const nav = s?.nav_state;
  const hasMission = !!s?.mission_progress?.mission_id;
  const missionStatus = s?.mission_progress?.status;
  const connected = !!s?.connected;
  // 'interrupted' = rover dropped mid-mission; resume by re-sending the
  // remaining waypoints ("이어서 실행"), since a fresh/rebooted rover has no
  // in-memory plan to continue. (A soft 'paused' mission is different — the
  // rover holds its plan and resumes in place via the dedicated 재개 button,
  // so it stays in the 'executing' view below, not here.)
  const resumable = hasMission && missionStatus === "interrupted";

  // Actively executing — or soft-paused, which is still an in-progress mission
  // (path overlay + progress stay visible; the 일시정지/재개 button toggles it).
  if (connected && (ACTIVE_NAV_STATES.has(nav) || nav === "PAUSED")) { roverMode.value = "executing"; return; }

  // Resumable: e-stop / error latch, or an interrupted mission. Show
  // "이어서 실행". Works whether or not the rover is currently connected — the
  // server gates the actual resume until the rover SSE is back.
  if (nav === "EMERGENCY_STOP" || nav === "ERROR" || resumable) {
    if (roverMode.value !== "stopped") {
      roverMode.value = "stopped";
      if (resumeStartIdx.value === 0) resumeStartIdx.value = executedIndex.value;
    }
    return;
  }

  if (!connected) {
    if (roverMode.value === "executing" || roverMode.value === "stopped") {
      roverMode.value = pathWaypoints.value.length ? "path-ready" : "none";
    }
    return;
  }

  // nav IDLE/null + no resumable mission — only step out of executing/stopped
  // once the server has also cleared the mission, so we don't bounce while the
  // rover briefly touches IDLE between phases.
  if (!hasMission && (roverMode.value === "executing" || roverMode.value === "stopped")) {
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
    if (showLogs.value) { showLogs.value = false; e.preventDefault(); return; }
    if (showSnapshots.value) { showSnapshots.value = false; e.preventDefault(); return; }
    if (showBatteryCal.value) { showBatteryCal.value = false; e.preventDefault(); return; }
    if (showCalibration.value) { closeCalibration(); e.preventDefault(); return; }
    if (showPreflight.value) { cancelPreflight(); e.preventDefault(); return; }
    // Then back out of the editing modes.
    if (rotateMode.value) { exitRotateMode(); e.preventDefault(); return; }
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
  window.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("click", onGlobalClickForChips);
  document.addEventListener("keydown", onGlobalKeyForChips);
  // 1Hz tick so time-ago chips and disconnect-ago refresh without new SSE events.
  uiTickInterval = setInterval(() => { uiTick.value = (uiTick.value + 1) % 3600; }, 1000);
  await fetchAll();
  await nextTick();
  await initMap();
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
});

onUnmounted(() => {
  stopReplay();
  // MapView is the sole writer of the App-owned sseReconnecting ref; clear it
  // so the "reconnecting" badge can't stick on after this view tears down.
  sseReconnecting.value = false;
  window.removeEventListener("resize", checkMobile);
  window.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("click", onGlobalClickForChips);
  document.removeEventListener("keydown", onGlobalKeyForChips);
  if (uiTickInterval) clearInterval(uiTickInterval);
  if (controlInterval) clearInterval(controlInterval);
  if (cameraStatusPoll) clearInterval(cameraStatusPoll);
  if (calStatusPollHandle) clearInterval(calStatusPollHandle);
  if (ledBrightnessTimer) clearTimeout(ledBrightnessTimer);
  if (centerlineTimer) clearTimeout(centerlineTimer);
  if (followTimer != null) clearTimeout(followTimer);
  if (eventSource) eventSource.close();
  if (map) {
    teardownRotateHandle();
    if (measureLayer) { try { map.removeLayer(measureLayer); } catch {} }
    map.getContainer().removeEventListener("pointerdown", onSelectionStart);
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
            <h3>캘리브레이션</h3>
            <button
              class="modal-close-x"
              :disabled="antennaCalSubmitting || wheelCalSubmitting"
              aria-label="닫기"
              @click="closeCalibration"
            >×</button>
          </div>

          <section class="cal-section">
            <div class="cal-section-title">
              안테나 오프셋
              <span v-if="antennaCalDisplay.sourceLabel" class="cal-source-tag">
                {{ antennaCalDisplay.sourceLabel }}
              </span>
            </div>
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

          <section class="cal-section">
            <div class="cal-section-title">휠 인코더 스케일</div>
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

          <section class="cal-section">
            <div class="cal-section-title">스테레오 카메라 교정</div>
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
      <div class="workspace">

        <!-- Persistent status strip (always visible across tabs) -->
        <div
          class="status-strip"
          @scroll.passive="onChipStripScroll"
        >
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
                <span class="mission-counts">{{ missionChip.current }}/{{ missionChip.total }} · {{ missionChip.percent }}%</span>
                <span v-if="missionChip.eta" class="mission-eta">ETA {{ missionChip.eta }}</span>
              </div>
              <span class="chip-popover" :style="popoverStyle">
                <span class="popover-row"><span class="popover-key">PROGRESS</span><span class="popover-val">{{ missionChip.current }} / {{ missionChip.total }} ({{ missionChip.percent }}%)</span></span>
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
                </span>
              </span>
            </div>
          </template>

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
          <div class="map-wrap">
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
                class="fab-icon-btn fab-rover"
                @click="addConeFromRover" :disabled="roverLoading"
                aria-label="로버 위치로 콘 추가"
                title="로버 GPS 위치로 콘 추가"
              >{{ roverLoading ? '⏳' : '📍' }}</button>
            </div>

            <!-- Measurement / selection tools (영역 · 자 · 각도기) — separate
                 top-right panel. Read-only, usable even when editing is locked. -->
            <div
              v-if="activeTab === 'courses' && activeCourse"
              class="map-fab-panel map-fab-tools"
            >
              <button
                v-if="centerline?.ok"
                :class="['fab-icon-btn', 'fab-tool', { active: isReversed }]"
                @click="toggleReverse"
                aria-label="진행방향 전환"
                :title="isReversed ? '진행방향: 역방향 (탭 → 정방향)' : '진행방향: 정방향 (탭 → 역방향)'"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="16 4 21 8 16 12" />
                  <line x1="3" y1="8" x2="21" y2="8" />
                  <polyline points="8 12 3 16 8 20" />
                  <line x1="3" y1="16" x2="21" y2="16" />
                </svg>
              </button>
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

            <!-- Memo sticker layer — geo-anchored HTML annotations over the map.
                 The layer is inert (map stays draggable); each sticker re-enables
                 pointer events. Positions/sizes recompute via mapFrame on every
                 map move/zoom/rotate. -->
            <div v-if="activeTab === 'courses' && activeCourse" class="memo-layer">
              <div
                v-for="m in activeMemos"
                :key="m.id"
                class="memo-sticker"
                :data-id="m.id"
                :style="memoStyle(m)"
              >
                <div class="memo-head" @pointerdown="onMemoDragStart(m, $event)" title="드래그하여 이동">
                  <span class="memo-grip">⠿</span>
                  <button class="memo-del" @pointerdown.stop @click="deleteMemo(m.id)" title="메모 삭제">×</button>
                </div>
                <textarea
                  class="memo-text"
                  v-model="m.content"
                  placeholder="메모 입력…"
                  @focus="onMemoFocus(m)"
                  @blur="onMemoBlur(m)"
                  @pointerdown.stop
                ></textarea>
                <div class="memo-resize" @pointerdown="onMemoResizeStart(m, $event)" title="드래그하여 크기 조절"></div>
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
                    <h3>{{ activeCourse.name }}<span v-if="centerline?.ok" class="centerline-len"> ({{ Math.round(centerline.length) }} m)</span><span v-if="editLocked" class="lock-badge" title="편집 잠김">🔒</span></h3>
                  </header>

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
                    <div class="group-title">콘 수정 #{{ coneSideIndex(activeCourseId, selectedConeId) }}</div>
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
                      고도 {{ selectedCone.alt.toFixed(2) }} m
                    </div>
                    <div class="edit-buttons">
                      <button class="btn btn-primary btn-lg-touch" @click="updateCone">저장</button>
                      <button class="btn btn-danger btn-lg-touch" @click="deleteCone(selectedConeId)">삭제</button>
                      <button class="btn btn-ghost btn-lg-touch" @click="selectedConeId = null">취소</button>
                    </div>
                    <div class="edit-buttons">
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
                        <span class="cone-num" :style="{ color: SIDE_COLORS[cone.side] }">#{{ coneSideIndex(activeCourseId, cone.id) }}</span>
                        <span class="cone-coords">{{ cone.lat.toFixed(6) }}, {{ cone.lng.toFixed(6) }}</span>
                        <span v-if="cone.alt != null" class="cone-alt" title="고도 (MSL)">{{ cone.alt.toFixed(1) }} m</span>
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
                  </div>
                </template>
              </section>

              <!-- Rover tab -->
              <section v-show="activeTab === 'rover'" class="tab-pane">
                <header class="tab-header">
                  <h3>로버 제어</h3>
                </header>

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
                      <span class="gps-val">{{ roverStatus.gps?.altitude != null ? roverStatus.gps.altitude.toFixed(1) + ' m' : '—' }}</span>
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
                    >{{ followRover ? '추적 중' : '추적' }}</button>
                  </div>
                  <button
                    v-if="roverStatus.connected"
                    class="btn btn-lg-touch btn-ghost manual-btn-row"
                    @click="openCalibration"
                  >캘리브레이션</button>
                  코스를 먼저 선택하세요.
                  <button class="btn btn-ghost btn-lg-touch" @click="activeTab = 'courses'">코스 탭으로</button>
                </div>
                <template v-else>
                  <div class="rover-controls rover-controls-grid">
                    <button
                      :class="['btn', 'btn-lg-touch', followRover ? 'btn-primary' : 'btn-ghost']"
                      :disabled="!roverStatus.connected"
                      @click="toggleFollowRover"
                    >{{ followRover ? '추적 중' : '추적' }}</button>
                    <button
                      :class="['btn', 'btn-lg-touch', pathBtnClass]"
                      @click="onPathBtn"
                      :disabled="activeCones.length === 0 || roverMode === 'manual' || (stopping && (roverMode === 'executing' || roverMode === 'stopped'))"
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
                  <div class="rover-controls rover-controls-grid">
                    <button
                      class="btn btn-lg-touch btn-ghost"
                      :disabled="!roverStatus.connected"
                      @click="openCalibration"
                    >캘리브레이션</button>
                    <button
                      :class="['btn', 'btn-lg-touch', roverMode === 'manual' ? 'btn-primary' : 'btn-ghost']"
                      :disabled="roverMode !== 'manual' && (!roverStatus.connected || (roverMode === 'executing' && roverStatus.nav_state !== 'PAUSED') || roverMode === 'stopped')"
                      @click="roverMode === 'manual' ? stopManualControl() : startManualControl()"
                    >{{ roverMode === 'manual' ? '수동 종료' : '수동 제어' }}</button>
                  </div>

                  <!-- Live camera (MJPEG, relayed via the course server). Opening
                       the stream tells the rover to start capturing; closing it
                       stops capture. Useful for manual driving / clearing an
                       obstacle while paused. -->
                  <div v-if="roverStatus.connected" class="rover-controls rover-controls-grid">
                    <button
                      :class="['btn', 'btn-lg-touch', cameraOn ? 'btn-primary' : 'btn-ghost']"
                      @click="toggleCamera"
                    >{{ cameraOn ? '카메라 끄기' : '카메라' }}</button>
                  </div>
                  <div v-if="cameraOn" class="camera-view">
                    <img v-if="cameraStreamUrl" :src="cameraStreamUrl" alt="rover camera" @error="onCameraError" />
                    <div v-if="cameraError" class="camera-error">카메라 신호 없음</div>
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
                    <div class="dispenser-buttons">
                      <button
                        class="dispenser-btn"
                        :disabled="dispenserBusy"
                        @click="setDispenserPosition('load')"
                      >Load</button>
                      <button
                        class="dispenser-btn"
                        :disabled="dispenserBusy"
                        @click="setDispenserPosition('dump')"
                      >Dump</button>
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
  /* Uniform 0.75rem between every chip (matches .chip-row gap) so spacing is
     consistent whether two chips share a zone or straddle a zone boundary,
     with comfortable breathing room. */
  padding: 0.875rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary); color: var(--text-primary);
  font-size: 0.85rem;
  flex-wrap: wrap;
  /* z-index 999: above Leaflet panes (max 700), below NavMenu drawer (1000). */
  position: relative;
  z-index: 999;
}

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
.calibration-modal .cal-section {
  padding: 0.75rem 0;
  border-top: 1px solid var(--border-color);
}
.calibration-modal .cal-section:first-of-type { border-top: none; padding-top: 0; }
.calibration-modal > .cal-section:first-of-type { padding-top: 0.5rem; }
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

/* Memo sticker layer. Inert container over the map (map stays draggable);
   each sticker re-enables pointer events. Stickers are geo-anchored — centred
   on their coordinate (translate) and sized in meters (scaled to px by
   memoStyle), so they pan/zoom/rotate with the course like cones do. */
.memo-layer { position: absolute; inset: 0; z-index: 450; overflow: hidden; pointer-events: none; }
.memo-sticker {
  position: absolute; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; box-sizing: border-box;
  min-width: 44px; min-height: 34px;
  background: color-mix(in srgb, #fde68a 94%, transparent);
  border: 1px solid #caa032; border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  pointer-events: auto; overflow: hidden;
}
.memo-head {
  display: flex; align-items: center; justify-content: space-between;
  flex: none; height: 18px; padding: 0 4px;
  background: color-mix(in srgb, #caa032 32%, transparent);
  cursor: move; touch-action: none; user-select: none;
}
.memo-grip { font-size: 11px; line-height: 1; color: #6b5010; }
.memo-del {
  border: none; background: transparent; color: #6b5010;
  font-size: 15px; line-height: 1; padding: 0 2px; cursor: pointer;
}
.memo-del:hover { color: #b91c1c; }
.memo-text {
  flex: 1; width: 100%; min-height: 0; box-sizing: border-box;
  border: none; outline: none; resize: none; background: transparent;
  color: #3f2d00; font-family: inherit; font-size: 12px; line-height: 1.3; padding: 4px;
}
.memo-text::placeholder { color: #a1793a; }
.memo-resize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize; touch-action: none;
  background: linear-gradient(135deg, transparent 55%, #caa032 55%, #caa032 65%,
    transparent 65%, transparent 78%, #caa032 78%, #caa032 88%, transparent 88%);
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
.camera-view img { display: block; width: 100%; height: auto; }
.camera-error {
  padding: 1rem 0.75rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-align: center;
}
.rover-controls-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem;
}
.rover-controls-grid .btn { width: 100%; }
/* Odd button count: last button spans both columns so the layout never
   leaves a half-empty trailing row. */
.rover-controls-grid > *:last-child:nth-child(odd) { grid-column: 1 / -1; }

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

.dispenser-buttons {
  display: flex; gap: 0.5rem; justify-content: center;
  margin-top: 0.75rem;
}
.dispenser-btn {
  flex: 1; max-width: 80px;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-color); border-radius: 4px;
  background: var(--bg-secondary); color: var(--text-primary);
  font-size: 0.8rem; cursor: pointer;
}
.dispenser-btn:hover:not(:disabled) { background: var(--bg-tertiary); }
.dispenser-btn:disabled { opacity: 0.5; cursor: not-allowed; }

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

/* ── Mobile: rail → bottom tab bar, inspector → bottom drawer ────────── */
@media (max-width: 768px) {
  .map-layout { padding: 0; }
  .content { border-radius: 0; border: none; }

  /* Strip scrolls horizontally; popovers go position: fixed (see
     toggleChipPopover) since overflow-x: auto would clip them. */
  .status-strip {
    padding: 0.75rem 1.25rem;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: visible;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .status-strip::-webkit-scrollbar { display: none; }
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
  .map-fab-tools { flex-direction: row; flex-wrap: nowrap; }
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
    padding: 1.25rem 1rem;
    cursor: pointer; flex-shrink: 0;
    touch-action: none;
  }
  .handle-bar {
    width: 56px; height: 6px; border-radius: 3px;
    background: var(--text-secondary); opacity: 0.5;
  }

  .tab-pane { padding: 0.75rem 0.875rem 1.25rem; }
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
