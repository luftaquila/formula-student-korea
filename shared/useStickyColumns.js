import { ref, computed, watch, onBeforeUnmount, nextTick } from "vue";

export function useStickyColumns({ storageKey, tableRef, columnSelectors, defaultCols = 1 }) {
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

  let dragStart = null;

  function startDrag(event) {
    event.preventDefault();
    const table = tableRef.value;
    if (!table) return;
    const tableRect = table.getBoundingClientRect();
    dragStart = {
      pointerId: event.pointerId,
      original: stickyCols.value,
      tableLeft: tableRect.left,
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
    const table = tableRef.value;
    if (!table) return;
    const tableLeft = table.getBoundingClientRect().left;
    const x = event.clientX - tableLeft;
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
