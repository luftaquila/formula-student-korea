import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { trafficEntry } from "../helpers/traffic.mjs";

const YEAR = currentCompetitionYear();

test.describe("Traffic scoreboard", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed a scoreboard-visible record before tests
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    await page.request.post("/competition/api/v1/traffic/records", {
      data: {
        name: "E2E-Scoreboard",
        data: {
          time: new Date().toISOString(),
          type: "가속",
          entry: await trafficEntry(1),
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
    const fileSelect = page.getByLabel("기록 파일");
    await expect(fileSelect).toBeVisible();
  });

  test("keeps the display at 16:9 across viewport sizes and fullscreen layout", async ({ page }) => {
    const display = page.locator(".display-area");
    const aspectRatioError = () => display.evaluate((element) => {
      const { width, height } = element.getBoundingClientRect();
      return Math.abs((width / height) - (16 / 9));
    });

    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    await expect.poll(aspectRatioError).toBeLessThan(0.01);

    await page.setViewportSize({ width: 700, height: 1000 });
    await expect.poll(aspectRatioError).toBeLessThan(0.01);

    await page.getByTitle("전체화면").click();
    await expect.poll(() => page.evaluate(() => (
      document.fullscreenElement?.classList.contains("display-wrapper") || false
    ))).toBe(true);
    await expect.poll(aspectRatioError).toBeLessThan(0.01);
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

    const current = page.getByTestId("current-record-가속");
    const best = page.getByTestId("best-record-가속");
    await expect(current).toBeVisible();
    await expect(best).toBeVisible();
    await expect(current).toContainText("No. 01");
    await expect(current).toContainText("서울대학교");
    await expect(current).toContainText("SNU Racing");
    await expect(current).toContainText("4.567");

    await expect.poll(() => current.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(0, 0, 0)");
    await expect.poll(() => best.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(0, 0, 0)");

    const headerSpacingDifference = await scoreboard.evaluate((element) => {
      const scoreboardBox = element.getBoundingClientRect();
      const headerBox = element.querySelector(":scope > .header").getBoundingClientRect();
      const panelsBox = element.querySelector(":scope > .panels").getBoundingClientRect();
      const topGap = headerBox.top - scoreboardBox.top;
      const bottomGap = panelsBox.top - headerBox.bottom;
      return Math.abs(topGap - bottomGap);
    });
    expect(headerSpacingDifference).toBeLessThan(1);
  });

  test("customizes and persists the scoreboard theme, event colors, and visibility", async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("scoreboard-settings-cleared")) {
        localStorage.removeItem("traffic-scoreboard-theme");
        localStorage.removeItem("traffic-scoreboard-colors");
        localStorage.removeItem("traffic-scoreboard-visibility");
        localStorage.removeItem("traffic-scoreboard-labels");
        sessionStorage.setItem("scoreboard-settings-cleared", "true");
      }
    });
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    await page.locator(".form-select").first().selectOption(`FSK ${YEAR} E2E-Scoreboard`);

    const themeButton = page.getByTestId("scoreboard-theme");
    const accelerationColor = page.getByTestId("scoreboard-color-가속");
    const accelerationVisibility = page.getByTestId("scoreboard-visible-가속");
    const accelerationLabel = page.getByLabel("가속 경기 표시명");

    await expect(themeButton).toHaveAttribute("data-theme", "dark");
    await expect(accelerationColor).toHaveValue("#ffd000");
    await expect(page.getByTestId("scoreboard-color-스키드패드")).toHaveValue("#00e5ff");
    await expect(page.getByTestId("scoreboard-color-오토크로스")).toHaveValue("#ff6b6b");
    await expect(accelerationVisibility).toBeChecked();
    await expect(page.getByTestId("scoreboard-visible-스키드패드")).toBeChecked();
    await expect(page.getByTestId("scoreboard-visible-오토크로스")).toBeChecked();
    await expect(accelerationLabel).toHaveValue("ACCELERATION");

    await themeButton.click();
    await expect(themeButton).toHaveAttribute("data-theme", "light");
    await expect(page.locator(".display-area")).toHaveAttribute("data-scoreboard-theme", "light");

    await accelerationColor.evaluate((input) => {
      input.value = "#345678";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect.poll(() => page.locator(".panel").first().evaluate((panel) => (
      getComputedStyle(panel).getPropertyValue("--panel-color").trim()
    ))).toBe("#345678");

    await accelerationLabel.fill("가속\n경기");
    await expect.poll(() => page.locator(".event-name").innerText()).toBe("가속\n경기");

    await accelerationVisibility.uncheck();
    await expect(page.locator(".panel")).toHaveCount(0);

    await page.reload();
    await waitForPageReady(page);

    await expect(page.getByTestId("scoreboard-theme")).toHaveAttribute("data-theme", "light");
    await expect(page.getByTestId("scoreboard-color-가속")).toHaveValue("#345678");
    await expect(page.getByTestId("scoreboard-visible-가속")).not.toBeChecked();
    await expect(page.getByLabel("가속 경기 표시명")).toHaveValue("가속\n경기");
    await expect(page.locator(".display-area")).toHaveAttribute("data-scoreboard-theme", "light");

    await page.getByTestId("scoreboard-visible-가속").check();
    await expect(page.locator(".panel")).toBeVisible({ timeout: 5000 });
    await expect.poll(() => page.locator(".event-name").innerText()).toBe("가속\n경기");
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
    await page.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} E2E-Scoreboard`);
    await context.close();
  });
});
