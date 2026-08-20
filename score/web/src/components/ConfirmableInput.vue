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
  placeholder: { type: String, default: "" },
  field: { type: String, default: undefined },
  confirmLabel: { type: String, default: "입력 확인" },
});

const emit = defineEmits(["input", "focus", "blur", "confirm"]);
const inputRef = ref(null);

function confirm() {
  emit("confirm", inputRef.value);
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
      :value="value"
      :disabled="disabled"
      :placeholder="placeholder"
      @input="emit('input', $event)"
      @focus="emit('focus', $event)"
      @blur="emit('blur', $event)"
    />
    <button
      v-if="editing"
      type="button"
      class="confirm-input-btn"
      tabindex="-1"
      :aria-label="confirmLabel"
      @mousedown.prevent
      @click="confirm"
    >확인</button>
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
  height: 1.75rem;
  padding: 0 0.5rem;
  border: 1px solid var(--accent-primary);
  border-radius: 5px;
  background: var(--accent-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}

.confirm-input-btn:hover {
  filter: brightness(1.08);
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
