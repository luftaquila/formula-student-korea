<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/browser/NavMenu.vue";
import { siteTitle } from "@shared/browser/site.js";
import Toaster from "fsk-coursekeeper/console/Toaster.vue";

const route = useRoute();
const isPublic = computed(() => route.meta.public === true);
</script>

<template>
  <div class="app-container app-fullheight">
    <Toaster />
    <header v-if="isPublic" class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">🏁</span>
          <h1>{{ siteTitle("경기 코스") }}</h1>
        </a>
        <div class="header-actions">
          <NavMenu currentPath="/course/public" />
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
  /* Override the shared .app-container `min-height: 100vh`. On mobile the app
     never scrolls (overflow: hidden), so the browser address bar stays pinned;
     a 100vh floor then exceeds the visible 100dvh and pushes the top content
     (the status chip bar) behind the address bar. Cap the floor at 100dvh. */
  min-height: 100dvh;
  overflow: hidden;
  position: relative;
}

.main-fill {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
