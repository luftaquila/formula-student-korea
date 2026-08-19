import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// 물리 신호등 사용 경기 지정(무선 설정). 기본은 전부 가상, 지정된 1개만 실제 제어.
test.describe("Wireless physical-event designation", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const p = await ctx.newPage();
    await p.request.put("/competition/api/v1/traffic/wireless/physical-event", { data: { event_type: null } }).catch(() => {});
    await ctx.close();
  });

  test("designates and changes the physical-light event, and can clear it", async ({ page }) => {
    await page.goto("/traffic/wireless/settings");
    await waitForPageReady(page);

    // 가속을 물리 신호등 경기로 지정
    const a = await page.request.put("/competition/api/v1/traffic/wireless/physical-event", { data: { event_type: "가속" } });
    expect(a.ok()).toBeTruthy();
    expect((await a.json()).owner_event).toBe("가속");

    // 다른 경기로 변경
    const b = await page.request.put("/competition/api/v1/traffic/wireless/physical-event", { data: { event_type: "스키드패드" } });
    expect(b.ok()).toBeTruthy();
    expect((await b.json()).owner_event).toBe("스키드패드");

    // 없음(전부 가상)으로 해제
    const c = await page.request.put("/competition/api/v1/traffic/wireless/physical-event", { data: { event_type: null } });
    expect(c.ok()).toBeTruthy();
    expect((await c.json()).owner_event).toBeNull();

    // 잘못된 종목은 400
    const d = await page.request.put("/competition/api/v1/traffic/wireless/physical-event", { data: { event_type: "없는종목" } });
    expect(d.status()).toBe(400);
  });
});
