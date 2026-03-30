<script setup>
import ThemeToggle from "@shared/ThemeToggle.vue";
import NavMenu from "@shared/NavMenu.vue";
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📅</span>
          <h1>FSK 대회 일정</h1>
        </a>
        <div class="header-actions">
          <ThemeToggle />
          <NavMenu currentPath="/calendar" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>
