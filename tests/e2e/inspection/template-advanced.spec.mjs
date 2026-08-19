import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

test.describe("Inspection template JSON export", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("preserves pdf_include in the JSON downloaded through the UI", async ({ page }) => {
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    expect(templateRes.status()).toBe(200);
    const template = await templateRes.json();
    const firstCategory = template[0];
    expect(firstCategory?.id).toBeTruthy();

    try {
      const update = await page.request.put(`/competition/api/v1/inspection/sheet/template/${firstCategory.id}`, {
        data: { pdf_include: false },
      });
      expect(update.status()).toBe(200);

      await page.goto("/inspection/template");
      await waitForPageReady(page);
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "JSON 내보내기" }).click();
      const download = await downloadPromise;
      const content = await download.createReadStream().then((stream) => new Promise((resolve, reject) => {
        let data = "";
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => resolve(data));
        stream.on("error", reject);
      }));

      const parsed = JSON.parse(content);
      expect(parsed[0].pdf_include).toBe(0);
      expect(parsed[1].pdf_include).toBe(1);
    } finally {
      const restore = await page.request.put(`/competition/api/v1/inspection/sheet/template/${firstCategory.id}`, {
        data: { pdf_include: true },
      });
      expect(restore.status()).toBe(200);
    }
  });
});
