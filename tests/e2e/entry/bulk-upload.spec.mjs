import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();
const ISOLATED_YEAR = YEAR - 2;

test.describe("Entry bulk upload and download", () => {
  test.use({ storageState: storageStatePath("admin") });

  // Seed vehicle types and entries in an isolated year to avoid interfering with other tests
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    // Create vehicle types for the isolated year first
    await page.request.post(`/entry/api/vehicle-types?year=${ISOLATED_YEAR}`, { data: { name: "EV" } });
    await page.request.post(`/entry/api/vehicle-types?year=${ISOLATED_YEAR}`, { data: { name: "CV" } });
    const entries = [
      { num: 1, univ: "서울대학교", team: "SNU Racing", type: "EV" },
      { num: 2, univ: "한양대학교", team: "ACES", type: "EV" },
      { num: 3, univ: "성균관대학교", team: "SKKU Racing", type: "CV" },
      { num: 10, univ: "KAIST", team: "RUN", type: "EV" },
      { num: 20, univ: "고려대학교", team: "KURF", type: "CV" },
    ];
    for (const entry of entries) {
      await page.request.post(`/entry/api/entries?year=${ISOLATED_YEAR}`, { data: entry });
    }
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    await page.request.delete(`/entry/api/entries?year=${ISOLATED_YEAR}`);
    // Clean up vehicle types for isolated year
    const res = await page.request.get(`/entry/api/vehicle-types?year=${ISOLATED_YEAR}`);
    const types = await res.json();
    for (const t of types) {
      await page.request.delete(`/entry/api/vehicle-types/${t.id}?year=${ISOLATED_YEAR}`);
    }
    await context.close();
  });

  test("downloads entries as JSON", async ({ page }) => {
    await page.goto("/entry");
    await waitForPageReady(page);

    // Switch to isolated year
    await page.locator(".year-select").selectOption(String(ISOLATED_YEAR));
    await waitForPageReady(page);

    // Set up download listener before clicking
    const downloadPromise = page.waitForEvent("download");
    await page.locator('a.download-btn').click();
    const download = await downloadPromise;

    // Verify the file name
    expect(download.suggestedFilename()).toBe(`entry_${ISOLATED_YEAR}.json`);

    // Save to temp path and verify contents
    const tmpPath = path.join(os.tmpdir(), download.suggestedFilename());
    await download.saveAs(tmpPath);
    const content = JSON.parse(fs.readFileSync(tmpPath, "utf-8"));

    // Verify the downloaded JSON contains all 5 seeded entries
    expect(Object.keys(content)).toHaveLength(5);
    expect(content["1"]).toEqual({ univ: "서울대학교", team: "SNU Racing", type: "EV" });
    expect(content["2"]).toEqual({ univ: "한양대학교", team: "ACES", type: "EV" });

    // Clean up temp file
    fs.unlinkSync(tmpPath);
  });

  test("uploads entries from JSON file", async ({ page }) => {
    await page.goto("/entry");
    await waitForPageReady(page);

    // Switch to isolated year
    await page.locator(".year-select").selectOption(String(ISOLATED_YEAR));
    await waitForPageReady(page);

    // Create a temporary JSON fixture file for upload
    const uploadData = {
      "50": { univ: "업로드대학교A", team: "업로드팀A", type: "EV" },
      "51": { univ: "업로드대학교B", team: "업로드팀B", type: "CV" },
      "52": { univ: "업로드대학교C", team: "업로드팀C", type: "EV" },
    };

    const fixturePath = path.join(os.tmpdir(), "e2e-upload-fixture.json");
    fs.writeFileSync(fixturePath, JSON.stringify(uploadData, null, 2));

    // Upload the file via the file input (hidden input inside drop-zone)
    const fileInput = page.locator('input[type="file"][accept=".json"]');
    await fileInput.setInputFiles(fixturePath);

    // Verify file name is shown in the drop zone
    await expect(page.locator(".file-name")).toHaveText("e2e-upload-fixture.json");

    // Click upload button
    await page.locator("button.upload-btn").click();

    // Verify success notification
    await expectNotification(page, "success", "엔트리 목록을 업로드했습니다.");

    // Wait for table to update - bulk upload replaces all entries for this year
    await waitForPageReady(page);
    const table = page.locator(".entry-table");
    await expect(page.locator(".entry-count")).toHaveText("3개");
    await expect(table.locator("tbody")).toContainText("업로드대학교A");
    await expect(table.locator("tbody")).toContainText("업로드대학교B");
    await expect(table.locator("tbody")).toContainText("업로드대학교C");

    // Clean up temp file
    fs.unlinkSync(fixturePath);
  });
});
