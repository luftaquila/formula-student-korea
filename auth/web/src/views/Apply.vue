<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { formatPhone } from "@shared/format-phone.js";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";
const APPLY_PATH = import.meta.env.PROD ? "/auth/apply" : "/apply";
const { success, error } = useNotification();

const loading = ref(true);
const state = ref(""); // "closed" | "unlinked" | "registered" | "form" | "pending"
const email = ref("");
const submitting = ref(false);
const agreed = ref(false);
const form = reactive({ realname: "", phone: "", affiliation: "" });

const canSubmit = computed(
  () =>
    !!form.realname.trim() &&
    !!form.phone.trim() &&
    !!form.affiliation.trim() &&
    agreed.value &&
    !submitting.value,
);

function connectGoogle() {
  // 자동 리다이렉트 대신 명시적 연동/계정 변경 (select_account로 다른 계정 선택 가능)
  window.location.href = `/auth/api/login?redirect=${encodeURIComponent(APPLY_PATH)}`;
}

async function load() {
  loading.value = true;
  try {
    const cfgRes = await fetch(`${BASE_URL}/api/apply/config`);
    if (!cfgRes.ok) throw new Error(await cfgRes.text());
    if (!(await cfgRes.json()).open) {
      state.value = "closed";
      return;
    }

    const meRes = await fetch(`${BASE_URL}/api/apply/me`);
    if (meRes.status === 401) {
      state.value = "unlinked"; // 연동 전 — 자동 로그인 리다이렉트하지 않음
      return;
    }
    if (!meRes.ok) throw new Error(await meRes.text());
    const data = await meRes.json();
    email.value = data.email || "";

    if (data.registered) {
      state.value = "registered";
      return;
    }
    if (data.application) {
      form.realname = data.application.realname || "";
      form.phone = data.application.phone || "";
      form.affiliation = data.application.affiliation || "";
      agreed.value = true; // 최초 제출 시 동의함
      state.value = "pending";
    } else {
      state.value = "form";
    }
  } catch (e) {
    error(e.message);
  } finally {
    loading.value = false;
  }
}

function onPhoneInput(e) {
  form.phone = formatPhone(e.target.value);
}

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  const isEdit = state.value === "pending";
  try {
    const res = await fetch(`${BASE_URL}/api/apply`, {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        realname: form.realname.trim(),
        phone: formatPhone(form.phone),
        affiliation: form.affiliation.trim(),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    success(isEdit ? "수정했습니다." : "신청했습니다.");
    await load();
  } catch (e) {
    error(e.message);
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="apply-container">
    <div v-if="loading" class="loading">
      <div class="loading-spinner"></div>
    </div>

    <div v-else-if="state === 'closed'" class="card">
      <div class="card-body apply-message">
        <p class="apply-message-icon">🔒</p>
        <p>지금은 신청을 받지 않습니다.</p>
      </div>
    </div>

    <div v-else-if="state === 'registered'" class="card">
      <div class="card-body apply-message">
        <p class="apply-message-icon">✅</p>
        <p>이미 등록된 계정입니다.</p>
        <a href="/" class="btn btn-primary">사이트로 이동</a>
      </div>
    </div>

    <div v-else-if="state === 'unlinked'" class="card">
      <div class="card-header"><h3>Formula Student Korea 계정 신청</h3></div>
      <div class="card-body">
        <button type="button" class="btn btn-primary submit-btn" @click="connectGoogle">Google 계정 연동</button>
      </div>
    </div>

    <div v-else class="card">
      <div class="card-header">
        <h3>{{ state === 'pending' ? '신청 정보' : 'Formula Student Korea 계정 신청' }}</h3>
        <span v-if="state === 'pending'" class="badge badge-warning">신청 완료 · 검토 대기</span>
      </div>
      <div class="card-body">
        <p v-if="state === 'pending'" class="apply-guide">정보를 수정할 수 있습니다.</p>
        <form @submit.prevent="submit">
          <div class="form-group">
            <label class="form-label">이름</label>
            <input v-model="form.realname" type="text" class="form-input" required />
          </div>
          <div class="form-group">
            <label class="form-label">이메일</label>
            <div class="email-row">
              <input :value="email" type="email" class="form-input" readonly />
              <button type="button" class="btn btn-sm btn-ghost" @click="connectGoogle">계정 변경</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">전화번호</label>
            <input :value="form.phone" @input="onPhoneInput" type="tel" class="form-input" maxlength="13" required />
          </div>
          <div class="form-group">
            <label class="form-label">학교/팀</label>
            <input v-model="form.affiliation" type="text" class="form-input" required />
          </div>
          <label class="consent">
            <input type="checkbox" v-model="agreed" />
            <span class="consent-text">
              <strong>개인정보 수집·이용 동의 (필수)</strong>
              <span class="consent-detail">수집 항목: 이메일, 이름, 전화번호, 학교/팀<br />수집 목적: 계정 등록<br />보유 기간: 1년</span>
              <span class="consent-agree">위 내용에 동의합니다.</span>
            </span>
          </label>
          <button type="submit" class="btn btn-primary submit-btn" :disabled="!canSubmit">
            {{ state === 'pending' ? '수정하기' : '신청하기' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style>
@import "@shared/styles/base.css";
</style>

<style scoped>
.apply-container {
  max-width: 480px;
  margin: 0 auto;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.apply-guide {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  margin: 0 0 1rem;
  line-height: 1.6;
}

.email-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.email-row .form-input {
  flex: 1;
}

.form-input[readonly] {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: default;
}

.consent {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0.5rem 0;
  padding: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
}

.consent input[type="checkbox"] {
  margin-top: 0.15rem;
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  cursor: pointer;
}

.consent-text {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  font-size: 0.8125rem;
}

.consent-text strong {
  font-weight: 600;
}

.consent-detail {
  font-size: 0.75rem;
  color: var(--text-secondary);
  line-height: 1.6;
}

.consent-agree {
  font-weight: 500;
}

.submit-btn {
  width: 100%;
  margin-top: 0.5rem;
  justify-content: center;
}

.apply-message {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 2.5rem 1.25rem;
}

.apply-message-icon {
  font-size: 2.5rem;
  margin: 0;
}
</style>
