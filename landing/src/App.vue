<template>
  <div class="app-container">
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
    <div v-if="loginError" class="toast-error" @click="loginError = ''">{{ loginError }}</div>
    <main class="main">
      <section class="section">
        <h2 class="section-title">Services</h2>
        <div class="services">
          <ServiceCard v-if="isAuthenticated" title="서류 제출" description="" path="/documents" icon="📄" />
          <ServiceCard title="검차 대기열" description="" path="/queue" icon="🔧" />
          <ServiceCard title="에너지미터" description="" path="/energymeter" icon="⚡" />
          <ServiceCard title="대회 일정" description="" path="/calendar" icon="📅" />
          <ServiceCard title="대회 규정집" description="" path="/rules" icon="📖" external />
          <ServiceCard title="AI 규정 챗봇" description="" path="https://pitbot.luftaquila.io" icon="💽" external />
          <ServiceCard
            title="자작자동차포럼"
            description=""
            path="https://dnf.luftaquila.io"
            :svgIcon="forumSvg"
            external
          />
        </div>
      </section>

      <section v-if="showOfficials" class="section">
        <h2 class="section-title">Officials</h2>
        <div class="services">
          <ServiceCard title="검차 대기 관리" description="" path="/queue/admin" icon="🛠️" />
          <ServiceCard title="인스펙션 시트" description="" path="/inspection" icon="📋" />
          <ServiceCard v-if="isChief" title="서류 제출 관리" description="" path="/documents/admin" icon="📑" />
          <ServiceCard v-if="isChief" title="파일 클라우드" description="" path="/files/" icon="📁" />
        </div>
      </section>

      <section v-if="isAdmin" class="section">
        <h2 class="section-title">Admin</h2>
        <div class="services">
          <ServiceCard title="엔트리 관리" description="" path="/entry" icon="🏁" />
          <ServiceCard title="계측 시스템" description="" path="/traffic" icon="🚦" />
          <ServiceCard title="성적 관리" description="" path="/score" icon="📊" />
          <ServiceCard title="코스 관리" description="" path="/course" icon="📍" />
          <ServiceCard title="계정 관리" description="" path="/auth" icon="🔑" />
          <ServiceCard title="시스템 로그" description="" path="/auth/logs" icon="📜" />
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import ServiceCard from "./components/ServiceCard.vue";
import NavMenu from "@shared/NavMenu.vue";
import { user, isAuthenticated, showOfficials, isChief, isAdmin } from "@shared/officialsStore.js";
import { forumSvg } from "@shared/nav-config.js";

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

const loginError = ref("");

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("login_error");
  if (error) {
    loginError.value = LOGIN_ERROR_MESSAGES[error] || "로그인에 실패했습니다.";
    history.replaceState(null, "", "/");
  }

  if (user.value) {
    fetch("/auth/api/session").then(res => {
      if (res.ok) return res.json().then(data => { user.value = data; });
      user.value = null;
    }).catch(() => {});
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

.services {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
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

.toast-error {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--danger, #ef4444);
  color: #fff;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  cursor: pointer;
  z-index: 9999;
  animation: toast-in 0.3s ease;
}

@keyframes toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-1rem); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
</style>
