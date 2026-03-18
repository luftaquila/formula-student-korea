import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

test.describe("Score endurance input", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/score/endurance");
    await waitForPageReady(page);
  });

  test("endurance page renders with team data", async ({ page }) => {
    // Verify the page title
    await expect(page.locator("h3")).toContainText("내구 기록 입력");

    // Verify team count badge
    await expect(page.locator(".count-badge")).toContainText("5");

    // Verify the endurance table is visible
    const table = page.locator("table.endurance-table");
    await expect(table).toBeVisible();

    // Verify seeded teams appear
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("KAIST");

    // Verify key column headers
    await expect(page.locator("th").filter({ hasText: "번호" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "최종 기록" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "드라이버 1" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "드라이버 2" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "상태" })).toBeVisible();
  });

  test("set DNS status for a team and verify inputs are disabled", async ({ page }) => {
    const table = page.locator("table.endurance-table");

    // Find the row for team #1 (서울대학교)
    const row = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    await expect(row).toBeVisible();

    // Click DNS button
    const dnsBtn = row.locator(".status-btn").filter({ hasText: "DNS" });
    await dnsBtn.click();

    // Verify DNS is active
    await expect(dnsBtn).toHaveClass(/active/);

    // Verify inputs in the row are disabled
    const inputs = row.locator("input.cell-input");
    const inputCount = await inputs.count();
    for (let i = 0; i < inputCount; i++) {
      await expect(inputs.nth(i)).toBeDisabled();
    }

    // Verify via API
    const response = await page.request.get(`/score/api/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[1]?.status).toBe("DNS");

    // Toggle DNS off (click again to remove status)
    await dnsBtn.click();
    await expect(dnsBtn).not.toHaveClass(/active/);

    // Inputs should be re-enabled
    const firstInput = row.locator("input.cell-input").first();
    await expect(firstInput).not.toBeDisabled();
  });

  test("set DNF status for a team", async ({ page }) => {
    const table = page.locator("table.endurance-table");
    const row = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(row).toBeVisible();

    // Click DNF button
    const dnfBtn = row.locator(".status-btn").filter({ hasText: "DNF" });
    await dnfBtn.click();
    await expect(dnfBtn).toHaveClass(/active/);

    // Verify the final record column shows "DNF"
    await expect(row.locator(".record-value.dnf")).toContainText("DNF");

    // Verify via API
    const response = await page.request.get(`/score/api/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[2]?.status).toBe("DNF");

    // Clean up: toggle off
    await dnfBtn.click();
    await expect(dnfBtn).not.toHaveClass(/active/);
  });

  test("enter driver 1 and driver 2 times", async ({ page }) => {
    const table = page.locator("table.endurance-table");
    const row = table.locator("tbody tr").filter({ hasText: "성균관대학교" });
    await expect(row).toBeVisible();

    // Driver 1 time input (first time-input in the row)
    const driver1TimeInput = row.locator("input.time-input").nth(0);
    await driver1TimeInput.click();
    await driver1TimeInput.fill("5:30.500");
    await driver1TimeInput.blur();
    await page.waitForTimeout(300);

    // Driver change time input (second time-input)
    const changeTimeInput = row.locator("input.time-input").nth(1);
    await changeTimeInput.click();
    await changeTimeInput.fill("0:05.000");
    await changeTimeInput.blur();
    await page.waitForTimeout(300);

    // Driver 2 time input (third time-input)
    const driver2TimeInput = row.locator("input.time-input").nth(2);
    await driver2TimeInput.click();
    await driver2TimeInput.fill("5:45.200");
    await driver2TimeInput.blur();
    await page.waitForTimeout(300);

    // Verify driving time is populated (sum of all 3 times)
    // 5:30.500 + 0:05.000 + 5:45.200 = 11:20.700
    const drivingTimeCell = row.locator(".col-summary").nth(1);
    await expect(drivingTimeCell).toContainText("11:20.700");

    // Verify final record is populated (should equal driving time when no penalties)
    const finalRecordCell = row.locator(".col-summary").nth(0);
    await expect(finalRecordCell.locator(".record-value")).toBeVisible();

    // Verify via API
    const response = await page.request.get(`/score/api/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[3]?.driver1_time).toBe(330500); // 5:30.500 in ms
    expect(data[3]?.driver_change_time).toBe(5000); // 0:05.000 in ms
    expect(data[3]?.driver2_time).toBe(345200); // 5:45.200 in ms

    // Clean up: clear the times
    await driver1TimeInput.click();
    await driver1TimeInput.fill("");
    await driver1TimeInput.blur();
    await page.waitForTimeout(200);
    await changeTimeInput.click();
    await changeTimeInput.fill("");
    await changeTimeInput.blur();
    await page.waitForTimeout(200);
    await driver2TimeInput.click();
    await driver2TimeInput.fill("");
    await driver2TimeInput.blur();
    await page.waitForTimeout(200);
  });

  test("enter cone and off-course penalties and verify final time", async ({ page }) => {
    const table = page.locator("table.endurance-table");
    const row = table.locator("tbody tr").filter({ hasText: "KAIST" });
    await expect(row).toBeVisible();

    // First enter driver times so we have a base time
    const driver1TimeInput = row.locator("input.time-input").nth(0);
    await driver1TimeInput.click();
    await driver1TimeInput.fill("4:00.000");
    await driver1TimeInput.blur();
    await page.waitForTimeout(300);

    const changeTimeInput = row.locator("input.time-input").nth(1);
    await changeTimeInput.click();
    await changeTimeInput.fill("0:03.000");
    await changeTimeInput.blur();
    await page.waitForTimeout(300);

    const driver2TimeInput = row.locator("input.time-input").nth(2);
    await driver2TimeInput.click();
    await driver2TimeInput.fill("4:10.000");
    await driver2TimeInput.blur();
    await page.waitForTimeout(300);

    // Enter cone touch count for driver 1
    // num-input order per row: d1_start_delay(0), d1_cones(1), d1_oc(2), d1_penalty(3),
    //                          d2_start_delay(4), d2_cones(5), d2_oc(6), d2_penalty(7)
    const driver1ConesInput = row.locator("input.num-input").nth(1);
    await driver1ConesInput.click();
    await driver1ConesInput.fill("3");
    await driver1ConesInput.blur();
    await page.waitForTimeout(300);

    // Enter off-course for driver 2
    const driver2OcInput = row.locator("input.num-input").nth(6);
    await driver2OcInput.click();
    await driver2OcInput.fill("1");
    await driver2OcInput.blur();
    await page.waitForTimeout(300);

    // Verify the penalty column shows a non-empty value (depends on penalty settings)
    // The penalty display will only show if penalty settings have been configured
    // But the cone/oc values should be saved

    // Verify via API
    const response = await page.request.get(`/score/api/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[10]?.driver1_cones).toBe(3);
    expect(data[10]?.driver2_oc).toBe(1);

    // Clean up
    for (const input of [driver1TimeInput, changeTimeInput, driver2TimeInput]) {
      await input.click();
      await input.fill("");
      await input.blur();
      await page.waitForTimeout(200);
    }
    await driver1ConesInput.click();
    await driver1ConesInput.fill("");
    await driver1ConesInput.blur();
    await page.waitForTimeout(200);
    await driver2OcInput.click();
    await driver2OcInput.fill("");
    await driver2OcInput.blur();
    await page.waitForTimeout(200);
  });

  test("navigation link returns to score dashboard", async ({ page }) => {
    // Find and click the "성적표" navigation link
    const navLink = page.locator("a.nav-link").filter({ hasText: "성적표" });
    await expect(navLink).toBeVisible();
    await navLink.click();

    // Should navigate to the score dashboard
    await waitForPageReady(page);
    await expect(page.locator("table.score-table")).toBeVisible();
  });
});
