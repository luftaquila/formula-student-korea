<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useSerialStore } from "../stores/serial";
import { useWirelessStore } from "../stores/wireless";
import { useSSE } from "../composables/useSSE";

const route = useRoute();
const serial = useSerialStore();
const wireless = useWirelessStore();
const { eventModes } = useSSE();

const wiredNavItems = [
  { id: "record", label: "📋 기록", path: "/record" },
  { id: "accel", label: "🏎️ 가속", path: "/accel", eventType: "가속" },
  { id: "skidpad", label: "⏱️ 스키드패드", path: "/skidpad", eventType: "스키드패드" },
  { id: "autocross", label: "🚧 오토크로스", path: "/autocross", eventType: "오토크로스" },
  { id: "endurance", label: "🏁 내구", path: "/endurance", eventType: "내구" },
  { id: "scoreboard", label: "📺 전광판", path: "/scoreboard" },
];

const wirelessNavItems = [
  { id: "wl-record", label: "📋 기록", path: "/wireless/record" },
  { id: "wl-accel", label: "🏎️ 가속", path: "/wireless/accel", eventType: "가속" },
  { id: "wl-skidpad", label: "⏱️ 스키드패드", path: "/wireless/skidpad", eventType: "스키드패드" },
  { id: "wl-autocross", label: "🚧 오토크로스", path: "/wireless/autocross", eventType: "오토크로스" },
  { id: "wl-endurance", label: "🏁 내구", path: "/wireless/endurance", eventType: "내구" },
  { id: "wl-scoreboard", label: "📺 전광판", path: "/wireless/scoreboard" },
  { id: "wl-settings", label: "⚙️ 무선 설정", path: "/wireless/settings" },
];

const isWireless = computed(() => route.path.startsWith("/wireless"));

// 무선 모드: 브리지에서 점유 중인 경기의 신호등이 green이면 탭 전환 잠금
const locked = computed(() =>
  isWireless.value
    ? wireless.bridgeIsSelf && wireless.ownerKey && wireless.lightColorFor(wireless.ownerKey) === "green"
    : serial.green.active,
);

const navItems = computed(() => {
  const base = isWireless.value ? wirelessNavItems : wiredNavItems;
  return base.filter((item) => !item.eventType || eventModes.value[item.eventType] !== false);
});
</script>

<template>
  <nav class="nav-tabs">
    <router-link
      v-for="item in navItems"
      :key="item.id"
      :to="locked ? route.path : item.path"
      class="nav-tab"
      :class="{ active: route.path === item.path, disabled: locked }"
    >
      {{ item.label }}
    </router-link>
  </nav>
</template>

<style scoped>
.nav-tabs {
  display: flex;
  gap: 0.25rem;
  background: transparent;
  padding: 0.25rem;
  border-radius: 12px;
}

.nav-tab {
  padding: 0.5rem 1rem;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 8px;
  border: none;
  background: none;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.nav-tab:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.nav-tab.active {
  color: var(--text-primary);
  font-weight: 700;
  background: var(--bg-tab-active, var(--bg-card));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.1);
}

.nav-tab.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.nav-tab.disabled:not(.active):hover {
  background: transparent;
  color: var(--text-secondary);
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
