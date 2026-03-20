import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Template import/export UI round-trip", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("exports and re-imports template JSON with identical result", async ({ page }) => {
    await page.goto("/inspection/template");
    await waitForPageReady(page);

    // Step 1: Export via UI
    const downloadPromise = page.waitForEvent("download");
    await page.locator("button").filter({ hasText: "JSON 내보내기" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(`inspection-template-${YEAR}.json`);

    // Read downloaded JSON content
    const content = await download.createReadStream().then((stream) => {
      return new Promise((resolve) => {
        let data = "";
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => resolve(data));
      });
    });

    const exported = JSON.parse(content);
    expect(Array.isArray(exported)).toBe(true);
    expect(exported.length).toBe(2);

    // Step 2: Import the same JSON back via UI
    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Click import button, handle filechooser
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.locator("button").filter({ hasText: "JSON 가져오기" }).click();
    const fileChooser = await fileChooserPromise;

    // Set the exported content as a file
    await fileChooser.setFiles({
      name: `inspection-template-${YEAR}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(content),
    });

    // Wait for import to complete
    await waitForPageReady(page);

    // Step 3: Verify template is unchanged after round-trip
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const imported = await templateRes.json();
    expect(imported.length).toBe(2);
    expect(imported[0].name).toBe("전기 검차");
    expect(imported[1].name).toBe("샤시 검차");

    // Verify nested structure preserved
    expect(imported[0].subcategories[0].name).toBe("배터리");
    expect(imported[0].subcategories[0].groups[0].name).toBe("배터리 팩");
    expect(imported[0].subcategories[0].groups[0].items).toHaveLength(4);
    expect(imported[1].subcategories[0].name).toBe("프레임");
    expect(imported[1].subcategories[0].groups[0].name).toBe("롤바");
  });
});
