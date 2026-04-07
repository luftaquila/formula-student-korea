<script setup>
import NavMenu from "@shared/NavMenu.vue";
import { useRoute } from "vue-router";

const route = useRoute();
</script>

<template>
  <div class="app-container app-fullheight">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📍</span>
          <h1>FSK 코스 관리</h1>
        </a>
        <div class="header-actions">
          <NavMenu :currentPath="'/course' + route.path" />
        </div>
      </div>
    </header>

    <main class="main-fill">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-fullheight {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
}

.main-fill {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
