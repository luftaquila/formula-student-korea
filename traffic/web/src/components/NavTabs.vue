<script setup>
import { useRoute, useRouter } from 'vue-router'
import { useSerialStore } from '../stores/serial'

const route = useRoute()
const router = useRouter()
const serial = useSerialStore()

const navItems = [
  { id: 'accel', label: '🏎️ 가속', path: '/accel' },
  { id: 'gymkhana', label: '🏁 짐카나', path: '/gymkhana' },
  { id: 'skidpad', label: '⏱️ 스키드패드', path: '/skidpad' },
  { id: 'record', label: '📋 기록', path: '/record' }
]

function handleNavClick(e, path) {
  e.preventDefault()
  if (serial.green.active) return
  router.push(path)
}
</script>

<template>
  <nav class="nav-tabs">
    <a 
      v-for="item in navItems" 
      :key="item.id"
      :href="item.path"
      class="nav-tab"
      :class="{ active: route.path === item.path, disabled: serial.green.active }"
      @click="handleNavClick($event, item.path)"
    >
      {{ item.label }}
    </a>
  </nav>
</template>

<style scoped>
.nav-tabs {
  display: flex;
  gap: 0.25rem;
  background: rgba(255, 255, 255, 0.1);
  padding: 0.25rem;
  border-radius: 12px;
}

.nav-tab {
  padding: 0.5rem 1rem;
  color: rgba(255, 255, 255, 0.8);
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 8px;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.nav-tab:hover {
  color: white;
  background: rgba(255, 255, 255, 0.1);
}

.nav-tab.active {
  color: var(--accent-primary);
  background: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.nav-tab.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.nav-tab.disabled:not(.active):hover {
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
}

@media (max-width: 768px) {
  .nav-tabs {
    flex-wrap: wrap;
    justify-content: center;
  }
  
  .nav-tab {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
  }
}
</style>

