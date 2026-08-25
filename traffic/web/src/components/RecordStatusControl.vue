<script setup>
import { computed } from "vue";

const props = defineProps({
  status: { type: String, default: null },
  result: { type: Number, default: null },
  disabled: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
  allowCancel: { type: Boolean, default: false },
});
const emit = defineEmits(["select", "cancel"]);

const options = Object.freeze([
  { value: null, label: "정상" },
  { value: "DNS", label: "DNS" },
  { value: "DNF", label: "DNF" },
  { value: "DSQ", label: "DSQ" },
]);
const hasMeasuredTime = computed(() => Number.isInteger(props.result) && props.result > 0);
const canCancel = computed(() => props.allowCancel && props.status != null && !hasMeasuredTime.value);

function select(status) {
  if (props.disabled || props.busy || status === props.status) return;
  if (status === null && !hasMeasuredTime.value) return;
  emit("select", status);
}
</script>

<template>
  <div class="record-status" :class="{ compact }" role="group" aria-label="기록 판정">
    <button
      v-for="option in options"
      :key="option.label"
      type="button"
      class="status-option"
      :class="[`status-${option.value || 'normal'}`, { active: status === option.value }]"
      :disabled="disabled || busy || (option.value === null && !hasMeasuredTime)"
      :aria-pressed="status === option.value"
      :data-status="option.value || 'normal'"
      @click="select(option.value)"
    >
      {{ option.label }}
    </button>
    <button
      v-if="canCancel"
      type="button"
      class="status-cancel"
      :disabled="disabled || busy"
      @click="emit('cancel')"
    >
      판정 취소
    </button>
  </div>
</template>

<style scoped>
.record-status {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.45rem;
}

.status-option,
.status-cancel {
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

.status-option:hover:not(:disabled) { border-color: var(--border-focus); }
.status-option:disabled,
.status-cancel:disabled { cursor: not-allowed; opacity: 0.45; }
.status-normal.active { border-color: var(--accent-success); background: rgba(16, 185, 129, 0.12); color: var(--accent-success); }
.status-DNS.active { border-color: #64748b; background: rgba(100, 116, 139, 0.15); color: #94a3b8; }
.status-DNF.active { border-color: #f59e0b; background: rgba(245, 158, 11, 0.13); color: #f59e0b; }
.status-DSQ.active { border-color: var(--accent-danger); background: rgba(239, 68, 68, 0.12); color: var(--accent-danger); }
.status-cancel {
  grid-column: 1 / -1;
  color: var(--text-tertiary);
  background: transparent;
}

.compact { gap: 0.25rem; }
.compact .status-option { min-height: 32px; padding: 0.35rem 0.45rem; font-size: 0.74rem; }
.compact .status-cancel { min-height: 30px; padding: 0.3rem; font-size: 0.72rem; }
</style>
