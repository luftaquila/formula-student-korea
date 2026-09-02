import { watch, onUpdated, onBeforeUnmount, nextTick } from "vue";

/**
 * Keep a table header at the top of the page without turning its horizontal
 * scroller into a nested vertical scroll container.
 */
export function useTableHeadBand({ tableRef, scrollerRef, bandRef }) {
  let resizeObs = null;
  let clone = null;
  let frame = 0;
  let signature = null;
  let widthRow = null;

  function build() {
    const table = tableRef.value;
    const band = bandRef.value;
    const head = table?.tHead;
    if (!head || !band) return;

    if (clone && head.innerHTML === signature) return measure();
    signature = head.innerHTML;
    widthRow = null;

    // Preserve the original classes and scoped-style attributes so the pinned
    // header is rendered exactly like the source header.
    clone = table.cloneNode(false);
    clone.dataset.tableHeadCopy = "";
    clone.setAttribute("aria-hidden", "true");
    clone.appendChild(head.cloneNode(true));
    band.replaceChildren(clone);
    observeLayout();
    measure();
  }

  function observeLayout() {
    const table = tableRef.value;
    if (!resizeObs || !table) return;
    resizeObs.disconnect();
    resizeObs.observe(table);
    for (const cell of table.tHead?.rows[0]?.cells ?? []) resizeObs.observe(cell);
  }

  function measure() {
    const table = tableRef.value;
    const band = bandRef.value;
    if (!table || !band || !clone) return;

    const source = widestRow(table);
    const sourceCells = source ? visibleCells(source) : [];
    if (sourceCells.length === 0) {
      clone.querySelector("colgroup")?.remove();
      clone.style.tableLayout = "";
      return sizeBand();
    }
    clone.style.tableLayout = "fixed";

    const cols = clone.querySelector("colgroup")
      ?? clone.insertBefore(document.createElement("colgroup"), clone.firstChild);
    while (cols.children.length > sourceCells.length) cols.lastElementChild.remove();
    while (cols.children.length < sourceCells.length) cols.appendChild(document.createElement("col"));
    for (let index = 0; index < sourceCells.length; index += 1) {
      cols.children[index].style.width = `${sourceCells[index].getBoundingClientRect().width}px`;
    }
    sizeBand();
  }

  function sizeBand() {
    const table = tableRef.value;
    const band = bandRef.value;
    if (!table || !band || !clone) return;

    const tableWidth = table.getBoundingClientRect().width;
    // The responsive team-table contract uses !important while shrinking the
    // source table to its intrinsic content width. Keep the detached header
    // copy on the exact measured width with the same priority so its colgroup
    // remains aligned with the source columns.
    clone.style.setProperty("width", `${tableWidth}px`, "important");
    clone.style.setProperty("min-width", `${tableWidth}px`, "important");
    clone.style.setProperty("max-width", `${tableWidth}px`, "important");
    const height = table.tHead.getBoundingClientRect().height;
    const firstColumnWidth = table.tHead.rows[0]?.cells[0]?.getBoundingClientRect().width || 0;
    band.style.height = `${height}px`;
    band.style.marginBottom = `${-height}px`;
    if (scrollerRef.value) scrollerRef.value.style.scrollPaddingInlineStart = `${firstColumnWidth}px`;
    document.documentElement.style.scrollPaddingTop = `${height}px`;
    syncX();
    syncPointerEvents();
  }

  function syncX() {
    const band = bandRef.value;
    const scroller = scrollerRef.value;
    if (!band || !scroller) return;
    const sourceMax = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const bandMax = Math.max(0, band.scrollWidth - band.clientWidth);
    band.scrollLeft = sourceMax > 0 ? (scroller.scrollLeft / sourceMax) * bandMax : 0;
  }

  function syncPointerEvents() {
    const head = tableRef.value?.tHead;
    const band = bandRef.value;
    if (!head || !band) return;
    const sourceTop = head.getBoundingClientRect().top;
    const bandTop = band.getBoundingClientRect().top;
    // At the table's original position, let events reach the real Vue header.
    // Once it scrolls away, the pinned copy becomes the interactive surface.
    band.style.pointerEvents = sourceTop < bandTop - 0.5 ? "auto" : "none";
  }

  function widestRow(table) {
    if (widthRow?.isConnected) return widthRow;
    let best = null;
    for (const body of table.tBodies) {
      for (const row of body.rows) {
        if (row.cells.length > (best?.cells.length ?? 0) && !hasSpan(row)) best = row;
      }
    }
    widthRow = best;
    return best;
  }

  function hasSpan(row) {
    for (const cell of row.cells) if (cell.colSpan > 1 || cell.rowSpan > 1) return true;
    return false;
  }

  function visibleCells(row) {
    return Array.from(row.cells).filter((cell) => getComputedStyle(cell).display !== "none");
  }

  // The clone has no Vue listeners. Forward sortable header clicks to the
  // matching source cell while the pinned copy is visible.
  function forwardClick(event) {
    const cell = event.target.closest("th");
    const row = cell?.closest("tr");
    if (!cell || !row) return;
    const rowIndex = Array.prototype.indexOf.call(clone.tHead.rows, row);
    const sourceCell = tableRef.value?.tHead?.rows[rowIndex]?.cells[cell.cellIndex];
    if (!sourceCell) return;

    const interactiveSelector = "a, button, input, select, [role='button']";
    const interactive = event.target.closest(interactiveSelector);
    if (interactive && cell.contains(interactive)) {
      event.preventDefault();
      const cloneControls = Array.from(cell.querySelectorAll(interactiveSelector));
      const sourceControls = Array.from(sourceCell.querySelectorAll(interactiveSelector));
      sourceControls[cloneControls.indexOf(interactive)]?.click();
      return;
    }
    sourceCell.click();
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      build();
    });
  }

  function rebuildForViewport() {
    signature = null;
    schedule();
  }

  function attach(table) {
    detach();
    if (!table) return;
    resizeObs = new ResizeObserver(measure);
    build();
    scrollerRef.value?.addEventListener("scroll", syncX, { passive: true });
    bandRef.value?.addEventListener("click", forwardClick);
    window.addEventListener("resize", rebuildForViewport);
    window.addEventListener("scroll", syncPointerEvents, { passive: true });
  }

  function detach() {
    scrollerRef.value?.removeEventListener("scroll", syncX);
    bandRef.value?.removeEventListener("click", forwardClick);
    window.removeEventListener("resize", rebuildForViewport);
    window.removeEventListener("scroll", syncPointerEvents);
    resizeObs?.disconnect();
    resizeObs = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    document.documentElement.style.scrollPaddingTop = "";
    if (bandRef.value) bandRef.value.style.pointerEvents = "";
    if (scrollerRef.value) scrollerRef.value.style.scrollPaddingInlineStart = "";
    clone = null;
    signature = null;
    widthRow = null;
  }

  watch(
    tableRef,
    async (element) => {
      await nextTick();
      attach(element);
    },
    { immediate: true, flush: "post" },
  );

  onUpdated(schedule);
  onBeforeUnmount(detach);
}
