import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const TEAM_NUM = 1;

test.describe("Entry active-state toggle", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("updates only the target row without refetching the table", async ({ page }) => {
    const teams = await (await page.request.get(`/competition/api/v1/teams?year=${YEAR}&includeInactive=true`)).json();
    const team = teams.find((candidate) => candidate.number === TEAM_NUM);
    expect(team?.id).toBeTruthy();
    await page.request.patch(`/competition/api/v1/teams/${team.id}`, { data: { active: true } });
    await page.goto("/entry");
    await waitForPageReady(page);
    await page.locator(".year-select").selectOption(String(YEAR));
    await waitForPageReady(page);

    let listFetches = 0;
    let deactivationRequests = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/competition/api/v1/teams") listFetches += 1;
      if (request.method() === "PATCH" && url.pathname === `/competition/api/v1/teams/${team.id}`) deactivationRequests += 1;
    });

    const row = page.locator(".entry-table tbody tr").filter({ hasText: "서울대학교" });
    const toggle = row.locator(".status-toggle");
    await expect(toggle).toHaveText("");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    page.once("dialog", (dialog) => dialog.dismiss());
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(deactivationRequests).toBe(0);

    page.once("dialog", (dialog) => dialog.accept());
    await toggle.click();
    await expectNotification(page, "success", "비활성화했습니다");

    await expect(row).toHaveClass(/entry-inactive/);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(deactivationRequests).toBe(1);
    expect(listFetches).toBe(0);

    await toggle.click();
    await expectNotification(page, "success", "활성화했습니다");

    await expect(row).not.toHaveClass(/entry-inactive/);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(listFetches).toBe(0);
  });
});
