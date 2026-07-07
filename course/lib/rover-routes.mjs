// Rover·미션·카메라 서브시스템 라우트 (course/index.mjs에서 분리).
//
// course/index.mjs는 코스·콘 CRUD와 DB 스키마를 소유하고, 이 모듈은 /api/rover/*,
// /api/missions* 전체와 관련 인메모리 상태(rover SSE 연결, 미션 추적, 카메라 릴레이)를
// 소유한다. shared/team-lifecycle.mjs와 같은 register 패턴 — 동작은 분리 전과 동일.
import crypto from "crypto";
import { haversine } from "./geo.mjs";

const ROVER_MAX_WAYPOINT_DIST_M = Number(process.env.ROVER_MAX_WAYPOINT_DIST_M) || 200;
const ROVER_MAX_SEGMENT_DIST_M = Number(process.env.ROVER_MAX_SEGMENT_DIST_M) || 50;
const ROVER_MIN_SEGMENT_DIST_M = 0.05;
const ROVER_MAX_PENDING_REQUESTS = 32;
const ROVER_POSITION_STALE_MS = 30 * 1000;

export function registerRoverRoutes(app, { express, db, dbRun, logger, broadcastEvent, getCourseById, takeCourseSnapshot, validateCoordinate, validateAltitude }) {

/* ============================================
   API 라우트: /api/rover
   ============================================ */

let roverClient = null;
// The GPS-receiver unit (fsk-rover-gps) holds its OWN SSE slot, distinct from the
// rover (fsk-rover). Both connect to /api/rover/stream but self-identify via
// ?device=gps|rover, so they no longer evict each other — a receiver carried for
// cone surveying and the rover can be connected at the same time. The receiver is
// the PREFERRED position source for cone capture (higher RTK-fixed reliability);
// the rover is the fallback. See activePositionSource().
let receiverClient = null;
// In-memory mirror of gps_config.ntrip_source so broadcastRoverStatus (a hot
// path) doesn't read SQLite on every frame. Loaded from the DB at boot (in the
// GPS section) and updated on PUT /api/gps/config.
let ntripSourceCache = "ngii";
const roverPendingResolves = [];
let lastRoverPosition = null; // { lat, lng, at: epoch ms }
// When the operator last issued a resume. Telemetry's PAUSED→paused reconcile
// (below) ignores frames within this window so a stale PAUSED frame in flight at
// resume time can't bounce a just-resumed mission back to paused.
let roverLastResumeAt = 0;
const ROVER_PAUSE_RECONCILE_GRACE_MS = 5000;

// Nav states in which the rover OWNS the velocity stream (actively executing a
// mission). Mirrors navigator_node's State enum and the web ACTIVE_NAV_STATES.
// Used to tell "rover is still driving the mission" from "rover went idle".
const ACTIVE_NAV_STATES = new Set([
  "CALIBRATING", "CAL_ANTENNA", "CAL_WHEELS", "NAVIGATING", "SETTLING", "SPRAYING",
]);

// Active mission tracking
const insertMission = db.prepare(
  "INSERT INTO mission (course_id, started_at, waypoints_json, actor) VALUES (?, ?, ?, ?)"
);
// Terminal transition. Allowed from any non-terminal state (running/paused/
// interrupted) so an operator can end a paused/interrupted mission, and a
// superseding execute can close a still-open prior one.
const finishMission = db.prepare(
  "UPDATE mission SET ended_at = ?, status = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'paused', 'interrupted')"
);
// Non-terminal status change (running ⇄ paused ⇄ interrupted), no ended_at.
const setMissionStatus = db.prepare(
  "UPDATE mission SET status = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'paused', 'interrupted')"
);
// Persist in-flight progress so a disconnect / reload / server restart can
// rebuild the executing view and resume from the right waypoint.
const persistMissionProgress = db.prepare(
  "UPDATE mission SET current_waypoint_idx = ?, spray_results_json = ?, updated_at = ? WHERE id = ?"
);
const insertTelemetry = db.prepare(
  `INSERT INTO mission_telemetry
     (mission_id, t, lat, lng, fix_status, nav_state, ntrip_connected, corr_age_ms, ntrip_fail_count, h_acc_m, altitude_m, v_acc_m)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

let currentMissionId = null;

// Recover from unclean shutdowns: a row left 'running' means the server died
// mid-mission. The rover keeps driving on its own (it already has the
// waypoints) and will reconnect, so the mission is NOT lost — mark it
// 'interrupted' (resumable) rather than terminal 'error'. The persisted
// current_waypoint_idx lets the operator resume, and the boot re-adopt below
// reloads it into memory so the reconnecting rover stays attached to it.
const orphanRecoveryResult = db.prepare(
  `UPDATE mission SET status = 'interrupted', updated_at = ? WHERE status = 'running'`
).run(Date.now());
if (orphanRecoveryResult.changes > 0) {
  logger.log(null, "mission.orphan_recovery", { count: orphanRecoveryResult.changes }, "rover",
    { email: "system", name: "boot", role: "admin" });
}

function startMission(waypoints, actor, courseId) {
  // Close any still-open prior mission as stopped.
  if (currentMissionId != null) {
    logger.warn(null, "mission.end.superseded", { mission_id: currentMissionId }, "rover");
    finishMission.run(Date.now(), "stopped", Date.now(), currentMissionId);
  }
  const info = insertMission.run(
    courseId || null,
    Date.now(),
    JSON.stringify(waypoints),
    actor || null,
  );
  currentMissionId = Number(info.lastInsertRowid);
  // A fresh mission starts with a clean slate — never inherit a previous run's
  // obstacle alert, and scope the resume grace window to THIS mission so a
  // prior mission's resume can't suppress this one's pause reconcile.
  roverState.obstacle = { active: false, at: 0, nearest_m: null };
  roverLastResumeAt = 0;
  roverState.mission_progress = {
    mission_id: currentMissionId,
    waypoints,
    current_waypoint_idx: 0,
    spray_results: {},
    status: "running",
  };
}

function endMission(status) {
  if (currentMissionId == null) return;
  finishMission.run(Date.now(), status, Date.now(), currentMissionId);
  currentMissionId = null;
  // The mission is over — any obstacle hold is moot; clear the operator alert.
  roverState.obstacle = { active: false, at: 0, nearest_m: null };
  roverState.mission_progress = {
    mission_id: null,
    waypoints: [],
    current_waypoint_idx: 0,
    spray_results: {},
    status: null,
  };
}

// Persist the in-flight waypoint index + spray results to the DB so a rover
// disconnect, a UI reload, or a server restart can rebuild the executing view
// and resume from the right place. Cheap; called on every progress event.
function persistProgress() {
  if (currentMissionId == null) return;
  const mp = roverState.mission_progress;
  persistMissionProgress.run(
    mp.current_waypoint_idx || 0,
    JSON.stringify(mp.spray_results || {}),
    Date.now(),
    currentMissionId,
  );
}

// The rover SSE dropped (or the server is shutting down) mid-mission. The rover
// keeps driving autonomously and will reconnect, so we do NOT end the mission —
// we flag it 'interrupted' (resumable) and keep currentMissionId +
// mission_progress in memory. The next telemetry showing an active nav_state
// flips it back to 'running' (see /api/rover/telemetry).
//
// A mission that was operator-'paused' stays 'paused' across the drop: the rover
// is holding in PAUSED and is still resumable in place via /api/rover/resume, so
// we must not downgrade it to 'interrupted' (that would make the UI's 재개 button
// 409 against the paused-only resume guard). Only a 'running' mission interrupts.
function interruptMission() {
  if (currentMissionId == null) return;
  persistProgress();
  if (roverState.mission_progress.status === "running") {
    setMissionStatus.run("interrupted", Date.now(), currentMissionId);
    roverState.mission_progress.status = "interrupted";
  }
}

function recordTelemetrySample() {
  if (currentMissionId == null) return;
  const pos = roverState.last_position;
  const now = Date.now();
  // NTRIP link health at this sample. ntrip_connected===false zeroes
  // roverState.ntrip (see /api/rover/telemetry), so corr_age/fail_count are
  // null while disconnected — that's intended: ntrip_connected=0 alone is the
  // "network drop" signature; corr_age only matters while connected (caster
  // silent). last_correction_at is the rover's unix-seconds clock; both rover
  // and server are NTP-synced so the ms delta is meaningful for diagnosis.
  const ntrip = roverState.ntrip;
  const corrAgeMs =
    ntrip && typeof ntrip.last_correction_at === "number" && ntrip.last_correction_at > 0
      ? Math.max(0, now - Math.round(ntrip.last_correction_at * 1000))
      : null;
  insertTelemetry.run(
    currentMissionId,
    now,
    pos ? pos.lat : null,
    pos ? pos.lng : null,
    roverState.fix_status,
    roverState.nav_state,
    typeof roverState.ntrip_connected === "boolean" ? (roverState.ntrip_connected ? 1 : 0) : null,
    corrAgeMs,
    ntrip && Number.isInteger(ntrip.fail_count) ? ntrip.fail_count : null,
    roverState.gps && typeof roverState.gps.h_acc === "number" ? roverState.gps.h_acc : null,
    roverState.gps && typeof roverState.gps.altitude === "number" ? roverState.gps.altitude : null,
    roverState.gps && typeof roverState.gps.v_acc === "number" ? roverState.gps.v_acc : null,
  );
}
const roverState = {
  connected: false,
  last_position: null,
  last_position_at: 0,
  fix_status: null,
  fix_status_at: 0,
  nav_state: null,
  ntrip_connected: null,
  // Nav-light pattern: 0=off 1=steady 2=double-strobe 3=single-strobe 4=50% blink.
  // Operator-selected; persisted here and re-sent to the rover on (re)connect.
  nav_lights_mode: 2,
  // Status-LED (WS2812) global brightness scale 0-255. Same persist/re-send.
  led_brightness: 255,
  // Peristaltic pump manual toggle state (operator PUMP button). Reset to
  // off on rover (re)connect since the rover boots the pump off.
  pump_on: false,
  // Pump dispense time in seconds — how long the pump runs per waypoint.
  // Operator-tunable; persisted here and re-sent to the rover on (re)connect.
  pump_run_duration: 2.0,
  last_disconnect_reason: null, // "sse_closed" | "write_failed" | "replaced"
  last_disconnect_at: 0,
  last_spray_result: null, // { waypoint, outcome, at }
  // Most recent antenna offset calibration outcome — surfaced in the UI so
  // the chief can see whether the persisted offset on the rover matches
  // what they just measured / whether a recent attempt failed (and why).
  // { ok, a_x, a_y, rms_residual_m, samples, drive_distance_m, calibrated_at, reason }
  antenna_calibration: null,
  // Most recent wheel scale calibration outcome.
  // { ok, scale_l, scale_r, gps_distance_m, encoder_left_m, encoder_right_m, samples, calibrated_at, reason }
  wheel_calibration: null,
  battery: null, // { voltage, percent, source }
  ntrip: null, // { host, port, mountpoint, fail_count, last_error, last_correction_at, bytes_received }
  gps: null, // { h_acc, v_acc, altitude, speed, heading, num_sv, pdop, tdop } from rover GPS metrics
  // Most recent driving-corridor obstacle reported by the perception node. The
  // rover auto-pauses the mission LOCALLY over ROS; this only mirrors it for the
  // operator UI (alert banner + auto-open camera). { active, at, nearest_m }
  obstacle: { active: false, at: 0, nearest_m: null },
  // UI-triggered stereo calibration progress/result, reported by the perception
  // node. { status: idle|running|done|failed, phase, captured, target, rms,
  // baseline_mm, pairs, error, at }
  stereo_calibration: { status: "idle", at: 0 },
  // UI-triggered ground calibration progress/result (above-ground detector's
  // ground-depth curve). { status, phase, captured, target, near_m, far_m, rows,
  // error, at }. Requires a stereo calibration first (metric depth).
  ground_calibration: { status: "idle", at: 0 },
  // Session-scoped per-mission progress used for tab-close recovery — the
  // server acts as the source of truth so reloading the UI rebuilds the
  // executing/stopped view exactly.
  mission_progress: {
    mission_id: null,
    waypoints: [],          // last waypoint set broadcast to the rover
    current_waypoint_idx: 0, // 1-based: count of waypoints reached so far
    spray_results: {},      // { [waypointIndex]: outcome }
    // running | paused | interrupted | null. Lets the UI distinguish an
    // operator pause from a connection interruption, and gates auto-complete.
    status: null,
  },
  updated_at: 0,
};

// GPS-receiver (fsk-rover-gps) state — kept separate from roverState so the two
// devices can be connected simultaneously. `mode` is SERVER-owned (driven by the
// GPS-management config / base-station commands, re-applied on receiver reconnect),
// not by the receiver's telemetry: "capture" = live position source for cone
// surveying; "base" = stationary RTK base station emitting RTCM (not a position
// source). The `base` sub-block mirrors survey progress + RTCM link health for the UI.
const receiverState = {
  connected: false,
  last_disconnect_reason: null,
  last_disconnect_at: 0,
  mode: "capture", // "capture" | "base"
  last_position: null, // { lat, lng, alt }
  last_position_at: 0,
  fix_status: null,
  ntrip_connected: null,
  ntrip: null, // { host, port, mountpoint, fail_count, last_error, last_correction_at, bytes_received }
  gps: null,   // { h_acc, v_acc, altitude, speed, heading, num_sv, pdop, tdop }
  base: {
    state: "idle",       // idle | surveying | active
    point_id: null,      // survey_point.id being surveyed / used as base
    survey: null,        // { started_at, duration_s, samples } while surveying
    last_rtcm_at: 0,     // epoch ms of last relayed RTCM chunk
    rtcm_bytes: 0,       // cumulative RTCM bytes relayed this base session
  },
  updated_at: 0,
};

// Boot re-adopt: if a mission was left open (interrupted by an unclean shutdown,
// or paused) reload it into memory. The rover keeps driving and reconnects, so
// the server must stay attached to the same mission_id; and the UI rebuilds the
// in-flight overlay from mission_progress on first status fetch. Newest wins.
{
  const open = db.prepare(
    `SELECT id, waypoints_json, current_waypoint_idx, spray_results_json, status
     FROM mission WHERE status IN ('interrupted', 'paused') ORDER BY id DESC LIMIT 1`
  ).get();
  if (open) {
    let waypoints = [];
    let spray = {};
    try { waypoints = JSON.parse(open.waypoints_json); } catch { /* leave [] */ }
    try { spray = JSON.parse(open.spray_results_json); } catch { /* leave {} */ }
    currentMissionId = open.id;
    roverState.mission_progress = {
      mission_id: open.id,
      waypoints: Array.isArray(waypoints) ? waypoints : [],
      current_waypoint_idx: open.current_waypoint_idx || 0,
      spray_results: spray && typeof spray === "object" ? spray : {},
      status: open.status,
    };
  }
}

// The receiver reports position at ~1 Hz while it holds a fix, and stops posting
// when the fix drops. So "posted within this window" is the signal that it has a
// live, usable fix — treat an older position as stale (fix lost / connection
// dead) so capture doesn't route to a receiver that can't answer.
const RECEIVER_POSITION_STALE_MS = 5000;

// The GPS receiver is the preferred cone-capture position source when connected in
// "capture" mode with a RECENT (non-stale) fix; otherwise fall back to the rover.
// In "base" mode the receiver is a stationary RTCM source, NOT a position source.
// Returns "receiver" | "rover" | null (nobody usable).
function activePositionSource() {
  if (receiverClient && receiverState.mode === "capture" && receiverState.last_position
      && Date.now() - receiverState.last_position_at < RECEIVER_POSITION_STALE_MS) return "receiver";
  if (roverClient) return "rover";
  return null;
}

function broadcastRoverStatus() {
  const now = Date.now();
  roverState.updated_at = now;
  receiverState.updated_at = now;
  broadcastEvent("rover:status", {
    ...roverState,
    receiver: { ...receiverState },
    position_source: activePositionSource(),
    // The rover's configured correction source — lets the UI warn when it's the
    // receiver base station but the receiver isn't connected (rover gets no RTK).
    ntrip_source: ntripSourceCache,
  });
}

function markRoverDisconnected(reason) {
  if (roverState.connected) {
    roverState.last_disconnect_reason = reason;
    roverState.last_disconnect_at = Date.now();
  }
  roverState.connected = false;
}

function markReceiverDisconnected(reason) {
  if (receiverState.connected) {
    receiverState.last_disconnect_reason = reason;
    receiverState.last_disconnect_at = Date.now();
  }
  receiverState.connected = false;
  // A disconnected receiver has no live fix — drop its last position (and fix
  // status) so it can't stay the preferred capture source, or leave a stale
  // marker, until it reconnects and re-posts a fresh fix.
  receiverState.last_position = null;
  receiverState.last_position_at = 0;
  receiverState.fix_status = null;
}

// Telemetry field sanitizers — shared by the rover and receiver telemetry paths so
// both devices' GPS/NTRIP blocks are validated identically. Return null when the
// block is absent/malformed (caller then leaves the cached value untouched).
function sanitizeGpsMetrics(gps) {
  if (!gps || typeof gps !== "object" || Array.isArray(gps)) return null;
  return {
    h_acc: typeof gps.h_acc === "number" ? gps.h_acc : null,
    v_acc: typeof gps.v_acc === "number" ? gps.v_acc : null,
    altitude: typeof gps.altitude === "number" ? gps.altitude : null,
    speed: typeof gps.speed === "number" ? gps.speed : null,
    heading: typeof gps.heading === "number" ? gps.heading : null,
    num_sv: Number.isInteger(gps.num_sv) ? gps.num_sv : null,
    pdop: typeof gps.pdop === "number" ? gps.pdop : null,
    tdop: typeof gps.tdop === "number" ? gps.tdop : null,
  };
}
function sanitizeNtripDetail(ntrip) {
  if (!ntrip || typeof ntrip !== "object" || Array.isArray(ntrip)) return null;
  return {
    host: typeof ntrip.host === "string" ? ntrip.host.slice(0, 128) : null,
    port: Number.isInteger(ntrip.port) ? ntrip.port : null,
    mountpoint: typeof ntrip.mountpoint === "string" ? ntrip.mountpoint.slice(0, 64) : null,
    fail_count: Number.isInteger(ntrip.fail_count) ? ntrip.fail_count : null,
    last_error: typeof ntrip.last_error === "string" ? ntrip.last_error.slice(0, 256) : null,
    last_correction_at: typeof ntrip.last_correction_at === "number" ? ntrip.last_correction_at : null,
    bytes_received: Number.isInteger(ntrip.bytes_received) ? ntrip.bytes_received : null,
  };
}

function rejectNoRover(req, res, action, extra = {}) {
  logger.warn(req, action, { error: "not_connected", ...extra }, "rover");
  return res.status(503).send("로버가 연결되어 있지 않습니다.");
}

// GET /api/rover/stream - 로버 SSE 연결 (로버가 호출)
app.get("/api/rover/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");

  // The GPS receiver (fsk-rover-gps) self-identifies with ?device=gps and takes its
  // OWN slot; anything else is the rover (default keeps legacy pilots working). The
  // receiver never drives, so its path has no mission lifecycle — it only owns the
  // receiverClient slot + connection state and re-applies any base-station config.
  if (req.query.device === "gps") {
    if (receiverClient && receiverClient !== res) {
      logger.warn(req, "receiver.stream.replaced", null, "receiver");
      markReceiverDisconnected("replaced");
      try { receiverClient.end(); } catch {}
    }
    receiverClient = res;
    receiverState.connected = true;
    receiverState.last_disconnect_reason = null;
    receiverState.last_disconnect_at = 0;
    // A fresh connection can't be continuing a prior in-flight survey (the survey
    // worker lived in the previous session) — abort a stale "surveying" state.
    if (receiverState.base.state === "surveying") {
      receiverState.base = { state: "idle", point_id: null, survey: null, last_rtcm_at: 0, rtcm_bytes: 0 };
    }
    // Re-apply base config FIRST (it may flip mode to "base"), then broadcast once
    // so the UI doesn't show "capture" for a telemetry cycle after a base receiver
    // reconnects.
    reapplyReceiverBaseState();
    broadcastRoverStatus();

    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch {}
    }, 10000);
    req.on("close", () => {
      clearInterval(heartbeat);
      if (receiverClient === res) {
        receiverClient = null;
        markReceiverDisconnected("sse_closed");
        // A survey can't continue without the device — abort it so the UI doesn't
        // stay stuck on "surveying" (device telemetry no longer resets base.state).
        if (receiverState.base.state === "surveying") {
          receiverState.base = { state: "idle", point_id: null, survey: null, last_rtcm_at: 0, rtcm_bytes: 0 };
        }
        broadcastRoverStatus();
      }
    });
    return;
  }

  // 기존 연결이 있으면 종료(중복 스트림 방지). 진행 중이던 미션은 폐기하지
  // 않는다 — 로버는 끊겼다 재연결하는 동안에도 받은 waypoint로 자율 주행을
  // 계속하므로, 새 세션이 같은 미션을 그대로 이어받는다. (이전 동작은 여기서
  // endMission('error')로 미션을 통째로 버려, wifi 블립/pilot 재시작 한 번에
  // 진행상황이 사라지는 원인이었다.)
  if (roverClient && roverClient !== res) {
    // Session takeover — leave an audit trail (the old endMission path used to
    // log this; the mission itself is intentionally preserved for the new
    // session to inherit). The replaced connection's own req.on('close') can't
    // log it: roverClient has already been reassigned by then, so its
    // `roverClient === res` guard is false.
    logger.warn(req, "rover.stream.replaced", { mission_id: currentMissionId }, "rover");
    markRoverDisconnected("replaced");
    try { roverClient.end(); } catch {}
  }
  roverClient = res;
  roverState.connected = true;
  roverState.last_disconnect_reason = null;
  roverState.last_disconnect_at = 0;
  // The rover boots the pump off; keep the UI toggle in sync on (re)connect.
  roverState.pump_on = false;
  broadcastRoverStatus();

  // Re-apply the operator's nav-light choice so it survives a pilot restart.
  if (roverState.nav_lights_mode != null) {
    sendRoverEvent("nav-lights", { mode: roverState.nav_lights_mode });
  }
  if (roverState.led_brightness != null) {
    sendRoverEvent("led-brightness", { brightness: roverState.led_brightness });
  }
  // Re-apply the operator's pump dispense-time so it survives a pilot restart.
  if (roverState.pump_run_duration != null) {
    sendRoverEvent("pump-duration", { seconds: roverState.pump_run_duration });
  }
  // Re-apply the correction source (NGII vs receiver base station) so a base-station
  // selection survives a pilot restart / reconnect.
  applyNtripSource(getGpsConfig().ntrip_source);

  // 10s heartbeat (was 30s). The rover's SSE read timeout is 25s, so a dead
  // connection (Wi-Fi dropped → no FIN/RST) is detected within ~25s instead of
  // ~90s. Keep heartbeat ≤ read_timeout/2 so normal jitter never false-trips.
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch {}
  }, 10000);

  req.on("close", () => {
    clearInterval(heartbeat);
    if (roverClient === res) {
      roverClient = null;
      markRoverDisconnected("sse_closed");
      // The rover dropped off mid-mission. It keeps driving on its own and
      // will reconnect, so DON'T end the mission — flag it 'interrupted'
      // (resumable) and keep the persisted progress. The reconnecting rover's
      // first active telemetry flips it back to 'running'. This is what makes
      // the mission survive a wifi blip / pilot auto-update restart / reload.
      if (currentMissionId != null) {
        interruptMission();
        logger.warn(req, "mission.interrupted", { mission_id: currentMissionId, reason: "sse_disconnect" }, "rover");
      }
      broadcastRoverStatus();
    }
  });
});

// POST /api/rover/position - 로버/수신기가 현재 위치 전송 (기기가 호출, ?device=gps|rover)
app.post("/api/rover/position", (req, res) => {
  const device = req.query.device === "gps" ? "gps" : "rover";
  const { lat, lng, alt, request_id, request_ids } = req.body || {};

  // Cone-capture explicit failure: the device couldn't hold a stable RTK fix, so
  // resolve the pending request as FAILED (no coordinates) — the operator sees the
  // error immediately instead of waiting out the request timeout.
  if (req.body?.capture_failed) {
    const failIds = Array.isArray(request_ids) ? request_ids : [request_id];
    for (const id of failIds) {
      if (typeof id !== "string" || !id) continue;
      const idx = roverPendingResolves.findIndex((entry) => entry.request_id === id);
      if (idx !== -1) {
        const [{ resolve }] = roverPendingResolves.splice(idx, 1);
        resolve({ ok: false, error: typeof req.body.error === "string" ? req.body.error : "capture_failed" });
      }
    }
    return res.json({ ok: true });
  }

  const coordValidation = validateCoordinate(lat, lng);
  if (!coordValidation.valid) return res.status(400).send(coordValidation.error);
  const altValidation = validateAltitude(alt);
  if (!altValidation.valid) return res.status(400).send(altValidation.error);
  // RTK fix의 MSL 고도. lat/lng와 같은 fix에서 온 값이라 콘에 그대로 박아 둔다.
  const altValue = altValidation.value;
  const now = Date.now();

  if (device === "gps") {
    receiverState.last_position = { lat, lng, alt: altValue };
    receiverState.last_position_at = now;
  } else {
    lastRoverPosition = { lat, lng, alt: altValue, at: now };
    roverState.last_position = { lat, lng, alt: altValue };
    roverState.last_position_at = now;
  }

  // Resolve only the matching explicit admin request, regardless of which device
  // answered — request-position went to exactly one device, so only that device
  // echoes the id. Periodic position POSTs (no id) don't drain the queue.
  const ids = Array.isArray(request_ids) ? request_ids : [request_id];
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue;
    const idx = roverPendingResolves.findIndex((entry) => entry.request_id === id);
    if (idx !== -1) {
      const [{ resolve }] = roverPendingResolves.splice(idx, 1);
      resolve({ lat, lng, alt: altValue });
    }
  }

  // Mission telemetry is a rover-only concern (the receiver never drives).
  if (device === "rover" && currentMissionId != null) recordTelemetrySample();

  // Drive the live map marker only from the ACTIVE source, so a rover heartbeat
  // can't yank the marker off the receiver (the preferred source) or vice-versa.
  // Map device → source ("gps" is the receiver) so the payload's source matches
  // what the client discriminates on and the guard compares like-for-like.
  const liveSource = device === "gps" ? "receiver" : "rover";
  if (liveSource === activePositionSource()) {
    broadcastEvent("rover", { lat, lng, alt: altValue, source: liveSource });
  }
  broadcastRoverStatus();
  res.json({ lat, lng, alt: altValue });
});

// POST /api/rover/telemetry - 로버/수신기 상태 텔레메트리 (internal, ?device=gps|rover)
app.post("/api/rover/telemetry", (req, res) => {
  const device = req.query.device === "gps" ? "gps" : "rover";
  const { nav_state, fix_status, ntrip_connected, battery, ntrip, gps } = req.body || {};
  const now = Date.now();

  // Receiver telemetry has no mission lifecycle — it only refreshes the receiver's
  // fix/NTRIP/GPS snapshot. `mode` AND `base.state` are server-owned (driven by the
  // GPS-management config + survey/base commands + the survey-result callback), so
  // the device's telemetry `base.state`/`mode` are ignored here. The one exception
  // is the live survey sample count, which only the device knows.
  if (device === "gps") {
    if (typeof fix_status === "string") receiverState.fix_status = fix_status;
    if (typeof ntrip_connected === "boolean") {
      receiverState.ntrip_connected = ntrip_connected;
      if (ntrip_connected === false) receiverState.ntrip = null;
    }
    const gpsMetrics = sanitizeGpsMetrics(gps);
    if (gpsMetrics) receiverState.gps = gpsMetrics;
    const ntripDetail = sanitizeNtripDetail(ntrip);
    if (ntripDetail) receiverState.ntrip = ntripDetail;
    // Live survey progress: only accept the sample count while WE consider a
    // survey in progress (server-owned state), so it can't desync the rest.
    const bSamples = req.body?.base?.survey_samples;
    if (receiverState.base.state === "surveying" && receiverState.base.survey
        && Number.isInteger(bSamples)) {
      receiverState.base.survey.samples = bSamples;
    }
    broadcastRoverStatus();
    return res.json({ ok: true });
  }

  const prevNav = roverState.nav_state;
  if (typeof nav_state === "string") roverState.nav_state = nav_state;
  if (typeof fix_status === "string") {
    roverState.fix_status = fix_status;
    roverState.fix_status_at = now;
  }
  // Distinguish "not reported" (null/undefined) from "reported disconnected" (false).
  // When the rover explicitly says it's not connected, drop the cached detail
  // too — otherwise a previous boot's mountpoint + last_correction_at lingers
  // forever in memory and the UI keeps rendering it as a stale "보정 N s 전".
  if (typeof ntrip_connected === "boolean") {
    roverState.ntrip_connected = ntrip_connected;
    if (ntrip_connected === false) roverState.ntrip = null;
  }
  if (battery && typeof battery === "object") {
    roverState.battery = {
      voltage: typeof battery.voltage === "number" ? battery.voltage : null,
      voltage_raw: typeof battery.voltage_raw === "number" ? battery.voltage_raw : null,
      percent: Number.isInteger(battery.percent) ? battery.percent : null,
      source: typeof battery.source === "string" ? battery.source : null,
      gain: typeof battery.gain === "number" ? battery.gain : null,
      measured_v: typeof battery.measured_v === "number" ? battery.measured_v : null,
      calibrated_at: Number.isInteger(battery.calibrated_at) ? battery.calibrated_at : null,
      // Raw MCU status flag bitfield (T-frame flags 7). Lets the UI decode the
      // exact fault behind an ERROR / EMERGENCY_STOP chip — e-stop source,
      // undervolt, heartbeat timeout, nav-GPS-lost — the same conditions the
      // MCU status LED encodes by colour.
      flags: Number.isInteger(battery.flags) ? battery.flags : null,
    };
  }
  const gpsMetrics = sanitizeGpsMetrics(gps);
  if (gpsMetrics) roverState.gps = gpsMetrics;
  const ntripDetail = sanitizeNtripDetail(ntrip);
  if (ntripDetail) roverState.ntrip = ntripDetail;

  // Mission auto-resumed from an INTERRUPTED state: a rover that dropped mid-
  // mission and is reporting an active nav state again has clearly resumed
  // driving on its own — flip it back to 'running'. This also guards the
  // natural-completion check below: a rover that reconnected IDLE after a
  // reboot must NOT be auto-completed.
  //
  // 'paused' is deliberately NOT auto-flipped here: an operator pause is only
  // released by /api/rover/resume (which also commands the rover). A stray
  // active-nav telemetry frame arriving in the gap between the pause command
  // and the rover actually leaving NAVIGATING must not silently un-pause it.
  if (currentMissionId != null
      && roverState.mission_progress.status === "interrupted"
      && ACTIVE_NAV_STATES.has(nav_state)) {
    setMissionStatus.run("running", Date.now(), currentMissionId);
    roverState.mission_progress.status = "running";
    logger.log(req, "mission.resumed", { mission_id: currentMissionId, nav_state }, "rover");
  }

  // Reflect a rover-initiated pause that we DIDN'T already record (the obstacle
  // alert / pause command that would have flipped status was lost — e.g. an
  // uplink blip while the rover paused itself locally on an obstacle). This is
  // the running→paused direction only — it never auto-un-pauses (paused→running
  // stays operator-driven). The grace window prevents a stale PAUSED frame in
  // flight at resume time from bouncing a just-resumed mission back to paused.
  if (currentMissionId != null
      && (roverState.mission_progress.status === "running"
          || roverState.mission_progress.status === "interrupted")
      && nav_state === "PAUSED"
      && (now - roverLastResumeAt) > ROVER_PAUSE_RECONCILE_GRACE_MS) {
    setMissionStatus.run("paused", now, currentMissionId);
    roverState.mission_progress.status = "paused";
    // A rover reporting PAUSED that we didn't record as paused can only be an
    // obstacle auto-pause (an operator pause goes through /api/rover/pause, which
    // sets status=paused). This also rescues the 'interrupted + PAUSED' corner:
    // an SSE drop marks the mission interrupted, then the rover pauses itself on
    // an obstacle — without this it would stay interrupted (the reconnect
    // interrupted→running flip needs an ACTIVE nav state, which PAUSED is not)
    // and /api/rover/resume (requires 'paused') would 409. Raise the operator
    // alert too — the lost-POST backup must not pause silently. nearest_m
    // unknown on this path.
    roverState.obstacle = { active: true, at: now, nearest_m: null };
    broadcastEvent("rover:obstacle", { at: now, nearest_m: null, paused: true });
    logger.warn(req, "mission.paused.reconciled", { mission_id: currentMissionId }, "rover");
  }

  // Mission lifecycle: end on natural completion (driving → IDLE) or rover ERROR.
  // EMERGENCY_STOP is operator-acknowledged and *preserves* the mission across
  // the clear-emergency → IDLE transition so "이어서 실행" remains available.
  // Only auto-end a mission we believe is actively 'running' — an 'interrupted'
  // mission going IDLE (e.g. rover rebooted) stays resumable instead of being
  // falsely marked completed/error from a stale prevNav.
  // Operator must explicitly abandon via /api/rover/end-mission to commit.
  if (prevNav && prevNav !== "IDLE" && prevNav !== "EMERGENCY_STOP"
      && nav_state === "IDLE" && currentMissionId != null
      && roverState.mission_progress.status === "running") {
    const endStatus = prevNav === "ERROR" ? "error" : "completed";
    const endedId = currentMissionId;
    endMission(endStatus);
    if (endStatus === "completed") {
      logger.log(req, "mission.end.completed", { mission_id: endedId, prevNav }, "rover");
    } else {
      logger.warn(req, "mission.end.error", { mission_id: endedId, prevNav }, "rover");
    }
  }
  if (currentMissionId != null) recordTelemetrySample();

  broadcastRoverStatus();
  res.json({ ok: true });
});

// GET /api/rover/status - 로버+수신기 상태 스냅샷 (admin)
app.get("/api/rover/status", (req, res) => {
  res.json({
    ...roverState, receiver: { ...receiverState },
    position_source: activePositionSource(), ntrip_source: ntripSourceCache,
  });
});

// POST /api/rover/waypoint_reached - 로버가 웨이포인트 도달 알림 (internal)
app.post("/api/rover/waypoint_reached", (req, res) => {
  const index = Number(req.body?.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).send("올바르지 않은 waypoint index입니다.");
  }
  // 미션 자동 종료(driving→IDLE) 직후 늦게 도착할 수 있다. 진행 인덱스만
  // 전진시키는 이벤트라 종료 후엔 의미가 없으므로 에러 대신 no-op 처리한다.
  if (currentMissionId == null) {
    return res.json({ ok: true });
  }
  if (index >= roverState.mission_progress.waypoints.length) {
    logger.warn(req, "rover.waypoint_reached", { index, error: "index_out_of_range" }, "rover");
    return res.status(400).send("waypoint index가 현재 미션 범위를 벗어났습니다.");
  }
  // Monotonic: never regress current_waypoint_idx so late or duplicate events
  // from SSE reconnects can't walk progress backwards.
  if (index + 1 > roverState.mission_progress.current_waypoint_idx) {
    roverState.mission_progress.current_waypoint_idx = index + 1;
  }
  persistProgress();
  broadcastEvent("rover:waypoint", { index });
  res.json({ ok: true });
});

/* ============================================
   API 라우트: /api/missions (미션 이력)
   ============================================ */

const MISSION_LIST_MAX_LIMIT = 500;
const MISSION_LIST_DEFAULT_LIMIT = 50;
const selectMissions = db.prepare(
  `SELECT m.id, m.course_id, c.name AS course_name, m.started_at, m.ended_at, m.status, m.actor,
          (SELECT COUNT(*) FROM mission_telemetry t WHERE t.mission_id = m.id) AS sample_count
   FROM mission m LEFT JOIN course c ON c.id = m.course_id
   ORDER BY m.started_at DESC LIMIT ? OFFSET ?`
);
const countMissions = db.prepare("SELECT COUNT(*) AS cnt FROM mission");
const selectMissionById = db.prepare(
  `SELECT m.id, m.course_id, c.name AS course_name, m.started_at, m.ended_at, m.status,
          m.waypoints_json, m.actor
   FROM mission m LEFT JOIN course c ON c.id = m.course_id WHERE m.id = ?`
);
const selectMissionTelemetry = db.prepare(
  `SELECT t, lat, lng, fix_status, nav_state, ntrip_connected, corr_age_ms, ntrip_fail_count, h_acc_m, altitude_m, v_acc_m
   FROM mission_telemetry WHERE mission_id = ? ORDER BY t`
);

app.get("/api/missions", (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || MISSION_LIST_DEFAULT_LIMIT, MISSION_LIST_MAX_LIMIT));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = selectMissions.all(limit, offset);
  const total = countMissions.get().cnt;
  res.json({ missions: rows, total, limit, offset });
});

app.get("/api/missions/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send("올바르지 않은 id입니다.");
  const mission = selectMissionById.get(id);
  if (!mission) return res.status(404).send("미션을 찾을 수 없습니다.");
  let waypoints = [];
  try { waypoints = JSON.parse(mission.waypoints_json); } catch { /* ignore */ }
  res.json({
    id: mission.id,
    course_id: mission.course_id,
    course_name: mission.course_name,
    started_at: mission.started_at,
    ended_at: mission.ended_at,
    status: mission.status,
    actor: mission.actor,
    waypoints,
  });
});

app.get("/api/missions/:id/telemetry", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send("올바르지 않은 id입니다.");
  const mission = selectMissionById.get(id);
  if (!mission) return res.status(404).send("미션을 찾을 수 없습니다.");
  const samples = selectMissionTelemetry.all(id);
  res.json({ samples });
});

// Rover log cache — in-memory only. Filled by rover POST, drained by admin GET.
const MAX_ROVER_LOG_ENTRIES = 1000;
let roverLogCache = { entries: [], uploaded_at: 0 };

// POST /api/rover/logs - 로버 로그 업로드 (internal)
app.post("/api/rover/logs", (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!entries) return res.status(400).send("올바르지 않은 로그 데이터입니다.");
  const sanitized = entries
    .filter((e) => e && typeof e === "object")
    .slice(-MAX_ROVER_LOG_ENTRIES)
    .map((e) => ({
      t: Number(e.t) || 0,
      level: typeof e.level === "string" ? e.level.slice(0, 10) : "",
      node: typeof e.node === "string" ? e.node.slice(0, 64) : "",
      msg: typeof e.msg === "string" ? e.msg.slice(0, 2000) : "",
    }));
  roverLogCache = { entries: sanitized, uploaded_at: Date.now() };
  broadcastEvent("rover:logs", { count: sanitized.length, uploaded_at: roverLogCache.uploaded_at });
  res.json({ ok: true, stored: sanitized.length });
});

// GET /api/rover/logs - 최근 업로드된 로그 조회 (admin)
app.get("/api/rover/logs", (req, res) => {
  res.json(roverLogCache);
});

// POST /api/rover/logs/fetch - 로버에 로그 업로드 요청 (admin → SSE)
app.post("/api/rover/logs/fetch", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.logs.fetch");
  if (!sendRoverEvent("fetch-logs", {})) {
    logger.warn(req, "rover.logs.fetch", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.logs.fetch", null, "rover");
  res.json({ ok: true });
});

// POST /api/rover/spray_result - 로버가 스프레이 결과 보고 (internal)
const SPRAY_OUTCOMES = new Set(["success", "cancelled", "timeout"]);
app.post("/api/rover/spray_result", (req, res) => {
  const index = Number(req.body?.waypoint);
  const outcome = req.body?.outcome;
  if (!Number.isInteger(index) || index < 0 || !SPRAY_OUTCOMES.has(outcome)) {
    return res.status(400).send("올바르지 않은 spray_result 데이터입니다.");
  }
  // 마지막 waypoint의 spray_result는 미션이 driving→IDLE로 자동 종료된 직후에
  // 도착할 수 있다(로버의 spray-post 스레드와 telemetry 스레드가 별도라 순서
  // 보장 없음). 그 경우에도 live 결과(last_spray_result + 브로드캐스트)는
  // 기록해 마지막 콘 결과가 유실되지 않게 하고, mission_progress는 미션이
  // 활성일 때만 변경한다.
  if (currentMissionId != null) {
    if (index >= roverState.mission_progress.waypoints.length) {
      logger.warn(req, "rover.spray_result", { index, outcome, error: "index_out_of_range" }, "rover");
      return res.status(400).send("waypoint index가 현재 미션 범위를 벗어났습니다.");
    }
    roverState.mission_progress.spray_results[String(index)] = outcome;
    persistProgress();
  }
  roverState.last_spray_result = { waypoint: index, outcome, at: Date.now() };
  broadcastEvent("rover:spray", { waypoint: index, outcome, at: roverState.last_spray_result.at });
  broadcastRoverStatus();
  res.json({ ok: true });
});

// POST /api/rover/request - 관리자가 콘 좌표 요청 (프론트엔드가 호출)
// 대상은 activePositionSource()와 동일하게 고른다 — 즉 수신기는 캡처 모드 + 실제
// 라이브 위치가 있을 때만 우선하고, 그 외에는 로버로 폴백한다. (라우팅이 아이콘/FAB이
// 쓰는 정본과 어긋나면, fix 없는 수신기로 보내 로버를 두고 504로 타임아웃할 수 있다.)
app.post("/api/rover/request", async (req, res) => {
  const target = activePositionSource();
  if (!target) {
    return rejectNoRover(req, res, "rover.request");
  }

  if (roverPendingResolves.length >= ROVER_MAX_PENDING_REQUESTS) {
    logger.warn(req, "rover.request", { error: "queue_full", pending: roverPendingResolves.length }, "rover");
    return res.status(503).send("위치 요청이 많아 대기 중입니다.");
  }

  const request_id = crypto.randomUUID();
  let removeFromQueue;
  const pending = new Promise((resolve) => {
    const entry = { request_id, resolve, createdAt: Date.now() };
    roverPendingResolves.push(entry);
    removeFromQueue = () => {
      const idx = roverPendingResolves.indexOf(entry);
      if (idx !== -1) roverPendingResolves.splice(idx, 1);
    };
  });

  const sent = target === "receiver"
    ? sendReceiverEvent("request-position", { request_id })
    : sendRoverEvent("request-position", { request_id });
  if (!sent) {
    if (removeFromQueue) removeFromQueue();
    logger.warn(req, "rover.request", { error: "connection_lost", target }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  const position = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
  ]).catch(() => null);

  if (removeFromQueue) removeFromQueue();

  if (!position) {
    logger.warn(req, "rover.request", { result: "timeout", target }, "rover");
    return res.status(504).send("로버 응답 시간 초과");
  }
  if (position.ok === false) {
    logger.warn(req, "rover.request", { result: "capture_failed", error: position.error, target }, "rover");
    return res.status(422).send("위치 캡처 실패: 안정된 RTK 고정을 얻지 못했습니다.");
  }
  logger.log(req, "rover.request", { lat: position.lat, lng: position.lng, alt: position.alt, source: target }, "rover");
  // Return which source actually answered so the client marks the cone on the
  // right device marker deterministically (not from possibly-flipped live state).
  res.json({ ...position, source: target });
});

function sendRoverEvent(event, data) {
  if (!roverClient) return false;
  try {
    roverClient.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    try { roverClient.end(); } catch {}
    roverClient = null;
    markRoverDisconnected("write_failed");
    logger.warn(null, "rover.stream.write_failed", { event }, "rover");
    broadcastRoverStatus();
    return false;
  }
}

function sendReceiverEvent(event, data) {
  if (!receiverClient) return false;
  try {
    receiverClient.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    try { receiverClient.end(); } catch {}
    receiverClient = null;
    markReceiverDisconnected("write_failed");
    logger.warn(null, "receiver.stream.write_failed", { event }, "receiver");
    broadcastRoverStatus();
    return false;
  }
}

/* ============================================
   GPS 관리: 수신기 소스 선택 + base station 측량점
   ============================================ */

const getGpsConfigStmt = db.prepare("SELECT value FROM gps_config WHERE key = ?");
const setGpsConfigStmt = db.prepare(
  "INSERT INTO gps_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);
function gpsConfigGet(key, def = null) {
  const row = getGpsConfigStmt.get(key);
  return row && row.value != null ? row.value : def;
}
function getGpsConfig() {
  const ntrip_source = gpsConfigGet("ntrip_source", "ngii") === "base" ? "base" : "ngii";
  const raw = gpsConfigGet("active_base_point_id", null);
  const active_base_point_id =
    raw != null && raw !== "" && Number.isInteger(Number(raw)) ? Number(raw) : null;
  return { ntrip_source, active_base_point_id };
}
// Prime the hot-path cache from the persisted config at boot.
ntripSourceCache = getGpsConfig().ntrip_source;

const listSurveyPointsStmt = db.prepare("SELECT * FROM survey_point ORDER BY id");
const getSurveyPointStmt = db.prepare("SELECT * FROM survey_point WHERE id = ?");
const insertSurveyPointStmt = db.prepare("INSERT INTO survey_point (name) VALUES (?)");
const deleteSurveyPointStmt = db.prepare("DELETE FROM survey_point WHERE id = ?");
const updateSurveyPointResultStmt = db.prepare(
  `UPDATE survey_point
     SET lat = ?, lng = ?, alt = ?, h_acc_m = ?, samples = ?,
         surveyed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = ?`
);

const SURVEY_DEFAULT_DURATION_S = 120;
const SURVEY_MIN_DURATION_S = 10;
const SURVEY_MAX_DURATION_S = 1800;

// 로버에 어떤 보정 소스를 쓸지 알린다(NGII vs 수신기 base). 로버 미연결이면
// no-op — 로버 재연결 시 stream 핸들러에서 재적용된다.
function applyNtripSource(source) {
  sendRoverEvent("ntrip-source", { source: source === "base" ? "base" : "ngii" });
}

// 수신기를 기준국으로 전환하고(측량 좌표로 F9P TMODE3 FIXED) 로버를 base 소스로 돌린다.
function activateBase(point) {
  receiverState.mode = "base";
  receiverState.base = {
    state: "active", point_id: point.id, survey: null, last_rtcm_at: 0, rtcm_bytes: 0,
  };
  sendReceiverEvent("base-activate", {
    point_id: point.id, lat: point.lat, lng: point.lng, alt: point.alt, acc: point.h_acc_m,
  });
  applyNtripSource("base");
}

// 수신기를 캡처 모드로 되돌리고 로버를 NGII 소스로 돌린다.
function deactivateBase() {
  receiverState.mode = "capture";
  receiverState.base = { state: "idle", point_id: null, survey: null, last_rtcm_at: 0, rtcm_bytes: 0 };
  sendReceiverEvent("base-stop", {});
  applyNtripSource("ngii");
}

// 수신기 재연결 시 서버가 소유한 base 설정을 재적용한다. base 소스이고 활성
// 측량점에 좌표가 있으면 기준국으로, 아니면 캡처 모드로 둔다. (stream 핸들러에서 호출)
function reapplyReceiverBaseState() {
  const cfg = getGpsConfig();
  if (cfg.ntrip_source === "base" && cfg.active_base_point_id != null) {
    const point = getSurveyPointStmt.get(cfg.active_base_point_id);
    if (point && point.lat != null && point.lng != null) {
      activateBase(point);
      return;
    }
  }
  receiverState.mode = "capture";
}

// GET /api/gps/config - 현재 GPS 소스 설정 (admin)
app.get("/api/gps/config", (req, res) => {
  res.json(getGpsConfig());
});

// PUT /api/gps/config - GPS 소스 설정 변경 (admin)
app.put("/api/gps/config", (req, res) => {
  const { ntrip_source, active_base_point_id } = req.body || {};
  if (ntrip_source !== "ngii" && ntrip_source !== "base") {
    return res.status(400).send("ntrip_source는 'ngii' 또는 'base'여야 합니다.");
  }
  let point = null;
  if (ntrip_source === "base") {
    const pid = Number(active_base_point_id);
    if (!Number.isInteger(pid)) {
      return res.status(400).send("base 소스에는 측량점을 지정해야 합니다.");
    }
    point = getSurveyPointStmt.get(pid);
    if (!point) return res.status(404).send("측량점을 찾을 수 없습니다.");
    if (point.lat == null || point.lng == null) {
      logger.warn(req, "gps.config.update", { error: "point_not_surveyed", point_id: pid }, "gps");
      return res.status(400).send("아직 측량되지 않은 지점입니다. 먼저 위치를 측량하세요.");
    }
  }
  const result = dbRun(() => {
    setGpsConfigStmt.run("ntrip_source", ntrip_source);
    setGpsConfigStmt.run("active_base_point_id", point ? String(point.id) : "");
  });
  if (!result.success) {
    logger.warn(req, "gps.config.update", { error: result.error }, "gps");
    return res.status(result.status).send(result.error);
  }
  ntripSourceCache = ntrip_source;
  // 저장 후 즉시 기기에 반영.
  if (point) activateBase(point); else deactivateBase();
  logger.log(req, "gps.config.update",
    { ntrip_source, active_base_point_id: point ? point.id : null }, "gps");
  // Selecting base with no receiver connected strands the rover: NGII is
  // suppressed but no base RTCM will flow. Not an error (operator's choice), but
  // audit it — the UI also shows a persistent warning.
  if (ntrip_source === "base" && !receiverClient) {
    logger.warn(req, "gps.config.update",
      { warning: "base_selected_no_receiver", active_base_point_id: point ? point.id : null }, "gps");
  }
  broadcastRoverStatus();
  res.json(getGpsConfig());
});

// GET /api/gps/survey-points - 측량점 목록 (admin)
app.get("/api/gps/survey-points", (req, res) => {
  res.json({ points: listSurveyPointsStmt.all() });
});

// POST /api/gps/survey-points - 측량점 추가(이름만) (admin)
app.post("/api/gps/survey-points", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).send("측량점 이름이 비어 있습니다.");
  if (name.length > 100) return res.status(400).send("측량점 이름이 너무 깁니다.");
  const result = dbRun(() => {
    const info = insertSurveyPointStmt.run(name);
    return getSurveyPointStmt.get(Number(info.lastInsertRowid));
  });
  if (!result.success) {
    logger.warn(req, "gps.survey_point.create", { error: result.error }, name);
    return res.status(result.status).send(
      result.error?.includes("UNIQUE") ? "이미 존재하는 측량점 이름입니다." : result.error);
  }
  logger.log(req, "gps.survey_point.create", null, name);
  broadcastRoverStatus();
  res.status(201).json(result.result);
});

// DELETE /api/gps/survey-points/:id - 측량점 삭제 (admin)
app.delete("/api/gps/survey-points/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send("올바르지 않은 id입니다.");
  const point = getSurveyPointStmt.get(id);
  if (!point) return res.status(404).send("측량점을 찾을 수 없습니다.");
  const cfg = getGpsConfig();
  if (cfg.ntrip_source === "base" && cfg.active_base_point_id === id) {
    return res.status(409).send("현재 기준국으로 사용 중인 측량점입니다. 먼저 NGII 소스로 전환하세요.");
  }
  const result = dbRun(() => deleteSurveyPointStmt.run(id));
  if (!result.success) {
    logger.warn(req, "gps.survey_point.delete", { error: result.error, id }, point.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "gps.survey_point.delete", { id }, point.name);
  broadcastRoverStatus();
  res.json({ ok: true });
});

// POST /api/gps/survey-points/:id/survey - 수신기 위치 측량 시작 (admin)
app.post("/api/gps/survey-points/:id/survey", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send("올바르지 않은 id입니다.");
  const point = getSurveyPointStmt.get(id);
  if (!point) return res.status(404).send("측량점을 찾을 수 없습니다.");
  if (!receiverClient) {
    logger.warn(req, "gps.survey.start", { error: "receiver_not_connected", id }, point.name);
    return res.status(503).send("GPS 수신기가 연결되어 있지 않습니다.");
  }
  if (receiverState.mode === "base") {
    return res.status(409).send("수신기가 기준국으로 사용 중입니다. 먼저 NGII 소스로 전환하세요.");
  }
  if (receiverState.base.state === "surveying") {
    logger.warn(req, "gps.survey.start",
      { error: "already_surveying", id, in_progress: receiverState.base.point_id }, point.name);
    return res.status(409).send("이미 측량이 진행 중입니다.");
  }
  let duration = Number(req.body?.duration_s);
  if (!Number.isFinite(duration)) duration = SURVEY_DEFAULT_DURATION_S;
  duration = Math.max(SURVEY_MIN_DURATION_S, Math.min(Math.round(duration), SURVEY_MAX_DURATION_S));
  if (!sendReceiverEvent("base-survey-start", { point_id: id, duration_s: duration })) {
    logger.warn(req, "gps.survey.start", { error: "connection_lost", id }, point.name);
    return res.status(503).send("수신기 연결이 끊어졌습니다.");
  }
  receiverState.base = {
    state: "surveying", point_id: id,
    survey: { started_at: Date.now(), duration_s: duration, samples: 0 },
    last_rtcm_at: 0, rtcm_bytes: 0,
  };
  logger.log(req, "gps.survey.start", { id, duration_s: duration }, point.name);
  broadcastRoverStatus();
  res.json({ ok: true, duration_s: duration });
});

// POST /api/gps/survey-points/:id/survey/cancel - 측량 취소 (admin)
app.post("/api/gps/survey-points/:id/survey/cancel", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send("올바르지 않은 id입니다.");
  sendReceiverEvent("base-survey-cancel", { point_id: id });
  if (receiverState.base.state === "surveying" && receiverState.base.point_id === id) {
    receiverState.base = { state: "idle", point_id: null, survey: null, last_rtcm_at: 0, rtcm_bytes: 0 };
  }
  logger.log(req, "gps.survey.cancel", { id }, "gps");
  broadcastRoverStatus();
  res.json({ ok: true });
});

// POST /api/rover/base/survey-result - 수신기가 측량 결과 보고 (internal)
// 성공/실패 모두 보고된다: 성공이면 좌표 저장, 실패(ok:false, 예: rtk_fixed 샘플 0)면
// 좌표는 그대로 두고 실패를 UI에 알린다. 어느 쪽이든 surveying 상태를 idle로 되돌린다.
app.post("/api/rover/base/survey-result", (req, res) => {
  const { point_id, ok, lat, lng, alt, h_acc, samples, error } = req.body || {};
  const id = Number(point_id);
  if (!Number.isInteger(id)) return res.status(400).send("올바르지 않은 point_id입니다.");
  const point = getSurveyPointStmt.get(id);
  if (!point) {
    logger.warn(req, "gps.survey.result", { error: "point_not_found", id }, "gps");
    return res.status(404).send("측량점을 찾을 수 없습니다.");
  }
  // Clear the surveying state for this point regardless of outcome.
  if (receiverState.base.state === "surveying" && receiverState.base.point_id === id) {
    receiverState.base = { state: "idle", point_id: null, survey: null, last_rtcm_at: 0, rtcm_bytes: 0 };
  }

  // Failure (e.g. no RTK-fixed samples): leave the point's coordinate untouched
  // and surface the failure to the operator UI.
  if (ok === false) {
    const reason = typeof error === "string" ? error.slice(0, 64) : "survey_failed";
    logger.warn(req, "gps.survey.result", { id, ok: false, error: reason }, point.name);
    broadcastEvent("gps:survey_result", { point_id: id, name: point.name, ok: false, error: reason });
    broadcastRoverStatus();
    return res.json({ ok: true });
  }

  // Success: record the surveyed coordinate. An ok:true report with bad coords is
  // an internal-callback contract violation — log it (CLAUDE.md rule 5) before 400.
  const coordValidation = validateCoordinate(lat, lng);
  if (!coordValidation.valid) {
    logger.warn(req, "gps.survey.result", { error: coordValidation.error, id, ok: true }, point.name);
    return res.status(400).send(coordValidation.error);
  }
  const altValue = typeof alt === "number" && Number.isFinite(alt) ? alt : null;
  const hAccValue = typeof h_acc === "number" && Number.isFinite(h_acc) ? h_acc : null;
  const sampleCount = Number.isInteger(samples) ? samples : null;
  const result = dbRun(() =>
    updateSurveyPointResultStmt.run(lat, lng, altValue, hAccValue, sampleCount, id));
  if (!result.success) {
    logger.warn(req, "gps.survey.result", { error: result.error, id }, point.name);
    return res.status(result.status).send(result.error);
  }
  logger.log(req, "gps.survey.result",
    { id, lat, lng, alt: altValue, h_acc: hAccValue, samples: sampleCount }, point.name);
  broadcastEvent("gps:survey_result", { point_id: id, name: point.name, ok: true, samples: sampleCount });
  broadcastRoverStatus();
  res.json({ ok: true });
});

// POST /api/rover/base/rtcm - 수신기(기준국)가 RTCM 청크 전송 → 로버로 릴레이 (internal)
// hot path: 초당 여러 번 호출되므로 broadcastRoverStatus는 하지 않는다(주기 텔레메트리가 UI 갱신).
app.post("/api/rover/base/rtcm", (req, res) => {
  const data = req.body?.data;
  if (typeof data !== "string" || !data) return res.status(400).send("RTCM data가 비어 있습니다.");
  receiverState.base.last_rtcm_at = Date.now();
  // base64 길이로 대략적 바이트 누적(원바이트 수 근사, 링크 활성 지표로 충분).
  receiverState.base.rtcm_bytes += Math.floor((data.length * 3) / 4);
  // 로버 연결 시에만 릴레이. 미연결이면 드롭(로버 재연결 시 자연 재개).
  if (roverClient) sendRoverEvent("rtcm", { data });
  res.json({ ok: true });
});

function validateWaypointDistances(waypoints) {
  // 첫 waypoint와 최신 rover 위치 간 거리 검증
  if (lastRoverPosition && Date.now() - lastRoverPosition.at < ROVER_POSITION_STALE_MS) {
    const d0 = haversine(lastRoverPosition, waypoints[0]);
    if (d0 > ROVER_MAX_WAYPOINT_DIST_M) {
      return { valid: false, reason: "first_waypoint_far", distance: d0 };
    }
  }
  // 인접 세그먼트 거리 검증 + 중복(<5cm) 제거
  const cleaned = [waypoints[0]];
  for (let i = 1; i < waypoints.length; i++) {
    const d = haversine(cleaned[cleaned.length - 1], waypoints[i]);
    if (d < ROVER_MIN_SEGMENT_DIST_M) continue; // 중복 제거
    if (d > ROVER_MAX_SEGMENT_DIST_M) {
      return { valid: false, reason: "segment_too_long", distance: d, index: i };
    }
    cleaned.push(waypoints[i]);
  }
  if (waypoints.length > 1 && cleaned.length < 2) {
    return { valid: false, reason: "path_degenerate", distance: 0 };
  }
  return { valid: true, waypoints: cleaned };
}

// POST /api/rover/execute - 경로 실행 (waypoint 전송)
app.post("/api/rover/execute", (req, res) => {
  const { waypoints, force } = req.body;
  if (!Array.isArray(waypoints) || waypoints.length === 0 || waypoints.length > 10000) {
    return res.status(400).send("올바르지 않은 waypoint 데이터입니다.");
  }
  if (force === true) {
    logger.warn(req, "rover.execute.force", {
      fix_status: roverState.fix_status,
      ntrip_connected: roverState.ntrip_connected,
      waypoint_count: waypoints.length,
    }, "rover");
  }

  for (const wp of waypoints) {
    const v = validateCoordinate(wp.lat, wp.lng);
    if (!v.valid) return res.status(400).send(v.error);
  }

  const distCheck = validateWaypointDistances(waypoints);
  if (!distCheck.valid) {
    const msg = distCheck.reason === "first_waypoint_far"
      ? `로버 현재 위치에서 첫 웨이포인트까지 ${distCheck.distance.toFixed(1)}m로 너무 멉니다 (최대 ${ROVER_MAX_WAYPOINT_DIST_M}m).`
      : distCheck.reason === "path_degenerate"
        ? `웨이포인트가 모두 ${ROVER_MIN_SEGMENT_DIST_M * 100}cm 이내로 겹쳐 실행할 경로가 없습니다.`
        : `${distCheck.index}번 웨이포인트 인접 거리가 ${distCheck.distance.toFixed(1)}m로 너무 큽니다 (최대 ${ROVER_MAX_SEGMENT_DIST_M}m).`;
    logger.warn(req, "rover.execute", { error: msg, reason: distCheck.reason, distance: distCheck.distance }, "rover");
    return res.status(400).send(msg);
  }
  const finalWaypoints = distCheck.waypoints;

  if (!roverClient) return rejectNoRover(req, res, "rover.execute");

  // 비상정지 래치가 걸린 상태에서는 새 경로 송신을 거부한다. 운영자가 먼저
  // "비상정지 해제"를 눌러 명시적으로 인지·해제한 뒤에만 다음 동작을 허용해
  // 이중 운영자 시나리오에서 우회 출발이 발생하지 않도록 한다.
  if (roverState.nav_state === "EMERGENCY_STOP") {
    logger.warn(req, "rover.execute", { error: "in_emergency_stop" }, "rover");
    return res.status(409).send("비상정지 상태입니다. 먼저 해제 후 실행하세요.");
  }

  if (!sendRoverEvent("execute-path", { waypoints: finalWaypoints })) {
    logger.warn(req, "rover.execute", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  const actor = req.user ? `${req.user.name || ""} <${req.user.email || ""}>` : null;
  const courseId = Number.isInteger(req.body?.course_id) ? req.body.course_id : null;
  const course = courseId != null ? getCourseById(courseId) : null;
  if (courseId != null && course) {
    try {
      const snapshotId = takeCourseSnapshot(courseId, actor, `auto: execute mission`);
      if (snapshotId != null) {
        logger.log(req, "course.snapshot.auto", { snapshot_id: snapshotId, course_id: courseId }, course?.name);
      }
    }
    catch (err) { logger.warn(req, "course.snapshot.auto", { error: String(err) }, `course#${courseId}`); }
  }
  startMission(finalWaypoints, actor, courseId);

  logger.log(req, "rover.execute", {
    waypoint_count: finalWaypoints.length,
    dropped: waypoints.length - finalWaypoints.length,
    mission_id: currentMissionId,
  }, "rover");
  res.json({ sent: finalWaypoints.length, waypoints: finalWaypoints, mission_id: currentMissionId });
});

