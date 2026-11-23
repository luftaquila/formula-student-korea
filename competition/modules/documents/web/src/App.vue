<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/browser/NavMenu.vue";
import { siteTitle } from "@shared/browser/site.js";
import SonnerToaster from "@shared/browser/SonnerToaster.vue";

const route = useRoute();
const title = computed(() => siteTitle(route.path.startsWith("/admin") ? "서류 제출 관리" : "서류 제출"));

watch(title, (v) => { document.title = v; }, { immediate: true });
</script>

<template>
  <div class="app-container">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📄</span>
          <h1>{{ title }}</h1>
        </a>
        <div class="header-actions">
          <NavMenu :currentPath="'/documents' + route.path" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>
