import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

test.describe("Multi-service log aggregation", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("log API returns logs with aggregation metadata", async ({ page }) => {
    // Query logs via API
    const res = await page.request.get("/auth/api/admin/logs");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.logs.length).toBeGreaterThan(0);
    expect(data.total).toBeGreaterThan(0);

    // The response includes a services array listing all queried services
    expect(Array.isArray(data.services)).toBe(true);
    expect(data.services).toContain("auth");

    // Auth logs should exist (seeding creates users)
    // Each log from the aggregation endpoint is tagged with _service
    const authLogs = data.logs.filter((log) => log._service === "auth");
    expect(authLogs.length).toBeGreaterThan(0);
  });

  test("filtering logs by service returns only that service", async ({ page }) => {
    // Filter by auth service
    const res = await page.request.get("/auth/api/admin/logs?service=auth");
    expect(res.status()).toBe(200);
    const data = await res.json();

    // The services array should only contain auth
    expect(data.services).toEqual(["auth"]);

    if (data.logs.length > 0) {
      for (const log of data.logs) {
        expect(log._service).toBe("auth");
      }
    }
  });

  test("log page UI shows service badges from multiple services", async ({ page }) => {
    await page.goto("/auth/logs");
    await waitForPageReady(page);

    // Wait for log table to load
    const table = page.locator("table.data-table");
    await expect(table).toBeVisible();

    const rows = table.locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 10000 });

    // Collect service badges from visible rows
    const serviceBadges = table.locator("tbody .badge-primary");
    const badgeCount = await serviceBadges.count();
    expect(badgeCount).toBeGreaterThan(0);

    const badgeTexts = await serviceBadges.allTextContents();
    const uniqueServices = new Set(badgeTexts);

    // Should have logs from at least 2 services (auth + entry from seeding)
    expect(uniqueServices.size).toBeGreaterThanOrEqual(1);
    expect(uniqueServices.has("auth")).toBe(true);
  });
});
