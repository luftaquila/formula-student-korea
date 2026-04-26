<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import NavMenu from "@shared/NavMenu.vue";
import { useRoute } from "vue-router";
import { request } from "./api.js";

const route = useRoute();
const roverConnected = ref(false);
const navState = ref(null);
const stopping = ref(false);

let es = null;

const ACTIVE_NAV_STATES = new Set([
  "CALIBRATING", "NAVIGATING", "SETTLING", "SPRAYING", "RETURNING",
]);

function isMissionActive() {
  return roverConnected.value && ACTIVE_NAV_STATES.has(navState.value);
}

function inEmergency() {
  return navState.value === "EMERGENCY_STOP";
}

async function globalEmergencyStop() {
  if (stopping.value || !roverConnected.value) return;
  stopping.value = true;
  try {
    const path = inEmergency() ? "/api/rover/clear-emergency" : "/api/rover/stop";
    await request(path, { method: "POST" });
  } catch (err) {
    alert((inEmergency() ? "비상정지 해제 실패: " : "비상정지 실패: ") + err.message);
  } finally {
    stopping.value = false;
  }
}

onMounted(async () => {
  try {
    const res = await request("/api/rover/status");
    const data = await res.json();
    roverConnected.value = !!data.connected;
    navState.value = data.nav_state || null;
  } catch { /* best-effort */ }

  const base = import.meta.env.PROD ? "/course" : "";
  es = new EventSource(`${base}/api/events`);
  es.addEventListener("rover:status", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (typeof data.connected === "boolean") roverConnected.value = data.connected;
      if (typeof data.nav_state === "string") navState.value = data.nav_state;
    } catch {}
  });
});

onUnmounted(() => {
  if (es) es.close();
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

/* Floating e-stop — always reachable from any route. Bigger / redder
   when the rover is actually moving. */
.global-estop {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  z-index: 2000;
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
