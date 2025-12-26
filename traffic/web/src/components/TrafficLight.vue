<script setup>
defineProps({
  color: {
    type: String,
    default: 'grey'
  }
})
</script>

<template>
  <span class="traffic" :style="{ backgroundColor: color === 'red' ? 'rgb(230, 20, 20)' : color }"></span>
</template>

<style scoped>
.traffic {
  display: inline-block;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  margin-right: 1.5rem;
  transition: background-color 0.2s ease;
}
</style>
