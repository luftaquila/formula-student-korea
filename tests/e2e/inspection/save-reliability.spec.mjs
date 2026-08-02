import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const TEAM = 28;

async function findItem(page, name) {
  const response = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
  const template = await response.json();
  for (const category of template) {
    for (const subcategory of category.subcategories || []) {
      for (const group of subcategory.groups || []) {
        const item = (group.items || []).find(candidate => candidate.name === name);
        if (item) return item;
      }
    }
  }
  throw new Error(`Inspection item not found: ${name}`);
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

    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "" },
    });
  });

  test("keeps multiline memo input and exposes it in the team sheet memo index", async ({ page }) => {
    const item = await findItem(page, "전압 확인");
    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, memo: "" },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/inspection/${YEAR}/${TEAM}`);
    await waitForPageReady(page);
    const row = page.locator(".item-row").filter({ hasText: "전압 확인" });
    await row.locator(".memo-text").click();

    const textarea = row.locator("textarea.memo-input");
    await expect(textarea).toBeVisible();
    await textarea.fill("첫째 줄\n둘째 줄");
    await textarea.blur();

    await expect.poll(async () => {
      const response = await page.request.get(`/inspection/api/sheet/data/${YEAR}/${TEAM}`);
      const data = await response.json();
      return data.answers[item.id]?.memo;
    }, { timeout: 10000 }).toBe("첫째 줄\n둘째 줄");

    const summary = page.locator(".memo-summary");
    await expect(summary.locator(".memo-summary-toggle")).toContainText("메모 있는 항목 1개");
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
    const pass = row.locator(".pf-toggle button").first();
    await pass.click();

    await expect(pass).toHaveClass(/btn-success/);
    await expect(row.locator(".save-error")).toContainText("응답 저장 실패");
    await row.locator(".save-error button").click();

    await expect.poll(async () => {
      const response = await page.request.get(`/inspection/api/sheet/data/${YEAR}/${TEAM}`);
      const data = await response.json();
      return data.answers[item.id]?.value;
    }, { timeout: 10000 }).toBe("PASS");

    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: TEAM, item_id: item.id, value: "" },
    });
  });
});
