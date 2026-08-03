<script setup>
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useNotification } from "@shared/useNotification.js";
import { updateRecord } from "../composables/useApi";

const props = defineProps({
  record: { type: Object, required: true },
});
const emit = defineEmits(["update"]);
const { notyf } = useNotification();

const state = reactive({
  invalidated: 0,
  scoreboard: 1,
  cones: 0,
  oc: 0,
});
const pending = reactive({
  invalidated: false,
  scoreboard: false,
  cones: false,
  oc: false,
});
const saveState = ref("ready");
let savedTimer = null;

function normalizeCount(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function syncRecord(record) {
  state.invalidated = record?.invalidated ? 1 : 0;
  state.scoreboard = record?.scoreboard ? 1 : 0;
  state.cones = normalizeCount(record?.cones);
  state.oc = normalizeCount(record?.oc);
}

watch(() => props.record, syncRecord, { immediate: true, deep: true });

const isSaving = computed(() => Object.values(pending).some(Boolean));
const isStatusSaving = computed(() => pending.invalidated || pending.scoreboard);

function markSaved() {
  clearTimeout(savedTimer);
  saveState.value = "saved";
  savedTimer = setTimeout(() => { saveState.value = "ready"; }, 1600);
}

function mergeResult(result) {
  if (!result) return;
  if ("invalidated" in result) state.invalidated = result.invalidated ? 1 : 0;
  if ("scoreboard" in result) state.scoreboard = result.scoreboard ? 1 : 0;
  if ("cones" in result) state.cones = normalizeCount(result.cones);
  if ("oc" in result) state.oc = normalizeCount(result.oc);
  emit("update", result);
}

async function toggle(field) {
  // 두 필드는 서버에서 현재 값을 기준으로 토글되고 무효화↔전광판 연동도 있으므로
  // 서로 다른 버튼이라도 동시에 보내지 않는다.
  if (isStatusSaving.value) return;
  pending[field] = true;
  saveState.value = "saving";
  try {
    const result = await updateRecord(props.record.name, props.record.rowid, field);
    mergeResult(result);
    markSaved();
  } catch (e) {
    saveState.value = "ready";
    notyf.error(`기록 수정 실패: ${e.message}`);
  } finally {
    pending[field] = false;
  }
}

async function saveCount(field, value, input = null) {
  if (pending[field]) return;
  const next = normalizeCount(value);
  const previous = state[field];
  if (input) input.value = String(next);
  if (next === previous) return;

  pending[field] = true;
  saveState.value = "saving";
  state[field] = next;
  try {
    const result = await updateRecord(props.record.name, props.record.rowid, field, next);
    mergeResult(result);
    markSaved();
  } catch (e) {
    state[field] = previous;
    if (input) input.value = String(previous);
    saveState.value = "ready";
    notyf.error(`기록 수정 실패: ${e.message}`);
  } finally {
    pending[field] = false;
  }
}

function onCountChange(field, event) {
  saveCount(field, event.currentTarget.value, event.currentTarget);
}

onUnmounted(() => clearTimeout(savedTimer));
</script>

<template>
  <section
    class="quick-edit"
    :class="{ 'has-summary': !!$slots.summary }"
    data-testid="record-quick-edit"
    aria-label="기록 빠른 편집"
  >
    <div
      v-if="$slots.summary || (saveState === 'saved' && !isSaving)"
      class="quick-edit-summary"
    >
      <slot name="summary"></slot>
      <div
        v-if="saveState === 'saved' && !isSaving"
        class="save-status"
        data-testid="quick-save-status"
        aria-live="polite"
      >
        <span class="status-dot"></span>
        저장됨
      </div>
    </div>

    <div class="quick-edit-body">
      <div class="toggle-grid">
        <button
          type="button"
          class="state-button"
          :class="state.invalidated ? 'is-danger' : 'is-success'"
          :aria-pressed="!!state.invalidated"
          :disabled="isStatusSaving"
          data-testid="quick-invalidated"
          @click="toggle('invalidated')"
        >
          <span class="state-label">기록 상태</span>
          <strong>{{ state.invalidated ? "무효" : "유효" }}</strong>
          <span class="state-hint">눌러서 {{ state.invalidated ? "유효화" : "무효화" }}</span>
        </button>
        <button
          type="button"
          class="state-button"
          :class="state.scoreboard ? 'is-success' : 'is-muted'"
          :aria-pressed="!!state.scoreboard"
          :disabled="isStatusSaving || !!state.invalidated"
          data-testid="quick-scoreboard"
          @click="toggle('scoreboard')"
        >
          <span class="state-label">전광판</span>
          <strong>{{ state.scoreboard ? "표시" : "숨김" }}</strong>
          <span class="state-hint">{{ state.invalidated ? "무효 기록은 표시 불가" : "눌러서 전환" }}</span>
        </button>
      </div>

      <div class="penalty-grid">
        <div class="penalty-control">
          <label for="quick-cones">콘터치</label>
          <div class="stepper">
            <button
              type="button"
              aria-label="콘터치 1 감소"
              :disabled="pending.cones || state.cones <= 0"
              @click="saveCount('cones', state.cones - 1)"
            >−</button>
            <input
              id="quick-cones"
              :value="state.cones"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              :disabled="pending.cones"
              data-testid="quick-cones"
              @change="onCountChange('cones', $event)"
              @keydown.enter="$event.currentTarget.blur()"
            />
            <button
              type="button"
              aria-label="콘터치 1 증가"
              :disabled="pending.cones"
              data-testid="quick-cones-plus"
              @click="saveCount('cones', state.cones + 1)"
            >+</button>
          </div>
        </div>

        <div class="penalty-control">
          <label for="quick-oc">코스 이탈</label>
          <div class="stepper">
            <button
              type="button"
              aria-label="코스 이탈 1 감소"
              :disabled="pending.oc || state.oc <= 0"
              @click="saveCount('oc', state.oc - 1)"
            >−</button>
            <input
              id="quick-oc"
              :value="state.oc"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              :disabled="pending.oc"
              data-testid="quick-oc"
              @change="onCountChange('oc', $event)"
              @keydown.enter="$event.currentTarget.blur()"
            />
            <button
              type="button"
              aria-label="코스 이탈 1 증가"
              :disabled="pending.oc"
              data-testid="quick-oc-plus"
              @click="saveCount('oc', state.oc + 1)"
            >+</button>
          </div>
        </div>
      </div>

    </div>
  </section>
</template>

<style scoped>
.quick-edit {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border-color);
}

