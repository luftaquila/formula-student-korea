<script setup>
import { computed } from 'vue'
import { useEntryStore } from '../stores/entry'

const props = defineProps({
  modelValue: {
    type: [Number, String],
    default: null
  },
  disabled: Boolean,
  label: String
})

const emit = defineEmits(['update:modelValue'])

const entryStore = useEntryStore()
const entries = computed(() => entryStore.entries)

function handleChange(e) {
  const value = e.target.value
  emit('update:modelValue', value === '팀 선택' ? null : Number(value))
}

function handleDeselect() {
  emit('update:modelValue', null)
}
</script>

<template>
  <div class="team-select-row">
    <i v-if="label" :class="['fa', 'fa-fw', `fa-${label}`]"></i>
    <select
      class="select-team"
      :value="modelValue ?? '팀 선택'"
      :disabled="disabled"
      @change="handleChange"
    >
      <option disabled>팀 선택</option>
      <option
        v-for="entry in entries"
        :key="entry.num"
        :value="entry.num"
      >
        {{ entry.num }} {{ entry.univ }} {{ entry.team }}
      </option>
    </select>
    <button class="deselect-team" :disabled="disabled" @click="handleDeselect">
      <i class="fa fa-x"></i>
    </button>
  </div>
</template>

<style scoped>
.team-select-row {
  margin-bottom: 1rem;
}

.team-select-row i {
  margin-right: 0.7rem;
}

select.select-team {
  width: 17rem;
  height: 1.7rem;
}

button.deselect-team {
  margin-left: 0.3rem;
  width: 1.7rem;
  height: 1.7rem;
}
</style>
