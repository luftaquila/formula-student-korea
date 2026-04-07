<script setup>
import { useRoute } from "vue-router";
import NavMenu from "@shared/NavMenu.vue";

const route = useRoute();
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📊</span>
          <h1>FSK 성적 관리</h1>
        </a>
        <div class="header-actions">
          <NavMenu :currentPath="'/score' + route.path" />
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
  --layout-max-width: none;
}
</style>

