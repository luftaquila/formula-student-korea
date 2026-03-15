<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import ThemeToggle from "@shared/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";

const route = useRoute();

const pageInfo = {
  "/": { title: "인스펙션 시트" },
  "/template": { title: "인스펙션 시트 템플릿" },
  "/template/print": { title: "인스펙션 시트 인쇄" },
};

const isPrintPage = computed(() => route.path === "/template/print");

function getPageTitle() {
  if (route.path.match(/^\/\d+\/\d+$/)) return "인스펙션 시트";
  return pageInfo[route.path]?.title || "인스펙션 시트";
}
</script>

<template>
  <div v-if="isPrintPage">
    <router-view />
  </div>
  <div v-else class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📋</span>
          <h1>FSK {{ getPageTitle() }}</h1>
        </a>
        <div class="header-actions">
          <ThemeToggle />
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
  --layout-max-width: 960px;
}
</style>
