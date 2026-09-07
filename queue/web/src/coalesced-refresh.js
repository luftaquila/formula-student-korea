export function createCoalescedRefresh({
  refresh,
  schedule = (callback) => queueMicrotask(callback),
}) {
  let scheduled = false;
  let running = false;
  let trailing = false;
  let stopped = false;
  let currentPromise = null;
  let resolveCurrent = null;

  function scheduleRefresh() {
    scheduled = true;
    currentPromise = new Promise((resolve) => {
      resolveCurrent = resolve;
    });

    schedule(async () => {
      const resolve = resolveCurrent;
      if (stopped) {
        scheduled = false;
        currentPromise = null;
        resolveCurrent = null;
        resolve(false);
        return;
      }

      scheduled = false;
      running = true;
      let succeeded = true;
      try {
        await refresh();
      } catch {
        succeeded = false;
      } finally {
        running = false;
        currentPromise = null;
        resolveCurrent = null;
        resolve(succeeded);

        if (trailing && !stopped) {
          trailing = false;
          scheduleRefresh();
        }
      }
    });

    return currentPromise;
  }

  function request() {
    if (stopped) return Promise.resolve(false);
    if (running) {
      trailing = true;
      return currentPromise;
    }
    if (scheduled) return currentPromise;
    return scheduleRefresh();
  }

  function stop() {
    stopped = true;
    trailing = false;
  }

  return { request, stop };
}
