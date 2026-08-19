import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const teamsPattern = "**/competition/api/v1/teams?includeInactive=true*";
const importPattern = "**/competition/api/v1/teams/import*";

test.describe("Entry import request lifecycle", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("keeps the selected file and loading state until the parent request settles", async ({ page }) => {
    await page.route(teamsPattern, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }));
    let releaseImport;
    let markImportStarted;
    const importStarted = new Promise((resolve) => { markImportStarted = resolve; });
    const importGate = new Promise((resolve) => { releaseImport = resolve; });
    await page.route(importPattern, async (route) => {
      markImportStarted();
      await importGate;
      await route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    });

    await page.goto("/entry");
    await waitForPageReady(page);
    await page.locator(".year-select").selectOption(String(YEAR));
    const input = page.locator('input[type="file"]');
    await input.setInputFiles({
      name: "teams.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"teams":[]}'),
    });
    const upload = page.locator(".upload-btn");
    await upload.click();
    await importStarted;

    await expect(upload).toBeDisabled();
    await expect(upload).toContainText("업로드 중");
    await expect(page.locator(".file-name")).toHaveText("teams.json");

    releaseImport();
    await expectNotification(page, "success", "업로드했습니다");
    await expect(page.locator(".file-name")).toHaveCount(0);
    await expect(upload).toContainText("업로드");

    await page.unroute(importPattern);
    await page.route(importPattern, (route) => route.fulfill({ status: 500, body: "import failed" }));
    await input.setInputFiles({
      name: "retry.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"teams":[]}'),
    });
    await upload.click();
    await expectNotification(page, "error", "import failed");
    await expect(page.locator(".file-name")).toHaveText("retry.json");
    await expect(upload).not.toBeDisabled();
  });
});
