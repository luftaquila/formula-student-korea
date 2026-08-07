import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// 고정열 경계선은 shared/useStickyColumns.js 에 있고 5개 서비스 8개 화면이 함께 쓴다.
// 포인터를 표가 아니라 스크롤 영역 왼쪽 기준으로 매핑한다는 계약을 score 밖에서도 잠가둔다.
test.describe("Entry table frozen columns", () => {
  test.use({ storageState: storageStatePath("admin") });

  const COLUMNS = [".col-num", ".col-univ", ".col-team", ".col-type"];

  test.beforeEach(async ({ page }) => {
    // 이 회귀는 표가 가로로 밀려 있을 때만 나타나므로 넘치도록 좁힌다
    await page.setViewportSize({ width: 360, height: 900 });
    await page.addInitScript(() => localStorage.setItem("entry-sticky-cols", "1"));
    await page.goto("/entry");
    await waitForPageReady(page);
    await expect(page.locator(".entry-table")).toBeVisible();
    await page.locator(".sticky-host").scrollIntoViewIfNeeded();
  });

  test("dragging the freeze line lands on the column under the pointer even when the table is scrolled sideways", async ({ page }) => {
    const geometry = (columns) => page.evaluate((selectors) => {
      const host = document.querySelector(".sticky-host");
      const wrapper = host.querySelector(".table-wrapper");
      const table = host.querySelector(".entry-table");
      const head = table.tHead.rows[0];
      // 고정열 후보의 누적 폭. 경계선도 고정열도 스크롤 영역 왼쪽에서 이 값만큼 떨어져 놓인다.
      const bounds = [0];
      for (const sel of selectors) {
        bounds.push(bounds[bounds.length - 1] + head.querySelector(sel).getBoundingClientRect().width);
      }
      return {
        hostLeft: host.getBoundingClientRect().left,
        maxScroll: wrapper.scrollWidth - wrapper.clientWidth,
        scrollLeft: wrapper.scrollLeft,
        stickyCols: table.getAttribute("data-sticky-cols"),
        univRight: head.querySelector(".col-univ").getBoundingClientRect().right,
        bounds,
      };
    }, columns);

    const before = await geometry(COLUMNS);
    expect(before.stickyCols).toBe("1");

    // 표 기준으로 재면 포인터가 스크롤한 만큼 오른쪽으로 밀려 읽힌다. 그 오차가 학교와 팀명
    // 사이 경계의 중간을 넘어야 다른 열이 잡히므로, 그만큼은 밀 수 있어야 회귀를 잡아낸다.
    const half = (before.bounds[3] - before.bounds[2]) / 2;
    const shift = Math.min(before.maxScroll, before.bounds[3] - before.bounds[2]);
    expect(shift).toBeGreaterThan(half);

    await page.evaluate((x) => {
      document.querySelector(".sticky-host .table-wrapper").scrollLeft = x;
    }, shift);
    const scrolled = await geometry(COLUMNS);
    expect(scrolled.scrollLeft).toBeGreaterThan(half);

    // 학교 열 오른쪽 경계로 끌어 고정열을 2개로 만든다
    const dropX = before.hostLeft + before.bounds[2];
    expect(dropX).toBeLessThan(page.viewportSize().width - 10);

    const line = await page.locator(".sticky-freeze-line").boundingBox();
    const grabY = Math.min(line.y + 40, page.viewportSize().height - 10);
    expect(grabY).toBeGreaterThan(line.y);

    await page.mouse.move(line.x + line.width / 2, grabY);
    await page.mouse.down();
    await page.mouse.move(dropX, grabY, { steps: 8 });
    await page.mouse.up();

    // 스크롤 오프셋만큼 밀려 읽혔다면 팀명이나 유형까지 함께 고정된다
    await expect.poll(async () => (await geometry(COLUMNS)).stickyCols).toBe("2");

    // 그리고 고정 경계는 포인터를 놓은 자리에 맞아야 한다
    const after = await geometry(COLUMNS);
    expect(Math.abs(after.univRight - dropX)).toBeLessThanOrEqual(2);
  });
});
