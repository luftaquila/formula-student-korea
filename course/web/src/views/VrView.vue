<script setup>
/*
 * VR teleop view — Meta Quest 3S (WebXR immersive-vr).
 *
 * Plays the rover's stereo camera in 3D on a floating screen in the headset and
 * drives the rover with the Touch controller thumbsticks. Video is WebRTC (WHEP)
 * from the `rover-vr` stream (rectified left|right side-by-side, split per eye);
 * it opens a VR gating hold (/api/rover/camera/hold?mode=vr) so the rover captures
 * and publishes, and falls back to the mono MJPEG stream (/api/rover/camera/stream)
 * only if WebRTC can't connect. Control uses /api/rover/control + /stop +
 * /clear-emergency + /resume + /pump.
 *
 * In-headset HUD (head-locked, fighter-jet style): battery, speed, GPS fix/sats/
 * accuracy + coords, nav/link state, throttle/steering. A comfort vignette darkens
 * the periphery. A world-locked minimap sits to the left of the screen: VWorld
 * satellite tiles (proxied same-origin) centered on the rover, live position marker,
 * left-controller keys zoom it.
 *
 * Controls — right controller only: stick = throttle (Y) + steering (X), trigger =
 * pump, grip (middle finger) = emergency-stop TOGGLE (stop ↔ clear), A / B =
 * minimap zoom in / out.
 */
