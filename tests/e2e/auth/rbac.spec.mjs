import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

async function withPage(browser, storageState, callback) {
  const context = await browser.newContext(storageState ? { storageState } : {});
  try {
    await callback(await context.newPage());
  } finally {
    await context.close();
  }
}

test.describe("Cross-application RBAC", () => {
  test("unauthenticated users are redirected from protected apps and rejected by protected APIs", async ({ browser }) => {
    await withPage(browser, null, async (page) => {
      for (const path of ["/entry", "/inspection", "/traffic", "/score"]) {
        await test.step(`redirect ${path}`, async () => {
          await page.goto(path);
          await expect(page).toHaveURL("/");
        });
      }

      expect((await page.request.get("/competition/api/v1/teams")).status()).toBe(200);
      expect((await page.request.post("/competition/api/v1/teams", {
        data: { number: 999, university: "test", name: "test" },
      })).status()).toBe(401);
      expect((await page.request.get("/competition/api/v1/traffic/records")).status()).toBe(401);
    });
  });

  test("students can use documents but cannot enter or mutate admin applications", async ({ browser }) => {
    await withPage(browser, storageStatePath("student"), async (page) => {
      for (const path of ["/entry", "/traffic", "/score"]) {
        await test.step(`redirect ${path}`, async () => {
          await page.goto(path);
          await expect(page).toHaveURL("/");
        });
      }

      await page.goto("/documents");
      await expect(page).toHaveURL(/\/documents/);
      const res = await page.request.post("/competition/api/v1/teams", {
        data: { number: 999, university: "test", name: "test" },
      });
      expect(res.status()).toBe(403);
    });
  });

  test("officials can use inspection and queue admin but not admin-only applications", async ({ browser }) => {
    await withPage(browser, storageStatePath("official"), async (page) => {
      for (const path of ["/entry", "/traffic", "/score"]) {
        await test.step(`redirect ${path}`, async () => {
          await page.goto(path);
          await expect(page).toHaveURL("/");
        });
      }

      await page.goto("/inspection");
      await expect(page).toHaveURL(/\/inspection/);
      await page.goto("/queue/admin");
      await expect(page).toHaveURL(/\/queue\/admin/);
      expect((await page.request.get("/competition/api/v1/traffic/records")).status()).toBe(403);
    });
  });

  test("the public queue page and active endpoint remain unauthenticated", async ({ browser }) => {
    await withPage(browser, null, async (page) => {
      await page.goto("/queue");
      await expect(page).toHaveURL(/\/queue/);
      expect((await page.request.get("/competition/api/v1/queue/active")).status()).toBe(200);
    });
  });
});
