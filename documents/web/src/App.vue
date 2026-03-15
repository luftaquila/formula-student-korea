<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import ThemeToggle from "@shared/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";

const route = useRoute();
const title = computed(() => route.path.startsWith("/admin") ? "FSK 서류 제출 관리" : "FSK 서류 제출");
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📄</span>
          <h1>{{ title }}</h1>
        </a>
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu :currentPath="'/documents' + route.path" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>
