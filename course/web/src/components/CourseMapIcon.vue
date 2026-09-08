<script setup>
defineProps({ name: { type: String, required: true } });
</script>

<template>
  <span class="course-map-icon" v-if="name === 'ruler'" aria-hidden="true">📏</span>
  <span class="course-map-icon" v-else-if="name === 'protractor'" aria-hidden="true">📐</span>
  <svg class="course-map-icon" v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'centerline'">
      <path d="M3 18c4 0 5-12 9-12s5 12 9 12" stroke-dasharray="3 3" />
      <circle cx="3" cy="18" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="21" cy="18" r="1.7" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'rotate' || name === 'reset'">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </template>
    <template v-else-if="name === 'eye'">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </template>
    <template v-else-if="name === 'eye-off'">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><path d="m1 1 22 22" />
    </template>
    <path v-else-if="name === 'close'" d="m6 6 12 12M6 18 18 6" />
    <template v-else-if="name === 'download'">
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </template>
  </svg>
</template>

<style scoped>
.course-map-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  font-size: 18px;
  line-height: 1;
}
</style>
