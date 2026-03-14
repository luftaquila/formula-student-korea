<script setup>
import { computed } from "vue";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";

const params = new URLSearchParams(window.location.search);
const errorCode = params.get("error");
const redirect = params.get("redirect") || "/";

const errorMessage = computed(() => {
  switch (errorCode) {
    case "access_denied":
      return "접근이 거부되었습니다. 관리자에게 문의하세요.";
    case "token_failed":
    case "userinfo_failed":
    case "server_error":
      return "로그인 중 오류가 발생했습니다. 다시 시도해주세요.";
    case "no_code":
      return "인증 코드를 받지 못했습니다. 다시 시도해주세요.";
    case "csrf_failed":
      return "보안 검증에 실패했습니다. 다시 시도해주세요.";
    default:
      return null;
  }
});

const loginUrl = `${BASE_URL}/api/login?redirect=${encodeURIComponent(redirect)}`;
</script>

<template>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <span class="login-icon">🏁</span>
        <h2>Formula Student Korea</h2>
        <p>서비스 허브에 로그인</p>
      </div>

      <div v-if="errorMessage" class="error-message">
        {{ errorMessage }}
      </div>

      <a :href="loginUrl" class="google-btn">
        <svg class="google-logo" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        <span>Google 계정으로 로그인</span>
      </a>
    </div>
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 200px);
}

.login-card {
  background: var(--bg-card);
  border-radius: 16px;
  box-shadow: var(--shadow-card);
  padding: 3rem;
  width: 100%;
  max-width: 400px;
  text-align: center;
}

.login-header {
  margin-bottom: 2rem;
}

.login-icon {
  font-size: 3rem;
  display: block;
  margin-bottom: 1rem;
}

.login-header h2 {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 0.5rem;
}

.login-header p {
  color: var(--text-secondary);
  font-size: 0.9375rem;
  margin: 0;
}

.error-message {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: var(--accent-danger);
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  margin-bottom: 1.5rem;
}

.google-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.875rem 1.5rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 0.9375rem;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s ease;
}

.google-btn:hover {
  background: var(--bg-hover);
  box-shadow: var(--shadow-hover);
}

.google-logo {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

@media (max-width: 480px) {
  .login-card {
    padding: 2rem 1.5rem;
  }
}
</style>
