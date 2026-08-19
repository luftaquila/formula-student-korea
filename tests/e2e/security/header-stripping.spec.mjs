import { test, expect } from "@playwright/test";
import { internalHeaders } from "../helpers/auth.mjs";

// Caddy strips X-Internal-Service and Authuser from every external request so a
// browser cannot (a) forge the inter-service secret to gain auto-admin, or
// (b) forge Authuser to impersonate a user. These tests send those headers with
// NO auth cookie through Caddy (localhost:9000) and assert no escalation.
// The `request` fixture is a cookie-less APIRequestContext bound to baseURL.
test.describe("Caddy security header stripping", () => {
  test("forged X-Internal-Service does not grant admin (stripped at the edge)", async ({ request }) => {
    // Even the REAL secret value, sent by an external client, must be stripped.
    const res = await request.post("/competition/api/v1/teams", {
      headers: internalHeaders(),
      data: { number: 99001, university: "sec-test", name: "sec-test" },
    });
    expect(res.status()).toBe(401);
  });

  test("forged Authuser header cannot impersonate a user", async ({ request }) => {
    const res = await request.post("/competition/api/v1/teams", {
      headers: { Authuser: "e2e-admin@test.com" },
      data: { number: 99002, university: "sec-test", name: "sec-test" },
    });
    expect(res.status()).toBe(401);
  });

  test("X-Internal-Service is preserved on /course/api/rover/* but stripped on /course UI paths", async ({ request }) => {
    // Rover endpoints live on the open internet, so Caddy intentionally keeps
    // the header here — the internal secret authenticates as admin.
    const rover = await request.post("/course/api/rover/position", {
      headers: internalHeaders(),
      data: { lat: 37.5, lng: 127.0 },
    });
    expect(rover.ok()).toBeTruthy();

    // The same header on a non-rover course path is stripped → no auth → 401.
    const ui = await request.post("/course/api/courses", {
      headers: internalHeaders(),
      data: { name: `sec-strip-${Date.now()}` },
    });
    expect(ui.status()).toBe(401);
  });
});
