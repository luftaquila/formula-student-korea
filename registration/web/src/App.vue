<script setup>
import { watch } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";

const route = useRoute();

const pageInfo = {
  "/": { title: "등록 대기열" },
  "/manage": { title: "등록 대기 관리" },
  "/register": { title: "등록 대기열 등록" },
};

function getPageTitle() {
  return pageInfo[route.path]?.title || "등록 대기열";
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
        <div class="header-actions">
          <NavMenu :currentPath="'/registration' + route.path" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>
