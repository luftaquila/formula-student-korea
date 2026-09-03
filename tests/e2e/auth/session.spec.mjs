import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

test.describe("Auth session API", () => {
  test("GET /auth/api/session returns user data with valid cookie", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    const response = await page.request.get("/auth/api/session");
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("name");
    expect(data).toHaveProperty("role");
    expect(data.role).toBe("admin");

    await context.close();
  });

  test("GET /auth/api/session returns 401 without cookie", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const response = await page.request.get("/auth/api/session");
    expect(response.status()).toBe(401);

    await context.close();
  });

  test("GET /auth/api/session works for each role", async ({ browser }) => {
    for (const role of ["admin", "master", "chief", "official", "staff", "student"]) {
      const context = await browser.newContext({ storageState: storageStatePath(role) });
      const page = await context.newPage();

      const response = await page.request.get("/auth/api/session");
      expect(response.status()).toBe(200);

      const data = await response.json();
      expect(data.role).toBe(role);

      await context.close();
    }
  });

  test("POST /auth/api/logout clears session cookies", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();

    // Verify session is valid before logout
    const beforeRes = await page.request.get("/auth/api/session");
    expect(beforeRes.status()).toBe(200);

    // Perform logout
    const logoutRes = await page.request.post("/auth/api/logout");
    expect(logoutRes.status()).toBe(200);

    // Session should now be invalid (cookies cleared)
    const afterRes = await page.request.get("/auth/api/session");
    expect(afterRes.status()).toBe(401);

    await context.close();
  });
});
