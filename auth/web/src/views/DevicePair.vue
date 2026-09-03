<script setup>
import { ref } from "vue";

const BASE_URL = import.meta.env.PROD ? "/auth" : "";
const code = ref("");
const error = ref("");
const pairing = ref(false);

async function pair() {
  if (pairing.value) return;
  pairing.value = true;
  error.value = "";
  try {
    const response = await fetch(`${BASE_URL}/api/device/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.value }),
    });
    if (!response.ok) {
      error.value = response.status === 429
        ? "입력 횟수가 너무 많습니다. 잠시 후 다시 시도하세요."
        : "코드가 올바르지 않거나 만료되었습니다.";
      return;
    }
    const device = await response.json();
    window.location.href = device.startPath;
  } catch {
    error.value = "인증 서버에 연결할 수 없습니다.";
  } finally {
    pairing.value = false;
  }
}
</script>

<template>
  <section class="pair-card card">
    <h2>태블릿 장비 인증</h2>
    <p>관리자 화면에 표시된 8자리 장비 코드를 입력하세요.</p>
    <form @submit.prevent="pair">
      <input
        v-model="code"
        class="pair-code"
        maxlength="8"
        autocomplete="one-time-code"
        autocapitalize="characters"
        placeholder="장비 코드"
        autofocus
      />
      <button class="btn btn-primary" :disabled="pairing || code.trim().length !== 8">
        {{ pairing ? "인증 중…" : "접수 화면 열기" }}
      </button>
    </form>
    <p v-if="error" class="pair-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.pair-card { width: min(440px, calc(100vw - 2rem)); margin: 8vh auto 0; padding: 2rem; text-align: center; }
.pair-card form { display: grid; gap: 1rem; margin-top: 1.5rem; }
.pair-code { width: 100%; padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); color: var(--text-primary); font: 700 2rem/1 monospace; letter-spacing: 0.25em; text-align: center; text-transform: uppercase; }
.pair-error { color: var(--danger-color, #ef4444); }
</style>
