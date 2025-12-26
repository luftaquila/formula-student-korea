<script setup>
import { useRoute } from 'vue-router'

const route = useRoute()

const navItems = [
  { id: 'accel', icon: 'fa-flip-horizontal fa-car-side', tooltip: '가속 측정', path: '/accel' },
  { id: 'gymkhana', icon: 'fa-flag-checkered', tooltip: '짐카나', path: '/gymkhana' },
  { id: 'skidpad', icon: 'fa-stopwatch', tooltip: '스키드패드', path: '/skidpad' },
  { id: 'record', icon: 'fa-file-waveform', tooltip: '경기 기록', path: '/record' },
  { id: 'entry', icon: 'fa-list-ol', tooltip: '엔트리 관리', path: '/entry' }
]
</script>

<template>
  <nav class="sidebar-navigation">
    <ul>
      <li
        v-for="item in navItems"
        :key="item.id"
        :class="{ active: route.path === item.path }"
      >
        <router-link :to="item.path">
          <i :class="['fa', 'fw', item.icon]"></i>
          <span class="tooltip">{{ item.tooltip }}</span>
        </router-link>
      </li>
      <li class="bottom-item" @click="() => window.open('https://github.com/luftaquila/fsk-traffic', '_blank')">
        <i class="fab fw fa-github"></i>
        <span class="tooltip">luftaquila/fsk-traffic</span>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.sidebar-navigation ul li a {
  display: block;
  color: inherit;
  text-decoration: none;
}

.bottom-item {
  position: fixed;
  bottom: 0;
  cursor: pointer;
}
</style>
