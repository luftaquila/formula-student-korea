import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const NODE = "e2e-map-1";

// 센서->경기·역할 매핑을 UI에서 설정·영속하는지. 노드는 진단(telemetry) ingest로 노출시킨다.
test.describe("Wireless sensor mapping", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
    const p = await ctx.newPage();
    await p.request.delete(`/traffic/api/wireless/mapping/${NODE}`).catch(() => {});
    await ctx.close();
  });

  test("maps a discovered node and persists it", async ({ page }) => {
    // 노드를 진단 ingest로 노출
    await page.request.post("/traffic/api/wireless/ingest", {
      data: { telemetry: [{ node_id: NODE, rssi: -70, snr: 9, offset_us: 100, skew_ppm: 3, latency_ms: 20, link_state: "online" }] },
    });

    await page.goto("/traffic/wireless/settings");
    await waitForPageReady(page);

    // 진단 SSE로 매핑 행이 등장
    const row = page.getByTestId(`mapping-row-${NODE}`);
    await expect(row).toBeVisible({ timeout: 8000 });

    // 종목/역할 선택 후 저장
    await row.locator("select").first().selectOption("가속");
    await row.locator("select").nth(1).selectOption("finish");

    const saved = page.waitForResponse(
      (r) => r.url().includes(`/api/wireless/mapping/${NODE}`) && r.request().method() === "PUT" && r.status() === 200,
    );
    await page.getByTestId(`mapping-save-${NODE}`).click();
    await saved;
    await expectNotification(page, "success", "할당 저장");

    // 서버에 영속되었는지 확인
    const res = await page.request.get("/traffic/api/wireless/mapping");
    const list = await res.json();
    const m = list.find((x) => x.node_id === NODE);
    expect(m).toBeTruthy();
    expect(m.event_type).toBe("가속");
    expect(m.role).toBe("finish");
  });
});
