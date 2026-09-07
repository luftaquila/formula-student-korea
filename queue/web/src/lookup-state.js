const TERMINAL_LOOKUP_STATUSES = new Set([400, 404, 410]);

export function isTerminalLookupError(error) {
  return TERMINAL_LOOKUP_STATUSES.has(Number(error?.status));
}

export function isLookupEntryAvailable(entries, num) {
  const entry = entries?.[String(num)];
  return Boolean(entry) && entry.active !== false;
}

export function createLookupLoader({ fetchQueue, fetchRegistration }) {
  let generation = 0;

  async function load(num) {
    const requestGeneration = ++generation;
    const [queueResult, registrationResult] = await Promise.allSettled([
      fetchQueue(num),
      fetchRegistration(num),
    ]);
    if (requestGeneration !== generation) return null;

    const terminalError = queueResult.status === "rejected"
      && isTerminalLookupError(queueResult.reason)
      ? queueResult.reason
      : null;
    const queue = queueResult.status === "fulfilled"
      ? { apply: true, value: queueResult.value?.queues || [], error: null }
      : { apply: false, error: queueResult.reason };
    const registration = registrationResult.status === "fulfilled"
      ? { apply: true, value: registrationResult.value, error: null }
      : registrationResult.reason?.status === 404
        ? { apply: true, value: null, error: null }
        : { apply: false, error: registrationResult.reason };

    return { num, terminalError, queue, registration };
  }

  function invalidate() {
    generation += 1;
  }

  return { load, invalidate };
}
