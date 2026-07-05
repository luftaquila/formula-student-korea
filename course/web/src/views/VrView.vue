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
 * Controls — right controller: stick = throttle (Y) + steering (X), trigger = pump,
 * A = emergency-stop TOGGLE (stop ↔ clear), B = resume. Left controller: X/Y =
 * minimap zoom out/in.
 */
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { request } from "../api.js";
import { useRoverControl } from "../composables/useRoverControl.js";
import { useNotification } from "@shared/useNotification.js";

const { error: notifyError, warning: notifyWarn, success: notifySuccess } = useNotification();
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

const STREAM_BASE = import.meta.env.PROD ? "/course" : "";
const DEADZONE = 0.08; // thumbstick rest drift
const prevBtn = {};    // edge-detection state for buttons
let pumpOn = false;
let frame = 0;

// Live rover status (SSE rover:status) — drives the e-stop toggle, the HUD, and
// the minimap. rover:status carries the whole roverState, so battery/gps/position
// are all here.
const navState = ref(null);
const roverConnected = ref(false);
const battery = ref(null);      // { voltage, percent, source }
const gps = ref(null);          // { speed, heading, h_acc, num_sv, ... }
const fixStatus = ref(null);
const roverPos = ref(null);     // { lat, lng }
let evtSource = null;

// ── minimap (VWorld satellite via same-origin tile proxy) ──────────────────────
const MINIMAP_PX = 512;
const MINIMAP_ZOOM_MIN = 15;
const MINIMAP_ZOOM_MAX = 20;
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
  const pos = roverPos.value;
  if (pos) {
    const z = minimapZoom;
    const n = 2 ** z;
    const latRad = (pos.lat * Math.PI) / 180;
    // slippy-map world pixel of the rover (Web Mercator, 256px tiles)
    const xW = ((pos.lng + 180) / 360) * n * 256;
    const yW = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * 256;
    const originX = xW - S / 2;  // world px at canvas (0,0) — rover centered
    const originY = yW - S / 2;
    const tx0 = Math.floor(originX / 256), tx1 = Math.floor((originX + S) / 256);
    const ty0 = Math.floor(originY / 256), ty1 = Math.floor((originY + S) / 256);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
        const img = getTile(z, tx, ty);
        if (img) ctx.drawImage(img, Math.round(tx * 256 - originX), Math.round(ty * 256 - originY));
      }
    }
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
    ctx.fillStyle = "#33ff88";
    ctx.font = "600 30px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("NO GPS", S / 2, S / 2);
  }
  // frame + zoom label
  ctx.strokeStyle = "rgba(51,255,136,0.5)";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, S - 4, S - 4);
  ctx.fillStyle = "#33ff88";
  ctx.font = "600 24px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`MAP  Z${minimapZoom}`, 12, 12);
  minimapTexture.needsUpdate = true;
}

function streamUrl() {
  return `${STREAM_BASE}/api/rover/camera/stream?t=${Date.now()}`;
}
function startStream() {
  if (imgEl) imgEl.src = streamUrl();
}
function stopStream() {
  if (imgEl) imgEl.removeAttribute("src");
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
function dz(v) {
  return Math.abs(v) < DEADZONE ? 0 : v;
}
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
      throttle = -dz(sy) * 100; // stick up = forward
      steering = dz(sx) * 100;  // stick right = steer right
      if (edge("A", b[4]).rising) toggleEstop(); // A: stop ↔ clear
      if (edge("B", b[5]).rising) resumeMission(); // B
      const trig = edge("TRIG", b[0]);
      if (trig.rising) setPump(true);
      if (trig.falling) setPump(false);
    } else if (src.handedness === "left") {
      // X (b[4]) = minimap zoom out, Y (b[5]) = zoom in.
      if (edge("LX", b[4]).rising) setMinimapZoom(-1);
      if (edge("LY", b[5]).rising) setMinimapZoom(+1);
    }
  }
  control.setInput(throttle, steering);
}

function toggleEstop() {
  const clearing = navState.value === "EMERGENCY_STOP";
  const path = clearing ? "/api/rover/clear-emergency" : "/api/rover/stop";
  if (!clearing) control.setInput(0, 0);
  request(path, { method: "POST" })
    .then(() => notifyWarn(clearing ? "비상정지 해제" : "비상정지 전송됨"))
    .catch((e) => notifyError((clearing ? "해제" : "정지") + " 실패: " + e.message));
}
function resumeMission() {
  request("/api/rover/resume", { method: "POST" })
    .then(() => notifySuccess("미션 재개"))
    .catch((e) => notifyError("재개 실패: " + e.message));
}
function setPump(on) {
  if (pumpOn === on) return;
  pumpOn = on;
  request("/api/rover/pump", { method: "POST", body: JSON.stringify({ on }) })
    .catch((e) => notifyError("펌프 제어 실패: " + e.message));
}

