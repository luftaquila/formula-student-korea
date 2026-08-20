<script setup>
import { onMounted, onUnmounted, ref, watch } from "vue";
import { formatPhone } from "@shared/format-phone.js";
import * as api from "../api.js";

const year = ref(null);
const status = ref(null);
const number = ref("");
const phone = ref("010");
const agreed = ref(false);
const team = ref(null);
const teamError = ref("");
const checking = ref(false);
const error = ref("");
const busy = ref(false);
const done = ref(null);
const countdown = ref(0);

let lookupTimer = null;
let lookupSequence = 0;
let resetTimer = null;
let countdownTimer = null;
let events = null;

async function loadStatus() {
  if (!year.value) return;
  try { status.value = await api.fetchStatus(year.value); }
  catch { status.value = null; }
}

async function checkTeam(value, sequence = ++lookupSequence) {
  const trimmed = String(value).trim();
  team.value = null;
  teamError.value = "";
  if (!trimmed || !year.value) {
    checking.value = false;
    return;
  }
  checking.value = true;
  try {
    const found = await api.fetchTeam(trimmed, year.value);
    if (sequence !== lookupSequence) return;
    team.value = found;
  } catch (requestError) {
    if (sequence !== lookupSequence) return;
    teamError.value = api.errorMessage(requestError);
  } finally {
    if (sequence === lookupSequence) checking.value = false;
  }
}

watch(number, (value) => {
  clearTimeout(lookupTimer);
  const sequence = ++lookupSequence;
  team.value = null;
  teamError.value = "";
  error.value = "";
  if (!String(value).trim()) {
    checking.value = false;
    return;
  }
  checking.value = true;
  lookupTimer = setTimeout(() => checkTeam(value, sequence), 250);
});

function onPhoneInput(event) {
  phone.value = formatPhone(event.target.value);
  error.value = "";
}

function reset() {
  clearTimeout(resetTimer);
  clearInterval(countdownTimer);
  clearTimeout(lookupTimer);
  lookupSequence += 1;
  number.value = "";
  phone.value = "010";
  agreed.value = false;
  team.value = null;
  teamError.value = "";
  checking.value = false;
  error.value = "";
  done.value = null;
  countdown.value = 0;
}

async function submit() {
  if (busy.value) return;
  if (!team.value) {
    error.value = teamError.value || "활성 엔트리 번호를 입력하세요.";
    return;
  }
  if (team.value.queueStatus) {
    error.value = team.value.queueStatus === "called"
      ? "이미 호출된 엔트리입니다. 등록 데스크로 오세요."
      : "이미 대기 중인 엔트리입니다.";
    return;
  }
  if (!/^010\d{8}$/.test(phone.value.replace(/\D/g, ""))) {
    error.value = "전화번호를 정확히 입력하세요.";
    return;
  }
  if (!agreed.value) {
    error.value = "개인정보 수집 및 이용에 동의하세요.";
    return;
  }

  busy.value = true;
  error.value = "";
  try {
    done.value = await api.createRegistration({ teamId: team.value.id, phone: phone.value });
    await loadStatus();
    countdown.value = 8;
    countdownTimer = setInterval(() => { countdown.value = Math.max(0, countdown.value - 1); }, 1000);
    resetTimer = setTimeout(reset, 8000);
  } catch (requestError) {
    error.value = api.errorMessage(requestError);
    await checkTeam(number.value);
  } finally {
    busy.value = false;
  }
}

function startEvents() {
  events?.close();
  events = new EventSource(api.eventsUrl(year.value));
  const refresh = () => {
    loadStatus();
    if (number.value && !done.value) checkTeam(number.value);
  };
  events.addEventListener("init", refresh);
  events.addEventListener("registration", refresh);
}

onMounted(async () => {
  try {
    const years = await api.fetchYears();
    year.value = years[0];
    await loadStatus();
    startEvents();
  } catch (requestError) {
    error.value = api.errorMessage(requestError);
  }
});

onUnmounted(() => {
  events?.close();
  clearTimeout(lookupTimer);
  clearTimeout(resetTimer);
  clearInterval(countdownTimer);
});
</script>

