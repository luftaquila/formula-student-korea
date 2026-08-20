<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";
import { isChief, showOfficials } from "@shared/officialsStore.js";

const route = useRoute();
const tabs = computed(() => {
  const items = [{ name: "대기 현황", path: "/" }];
  if (showOfficials.value) items.push({ name: "대기 관리", path: "/manage" });
  if (isChief.value) items.push({ name: "대기 등록", path: "/register" });
  return items;
});

watch(
  () => route.meta.title,
  (title) => { document.title = `FSK ${title || "학회 등록 대기열"}`; },
  { immediate: true },
);
</script>

<template>
  <div class="app-container registration-app">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="registration-mark" aria-hidden="true">FSK</span>
          <h1>학회 등록 대기열</h1>
        </a>
        <div class="header-actions">
          <NavMenu :currentPath="'/registration' + route.path" />
        </div>
      </div>
    </header>

    <nav v-if="tabs.length > 1" class="registration-tabs" aria-label="등록 대기열 메뉴">
      <router-link
        v-for="tab in tabs"
        :key="tab.path"
        :to="tab.path"
        :class="{ active: route.path === tab.path }"
      >
        {{ tab.name }}
      </router-link>
    </nav>

    <main class="main-content registration-main">
      <router-view />
    </main>
  </div>
</template>
