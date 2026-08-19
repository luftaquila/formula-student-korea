import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

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
    expect(data.services).toContain("entry");

    // Auth logs should exist (seeding creates users)
    // Each log from the aggregation endpoint is tagged with _service
    const authLogs = data.logs.filter((log) => log._service === "auth");
    expect(authLogs.length).toBeGreaterThan(0);
  });

  test("filtering logs reaches a downstream service and returns only its records", async ({ page }) => {
    // Generate a deterministic downstream log without changing state. The
    // duplicate insert is rejected, but Competition records the attempted action
    // before returning its documented duplicate-key response.
    const year = currentCompetitionYear();
    const duplicate = await page.request.post(`/competition/api/v1/teams?year=${year}`, {
      data: { number: 1, university: "서울대학교", name: "SNU Racing" },
    });
    expect(duplicate.status()).toBe(409);

    const query = new URLSearchParams({
      service: "entry",
      action: "team.create",
    });
    const res = await page.request.get(`/auth/api/admin/logs?${query}`);
    expect(res.status()).toBe(200);
    const aggregated = await res.json();

    expect(aggregated.services).toEqual(["entry"]);
    expect(aggregated.logs.length).toBeGreaterThan(0);
    expect(aggregated.logs.every(
      (log) => log._service === "entry"
        && log.action === "team.create",
    )).toBe(true);
    expect(aggregated.logs.some(
      (log) => log.target === "#1" && log.level === "warn",
    )).toBe(true);
  });
});