import { inject, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { request } from "../api.js";
import { shapeStick } from "@lib/stick.mjs";
import { formatCoord, ALT_DECIMALS } from "@lib/geo.mjs";
import { useRoverControl } from "../composables/useRoverControl.js";
import { useNotification } from "@shared/useNotification.js";

const { error: notifyError, warning: notifyWarn } = useNotification();
const router = useRouter();
const containerEl = ref(null);
const control = useRoverControl();

function goBack() {
  if (window.history.length > 1) router.back();
  else router.push("/");
}

// three handles (not reactive — mutated imperatively in the render loop).
let renderer = null;
let scene = null;
let camera = null;
let texture = null;          // MJPEG fallback texture
let imgEl = null;
let videoEl = null;          // WHEP <video> (WebRTC, side-by-side stereo)
let videoTextureL = null;    // left half of the SBS
let videoTextureR = null;    // right half of the SBS
let screenMat = null;        // mono screen material (MJPEG / flat left-eye preview)
let screenMono = null;       // layer 0: both eyes (fallback + flat preview)
let screenL = null;          // layer 1: left eye only (XR)
let screenR = null;          // layer 2: right eye only (XR)
let whepPc = null;
let vrButtonEl = null;
let hudCanvas = null;
let hudCtx = null;
let hudTexture = null;
let minimapCanvas = null;
let minimapCtx = null;
let minimapTexture = null;
const usingWebrtc = ref(false); // true once the WHEP video is delivering frames
const hasVideo = ref(false);    // any picture up (WebRTC OR the MJPEG fallback)

const STREAM_BASE = import.meta.env.PROD ? "/course" : "";
const prevBtn = {};    // edge-detection state for buttons
let pumpOn = false;
let frame = 0;

// Live rover status (SSE rover:status) — drives the e-stop toggle, the HUD, and
// the minimap. rover:status carries the whole roverState, so battery/gps/position
// are all here.
const navState = ref(null);
const roverConnected = ref(false);
// App의 전역 e-stop 버튼은 provide된 navState/roverConnected를 읽는다. /vr에서는 MapView가
// 마운트되지 않아 아무도 이 값을 갱신하지 않으므로, VrView가 rover:status 수신 시 함께 갱신해
// App e-stop이 stale 상태로 오동작(해제 대신 재정지 등)하지 않게 한다.
const appNavState = inject("navState", null);
const appRoverConnected = inject("roverConnected", null);
const battery = ref(null);      // { voltage, percent, source }
const gps = ref(null);          // { speed, heading, h_acc, num_sv, ... }
const fixStatus = ref(null);
const roverPos = ref(null);     // { lat, lng }
let evtSource = null;

// ── minimap (VWorld satellite via same-origin tile proxy) ──────────────────────
const MINIMAP_PX = 512;
// Fallback centre when the rover has no GPS fix — the course-management default
// (matches MapView's initial setView), so the minimap shows the venue, not black.
const DEFAULT_CENTER = { lat: 35.292012, lng: 126.574415 };
const MINIMAP_ZOOM_MIN = 15;
const MINIMAP_ZOOM_MAX = 20;
// VWorld satellite tiles top out at native zoom 19; past it we upscale the z19
// tiles (like Leaflet's maxNativeZoom) instead of requesting non-existent tiles
// (which came back as black holes).
const MINIMAP_NATIVE_MAX = 19;
let minimapZoom = 18;
let minimapDirty = true;
const TILE_CACHE_MAX = 300;   // bound decoded-tile memory over a long session
const TILE_RETRY_MS = 10000;  // re-fetch a failed tile after this (transient 502s)
const tileCache = new Map();  // "z/x/y" -> HTMLImageElement | "loading" | { err: ts }

function getTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  const cached = tileCache.get(k);
  if (cached instanceof Image) return cached;
  if (cached === "loading") return null;
  if (cached && cached.err && Date.now() - cached.err < TILE_RETRY_MS) return null; // backoff, then retry
  tileCache.set(k, "loading");
  const img = new Image();
  img.onload = () => {
    tileCache.set(k, img);
    minimapDirty = true;
    // Evict oldest (Map preserves insertion order) so the cache can't grow forever.
    while (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  };
  img.onerror = () => { tileCache.set(k, { err: Date.now() }); }; // retryable, not permanent
  img.src = `${STREAM_BASE}/api/rover/map-tile?z=${z}&x=${x}&y=${y}`;
  return null;
}
function setMinimapZoom(delta) {
  const z = Math.min(MINIMAP_ZOOM_MAX, Math.max(MINIMAP_ZOOM_MIN, minimapZoom + delta));
  if (z !== minimapZoom) { minimapZoom = z; minimapDirty = true; }
}
function drawMinimap() {
  if (!minimapCtx) return;
  const S = MINIMAP_PX, ctx = minimapCtx;
  ctx.fillStyle = "#0a0f14";
  ctx.fillRect(0, 0, S, S);
  // Always show tiles: centre on the live rover position, or the course default
  // area when there's no GPS fix (so it's never a black box).
  const live = roverPos.value;
  const pos = live || DEFAULT_CENTER;
  const z = minimapZoom;
  const tz = Math.min(z, MINIMAP_NATIVE_MAX);  // fetch native-max tiles past 19…
  const f = 2 ** (z - tz);                     // …and upscale them by this factor
  const tsize = 256 * f;                       // on-canvas size of one native tile
  const nt = 2 ** tz;
  const latRad = (pos.lat * Math.PI) / 180;
  // slippy-map centre in DISPLAY pixels (native tile px × upscale factor)
  const xW = ((pos.lng + 180) / 360) * nt * 256 * f;
  const yW = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * nt * 256 * f;
  const originX = xW - S / 2;  // display px at canvas (0,0) — centre stays centred
  const originY = yW - S / 2;
  const tx0 = Math.floor(originX / tsize), tx1 = Math.floor((originX + S) / tsize);
  const ty0 = Math.floor(originY / tsize), ty1 = Math.floor((originY + S) / tsize);
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      if (tx < 0 || ty < 0 || tx >= nt || ty >= nt) continue;
      const img = getTile(tz, tx, ty);
      if (img) ctx.drawImage(img, Math.round(tx * tsize - originX), Math.round(ty * tsize - originY), tsize, tsize);
    }
  }
  if (live) {
    // rover marker (heading-oriented arrow) fixed at centre
    const hdg = gps.value && typeof gps.value.heading === "number" ? gps.value.heading : null;
    ctx.save();
    ctx.translate(S / 2, S / 2);
    if (hdg != null) ctx.rotate((hdg * Math.PI) / 180);
    ctx.fillStyle = "#33ff88";
    ctx.strokeStyle = "#0a0f14";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -15); ctx.lineTo(10, 12); ctx.lineTo(0, 5); ctx.lineTo(-10, 12);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  } else {
    // No-fix marker (centre); the map still shows the course default area.
    ctx.fillStyle = "rgba(255,204,68,0.95)";
    ctx.font = "600 24px monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("NO FIX", S / 2, S / 2);
  }
  // GPS lat / lng bottom-left (one per line); horizontal accuracy bottom-right.
  ctx.fillStyle = "#33ff88";
  ctx.font = "600 22px monospace";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";                       // 16px inset all round (matches bottom margin)
  ctx.fillText("LAT " + (live ? formatCoord(live.lat) : "--"), 16, S - 44);
  ctx.fillText("LON " + (live ? formatCoord(live.lng) : "--"), 16, S - 16);
  const ha = typeof gps.value?.h_acc === "number" ? gps.value.h_acc : null;
  ctx.textAlign = "right";
  ctx.fillText("±" + (ha != null ? ha.toFixed(2) : "--") + " m", S - 16, S - 16);
  // frame
  ctx.strokeStyle = "rgba(51,255,136,0.5)";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, S - 4, S - 4);
  minimapTexture.needsUpdate = true;
}

