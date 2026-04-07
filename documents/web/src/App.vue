<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/NavMenu.vue";

const route = useRoute();
const title = computed(() => route.path.startsWith("/admin") ? "FSK 서류 제출 관리" : "FSK 서류 제출");

watch(title, (v) => { document.title = v; }, { immediate: true });
</script>

<template>
  <div class="app-container">
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