// ── fighter-jet HUD (head-locked, drawn to a transparent canvas texture) ───────
function fmtSigned(v) {
  const n = Math.round(v);
  return (n > 0 ? "+" : "") + n;
}
function drawHud() {
  if (!hudCtx) return;
  const c = hudCanvas, ctx = hudCtx, W = c.width, H = c.height;
  const G = "#33ff88";
  const M = 44;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = G;
  ctx.fillStyle = G;
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(51,255,136,0.55)";
  ctx.shadowBlur = 8;
  ctx.font = "600 28px monospace";

  // Center bore reticle.
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.moveTo(-30, 0); ctx.lineTo(-15, 0);
  ctx.moveTo(15, 0); ctx.lineTo(30, 0);
  ctx.moveTo(0, -30); ctx.lineTo(0, -15);
  ctx.stroke();
  ctx.restore();

  // Battery (top-left).
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const bp = battery.value?.percent, bv = battery.value?.voltage;
  ctx.fillText(`BATT ${bp != null ? Math.round(bp) + "%" : "--"}${bv != null ? "  " + bv.toFixed(1) + "V" : ""}`, M, M);

  // Speed (top-right).
  ctx.textAlign = "right";
  const spd = gps.value?.speed;
  ctx.fillText(`SPD ${spd != null ? spd.toFixed(1) : "--"} m/s`, W - M, M);

  // Nav / link state (top-center) — reconnect UX.
  ctx.textAlign = "center";
  let link = navState.value || "STANDBY";
  let linkColor = G;
  if (!roverConnected.value) { link = "◆ LINK LOST"; linkColor = "#ff5555"; }
  else if (!usingWebrtc.value) { link = "◆ CONNECTING"; linkColor = "#ffcc44"; }
  ctx.fillStyle = linkColor;
  ctx.fillText(link, W / 2, M);
  ctx.fillStyle = G;

  // GPS (bottom-left).
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  const fix = fixStatus.value || "--";
  const sv = gps.value?.num_sv;
  const ha = gps.value?.h_acc;
  ctx.fillText(`GPS ${fix}  SV ${sv ?? "--"}  ±${ha != null ? ha.toFixed(2) : "--"}m`, M, H - M - 34);
  const p = roverPos.value;
  ctx.fillText(p ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : "-- , --", M, H - M);

  // Throttle / steering / control (bottom-right).
  ctx.textAlign = "right";
  const post = control.active.value ? (control.ok.value ? "OK" : "FAIL") : "off";
  ctx.fillText(`THR ${fmtSigned(control.throttle.value)}   STR ${fmtSigned(control.steering.value)}`, W - M, H - M - 34);
  ctx.fillText(`CTRL ${post}   PUMP ${pumpOn ? "ON" : "off"}`, W - M, H - M);

  // Throttle tape (left of center): vertical scale, fill up=forward / down=reverse.
  const tapeX = M + 10, tapeCy = H / 2, tapeH = H * 0.30;
  ctx.lineWidth = 2;
  ctx.strokeRect(tapeX, tapeCy - tapeH, 14, tapeH * 2);
  ctx.beginPath(); ctx.moveTo(tapeX, tapeCy); ctx.lineTo(tapeX + 14, tapeCy); ctx.stroke();
  const tFrac = Math.max(-1, Math.min(1, control.throttle.value / 100));
  ctx.fillRect(tapeX, tapeCy - tFrac * tapeH, 14, tFrac * tapeH);

  // Steering bar (below center): horizontal scale with a marker.
  const barW = W * 0.30, barCx = W / 2, barY = H / 2 + tapeH + 30;
  ctx.strokeRect(barCx - barW, barY, barW * 2, 14);
  ctx.beginPath(); ctx.moveTo(barCx, barY); ctx.lineTo(barCx, barY + 14); ctx.stroke();
  const sFrac = Math.max(-1, Math.min(1, control.steering.value / 100));
  ctx.fillRect(barCx + sFrac * barW - 4, barY - 4, 8, 22);

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
  hudCanvas.width = 1024;
  hudCanvas.height = 576;
  hudCtx = hudCanvas.getContext("2d");
  hudTexture = new THREE.CanvasTexture(hudCanvas);
  hudTexture.colorSpace = THREE.SRGBColorSpace;
  drawHud();
  const hud = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 1.07),
    new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true, depthTest: false, depthWrite: false }),
  );
  hud.position.set(0, 0, -1.4);
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
          <tr><th>트리거</th><td>펌프</td></tr>
          <tr><th>A</th><td>비상정지 토글</td></tr>
          <tr><th>B</th><td>재개</td></tr>
          <tr><th>왼쪽 X / Y</th><td>미니맵 축소 / 확대</td></tr>
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