function streamUrl() {
  return `${STREAM_BASE}/api/rover/camera/stream?t=${Date.now()}`;
}
function startStream() {
  if (imgEl) imgEl.src = streamUrl();
}
const BLANK_IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function stopStream() {
  // Chrome은 multipart/x-mixed-replace <img> 스트림을 removeAttribute("src")로 중단하지 않는다 —
  // blank data URI로 src를 교체해야 확실히 abort된다(MapView와 동일 기법). 안 그러면 WebRTC로
  // 전환한 뒤에도 MJPEG 소켓이 살아남아 로버가 불필요한 JPEG 인코딩/업링크를 지속한다.
  if (imgEl) imgEl.src = BLANK_IMG;
}

// Gating-only hold: keeps the rover capturing + WebRTC-publishing without being an
// MJPEG viewer, so the rover skips its JPEG encode+POST while WebRTC is up. MJPEG
// (startStream) is opened only as the fallback while WebRTC isn't connected.
let holdSource = null;
function startHold() {
  if (holdSource) return;
  holdSource = new EventSource(`${STREAM_BASE}/api/rover/camera/hold?mode=vr`);
  // Surfaced reconnect/viewer-cap UX: the hold is subject to the shared viewer cap
  // (503) and drops with the server. EventSource auto-retries; just flag the gap so
  // the operator knows the picture may not come (the HUD also shows CONNECTING).
  holdSource.addEventListener("error", () => {
    if (!usingWebrtc.value) notifyWarn("카메라 홀드 재연결 중… (뷰어 한도 초과 시 안 보일 수 있음)");
  });
}
function stopHold() {
  if (holdSource) { holdSource.close(); holdSource = null; }
}

// WHEP: pull the rover's H.264 WebRTC stream from mediamtx (via the same-origin
// 443 → caddy signaling route). Media (SRTP/UDP) is peer↔mediamtx direct.
// Retried every few seconds until frames flow: on VR entry the reader often
// beats the rover's publisher online (mediamtx: "no stream available"), so a
// single attempt loses the race — keep re-attempting until the <video> delivers
// frames, then stop. MJPEG shows meanwhile (and stays as the fallback).
let whepTimer = null;
let whepStop = false;
let whepBusy = false;
let whepConnected = false;  // stop re-attempting once the peer connection is up

