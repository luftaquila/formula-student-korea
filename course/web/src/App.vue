<script setup>
import { ref, watch, provide, onMounted, onUnmounted } from "vue";
import NavMenu from "@shared/NavMenu.vue";
import { useRoute } from "vue-router";
import { request } from "./api.js";
import { useNotification } from "@shared/useNotification.js";

const { error: notifyError } = useNotification();

const route = useRoute();
const roverConnected = ref(false);
const navState = ref(null);
const stopping = ref(false);
provide("roverConnected", roverConnected);
provide("navState", navState);
// Visible to MapView (and any future descendant) via inject so the path-execute
// button can surface "정지 요청 중..." in the same window the global e-stop
// latch is held — both buttons need to reflect the same in-flight command.
provide("stopping", stopping);

// True only while the SSE link is in a reconnecting state, so the UI can show
// a small "연결 재시도 중" badge instead of silently freezing.
const sseReconnecting = ref(false);
provide("sseReconnecting", sseReconnecting);

// What the operator just commanded — used to decide which terminal nav_state
// releases the latch. Cleared once the rover confirms via telemetry, or after
// a 5s safety timeout so a missed update can never freeze the button.
let stopRequestedKind = null; // "stop" | "clear" | null
let stopReleaseTimer = null;

const ACTIVE_NAV_STATES = new Set([
  "CALIBRATING", "NAVIGATING", "SETTLING", "SPRAYING",
  "CAL_ANTENNA", "CAL_WHEELS",
]);

function isMissionActive() {
  return roverConnected.value && ACTIVE_NAV_STATES.has(navState.value);
}

function inEmergency() {
  return navState.value === "EMERGENCY_STOP";
}

function clearStopLatch() {
  stopping.value = false;
  stopRequestedKind = null;
  if (stopReleaseTimer) { clearTimeout(stopReleaseTimer); stopReleaseTimer = null; }
}

async function globalEmergencyStop() {
  if (stopping.value || !roverConnected.value) return;
  stopRequestedKind = inEmergency() ? "clear" : "stop";
  stopping.value = true;
  try {
    const path = stopRequestedKind === "clear" ? "/api/rover/clear-emergency" : "/api/rover/stop";
    await request(path, { method: "POST" });
  } catch (err) {
    const kind = stopRequestedKind;
    clearStopLatch();
    notifyError((kind === "clear" ? "비상정지 해제 실패: " : "비상정지 실패: ") + err.message);
    return;
  }
  // Hold the latch until telemetry confirms the rover reached the requested
  // terminal state — operators were clicking the button again before the
  // command had even reached the rover.
  stopReleaseTimer = setTimeout(clearStopLatch, 5000);
}

watch(navState, (cur) => {
  if (!stopping.value) return;
  if (stopRequestedKind === "stop" && cur === "EMERGENCY_STOP") clearStopLatch();
  else if (stopRequestedKind === "clear" && cur === "IDLE") clearStopLatch();
});

async function fetchStatus() {
  try {
    const res = await request("/api/rover/status");
    const data = await res.json();
    roverConnected.value = !!data.connected;
    navState.value = data.nav_state || null;
  } catch { /* best-effort */ }
}

onMounted(async () => {
  await fetchStatus();
});

onUnmounted(() => {
  if (stopReleaseTimer) clearTimeout(stopReleaseTimer);
});
</script>

<template>
  <div class="app-container app-fullheight">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📍</span>
          <h1>FSK 코스 관리</h1>
        </a>
        <div class="header-actions">
          <NavMenu :currentPath="'/course' + route.path" />
        </div>
      </div>
    </header>

    <main class="main-fill">
      <router-view />
    </main>

    <!-- SSE 재연결 진행 중 표시: 무음 freeze 방지용. 자동 화해는 onopen 에서
         일어나므로 이 배지는 시각적 신호만 담당. -->
    <div v-if="sseReconnecting" class="sse-reconnecting" role="status">
      <span class="sse-spinner"></span> 연결 재시도 중...
    </div>

    <!-- Global emergency stop: visible only when rover is connected.
         Stronger visual emphasis when a mission is actively running.
         Morphs to a release button when the rover is latched in
         EMERGENCY_STOP so the operator can clear without a tab change. -->
    <button
      v-if="roverConnected"
      :class="['global-estop', { active: isMissionActive(), release: inEmergency() }]"
      :disabled="stopping"
      @click="globalEmergencyStop"
      :title="inEmergency() ? '비상정지 해제' : '비상정지 (모든 화면에서 접근 가능)'"
    >
      <template v-if="stopping">{{ inEmergency() ? '해제 중...' : '정지 중...' }}</template>
      <template v-else-if="inEmergency()">▶ 비상정지 해제</template>
      <template v-else>⏹ 비상정지</template>
    </button>
  </div>
</template>

<style scoped>
.app-fullheight {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
  position: relative;
}

.main-fill {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* z-index 999: same as status-strip; NavMenu drawer (1000) covers it. */
.global-estop {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  z-index: 999;
  padding: 0.85rem 1.25rem;
  border: none;
  border-radius: 999px;
  background: #ef4444;
  color: #fff;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(239, 68, 68, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25);
  transition: transform 0.1s, box-shadow 0.15s;
}
.global-estop:hover:not(:disabled) { transform: translateY(-1px); }
.global-estop:active:not(:disabled) { transform: translateY(0); }
.global-estop:disabled { opacity: 0.6; cursor: not-allowed; }

.global-estop.active {
  background: #dc2626;
  animation: estop-pulse 1.6s ease-in-out infinite;
}

/* Morph into a release button when the rover is latched in EMERGENCY_STOP. */
.global-estop.release {
  background: #16a34a;
  box-shadow: 0 8px 20px rgba(22, 163, 74, 0.35), 0 2px 6px rgba(0,0,0,0.25);
  animation: none;
}
.global-estop.release:hover:not(:disabled) {
  background: #15803d;
}

@keyframes estop-pulse {
  0%, 100% { box-shadow: 0 8px 20px rgba(220, 38, 38, 0.35), 0 0 0 0 rgba(220, 38, 38, 0.7); }
  50% { box-shadow: 0 8px 20px rgba(220, 38, 38, 0.5), 0 0 0 12px rgba(220, 38, 38, 0); }
}

.sse-reconnecting {
  position: fixed;
  top: 0.75rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 998;
  padding: 0.4rem 0.85rem;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.95);
  color: #1f2937;
  font-size: 0.8rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
.sse-spinner {
  width: 0.7rem;
  height: 0.7rem;
  border: 2px solid rgba(31, 41, 55, 0.3);
  border-top-color: #1f2937;
  border-radius: 50%;
  display: inline-block;
  animation: sse-spin 0.8s linear infinite;
}
@keyframes sse-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  /* Sit above the map view's bottom rail (~56px) plus the iOS
     home-indicator safe-area, so the button never overlaps tabs. */
  .global-estop {
    bottom: calc(64px + env(safe-area-inset-bottom));
    right: 0.75rem;
    padding: 0.7rem 1rem;
    font-size: 0.85rem;
  }
}
</style>
