import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

test.describe("RBAC — unauthenticated access", () => {
  test("unauthenticated user is redirected from /entry", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const response = await page.goto("/entry");
    // SPA pages redirect to / for unauthenticated users
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("unauthenticated user is redirected from /inspection", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/inspection");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("unauthenticated user is redirected from /traffic", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/traffic");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("unauthenticated user is redirected from /score", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/score");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("unauthenticated API calls return 401", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const res = await page.request.get("/entry/api/entries");
    // Public endpoint — should return 200
    expect(res.status()).toBe(200);

    // Admin-only endpoints should return 401
    const entryPost = await page.request.post("/entry/api/entries", {
      data: { num: 999, univ: "test", team: "test", type: "EV" },
    });
    expect(entryPost.status()).toBe(401);

    const trafficRes = await page.request.get("/traffic/api/records");
    expect(trafficRes.status()).toBe(401);

    await context.close();
  });
});

test.describe("RBAC — student role restrictions", () => {
  test("student is redirected from /entry (admin only)", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("student") });
    const page = await context.newPage();

    await page.goto("/entry");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("student is redirected from /traffic (admin only)", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("student") });
    const page = await context.newPage();

    await page.goto("/traffic");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("student is redirected from /score (admin only)", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("student") });
    const page = await context.newPage();

    await page.goto("/score");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("student CAN access /documents", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("student") });
    const page = await context.newPage();

    await page.goto("/documents");
    // Should NOT redirect to / — student can access documents
    await expect(page).toHaveURL(/\/documents/);
    await context.close();
  });

  test("student API calls to admin endpoints return 403", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("student") });
    const page = await context.newPage();

    const res = await page.request.post("/entry/api/entries", {
      data: { num: 999, univ: "test", team: "test", type: "EV" },
    });
    expect(res.status()).toBe(403);

    await context.close();
  });
});

test.describe("RBAC — official role restrictions", () => {
  test("official is redirected from /entry (admin only)", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    await page.goto("/entry");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("official is redirected from /traffic (admin only)", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    await page.goto("/traffic");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("official is redirected from /score (admin only)", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    await page.goto("/score");
    await expect(page).toHaveURL("/");
    await context.close();
  });

  test("official CAN access /inspection", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    await page.goto("/inspection");
    await expect(page).toHaveURL(/\/inspection/);
    await context.close();
  });

  test("official CAN access /queue/admin", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    await page.goto("/queue/admin");
    await expect(page).toHaveURL(/\/queue\/admin/);
    await context.close();
  });

  test("official API calls to admin endpoints return 403", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
    const page = await context.newPage();

    const res = await page.request.get("/traffic/api/records");
    expect(res.status()).toBe(403);

    await context.close();
  });
});

test.describe("RBAC — queue public access", () => {
  test("unauthenticated user CAN access /queue (public page)", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/queue");
    await expect(page).toHaveURL(/\/queue/);
    await context.close();
  });

  test("unauthenticated user CAN access /queue/api/active", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const res = await page.request.get("/queue/api/active");
    expect(res.status()).toBe(200);
    await context.close();
  });
});
