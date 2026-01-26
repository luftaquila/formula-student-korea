<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import ThemeToggle from "./components/ThemeToggle.vue";
import NavTabs from "./components/NavTabs.vue";
import NavMenu from "@shared/NavMenu.vue";
import { useEntryStore } from "./stores/entry";

const route = useRoute();
const entryStore = useEntryStore();
const isScoreboardFullscreen = ref(false);

function handleFullscreenChange() {
  isScoreboardFullscreen.value = document.body.classList.contains("scoreboard-fullscreen");
}

onMounted(() => {
  entryStore.loadEntries();
  // Watch for scoreboard fullscreen state
  const observer = new MutationObserver(handleFullscreenChange);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  handleFullscreenChange();
});

onUnmounted(() => {
  document.body.classList.remove("scoreboard-fullscreen");
});
</script>

<template>
  <div class="app-container">
    <header class="header" v-show="!isScoreboardFullscreen">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">🚦</span>
          <h1>FSK 계측 시스템</h1>
        </a>
        <NavTabs />
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu currentPath="/traffic" />
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
  gap: 2rem;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-shrink: 0;
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
  flex-shrink: 0;
}

.main-content {
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem;
}

@media (max-width: 1024px) {
  .header-content {
    flex-wrap: wrap;
  }
}

@media (max-width: 640px) {
  .header {
    padding: 1rem;
  }

  .header-content {
    flex-direction: column;
    gap: 1rem;
  }

  .main-content {
    padding: 1rem;
  }
}
</style>
