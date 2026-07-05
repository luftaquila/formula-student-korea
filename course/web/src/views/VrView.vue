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
 * /clear-emergency + /resume + /pump. A status HUD (below the screen) shows
 * nav_state, connection/source, and the throttle/steering being sent.
 *
 * Controls (right controller): stick = throttle (Y) + steering (X),
 * A = emergency-stop TOGGLE (stop ↔ clear), B = resume, trigger = pump.
 */
import { onMounted, onUnmounted, ref } from "vue";
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { request } from "../api.js";
import { useRoverControl } from "../composables/useRoverControl.js";
import { useNotification } from "@shared/useNotification.js";

const { error: notifyError, warning: notifyWarn, success: notifySuccess } = useNotification();
const containerEl = ref(null);
const control = useRoverControl();

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
const usingWebrtc = ref(false); // true once the WHEP video is delivering frames

const STREAM_BASE = import.meta.env.PROD ? "/course" : "";
const DEADZONE = 0.08; // thumbstick rest drift
const prevBtn = {};    // edge-detection state for buttons
let pumpOn = false;
let frame = 0;

// Live rover status (SSE rover:status), for the e-stop toggle + HUD.
const navState = ref(null);
const roverConnected = ref(false);
let evtSource = null;

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
      const b = gp.buttons || [];
      if (edge("A", b[4]).rising) toggleEstop(); // A: stop ↔ clear
      if (edge("B", b[5]).rising) resumeMission(); // B
      const trig = edge("TRIG", b[0]);
      if (trig.rising) setPump(true);
      if (trig.falling) setPump(false);
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

// ── status HUD ─────────────────────────────────────────────────────────────────
function drawHud() {
  if (!hudCtx) return;
  const c = hudCanvas;
  hudCtx.fillStyle = "rgba(10,10,16,0.85)";
  hudCtx.fillRect(0, 0, c.width, c.height);
  hudCtx.fillStyle = "#e5e7eb";
  hudCtx.font = "600 32px monospace";
  hudCtx.textBaseline = "top";
  const post = control.active.value ? (control.ok.value ? "OK" : "FAIL") : "off";
  const stereo = videoEl && videoEl.videoWidth > videoEl.videoHeight * 2.4;
  const src = usingWebrtc.value ? `WebRTC(H264 ${stereo ? "3D" : "2D"})` : "MJPEG";
  const lines = [
    `state ${navState.value || "-"}   conn ${roverConnected.value ? "yes" : "no"}   src ${src}`,
    `T ${control.throttle.value}   S ${control.steering.value}   ctrl ${post}`,
  ];
  lines.forEach((ln, i) => hudCtx.fillText(ln, 18, 16 + i * 52));
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
    } catch { /* ignore malformed frame */ }
  });
}

onMounted(() => {
  const w = containerEl.value.clientWidth || window.innerWidth;
  const h = containerEl.value.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101014);
  camera = new THREE.PerspectiveCamera(70, w / h, 0.1, 100);

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

  // Status HUD, below the screen.
  hudCanvas = document.createElement("canvas");
  hudCanvas.width = 720;
  hudCanvas.height = 260;
  hudCtx = hudCanvas.getContext("2d");
  hudTexture = new THREE.CanvasTexture(hudCanvas);
  hudTexture.colorSpace = THREE.SRGBColorSpace;
  drawHud();
  const hud = new THREE.Mesh(
    new THREE.PlaneGeometry(1.44, 0.52),
    new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true }),
  );
  hud.position.set(0, -1.0, -2.0);
  scene.add(hud);

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
  if (renderer) {
    renderer.setAnimationLoop(null);
    renderer.xr.removeEventListener("sessionstart", onSessionStart);
    renderer.xr.removeEventListener("sessionend", onSessionEnd);
    const session = renderer.xr.getSession();
    if (session) session.end().catch(() => {});
    if (renderer.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    renderer.dispose();
  }
  if (vrButtonEl?.parentNode) vrButtonEl.parentNode.removeChild(vrButtonEl);
  if (texture) texture.dispose();
  if (videoTextureL) videoTextureL.dispose();
  if (videoTextureR) videoTextureR.dispose();
  if (hudTexture) hudTexture.dispose();
});
</script>

<template>
  <div class="vr-root" ref="containerEl">
    <div class="vr-overlay">
      <router-link to="/" class="vr-back">← 코스로</router-link>
      <p class="vr-hint">
        헤드셋에서 <b>VR 진입</b> 후 — 오른손 스틱: 전/후진 + 조향 ·
        <b>A</b>: 비상정지 토글 · <b>B</b>: 재개 · <b>트리거</b>: 펌프
      </p>
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
  right: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  pointer-events: none;
}
.vr-back {
  pointer-events: auto;
  align-self: flex-start;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  padding: 0.4rem 0.8rem;
  border-radius: 999px;
  text-decoration: none;
  font-weight: 600;
}
.vr-hint {
  margin: 0;
  max-width: 40rem;
  color: #e5e7eb;
  background: rgba(0, 0, 0, 0.45);
  padding: 0.5rem 0.8rem;
  border-radius: 0.5rem;
  font-size: 0.85rem;
  line-height: 1.4;
}
</style>
