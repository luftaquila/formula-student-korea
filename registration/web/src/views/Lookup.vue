<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { displayPhone, formatPhone } from "@shared/format-phone.js";
import * as api from "../api.js";

const years = ref([]);
const year = ref(null);
const status = ref(null);
const form = ref({ num: "", phone: "" });
const result = ref(null);
const notFound = ref(false);
const error = ref("");
const busy = ref(false);
let events = null;

const ahead = computed(() => result.value?.position ? result.value.position - 1 : 0);
const storageKey = () => `fsk_registration_lookup_${year.value}`;

async function loadStatus() {
  if (!year.value) return;
  try { status.value = await api.fetchStatus(year.value); }
  catch { status.value = null; }
}

function onPhoneInput(event) {
  form.value.phone = formatPhone(event.target.value);
  error.value = "";
}

async function lookup({ silent = false } = {}) {
  const num = String(form.value.num).trim();
  const phone = String(form.value.phone).trim();
  if (!num || !phone) {
    if (!silent) error.value = "엔트리 번호와 전화번호를 입력하세요.";
    return;
  }
  if (!silent) busy.value = true;
  error.value = "";
  try {
    result.value = await api.lookupRegistration({ year: year.value, num, phone });
    notFound.value = false;
    localStorage.setItem(storageKey(), JSON.stringify({ num, phone }));
  } catch (requestError) {
    result.value = null;
    notFound.value = requestError?.status === 404;
    if (!silent) error.value = api.errorMessage(requestError);
  } finally {
    if (!silent) busy.value = false;
  }
}

function reset() {
  result.value = null;
  notFound.value = false;
  error.value = "";
  form.value = { num: "", phone: "" };
  localStorage.removeItem(storageKey());
}

function restoreLookup() {
  result.value = null;
  notFound.value = false;
  error.value = "";
  form.value = { num: "", phone: "" };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || "null");
    if (saved?.num && saved?.phone) {
      form.value = { num: saved.num, phone: formatPhone(saved.phone) };
      lookup({ silent: true });
    }
  } catch {}
}

function startEvents() {
  events?.close();
  if (!year.value) return;
  events = new EventSource(api.eventsUrl(year.value));
  const refresh = () => {
    loadStatus();
    if (result.value) lookup({ silent: true });
  };
  events.addEventListener("init", refresh);
  events.addEventListener("registration", refresh);
}

watch(year, () => {
  loadStatus();
  restoreLookup();
  startEvents();
});

onMounted(async () => {
  try {
    years.value = await api.fetchYears();
    year.value = years.value[0];
  } catch (requestError) {
    error.value = api.errorMessage(requestError);
  }
});

onUnmounted(() => events?.close());
</script>

<template>
  <div class="lookup-page stack">
    <div class="page-heading">
      <div>
        <h2>학회 등록 대기 현황</h2>
        <p>등록할 때 입력한 엔트리 번호와 전화번호로 현재 순번을 확인하세요.</p>
      </div>
      <select v-if="years.length" v-model="year" class="form-select" aria-label="대회 연도">
        <option v-for="item in years" :key="item" :value="item">{{ item }}년</option>
      </select>
    </div>

    <div v-if="status" class="status-row">
      <span class="badge" :class="status.open ? 'success' : 'danger'">
        {{ status.open ? "접수 중" : "접수 마감" }}
      </span>
      <span class="badge primary">현재 대기 {{ status.waiting }}팀</span>
    </div>

    <section v-if="status?.called?.length" class="card">
      <div class="card-header"><h3>호출된 엔트리</h3></div>
      <div class="card-body badge-row">
        <span v-for="row in status.called" :key="row.teamId" class="badge warning mono">
          {{ row.number }}번
        </span>
      </div>
    </section>

    <section class="card lookup-card">
      <div v-if="result" class="card-body result-card stack">
        <div class="badge-row">
          <span class="badge" :class="result.status === 'called' ? 'warning' : 'primary'">
            {{ result.status === "called" ? "호출됨" : "대기 중" }}
          </span>
          <span class="muted">{{ result.university }} · {{ result.name }}</span>
        </div>

        <div v-if="result.status === 'waiting'" class="rank-block">
          <strong class="mono">{{ result.position }}</strong>
          <span>번째</span>
          <p v-if="ahead">앞에 {{ ahead }}팀이 기다리고 있습니다.</p>
          <p v-else>다음 차례입니다. 등록 데스크 근처에서 대기하세요.</p>
        </div>
        <div v-else class="called-block">
          <strong>등록 차례입니다</strong>
          <p>등록 데스크로 와주세요.</p>
        </div>

        <dl class="result-details">
          <div><dt>엔트리</dt><dd class="mono">{{ result.number }}번</dd></div>
          <div><dt>전체 대기</dt><dd>{{ result.waitingTotal }}팀</dd></div>
          <div><dt>전화번호</dt><dd class="mono">{{ displayPhone(form.phone.replace(/\D/g, '')) }}</dd></div>
        </dl>
        <button class="btn btn-ghost" type="button" @click="reset">다른 대기 조회</button>
      </div>

      <form v-else class="card-body stack" @submit.prevent="lookup()">
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label" for="lookup-number">엔트리 번호</label>
            <input id="lookup-number" v-model="form.num" class="form-input mono" inputmode="numeric" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="form-label" for="lookup-phone">전화번호</label>
            <input
              id="lookup-phone"
              class="form-input mono"
              type="tel"
              inputmode="numeric"
              maxlength="13"
              placeholder="010-0000-0000"
              autocomplete="tel"
              :value="form.phone"
              @input="onPhoneInput"
            >
          </div>
        </div>
        <p v-if="notFound && !error" class="muted">대기 중인 등록 내역이 없습니다.</p>
        <p v-if="error" class="error-text">{{ error }}</p>
        <button class="btn btn-primary" type="submit" :disabled="busy || !year">
          {{ busy ? "조회 중…" : "내 순번 조회" }}
        </button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.lookup-page { max-width: 680px; margin: 0 auto; }
.lookup-card { margin-top: 0.25rem; }
.result-card { align-items: stretch; }
.rank-block,
.called-block { padding: 1.5rem; text-align: center; background: var(--bg-hover); border-radius: 10px; }
.rank-block strong { font-size: 3.3rem; line-height: 1; color: var(--accent-primary); }
.rank-block > span { margin-left: 0.3rem; font-size: 1.1rem; font-weight: 600; }
.rank-block p,
.called-block p { margin-top: 0.65rem; color: var(--text-secondary); }
.called-block strong { font-size: 1.35rem; color: var(--accent-warning); }
.result-details { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; }
.result-details div { padding: 0.7rem; border: 1px solid var(--border-color); border-radius: 8px; }
.result-details dt { color: var(--text-secondary); font-size: 0.75rem; }
.result-details dd { margin-top: 0.15rem; font-weight: 600; }
@media (max-width: 540px) { .result-details { grid-template-columns: 1fr; } }
</style>
