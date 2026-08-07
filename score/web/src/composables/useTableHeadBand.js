import { watch, onUpdated, onBeforeUnmount, nextTick } from "vue";

/**
 * 페이지를 스크롤해도 표 헤더가 화면 상단에 남아 있게 한다.
 *
 * thead에 sticky를 걸면 가로 스크롤 래퍼가 기준이 되어 동작하지 않는다. 그래서 헤더
 * 사본을 래퍼 밖 sticky 밴드에 띄운다. 세로는 브라우저가 잡고 JS는 레이아웃이 바뀔 때
 * 크기만 맞추지만, 가로는 밴드가 별도 스크롤 컨테이너라 scrollLeft를 따라 써야 해서
 * 빠르게 밀면 한 프레임 늦는다.
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

    // 헤더와 무관한 리렌더(SSE·검색어·hover)에서는 너비만 맞춘다.
    if (clone && head.innerHTML === signature) return measure();
    signature = head.innerHTML;
    widthRow = null;

    // 껍데기를 복제해야 스코프 스타일 속성과 --sticky-l* 인라인 변수가 따라온다.
    clone = table.cloneNode(false);
    clone.setAttribute("aria-hidden", "true");
    clone.appendChild(head.cloneNode(true));
    band.replaceChildren(clone);
    observeLayout();
    measure();
  }

  // 표 폭이 그대로여도 열 사이에서 너비가 재분배될 수 있다. 열이 갈리면 다시 건다.
  function observeLayout() {
    const table = tableRef.value;
    if (!resizeObs || !table) return;
    resizeObs.disconnect();
    resizeObs.observe(table);
    for (const cell of table.tHead?.rows[0]?.cells ?? []) resizeObs.observe(cell);
  }

  // 열 너비는 원본이 정하고 사본은 colgroup 으로 받아쓴다. 헤더가 여러 행이거나
  // colspan 을 쓰면(내구 입력) 헤더 셀과 열이 1:1이 아니라서 본문 행에서 재야 한다.
  function measure() {
    const table = tableRef.value;
    const band = bandRef.value;
    if (!table || !band || !clone) return;

    const source = widestRow(table);
    if (!source) {
      // 본문 행이 없으면 원본도 헤더만으로 열을 잡으므로 사본도 같은 방식에 맡긴다.
      clone.querySelector("colgroup")?.remove();
      clone.style.tableLayout = "";
      return sizeBand();
    }
    clone.style.tableLayout = "fixed";

    const cols = clone.querySelector("colgroup") ?? clone.insertBefore(document.createElement("colgroup"), clone.firstChild);
    while (cols.children.length > source.cells.length) cols.lastElementChild.remove();
    while (cols.children.length < source.cells.length) cols.appendChild(document.createElement("col"));
    for (let i = 0; i < source.cells.length; i++) {
      cols.children[i].style.width = `${source.cells[i].getBoundingClientRect().width}px`;
    }
    sizeBand();
  }

  function sizeBand() {
    const table = tableRef.value;
    const band = bandRef.value;
    if (!table || !band || !clone) return;

    mirrorStickyState(table);
    clone.style.width = `${table.getBoundingClientRect().width}px`;

    // 헤더 높이만큼 자리를 잡고 음수 마진으로 돌려준다. 차지하는 공간은 0이지만
    // sticky가 표 아래로 빠져나가지 않게 잡아준다.
    const height = table.tHead.getBoundingClientRect().height;
    band.style.height = `${height}px`;
    band.style.marginBottom = `${-height}px`;
    // 방향키로 셀을 옮길 때 대상이 고정 헤더 뒤로 들어가지 않게. 스크롤 컨테이너가 문서라
    // 여기만 가능하고, 그래서 한 문서에 밴드가 하나뿐이라고 전제한다.
    document.documentElement.style.scrollPaddingTop = `${height}px`;
    syncX();
  }

  // 고정열 상태는 헤더가 아니라 table 자체(data-sticky-cols, --sticky-l*)에 있어서
  // 사본을 다시 만들지 않는 경로에서도 따로 옮겨줘야 한다.
  function mirrorStickyState(table) {
    const cols = table.getAttribute("data-sticky-cols");
    if (cols === null) clone.removeAttribute("data-sticky-cols");
    else clone.setAttribute("data-sticky-cols", cols);
    for (const name of table.style) {
      if (name.startsWith("--")) clone.style.setProperty(name, table.style.getPropertyValue(name));
    }
  }

  // 밴드도 스크롤 컨테이너라 scrollLeft만 맞추면 열 고정이 그대로 산다.
  function syncX() {
    if (bandRef.value && scrollerRef.value) bandRef.value.scrollLeft = scrollerRef.value.scrollLeft;
  }

  // 병합 없이 한 줄에 열이 다 있는 본문 행. 열 너비의 기준이 된다.
  // measure() 는 ResizeObserver 콜백이기도 해서 매번 전체 행을 훑지 않도록 잡아둔다.
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

  // 사본엔 Vue 핸들러가 없어 클릭을 같은 자리의 원본 셀로 넘긴다(정렬).
  function forwardClick(event) {
    const cell = event.target.closest("th");
    const row = cell?.closest("tr");
    if (!cell || !row) return;
    const rowIndex = Array.prototype.indexOf.call(clone.tHead.rows, row);
    tableRef.value?.tHead?.rows[rowIndex]?.cells[cell.cellIndex]?.click();
  }

  function schedule() {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        build();
      });
    }
  }

  function attach(table) {
    detach();
    if (!table) return;
    resizeObs = new ResizeObserver(measure);
    build();
    scrollerRef.value?.addEventListener("scroll", syncX, { passive: true });
    bandRef.value?.addEventListener("click", forwardClick);
    window.addEventListener("resize", measure);
  }

  function detach() {
    scrollerRef.value?.removeEventListener("scroll", syncX);
    bandRef.value?.removeEventListener("click", forwardClick);
    window.removeEventListener("resize", measure);
    resizeObs?.disconnect();
    resizeObs = null;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    document.documentElement.style.scrollPaddingTop = "";
    clone = null;
    signature = null;
    widthRow = null;
  }

  // 표는 로딩이 끝난 뒤에야 나타나므로 ref가 채워지는 시점에 붙인다.
  watch(
    tableRef,
    async (el) => {
      await nextTick();
      attach(el);
    },
    { immediate: true, flush: "post" },
  );

  onUpdated(schedule);

  onBeforeUnmount(detach);
}
