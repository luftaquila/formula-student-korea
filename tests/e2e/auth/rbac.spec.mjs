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
  test("home shows operational cards from explicit service permissions and admin tools only to admins", async ({ browser }) => {
    const ADMIN_TOOLS = ["/entry", "/email", "/auth/logs", "/auth"];
    const cases = [
      {
        profile: "registrationOperator",
        headings: ["Services", "Operations"],
        paths: ["/registration/manage"],
        absentPaths: ["/queue/admin", "/inspection", "/documents/admin"],
      },
      {
        profile: "operationsOperator",
        headings: ["Services", "Operations"],
        paths: ["/registration/manage", "/queue/admin", "/inspection"],
        absentPaths: ["/documents/admin", "/course", "/traffic", "/score"],
      },
      {
        profile: "operationsManager",
        headings: ["Services", "Operations"],
        paths: ["/registration/manage", "/queue/admin", "/inspection", "/documents/admin", "/files/"],
        absentPaths: ["/course", "/traffic", "/score"],
      },
      {
        profile: "technicalOperator",
        headings: ["Services", "Operations"],
        paths: ["/course", "/traffic", "/score"],
        absentPaths: ["/registration/manage", "/queue/admin", "/inspection", "/documents/admin", "/files/"],
      },
      {
        profile: "admin",
        headings: ["Services", "Operations", "Admin"],
        paths: ["/registration/manage", "/queue/admin", "/inspection", "/documents/admin", "/course", "/traffic", "/score"],
        absentPaths: ["/auth/applications", "/auth/contacts", "/auth/devices"],
      },
    ];

    for (const expectation of cases) {
      await withPage(browser, storageStatePath(expectation.profile), async (page) => {
        await page.goto("/");
        await expect(page.locator("main h2")).toHaveText(expectation.headings);
        const operations = page.locator("main section").filter({
          has: page.getByRole("heading", { name: "Operations", exact: true }),
        });
        for (const path of expectation.paths) {
          await expect(operations.locator('.service-card[href="' + path + '"]')).toHaveCount(1);
        }
        for (const path of expectation.absentPaths) {
          await expect(page.locator('main .service-card[href="' + path + '"]')).toHaveCount(0);
        }

        // Admin tools live in their own group. They are never inside Operations, and
        // non-admins do not get the group at all — no grant can unlock it.
        const admin = page.locator("main section").filter({
          has: page.getByRole("heading", { name: "Admin", exact: true }),
        });
        for (const path of ADMIN_TOOLS) {
          await expect(operations.locator('.service-card[href="' + path + '"]')).toHaveCount(0);
          await expect(admin.locator('.service-card[href="' + path + '"]')).toHaveCount(expectation.profile === "admin" ? 1 : 0);
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
      await expect.poll(() => page.evaluate(
        () => localStorage.getItem("fsk.resources.open"),
      )).toBe("closed");
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

  test("registration operator can only enter registration operation among protected apps", async ({ browser }) => {
    await withPage(browser, storageStatePath("registrationOperator"), async (page) => {
      await page.goto("/registration/manage");
      await expect(page).toHaveURL(/\/registration\/manage/);
      await expect(page.getByRole("heading", { name: "설정" })).toHaveCount(0);

      for (const path of ["/registration/register", "/queue/admin", "/inspection", "/documents/admin"]) {
        await page.goto(path);
        await expect(page).toHaveURL("/");
      }
    });
  });

  test("multi-service operator can use only the explicitly granted operation apps", async ({ browser }) => {
    await withPage(browser, storageStatePath("operationsOperator"), async (page) => {
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
      await page.goto("/registration/manage");
      await expect(page).toHaveURL(/\/registration\/manage/);
      expect((await page.request.get("/competition/api/v1/traffic/records")).status()).toBe(403);
    });
  });

  test("technical operator can use course, traffic, and score only", async ({ browser }) => {
    await withPage(browser, storageStatePath("technicalOperator"), async (page) => {
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
