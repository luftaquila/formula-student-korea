import { test, expect } from "@playwright/test";
import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const INSPECTION_TYPE = "battery";
const YEAR = currentCompetitionYear();

async function apiRegister(num, type = INSPECTION_TYPE) {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/register/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
    body: JSON.stringify({ num, phone: "01000000000" }),
  });
  return res;
}

async function apiCancel(num, type = INSPECTION_TYPE) {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/cancel/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsOperator") },
    body: JSON.stringify({ num }),
  });
  return res;
}

async function apiGetQueue(type = INSPECTION_TYPE) {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/inspection/${type}`, {
    headers: { Cookie: getAuthCookie("operationsOperator") },
  });
  return res.json();
}

async function apiExitBooth(type, boothNum) {
  await fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${type}/${boothNum}/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsOperator") },
  });
}

async function apiEnterBooth(type, boothNum, num) {
  return fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${type}/${boothNum}/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsOperator") },
    body: JSON.stringify({ num }),
  });
}

async function apiGetBooths(type = INSPECTION_TYPE) {
  const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${type}`, {
    headers: { Cookie: getAuthCookie("operationsOperator") },
  });
  return res.json();
}

async function cleanupQueue(type = INSPECTION_TYPE) {
  // Exit booth first
  await apiExitBooth(type, 1);
  // Remove queued entries via booth enter+exit (avoids cancel penalties entirely)
  const queue = await apiGetQueue(type);
  for (const item of queue) {
    await apiEnterBooth(type, 1, item.num).catch(() => {});
    await apiExitBooth(type, 1);
  }
}

async function clickAndAcceptConfirm(page, button, expectedMessage) {
  const handled = new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      const details = { type: dialog.type(), message: dialog.message() };
      await dialog.accept();
      resolve(details);
    });
  });
  await button.click();
  const dialog = await handled;
  expect(dialog.type).toBe("confirm");
  expect(dialog.message).toContain(expectedMessage);
}

