<script setup>
const isTestServer = window.__TEST_SERVER__ === true;
</script>

<template>
  <div v-if="isTestServer" class="test-server-notice" role="note">⚠️ TEST</div>
</template>

<style scoped>
.test-server-notice {
  flex-shrink: 0;
  padding: 0.25rem 0.75rem;
  background: #fef3c7;
  color: #78350f;
  font-weight: 700;
  text-align: center;
}
</style>
