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
  min-height: 100vh;
  background: var(--bg-primary);
}

.header {
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  padding: 1rem 2rem;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.header-content {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-content.wide {
  max-width: 1400px;
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
  max-width: 960px;
  margin: 0 auto;
  padding: 2rem;
}

.main-content.wide {
  max-width: 1400px;
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
