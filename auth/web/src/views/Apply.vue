<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { formatPhone } from "@shared/format-phone.js";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";
const { success, error } = useNotification();

const loading = ref(true);
const state = ref(""); // "closed" | "registered" | "form" | "pending"
const googleName = ref("");
const submitting = ref(false);
const form = reactive({ realname: "", phone: "", affiliation: "" });

const canSubmit = computed(
  () => !!form.realname.trim() && !!form.phone.trim() && !!form.affiliation.trim() && !submitting.value,
);

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
      // 세션 없음 → 구글 로그인 후 신청 페이지로 복귀
      const back = import.meta.env.PROD ? "/auth/apply" : "/apply";
      window.location.href = `/auth/api/login?redirect=${encodeURIComponent(back)}`;
      return;
    }
    if (!meRes.ok) throw new Error(await meRes.text());
    const data = await meRes.json();

    if (data.registered) {
      state.value = "registered";
      return;
    }
    googleName.value = data.name || "";
    if (data.application) {
      form.realname = data.application.realname || "";
      form.phone = data.application.phone || "";
      form.affiliation = data.application.affiliation || "";
      state.value = "pending";
    } else {
      form.realname = googleName.value; // 편의상 실명에 구글 이름 prefill
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

    <div v-else class="card">
      <div class="card-header">
        <h3>{{ state === 'pending' ? '신청 정보' : '계정 신청' }}</h3>
        <span v-if="state === 'pending'" class="badge badge-warning">신청 완료 · 검토 대기</span>
      </div>
      <div class="card-body">
        <p class="apply-guide">
          {{ state === 'pending'
            ? '정보를 수정할 수 있습니다.'
            : '정보를 입력해 신청하세요. 승인 후 계정이 생성됩니다.' }}
        </p>
        <form @submit.prevent="submit">
          <div class="form-group">
            <label class="form-label">실명</label>
            <input v-model="form.realname" type="text" class="form-input" placeholder="홍길동" required />
          </div>
          <div class="form-group">
            <label class="form-label">전화번호</label>
            <input
              :value="form.phone"
              @input="onPhoneInput"
              type="tel"
              class="form-input"
              placeholder="010-1234-5678"
              maxlength="13"
              required
            />
          </div>
          <div class="form-group">
            <label class="form-label">학교/팀</label>
            <input v-model="form.affiliation" type="text" class="form-input" placeholder="한국대학교 FSAE" required />
          </div>
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
