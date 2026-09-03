<script setup>
import { computed, ref, watch } from "vue";
import ThemeToggle from "./ThemeToggle.vue";
import {
  RESOURCES_DISCLOSURE_STORAGE_KEY,
  readDisclosureState,
  writeDisclosureState,
} from "./persistent-disclosure.js";
import { services, resources, operations, administration, getIcon, isSvgIcon, forumSvg } from "./nav-config.js";
import { user, isStudent, isOfficial, isAdmin, hasPermission } from "./officialsStore.js";

function canShow(item) {
  if (item.studentOnly) return isStudent.value;
  if (item.adminOnly) return isAdmin.value;
  return !item.permission || hasPermission(item.permission);
}
const visibleOperations = computed(() => operations.filter(canShow));
const visibleAdministration = computed(() => administration.filter(canShow));

// Show the Google profile picture when the session carries one; fall back to the
// emoji if the image fails to load. Reset the failure when the account changes.
const avatarFailed = ref(false);
watch(user, () => { avatarFailed.value = false; });

const props = defineProps({
  currentPath: {
    type: String,
    default: "/",
  },
});

const isOpen = ref(false);
const opsContacts = ref(null);
const browserStorage = (() => {
  try { return window.localStorage; }
  catch { return null; }
})();
const resourcesOpen = ref(readDisclosureState(browserStorage, RESOURCES_DISCLOSURE_STORAGE_KEY));

function persistResourcesState(event) {
  resourcesOpen.value = event.currentTarget.open;
  writeDisclosureState(browserStorage, RESOURCES_DISCLOSURE_STORAGE_KEY, resourcesOpen.value);
}

async function fetchOpsContacts() {
  try {
    const res = await fetch("/auth/api/ops-contacts");
    if (res.ok) {
      const data = await res.json();
      opsContacts.value = data.length ? data : null;
    }
  } catch {}
}

watch(isOpen, (open) => {
  if (open && isOfficial.value) fetchOpsContacts();
});

function isActive(href) {
  // Landing page
  if (props.currentPath === "/" && href === "/") {
    return true;
  }

  // Queue service
  if (props.currentPath.startsWith("/queue")) {
    if (href === "/queue") {
      return props.currentPath === "/queue" || props.currentPath === "/queue/";
    }
    if (href === "/queue/admin") {
      return (
        props.currentPath === "/queue/admin" ||
        props.currentPath === "/queue/register" ||
        props.currentPath === "/queue/priority"
      );
    }
  }

  // Registration queue
  if (props.currentPath.startsWith("/registration")) {
    if (href === "/registration") {
      return props.currentPath === "/registration" || props.currentPath === "/registration/";
    }
    if (href === "/registration/manage") {
      return props.currentPath === "/registration/manage" || props.currentPath === "/registration/register";
    }
  }

  // Other services - exact match or prefix match (but not when a more specific item exists)
  if (href !== "/" && props.currentPath === href) {
    return true;
  }
  if (href !== "/" && props.currentPath.startsWith(href + "/")) {
    // Only match prefix if no other item is a more specific match
    const allItems = [...services, ...resources, ...operations, ...administration];
    const hasMoreSpecific = allItems.some(item => item.href !== href && item.href.startsWith(href) && props.currentPath.startsWith(item.href));
    if (!hasMoreSpecific) return true;
  }

  return false;
}

function toggle() {
  isOpen.value = !isOpen.value;
}

function close() {
  isOpen.value = false;
}

