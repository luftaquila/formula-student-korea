export function createLookupRefreshScheduler({
  intervalMs,
  refresh,
  now = () => Date.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
}) {
  let lastRefreshAt = 0;
  let pendingTimer = null;
  let stopped = false;

  function clearPending() {
    if (pendingTimer === null) return;
    cancel(pendingTimer);
    pendingTimer = null;
  }

  function run() {
    if (stopped) return false;
    clearPending();
    lastRefreshAt = now();
    refresh();
    return true;
  }

  function request({ force = false } = {}) {
    if (stopped) return false;
    const remaining = intervalMs - (now() - lastRefreshAt);
    if (force || lastRefreshAt === 0 || remaining <= 0) return run();
    if (pendingTimer === null) {
      pendingTimer = schedule(() => {
        pendingTimer = null;
        run();
      }, remaining);
    }
    return false;
  }

  function markRefreshed() {
    clearPending();
    lastRefreshAt = now();
  }

  function stop() {
    stopped = true;
    clearPending();
  }

  return { request, markRefreshed, stop };
}
