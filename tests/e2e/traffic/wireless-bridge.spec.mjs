import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// 브리지 온라인 상태가 SSE(wireless:bridge)로 전파되는지. Web Serial은 CI에서 구동
// 불가하므로, 서버로 ingest(heartbeat)를 보내 브리지-온라인 전이만 검증한다.
test.describe("Wireless bridge status", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("bridge status reflects ingest heartbeat over SSE", async ({ page }) => {
    await page.goto("/traffic/wireless/settings");
    await waitForPageReady(page);

    // 초기: 브리지 오프라인
    await expect(page.getByTestId("bridge-status")).toHaveClass(/bad/);

    // 서버로 heartbeat ingest → wireless:bridge online 브로드캐스트
    const res = await page.request.post("/traffic/api/wireless/ingest", { data: { events: [], telemetry: [] } });
    expect(res.ok()).toBeTruthy();

    // 클라이언트가 SSE로 온라인 반영(자동 재시도 단언)
    await expect(page.getByTestId("bridge-status")).toHaveClass(/ok/, { timeout: 8000 });
  });
});
