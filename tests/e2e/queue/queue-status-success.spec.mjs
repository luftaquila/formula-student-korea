import { test, expect } from "@playwright/test";
import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const PHONE = "01055556666";
const ENTRY_NUM = 95;
const TYPE = "tilting";

test.describe("Unified public queue lookup", () => {
  test.use({ storageState: storageStatePath("operationsManager") });

  test("shows registration plus overall and cohort inspection ranks from one entry number", async ({ page }) => {
    const registered = await page.request.post(`/competition/api/v1/queue/admin/register/${TYPE}`, {
      data: { num: ENTRY_NUM, phone: PHONE },
    });
    expect(registered.status()).toBe(201);

    await page.route(`**/competition/api/v1/registration/lookup/${ENTRY_NUM}?*`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        year: YEAR,
        teamId: ENTRY_NUM,
        number: ENTRY_NUM,
        university: "E2E Queue Status",
        name: "Queue Status",
        status: "waiting",
        position: 4,
        waitingTotal: 7,
      }),
    }));

    try {
      await page.goto("/queue");
      await waitForPageReady(page);

      await expect(page.getByLabel("전화번호")).toHaveCount(0);
      const entryInput = page.getByLabel("엔트리 번호");
      await entryInput.fill(String(ENTRY_NUM));
      await expect(page.locator(".team-badge").first()).toContainText("E2E Queue Status");
      await page.getByRole("button", { name: "조회" }).click();

      const registrationRow = page.locator(".result-row-detailed").filter({ hasText: "등록" });
      await expect(registrationRow.locator(".result-rank")).toHaveText("4");
      await expect(registrationRow.locator(".result-suffix")).toHaveText("번");
      await expect(registrationRow).toContainText("7팀");

      const inspectionRow = page.locator(".result-row-detailed").filter({ hasText: "틸팅" });
      const rankLines = inspectionRow.locator(".rank-line");
      await expect(rankLines).toHaveCount(2);
      await expect(rankLines.nth(0)).toContainText(/전체\s*\d+번\s*\/\s*\d+팀/);
      await expect(rankLines.nth(1)).toContainText(/(초검|재검)\s*\d+번\s*\/\s*\d+팀/);
    } finally {
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/enter`, {
        data: { num: ENTRY_NUM },
      });
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/exit`);
    }
  });

  test("reveals the public team queue in the existing booth status section", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const registered = await page.request.post(`/competition/api/v1/queue/admin/register/${TYPE}`, {
      data: { num: ENTRY_NUM, phone: PHONE },
    });
    expect(registered.status()).toBe(201);

    try {
      await page.goto("/queue");
      await waitForPageReady(page);

      const section = page.locator(".booth-type-section").filter({ hasText: "틸팅" });
      const disclosure = section.locator(".public-queue-disclosure");
      await disclosure.locator("summary").click();
      const teamRow = disclosure.locator("li").filter({ hasText: `#${ENTRY_NUM}` });
      const identityLine = teamRow.locator(".public-team-line");
      await expect(identityLine).toContainText(`#${ENTRY_NUM}`);
      await expect(identityLine).toContainText("E2E Queue Status");
      await expect(identityLine).toContainText("Queue Status");
      const rankLine = teamRow.locator(".public-ranks");
      await expect(rankLine).toContainText(/전체 \d+번/);
      await expect(rankLine).toContainText(/(초검|재검) \d+번/);
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )).toBe(true);
    } finally {
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/enter`, {
        data: { num: ENTRY_NUM },
      });
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/exit`);
    }
  });
});
