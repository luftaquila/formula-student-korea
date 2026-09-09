// 키 단위 디바운스 팩토리. 같은 key로 다시 예약하면 이전 타이머를 취소하고 마지막
// fn만 실행한다. flush()는 대기 중인 fn 전부를 즉시 실행해 언마운트 시 저장 유실을
// 막고, cancel(key)는 실행 없이 폐기한다.
export function createKeyedDebouncer(defaultDelay = 300) {
  const timers = new Map();
  const pending = new Map();

  function debounce(key, fn, delay = defaultDelay) {
    clearTimeout(timers.get(key));
    pending.set(key, fn);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      pending.delete(key);
      fn();
    }, delay));
  }

  function cancel(key) {
    clearTimeout(timers.get(key));
    timers.delete(key);
    pending.delete(key);
  }

  function flush() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) fn();
  }

  return { debounce, cancel, flush };
}
