<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";
import { device } from "@shared/deviceStore.js";

const route = useRoute();
const isKiosk = computed(() => route.path === "/register" && device.value?.scope === "kiosk.registration.register");

const pageInfo = {
  "/manage": { title: "등록 대기 관리" },
  "/register": { title: "등록 대기열 등록" },
};

function getPageTitle() {
  return pageInfo[route.path]?.title || "등록 대기 관리";
}

watch(
  () => route.path,
  () => { document.title = `FSK ${getPageTitle()}`; },
  { immediate: true },
);
</script>

<template>
  <div class="app-container">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon" aria-hidden="true">🎫</span>
          <h1>FSK {{ getPageTitle() }}</h1>
        </a>
        <div v-if="isKiosk" class="device-badge" title="접수 전용 장비">📱 {{ device.name }}</div>
        <div v-else class="header-actions">
          <NavMenu :currentPath="'/registration' + route.path" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.device-badge { color: var(--text-secondary); font-size: 0.875rem; font-weight: 600; }
</style>
