import { ref, watch } from "vue";

function readStoredFilters(storageKey) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, enabled]) => typeof enabled === "boolean"),
    );
  } catch {
    return {};
  }
}

export function usePersistentTypeFilters(storageKey, availableTypes) {
  const typeFilters = ref(readStoredFilters(storageKey));

  watch(
    availableTypes,
    (types) => {
      const next = { ...typeFilters.value };
      let changed = false;
      for (const type of types) {
        if (type in next) continue;
        next[type] = true;
        changed = true;
      }
      if (changed) typeFilters.value = next;
    },
    { immediate: true },
  );

  watch(
    typeFilters,
    (filters) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(filters));
      } catch {
        // Filtering still works when storage is unavailable.
      }
    },
    { deep: true },
  );

  return typeFilters;
}