async function whepAttempt() {
  // Re-attempt ONLY while not connected — creating a new session while one is
  // live would close the working connection (the flicker we had).
  if (whepStop || whepBusy || whepConnected) return;
  whepBusy = true;
  try {
    if (whepPc) { try { whepPc.close(); } catch {} whepPc = null; }
    // STUN so the browser gets a server-reflexive (public) candidate — without it
    // ICE has no reachable pair to mediamtx across NAT and fails.
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    whepPc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (e) => {
      if (videoEl && e.streams[0]) {
        videoEl.srcObject = e.streams[0];
        videoEl.play().catch(() => {});
      }
      whepConnected = true; // media arriving — the reliable "connected" signal
      stopStream();         // WebRTC is up → drop the MJPEG fallback (mjpeg-off)
    };
    pc.onconnectionstatechange = () => {
      if (pc !== whepPc) return; // ignore a superseded pc
      const s = pc.connectionState;
      // "disconnected" is usually a transient ICE blip that recovers — only a
      // terminal state should drop us back to MJPEG / trigger a re-attempt.
      if (s === "failed" || s === "closed") {
        whepConnected = false;
        // Clear the stream so videoWidth drops to 0 → render() stops treating the
        // (now frozen) last stereo frame as live: it reveals the MJPEG fallback and
        // the HUD flips to CONNECTING/LINK LOST instead of showing a stale image.
        if (videoEl) { try { videoEl.srcObject = null; } catch {} }
        startStream();      // WebRTC dropped → MJPEG fallback (mjpeg-on)
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(`${STREAM_BASE}/api/rtc/rover-vr/whep`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
      // Bound the request: without this a hung POST leaves `whepBusy` true forever,
      // and the 3s retry no-ops for the rest of the session (no WebRTC reconnect).
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`WHEP ${res.status}`);
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  } catch {
    if (whepPc) { try { whepPc.close(); } catch {} whepPc = null; }
    whepConnected = false;
    // swallow — the interval re-attempts until connected
  } finally {
    whepBusy = false;
  }
}

function startWhep() {
  whepStop = false;
  whepConnected = false;
  whepAttempt();
  whepTimer = setInterval(whepAttempt, 3000);
}
function stopWhep() {
  whepStop = true;
  whepConnected = false;
  if (whepTimer) { clearInterval(whepTimer); whepTimer = null; }
  usingWebrtc.value = false;
  if (whepPc) { try { whepPc.close(); } catch {} whepPc = null; }
  if (videoEl) { try { videoEl.srcObject = null; } catch {} }
}

function onSessionStart() {
  // Stream + WHEP already run from mount (so the flat 2D preview works without a
  // headset too); entering VR only adds controller driving.
  control.start({ onRelease: () => notifyWarn("로버 연결이 끊어져 수동 제어를 해제했습니다.") });
}
function onSessionEnd() {
  control.stop();      // keep the stream/WHEP alive for the flat preview
  pumpOn = false;
}

// ── controller input ─────────────────────────────────────────────────────────
function edge(key, btn) {
  const now = !!(btn && btn.pressed);
  const was = !!prevBtn[key];
  prevBtn[key] = now;
  return { rising: now && !was, falling: !now && was };
}

function pollInput(session) {
  let throttle = 0;
  let steering = 0;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const ax = gp.axes || [];
    const b = gp.buttons || [];
    // The thumbstick is at axes[2]/[3] in the xr-standard mapping (axes[0]/[1] =
    // legacy touchpad). Some runtimes differ, so use whichever pair is deflected
    // more — robust to the axis-index layout.
    const m23 = Math.hypot(ax[2] || 0, ax[3] || 0);
    const m01 = Math.hypot(ax[0] || 0, ax[1] || 0);
    const sx = m23 >= m01 ? (ax[2] || 0) : (ax[0] || 0);
    const sy = m23 >= m01 ? (ax[3] || 0) : (ax[1] || 0);
    if (src.handedness === "right") {
      throttle = -shapeStick(sy) * 100; // stick up = forward
      steering = shapeStick(sx) * 100;  // stick right = steer right
      if (edge("A", b[4]).rising) setMinimapZoom(+1); // A: minimap zoom in
      if (edge("B", b[5]).rising) setMinimapZoom(-1); // B: minimap zoom out
      // Grip (squeeze, middle finger) = emergency stop. Separate finger from the
      // thumb (stick) and index (trigger/pump), so it can't be nudged while driving.
      if (edge("GRIP", b[1]).rising) toggleEstop();
      const trig = edge("TRIG", b[0]);
      if (trig.rising) setPump(true);
      if (trig.falling) setPump(false);
    }
  }
  control.setInput(throttle, steering);
}

// Grip toggles the e-stop, decided from the live nav_state: /stop while running,
// /clear-emergency when already latched. So the headset can both stop AND release.
function toggleEstop() {
  const clearing = navState.value === "EMERGENCY_STOP";
  const path = clearing ? "/api/rover/clear-emergency" : "/api/rover/stop";
  if (!clearing) control.setInput(0, 0);
  request(path, { method: "POST" })
    .then(() => notifyWarn(clearing ? "비상정지 해제" : "비상정지 전송됨"))
    .catch((e) => notifyError((clearing ? "해제" : "정지") + " 실패: " + e.message));
}
function setPump(on) {
  if (pumpOn === on) return;
  pumpOn = on;
  request("/api/rover/pump", { method: "POST", body: JSON.stringify({ on }) })
    .catch((e) => notifyError("펌프 제어 실패: " + e.message));
}

// ── HUD (head-locked, drawn to a transparent canvas texture) ───────────────────
function fmtSigned(v) {
  const n = Math.round(v);
  return (n > 0 ? "+" : "") + n;
}
// Long nav states blow past the VR FOV; abbreviate to fixed short codes.
function navShort(s) {
  if (!s) return "STANDBY";
  return { EMERGENCY_STOP: "E-STOP", NAVIGATING: "DRIVE", SETTLING: "SETTLE",
    SPRAYING: "SPRAY", PAUSED: "PAUSED", IDLE: "IDLE" }[s] || s;
}
// Fighter-jet style: airspeed/throttle on the LEFT, altitude/systems on the RIGHT,
// bore reticle + heading + link status down the CENTRE — the classic framing. Every
// cell is LEFT-aligned monospace with a fixed-width label, so a value changing length
// never shifts the existing glyphs (no jitter) and no cell overlaps another. Kept
// well inside the headset FOV (short values, columns pulled toward centre) — the wide
// corner layout ran off the edges.
const FIX_SHORT = {
  rtk_fixed: "RTK", rtk_float: "FLT", "3d_fix": "3D", "2d_fix": "2D", time_only: "NO", no_fix: "NO",
};
function drawHud() {
  if (!hudCtx) return;
  const ctx = hudCtx, W = hudCanvas.width, H = hudCanvas.height;
  const G = "#33ff88", cx = W / 2, cy = H / 2;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = G; ctx.fillStyle = G; ctx.lineWidth = 2.5;
  ctx.shadowColor = "rgba(51,255,136,0.45)"; ctx.shadowBlur = 6;

  const g = gps.value || {}, b = battery.value || {};
  const thr = control.throttle.value, str = control.steering.value;
  const num = (v, d, u) => (typeof v === "number" ? v.toFixed(d) + (u || "") : "--");

  // Velocity-vector reticle — TRUE centre of view.
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.moveTo(cx - 36, cy); ctx.lineTo(cx - 16, cy);
  ctx.moveTo(cx + 16, cy); ctx.lineTo(cx + 36, cy);
  ctx.moveTo(cx, cy - 16); ctx.lineTo(cx, cy - 32);
  ctx.stroke();

  // Heading tape (top-centre): a horizontal bar with the compass ticks/labels BELOW
  // it, and the current heading boxed just ABOVE the bar.
  const hdg = typeof g.heading === "number" ? ((g.heading % 360) + 360) % 360 : null;
  const HW = 300, ppd = HW / 45, barY = 92;
  ctx.save();
  ctx.beginPath(); ctx.rect(cx - HW, 84, HW * 2, 64); ctx.clip();
  ctx.beginPath(); ctx.moveTo(cx - HW, barY); ctx.lineTo(cx + HW, barY); ctx.stroke();
  if (hdg != null) {
    ctx.font = "600 20px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let d = Math.ceil((hdg - 45) / 5) * 5; d <= hdg + 45; d += 5) {
      const x = cx + (d - hdg) * ppd, dd = ((d % 360) + 360) % 360, tall = dd % 10 === 0;
      ctx.beginPath(); ctx.moveTo(x, barY); ctx.lineTo(x, barY + (tall ? 14 : 8)); ctx.stroke();
      if (dd % 30 === 0) ctx.fillText(String(dd).padStart(3, "0"), x, barY + 30);
    }
  }
  ctx.restore();
  // Caret (▼) below the bar centre — gap below the bar matches the number box's gap above it (12px).
  ctx.beginPath(); ctx.moveTo(cx - 9, barY + 12); ctx.lineTo(cx + 9, barY + 12); ctx.lineTo(cx, barY + 25); ctx.closePath(); ctx.fill();
  ctx.font = "600 26px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.strokeRect(cx - 34, barY - 42, 68, 30);
  ctx.fillText(hdg != null ? String(Math.round(hdg)).padStart(3, "0") : "--", cx, barY - 27);

  // Airspeed box (left of centre) + altitude box (right) — classic HUD framing.
  ctx.textBaseline = "middle";
  const sx = cx - 380;
  ctx.strokeRect(sx, cy - 26, 150, 52);
  ctx.beginPath(); ctx.moveTo(sx + 150, cy - 11); ctx.lineTo(sx + 166, cy); ctx.lineTo(sx + 150, cy + 11); ctx.stroke();
  ctx.textAlign = "left"; ctx.font = "600 20px monospace"; ctx.fillText("SPD", sx + 4, cy - 42);
  ctx.font = "600 30px monospace"; ctx.fillText(num(g.speed, 1), sx + 10, cy + 1); // +1: optical nudge (middle baseline centres the em box → digits read a touch high)
  ctx.textAlign = "right"; ctx.font = "600 18px monospace"; ctx.fillText("m/s", sx + 140, cy + 1); // unit inside box, right margin = left margin (10)
  const ax = cx + 230;
  ctx.strokeRect(ax, cy - 26, 150, 52);
  ctx.beginPath(); ctx.moveTo(ax, cy - 11); ctx.lineTo(ax - 16, cy); ctx.lineTo(ax, cy + 11); ctx.stroke();
  ctx.textAlign = "left"; ctx.font = "600 20px monospace"; ctx.fillText("ALT", ax + 4, cy - 42);
  ctx.font = "600 30px monospace"; ctx.fillText(num(g.altitude, ALT_DECIMALS), ax + 10, cy + 1);
  ctx.textAlign = "right"; ctx.font = "600 18px monospace"; ctx.fillText("m", ax + 140, cy + 1);

  // Throttle bar (left, vertical, fill from centre) + steering bar (bottom, bar only).
  const tx = 140, tHalf = 150;
  ctx.strokeRect(tx, cy - tHalf, 26, tHalf * 2);
  ctx.beginPath(); ctx.moveTo(tx - 8, cy); ctx.lineTo(tx + 34, cy); ctx.stroke();
  const tf = Math.max(-1, Math.min(1, thr / 100));
  ctx.fillRect(tx, cy - tf * tHalf, 26, tf * tHalf);
  ctx.textAlign = "center"; ctx.font = "600 22px monospace";
  ctx.fillText("THR", tx + 13, cy - tHalf - 24);
  ctx.fillText(fmtSigned(thr), tx + 13, cy + tHalf + 26);
  const syb = H - 92, sHalf = 240;
  ctx.strokeRect(cx - sHalf, syb, sHalf * 2, 24);
  ctx.beginPath(); ctx.moveTo(cx, syb - 8); ctx.lineTo(cx, syb + 32); ctx.stroke();
  const sf = Math.max(-1, Math.min(1, str / 100));
  ctx.fillRect(cx + sf * sHalf - 6, syb - 4, 12, 32);
  // Link / nav status where the STR text used to be (bottom-centre, above the bar).
  // Shows the rover's nav_state (IDLE / DRIVE / PAUSED / E-STOP …) whenever the
  // rover link is up — NOT gated on the WebRTC video (control works over the SSE
  // even if rover-vr isn't publishing). NO LINK only when the rover is disconnected.
  let link = navShort(navState.value), lc = G;
  if (!roverConnected.value) { link = "NO LINK"; lc = "#ff5555"; }
  else if (!hasVideo.value) { link = "CONNECTING"; lc = "#ffcc44"; }  // no picture yet (any source)
  else if (navState.value === "EMERGENCY_STOP") { lc = "#ff5555"; }
  else if (navState.value === "PAUSED") { lc = "#ffcc44"; }
  ctx.fillStyle = lc; ctx.fillText(link, cx, syb - 26); ctx.fillStyle = G;

  // Corner readouts — left-aligned monospace with fixed-width labels (no jitter).
  ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = "600 24px monospace";
  const cell = (label, val, x, y, color) => { ctx.fillStyle = color || G; ctx.fillText(label.padEnd(5) + val, x, y); ctx.fillStyle = G; };
  const fix = fixStatus.value ? (FIX_SHORT[fixStatus.value] || "NO") : "NO";
  // Left/right clusters, mirror-symmetric about centre (both left-aligned so values
  // never jitter). Lifted clear of the steering bar at the bottom.
  const xl = 300, xr = 850;
  cell("GPS", fix, xr, 178);                                          // top-right, clear of the heading-tape labels
  cell("ACC", g.h_acc != null ? "±" + g.h_acc.toFixed(2) + "m" : "--", xr, 214);
  cell("SAT", g.num_sv != null ? String(g.num_sv) : "--", xr, 250);
  cell("BATT", b.percent != null ? Math.round(b.percent) + "%" : "--", xl, H - 190); // bottom-left
  cell("VOLT", num(b.voltage, 1, "V"), xl, H - 154);
  cell("CTRL", control.active.value ? (control.ok.value ? "OK" : "FAIL") : "OFF", xr, H - 190); // bottom-right
  cell("PUMP", pumpOn ? "ON" : "OFF", xr, H - 154);

  ctx.shadowBlur = 0;
  hudTexture.needsUpdate = true;
}

