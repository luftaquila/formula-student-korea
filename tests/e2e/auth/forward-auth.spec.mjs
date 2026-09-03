import { test, expect } from "@playwright/test";
import { INTERNAL_SECRET, TEST_USERS } from "../helpers/auth.mjs";
import { storageStatePath } from "../helpers/utils.mjs";

// GET /auth/api/forward-auth backs Caddy's forward_auth for FileBrowser (/files).
// Caddy injects `X-Forward-Auth-Key: <INTERNAL_SECRET>` and `?permission=`.
// It is reachable through Caddy (the /auth/* block does not strip that header),
// so we can exercise the full key/role matrix directly. filebrowser itself is
// not started in CI, so we test the auth backend, not the /files/ proxy.
const KEY = { "X-Forward-Auth-Key": INTERNAL_SECRET };

test.describe("forward-auth backend (FileBrowser gate)", () => {
  test("missing key → 403", async ({ request }) => {
    const res = await request.get("/auth/api/forward-auth?permission=files.access");
    expect(res.status()).toBe(403);
  });

  test("wrong key → 403", async ({ request }) => {
    const res = await request.get("/auth/api/forward-auth?permission=files.access", {
      headers: { "X-Forward-Auth-Key": "not-the-secret" },
    });
    expect(res.status()).toBe(403);
  });

  test("valid key but no user cookie → 401", async ({ request }) => {
    const res = await request.get("/auth/api/forward-auth?permission=files.access", { headers: KEY });
    expect(res.status()).toBe(401);
  });

  test("valid key + official without files.access → 403", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("operationsOperator") });
    const res = await context.request.get("/auth/api/forward-auth?permission=files.access", { headers: KEY });
    expect(res.status()).toBe(403);
    await context.close();
  });

  test("valid key + official with files.access → 200 and sets X-Forwarded-User", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("operationsManager") });
    const res = await context.request.get("/auth/api/forward-auth?permission=files.access", { headers: KEY });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-forwarded-user"]).toBe(TEST_USERS.operationsManager.email);
    await context.close();
  });

  test("valid key + admin → 200", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const res = await context.request.get("/auth/api/forward-auth?permission=files.access", { headers: KEY });
    expect(res.status()).toBe(200);
    await context.close();
  });

  test("permission is required and must be known", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("operationsOperator") });
    const res = await context.request.get("/auth/api/forward-auth", { headers: KEY });
    expect(res.status()).toBe(400);
    await context.close();
  });
});
