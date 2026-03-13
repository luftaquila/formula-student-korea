<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import ThemeToggle from "@shared/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";

const route = useRoute();

const pageInfo = {
  "/": { title: "인스펙션 시트", icon: "clipboard" },
  "/template": { title: "인스펙션 시트 템플릿", icon: "clipboard" },
  "/template/print": { title: "인스펙션 시트 인쇄", icon: "clipboard" },
};

const isPrintPage = computed(() => route.path === "/template/print");
const isWide = computed(() => route.path === "/");

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
      <div :class="['header-content', { wide: isWide }]">
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

    <main :class="['main-content', { wide: isWide }]">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-container {
  --layout-max-width: 960px;
}

.header-content.wide,
.main-content.wide {
  max-width: 1400px;
}
</style>