.quick-edit.has-summary {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}

.quick-edit-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.quick-edit-body {
  margin-top: 0;
}

.quick-edit.has-summary .quick-edit-body,
.quick-edit-summary + .quick-edit-body { margin-top: 1rem; }

.toggle-grid,
.penalty-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

.state-button {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 0.2rem 0.75rem;
  min-height: 76px;
  padding: 0.8rem 1rem;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.state-button strong {
  grid-row: 1 / span 2;
  grid-column: 2;
  font-size: 1.1rem;
}

.state-button.is-success {
  border-color: rgba(16, 185, 129, 0.45);
  background: rgba(16, 185, 129, 0.1);
}

.state-button.is-success strong { color: var(--accent-success); }
.state-button.is-danger {
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.1);
}
.state-button.is-danger strong { color: var(--accent-danger); }
.state-button.is-muted strong { color: var(--text-tertiary); }
.state-button:disabled { cursor: not-allowed; opacity: 0.58; }

.state-label {
  font-size: 0.82rem;
  font-weight: 650;
}

.state-hint {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.penalty-grid {
  margin-top: 0.9rem;
}

.penalty-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.8rem 1rem;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
}

.penalty-control label {
  font-size: 0.86rem;
  font-weight: 650;
}

.stepper {
  display: grid;
  grid-template-columns: 40px 58px 40px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
}

.stepper button,
.stepper input {
  height: 40px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
}

.stepper button {
  font-size: 1.25rem;
  cursor: pointer;
}

.stepper button:hover:not(:disabled) { background: rgba(94, 106, 210, 0.12); }
.stepper button:disabled { opacity: 0.35; cursor: not-allowed; }
.stepper input {
  min-width: 0;
  border-right: 1px solid var(--border-color);
  border-left: 1px solid var(--border-color);
  text-align: center;
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  appearance: textfield;
}
.stepper input::-webkit-inner-spin-button,
.stepper input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.stepper input:focus { outline: 2px solid var(--border-focus); outline-offset: -2px; }

.save-status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 1.2rem;
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent-success);
}

@media (max-width: 720px) {
  .toggle-grid,
  .penalty-grid { grid-template-columns: 1fr; }
  .penalty-control { flex-wrap: wrap; }
  .stepper { margin-left: auto; }
}
</style>
