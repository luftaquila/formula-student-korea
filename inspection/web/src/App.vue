<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";

const route = useRoute();

const pageInfo = {
  "/": { title: "인스펙션 시트" },
  "/template": { title: "인스펙션 시트 템플릿" },
  "/template/print": { title: "인스펙션 시트 인쇄" },
};

const isPrintPage = computed(() => route.path === "/template/print");

// 팀 목록은 카테고리 수만큼 열이 늘어나므로 공용 기본 너비(1400px)를 그대로 쓴다.
const isWidePage = computed(() => route.path === "/");

function getPageTitle() {
  if (route.path.match(/^\/\d+\/\d+$/)) return "인스펙션 시트";
  return pageInfo[route.path]?.title || "인스펙션 시트";
}

watch(() => route.path, () => { document.title = `FSK ${getPageTitle()}`; }, { immediate: true });
</script>

<template>
  <div v-if="isPrintPage">
    <router-view />
  </div>
  <div v-else class="app-container" :class="{ 'app-wide': isWidePage }">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📋</span>
          <h1>FSK {{ getPageTitle() }}</h1>
        </a>
        <div class="header-actions">
          <NavMenu :currentPath="'/inspection' + route.path" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-container {
  --layout-max-width: 1100px;
}

.app-container.app-wide {
  --layout-max-width: 1400px;
}
</style>
