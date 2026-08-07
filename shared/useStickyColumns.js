import { ref, computed, watch, onBeforeUnmount, nextTick } from "vue";

// scrollerRef(가로 스크롤 래퍼)는 선택이다. 넘기면 방향키 이동 시 대상 셀이 고정열 뒤로
// 들어가지 않도록 스크롤 여백을 잡아준다. 넘기지 않으면 고정/드래그 동작만 그대로 쓴다.
export function useStickyColumns({ storageKey, tableRef, scrollerRef, columnSelectors, defaultCols = 1 }) {
  const maxCols = columnSelectors.length;

  const initial = (() => {
    const raw = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(raw) && raw >= 1 && raw <= maxCols) return raw;
    return defaultCols;
  })();

  const stickyCols = ref(initial);
  watch(stickyCols, (v) => localStorage.setItem(storageKey, String(v)));

  const widths = ref(new Array(maxCols).fill(0));
  const offsets = computed(() => {
    const out = [0];
    for (let i = 0; i < maxCols; i++) out.push(out[i] + widths.value[i]);
    return out;
  });
  const lineX = computed(() => offsets.value[stickyCols.value]);

  let resizeObs = null;
  let observedEls = [];

  function measure() {
    const table = tableRef.value;
    if (!table) return;
    const next = new Array(maxCols).fill(0);
    for (let i = 0; i < maxCols; i++) {
      const el = table.querySelector(`thead ${columnSelectors[i]}`) || table.querySelector(columnSelectors[i]);
      if (el) next[i] = el.getBoundingClientRect().width;
    }
    widths.value = next;
    applyVars();
  }

  function applyVars() {
    const table = tableRef.value;
    if (!table) return;
    for (let i = 1; i < maxCols; i++) {
      table.style.setProperty(`--sticky-l${i}`, `${offsets.value[i]}px`);
    }
  }

  function attachObserver() {
    detachObserver();
    const table = tableRef.value;
    if (!table) return;
    resizeObs = new ResizeObserver(() => measure());
    resizeObs.observe(table);
    observedEls = [table];
    for (const sel of columnSelectors) {
      const el = table.querySelector(`thead ${sel}`) || table.querySelector(sel);
      if (el) {
        resizeObs.observe(el);
        observedEls.push(el);
      }
    }
  }

  function detachObserver() {
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    observedEls = [];
  }

  // 경계선과 고정열은 표가 아니라 스크롤 영역 왼쪽을 기준으로 그려진다. 표 기준으로 재면
  // 가로로 스크롤한 만큼 어긋나므로, 항상 고정인 첫 열의 위치를 기준점으로 삼는다.
  // (스크롤 중이면 스크롤 영역 왼쪽, 아니면 표 왼쪽 — 둘 다 우리가 원하는 값이다.)
  function originLeft() {
    const table = tableRef.value;
    if (!table) return 0;
    const first = table.querySelector(`thead ${columnSelectors[0]}`) || table.querySelector(columnSelectors[0]);
    return (first || table).getBoundingClientRect().left;
  }

  let dragStart = null;

  function startDrag(event) {
    event.preventDefault();
    const table = tableRef.value;
    if (!table) return;
    dragStart = {
      pointerId: event.pointerId,
      original: stickyCols.value,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
    window.addEventListener("keydown", onDragKey);
  }

  function onDragMove(event) {
    if (!dragStart) return;
    if (!tableRef.value) return;
    const x = event.clientX - originLeft();
    let nearest = 1;
    let best = Infinity;
    for (let i = 1; i <= maxCols; i++) {
      const d = Math.abs(x - offsets.value[i]);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    if (nearest !== stickyCols.value) stickyCols.value = nearest;
  }

  function onDragEnd() {
    cleanupDrag();
  }

  function onDragKey(event) {
    if (event.key === "Escape" && dragStart) {
      stickyCols.value = dragStart.original;
      cleanupDrag();
    }
  }

  function cleanupDrag() {
    dragStart = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    window.removeEventListener("keydown", onDragKey);
  }

  // 고정 폭이 바뀌면(열 너비 변화·경계선 드래그) 스크롤 여백도 같이 따라가야 한다.
  if (scrollerRef) {
    watch(
      [lineX, scrollerRef],
      ([x, el]) => {
        if (el) el.style.scrollPaddingLeft = `${x}px`;
      },
      { immediate: true, flush: "post" },
    );
  }

  watch(
    tableRef,
    async (el) => {
      if (el) {
        await nextTick();
        measure();
        attachObserver();
      } else {
        detachObserver();
      }
    },
    { immediate: true, flush: "post" },
  );

  onBeforeUnmount(() => {
    detachObserver();
    cleanupDrag();
  });

  return {
    stickyCols,
    lineX,
    maxCols,
    startDrag,
    measure,
  };
}
