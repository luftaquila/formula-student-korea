import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { fetchEntries } from '../composables/useApi'
import { useNotification } from '../composables/useNotification'

export const useEntryStore = defineStore('entry', () => {
  const { notyf } = useNotification()

  // State
  const entries = ref([])
  const loaded = ref(false)
  const loading = ref(false)

  // Getters
  const entryList = computed(() => entries.value)
  const isLoaded = computed(() => loaded.value)

  // Actions
  async function loadEntries() {
    if (loading.value) return
    loading.value = true

    try {
      const res = await fetchEntries()
      entries.value = Object.entries(res).map(([key, value]) => ({
        num: Number(key),
        ...value
      }))
      loaded.value = true
    } catch (e) {
      notyf.error(`엔트리 목록을 불러오지 못했습니다.<br>${e}`)
      loaded.value = false
    } finally {
      loading.value = false
    }
  }

  function getEntryByNum(num) {
    return entries.value.find(e => e.num === Number(num))
  }

  return {
    entries,
    loaded,
    loading,
    entryList,
    isLoaded,
    loadEntries,
    getEntryByNum
  }
})
