<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import {
  clearFullscreenLayout,
  isFullscreenSupported,
  syncFullscreenLayout,
  toggleFullscreen,
} from "./fullscreen.js";
import { useNotification } from "./useNotification.js";

const { error } = useNotification();
const supported = ref(false);
const fullscreen = ref(false);

function syncFullscreen() {
  fullscreen.value = syncFullscreenLayout(document);
}

async function toggle() {
  try {
    await toggleFullscreen(document);
    syncFullscreen();
  } catch {
    error("전체화면을 전환할 수 없습니다.");
  }
}

onMounted(() => {
  supported.value = isFullscreenSupported(document);
  syncFullscreen();
  document.addEventListener("fullscreenchange", syncFullscreen);
});

onUnmounted(() => {
  document.removeEventListener("fullscreenchange", syncFullscreen);
  clearFullscreenLayout(document);
});
</script>

<template>
  <button
    v-if="supported"
    class="fullscreen-button"
    type="button"
    :title="fullscreen ? '전체화면 종료' : '전체화면'"
    :aria-label="fullscreen ? '전체화면 종료' : '전체화면'"
    @click="toggle"
  >
    <svg v-if="!fullscreen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
    </svg>
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M21 16h-3a2 2 0 0 0-2 2v3M3 16h3a2 2 0 0 1 2 2v3" />
    </svg>
  </button>
</template>

<style scoped>
.fullscreen-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.fullscreen-button:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.1);
}

.fullscreen-button svg {
  width: 20px;
  height: 20px;
}
</style>
