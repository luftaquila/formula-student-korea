<script setup>
defineProps({
  time: {
    type: String,
    default: '00:00:00.000'
  }
})
</script>

<template>
  <div class="clock">{{ time }}</div>
</template>

<style scoped>
.clock {
  margin: 0.3rem 0 0 !important;
  font-size: 2.7rem;
  font-weight: bold;
}
</style>
