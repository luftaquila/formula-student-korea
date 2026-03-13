<script setup>
import { useRoute } from "vue-router";
import ThemeToggle from "@shared/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";

const route = useRoute();

const pageInfo = {
  "/": { title: "검차 대기열", icon: "magnifying-glass" },
  "/admin": { title: "검차 대기 관리", icon: "list-check" },
  "/register": { title: "검차 대기열 등록", icon: "plus" },
  "/priority": { title: "검차 우선순위 관리", icon: "star" },
  "/stats": { title: "검차 통계", icon: "chart-bar" },
};

function getPageTitle() {
  return pageInfo[route.path]?.title || "검차 대기열";
}
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">🔧</span>
          <h1>FSK {{ getPageTitle() }}</h1>
        </a>
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu :currentPath="'/queue' + route.path" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

