import { ref, onUnmounted } from "vue";

export function useBoothTimers() {
  const elapsedTimes = ref({});
  let elapsedTimers = {};

  function formatElapsed(enteredAt) {
    const diff = Math.max(0, Math.floor((Date.now() - enteredAt) / 1000));
    const min = Math.floor(diff / 60).toString().padStart(2, "0");
    const sec = (diff % 60).toString().padStart(2, "0");
    return `${min}:${sec}`;
  }

  /**
   * Sync timers for a single booth type prefix.
   * Clears existing timers for that prefix before setting new ones.
   */
  function syncTimers(booths, keyPrefix) {
    // Clear only timers matching this prefix
    for (const key of Object.keys(elapsedTimers)) {
      if (key.startsWith(`${keyPrefix}-`)) {
        clearInterval(elapsedTimers[key]);
        delete elapsedTimers[key];
        delete elapsedTimes.value[key];
      }
    }
    for (const booth of booths) {
      if (booth.occupied_by && booth.entered_at) {
        const key = `${keyPrefix}-${booth.booth_num}`;
        elapsedTimes.value[key] = formatElapsed(booth.entered_at);
        elapsedTimers[key] = setInterval(() => {
          elapsedTimes.value[key] = formatElapsed(booth.entered_at);
        }, 1000);
      }
    }
  }

  function clearAllTimers() {
    Object.values(elapsedTimers).forEach(clearInterval);
    elapsedTimers = {};
    elapsedTimes.value = {};
  }

  onUnmounted(() => {
    clearAllTimers();
  });

  return { elapsedTimes, syncTimers, clearAllTimers };
}