async function logout() {
  try {
    await fetch("/auth/api/logout", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
}
</script>

<template>
  <div class="nav-menu">
    <button class="menu-btn" @click="toggle" title="메뉴">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>

    <Teleport to="body">
      <Transition name="fade">
        <div v-if="isOpen" class="overlay" @click="close"></div>
      </Transition>

      <Transition name="slide">
        <div v-if="isOpen" class="drawer">
          <div class="drawer-header">
            <span class="drawer-title"><span class="drawer-title-icon">🏁</span>FSK Hub</span>
            <a href="https://github.com/luftaquila" target="_blank" rel="noopener noreferrer" class="top-icon-btn" title="GitHub">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
            </a>
            <ThemeToggle />
            <button class="close-btn" @click="close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <nav class="drawer-nav">
            <div class="nav-section nav-section-account">
              <div v-if="user" class="nav-item user-info">
                <img
                  v-if="user.picture && !avatarFailed"
                  :src="user.picture"
                  class="nav-avatar"
                  alt=""
                  referrerpolicy="no-referrer"
                  @error="avatarFailed = true"
                />
                <span v-else class="nav-icon">👤</span>
                <span>{{ user.name }}</span>
                <button class="logout-btn" @click="logout">로그아웃</button>
              </div>
              <a v-else :href="'/auth/api/login?redirect=' + encodeURIComponent(currentPath)" class="nav-item google-login-btn">
                <svg class="nav-icon google-logo" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                <span>Google 계정으로 로그인</span>
              </a>
            </div>

            <div v-if="isOfficial && opsContacts" class="nav-section ops-contacts-section">
              <span class="nav-section-title">Contacts</span>
              <div v-for="c in opsContacts" :key="c.id" class="ops-contact">
                <span class="ops-contact-identity">
                  <span class="ops-contact-name">{{ c.realname || c.name || c.email }}</span>
                  <span v-if="c.description" class="ops-contact-description">{{ c.description }}</span>
                </span>
                <a v-if="c.phone" :href="'tel:' + c.phone" class="ops-contact-phone">{{ c.phone }}</a>
              </div>
            </div>

            <div class="nav-section">
              <span class="nav-section-title">Services</span>
              <template v-for="item in services" :key="item.href">
                <a
                  v-if="canShow(item)"
                  :href="item.href"
                  :target="item.external ? '_blank' : undefined"
                  :rel="item.external ? 'noopener noreferrer' : undefined"
                  class="nav-item"
                  :class="{ active: isActive(item.href) }"
                >
                  <span v-if="isSvgIcon(item.icon)" class="nav-icon nav-icon-svg" v-html="forumSvg"></span>
                  <span v-else class="nav-icon">{{ getIcon(item.icon) }}</span>
                  <span>{{ item.name }}</span>
                  <svg
                    v-if="item.external"
                    class="external-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              </template>
            </div>

            <details :open="resourcesOpen" class="nav-section resources-section" @toggle="persistResourcesState">
              <summary class="nav-section-title collapsible-title">
                Resources
                <svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </summary>
              <template v-for="item in resources" :key="item.href">
                <a
                  :href="item.href"
                  :target="item.external ? '_blank' : undefined"
                  :rel="item.external ? 'noopener noreferrer' : undefined"
                  class="nav-item"
                  :class="{ active: isActive(item.href) }"
                >
                  <span v-if="isSvgIcon(item.icon)" class="nav-icon nav-icon-svg" v-html="forumSvg"></span>
                  <span v-else class="nav-icon">{{ getIcon(item.icon) }}</span>
                  <span>{{ item.name }}</span>
                  <svg
                    v-if="item.external"
                    class="external-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              </template>
            </details>

            <div v-if="visibleOperations.length" class="nav-section">
              <span class="nav-section-title">Operations</span>
              <a
                v-for="item in visibleOperations"
                :key="item.href"
                :href="item.href"
                :target="item.external ? '_blank' : undefined"
                :rel="item.external ? 'noopener noreferrer' : undefined"
                class="nav-item"
                :class="{ active: isActive(item.href) }"
              >
                <span class="nav-icon">{{ getIcon(item.icon) }}</span>
                <span>{{ item.name }}</span>
                <svg
                  v-if="item.external"
                  class="external-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>

            <div v-if="visibleAdministration.length" class="nav-section">
              <span class="nav-section-title">Admin</span>
              <a
                v-for="item in visibleAdministration"
                :key="item.href"
                :href="item.href"
                class="nav-item"
                :class="{ active: isActive(item.href) }"
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

<style scoped>
.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.menu-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.menu-btn svg {
  width: 20px;
  height: 20px;
  color: #b0b4be;
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
  height: 100dvh;
  background: var(--bg-card);
  border-left: 1px solid var(--border-color);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.2);
  z-index: 1001;
  display: flex;
  flex-direction: column;
}

.drawer-header {
  display: flex;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-right: auto;
}

.drawer-title-icon {
  font-size: 1.25rem;
}

.drawer-header :deep(.theme-toggle) {
  width: 44px;
  height: 44px;
  background: transparent;
  border: none;
  border-radius: 6px;
}

.drawer-header :deep(.theme-toggle:hover) {
  background: var(--bg-hover);
}

.drawer-header :deep(.icon) {
  width: 20px;
  height: 20px;
  color: var(--text-secondary);
}

.drawer-header :deep(.theme-toggle:hover .icon) {
  color: var(--text-primary);
}

.top-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.top-icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.top-icon-btn svg {
  width: 20px;
  height: 20px;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: background-color 0.15s ease, color 0.15s ease;
}

.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.close-btn svg {
  width: 20px;
  height: 20px;
}

.drawer-nav {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0 0;
  display: flex;
  flex-direction: column;
}

.ops-contacts-section .ops-contact {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.375rem 1.5rem;
}

.ops-contact-identity {
  display: inline-flex;
  align-items: baseline;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 0.75rem;
  min-width: 0;
  max-width: 100%;
}

.ops-contact-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  min-width: 0;
  overflow-wrap: anywhere;
}

.ops-contact-description {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-secondary);
  min-width: 0;
  overflow-wrap: anywhere;
}

.ops-contact-phone {
  font-size: 0.8125rem;
  color: var(--accent-primary);
  text-decoration: none;
}

.ops-contact-phone:hover {
  text-decoration: underline;
}

.nav-section {
  padding: 0.5rem 0;
}

.resources-section > summary {
  list-style: none;
  cursor: pointer;
}

.resources-section > summary::-webkit-details-marker {
  display: none;
}

.collapsible-title {
  display: flex;
  align-items: center;
}

.collapse-icon {
  width: 1rem;
  height: 1rem;
  margin-left: auto;
  transition: transform 0.15s ease;
}

.resources-section:not([open]) .collapse-icon {
  transform: rotate(-90deg);
}

.nav-section-account {
  border-bottom: 1px solid var(--border-color);
  padding: 0;
}

.nav-section-account .nav-item {
  padding-top: 1rem;
  padding-bottom: 1rem;
}

.nav-avatar {
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.nav-section-title {
  display: block;
  padding: 0.5rem 1.5rem;
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1.5rem;
  color: var(--text-primary);
  text-decoration: none;
  font-size: 0.9375rem;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-primary);
  font-weight: 600;
}

.nav-icon {
  font-size: 1.125rem;
  width: 1.5rem;
  text-align: center;
  flex-shrink: 0;
}

.nav-icon-svg {
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav-icon-svg :deep(svg) {
  width: 1.125rem;
  height: 1.125rem;
}

.external-icon {
  width: 14px;
  height: 14px;
  margin-left: auto;
  opacity: 0.5;
}

.user-info {
  cursor: default;
}

.user-info:hover {
  background: transparent;
}

.logout-btn {
  margin-left: auto;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.logout-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.google-login-btn {
  font-weight: 500;
}

.google-logo {
  width: 1.125rem;
  height: 1.125rem;
  flex-shrink: 0;
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
