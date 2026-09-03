import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// Calendar UI: the iCal subscribe flow and its auth gating. Event create/edit
// (schedule-x grid interaction) is covered at the API layer by visibility.spec
// and is intentionally not driven through the grid here (library-controlled DOM,
// fragile). This exercises the stable, user-visible subscribe affordance.
test.describe("Calendar subscribe UI", () => {
  for (const [profile, audience] of [["operationsManager", "official"], ["student", "student"]]) {
    test(`${profile} can open the subscribe dialog and gets an audience-scoped iCal URL`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: storageStatePath(profile) });
      const page = await context.newPage();
      await page.goto("/calendar");
      await waitForPageReady(page);

      const btn = page.locator(".subscribe-btn");
      await expect(btn).toBeVisible();
      const sub = page.waitForResponse((r) => r.url().includes("/calendar/api/events/subscribe") && r.status() === 200);
      await btn.click();
      await sub;

      const url = page.locator(".subscribe-dialog__url");
      await expect(url).toHaveValue(new RegExp(`/calendar/api/events/ical\\?role=${audience}&sig=[0-9a-f]+`));
      await context.close();
    });
  }

  test("unauthenticated visitor sees no subscribe affordance", async ({ page }) => {
    await page.goto("/calendar");
    await waitForPageReady(page);
    // Authenticated-only button; for an anonymous visitor it never renders.
    await expect(page.locator(".subscribe-btn")).toHaveCount(0);
  });
});