// ── render loop ────────────────────────────────────────────────────────────────
function render() {
  const session = renderer.xr.getSession();
  if (session) pollInput(session);
  const webrtcReady = !!(videoEl && videoEl.videoWidth > 0);
  const inXR = renderer.xr.isPresenting;
  usingWebrtc.value = webrtcReady;
  hasVideo.value = webrtcReady || !!(imgEl && imgEl.naturalWidth > 0); // WebRTC OR MJPEG fallback
  // Per-eye stereo meshes only render in XR (layers 1/2); show them once video is up.
  screenL.visible = webrtcReady;
  screenR.visible = webrtcReady;
  // Mono screen (layer 0 = both eyes): hide in XR once stereo video is up, else it
  // would overlay both eyes. It's the flat-preview surface and the MJPEG fallback.
  screenMono.visible = !(webrtcReady && inXR);
  if (webrtcReady) {
    // flat preview: show the left half of the SBS on the mono screen.
    if (screenMat.map !== videoTextureL) { screenMat.map = videoTextureL; screenMat.needsUpdate = true; }
  } else {
    if (screenMat.map !== texture) { screenMat.map = texture; screenMat.needsUpdate = true; }
    if (imgEl && imgEl.naturalWidth > 0) texture.needsUpdate = true; // MJPEG needs explicit upload
  }
  if (frame++ % 6 === 0) drawHud(); // ~throttled status refresh
  if (minimapDirty) { drawMinimap(); minimapDirty = false; }
  renderer.render(scene, camera);
}

