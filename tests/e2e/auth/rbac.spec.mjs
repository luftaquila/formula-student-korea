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
  test("home groups operational cards by their actual minimum role", async ({ browser }) => {
    const cases = [
      {
        role: "staff",
        headings: ["Services", "Staff"],
        paths: ["/registration/manage"],
        absentPaths: ["/queue/admin", "/inspection", "/documents/admin"],
      },
      {
        role: "official",
        headings: ["Services", "Officials"],
        paths: ["/queue/admin", "/inspection"],
        absentPaths: ["/registration/manage", "/documents/admin"],
      },
      {
        role: "chief",
        headings: ["Services", "Officials", "Chief"],
        paths: ["/queue/admin", "/inspection", "/documents/admin", "/files/"],
        absentPaths: ["/registration/manage", "/course", "/traffic", "/score"],
      },
      {
        role: "master",
        headings: ["Services", "Officials", "Chief", "Master"],
        paths: ["/queue/admin", "/inspection", "/documents/admin", "/files/", "/course", "/traffic", "/score"],
        absentPaths: ["/registration/manage", "/entry", "/auth"],
      },
      {
        role: "admin",
        headings: ["Services", "Staff", "Officials", "Chief", "Master", "Admin"],
        paths: ["/registration/manage", "/queue/admin", "/inspection", "/documents/admin", "/course", "/traffic", "/score"],
        absentPaths: [],
      },
    ];

    for (const expectation of cases) {
      await withPage(browser, storageStatePath(expectation.role), async (page) => {
        await page.goto("/");
        await expect(page.locator("main h2")).toHaveText(expectation.headings);
        for (const path of expectation.paths) {
          await expect(page.locator('main .service-card[href="' + path + '"]')).toHaveCount(1);
        }
        for (const path of expectation.absentPaths) {
          await expect(page.locator('main .service-card[href="' + path + '"]')).toHaveCount(0);
        }
      });
    }
  });

  test("resources are expanded by default and can be collapsed", async ({ browser }) => {
    await withPage(browser, null, async (page) => {
      await page.goto("/");
      const resources = page.locator("main details.resources-section");
      await expect(resources).toHaveAttribute("open", "");
      await resources.locator("summary").click();
      await expect(resources).not.toHaveAttribute("open", "");
      await page.reload();
      await expect(page.locator("main details.resources-section")).not.toHaveAttribute("open", "");
    });
  });

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

  test("staff can only enter registration management among protected operational apps", async ({ browser }) => {
    await withPage(browser, storageStatePath("staff"), async (page) => {
      await page.goto("/registration/manage");
      await expect(page).toHaveURL(/\/registration\/manage/);
      await expect(page.getByRole("heading", { name: "설정" })).toHaveCount(0);

      for (const path of ["/registration/register", "/queue/admin", "/inspection", "/documents/admin"]) {
        await page.goto(path);
        await expect(page).toHaveURL("/");
      }
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

  test("masters can use course, traffic, and score but not admin applications", async ({ browser }) => {
    await withPage(browser, storageStatePath("master"), async (page) => {
      for (const path of ["/course", "/traffic", "/score"]) {
        await page.goto(path);
        await expect(page).toHaveURL(new RegExp(path));
      }

      for (const path of ["/entry", "/auth", "/email"]) {
        await page.goto(path);
        await expect(page).toHaveURL("/");
      }
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
