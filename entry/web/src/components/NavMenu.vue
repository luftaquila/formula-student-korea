<script setup>
import { ref } from 'vue'

const isOpen = ref(false)

const services = [
  { name: '홈', href: '/', icon: 'home' },
  { name: '등록 대기열', href: '/enroll', icon: 'enroll' },
  { name: '검차 대기열', href: '/queue', icon: 'queue' },
  { name: '에너지미터', href: '/energymeter', icon: 'energy' },
  { name: '규정집', href: '/rules', icon: 'rules' },
]

const officials = [
  { name: '등록 관리', href: '/enroll/admin', icon: 'enroll-admin' },
  { name: '검차 관리', href: '/queue/admin', icon: 'queue-admin' },
  { name: '계측 제어', href: '/traffic', icon: 'traffic' },
  { name: '경기 기록', href: '/record', icon: 'record' },
  { name: '엔트리 관리', href: '/entry', icon: 'entry', active: true },
]

function toggle() {
  isOpen.value = !isOpen.value
}

function close() {
  isOpen.value = false
}
</script>

<template>
  <div class="nav-menu">
    <button class="menu-btn" @click="toggle" title="메뉴">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>

    <Teleport to="body">
      <Transition name="fade">
        <div v-if="isOpen" class="overlay" @click="close"></div>
      </Transition>
      
      <Transition name="slide">
        <div v-if="isOpen" class="drawer">
          <div class="drawer-header">
            <span class="drawer-title">FSK Services</span>
            <button class="close-btn" @click="close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          
          <nav class="drawer-nav">
            <div class="nav-section">
              <span class="nav-section-title">Services</span>
              <a 
                v-for="item in services" 
                :key="item.href"
                :href="item.href"
                class="nav-item"
                :class="{ active: item.active }"
              >
                <span class="nav-icon">{{ getIcon(item.icon) }}</span>
                <span>{{ item.name }}</span>
              </a>
            </div>
            
            <div class="nav-section">
              <span class="nav-section-title">Officials</span>
              <a 
                v-for="item in officials" 
                :key="item.href"
                :href="item.href"
                class="nav-item"
                :class="{ active: item.active }"
              >
                <span class="nav-icon">{{ getIcon(item.icon) }}</span>
                <span>{{ item.name }}</span>
              </a>
            </div>
          </nav>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script>
function getIcon(type) {
  const icons = {
    'home': '🏠',
    'enroll': '📋',
    'queue': '🔧',
    'energy': '⚡',
    'rules': '📖',
    'enroll-admin': '📝',
    'queue-admin': '🛠️',
    'traffic': '🚦',
    'record': '📊',
    'entry': '🏁',
  }
  return icons[type] || '📌'
}
</script>

<style scoped>
.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.menu-btn:hover {
  background: rgba(255, 255, 255, 0.25);
  transform: scale(1.05);
}

.menu-btn svg {
  width: 20px;
  height: 20px;
  color: white;
}

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  z-index: 1000;
}

.drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: 300px;
  max-width: 85vw;
  height: 100vh;
  background: var(--bg-card);
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.3);
  z-index: 1001;
  display: flex;
  flex-direction: column;
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.drawer-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text-primary);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.15s ease;
}

.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.close-btn svg {
  width: 18px;
  height: 18px;
}

.drawer-nav {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 0;
}

.nav-section {
  padding: 0.5rem 0;
}

.nav-section-title {
  display: block;
  padding: 0.5rem 1.5rem;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1.5rem;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 0.9375rem;
  transition: all 0.15s ease;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: linear-gradient(90deg, rgba(59, 130, 246, 0.15) 0%, transparent 100%);
  color: var(--accent-primary);
  border-left: 3px solid var(--accent-primary);
}

.nav-icon {
  font-size: 1.125rem;
}

/* Transitions */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-enter-active,
.slide-leave-active {
  transition: transform 0.25s ease;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}
</style>