function onResize() {
  if (!renderer || !containerEl.value) return;
  const w = containerEl.value.clientWidth;
  const h = containerEl.value.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function connectStatus() {
  evtSource = new EventSource(`${STREAM_BASE}/api/events`);
  evtSource.addEventListener("rover:status", (e) => {
    try {
      const d = JSON.parse(e.data);
      navState.value = d.nav_state ?? null;
      roverConnected.value = !!d.connected;
      if (appNavState) appNavState.value = navState.value;
      if (appRoverConnected) appRoverConnected.value = roverConnected.value;
      battery.value = d.battery ?? null;
      gps.value = d.gps ?? null;
      fixStatus.value = d.fix_status ?? null;
      if (d.last_position && typeof d.last_position.lat === "number") {
        roverPos.value = { lat: d.last_position.lat, lng: d.last_position.lng };
        minimapDirty = true; // rover moved → recentre the minimap
      }
    } catch { /* ignore malformed frame */ }
  });
}

// Radial-gradient comfort vignette: transparent centre → dark edges. Head-locked,
// so it always softens the peripheral FOV (reduces vection / motion discomfort).
function makeVignetteTexture() {
  const s = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(s / 2, s / 2, s * 0.32, s / 2, s / 2, s * 0.5);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

onMounted(() => {
  const w = containerEl.value.clientWidth || window.innerWidth;
  const h = containerEl.value.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101014);
  camera = new THREE.PerspectiveCamera(70, w / h, 0.1, 100);
  scene.add(camera); // so head-locked children (HUD, vignette) render + follow the head

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local");
  containerEl.value.appendChild(renderer.domElement);

  // MJPEG source → texture (detached <img>; uploaded each frame in render()).
  imgEl = new Image();
  imgEl.addEventListener("error", () => notifyWarn("카메라 신호 없음"));
  texture = new THREE.Texture(imgEl);
  texture.colorSpace = THREE.SRGBColorSpace;

  // WHEP <video> = the rover's rectified SBS stereo pair. Two VideoTextures read
  // the same element, each cropped to one half (repeat.x 0.5) → left / right eye.
  videoEl = document.createElement("video");
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoTextureL = new THREE.VideoTexture(videoEl);
  videoTextureL.colorSpace = THREE.SRGBColorSpace;
  videoTextureL.repeat.set(0.5, 1);
  videoTextureL.offset.set(0, 0);
  videoTextureR = new THREE.VideoTexture(videoEl);
  videoTextureR.colorSpace = THREE.SRGBColorSpace;
  videoTextureR.repeat.set(0.5, 1);
  videoTextureR.offset.set(0.5, 0);

  const geo = new THREE.PlaneGeometry(2.4, 1.35); // one 16:9 eye, ~2.2 m ahead
  // Mono surface (layer 0 = both eyes): MJPEG fallback, and the flat 2D preview
  // (shows the left half of the SBS). Hidden in XR once stereo video is up.
  screenMat = new THREE.MeshBasicMaterial({ map: texture });
  screenMono = new THREE.Mesh(geo, screenMat);
  screenMono.position.set(0, 0, -2.2);
  scene.add(screenMono);
  // Per-eye stereo surfaces. layer 1 → left eye, layer 2 → right eye: three's XR
  // ArrayCamera renders layer 1 only to the left camera, layer 2 only to the
  // right. They simply don't render in the flat (single-camera) mirror.
  screenL = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: videoTextureL }));
  screenL.position.set(0, 0, -2.2);
  screenL.layers.set(1);
  scene.add(screenL);
  screenR = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: videoTextureR }));
  screenR.position.set(0, 0, -2.2);
  screenR.layers.set(2);
  scene.add(screenR);

  // Minimap — world-locked to the left of the screen, angled toward the viewer.
  minimapCanvas = document.createElement("canvas");
  minimapCanvas.width = minimapCanvas.height = MINIMAP_PX;
  minimapCtx = minimapCanvas.getContext("2d");
  minimapTexture = new THREE.CanvasTexture(minimapCanvas);
  minimapTexture.colorSpace = THREE.SRGBColorSpace;
  drawMinimap();
  const minimap = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 1.3),
    new THREE.MeshBasicMaterial({ map: minimapTexture }),
  );
  minimap.position.set(-2.15, 0, -2.15);
  minimap.rotation.y = 0.6; // face the viewer
  scene.add(minimap);

  // Fighter-jet HUD — head-locked (child of the camera), transparent, drawn on top.
  hudCanvas = document.createElement("canvas");
  hudCanvas.width = 1280;
  hudCanvas.height = 720;
  hudCtx = hudCanvas.getContext("2d");
  hudTexture = new THREE.CanvasTexture(hudCanvas);
  hudTexture.colorSpace = THREE.SRGBColorSpace;
  drawHud();
  // Sized + positioned so the full jet-HUD spread (throttle bar far-left … systems
  // far-right, ~±28°) stays within the headset FOV without feeling cramped.
  const hud = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 1.125),
    new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true, depthTest: false, depthWrite: false }),
  );
  hud.position.set(0, 0, -1.6);
  hud.renderOrder = 20;
  camera.add(hud);

  // Comfort vignette — head-locked, peripheral darkening.
  const vignette = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 1.7),
    new THREE.MeshBasicMaterial({ map: makeVignetteTexture(), transparent: true, depthTest: false, depthWrite: false }),
  );
  vignette.position.set(0, 0, -1.0);
  vignette.renderOrder = 15;
  camera.add(vignette);

  vrButtonEl = VRButton.createButton(renderer);
  containerEl.value.appendChild(vrButtonEl);

  renderer.xr.addEventListener("sessionstart", onSessionStart);
  renderer.xr.addEventListener("sessionend", onSessionEnd);
  renderer.setAnimationLoop(render);
  window.addEventListener("resize", onResize);
  connectStatus();
  // Start the video pipeline on mount so the flat 2D preview (no headset) shows
  // the feed + HUD; VR entry only adds controller driving.
  startHold();     // gating (keeps the rover publishing) independent of MJPEG
  startStream();   // MJPEG fallback until WebRTC connects (then ontrack stops it)
  startWhep();
});

