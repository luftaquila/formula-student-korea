<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { displayPhone } from "@shared/format-phone.js";
import { isChief } from "@shared/officialsStore.js";
import { useNotification } from "@shared/useNotification.js";
import * as api from "../api.js";

const router = useRouter();
const { success, error: notifyError } = useNotification();
const year = currentCompetitionYear();
const board = ref(null);
const loading = ref(true);
const loadError = ref("");
const busyIds = ref(new Set());
const settingsBusy = ref(false);
let events = null;
let refreshSequence = 0;

const waiting = computed(() => board.value?.waiting || []);
const called = computed(() => board.value?.called || []);

async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const result = await api.fetchQueue(year);
    if (sequence !== refreshSequence) return;
    board.value = result;
    loadError.value = "";
  } catch (requestError) {
    if (sequence !== refreshSequence) return;
    loadError.value = api.errorMessage(requestError);
  } finally {
    if (sequence === refreshSequence) loading.value = false;
  }
}

function markBusy(id, value) {
  const next = new Set(busyIds.value);
  if (value) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

async function runAction(row, action, message) {
  if (busyIds.value.has(row.id)) return;
  markBusy(row.id, true);
  try {
    await action(row.id);
    success(message);
    await refresh();
  } catch (requestError) {
    notifyError(api.errorMessage(requestError));
    await refresh();
  } finally {
    markBusy(row.id, false);
  }
}

function call(row) {
  return runAction(row, api.callRegistration, `엔트리 ${row.number}번을 호출했습니다.`);
}

function complete(row) {
  return runAction(row, api.completeRegistration, `엔트리 ${row.number}번 등록을 완료했습니다.`);
}

function cancel(row) {
  if (!window.confirm(`엔트리 ${row.number}번의 등록 대기를 취소할까요?`)) return;
  return runAction(row, api.cancelRegistration, `엔트리 ${row.number}번 대기를 취소했습니다.`);
}

async function patchSetting(change) {
  if (!isChief.value || settingsBusy.value) return;
  settingsBusy.value = true;
  try {
    const settings = await api.updateSettings({ year, ...change });
    board.value = { ...board.value, settings };
    success("대기열 설정을 저장했습니다.");
  } catch (requestError) {
    notifyError(api.errorMessage(requestError));
    await refresh();
  } finally {
    settingsBusy.value = false;
  }
}

function startEvents() {
  events = new EventSource(api.eventsUrl(year));
  events.addEventListener("init", refresh);
  events.addEventListener("registration", refresh);
}

onMounted(async () => {
  await refresh();
  startEvents();
});

onUnmounted(() => events?.close());
</script>

<template>
  <div class="stack">
    <div class="page-heading">
      <div>
        <h2>학회 등록 대기 관리</h2>
        <p>{{ year }}년 대기자를 호출하고 등록 완료 여부를 처리합니다.</p>
      </div>
      <div class="button-row">
        <span v-if="board" class="badge primary">대기 {{ waiting.length }}팀</span>
        <span v-if="board" class="badge warning">호출 {{ called.length }}팀</span>
        <button v-if="isChief" class="btn btn-primary" type="button" @click="router.push('/register')">
          현장 등록 화면
        </button>
      </div>
    </div>

    <p v-if="loadError" class="error-text">{{ loadError }}</p>

    <section v-if="board" class="summary-grid">
      <div class="card summary-card">
        <small>현재 대기</small>
        <strong>{{ waiting.length }}</strong>
      </div>
      <div class="card summary-card">
        <small>호출 중</small>
        <strong>{{ called.length }}</strong>
      </div>
      <div class="card summary-card">
        <small>오늘 완료</small>
        <strong>{{ board.today.done }}</strong>
      </div>
      <div class="card summary-card">
        <small>오늘 취소</small>
        <strong>{{ board.today.canceled }}</strong>
      </div>
    </section>

    <section v-if="board && isChief" class="card">
      <div class="card-header"><h3>접수 및 문자 설정</h3></div>
      <div class="card-body settings-body">
        <div class="setting-line">
          <div>
            <strong>현장 대기 접수</strong>
            <small>등록 데스크의 신규 신청을 열거나 닫습니다.</small>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="board.settings.open"
              :disabled="settingsBusy"
              @change="patchSetting({ open: $event.target.checked })"
            >
            <span aria-hidden="true" />
          </label>
        </div>
        <div class="setting-line">
          <div>
            <strong>문자 안내</strong>
            <small v-if="board.settings.smsAvailable">사전 순번 및 호출 문자를 발송합니다.</small>
            <small v-else>이메일/SMS 서비스에서 SENS 설정이 필요합니다.</small>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="board.settings.sms"
              :disabled="settingsBusy || (!board.settings.smsAvailable && !board.settings.sms)"
              @change="patchSetting({ sms: $event.target.checked })"
            >
            <span aria-hidden="true" />
          </label>
        </div>
        <div class="setting-line">
          <div>
            <strong>사전 안내 순번</strong>
            <small>대기열 앞에서 몇 번째까지 한 번씩 안내할지 정합니다. 0이면 비활성화됩니다.</small>
          </div>
          <select
            class="form-select rank-select"
            :value="board.settings.notifyRank"
            :disabled="settingsBusy"
            @change="patchSetting({ notifyRank: Number($event.target.value) })"
          >
            <option v-for="rank in 21" :key="rank - 1" :value="rank - 1">{{ rank - 1 }}번째</option>
          </select>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><h3>호출 중</h3></div>
      <div v-if="called.length" class="table-wrap">
        <table class="data-table">
          <thead><tr><th>엔트리</th><th>팀</th><th>전화번호</th><th>처리</th></tr></thead>
          <tbody>
            <tr v-for="row in called" :key="row.id">
              <td><strong class="mono">{{ row.number }}</strong></td>
              <td><small>{{ row.university }}</small><br>{{ row.name }}</td>
              <td class="mono">{{ displayPhone(row.phone) }}</td>
              <td>
                <div class="row-actions">
                  <button class="btn btn-success" type="button" :disabled="busyIds.has(row.id)" @click="complete(row)">완료</button>
                  <button class="btn btn-ghost" type="button" :disabled="busyIds.has(row.id)" @click="cancel(row)">취소</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty-state">호출 중인 팀이 없습니다.</div>
    </section>

    <section class="card">
      <div class="card-header"><h3>대기 중</h3></div>
      <div v-if="waiting.length" class="table-wrap">
        <table class="data-table">
          <thead><tr><th>순번</th><th>엔트리</th><th>팀</th><th>전화번호</th><th>처리</th></tr></thead>
          <tbody>
            <tr v-for="row in waiting" :key="row.id">
              <td><strong class="mono">{{ row.position }}</strong></td>
              <td><strong class="mono">{{ row.number }}</strong></td>
              <td><small>{{ row.university }}</small><br>{{ row.name }}</td>
              <td class="mono">{{ displayPhone(row.phone) }}</td>
              <td>
                <div class="row-actions">
                  <button class="btn btn-primary" type="button" :disabled="busyIds.has(row.id)" @click="call(row)">호출</button>
                  <button class="btn btn-success" type="button" :disabled="busyIds.has(row.id)" @click="complete(row)">바로 완료</button>
                  <button class="btn btn-ghost" type="button" :disabled="busyIds.has(row.id)" @click="cancel(row)">취소</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="loading" class="empty-state">대기열을 불러오는 중…</div>
      <div v-else class="empty-state">현재 대기 중인 팀이 없습니다.</div>
    </section>

    <p v-if="board && !isChief" class="muted role-note">
      Official은 호출·완료·취소를 처리할 수 있습니다. 접수와 문자 설정은 Chief 이상만 변경할 수 있습니다.
    </p>
  </div>
</template>

<style scoped>
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
}
.summary-card { padding: 1rem; }
.summary-card small { display: block; color: var(--text-secondary); }
.summary-card strong { display: block; margin-top: 0.2rem; font-size: 1.8rem; }
.settings-body { padding-top: 0; padding-bottom: 0; }
.rank-select { width: 8rem; }
.row-actions { display: flex; justify-content: flex-end; gap: 0.4rem; white-space: nowrap; }
.role-note { text-align: right; font-size: 0.85rem; }
@media (max-width: 640px) {
  .summary-grid { grid-template-columns: repeat(2, 1fr); }
  .row-actions { flex-wrap: wrap; }
}
</style>
