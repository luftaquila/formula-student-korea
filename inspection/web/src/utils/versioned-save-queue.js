function defaultMutationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// 같은 문항의 저장은 하나씩 실행하고, 실행 중 들어온 변경은 최신 값 하나로 합친다.
// 서버 version을 기준으로 충돌을 감지하며 오류/충돌 값은 사용자가 재시도할 때까지 보존한다.
export function createVersionedSaveQueue({
  delay = 300,
  getVersion,
  save,
  onState,
  onSaved,
  onConflict,
  onError,
  makeMutationId = defaultMutationId,
}) {
  const entries = new Map();

  function entryFor(id) {
    if (!entries.has(id)) {
      entries.set(id, {
        version: Number(getVersion(id)) || 0,
        desired: undefined,
        pending: false,
        inFlight: null,
        external: null,
        timer: null,
        state: "idle",
      });
    }
    return entries.get(id);
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
    const mutationId = makeMutationId();
    const request = { value, baseVersion: entry.version, mutationId };
    entry.pending = false;
    setState(id, entry, "saving");

    const activeRequest = { mutationId, value, promise: null };
    entry.inFlight = activeRequest;
    const promise = (async () => {
      try {
        const response = await save(id, request);
        if (entry.inFlight !== activeRequest) return undefined;
        entry.inFlight = null;
        const responseVersion = Number(response.version) || 0;
        if (entry.external && Number(entry.external.version) > responseVersion) {
          entry.version = Math.max(entry.version, Number(entry.external.version) || 0);
          entry.pending = false;
          setState(id, entry, "conflict", entry.external);
          return undefined;
        }
        entry.external = null;
        entry.version = Math.max(entry.version, responseVersion);
        onSaved?.(id, response, value);

        if (entry.pending || entry.desired !== value) {
          entry.pending = true;
          return run(id);
        }

        setState(id, entry, "saved", response);
        return response;
      } catch (error) {
        if (entry.inFlight !== activeRequest) return undefined;
        entry.inFlight = null;
        if (error.status === 409 && error.data?.current) {
          const responseCurrent = error.data.current;
          const responseVersion = Number(responseCurrent.version) || 0;
          const externalVersion = Number(entry.external?.version) || 0;
          const knownVersion = entry.version;
          const current = externalVersion >= responseVersion ? entry.external : responseCurrent;
          const currentVersion = Math.max(responseVersion, externalVersion);
          entry.version = Math.max(knownVersion, currentVersion);

          if (!current || currentVersion < knownVersion) {
            entry.pending = true;
            setState(id, entry, "error", error);
            onError?.(id, error);
            return undefined;
          }

          entry.external = current;
          setState(id, entry, "conflict", current);
          onConflict?.(id, current, entry.desired);
        } else {
          entry.pending = true;
          setState(id, entry, "error", error);
          onError?.(id, error);
        }
        return undefined;
      }
    })();

    activeRequest.promise = promise;
    return promise;
  }

  function enqueue(id, value, { immediate = false } = {}) {
    const entry = entryFor(id);
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
    return Promise.all([...entries.keys()].map(id => flush(id)));
  }

  function retry(id) {
    const entry = entryFor(id);
    entry.external = null;
    entry.pending = true;
    return run(id);
  }

  function acceptVersion(id, version) {
    const entry = entryFor(id);
    entry.version = Math.max(entry.version, Number(version) || 0);
  }

  function isOwnMutation(id, mutationId) {
    if (!mutationId) return false;
    return entryFor(id).inFlight?.mutationId === mutationId;
  }

  function isDirty(id) {
    const entry = entries.get(id);
    return !!entry && (entry.pending || !!entry.inFlight || entry.state === "error" || entry.state === "conflict");
  }

  function currentVersion(id) {
    return entryFor(id).version;
  }

  function resolveWithRemote(id, version) {
    const entry = entryFor(id);
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.inFlight = null;
    entry.version = Math.max(entry.version, Number(version) || 0);
    entry.pending = false;
    entry.desired = undefined;
    entry.external = null;
    setState(id, entry, "idle");
  }

  function markConflict(id, current) {
    const entry = entryFor(id);
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.version = Math.max(entry.version, Number(current.version) || 0);
    entry.external = current;
    entry.pending = false;
    setState(id, entry, "conflict", current);
    onConflict?.(id, current, entry.desired);
  }

  return {
    enqueue,
    flush,
    flushAll,
    retry,
    acceptVersion,
    isOwnMutation,
    isDirty,
    currentVersion,
    resolveWithRemote,
    markConflict,
  };
}
