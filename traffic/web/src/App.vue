<script setup>
import { onMounted } from 'vue'
import Sidebar from './components/Sidebar.vue'
import { useEntryStore } from './stores/entry'

const entryStore = useEntryStore()

onMounted(() => {
  entryStore.loadEntries()
})
</script>

<template>
  <Sidebar />
  <div id="root-container">
    <router-view />
  </div>
</template>

<style scoped>
#root-container {
  display: flex;
  margin-left: 5rem;
}
</style>
