function defaultMutationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const COMPLETED_MUTATION_TTL_MS = 30_000;
const MAX_COMPLETED_MUTATIONS_PER_FIELD = 8;

// Serialize saves for one field so a slow earlier request cannot arrive after
// a newer request from the same browser. Cross-browser staleness is enforced
// by the server using the last value this queue successfully observed.
export function createSaveQueue({
  delay = 300,
  save,
  responseValue,
  currentValue,
  onState,
  onSaved,
  onStale,
  onError,
  makeMutationId = defaultMutationId,
}) {
  const entries = new Map();

  function entryFor(id) {
    if (!entries.has(id)) entries.set(id, {
      expected: undefined,
      desired: undefined,
      pending: false,
      inFlight: null,
      completedMutations: new Map(),
      timer: null,
      state: "idle",
    });
    return entries.get(id);
  }

  function forgetCompletedMutation(entry, mutationId) {
    const timer = entry.completedMutations.get(mutationId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    entry.completedMutations.delete(mutationId);
    return true;
  }

  function rememberCompletedMutation(entry, mutationId) {
    forgetCompletedMutation(entry, mutationId);
    const timer = setTimeout(() => {
      entry.completedMutations.delete(mutationId);
    }, COMPLETED_MUTATION_TTL_MS);
    if (typeof timer?.unref === "function") timer.unref();
    entry.completedMutations.set(mutationId, timer);
    while (entry.completedMutations.size > MAX_COMPLETED_MUTATIONS_PER_FIELD) {
      forgetCompletedMutation(entry, entry.completedMutations.keys().next().value);
    }
  }

  function setState(id, entry, state, detail = null) {
    entry.state = state;
    onState?.(id, state, detail);
  }

  async function run(id) {
    const entry = entryFor(id);
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.inFlight || !entry.pending) return entry.inFlight?.promise;

    const value = entry.desired;
    const expected = entry.expected;
    const mutationId = makeMutationId();
    const request = { value, expected, mutationId };
    entry.pending = false;
    setState(id, entry, "saving");

    const active = { mutationId, value, echoed: false, promise: null };
    entry.inFlight = active;
    const promise = (async () => {
      try {
        const response = await save(id, request);
        if (entry.inFlight !== active) return undefined;
        entry.inFlight = null;
        if (!active.echoed) rememberCompletedMutation(entry, mutationId);
        entry.expected = responseValue(response);
        onSaved?.(id, response, value);
        if (entry.pending || entry.desired !== value) {
          entry.pending = true;
          return run(id);
        }
        setState(id, entry, "saved", response);
        return response;
      } catch (error) {
        if (entry.inFlight !== active) return undefined;
        entry.inFlight = null;
        if (error.status === 409 && error.data?.code === "INSPECTION_STALE_WRITE") {
          entry.pending = false;
          entry.desired = undefined;
          entry.expected = currentValue(error.data.current);
          setState(id, entry, "idle");
          onStale?.(id, error.data.current);
        } else {
          entry.pending = true;
          setState(id, entry, "error", error);
          onError?.(id, error);
        }
        return undefined;
      }
    })();
    active.promise = promise;
    return promise;
  }

  function enqueue(id, value, { expected, immediate = false } = {}) {
    const entry = entryFor(id);
    if (!entry.pending && !entry.inFlight) entry.expected = expected;
    entry.desired = value;
    entry.pending = true;
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.state !== "saving") setState(id, entry, "pending");
    if (immediate) return run(id);
    entry.timer = setTimeout(() => run(id), delay);
    return undefined;
  }

  function flush(id) {
    const entry = entries.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    entry.timer = null;
    return run(id);
  }

  function flushAll() {
    return Promise.all([...entries.keys()].map(flush));
  }

  function retry(id) {
    const entry = entryFor(id);
    entry.pending = true;
    return run(id);
  }

  function isOwnMutation(id, mutationId) {
    if (!mutationId) return false;
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.inFlight?.mutationId === mutationId) {
      entry.inFlight.echoed = true;
      return true;
    }
    return forgetCompletedMutation(entry, mutationId);
  }

  function isDirty(id) {
    const entry = entries.get(id);
    return !!entry && (entry.pending || !!entry.inFlight || entry.state === "error");
  }

  function dirtyIds() {
    return [...entries.keys()].filter(isDirty);
  }

  function acceptRemote(id, value) {
    const entry = entryFor(id);
    entry.expected = value;
  }

  function rejectForRemote(id, current) {
    const entry = entryFor(id);
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.inFlight = null;
    entry.pending = false;
    entry.desired = undefined;
    entry.expected = currentValue(current);
    setState(id, entry, "idle");
    onStale?.(id, current);
  }

  return { enqueue, flush, flushAll, retry, isOwnMutation, isDirty, dirtyIds, acceptRemote, rejectForRemote };
}

function emptyServerRecord() {
  return {
    value: "",
    memo: "",
    answer_updated_at: null,
    answer_updated_by: "",
    memo_updated_at: null,
    memo_updated_by: "",
  };
}

export function reconcileSaveQueuesAfterReconnect({
  answers = {}, itemIds = [], answerQueue, memoQueue,
}) {
  const ids = new Set([
    ...itemIds,
    ...Object.keys(answers),
    ...answerQueue.dirtyIds(),
    ...memoQueue.dirtyIds(),
  ].map(Number).filter(Number.isInteger));
  for (const itemId of ids) {
    const serverRecord = answers[itemId] ?? emptyServerRecord();
    if (answerQueue.isDirty(itemId)) answerQueue.rejectForRemote(itemId, serverRecord);
    else answerQueue.acceptRemote(itemId, serverRecord.value);
    if (memoQueue.isDirty(itemId)) memoQueue.rejectForRemote(itemId, serverRecord);
    else memoQueue.acceptRemote(itemId, serverRecord.memo);
  }
}
