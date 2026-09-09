<script setup>
import { computed } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue"]);

const presets = {
  dynamic: "다이나믹",
  test: "테스트",
};

const selectedOption = computed({
  get() {
    const preset = Object.entries(presets).find(([, name]) => name === props.modelValue);
    return preset?.[0] ?? "custom";
  },
  set(option) {
    emit("update:modelValue", presets[option] ?? "");
  },
});

const customName = computed({
  get: () => (selectedOption.value === "custom" ? props.modelValue : ""),
  set: (value) => emit("update:modelValue", value),
});
</script>

<template>
  <div class="event-name-field">
    <select
      v-model="selectedOption"
      class="form-input"
      data-testid="event-name-option"
      aria-label="이벤트 이름 선택"
      :disabled="disabled"
    >
      <option value="dynamic">다이나믹</option>
      <option value="test">테스트</option>
      <option value="custom">직접 입력</option>
    </select>
    <input
      v-if="selectedOption === 'custom'"
      v-model="customName"
      type="text"
      class="form-input"
      data-testid="event-name-custom"
      aria-label="이벤트 이름 직접 입력"
      placeholder="이벤트 이름 입력"
      :disabled="disabled"
    />
  </div>
</template>

<style scoped>
.event-name-field {
  display: grid;
  gap: 0.5rem;
}
</style>
