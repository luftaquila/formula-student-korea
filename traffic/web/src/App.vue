<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import NavTabs from "./components/NavTabs.vue";
import NavMenu from "@shared/NavMenu.vue";
import { useEntryStore } from "./stores/entry";

const entryStore = useEntryStore();
const isScoreboardFullscreen = ref(false);

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
