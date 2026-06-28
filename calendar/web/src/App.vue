<script setup>
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";
</script>

<template>
  <div class="app-container">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">📅</span>
          <h1>FSK 대회 일정</h1>
        </a>
        <div class="header-actions">
          <NavMenu currentPath="/calendar" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>
