import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { fetchEntries } from "../composables/useApi";
import { useNotification } from "@shared/useNotification.js";

export const useEntryStore = defineStore("entry", () => {
  const { notyf } = useNotification();

  // State
  const entries = ref([]);
  const loaded = ref(false);
  const loading = ref(false);
  let loadSeq = 0;

  // Getters
  const isLoaded = computed(() => loaded.value);

  // Actions
  async function loadEntries() {
    const seq = ++loadSeq;
    loading.value = true;

    try {
      const res = await fetchEntries();
      if (seq !== loadSeq) return;
      entries.value = Object.entries(res).map(([key, value]) => ({
        num: Number(key),
        ...value,
      }));
      loaded.value = true;
    } catch (e) {
      if (seq !== loadSeq) return;
      notyf.error(`엔트리 목록을 불러오지 못했습니다. ${e}`);
      loaded.value = false;
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  }

  function getEntryByNum(num) {
    return entries.value.find((e) => e.num === Number(num));
  }

  return {
    entries,
    isLoaded,
    loadEntries,
    getEntryByNum,
  };
});
