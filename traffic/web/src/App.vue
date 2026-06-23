<script setup>
import { onMounted, onUnmounted, ref, computed } from "vue";
import { useRoute } from "vue-router";
import NavTabs from "./components/NavTabs.vue";
import NavMenu from "@shared/NavMenu.vue";
import { useEntryStore } from "./stores/entry";

const entryStore = useEntryStore();
const route = useRoute();
const isScoreboardFullscreen = ref(false);

// 계측 모드(무선/유선). 진입 기본은 무선(라우터 / → /wireless), 이 버튼으로 유선과 전환.
const isWireless = computed(() => route.path.startsWith("/wireless"));
const modeToggle = computed(() =>
  isWireless.value
    ? { to: "/record", label: "🔌 유선 계측" }
    : { to: "/wireless/record", label: "📡 무선 계측" },
);

function handleFullscreenChange() {
  isScoreboardFullscreen.value = document.body.classList.contains("scoreboard-fullscreen");
}

let observer = null;

onMounted(() => {
  entryStore.loadEntries();
  // Watch for scoreboard fullscreen state
  observer = new MutationObserver(handleFullscreenChange);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  handleFullscreenChange();
});

onUnmounted(() => {
  if (observer) observer.disconnect();
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
          <router-link :to="modeToggle.to" class="mode-toggle">{{ modeToggle.label }}</router-link>
          <NavMenu currentPath="/traffic" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.header-content {
  gap: 2rem;
}

.logo,
.header-actions {
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.mode-toggle {
  padding: 0.4rem 0.85rem;
  border-radius: 999px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 0.8125rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  transition: all 0.2s ease;
}

.mode-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

@media (max-width: 1024px) {
  .header-content {
    flex-wrap: wrap;
  }

  :deep(.nav-tabs) {
    order: 1;
    width: 100%;
  }
}

@media (max-width: 640px) {
  .header-content {
    text-align: initial;
  }
}
</style>
