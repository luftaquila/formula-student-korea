import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const TEAM = 28;

async function findItemContext(page, name) {
  const response = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
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

async function replaceAnswer(page, itemId, value) {
  const current = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/${TEAM}`);
  const data = await current.json();
  const response = await page.request.put("/competition/api/v1/inspection/sheet/answer", {
    data: {
      year: YEAR,
      team_num: TEAM,
      item_id: itemId,
      value,
      expectedValue: data.answers[itemId]?.value || "",
    },
  });
  expect(response.status()).toBe(200);
}

async function replaceMemo(page, itemId, memo) {
  const current = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/${TEAM}`);
  const data = await current.json();
  const response = await page.request.put("/competition/api/v1/inspection/sheet/memo", {
    data: {
      year: YEAR,
      team_num: TEAM,
      item_id: itemId,
      memo,
      expectedMemo: data.answers[itemId]?.memo || "",
    },
  });
  expect(response.status()).toBe(200);
}

test.describe("Inspection answer and memo save reliability", () => {
  test.use({ storageState: storageStatePath("official") });

  test("coalesces rapid PASS/FAIL changes to the final visible value", async ({ page }) => {
    const item = await findItem(page, "전압 확인");
    await replaceAnswer(page, item.id, "");

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
      const response = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/${TEAM}`);
      const data = await response.json();
      return data.answers[item.id]?.value;
    }, { timeout: 10000 }).toBe("PASS");
    await expect(pass).toHaveClass(/btn-success/);
    await expect(fail).not.toHaveClass(/btn-danger/);
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(initialRowHeight);

    await replaceAnswer(page, item.id, "");
  });

  test("shows, edits, and scopes full multiline memos to the active category", async ({ page }) => {
    const item = await findItem(page, "전압 확인");
    const otherCategoryItem = await findItem(page, "용접 상태");
    await replaceMemo(page, item.id, "");
    await replaceMemo(page, otherCategoryItem.id, "다른 카테고리 메모");

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
    const memoSaved = row.locator(".memo-edit-metadata .save-saved").filter({ hasText: "메모 저장됨" });
    await expect(memoSaved).toBeVisible({ timeout: 10000 });
    const [textareaBox, statusBox] = await Promise.all([textarea.boundingBox(), memoSaved.boundingBox()]);
    expect(statusBox.y + statusBox.height <= textareaBox.y || textareaBox.y + textareaBox.height <= statusBox.y).toBe(true);
    await textarea.blur();

    await expect.poll(async () => {
      const response = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/${TEAM}`);
      const data = await response.json();
      return data.answers[item.id]?.memo;
    }, { timeout: 10000 }).toBe("첫째 줄\n둘째 줄");

    const summary = page.locator(".memo-summary");
    await expect(summary.locator(".memo-summary-toggle")).toContainText("메모 1개");
    await expect(row.locator(".memo-text")).toContainText(/첫째 줄\s+둘째 줄/);
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(filledRowHeight);
    await summary.locator(".memo-summary-toggle").click();
    await expect(summary.locator(".memo-summary-preview")).toContainText("첫째 줄");
    await expect(summary.locator(".memo-summary-preview")).not.toContainText("다른 카테고리 메모");

    await page.locator(".tab").filter({ hasText: "샤시 검차" }).click();
    await expect(summary.locator(".memo-summary-toggle")).toContainText("메모 1개");
    await expect(summary.locator(".memo-summary-list")).toHaveCount(0);
    await summary.locator(".memo-summary-toggle").click();
    await expect(summary.locator(".memo-summary-preview")).toContainText("다른 카테고리 메모");
    await expect(summary.locator(".memo-summary-preview")).not.toContainText("첫째 줄");

    await replaceMemo(page, item.id, "");
    await replaceMemo(page, otherCategoryItem.id, "");
  });

  test("retains an optimistic answer after a failed save and retries it", async ({ page }) => {
    const item = await findItem(page, "전압 확인");
    await replaceAnswer(page, item.id, "");

    let failedOnce = false;
    await page.route("**/competition/api/v1/inspection/sheet/answer", async route => {
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
      const response = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/${TEAM}`);
      const data = await response.json();
      return data.answers[item.id]?.value;
    }, { timeout: 10000 }).toBe("PASS");
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(initialRowHeight);

    await replaceAnswer(page, item.id, "");
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
    await replaceAnswer(page, item.id, JSON.stringify({ "99_99": "1" }));
    await page.request.put("/competition/api/v1/inspection/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: category.id, result: "" },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);
    await page.locator(".tab").filter({ hasText: category.name }).click();

    const progress = page.locator(".inspection-progress");
    const progressValue = progress.locator(".inspection-progress-label");
    const initialCompleted = Number(await progressValue.getAttribute("aria-valuenow"));
    const statusItem = progress.locator(`.status-map-item[aria-label*="${item.name}"]`);
    await expect(statusItem).toHaveClass(/status-unanswered/);
    const missingSummary = page.locator(".missing-summary");
    await expect(missingSummary).toBeVisible();
    await missingSummary.locator(".missing-summary-toggle").click();
    const missingItem = missingSummary.locator(".missing-summary-item").filter({ hasText: item.name });
    await expect(missingItem).toBeVisible();

    const row = page.locator(".item-row").filter({ hasText: item.name });
    const cells = row.locator('.checktable-cell input[type="checkbox"]');
    expect(await cells.count()).toBeGreaterThan(1);
    await cells.first().check();
    await expect.poll(async () => Number(await progressValue.getAttribute("aria-valuenow"))).toBe(initialCompleted + 1);
    await expect(statusItem).toHaveClass(/status-answered/);
    await expect(missingItem).toHaveCount(0);

    await cells.nth(1).check();
    await expect.poll(async () => Number(await progressValue.getAttribute("aria-valuenow"))).toBe(initialCompleted + 1);

    await replaceAnswer(page, item.id, "");
    await page.request.put("/competition/api/v1/inspection/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: category.id, result: "" },
    });
  });

  test("shows a sticky status map for FAIL and unanswered items above memo summaries", async ({ page }) => {
    const { item, category } = await findItemContext(page, "전압 확인");
    await replaceAnswer(page, item.id, "FAIL");
    await replaceMemo(page, item.id, "상단 순서 확인");
    await page.request.put("/competition/api/v1/inspection/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: category.id, result: "" },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);

    const progress = page.locator(".inspection-progress");
    const progressValue = progress.locator(".inspection-progress-label");
    await expect(progress).toBeVisible();
    await expect(progress.locator('.status-map-item[aria-label*="전압 확인"]')).toHaveClass(/status-fail/);
    await expect(progress.locator(".status-map-item.status-unanswered").first()).toBeVisible();
    const failedSummary = page.locator(".failed-summary");
    await expect(failedSummary).toBeVisible();
    await expect(page.locator(".missing-summary")).toBeVisible();
    await failedSummary.locator(".failed-summary-toggle").click();
    await expect(failedSummary.locator(".failed-summary-item").filter({ hasText: item.name })).toBeVisible();
    await expect(page.locator(".memo-summary")).toBeVisible();
    const progressBox = await progress.boundingBox();
    const memoBox = await page.locator(".memo-summary").boundingBox();
    expect(progressBox.y + progressBox.height).toBeLessThanOrEqual(memoBox.y);
    expect(Number(await progressValue.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(Number(await progressValue.getAttribute("aria-valuemax"))).toBeGreaterThan(
      Number(await progressValue.getAttribute("aria-valuenow")),
    );

    const progressStyles = await progress.evaluate(element => {
      const failItem = element.querySelector(".status-map-item.status-fail");
      const failButton = document.querySelector(".item-row .pf-toggle .btn-danger");
      return {
        position: getComputedStyle(element).position,
        top: getComputedStyle(element).top,
        failColor: getComputedStyle(failItem).backgroundColor,
        failButtonColor: getComputedStyle(failButton).backgroundColor,
      };
    });
    expect(progressStyles.position).toBe("sticky");
    expect(progressStyles.top).toBe("0px");
    expect(progressStyles.failColor).toBe(progressStyles.failButtonColor);
    expect(await page.locator(".memo-summary").evaluate(
      element => getComputedStyle(element).position !== "sticky",
    )).toBe(true);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(async () => Math.round(await progress.evaluate(
      element => element.getBoundingClientRect().top,
    ))).toBe(0);

    await replaceAnswer(page, item.id, "");
    await replaceMemo(page, item.id, "");
    await page.request.put("/competition/api/v1/inspection/sheet/category-result", {
      data: { year: YEAR, team_num: TEAM, category_id: category.id, result: "" },
    });
  });
});
