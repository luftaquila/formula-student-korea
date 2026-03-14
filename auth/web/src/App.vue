<script setup>
import ThemeToggle from "@shared/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">👤</span>
          <h1>FSK 계정 관리</h1>
        </a>
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu currentPath="/auth" />
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
  --layout-max-width: 1100px;
}
</style>
