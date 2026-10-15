<script setup>
import { computed } from "vue";

const props = defineProps({
  status: { type: String, default: null },
  result: { type: Number, default: null },
  disabled: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
  // Saved records only: an untimed row cannot become normal, so clearing its
  // verdict deletes the row. Drafts just clear the selection.
  allowCancel: { type: Boolean, default: false },
});
const emit = defineEmits(["select", "cancel"]);

const options = Object.freeze([
  { value: "DNS", label: "DNS" },
  { value: "DNF", label: "DNF" },
  { value: "DSQ", label: "DSQ" },
]);
const hasMeasuredTime = computed(() => Number.isInteger(props.result) && props.result > 0);
const clearDeletes = computed(() => props.allowCancel && !hasMeasuredTime.value);
const clearHint = computed(() => (clearDeletes.value ? "다시 누르면 기록 삭제" : "다시 누르면 판정 해제"));

function toggle(status) {
  if (props.disabled || props.busy) return;
  if (status !== props.status) {
    emit("select", status);
  } else if (!clearDeletes.value) {
    emit("select", null);
  } else if (window.confirm(`${status} 판정을 해제하면 측정시간이 없어 이 기록이 삭제됩니다. 계속할까요?`)) {
    emit("cancel");
  }
}
</script>

<template>
  <div class="record-status" :class="{ compact }" role="group" aria-label="기록 판정">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="status-option"
      :class="[`status-${option.value}`, { active: status === option.value }]"
      :disabled="disabled || busy"
      :aria-pressed="status === option.value"
      :data-status="option.value"
      :title="status === option.value ? clearHint : undefined"
      @click="toggle(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.record-status {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
}

.status-option {
  min-height: 40px;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font: inherit;
  font-size: 0.82rem;
  font-weight: 750;
  cursor: pointer;
}

.status-DNS:hover:not(:disabled) { border-color: #64748b; }
.status-DNF:hover:not(:disabled) { border-color: #f59e0b; }
.status-DSQ:hover:not(:disabled) { border-color: var(--accent-danger); }
.status-option:disabled { cursor: not-allowed; opacity: 0.45; }
.status-DNS.active { border-color: #64748b; background: rgba(100, 116, 139, 0.15); color: #94a3b8; }
.status-DNF.active { border-color: #f59e0b; background: rgba(245, 158, 11, 0.13); color: #f59e0b; }
.status-DSQ.active { border-color: var(--accent-danger); background: rgba(239, 68, 68, 0.12); color: var(--accent-danger); }
.compact { gap: 0.25rem; }
.compact .status-option { min-height: 32px; padding: 0.35rem 0.45rem; font-size: 0.74rem; }
</style>
