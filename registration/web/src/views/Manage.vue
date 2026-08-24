<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { displayPhone } from "@shared/format-phone.js";
import { isChief } from "@shared/officialsStore.js";
import { useNotification } from "@shared/useNotification.js";
import * as api from "../api.js";
import { useRegistrationSSE } from "../composables/useSSE.js";

const router = useRouter();
const { success, error: notifyError } = useNotification();
const { registrationRevision, reconnected } = useRegistrationSSE();
const year = currentCompetitionYear();
const board = ref(null);
const settingsForm = ref({ open: false, sms: false, notifyRank: 3 });
const loading = ref(true);
const loadError = ref("");
const busyIds = ref(new Set());
const settingsBusy = ref(false);
let refreshSequence = 0;

const waiting = computed(() => board.value?.waiting || []);

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
    syncSettingsForm(board.value?.settings);
    notifyError(api.errorMessage(requestError));
    await refresh();
  } finally {
    settingsBusy.value = false;
  }
}

function syncSettingsForm(settings) {
  if (!settings) return;
  settingsForm.value = {
    open: settings.open,
    sms: settings.sms,
    notifyRank: settings.notifyRank,
  };
}

watch(() => board.value?.settings, syncSettingsForm);
watch(registrationRevision, refresh);
watch(reconnected, refresh);

onMounted(async () => {
  await refresh();
});
</script>

<template>
  <div class="admin-panel">
    <div class="top-actions">
      <button v-if="isChief" class="btn btn-primary" type="button" @click="router.push('/register')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        등록 대기 접수
      </button>
      <span class="year-label">{{ year }}년 운영 현황</span>
    </div>

    <p v-if="loadError" class="error-text">{{ loadError }}</p>

    <div class="admin-grid" :class="{ 'no-settings': !isChief }">
      <section class="card queue-panel">
        <div class="card-header queue-header">
          <div class="header-left">
            <h3>📋 등록 대기열</h3>
            <span class="queue-count">{{ waiting.length }}팀 대기중</span>
          </div>
        </div>

        <div v-if="loading && !board" class="loading"><div class="loading-spinner" /></div>
        <template v-else-if="board">
          <div class="summary-grid">
            <div class="summary-card">
              <small>현재 대기</small>
              <strong>{{ waiting.length }}</strong>
            </div>
            <div class="summary-card">
              <small>오늘 완료</small>
              <strong>{{ board.today.done }}</strong>
            </div>
            <div class="summary-card">
              <small>오늘 취소</small>
              <strong>{{ board.today.canceled }}</strong>
            </div>
          </div>

          <div class="queue-section">
            <div class="section-header">
              <h4>대기 중</h4>
              <span class="badge badge-primary">{{ waiting.length }}팀</span>
            </div>
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
                        <button class="btn btn-success btn-sm" type="button" :disabled="busyIds.has(row.id)" @click="complete(row)">완료</button>
                        <button class="btn btn-ghost btn-sm" type="button" :disabled="busyIds.has(row.id)" @click="cancel(row)">취소</button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="empty-state">현재 대기 중인 팀이 없습니다.</div>
          </div>
        </template>
      </section>

      <section v-if="board && isChief" class="card settings-panel">
        <div class="card-header"><h3>⚙️ 설정</h3></div>
        <div class="card-body settings-body">
          <div class="setting-line">
            <strong>현장 대기 접수</strong>
            <label class="toggle">
              <input
                v-model="settingsForm.open"
                type="checkbox"
                :disabled="settingsBusy"
                @change="patchSetting({ open: settingsForm.open })"
              >
              <span class="toggle-slider" aria-hidden="true" />
            </label>
          </div>
          <div class="setting-line">
            <strong>문자 안내</strong>
            <label class="toggle">
              <input
                v-model="settingsForm.sms"
                type="checkbox"
                :disabled="settingsBusy || (!board.settings.smsAvailable && !board.settings.sms)"
                @change="patchSetting({ sms: settingsForm.sms })"
              >
              <span class="toggle-slider" aria-hidden="true" />
            </label>
          </div>
          <div class="setting-line rank-setting">
            <strong>사전 안내 순번</strong>
            <label class="rank-input">
              <input
                v-model.number="settingsForm.notifyRank"
                class="form-input mono"
                type="number"
                inputmode="numeric"
                min="1"
                max="10"
                step="1"
                aria-label="사전 안내 순번"
                :disabled="settingsBusy"
                @change="patchSetting({ notifyRank: settingsForm.notifyRank })"
              >
              <span>번째</span>
            </label>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.admin-panel { display: flex; flex-direction: column; gap: 1.5rem; }
.top-actions { display: flex; align-items: center; gap: 0.75rem; }
.year-label { margin-left: auto; color: var(--text-secondary); font-size: 0.875rem; }
.admin-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 1.5rem; align-items: start; }
.admin-grid.no-settings { grid-template-columns: 1fr; }
.queue-header { display: flex; align-items: center; justify-content: space-between; }
.header-left { display: flex; align-items: center; gap: 0.75rem; }
.queue-count { padding: 0.25rem 0.625rem; color: white; background: var(--accent-primary); border-radius: 12px; font-family: "JetBrains Mono", monospace; font-size: 0.75rem; font-weight: 600; }
.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-bottom: 1px solid var(--border-color);
}
.summary-card { padding: 1rem 1.25rem; border-right: 1px solid var(--border-color); }
.summary-card:last-child { border-right: 0; }
.summary-card small { display: block; color: var(--text-secondary); }
.summary-card strong { display: block; margin-top: 0.2rem; font-size: 1.8rem; }
.queue-section + .queue-section { border-top: 1px solid var(--border-color); }
.section-header { display: flex; align-items: center; gap: 0.6rem; padding: 0.875rem 1.25rem; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); }
.section-header h4 { font-size: 0.9rem; }
.settings-panel { position: sticky; top: 1.5rem; }
.settings-body { padding-top: 0; padding-bottom: 0; }
.rank-input { display: flex; align-items: center; gap: 0.5rem; }
.rank-input .form-input { width: 5rem; text-align: center; }
.row-actions { display: flex; justify-content: flex-end; gap: 0.4rem; white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.data-table td:last-child,
.data-table th:last-child { text-align: right; }
.data-table small { color: var(--text-secondary); }
@media (max-width: 1024px) {
  .admin-grid { grid-template-columns: 1fr; }
  .settings-panel { position: static; }
}
@media (max-width: 640px) {
  .row-actions { flex-wrap: wrap; }
  .top-actions { align-items: stretch; flex-direction: column; }
  .year-label { margin-left: 0; }
}
</style>
