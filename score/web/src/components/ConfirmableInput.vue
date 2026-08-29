<script setup>
import { ref } from "vue";

defineProps({
  value: { type: [String, Number], default: "" },
  editing: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  variant: { type: String, default: "cell" },
  inputClass: { type: [String, Array, Object], default: "" },
  type: { type: String, default: "text" },
  min: { type: [String, Number], default: undefined },
  step: { type: [String, Number], default: undefined },
  maxlength: { type: [String, Number], default: undefined },
  placeholder: { type: String, default: "" },
  field: { type: String, default: undefined },
  confirmLabel: { type: String, default: "입력 확인" },
});

const emit = defineEmits(["input", "focus", "blur", "confirm"]);
const inputRef = ref(null);
const confirmRef = ref(null);
let confirming = false;

function handleInputBlur(event) {
  if (event.relatedTarget === confirmRef.value) return;
  emit("blur", event);
}

function confirm() {
  if (document.activeElement === confirmRef.value) {
    confirming = true;
    inputRef.value?.focus({ preventScroll: true });
    confirming = false;
  }
  emit("confirm", inputRef.value);
}

function handleInputKeydown(event) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.repeat) return;
  event.preventDefault();
  confirm();
}

function handleConfirmBlur(event) {
  if (!confirming) emit("blur", event);
}
</script>

<template>
  <div class="confirmable-input" :class="{ editing, 'filter-variant': variant === 'filter' }">
    <input
      ref="inputRef"
      :class="[variant === 'filter' ? 'filter-input' : 'cell-input', inputClass]"
      :data-field="field"
      :type="type"
      :min="min"
      :step="step"
      :maxlength="maxlength"
      :value="value"
      :disabled="disabled"
      :placeholder="placeholder"
      @input="emit('input', $event)"
      @focus="emit('focus', $event)"
      @blur="handleInputBlur"
      @keydown="handleInputKeydown"
    />
    <button
      v-if="editing"
      ref="confirmRef"
      type="button"
      class="confirm-input-btn"
      :aria-label="confirmLabel"
      @mousedown.prevent
      @blur="handleConfirmBlur"
      @click="confirm"
    >
      <svg class="confirm-check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
        <polyline points="5 12 10 17 19 7" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.confirmable-input {
  display: inline-flex;
  position: relative;
  align-items: center;
  justify-content: center;
}

.confirmable-input.editing {
  z-index: 6;
}

.cell-input {
  width: 5.5rem;
  padding: 0.125rem 0.25rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.875rem;
  font-weight: 500;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
}

.cell-input:focus {
  border-color: var(--accent-primary);
  background: var(--bg-input);
}

.cell-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cell-input::placeholder {
  color: var(--text-tertiary);
}

.cell-input::-webkit-outer-spin-button,
.cell-input::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.num-input {
  width: 3.5rem;
}

.name-input {
  width: 7rem;
}

.energy-input {
  width: 4.5rem;
}

.filter-input {
  height: 2.125rem;
  padding: 0 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 0.875rem;
  outline: none;
}

.filter-input:focus {
  border-color: var(--accent-primary);
}

.filter-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.config-input {
  width: 7rem;
}

.confirm-input-btn {
  position: absolute;
  left: calc(100% + 0.25rem);
  z-index: 6;
  display: inline-flex;
  width: 1.75rem;
  height: 1.75rem;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--accent-success);
  border-radius: 5px;
  background: var(--accent-success);
  color: white;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}

.confirm-input-btn:hover {
  filter: brightness(1.08);
}

.confirm-input-btn:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.confirm-check-icon {
  width: 1.25rem;
  height: 1.25rem;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@media (max-width: 640px) {
  .filter-variant {
    width: 100%;
    justify-content: flex-start;
  }

  .filter-variant .filter-input {
    width: 100%;
    box-sizing: border-box;
  }
}
</style>
