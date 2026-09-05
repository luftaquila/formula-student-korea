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

      const registrationRow = page.locator(".result-row-detailed").filter({ hasText: "등록 대기" });
      await expect(registrationRow.locator(".result-rank")).toHaveText("4");
      await expect(registrationRow.locator(".result-suffix")).toHaveText("번");
      await expect(registrationRow).toContainText("7팀");

      const inspectionRow = page.locator(".result-row-detailed").filter({ hasText: "틸팅" });
      await expect(inspectionRow.locator(".result-rank")).toHaveText(/\d+/);
      await expect(inspectionRow.locator(".result-total")).toContainText(/^\/ \d+팀$/);
      await expect(inspectionRow.locator(".cohort-rank")).toContainText(/(초검|재검) \d+위 \/ \d+팀/);
    } finally {
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/enter`, {
        data: { num: ENTRY_NUM },
      });
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/exit`);
    }
  });

  test("reveals the public team queue in the existing booth status section", async ({ page }) => {
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
      const teamRow = disclosure.locator("tbody tr").filter({ hasText: `#${ENTRY_NUM}` });
      await expect(teamRow).toContainText("E2E Queue Status / Queue Status");
      await expect(teamRow).toContainText(/\d+위/);
      await expect(teamRow).toContainText(/초검|재검/);
    } finally {
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/enter`, {
        data: { num: ENTRY_NUM },
      });
      await page.request.post(`/competition/api/v1/queue/admin/booths/${TYPE}/1/exit`);
    }
  });
});
