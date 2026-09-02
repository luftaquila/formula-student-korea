<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import NavTabs from "./components/NavTabs.vue";
import WirelessQualityAlert from "./components/WirelessQualityAlert.vue";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";
import { useEntryStore } from "./stores/entry";
import { useSSE } from "./composables/useSSE";
import { currentCompetitionYear } from "@shared/competition-year.mjs";

const entryStore = useEntryStore();
const { lastEntriesUpdate } = useSSE();
const route = useRoute();
const isWirelessRoute = computed(() => route.path.startsWith("/wireless"));
const isScoreboardFullscreen = ref(false);

function handleFullscreenChange() {
  isScoreboardFullscreen.value = document.body.classList.contains("scoreboard-fullscreen");
}

let observer = null;

watch(lastEntriesUpdate, (update) => {
  if (update?.year === currentCompetitionYear()) entryStore.loadEntries();
});

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
    <SonnerToaster />
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

    <WirelessQualityAlert v-if="isWirelessRoute" />

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
