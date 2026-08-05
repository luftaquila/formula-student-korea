import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Template JSON import UI", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("submits the selected JSON and reports a successful import", async ({ page }) => {
    const template = [{
      name: "E2E import fixture",
      remarks: "",
      pdf_include: 1,
      subcategories: [],
    }];
    let importRequest;
    await page.route("**/inspection/api/sheet/template/import", async (route) => {
      importRequest = route.request();
      await route.fulfill({ status: 201, body: "" });
    });

    await page.goto("/inspection/template");
    await waitForPageReady(page);
    page.on("dialog", (dialog) => dialog.accept());

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "JSON 가져오기" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: `inspection-template-${YEAR}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(template)),
    });

    await expect.poll(() => importRequest?.method()).toBe("POST");
    expect(importRequest.postDataJSON()).toEqual({ year: YEAR, template });
    await expect(page.getByText("템플릿을 가져왔습니다.")).toBeVisible();
  });
});
