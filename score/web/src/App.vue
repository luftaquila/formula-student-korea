<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";

const route = useRoute();
const isPublicPage = computed(() => route.name === "public-score");

watch(
  () => route.fullPath,
  () => { document.title = isPublicPage.value ? `FSK ${route.params.year}년 성적 공개` : "FSK 성적 관리"; },
  { immediate: true },
);
</script>

<template>
  <div class="app-container">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📊</span>
          <h1>{{ isPublicPage ? "FSK 성적 공개" : "FSK 성적 관리" }}</h1>
        </a>
        <div v-if="!isPublicPage" class="header-actions">
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
