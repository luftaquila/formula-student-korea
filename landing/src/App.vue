<template>
  <div class="app-container">
    <SonnerToaster />
    <header class="header">
      <div class="header-content">
        <a href="/" class="logo">
          <span class="logo-icon">🏁</span>
          <h1>Formula Student Korea</h1>
        </a>
        <div class="header-actions">
          <NavMenu currentPath="/" />
        </div>
      </div>
    </header>
    <main class="main">
      <section class="section">
        <h2 class="section-title">Services</h2>
        <div class="services">
          <ServiceCard v-for="item in serviceItems" :key="item.href" v-bind="cardProps(item)" />
        </div>
      </section>

      <details :open="resourcesOpen" class="section resources-section" @toggle="persistResourcesState">
        <summary class="section-title collapsible-title">
          Resources
          <svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>
        <div class="services">
          <ServiceCard v-for="item in resources" :key="item.href" v-bind="cardProps(item)" />
        </div>
      </details>

      <section v-if="operationItems.length" class="section">
        <h2 class="section-title">Operations</h2>
        <div class="services">
          <ServiceCard v-for="item in operationItems" :key="item.href" v-bind="cardProps(item)" />
        </div>
      </section>

      <section v-if="adminItems.length" class="section">
        <h2 class="section-title">Admin</h2>
        <div class="services">
          <ServiceCard v-for="item in adminItems" :key="item.href" v-bind="cardProps(item)" />
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import ServiceCard from "./components/ServiceCard.vue";
import NavMenu from "@shared/NavMenu.vue";
import SonnerToaster from "@shared/SonnerToaster.vue";
import { useNotification } from "@shared/useNotification.js";
import {
  RESOURCES_DISCLOSURE_STORAGE_KEY,
  readDisclosureState,
  writeDisclosureState,
} from "@shared/persistent-disclosure.js";
import { user, isStudent, isAdmin, hasPermission, refreshUser } from "@shared/officialsStore.js";
import { services, resources, operations, administration, getIcon, isSvgIcon, forumSvg } from "@shared/nav-config.js";

// 메뉴 데이터의 단일 소스는 nav-config.js — NavMenu와 landing 카드가 같은 목록을 쓴다.
// "홈"은 landing 자신이므로 카드에서 제외하고, 학생 전용 항목은 exact role로 제한한다.
const serviceItems = computed(() =>
  services.filter((item) => item.href !== "/" && (!item.studentOnly || isStudent.value)),
);
function canOpen(item) {
  return item.adminOnly ? isAdmin.value : hasPermission(item.permission);
}
const operationItems = computed(() => operations.filter(canOpen));
const adminItems = computed(() => administration.filter(canOpen));
const browserStorage = (() => {
  try { return window.localStorage; }
  catch { return null; }
})();
const resourcesOpen = ref(readDisclosureState(browserStorage, RESOURCES_DISCLOSURE_STORAGE_KEY));

function persistResourcesState(event) {
  resourcesOpen.value = event.currentTarget.open;
  writeDisclosureState(browserStorage, RESOURCES_DISCLOSURE_STORAGE_KEY, resourcesOpen.value);
}

function cardProps(item) {
  const props = { title: item.name, description: "", path: item.href, external: !!item.external };
  if (isSvgIcon(item.icon)) props.svgIcon = forumSvg;
  else props.icon = getIcon(item.icon);
  return props;
}

const LOGIN_ERROR_MESSAGES = {
  unregistered: "등록되지 않은 계정입니다. 관리자에게 문의하세요.",
  deactivated: "비활성화된 계정입니다. 관리자에게 문의하세요.",
  cancelled: "로그인이 취소되었습니다.",
  nonce: "로그인 요청이 만료되었습니다. 다시 시도해 주세요.",
  token: "로그인 중 오류가 발생했습니다. 다시 시도해 주세요.",
  userinfo: "로그인 중 오류가 발생했습니다. 다시 시도해 주세요.",
  error: "로그인 중 오류가 발생했습니다. 다시 시도해 주세요.",
  rate_limit: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
};

const { error: notifyError } = useNotification();

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("login_error");
  if (code) {
    notifyError(LOGIN_ERROR_MESSAGES[code] || "로그인에 실패했습니다.");
    history.replaceState(null, "", "/");
  }

  if (user.value) {
    refreshUser();
  }
});
</script>

<style scoped>
.app-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  transition: background-color 0.3s ease;
}

.header {
  background: #1a1b21;
  padding: 1rem 2rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.header-content {
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
}

.logo-icon {
  font-size: 2rem;
}

.logo h1 {
  color: #e2e4e9;
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.02em;
}

.header-actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  gap: 3rem;
}

.section {
  width: 100%;
  max-width: 1200px;
}

.section-title {
  font-size: 0.9375rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  margin-bottom: 1.25rem;
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
  margin-left: 0.5rem;
  transition: transform 0.15s ease;
}

.resources-section:not([open]) .collapse-icon {
  transform: rotate(-90deg);
}

.resources-section:not([open]) > summary {
  margin-bottom: 0;
}

.services {
  display: grid;
  /* auto-fit keeps short rows stretched edge to edge. The 170px minimum caps a
     1200px .section at six cards per row (seven would need 7*170 + 6*24 > 1200px). */
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 1.5rem;
  width: 100%;
}

@media (max-width: 768px) {
  .header {
    padding: 0.75rem 1rem;
  }

  .main {
    padding: 2rem 1rem;
    gap: 2rem;
    justify-content: flex-start;
  }

  .services {
    grid-template-columns: repeat(2, 1fr);
    gap: 0.75rem;
  }
}

@media (max-width: 480px) {
  .main {
    padding: 1rem;
    gap: 1.5rem;
  }
}

</style>