// POST /api/rover/stop - 비상정지
app.post("/api/rover/stop", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.stop");

  if (!sendRoverEvent("emergency-stop", {})) {
    logger.warn(req, "rover.stop", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  logger.log(req, "rover.stop", null, "rover");
  res.json({ stopped: true });
});

// POST /api/rover/pause - 미션 소프트 일시정지 (E-Stop 아님)
// 자율 주행을 멈추되 MCU 래치를 걸지 않아 수동 제어가 가능하다. 진행상황은
// 보존되고 /api/rover/resume 로 현재 waypoint부터 이어서 주행한다. 장애물
// 발견 시 운영자가 멈추고 수동으로 비켜 운전한 뒤 재개하는 흐름의 핵심.
app.post("/api/rover/pause", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.pause");
  if (currentMissionId == null || roverState.mission_progress.status !== "running") {
    logger.warn(req, "rover.pause",
      { error: "no_running_mission", status: roverState.mission_progress.status }, "rover");
    return res.status(409).send("일시정지할 진행 중인 미션이 없습니다.");
  }
  if (!sendRoverEvent("pause-mission", {})) {
    logger.warn(req, "rover.pause", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  setMissionStatus.run("paused", Date.now(), currentMissionId);
  roverState.mission_progress.status = "paused";
  broadcastRoverStatus();
  logger.log(req, "rover.pause", { mission_id: currentMissionId }, "rover");
  res.json({ paused: true });
});

// POST /api/rover/resume - 일시정지된 미션 재개 (현재 waypoint부터 이어 주행)
app.post("/api/rover/resume", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.resume");
  if (currentMissionId == null || roverState.mission_progress.status !== "paused") {
    logger.warn(req, "rover.resume",
      { error: "not_paused", status: roverState.mission_progress.status }, "rover");
    return res.status(409).send("재개할 일시정지된 미션이 없습니다.");
  }
  if (!sendRoverEvent("resume-mission", {})) {
    logger.warn(req, "rover.resume", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  setMissionStatus.run("running", Date.now(), currentMissionId);
  roverState.mission_progress.status = "running";
  // Clear any obstacle hold and open the reconcile grace window so a stale
  // PAUSED telemetry frame in flight can't immediately re-pause the mission.
  roverState.obstacle = { active: false, at: 0, nearest_m: null };
  roverLastResumeAt = Date.now();
  broadcastRoverStatus();
  logger.log(req, "rover.resume", { mission_id: currentMissionId }, "rover");
  res.json({ resumed: true });
});

// POST /api/rover/obstacle - perception이 주행 경로 장애물 감지 보고 (internal)
// 로버는 이미 ROS로 미션을 로컬 PAUSE했다(서버 왕복·blip 무관). 이 엔드포인트는
// 사람 대응 부분만 담당: (1) 미션 상태를 paused로 미러링해 재개 버튼을 활성화,
// (2) 운영자에게 경보를 broadcast해 배너 + 카메라 자동 표시를 트리거한다.
// pause-mission SSE는 보내지 않는다 — 로버가 스스로 멈췄으므로 중복 명령이다.
app.post("/api/rover/obstacle", (req, res) => {
  const body = req.body || {};
  const nearest = typeof body.nearest_m === "number" ? body.nearest_m : null;
  const at = Date.now();
  // No active mission → nothing to pause, and an alert nothing could clear. A
  // best-effort obstacle POST from the final NAVIGATING cycle can land just
  // after the mission ended (endMission nulled currentMissionId); raising the
  // persistent banner then would stick until the next mission (resume 409s).
  // No-op, mirroring /api/rover/waypoint_reached.
  if (currentMissionId == null) {
    return res.json({ ok: true, paused: false });
  }
  // Drop a stale obstacle POST that was in flight when the operator just
  // resumed: reflecting it would re-pause + re-alert a mission they deliberately
  // resumed (the rover already cleared its local obstacle edge on resume). Same
  // grace window the telemetry reconcile uses. If the obstacle genuinely
  // persists, the rover re-pauses LOCALLY and the post-grace telemetry reconcile
  // mirrors it — nothing is permanently lost.
  if (at - roverLastResumeAt <= ROVER_PAUSE_RECONCILE_GRACE_MS) {
    logger.log(req, "rover.obstacle", { ignored: "resume_grace" }, "rover");
    return res.json({ ok: true, paused: false, ignored: true });
  }
  // Mirror the rover's local pause so /api/rover/resume (status==='paused') is
  // reachable. From 'running' or 'interrupted' (the rover can pause itself on an
  // obstacle while its mission SSE is briefly dropped); never command the rover.
  let reflected = false;
  if (currentMissionId != null
      && (roverState.mission_progress.status === "running"
          || roverState.mission_progress.status === "interrupted")) {
    setMissionStatus.run("paused", at, currentMissionId);
    roverState.mission_progress.status = "paused";
    reflected = true;
  }
  roverState.obstacle = { active: true, at, nearest_m: nearest };
  broadcastRoverStatus();
  // Discrete alert: drives the one-shot banner + camera auto-open in the UI
  // (late joiners still see it via roverState.obstacle in the status snapshot).
  broadcastEvent("rover:obstacle", { at, nearest_m: nearest, paused: reflected });
  logger.warn(req, "rover.obstacle",
    { mission_id: currentMissionId, nearest_m: nearest, reflected }, "rover");
  res.json({ ok: true, paused: reflected });
});

// POST /api/rover/calibrate-stereo - 운영자가 스테레오 카메라 교정 시작 (admin)
// 명령을 perception의 카메라 control SSE로 보낸다 → 로버가 그 자리에서 양안으로
// 체커보드를 수집·계산·저장하고 detector를 재로드한다. 진행/결과는 perception이
// /api/rover/calibration-progress 로 회신해 UI에 표시된다.
app.post("/api/rover/calibrate-stereo", (req, res) => {
  const sq = Number(req.body?.square_m);
  if (!Number.isFinite(sq) || sq < 0.005 || sq > 0.2) {
    return res.status(400).send("정사각 한 칸 크기(square_m)는 0.005~0.2 m 범위의 숫자여야 합니다.");
  }
  if (!cameraControlClient) {
    logger.warn(req, "rover.calibrate_stereo", { error: "perception_not_connected" }, "rover");
    return res.status(503).send("카메라(perception)가 연결되어 있지 않습니다.");
  }
  if (!sendCameraControl("calibrate", { square_m: sq })) {
    logger.warn(req, "rover.calibrate_stereo", { error: "write_failed" }, "rover");
    return res.status(503).send("카메라 제어 채널 전송에 실패했습니다.");
  }
  roverState.stereo_calibration = {
    status: "running", phase: "start", captured: 0, target: null,
    rms: null, baseline_mm: null, pairs: null, error: null,
    square_m: sq, at: Date.now(),
  };
  broadcastRoverStatus();
  logger.log(req, "rover.calibrate_stereo", { square_m: sq }, "rover");
  res.json({ ok: true });
});

// POST /api/rover/calibrate-ground - 운영자가 지면 교정 시작 (admin). above-ground
// 검출기의 행별 기대 지면 깊이 곡선을 뜬다. 스테레오 교정(미터 깊이)이 선행돼야 하며,
// 없으면 perception이 done ok:false로 회신한다. 진행/결과는 calibration-progress
// (kind:"ground")로 회신돼 UI에 표시된다.
app.post("/api/rover/calibrate-ground", (req, res) => {
  let frames = Number(req.body?.frames);
  frames = Number.isFinite(frames) ? Math.max(10, Math.min(120, Math.round(frames))) : 30;
  if (!cameraControlClient) {
    logger.warn(req, "rover.calibrate_ground", { error: "perception_not_connected" }, "rover");
    return res.status(503).send("카메라(perception)가 연결되어 있지 않습니다.");
  }
  if (!sendCameraControl("calibrate-ground", { frames })) {
    logger.warn(req, "rover.calibrate_ground", { error: "write_failed" }, "rover");
    return res.status(503).send("카메라 제어 채널 전송에 실패했습니다.");
  }
  roverState.ground_calibration = {
    status: "running", phase: "start", captured: 0, target: frames,
    near_m: null, far_m: null, rows: null, error: null, at: Date.now(),
  };
  broadcastRoverStatus();
  logger.log(req, "rover.calibrate_ground", { frames }, "rover");
  res.json({ ok: true });
});

// POST /api/rover/calibration-progress - perception이 교정 진행/결과 보고 (internal).
// kind:"ground"면 지면 교정, 아니면(기본) 스테레오 교정 상태로 라우팅한다.
app.post("/api/rover/calibration-progress", (req, res) => {
  const b = req.body || {};
  const phase = typeof b.phase === "string" ? b.phase : "";
  const done = phase === "done";
  if (b.kind === "ground") {
    roverState.ground_calibration = {
      status: done ? (b.ok ? "done" : "failed") : "running",
      phase,
      captured: Number.isInteger(b.captured) ? b.captured : null,
      target: Number.isInteger(b.target) ? b.target : null,
      near_m: typeof b.near_m === "number" ? b.near_m : null,
      far_m: typeof b.far_m === "number" ? b.far_m : null,
      rows: Number.isInteger(b.rows) ? b.rows : null,
      error: typeof b.error === "string" ? b.error.slice(0, 200) : null,
      at: Date.now(),
    };
    broadcastRoverStatus();
    if (done) {
      logger.log(req, "rover.ground_calibration",
        { ok: !!b.ok, near_m: b.near_m ?? null, far_m: b.far_m ?? null,
          rows: b.rows ?? null, mode: b.mode ?? null, error: b.error ?? null }, "rover");
    }
    return res.json({ ok: true });
  }
  roverState.stereo_calibration = {
    status: done ? (b.ok ? "done" : "failed") : "running",
    phase,
    captured: Number.isInteger(b.captured) ? b.captured : null,
    target: Number.isInteger(b.target) ? b.target : null,
    rms: typeof b.rms === "number" ? b.rms : null,
    baseline_mm: typeof b.baseline_mm === "number" ? b.baseline_mm : null,
    pairs: Number.isInteger(b.pairs) ? b.pairs : null,
    error: typeof b.error === "string" ? b.error.slice(0, 200) : null,
    at: Date.now(),
  };
  broadcastRoverStatus();
  if (done) {
    logger.log(req, "rover.calibration",
      { ok: !!b.ok, rms: b.rms ?? null, rms_l: b.rms_l ?? null, rms_r: b.rms_r ?? null,
        baseline_mm: b.baseline_mm ?? null, error: b.error ?? null }, "rover");
  }
  res.json({ ok: true });
});

// POST /api/rover/calibrate-battery - 배터리 전압 1점 게인 보정 (admin)
// 운영자가 멀티미터로 측정한 실제 전압을 입력하면, 로버가 같은 시점의 ADC raw
// 값과 비교해 V_real = V_raw × gain 의 게인 하나를 갱신·영구 저장한다.
// 환경 온도가 바뀔 때마다 다시 누르면 그 자리에서 보정.
app.post("/api/rover/calibrate-battery", (req, res) => {
  const measured_v = Number(req.body?.measured_v);
  if (!Number.isFinite(measured_v) || measured_v < 15 || measured_v > 32) {
    return res.status(400).send("측정값은 15~32 V 범위 안의 숫자여야 합니다.");
  }
  if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_battery", { measured_v });

  if (!sendRoverEvent("calibrate-battery", { measured_v })) {
    logger.warn(req, "rover.calibrate_battery", { error: "write_failed", measured_v }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  logger.log(req, "rover.calibrate_battery", { measured_v }, "rover");
  res.json({ ok: true, measured_v });
});

// POST /api/rover/calibrate-antenna - 안테나 오프셋 자동 캘리브레이션 시작 (admin)
// 로버가 직진 → S-curve(8s) 패턴을 자동 주행하면서 인코더로 적분한
// chassis pose와 GPS 안테나 위치를 비교해 (a_x, a_y) 오프셋을 LSQ로 적합한다.
// 결과는 로버 측 /var/lib/pilot/antenna_offset.json에 영속화되고
// /api/rover/antenna_calibration_result로 회신된다.
app.post("/api/rover/calibrate-antenna", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_antenna");
  if (roverState.nav_state && roverState.nav_state !== "IDLE") {
    logger.warn(req, "rover.calibrate_antenna", { error: "not_idle", nav_state: roverState.nav_state }, "rover");
    return res.status(409).send(
      `로버가 IDLE이 아닙니다 (현재: ${roverState.nav_state}). 먼저 미션을 종료하세요.`
    );
  }
  if (!sendRoverEvent("calibrate-antenna", {})) {
    logger.warn(req, "rover.calibrate_antenna", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.calibrate_antenna", null, "rover");
  res.json({ ok: true });
});

// POST /api/rover/set-antenna-offset - 운영자가 줄자로 잰 안테나 오프셋 직접 입력 (admin)
// auto-cal은 PID 튜닝이 안 된 상태에서는 SCURVE 동안 chassis pose 적분 오차가
// 누적되어 m 단위 오차가 나오기 쉬우므로, 운영 환경에서는 한 번 측정한 값을
// 직접 입력하는 게 가장 확실하다. 결과는 동일한 antenna_offset.json에
// source='manual' 태그로 영속화된다.
app.post("/api/rover/set-antenna-offset", (req, res) => {
  const body = req.body || {};
  const a_x = typeof body.a_x === "number" ? body.a_x : null;
  const a_y = typeof body.a_y === "number" ? body.a_y : null;
  if (a_x === null || a_y === null) {
    return res.status(400).send("a_x, a_y는 숫자여야 합니다.");
  }
  if (a_x < 0.05 || a_x > 1.0 || Math.abs(a_y) > 1.0) {
    return res.status(400).send("a_x는 0.05~1 m, a_y는 ±1 m 이내여야 합니다.");
  }
  if (!roverClient) return rejectNoRover(req, res, "rover.set_antenna_offset", { a_x, a_y });
  if (!sendRoverEvent("set-antenna-offset", { a_x, a_y })) {
    logger.warn(req, "rover.set_antenna_offset", { error: "write_failed", a_x, a_y }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.set_antenna_offset", { a_x, a_y }, "rover");
  res.json({ ok: true, a_x, a_y });
});

// POST /api/rover/antenna_calibration_result - 로버가 캘리브레이션 결과 보고 (internal)
app.post("/api/rover/antenna_calibration_result", (req, res) => {
  const body = req.body || {};
  const ok = !!body.ok;
  // We log everything the rover sent so post-mortem of a failed calibration
  // (residual too high / not enough samples) tells the operator exactly
  // which gate tripped without needing SSH.
  const stored = {
    ok,
    a_x: typeof body.a_x === "number" ? body.a_x : null,
    a_y: typeof body.a_y === "number" ? body.a_y : null,
    rms_residual_m: typeof body.rms_residual_m === "number" ? body.rms_residual_m : null,
    samples: Number.isInteger(body.samples) ? body.samples : null,
    drive_distance_m: typeof body.drive_distance_m === "number" ? body.drive_distance_m : null,
    calibrated_at: Number.isInteger(body.calibrated_at) ? body.calibrated_at : Date.now(),
    reason: typeof body.reason === "string" ? body.reason : null,
    // 'auto' (auto-cal SCURVE drive) or 'manual' (operator typed the value).
    // Lets the UI label which method produced the persisted offset.
    source: body.source === "manual" ? "manual" : (body.source === "auto" ? "auto" : null),
  };
  roverState.antenna_calibration = stored;
  broadcastEvent("rover:antenna_calibration", stored);
  broadcastRoverStatus();
  if (ok) {
    logger.log(req, "rover.antenna_calibration", stored, "rover");
  } else {
    logger.warn(req, "rover.antenna_calibration", stored, "rover");
  }
  res.json({ ok: true });
});

// POST /api/rover/calibrate-wheels - 휠 인코더 스케일 자동 캘리브레이션 시작 (admin)
// 로버가 직진 10 m 주행 후 GPS chord 거리와 좌·우 인코더 적분 거리의 비율로
// 좌·우 휠 스케일을 추정한다. 결과는 /var/lib/pilot/wheel_cal.json에 영속화되고
// mcu_bridge가 텔레메트리 vl/vr에 곱해 적용한다. /api/rover/wheel_calibration_result로 회신.
app.post("/api/rover/calibrate-wheels", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_wheels");
  if (roverState.nav_state && roverState.nav_state !== "IDLE") {
    logger.warn(req, "rover.calibrate_wheels", { error: "not_idle", nav_state: roverState.nav_state }, "rover");
    return res.status(409).send(
      `로버가 IDLE이 아닙니다 (현재: ${roverState.nav_state}). 먼저 미션을 종료하세요.`
    );
  }
  if (!sendRoverEvent("calibrate-wheels", {})) {
    logger.warn(req, "rover.calibrate_wheels", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  logger.log(req, "rover.calibrate_wheels", null, "rover");
  res.json({ ok: true });
});

// POST /api/rover/wheel_calibration_result - 로버가 휠 캘리브레이션 결과 보고 (internal)
app.post("/api/rover/wheel_calibration_result", (req, res) => {
  const body = req.body || {};
  const ok = !!body.ok;
  const stored = {
    ok,
    scale_l: typeof body.scale_l === "number" ? body.scale_l : null,
    scale_r: typeof body.scale_r === "number" ? body.scale_r : null,
    gps_distance_m: typeof body.gps_distance_m === "number" ? body.gps_distance_m : null,
    encoder_left_m: typeof body.encoder_left_m === "number" ? body.encoder_left_m : null,
    encoder_right_m: typeof body.encoder_right_m === "number" ? body.encoder_right_m : null,
    samples: Number.isInteger(body.samples) ? body.samples : null,
    // Steering-trim auto-cal piggy-backs on the same drive (rover/pilot/lib/steering_calibration.py).
    // null radius_m means the path was straight enough that we report 0 µs trim;
    // null trim_us with a steering_reason means the trim solve failed but wheel scales still applied.
    trim_us: typeof body.trim_us === "number" ? body.trim_us : null,
    radius_m: typeof body.radius_m === "number" ? body.radius_m : null,
    steering_rms_m: typeof body.steering_rms_m === "number" ? body.steering_rms_m : null,
    steering_reason: typeof body.steering_reason === "string" ? body.steering_reason : null,
    // Rover doesn't stamp calibrated_at in the result payload — we stamp on receipt
    // since that's within ~100 ms of the rover's solve completion.
    calibrated_at: Date.now(),
    reason: typeof body.reason === "string" ? body.reason : null,
  };
  roverState.wheel_calibration = stored;
  broadcastRoverStatus();
  if (ok) {
    logger.log(req, "rover.wheel_calibration", stored, "rover");
  } else {
    logger.warn(req, "rover.wheel_calibration", stored, "rover");
  }
  res.json({ ok: true });
});

// POST /api/rover/reset-wheel-cal - 휠 스케일/조향 트림을 공장 기본값으로 되돌림 (admin)
// 휠 cal은 매 실행에서 scale_l/r을 새로 덮어쓰지만 조향 트림은 누적되므로,
// 비정상 누적값이 적용된 상태를 한 번에 해소하는 escape hatch.
app.post("/api/rover/reset-wheel-cal", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.reset_wheel_cal");
  if (roverState.nav_state && roverState.nav_state !== "IDLE") {
    logger.warn(req, "rover.reset_wheel_cal", { error: "not_idle", nav_state: roverState.nav_state }, "rover");
    return res.status(409).send(
      `로버가 IDLE이 아닙니다 (현재: ${roverState.nav_state}). 먼저 미션을 종료하세요.`
    );
  }
  if (!sendRoverEvent("reset-wheel-cal", {})) {
    logger.warn(req, "rover.reset_wheel_cal", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  roverState.wheel_calibration = null;
  broadcastRoverStatus();
  logger.log(req, "rover.reset_wheel_cal", null, "rover");
  res.json({ ok: true });
});

// POST /api/rover/waypoint_skipped - 로버가 stuck-skip으로 웨이포인트 건너뜀 (internal)
// waypoint_reached와 동일하게 current_waypoint_idx를 monotonically 전진시켜
// 새로고침 후에도 스킵된 콘이 다음 목표로 다시 잡히지 않도록 한다.
app.post("/api/rover/waypoint_skipped", (req, res) => {
  const index = Number(req.body?.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).send("올바르지 않은 waypoint index입니다.");
  }
  // 미션 자동 종료 직후 늦게 도착할 수 있다. 종료 후엔 의미가 없으므로 no-op.
  if (currentMissionId == null) {
    return res.json({ ok: true });
  }
  if (index >= roverState.mission_progress.waypoints.length) {
    logger.warn(req, "rover.waypoint_skipped", { index, error: "index_out_of_range" }, "rover");
    return res.status(400).send("waypoint index가 현재 미션 범위를 벗어났습니다.");
  }
  if (index + 1 > roverState.mission_progress.current_waypoint_idx) {
    roverState.mission_progress.current_waypoint_idx = index + 1;
  }
  persistProgress();
  broadcastEvent("rover:skipped", { index });
  logger.warn(req, "rover.waypoint_skipped", { index, mission_id: currentMissionId }, "rover");
  res.json({ ok: true });
});

// POST /api/rover/clear-emergency - 비상정지 해제 (operator-acknowledged)
app.post("/api/rover/clear-emergency", (req, res) => {
  if (!roverClient) return rejectNoRover(req, res, "rover.clear_emergency");

  if (!sendRoverEvent("clear-emergency", {})) {
    logger.warn(req, "rover.clear_emergency", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  logger.log(req, "rover.clear_emergency", null, "rover");
  res.json({ cleared: true });
});

// POST /api/rover/end-mission - 운영자가 보존된 미션을 명시적으로 종료
// EMERGENCY_STOP 동안은 미션이 자동으로 끝나지 않으므로, 운영자가 "이어서
// 실행" 대신 path 자체를 폐기할 때 호출되어 미션 레코드를 마감한다.
app.post("/api/rover/end-mission", (req, res) => {
  if (currentMissionId == null) return res.json({ ended: false });
  const endedId = currentMissionId;
  endMission("stopped");
  broadcastRoverStatus();
  logger.log(req, "rover.end_mission", { mission_id: endedId }, "rover");
  res.json({ ended: true, mission_id: endedId });
});

// POST /api/rover/pump - 페리스탈릭 펌프 수동 on/off 토글 (admin → SSE)
app.post("/api/rover/pump", (req, res) => {
  const { on } = req.body;
  if (typeof on !== "boolean") {
    return res.status(400).send("on must be a boolean.");
  }
  if (!roverClient) return rejectNoRover(req, res, "rover.pump", { on });
  if (!sendRoverEvent("pump-set", { on })) {
    logger.warn(req, "rover.pump", { error: "write_failed", on }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }
  roverState.pump_on = on;
  logger.log(req, "rover.pump", { on }, "rover");
  broadcastRoverStatus();
  res.json({ on });
});

// POST /api/rover/pump-duration - 펌프 분사 시간(초) 설정 (admin → SSE)
app.post("/api/rover/pump-duration", (req, res) => {
  const seconds = Number(req.body?.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) {
    logger.warn(req, "rover.pump_duration", { error: "invalid_seconds", seconds: req.body?.seconds }, "rover");
    return res.status(400).send("seconds는 0 초과 10 이하여야 합니다.");
  }
  // 항상 저장한다 — 로버 재연결 시 재전송돼 고착된다. 연결돼 있으면 즉시 전송.
  roverState.pump_run_duration = seconds;
  if (roverClient) sendRoverEvent("pump-duration", { seconds });
  logger.log(req, "rover.pump_duration", { seconds, connected: !!roverClient }, "rover");
  broadcastRoverStatus();
  res.json({ ok: true });
});

// POST /api/rover/control - 수동 제어
app.post("/api/rover/control", (req, res) => {
  const { throttle, steering } = req.body;
  if (typeof throttle !== "number" || typeof steering !== "number" || !Number.isFinite(throttle) || !Number.isFinite(steering)) {
    return res.status(400).send("올바르지 않은 제어 데이터입니다.");
  }

  const t = Math.max(-100, Math.min(100, throttle));
  const s = Math.max(-100, Math.min(100, steering));
  if (!roverClient) return rejectNoRover(req, res, "rover.control", { throttle: t, steering: s });

  if (!sendRoverEvent("manual-control", { throttle: t, steering: s })) {
    logger.warn(req, "rover.control", { error: "write_failed" }, "rover");
    return res.status(503).send("로버 연결이 끊어졌습니다.");
  }

  res.json({ throttle: t, steering: s });
});

// POST /api/rover/nav-lights - 항공기식 nav 라이트 모드 설정 (admin → SSE)
// mode: 0=off 1=steady 2=double-strobe 3=single-strobe 4=50% blink
app.post("/api/rover/nav-lights", (req, res) => {
  const mode = Number(req.body?.mode);
  if (!Number.isInteger(mode) || mode < 0 || mode > 4) {
    logger.warn(req, "rover.nav_lights", { error: "invalid_mode", mode: req.body?.mode }, "rover");
    return res.status(400).send("mode는 0~4여야 합니다.");
  }
  // 선택은 항상 저장한다 — 로버 재연결 시 재전송돼 고착된다. 연결돼 있으면 즉시 전송.
  roverState.nav_lights_mode = mode;
  if (roverClient) sendRoverEvent("nav-lights", { mode });
  logger.log(req, "rover.nav_lights", { mode, connected: !!roverClient }, "rover");
  broadcastRoverStatus();
  res.json({ ok: true });
});

// POST /api/rover/led-brightness - status LED(WS2812) 전역 밝기 0-255 (admin → SSE)
app.post("/api/rover/led-brightness", (req, res) => {
  const brightness = Number(req.body?.brightness);
  if (!Number.isInteger(brightness) || brightness < 0 || brightness > 255) {
    logger.warn(req, "rover.led_brightness", { error: "invalid_brightness", brightness: req.body?.brightness }, "rover");
    return res.status(400).send("brightness는 0~255여야 합니다.");
  }
  roverState.led_brightness = brightness;
  if (roverClient) sendRoverEvent("led-brightness", { brightness });
  logger.log(req, "rover.led_brightness", { brightness, connected: !!roverClient }, "rover");
  broadcastRoverStatus();
  res.json({ ok: true });
});

/* ============================================
   Camera relay (rover → server → browser, MJPEG)
   ============================================
   In-memory only — frames are ephemeral, never touch the DB. Tailscale-free:
   the rover's perception container pushes JPEG frames OUT to this server, and
   admin browsers pull them from the same server as multipart/x-mixed-replace
   (native <img> rendering). The rover only captures while someone is watching:
   a viewer connecting/leaving toggles a camera-start/stop event on the rover's
   control SSE. Separate from the pilot's /api/rover/stream so streaming load
   never interferes with the mission command channel. */
let cameraControlClient = null;   // perception container's control SSE (res)
const cameraViewers = new Set();  // browser MJPEG multipart responses
// WebRTC gating-only viewers (no MJPEG frames): they keep the rover capturing +
// publishing the matching stream. Split by kind so the rover encodes each stream
// (rover-2d mono/composite, rover-vr stereo) only while its viewer is present.
const holdViewers2d = new Set();
const holdViewersVr = new Set();
let cameraLatestFrame = null;     // { buf, at } — last JPEG, replayed to new viewers
// Operator toggled the both-eyes depth composite on. The composite is rendered
// ON the rover (perception owns the cameras); this flag only records the desired
// view mode so it can be (re)sent to the perception control channel — on the
// toggle itself, and again if the perception container reconnects mid-session.
let cameraDepthWanted = false;
const CAMERA_FRAME_FRESH_MS = 2000;
// Drop frames for a viewer whose socket is this far behind rather than buffering
// JPEGs unboundedly — a slow viewer (cellular/phone) must never OOM the mission
// server. ~4 MB ≈ several frames of headroom at our resolution.
const CAMERA_VIEWER_MAX_BACKLOG = 4 * 1024 * 1024;
// Bound the camera feature's footprint on the SHARED mission server.
const MAX_CAMERA_VIEWERS = 8;                 // cap held-open MJPEG responses
const CAMERA_MIN_FRAME_INTERVAL_MS = 40;      // relay ≤ ~25 fps regardless of rover
let cameraLastRelayAt = 0;

function sendCameraControl(event, data) {
  if (!cameraControlClient) return false;
  try {
    cameraControlClient.write(`event: ${event}\ndata: ${data ? JSON.stringify(data) : "{}"}\n\n`);
    return true;
  } catch {
    try { cameraControlClient.end(); } catch {}
    cameraControlClient = null;
    return false;
  }
}

function removeCameraViewer(res) {
  if (!cameraViewers.delete(res)) return;
  // Last MJPEG viewer gone → release the cached frame so a stale image can't be
  // replayed when the stream next reopens. (Depth is a 2D-view sub-mode and is
  // cleared in syncCameraCapture once NO 2D viewer — MJPEG or WebRTC — remains.)
  if (cameraViewers.size === 0) cameraLatestFrame = null;
  // Always re-sync: emits mjpeg-off, and camera-stop only if no WebRTC hold remains.
  syncCameraCapture();
}

// Capture while ANY viewer (MJPEG or WebRTC-hold) is watching; JPEG-encode only
// while an actual MJPEG viewer is attached (a WebRTC-only session skips MJPEG).
function syncCameraCapture() {
  const watching = cameraViewers.size > 0 || holdViewers2d.size > 0 || holdViewersVr.size > 0;
  sendCameraControl(watching ? "camera-start" : "camera-stop");
  sendCameraControl(cameraViewers.size > 0 ? "mjpeg-on" : "mjpeg-off");
  // Each WebRTC stream is encoded only while its viewer is present.
  sendCameraControl(holdViewers2d.size > 0 ? "webrtc-2d-on" : "webrtc-2d-off");
  sendCameraControl(holdViewersVr.size > 0 ? "webrtc-vr-on" : "webrtc-vr-off");
  // Depth is a 2D-view sub-mode (baked into the rover's `out` frame, which feeds
  // BOTH the MJPEG relay and rover-2d WebRTC). Clear it once no 2D viewer remains
  // so the flag can't get stuck on across sessions.
  if (cameraDepthWanted && cameraViewers.size === 0 && holdViewers2d.size === 0) {
    cameraDepthWanted = false;
    sendCameraControl("depth-off");
  }
}

// GET /api/rover/camera/control - perception container SSE (internal-strict).
// Receives camera-start / camera-stop so it captures only on demand.
app.get("/api/rover/camera/control", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");
  // Async socket errors (peer reset) don't throw — without a listener they'd
  // crash the process. Just drop the slot.
  res.on("error", () => { if (cameraControlClient === res) cameraControlClient = null; });
  if (cameraControlClient && cameraControlClient !== res) {
    // Session takeover (e.g. a perception container replaced by auto-update) —
    // leave an audit trail, mirroring /api/rover/stream's rover.stream.replaced.
    logger.warn(req, "rover.camera.control_replaced", null, "rover");
    try { cameraControlClient.end(); } catch {}
  }
  cameraControlClient = res;
  // Audit the perception container's control-channel attach/detach. Without
  // this there is NO log trail for "is the camera/perception process connected"
  // (camera_connected lives only in the live /camera/status response), which
  // makes "the camera shows nothing" hard to triage — connected vs. never
  // attached look identical in the logs.
  logger.log(req, "rover.camera.control_connected", null, "rover");
  // If viewers are already waiting, start capturing immediately — and restore
  // the depth view mode if it was on (covers a perception container that
  // reconnected mid-session, e.g. after an auto-update, without the operator
  // having to re-toggle).
  // Re-sync the FULL desired state on every (re)connect. The perception node now
  // keeps its last stream/depth/mjpeg state across an SSE blip (so a transient
  // drop no longer tears down the WebRTC publisher), so send the current truth —
  // camera-start/stop + mjpeg-on/off — to also cover a viewer that left while the
  // SSE was down.
  syncCameraCapture();
  sendCameraControl(cameraDepthWanted ? "depth-on" : "depth-off");
  // 10s heartbeat (was 30s) to match /api/rover/stream — keeps the SSE alive
  // through proxy idle-close so it doesn't drop every few minutes.
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch {}
  }, 10000);
  req.on("close", () => {
    clearInterval(heartbeat);
    if (cameraControlClient === res) {
      cameraControlClient = null;
      // A bare disconnect is a benign lifecycle event: the perception node
      // reconnects (client backoff) and the server re-syncs the full desired
      // state on reconnect, and WebRTC/stream survive the blip. It pairs with
      // the info-level control_connected, so log at info — a redeploy or a
      // flaky rover uplink otherwise floods the warn filter with reconnect
      // churn. warn is reserved for a close that actually broke something
      // (below).
      // If a calibration was mid-run, the perception node that was running it is
      // gone — mark it failed so the operator isn't locked out of retrying (the
      // 교정 button is disabled while 'running' and nothing else would clear it).
      const aborted = [];
      if (roverState.stereo_calibration.status === "running") {
        roverState.stereo_calibration = {
          status: "failed", phase: "done",
          error: "카메라(perception) 연결이 끊겼습니다.", at: Date.now(),
        };
        aborted.push("stereo");
      }
      if (roverState.ground_calibration.status === "running") {
        roverState.ground_calibration = {
          status: "failed", phase: "done",
          error: "카메라(perception) 연결이 끊겼습니다.", at: Date.now(),
        };
        aborted.push("ground");
      }
      if (aborted.length) {
        // This close DID break something the operator was waiting on: warn so it
        // surfaces under the level filter, with which calibration(s) it killed.
        logger.warn(req, "rover.camera.control_closed",
          { aborted_calibration: aborted }, "rover");
        broadcastRoverStatus();
      } else {
        logger.log(req, "rover.camera.control_closed", null, "rover");
      }
    }
  });
});

// POST /api/rover/camera - JPEG frame upload (internal-strict, raw body).
// express.raw only consumes image/jpeg; the global express.json skips it.
app.post("/api/rover/camera", express.raw({ type: "image/jpeg", limit: "3mb" }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).send("empty frame");
  }
  // Rate-cap the relay: drop frames arriving faster than ~25 fps so a fast or
  // misbehaving rover (the rover self-caps, but defense in depth on the shared
  // mission server) can't drive unbounded Buffer alloc + fan-out CPU here.
  const now = Date.now();
  if (now - cameraLastRelayAt < CAMERA_MIN_FRAME_INTERVAL_MS) {
    return res.status(204).end();
  }
  cameraLastRelayAt = now;
  cameraLatestFrame = { buf, at: now };
  const header = Buffer.from(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`
  );
  for (const viewer of cameraViewers) {
    // A viewer can close between its 'close' handler and this write; writing to
    // an ended/destroyed response emits an async 'error' (uncatchable here), so
    // skip + reap it. And bound memory: drop this frame for a backed-up viewer
    // instead of queueing it.
    if (viewer.writableEnded || viewer.destroyed) { removeCameraViewer(viewer); continue; }
    if (viewer.writableLength > CAMERA_VIEWER_MAX_BACKLOG) continue;
    try {
      viewer.write(header);
      viewer.write(buf);
      viewer.write("\r\n");
    } catch { removeCameraViewer(viewer); }
  }
  res.status(204).end();
});

// GET /api/rover/camera/stream - browser MJPEG viewer (admin).
app.get("/api/rover/camera/stream", (req, res) => {
  // Cap concurrent held-open MJPEG responses so a scripted/looping admin can't
  // exhaust sockets/heap on the shared server (mirrors the SSE manager's cap).
  if (cameraViewers.size >= MAX_CAMERA_VIEWERS) {
    logger.warn(req, "rover.camera.view", { error: "too_many_viewers", viewers: cameraViewers.size }, "rover");
    return res.status(503).send("카메라 시청자가 너무 많습니다.");
  }
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "keep-alive",
  });
  // Flush headers now: with no Content-Length, Node would otherwise hold the
  // headers until the first body write, so a viewer that connects before any
  // frame is pushed would see the request hang instead of an open MJPEG stream.
  res.flushHeaders();
  res.on("error", () => removeCameraViewer(res));
  cameraViewers.add(res);
  // Replay the most recent frame so a joining viewer sees something at once.
  if (cameraLatestFrame && Date.now() - cameraLatestFrame.at < CAMERA_FRAME_FRESH_MS) {
    try {
      res.write(Buffer.from(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${cameraLatestFrame.buf.length}\r\n\r\n`
      ));
      res.write(cameraLatestFrame.buf);
      res.write("\r\n");
    } catch { /* ignore */ }
  }
  if (cameraViewers.size === 1) syncCameraCapture(); // first viewer → start
  logger.log(req, "rover.camera.view", { viewers: cameraViewers.size }, "rover");
  req.on("close", () => removeCameraViewer(res));
});

// GET /api/rover/camera/hold - gating-only viewer (WebRTC/VR). Keeps the rover
// capturing + WebRTC-publishing WITHOUT pulling MJPEG frames, so the rover skips
// the JPEG encode+POST while only WebRTC viewers are watching. The browser holds
// this open (SSE) for the duration of the VR/WebRTC session.
app.get("/api/rover/camera/hold", (req, res) => {
  // mode=vr → stereo (rover-vr); anything else → 2D mono/composite (rover-2d).
  const set = req.query.mode === "vr" ? holdViewersVr : holdViewers2d;
  if (set.size >= MAX_CAMERA_VIEWERS) {
    return res.status(503).send("too many viewers");
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");
  res.on("error", () => { if (set.delete(res)) syncCameraCapture(); });
  set.add(res);
  syncCameraCapture();
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 10000);
  req.on("close", () => {
    clearInterval(hb);
    if (set.delete(res)) syncCameraCapture();
  });
});

// GET /api/rover/camera/status - camera availability for the UI (admin).
app.get("/api/rover/camera/status", (req, res) => {
  res.json({
    camera_connected: !!cameraControlClient,
    viewers: cameraViewers.size,
    depth: cameraDepthWanted,
    // Server-COMPUTED age, never a raw server epoch: the client must not diff
    // its own (possibly NTP-skewed) clock against a server timestamp — that
    // mismatch paints a working stream as "신호 없음" or hides a dead one (the
    // same client-clock trap as the course UI's "UPDATE Ns").
    last_frame_age_ms: cameraLatestFrame ? (Date.now() - cameraLatestFrame.at) : null,
  });
});

// POST /api/rover/camera/depth - toggle the both-eyes depth composite (admin).
// The rover renders the composite (rectified left + depth heatmap + nearest
// distance) itself; this only tells it which stream to send, so it's a no-op on
// the pixels until an operator is actually watching. Persisted so a mid-session
// perception reconnect restores the mode (see the control handler above).
app.post("/api/rover/camera/depth", (req, res) => {
  const on = !!(req.body && req.body.on);
  // Depth is a sub-mode of an active 2D stream — the composite is baked into the
  // rover's `out` frame, shared by the MJPEG relay AND rover-2d WebRTC. So gate on
  // ANY 2D viewer (MJPEG cameraViewers OR WebRTC holdViewers2d); a WebRTC-only 2D
  // panel has zero MJPEG viewers. Ignore an "on" with no 2D viewer so the flag
  // can't get stuck true (it's only cleared on the last-2D-viewer-leave edge).
  const has2dViewer = cameraViewers.size > 0 || holdViewers2d.size > 0;
  cameraDepthWanted = on && has2dViewer;
  const delivered = sendCameraControl(cameraDepthWanted ? "depth-on" : "depth-off");
  const detail = { on, applied: cameraDepthWanted, delivered,
    mjpegViewers: cameraViewers.size, webrtc2dViewers: holdViewers2d.size };
  // We wanted depth on (a viewer is present) but couldn't reach perception → an
  // inter-service delivery failure; warn per the logging policy so an operator can
  // find "the depth view didn't apply" by level. Everything else is info.
  if (cameraDepthWanted && !delivered) {
    logger.warn(req, "rover.camera.depth", { ...detail, error: "perception_not_connected" }, "rover");
  } else {
    logger.log(req, "rover.camera.depth", detail, "rover");
  }
  res.json({ ok: true, depth: cameraDepthWanted, camera_connected: !!cameraControlClient });
});

// GET /api/rover/map-tile - same-origin satellite tile proxy for the VR minimap
// (admin). WebGL cannot texture a canvas tainted by cross-origin tiles, so the VR
// view can't draw VWorld/Google tiles onto its minimap canvas directly — proxy
// them here (server-side VWORLD_KEY, else a Google fallback) so the canvas stays
// same-origin. z/x/y are slippy-map (XYZ) tile indices.
app.get("/api/rover/map-tile", async (req, res) => {
  const z = Number(req.query.z), x = Number(req.query.x), y = Number(req.query.y);
  const okInt = (v, hi) => Number.isInteger(v) && v >= 0 && v <= hi;
  if (!okInt(z, 21) || !okInt(x, (1 << z) - 1) || !okInt(y, (1 << z) - 1)) {
    return res.status(400).send("bad tile coords");
  }
  const key = process.env.VWORLD_KEY;
  const url = key
    ? `https://api.vworld.kr/req/wmts/1.0.0/${key}/Satellite/${z}/${y}/${x}.jpeg`
    : `https://mt0.google.com/vt/lyrs=y&x=${x}&y=${y}&z=${z}&scale=2`;
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!upstream.ok) {
      logger.warn(req, "rover.map_tile", { error: `upstream ${upstream.status}`, z, x, y }, "rover");
      return res.status(502).send("tile upstream error");
    }
    res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    logger.warn(req, "rover.map_tile", { error: String(e?.message || e), z, x, y }, "rover");
    res.status(502).send("tile fetch failed");
  }
});

}