<template>
  <div class="register-page stack">
    <div class="page-heading">
      <div>
        <h2>학회 등록 대기 신청</h2>
        <p>참가자가 직접 입력할 수 있도록 등록 데스크 태블릿에 이 화면을 열어두세요.</p>
      </div>
      <div v-if="status" class="status-row">
        <span class="badge" :class="status.open ? 'success' : 'danger'">
          {{ status.open ? "접수 중" : "접수 마감" }}
        </span>
        <span class="badge primary">대기 {{ status.waiting }}팀</span>
      </div>
    </div>

    <section v-if="status && !status.open" class="card notice-card">
      <div class="card-body">
        <h3>지금은 등록 대기 접수를 받지 않습니다</h3>
        <p>Chief가 대기 관리 화면에서 접수를 열 수 있습니다.</p>
      </div>
    </section>

    <section v-else-if="done" class="card success-card">
      <div class="card-body stack">
        <span class="badge success">대기 등록 완료</span>
        <div class="success-rank"><strong class="mono">{{ done.position }}</strong><span>번째</span></div>
        <p>엔트리 {{ done.number }}번 · {{ done.name }}</p>
        <p class="muted">순서가 가까워지거나 호출되면 문자로 안내합니다.</p>
        <button class="btn btn-ghost" type="button" @click="reset">처음으로 ({{ countdown }})</button>
      </div>
    </section>

    <form v-else class="card register-card" @submit.prevent="submit">
      <div class="card-body stack">
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label" for="register-number">엔트리 번호</label>
            <input
              id="register-number"
              v-model="number"
              class="form-input mono kiosk-input"
              inputmode="numeric"
              autocomplete="off"
              autofocus
            >
          </div>
          <div class="form-group">
            <label class="form-label" for="register-phone">전화번호</label>
            <input
              id="register-phone"
              class="form-input mono kiosk-input"
              type="tel"
              inputmode="numeric"
              maxlength="13"
              autocomplete="off"
              placeholder="010-0000-0000"
              :value="phone"
              @input="onPhoneInput"
            >
          </div>
          <div class="full team-result">
            <span v-if="checking" class="muted">엔트리 확인 중…</span>
            <template v-else-if="team">
              <div>
                <small>{{ team.university }}</small>
                <strong>{{ team.name }}</strong>
              </div>
              <span v-if="team.queueStatus" class="badge warning">
                {{ team.queueStatus === "called" ? "이미 호출됨" : "이미 대기 중" }}
              </span>
              <span v-else class="badge success">확인됨</span>
            </template>
            <span v-else-if="teamError" class="error-text">{{ teamError }}</span>
            <span v-else class="muted">번호를 입력하면 학교와 팀을 확인합니다.</span>
          </div>
        </div>

        <button
          type="button"
          class="consent-card"
          :class="{ agreed }"
          :aria-pressed="agreed"
          @click="agreed = !agreed; error = ''"
        >
          <span class="consent-check" aria-hidden="true">{{ agreed ? "✓" : "" }}</span>
          <span>
            <strong>개인정보 수집·이용 동의 (필수)</strong>
            <small>항목: 엔트리 번호·휴대전화번호</small>
            <small>목적: 등록 대기·순번 조회·호출 안내</small>
            <small>보유: 운영 이력과 함께 별도 삭제 전까지 보관</small>
            <small>미동의 시 등록 대기 신청 불가</small>
          </span>
        </button>

        <p v-if="error" class="error-text">{{ error }}</p>
        <button class="btn btn-primary submit-button" type="submit" :disabled="busy || !status?.open">
          {{ busy ? "등록 중…" : "대기 등록" }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.register-page { max-width: 720px; margin: 0 auto; }
.notice-card,
.success-card { text-align: center; }
.notice-card p { margin-top: 0.4rem; color: var(--text-secondary); }
.success-card .card-body { align-items: center; padding: 2rem; }
.success-rank strong { color: var(--accent-primary); font-size: 4rem; line-height: 1; }
.success-rank span { margin-left: 0.4rem; font-size: 1.2rem; font-weight: 600; }
.register-card .card-body { padding: 1.5rem; }
.kiosk-input { padding: 0.85rem 1rem; font-size: 1.25rem; }
.team-result {
  min-height: 4rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-hover);
}
.team-result div { display: flex; flex-direction: column; }
.team-result small { color: var(--text-secondary); }
.consent-card {
  display: flex;
  align-items: flex-start;
  gap: 0.9rem;
  width: 100%;
  padding: 1rem;
  color: var(--text-primary);
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
}
.consent-card.agreed { border-color: var(--accent-success); background: rgba(39, 166, 68, 0.07); }
.consent-card > span:last-child { display: flex; flex-direction: column; }
.consent-card small { color: var(--text-secondary); line-height: 1.55; }
.consent-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  border: 2px solid var(--border-color);
  border-radius: 6px;
  color: white;
  background: var(--bg-input);
  font-weight: 700;
}
.agreed .consent-check { border-color: var(--accent-success); background: var(--accent-success); }
.submit-button { min-height: 3rem; font-size: 1rem; }
</style>
