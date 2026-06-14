import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// 신호등 점유 잠금: 서버 권위 배타 + 클라이언트(SSE)에 점유자 표시.
test.describe("Wireless light lock", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const p = await ctx.newPage();
    await p.request.post("/traffic/api/wireless/light/release", { data: { event_type: "가속", force: true } }).catch(() => {});
    await ctx.close();
  });

  test("claim is exclusive and the owner is shown to clients", async ({ page }) => {
    await page.goto("/traffic/wireless");
    await waitForPageReady(page);

    // 가속이 점유
    const claim = await page.request.post("/traffic/api/wireless/light/claim", { data: { event_type: "가속" } });
    expect(claim.ok()).toBeTruthy();

    // 클라이언트가 SSE로 점유자 표시
    await expect(page.locator(".wl-lockline")).toContainText("가속", { timeout: 8000 });

    // 다른 종목의 점유 시도는 409
    const conflict = await page.request.post("/traffic/api/wireless/light/claim", { data: { event_type: "스키드패드" } });
    expect(conflict.status()).toBe(409);

    // 해제 후 다른 종목이 점유 가능
    const rel = await page.request.post("/traffic/api/wireless/light/release", { data: { event_type: "가속" } });
    expect(rel.ok()).toBeTruthy();
    const claim2 = await page.request.post("/traffic/api/wireless/light/claim", { data: { event_type: "스키드패드" } });
    expect(claim2.ok()).toBeTruthy();
    await page.request.post("/traffic/api/wireless/light/release", { data: { event_type: "스키드패드", force: true } });
  });
});
