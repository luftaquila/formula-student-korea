<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import ThemeToggle from "@shared/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";

const route = useRoute();
const isLogs = computed(() => route.path === "/logs");
const pageIcon = computed(() => isLogs.value ? "📜" : "🔑");
const pageTitle = computed(() => isLogs.value ? "FSK 시스템 로그" : "FSK 계정 관리");
const currentPath = computed(() => isLogs.value ? "/auth/logs" : "/auth");

watch(pageTitle, (v) => { document.title = v; }, { immediate: true });
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">{{ pageIcon }}</span>
          <h1>{{ pageTitle }}</h1>
        </a>
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu :currentPath="currentPath" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<style>
@import "@shared/styles/base.css";
@import "@shared/styles/layout.css";
</style>

<style scoped>
.app-container {
  --layout-max-width: 1100px;
}
</style>
