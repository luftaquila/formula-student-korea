import { ref, onUnmounted } from "vue";
import { formatBoothElapsed } from "../booth-timer.js";

export function useBoothTimers() {
  const elapsedTimes = ref({});
  let elapsedTimers = {};

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
        elapsedTimes.value[key] = formatBoothElapsed(booth);
        if (booth.timer_paused_at == null) {
          elapsedTimers[key] = setInterval(() => {
            elapsedTimes.value[key] = formatBoothElapsed(booth);
          }, 1000);
        }
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
