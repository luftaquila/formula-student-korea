<script setup>
import { useRoute } from "vue-router";
import ThemeToggle from "./components/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";

const route = useRoute();

const pageInfo = {
  "/": { title: "검차 대기열", icon: "magnifying-glass" },
  "/admin": { title: "검차 대기열 관리", icon: "list-check" },
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

<style scoped>
.app-container {
  min-height: 100vh;
  background: var(--bg-primary);
}

.header {
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  padding: 1rem 2rem;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.header-content {
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
}

.logo-icon {
  font-size: 2rem;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
}

.logo h1 {
  color: white;
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
}

.header-actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.main-content {
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem;
}

@media (max-width: 640px) {
  .header {
    padding: 1rem;
  }

  .header-content {
    flex-direction: column;
    gap: 1rem;
    text-align: center;
  }

  .main-content {
    padding: 1rem;
  }
}
</style>
