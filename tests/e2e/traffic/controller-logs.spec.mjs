import { test, expect } from "@playwright/test";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

test.describe("Traffic controller logs", () => {
  const LOG_DATA = { timestamp: new Date().toISOString(), data: "E2E controller log test" };

  test.afterAll(async () => {
    // Cleanup: clear all controller logs
    await fetch(`${BASE_URL}/traffic/api/controllers`, {
      method: "DELETE",
      headers: { Cookie: getAuthCookie("admin") },
    });
  });

  test("uploads controller log via API", async () => {
    const res = await fetch(`${BASE_URL}/traffic/api/controllers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("admin") },
      body: JSON.stringify(LOG_DATA),
    });
    expect(res.status).toBe(201);
  });

  test("retrieves controller logs via API", async () => {
    // Ensure at least one log exists
    await fetch(`${BASE_URL}/traffic/api/controllers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("admin") },
      body: JSON.stringify(LOG_DATA),
    });

    const res = await fetch(`${BASE_URL}/traffic/api/controllers`, {
      headers: { Cookie: getAuthCookie("admin") },
    });
    expect(res.status).toBe(200);

    const logs = await res.json();
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toHaveProperty("data");
  });

  test("clears all controller logs via API", async () => {
    // Ensure at least one log exists
    await fetch(`${BASE_URL}/traffic/api/controllers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("admin") },
      body: JSON.stringify(LOG_DATA),
    });

    // Delete all
    const deleteRes = await fetch(`${BASE_URL}/traffic/api/controllers`, {
      method: "DELETE",
      headers: { Cookie: getAuthCookie("admin") },
    });
    expect(deleteRes.status).toBe(200);

    // Verify empty
    const getRes = await fetch(`${BASE_URL}/traffic/api/controllers`, {
      headers: { Cookie: getAuthCookie("admin") },
    });
    const logs = await getRes.json();
    expect(logs).toEqual([]);
  });
});
