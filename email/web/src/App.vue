<script setup>
import NavMenu from "@shared/NavMenu.vue";
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">✉️</span>
          <h1>FSK 이메일/SMS</h1>
        </a>
        <div class="header-actions">
          <NavMenu currentPath="/email" />
        </div>
      </div>
    </header>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>
