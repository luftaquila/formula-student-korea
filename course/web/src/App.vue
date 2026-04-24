<script setup>
import NavMenu from "@shared/NavMenu.vue";
import { useRoute, RouterLink } from "vue-router";

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
        <nav class="subnav">
          <RouterLink to="/" exact-active-class="subnav-active">지도</RouterLink>
          <RouterLink to="/missions" active-class="subnav-active">미션 이력</RouterLink>
        </nav>
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

.subnav {
  display: flex;
  gap: 0.25rem;
  align-items: center;
  margin-left: 1rem;
}
.subnav :deep(a) {
  padding: 0.35rem 0.7rem;
  border-radius: 6px;
  font-size: 0.9rem;
  color: var(--text-secondary);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.subnav :deep(a:hover) { background: var(--bg-secondary); }
.subnav :deep(.subnav-active) {
  background: var(--accent-primary);
  color: #fff;
}
</style>