onUnmounted(() => {
  window.removeEventListener("resize", onResize);
  control.stop();
  stopStream();
  stopWhep();
  stopHold();
  if (evtSource) evtSource.close();
  // Free GPU resources renderer.dispose() does NOT release: every geometry and
  // material (and each material's texture — including the vignette CanvasTexture,
  // which has no standalone handle). The camera's HUD/vignette children are in the
  // graph via scene.add(camera), so the traversal reaches them too.
  if (scene) {
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    });
  }
  if (renderer) {
    renderer.setAnimationLoop(null);
    renderer.xr.removeEventListener("sessionstart", onSessionStart);
    renderer.xr.removeEventListener("sessionend", onSessionEnd);
    const session = renderer.xr.getSession();
    if (session) session.end().catch(() => {});
    if (renderer.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    renderer.dispose();
    renderer.forceContextLoss(); // release the WebGL context (browsers cap ~16 live)
  }
  if (vrButtonEl?.parentNode) vrButtonEl.parentNode.removeChild(vrButtonEl);
  // screenMat.map alternates between these at runtime, so the traversal only
  // disposed whichever was current — dispose both video textures + the MJPEG one.
  if (texture) texture.dispose();
  if (videoTextureL) videoTextureL.dispose();
  if (videoTextureR) videoTextureR.dispose();
});
</script>

