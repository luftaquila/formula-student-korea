<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";

const route = useRoute();
const isLogs = computed(() => route.path === "/logs");
const isApply = computed(() => route.path === "/apply");
const isApplications = computed(() => route.path === "/applications");
// 계정 관리(사용자 표)는 성적 관리처럼 화면 전체 너비를 사용한다.
const isManage = computed(() => route.path === "/");
const pageIcon = computed(() =>
  isApply.value ? "📝" : isApplications.value ? "📋" : isLogs.value ? "📜" : "🔑");
const pageTitle = computed(() =>
  isApply.value ? "FSK 계정 신청"
  : isApplications.value ? "FSK 계정 신청 관리"
  : isLogs.value ? "FSK 시스템 로그"
  : "FSK 계정 관리");
// 계정 신청 관리(/applications)는 별도 메뉴 없이 계정 관리(/auth) 하위로 취급 → 네비에서 계정 관리 활성
const currentPath = computed(() => isLogs.value ? "/auth/logs" : "/auth");

watch(pageTitle, (v) => { document.title = v; }, { immediate: true });
</script>

<template>
  <div class="app-container" :class="{ 'full-width': isManage }">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">{{ pageIcon }}</span>
          <h1>{{ pageTitle }}</h1>
        </a>
        <div class="header-actions">
          <NavMenu v-if="!isApply" :currentPath="currentPath" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<style>
@import "@shared/styles/base.css";
@import "@shared/styles/layout.css";
</style>

<style scoped>
.app-container {
  --layout-max-width: 1200px;
}
/* 계정 관리 페이지는 성적 관리처럼 전체 너비 (score App.vue와 동일하게 none). */
.app-container.full-width {
  --layout-max-width: none;
}
</style>
