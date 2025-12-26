<script setup>
defineProps({
  connected: Boolean
})

const emit = defineEmits(['connect'])
</script>

<template>
  <article>
    <h2>
      <i class="fa fw fa-cash-register"></i>컨트롤러
    </h2>
    <div>
      <span
        class="connect btn"
        :class="connected ? ['green', 'disabled'] : 'red'"
        @click="emit('connect')"
      >
        <i class="fab fw fa-usb"></i>컨트롤러 연결
      </span>
    </div>
  </article>
</template>