test.describe("Queue booth management", () => {
  test.use({ storageState: storageStatePath("operationsOperator") });

  let originalPenalty;

  test.beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      headers: { Cookie: getAuthCookie("operationsManager") },
    });
    originalPenalty = (await res.json()).value;
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
      body: JSON.stringify({ value: 0 }),
    });
  });

  test.afterAll(async () => {
    if (originalPenalty !== undefined) {
      await fetch(`${BASE_URL}/competition/api/v1/queue/admin/settings/cancel-penalty`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsManager") },
        body: JSON.stringify({ value: originalPenalty }),
      });
    }
  });

  test.beforeEach(async () => {
    await cleanupQueue();
  });

  test.afterEach(async () => {
    await cleanupQueue();
  });

  test("admin page shows queue listing and booth section", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Should show the admin panel heading
    await expect(page.getByRole("heading", { name: /검차 대기열/ })).toBeVisible();

    // Should show inspection type tabs
    const tabs = page.locator(".tab");
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    const count = await tabs.count();
    expect(count).toBeGreaterThan(0);

    // Should show booth section
    await expect(page.getByText("부스 현황")).toBeVisible();
  });

  test("switching inspection tabs changes displayed queue", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    const tabs = page.locator(".tab");
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });

    // Click second tab if available
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(2);
    const secondTab = tabs.nth(1);
    await secondTab.click();
    await expect(secondTab).toHaveClass(/active/);
  });

  test("register team via API then verify it appears in admin queue", async ({ page }) => {
    // Register entry 1 via API
    const res = await apiRegister(1);
    expect(res.status).toBe(201);

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Click the battery tab and wait for loading to complete
    const batteryTab = page.locator(".tab", { hasText: "축전지" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();
    await expect(page.locator(".loading")).toBeHidden({ timeout: 10000 });

    // Verify entry 1 appears in queue
    await expect(page.locator(".entry-num", { hasText: "1" })).toBeVisible({ timeout: 5000 });
  });

  test("shows queue ranks and keeps linked inspector names live", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const categoryId = 9001;
    let inspectors = ["김검차", "이검차"];
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      const inspectionSources = [];
      function RoutedEventSource(url, options) {
        if (!String(url).includes("/inspection/sheet/events")) {
          return new NativeEventSource(url, options);
        }
        const source = new EventTarget();
        source.url = String(url);
        source.readyState = NativeEventSource.OPEN;
        source.close = () => {};
        inspectionSources.push(source);
        return source;
      }
      RoutedEventSource.CONNECTING = NativeEventSource.CONNECTING;
      RoutedEventSource.OPEN = NativeEventSource.OPEN;
      RoutedEventSource.CLOSED = NativeEventSource.CLOSED;
      window.EventSource = RoutedEventSource;
      window.__emitInspectionInspector = (data) => {
        for (const source of inspectionSources) {
          source.dispatchEvent(new MessageEvent("inspector", { data: JSON.stringify(data) }));
        }
      };
    });
    await page.route("**/competition/api/v1/inspection/sheet/summary?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        year: YEAR,
        categories: [{ id: categoryId, name: "전기 검차", excluded_types: [] }],
        teams: {
          1: { inspectors: { [categoryId]: inspectors }, results: {} },
        },
      }),
    }));
    await page.route("**/competition/api/v1/queue/admin/inspection/electric", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        inspection: "electric",
        num: 1,
        phone: "01000000000",
        timestamp: Date.now(),
        year: YEAR,
        is_reinspection: 1,
        priority: 999,
        rank: 4,
        total: 8,
        group_rank: 2,
        group_total: 3,
      }]),
    }));

    await page.goto("/queue/admin");
    await waitForPageReady(page);
    const electricQueueLoaded = page.waitForResponse((response) =>
      response.url().endsWith("/competition/api/v1/queue/admin/inspection/electric")
      && response.status() === 200,
    );
    await page.locator(".tab", { hasText: "전기" }).click();
    await electricQueueLoaded;

    const row = page.locator(".queue-item").filter({ hasText: "SNU Racing" });
    await expect(row).toContainText("전체 4번");
    await expect(row).toContainText("재검 2번");
    await expect(row).not.toContainText("기존 검차관");
    await expect(row).toContainText("김검차, 이검차");
    await expect(row.getByRole("button", { name: "검차표", exact: true })).toHaveCount(0);
    await expect(row.getByRole("link", { name: "010-0000-0000" })).toBeVisible();
    await expect(row.locator(".entry-time")).toBeVisible();
    await expect(row.getByRole("button", { name: "1번 대기 취소" })).toBeVisible();
    await expect(row.getByRole("button", { name: "1번 라스트콜 문자 발송" })).toBeVisible();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    )).toBe(true);

    inspectors = ["박검차"];
    await page.evaluate(({ year, id }) => {
      window.__emitInspectionInspector({ year, team_num: 1, category_id: id, inspectors: ["박검차"] });
    }, { year: YEAR, id: categoryId });
    const inspectorLink = row.getByRole("button", { name: "박검차" });
    await expect(inspectorLink).toBeVisible();
    await inspectorLink.click();
    await expect(page).toHaveURL(new RegExp(`/inspection/${YEAR}/1\\?category=${categoryId}$`));
  });

  test("occupied booth keeps its inspection link without a category match", async ({ page }) => {
    await page.route("**/competition/api/v1/inspection/sheet/summary?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ year: YEAR, categories: [], teams: {} }),
    }));
    expect((await apiRegister(2)).status).toBe(201);
    expect((await apiEnterBooth(INSPECTION_TYPE, 1, 2)).status).toBe(200);

    await page.goto("/queue/admin");
    await waitForPageReady(page);
    await page.locator(".tab", { hasText: "축전지" }).click();

    const booth = page.locator(".booth-card").filter({
      has: page.locator(".booth-team-num", { hasText: "2" }),
    });
    const inspectionLink = booth.getByRole("button", { name: "검차", exact: true });
    await expect(inspectionLink).toBeVisible();
    await inspectionLink.click();
    await expect(page).toHaveURL(new RegExp(`/inspection/${YEAR}/2$`));
  });

  test("enter team into booth via admin UI", async ({ page }) => {
    // Register entry 2 via API
    await apiRegister(2);

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Select battery tab and wait for loading to complete
    const batteryTab = page.locator(".tab", { hasText: "축전지" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();
    await expect(page.locator(".loading")).toBeHidden({ timeout: 10000 });

    // Wait for the queue to show
    await expect(page.locator(".entry-num", { hasText: "2" })).toBeVisible({ timeout: 5000 });

    // Select the team in the booth select dropdown
    const boothSelect = page.locator(".booth-select").first();
    await expect(boothSelect).toBeVisible({ timeout: 5000 });
    const targetOption = boothSelect.locator("option").filter({ hasText: /^2 -/ });
    const optValue = await targetOption.getAttribute("value");
    await boothSelect.selectOption(optValue);

    // Click enter booth button
    const enterBtn = page.getByRole("button", { name: "입차" }).first();
    await clickAndAcceptConfirm(page, enterBtn, "입차 확인\n#2");

    // Should show success notification
    await expectNotification(page, "success", "입차");
  });

  test("exit team from booth via admin UI", async ({ page }) => {
    // Register and enter entry 3 via API
    await apiRegister(3);
    await fetch(`${BASE_URL}/competition/api/v1/queue/admin/booths/${INSPECTION_TYPE}/1/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: getAuthCookie("operationsOperator") },
      body: JSON.stringify({ num: 3 }),
    });

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Select battery tab and wait for loading to complete
    const batteryTab = page.locator(".tab", { hasText: "축전지" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();
    await expect(page.locator(".loading")).toBeHidden({ timeout: 10000 });

    // The booth should show the team and an exit button
    await expect(page.locator(".booth-team-num", { hasText: "3" })).toBeVisible({ timeout: 10000 });

    // Click exit booth button
    const exitBtn = page.getByRole("button", { name: "출차" }).first();
    await clickAndAcceptConfirm(page, exitBtn, "출차 확인\n#3");

    // Should show success notification
    await expectNotification(page, "success", "출차");
  });

  test("pause and resume an occupied booth timer via admin UI", async ({ page }) => {
    await apiRegister(10);
    const entered = await apiEnterBooth(INSPECTION_TYPE, 1, 10);
    expect(entered.status).toBe(200);

    await page.goto("/queue/admin");
    await waitForPageReady(page);
    const batteryTab = page.locator(".tab", { hasText: "축전지" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();

    const boothCard = page.locator(".booth-card").filter({ has: page.locator(".booth-team-num", { hasText: "10" }) });
    await expect(boothCard).toBeVisible({ timeout: 10000 });
    await boothCard.getByRole("button", { name: "중단", exact: true }).click();
    await expect(boothCard.getByRole("button", { name: "재개", exact: true })).toBeVisible();
    await expect(boothCard).toHaveClass(/booth-paused/);
    await expect(boothCard.getByText("일시중단", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const booths = await apiGetBooths();
      return booths.find((booth) => booth.booth_num === 1)?.timer_paused_at ?? null;
    }).not.toBeNull();

    const frozenElapsed = await boothCard.locator(".booth-elapsed").textContent();
    const publicPage = await page.context().newPage();
    await publicPage.goto("/queue/");
    await waitForPageReady(publicPage);
    const publicSection = publicPage.locator(".booth-type-section").filter({ hasText: "축전지" });
    const publicBooth = publicSection.locator(".booth-item").first();
    await expect(publicBooth).toHaveClass(/booth-paused/);
    await expect(publicBooth.getByText("일시중단", { exact: true })).toBeVisible();
    await publicPage.close();

    await boothCard.getByRole("button", { name: "재개", exact: true }).click();
    await expect(boothCard.getByRole("button", { name: "중단", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const booths = await apiGetBooths();
      return booths.find((booth) => booth.booth_num === 1)?.timer_paused_at ?? null;
    }).toBeNull();
    await expect.poll(() => boothCard.locator(".booth-elapsed").textContent()).not.toBe(frozenElapsed);
  });

  test("cancel queued team via admin UI", async ({ page }) => {
    // Register entry 20 via API
    await apiRegister(20);

    await page.goto("/queue/admin");
    await waitForPageReady(page);

    // Select battery tab and wait for loading to complete
    const batteryTab = page.locator(".tab", { hasText: "축전지" });
    await expect(batteryTab).toBeVisible({ timeout: 10000 });
    await batteryTab.click();
    await expect(page.locator(".loading")).toBeHidden({ timeout: 10000 });

    // Wait for entry to appear
    await expect(page.locator(".entry-num", { hasText: "20" })).toBeVisible({ timeout: 5000 });

    // Click cancel button (X icon)
    page.on("dialog", (dialog) => dialog.accept());
    const cancelBtn = page.locator(".queue-item", { hasText: "20" }).locator(".btn-danger");
    await cancelBtn.click();

    // Should show warning notification for cancel
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({ timeout: 5000 });
  });

  test("stacks queue actions and confirms before sending a last call", async ({ page }) => {
    expect((await apiRegister(1)).status).toBe(201);
    let requestMethod = null;
    await page.route(
      "**/competition/api/v1/queue/admin/inspection/battery/1/last-call",
      async (route) => {
        requestMethod = route.request().method();
        await route.fulfill({ status: 200, body: "" });
      },
    );

    await page.goto("/queue/admin");
    await waitForPageReady(page);
    await page.locator(".tab", { hasText: "축전지" }).click();

    const row = page.locator(".queue-item").filter({ has: page.locator(".entry-num", { hasText: /^1$/ }) });
    const cancelButton = row.getByRole("button", { name: "1번 대기 취소" });
    const lastCallButton = row.getByRole("button", { name: "1번 라스트콜 문자 발송" });
    await expect(cancelButton).toBeVisible();
    await expect(lastCallButton).toBeVisible();
    await expect(cancelButton).toHaveText("");
    await expect(lastCallButton).toHaveText("");
    await expect(cancelButton.locator("svg")).toHaveCount(1);
    await expect(lastCallButton.locator("svg")).toHaveCount(1);
    const [cancelBox, lastCallBox] = await Promise.all([cancelButton.boundingBox(), lastCallButton.boundingBox()]);
    expect(cancelBox).not.toBeNull();
    expect(lastCallBox).not.toBeNull();
    expect(lastCallBox.y).toBeGreaterThan(cancelBox.y + cancelBox.height - 1);

    await clickAndAcceptConfirm(page, lastCallButton, "엔트리 1번에 라스트콜 문자를 발송하시겠습니까?");
    expect(requestMethod).toBe("POST");
    await expectNotification(page, "success", "엔트리 1번에 라스트콜 문자를 발송했습니다");
  });

  test("keeps overlapping last calls pending per entry", async ({ page }) => {
    expect((await apiRegister(1)).status).toBe(201);
    expect((await apiRegister(2)).status).toBe(201);

    const requestCounts = new Map();
    const gates = new Map();
    const releases = new Map();
    for (const num of [1, 2]) {
      gates.set(num, new Promise((resolve) => releases.set(num, resolve)));
    }
    await page.route("**/competition/api/v1/queue/admin/inspection/battery/*/last-call", async (route) => {
      const match = route.request().url().match(/\/battery\/(\d+)\/last-call$/);
      const num = Number(match?.[1]);
      requestCounts.set(num, (requestCounts.get(num) || 0) + 1);
      await gates.get(num);
      await route.fulfill({ status: 200, body: "" });
    });

    await page.goto("/queue/admin");
    await waitForPageReady(page);
    await page.locator(".tab", { hasText: "축전지" }).click();

    const rowFor = (num) => page.locator(".queue-item").filter({
      has: page.locator(".entry-num", { hasText: new RegExp(`^${num}$`) }),
    });
    const firstCancel = rowFor(1).getByRole("button", { name: "1번 대기 취소" });
    const firstLastCall = rowFor(1).getByRole("button", { name: "1번 라스트콜 문자 발송" });
    const secondCancel = rowFor(2).getByRole("button", { name: "2번 대기 취소" });
    const secondLastCall = rowFor(2).getByRole("button", { name: "2번 라스트콜 문자 발송" });

    try {
      await clickAndAcceptConfirm(page, firstLastCall, "엔트리 1번에 라스트콜 문자를 발송하시겠습니까?");
      await clickAndAcceptConfirm(page, secondLastCall, "엔트리 2번에 라스트콜 문자를 발송하시겠습니까?");
      await expect.poll(() => requestCounts.get(1) || 0).toBe(1);
      await expect.poll(() => requestCounts.get(2) || 0).toBe(1);
      await expect(firstCancel).toBeDisabled();
      await expect(firstLastCall).toBeDisabled();
      await expect(secondCancel).toBeDisabled();
      await expect(secondLastCall).toBeDisabled();

      releases.get(1)();
      await expect(firstLastCall).toBeEnabled();
      await expect(firstCancel).toBeEnabled();
      await expect(secondLastCall).toBeDisabled();
      await expect(secondCancel).toBeDisabled();

      releases.get(2)();
      await expect(secondLastCall).toBeEnabled();
      await expect(secondCancel).toBeEnabled();
    } finally {
      releases.get(1)();
      releases.get(2)();
    }
  });

  test("official sees operational buttons without registration", async ({ page }) => {
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    await expect(page.getByRole("button", { name: "검차 등록", exact: true })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "우선순위" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "통계" })).toBeVisible();
    await expect(page.getByRole("button", { name: "페널티", exact: true })).toBeVisible();
  });

  test("queue manager can open the registration page from admin", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("operationsManager") });
    const page = await context.newPage();
    await page.goto("/queue/admin");
    await waitForPageReady(page);

    const registerButton = page.getByRole("button", { name: "검차 등록", exact: true });
    await expect(registerButton).toBeVisible();
    await registerButton.click();
    await expect(page).toHaveURL(/\/queue\/register/);
    await expect(page.getByText("검차 종류 선택")).toBeVisible();
    await context.close();
  });
});
