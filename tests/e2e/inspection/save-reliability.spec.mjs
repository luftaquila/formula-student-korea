import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const TEAM = 28;

async function findItemContext(page, name) {
  const response = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
  const template = await response.json();
  for (const category of template) {
    for (const subcategory of category.subcategories || []) {
      for (const group of subcategory.groups || []) {
        const item = (group.items || []).find(candidate => candidate.name === name);
        if (item) return { item, category };
      }
    }
  }
  throw new Error(`Inspection item not found: ${name}`);
}

async function findItem(page, name) {
  return (await findItemContext(page, name)).item;
}

test.describe("Inspection answer and memo save reliability", () => {
  test.use({ storageState: storageStatePath("official") });

  test("coalesces rapid PASS/FAIL changes to the final visible value", async ({ page }) => {
    const item = await findItem(page, "전압 확인");
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "" },
    });

    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);
    const row = page.locator(".item-row").filter({ hasText: "전압 확인" });
    const initialRowHeight = await row.evaluate(element => element.getBoundingClientRect().height);
    const pass = row.locator(".pf-toggle button").first();
    const fail = row.locator(".pf-toggle button").nth(1);

    await pass.click();
    await fail.click();
    await pass.click();

    await expect.poll(async () => {
      const response = await page.request.get(`/inspection/api/sheet/data/${YEAR}/${TEAM}`);
      const data = await response.json();
      return data.answers[item.id]?.value;
    }, { timeout: 10000 }).toBe("PASS");
    await expect(pass).toHaveClass(/btn-success/);
    await expect(fail).not.toHaveClass(/btn-danger/);
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(initialRowHeight);

    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "" },
    });
  });

  test("shows and edits the full multiline memo without overlapping save state", async ({ page }) => {
    const item = await findItem(page, "전압 확인");
    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, memo: "" },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);
    const row = page.locator(".item-row").filter({ hasText: "전압 확인" });
    const initialRowHeight = await row.evaluate(element => element.getBoundingClientRect().height);
    await row.locator(".memo-text").click();

    const textarea = row.locator("textarea.memo-input");
    await expect(textarea).toBeVisible();
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(initialRowHeight);
    await textarea.fill("첫째 줄\n둘째 줄");
    const filledRowHeight = await row.evaluate(element => element.getBoundingClientRect().height);
    expect(filledRowHeight).toBeGreaterThan(initialRowHeight);
    const memoSaved = row.locator(".save-saved").filter({ hasText: "메모 저장됨" });
    await expect(memoSaved).toBeVisible({ timeout: 10000 });
    const [textareaBox, statusBox] = await Promise.all([textarea.boundingBox(), memoSaved.boundingBox()]);
    expect(statusBox.y + statusBox.height <= textareaBox.y || textareaBox.y + textareaBox.height <= statusBox.y).toBe(true);
    await textarea.blur();

    await expect.poll(async () => {
      const response = await page.request.get(`/inspection/api/sheet/data/${YEAR}/${TEAM}`);
      const data = await response.json();
      return data.answers[item.id]?.memo;
    }, { timeout: 10000 }).toBe("첫째 줄\n둘째 줄");

    const summary = page.locator(".memo-summary");
    await expect(summary.locator(".memo-summary-toggle")).toContainText("메모 1개");
    await expect(row.locator(".memo-text")).toContainText(/첫째 줄\s+둘째 줄/);
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(filledRowHeight);
    await summary.locator(".memo-summary-toggle").click();
    await expect(summary.locator(".memo-summary-preview")).toContainText("첫째 줄");

    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, memo: "" },
    });
  });

  test("retains an optimistic answer after a failed save and retries it", async ({ page }) => {
    const item = await findItem(page, "전압 확인");
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "" },
    });

    let failedOnce = false;
    await page.route("**/inspection/api/sheet/answer", async route => {
      if (!failedOnce && route.request().method() === "PUT") {
        failedOnce = true;
        await route.fulfill({ status: 503, body: "temporary failure" });
        return;
      }
      await route.continue();
    });

    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);
    const row = page.locator(".item-row").filter({ hasText: "전압 확인" });
    const initialRowHeight = await row.evaluate(element => element.getBoundingClientRect().height);
    const pass = row.locator(".pf-toggle button").first();
    await pass.click();

    await expect(pass).toHaveClass(/btn-success/);
    await expect(row.locator(".save-error")).toContainText("응답 저장 실패");
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(initialRowHeight);
    await row.locator(".save-error button").click();

    await expect.poll(async () => {
      const response = await page.request.get(`/inspection/api/sheet/data/${YEAR}/${TEAM}`);
      const data = await response.json();
      return data.answers[item.id]?.value;
    }, { timeout: 10000 }).toBe("PASS");
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(initialRowHeight);

    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "" },
    });
  });

  test("keeps item text, check tables, and memo controls at full width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);
    await page.locator(".tab").filter({ hasText: "샤시 검차" }).click();

    const row = page.locator(".item-row").filter({ hasText: "점검 체크리스트" });
    await expect(row).toBeVisible();
    const widths = await row.evaluate(element => {
      const content = element.querySelector(".item-content").getBoundingClientRect().width;
      return {
        content,
        heading: element.querySelector(".item-heading").getBoundingClientRect().width,
        checktable: element.querySelector(".checktable-wrapper").getBoundingClientRect().width,
        memo: element.querySelector(".memo-area").getBoundingClientRect().width,
      };
    });

    expect(Math.abs(widths.heading - widths.content)).toBeLessThanOrEqual(1);
    expect(Math.abs(widths.checktable - widths.content)).toBeLessThanOrEqual(1);
    expect(Math.abs(widths.memo - widths.content)).toBeLessThanOrEqual(1);
  });

  test("counts a check table once using only currently configured cells", async ({ page }) => {
    const { item, category } = await findItemContext(page, "점검 체크리스트");
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: JSON.stringify({ "99_99": "1" }) },
    });
    await page.request.put("/inspection/api/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: category.id, result: "PASS" },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);
    await page.locator(".tab").filter({ hasText: category.name }).click();

    const progress = page.locator(".inspection-progress");
    const initialCompleted = Number(await progress.getAttribute("aria-valuenow"));
    await page.locator(".missing-toggle").click();
    const missingItem = page.locator(".missing-item").filter({ hasText: item.name });
    await expect(missingItem).toHaveCount(1);

    const row = page.locator(".item-row").filter({ hasText: item.name });
    const cells = row.locator('.checktable-cell input[type="checkbox"]');
    expect(await cells.count()).toBeGreaterThan(1);
    await cells.first().check();
    await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBe(initialCompleted + 1);
    await expect(missingItem).toHaveCount(0);

    await cells.nth(1).check();
    await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBe(initialCompleted + 1);

    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "" },
    });
    await page.request.put("/inspection/api/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: category.id, result: "" },
    });
  });

  test("shows progress above FAIL, unanswered, and memo summaries in that order", async ({ page }) => {
    const { item, category } = await findItemContext(page, "전압 확인");
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "FAIL" },
    });
    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, memo: "상단 순서 확인" },
    });
    await page.request.put("/inspection/api/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: category.id, result: "PASS" },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);

    const progress = page.locator(".inspection-progress");
    await expect(progress).toBeVisible();
    await expect(page.locator(".failed-banner")).toBeVisible();
    await expect(page.locator(".missing-banner")).toBeVisible();
    await expect(page.locator(".memo-summary")).toBeVisible();
    const blockOrder = await page.locator(
      ".inspection-progress, .failed-banner, .missing-banner, .memo-summary",
    ).evaluateAll(elements => elements.map(element => element.classList[0]));
    expect(blockOrder.slice(0, 4)).toEqual([
      "inspection-progress",
      "failed-banner",
      "missing-banner",
      "memo-summary",
    ]);
    expect(Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(Number(await progress.getAttribute("aria-valuemax"))).toBeGreaterThan(
      Number(await progress.getAttribute("aria-valuenow")),
    );

    const progressStyles = await progress.evaluate(element => {
      const fill = element.querySelector(".inspection-progress-fill");
      const passButton = document.querySelector(".btn-success");
      return {
        position: getComputedStyle(element).position,
        top: getComputedStyle(element).top,
        paddingTop: getComputedStyle(element).paddingTop,
        paddingBottom: getComputedStyle(element).paddingBottom,
        fillColor: getComputedStyle(fill).backgroundColor,
        passColor: getComputedStyle(passButton).backgroundColor,
      };
    });
    expect(progressStyles.position).toBe("sticky");
    expect(progressStyles.top).toBe("0px");
    expect(progressStyles.paddingTop).toBe("8px");
    expect(progressStyles.paddingBottom).toBe("8px");
    expect(progressStyles.fillColor).toBe(progressStyles.passColor);
    expect(await page.locator(".failed-banner, .missing-banner, .memo-summary").evaluateAll(
      elements => elements.every(element => getComputedStyle(element).position !== "sticky"),
    )).toBe(true);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(async () => Math.round(await progress.evaluate(
      element => element.getBoundingClientRect().top,
    ))).toBe(0);

    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "" },
    });
    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, memo: "" },
    });
    await page.request.put("/inspection/api/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: category.id, result: "" },
    });
  });
});
