import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Traffic scoreboard", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed a scoreboard-visible record before tests
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    await page.request.post("/traffic/api/records", {
      data: {
        name: "E2E-Scoreboard",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: { num: 1, univ: "서울대학교", team: "SNU Racing" },
          result: 4567,
          detail: "scoreboard test",
        },
      },
    });

    await context.close();
  });

  test("renders scoreboard page with file selector", async ({ page }) => {
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    // Verify scoreboard page loads
    const scoreboardPage = page.locator(".scoreboard-page");
    await expect(scoreboardPage).toBeVisible();

    // Verify file selector exists
    const fileSelect = page.locator(".form-select");
    await expect(fileSelect).toBeVisible();
  });

  test("displays scoreboard data when a file is selected", async ({ page }) => {
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    // Select the seeded record file
    const fileSelect = page.locator(".form-select").first();
    await fileSelect.selectOption(`FSK ${YEAR} E2E-Scoreboard`);

    // Wait for scoreboard to render
    const scoreboard = page.locator(".scoreboard");
    await expect(scoreboard).toBeVisible({ timeout: 5000 });

    // Verify header is present
    await expect(scoreboard).toContainText("FSK Race Control");

    // Verify LIVE indicator is present
    await expect(scoreboard).toContainText("LIVE");
  });

  test("shows empty state when no records", async ({ page }) => {
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    // Without selecting a file, the display should show empty state
    const emptyState = page.locator(".empty-state");
    await expect(emptyState).toBeVisible();
  });

  // Clean up
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/traffic/api/records/FSK ${YEAR} E2E-Scoreboard`);
    await context.close();
  });
});
