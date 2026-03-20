import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

async function apiRegister(type, num, phone = "01000000000") {
  return fetch(`${BASE_URL}/queue/api/admin/register/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num, phone }),
  });
}

async function apiCancel(type, num) {
  return fetch(`${BASE_URL}/queue/api/admin/cancel/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
    body: JSON.stringify({ num }),
  });
}

async function apiExitBooth(type, boothNum) {
  await fetch(`${BASE_URL}/queue/api/admin/booths/${type}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("official") },
  });
}

async function apiClearQueue(type) {
  // Exit all occupied booths first
  const boothRes = await fetch(`${BASE_URL}/queue/api/admin/booths/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  if (boothRes.ok) {
    const booths = await boothRes.json();
    for (const booth of booths) {
      if (booth.occupied_by) await apiExitBooth(type, booth.booth_num);
    }
  }
  // Cancel all queued entries (penalty=0 ensured by caller)
  const res = await fetch(`${BASE_URL}/queue/api/admin/inspection/${type}`, {
    headers: { Cookie: getAuthCookie("official") },
  });
  if (!res.ok) return;
  const entries = await res.json();
  for (const entry of entries) {
    await apiCancel(type, entry.num);
  }
}

test.describe("Queue registration business rules", () => {
  test.use({ storageState: storageStatePath("official") });

  // Set cancel penalty to 1 minute for testing, then restore
  let originalPenalty;

  test.beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("chief") },
    });
    originalPenalty = (await res.json()).value;

    // Temporarily disable penalty so cleanup cancels don't create penalties
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 0 }),
    });

    // Clear any leftover queue entries from previous test files
    for (const type of ["battery", "chassis", "noise", "rain"]) {
      await apiClearQueue(type);
    }

    // Set to 1 minute for testing
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 1 }),
    });
  });

  test.afterAll(async () => {
    // Restore original penalty
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
        body: JSON.stringify({ value: originalPenalty }),
      });
    }
  });

  test.afterEach(async () => {
    // Disable penalty before cleanup to avoid cross-test penalties
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 0 }),
    });
    for (const type of ["battery", "chassis", "noise", "rain"]) {
      await apiClearQueue(type);
    }
    // Restore 1-minute penalty for test assertions
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 1 }),
    });
  });

  test("cancel penalty blocks re-registration", async ({ page }) => {
    // Use "rain" type exclusively for this test to avoid collisions with other queue test files
    // Ensure penalty=1 right before the critical register+cancel sequence
    await fetch(`${BASE_URL}/queue/api/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("chief") },
      body: JSON.stringify({ value: 1 }),
    });

    const regRes = await apiRegister("rain", 32);
    expect(regRes.status).toBe(201);

    const cancelRes = await apiCancel("rain", 32);
    expect(cancelRes.status).toBe(200);

    // Attempt to re-register should fail with 403 (penalty active)
    const reRegRes = await apiRegister("rain", 32);
    expect(reRegRes.status).toBe(403);
  });

  test("battery + chassis concurrent registration is allowed", async ({ page }) => {
    // Register entry 30 for battery
    const batteryRes = await apiRegister("battery", 30);
    expect(batteryRes.status).toBe(201);

    // Register same entry for chassis (should be allowed)
    const chassisRes = await apiRegister("chassis", 30);
    expect(chassisRes.status).toBe(201);
  });

  test("duplicate registration for same inspection type is blocked", async ({ page }) => {
    // Register entry 30 for noise
    const firstRes = await apiRegister("noise", 30);
    expect(firstRes.status).toBe(201);

    // Attempt to register same entry for same type again
    const secondRes = await apiRegister("noise", 30);
    expect(secondRes.status).toBe(400);
  });

  test("registering two different non-compatible types is blocked", async ({ page }) => {
    // Register entry 31 for battery
    const batteryRes = await apiRegister("battery", 31);
    expect(batteryRes.status).toBe(201);

    // Attempt to register for noise (not battery+chassis pair) should fail
    const noiseRes = await apiRegister("noise", 31);
    expect(noiseRes.status).toBe(400);
  });

  test("registration fails for non-existent entry number", async ({ page }) => {
    const res = await apiRegister("battery", 9999);
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).toBe("존재하지 않는 엔트리 번호입니다.");
  });
});
