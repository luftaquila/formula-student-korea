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

    // The competition display is 16:9 and keeps only the two large, distant-readable records.
    const displayArea = page.locator(".display-area");
    const box = await displayArea.boundingBox();
    expect(box).toBeTruthy();
    expect(box.width / box.height).toBeGreaterThan(1.77);
    expect(box.width / box.height).toBeLessThan(1.78);
    await expect(scoreboard.getByText("Current", { exact: true })).toHaveCount(1);
    await expect(scoreboard.getByText("Best", { exact: true })).toHaveCount(1);
    await expect(scoreboard.getByText("Current Record", { exact: true })).toHaveCount(0);
    await expect(scoreboard.getByText("Best Record", { exact: true })).toHaveCount(0);
    await expect(scoreboard.getByText("Top Records", { exact: true })).toHaveCount(0);
    await expect(scoreboard.locator(".record-team").first().locator(".university-name")).toHaveCount(1);
    await expect(scoreboard.locator(".record-team").first().locator(".team-name-text")).toHaveCount(1);

    const currentBox = await page.getByTestId("current-record-가속").boundingBox();
    const bestBox = await page.getByTestId("best-record-가속").boundingBox();
    expect(currentBox).toBeTruthy();
    expect(bestBox).toBeTruthy();
    expect(Math.abs(currentBox.y - bestBox.y)).toBeLessThan(2);
    expect(bestBox.x).toBeGreaterThan(currentBox.x + currentBox.width - 2);

    const layoutBounds = await scoreboard.evaluate((element) => ({
      events: [...element.querySelectorAll(".event-name")].map((name) => ({
        width: name.getBoundingClientRect().width,
        available: name.parentElement.clientWidth,
        whiteSpace: getComputedStyle(name).whiteSpace,
      })),
      records: [...element.querySelectorAll(".record-cell")].map((cell) => ({
        width: cell.clientWidth,
        scrollWidth: cell.scrollWidth,
        height: cell.clientHeight,
        scrollHeight: cell.scrollHeight,
      })),
      teamLines: [...element.querySelectorAll(".university-name, .team-name-text")].map((line) => ({
        width: line.clientWidth,
        scrollWidth: line.scrollWidth,
      })),
    }));
    for (const event of layoutBounds.events) {
      expect(event.whiteSpace).toBe("nowrap");
      expect(event.width).toBeLessThanOrEqual(event.available);
    }
    for (const record of layoutBounds.records) {
      expect(record.scrollWidth).toBeLessThanOrEqual(record.width);
      expect(record.scrollHeight).toBeLessThanOrEqual(record.height);
    }
    for (const line of layoutBounds.teamLines) {
      expect(line.scrollWidth).toBeLessThanOrEqual(line.width + 1);
    }

    const recordFontSize = await scoreboard.locator(".record-result").first().evaluate((element) => (
      Number.parseFloat(getComputedStyle(element).fontSize)
    ));
    expect(recordFontSize).toBeGreaterThanOrEqual(80);

    const teamFontSize = await scoreboard.locator(".university-name").first().evaluate((element) => (
      Number.parseFloat(getComputedStyle(element).fontSize)
    ));
    expect(teamFontSize).toBeGreaterThanOrEqual(32);

    const supportingFontSizes = await scoreboard.evaluate((element) => ({
      label: Number.parseFloat(getComputedStyle(element.querySelector(".record-label")).fontSize),
      entry: Number.parseFloat(getComputedStyle(element.querySelector(".entry-number")).fontSize),
      entryBackground: getComputedStyle(element.querySelector(".entry-number")).backgroundColor,
    }));
    expect(supportingFontSizes.label).toBeGreaterThanOrEqual(35);
    expect(supportingFontSizes.entry).toBeGreaterThanOrEqual(36);
    expect(supportingFontSizes.entryBackground).toBe("rgba(0, 0, 0, 0)");

    const centeredText = await scoreboard.evaluate((element) => ({
      event: getComputedStyle(element.querySelector(".event-heading")).justifyContent,
      university: getComputedStyle(element.querySelector(".university-name")).textAlign,
      team: getComputedStyle(element.querySelector(".team-name-text")).textAlign,
    }));
    expect(centeredText.event).toBe("center");
    expect(centeredText.university).toBe("center");
    expect(centeredText.team).toBe("center");

    const nameFontSizes = await scoreboard.evaluate((element) => ({
      base: Number.parseFloat(getComputedStyle(element.querySelector(".record-team")).fontSize),
      university: Number.parseFloat(getComputedStyle(element.querySelector(".university-name")).fontSize),
      team: Number.parseFloat(getComputedStyle(element.querySelector(".team-name-text")).fontSize),
    }));
    expect(nameFontSizes.university).toBeLessThan(nameFontSizes.base);
    expect(Math.abs(nameFontSizes.team - nameFontSizes.university)).toBeLessThan(0.1);

    const spacing = await scoreboard.evaluate((element) => ({
      events: Number.parseFloat(getComputedStyle(element.querySelector(".panels")).rowGap),
      teamLines: Number.parseFloat(getComputedStyle(element.querySelector(".record-team")).rowGap),
    }));
    expect(spacing.events).toBeGreaterThanOrEqual(19);
    expect(spacing.teamLines).toBeGreaterThanOrEqual(4.5);
  });

  test("customizes and persists the scoreboard theme, event colors, and visibility", async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("scoreboard-settings-cleared")) {
        localStorage.removeItem("traffic-scoreboard-theme");
        localStorage.removeItem("traffic-scoreboard-colors");
        localStorage.removeItem("traffic-scoreboard-visibility");
        sessionStorage.setItem("scoreboard-settings-cleared", "true");
      }
    });
    await page.goto("/traffic/scoreboard");
    await waitForPageReady(page);

    await page.locator(".form-select").first().selectOption(`FSK ${YEAR} E2E-Scoreboard`);

    const displayArea = page.locator(".display-area");
    const themeButton = page.getByTestId("scoreboard-theme");
    const accelerationColor = page.getByTestId("scoreboard-color-가속");
    const accelerationVisibility = page.getByTestId("scoreboard-visible-가속");

    await expect(themeButton).toHaveAttribute("data-theme", "dark");
    await expect(accelerationColor).toHaveValue("#ffd000");
    await expect(page.getByTestId("scoreboard-color-스키드패드")).toHaveValue("#00e5ff");
    await expect(page.getByTestId("scoreboard-color-오토크로스")).toHaveValue("#ff6b6b");
    await expect(accelerationVisibility).toBeChecked();
    await expect(page.getByTestId("scoreboard-visible-스키드패드")).toBeChecked();
    await expect(page.getByTestId("scoreboard-visible-오토크로스")).toBeChecked();

    await themeButton.click();
    await expect(themeButton).toHaveAttribute("data-theme", "light");
    await expect(displayArea).toHaveAttribute("data-scoreboard-theme", "light");
    await expect(displayArea).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator(".scoreboard > .header")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    await accelerationColor.evaluate((input) => {
      input.value = "#345678";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect.poll(() => page.locator(".panel").first().evaluate((panel) => (
      getComputedStyle(panel).getPropertyValue("--panel-color").trim()
    ))).toBe("#345678");

    await accelerationVisibility.uncheck();
    await expect(page.locator(".panel")).toHaveCount(0);

    await page.reload();
    await waitForPageReady(page);

    await expect(page.getByTestId("scoreboard-theme")).toHaveAttribute("data-theme", "light");
    await expect(page.getByTestId("scoreboard-color-가속")).toHaveValue("#345678");
    await expect(page.getByTestId("scoreboard-visible-가속")).not.toBeChecked();
    await expect(page.locator(".display-area")).toHaveAttribute("data-scoreboard-theme", "light");

    await page.getByTestId("scoreboard-visible-가속").check();
    await expect(page.locator(".panel")).toBeVisible({ timeout: 5000 });
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