<template>
  <div class="vr-root" ref="containerEl">
    <div class="vr-overlay">
      <button class="vr-back" @click="goBack">←</button>
      <table class="vr-keys">
        <tbody>
          <tr><th>오른쪽 스틱</th><td>전/후진 + 조향</td></tr>
          <tr><th>오른쪽 트리거</th><td>펌프</td></tr>
          <tr><th>오른쪽 그립</th><td>비상정지</td></tr>
          <tr><th>A / B</th><td>미니맵 확대 / 축소</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.vr-root {
  position: relative;
  width: 100%;
  height: 100%;
  background: #101014;
  overflow: hidden;
}
.vr-root :deep(canvas) {
  display: block;
}
.vr-overlay {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 1rem;
  pointer-events: none;
}
.vr-back {
  pointer-events: auto;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  cursor: pointer;
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 999px;
  font-size: 1.2rem;
  font-weight: 700;
  line-height: 1;
}
.vr-keys {
  pointer-events: auto;
  border-collapse: collapse;
  color: #e5e7eb;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 0.5rem;
  overflow: hidden;
  font-size: 0.85rem;
}
.vr-keys th,
.vr-keys td {
  padding: 0.3rem 0.7rem;
  text-align: left;
}
.vr-keys th {
  font-weight: 700;
  color: #fff;
  border-right: 1px solid rgba(255, 255, 255, 0.15);
  white-space: nowrap;
}
.vr-keys tr + tr th,
.vr-keys tr + tr td {
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
</style>
