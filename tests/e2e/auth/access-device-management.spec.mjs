import { test, expect } from "@playwright/test";
import { createJWT } from "../../../shared/express-setup.mjs";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";

test.describe("Access and kiosk device management", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("admin assigns and restores an official's explicit service access", async ({ browser, page, request }) => {
    const email = `e2e-access-editor-${Date.now()}-${test.info().parallelIndex}@test.com`;
    let userId;
    let officialContext;

    try {
      const created = await request.post("/auth/api/users", {
        data: { email, role: "official" },
      });
      expect(created.status()).toBe(201);
      userId = (await created.json()).id;

      await page.goto("/auth");
      await waitForPageReady(page);
      const row = page.locator("table.users-table tbody tr").filter({ hasText: email });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "권한 0" }).click();

      const dialog = page.getByRole("dialog", { name: "서비스 권한 편집" });
      await expect(dialog).toBeVisible();
      const bundleColumn = dialog.locator(".access-columns > div").first();
      const directPermissionColumn = dialog.locator(".access-columns > div").nth(1);
      await bundleColumn.locator("label.access-option").filter({ hasText: "검차 대기 관리자" }).locator("input").check();
      await directPermissionColumn.locator("label.access-option").filter({ hasText: "인스펙션 운영" }).locator("input").check();

      const saved = page.waitForResponse((response) =>
        response.url().endsWith(`/auth/api/users/${userId}/access`)
        && response.request().method() === "PUT");
      await dialog.getByRole("button", { name: "저장", exact: true }).click();
      expect((await saved).status()).toBe(200);
      await expectNotification(page, "success", "서비스 권한을 변경했습니다");

      await expect(row.getByRole("button", { name: "권한 3" })).toBeVisible();
      const usersResponse = await request.get("/auth/api/users");
      const user = (await usersResponse.json()).find((candidate) => candidate.id === userId);
      expect(user.bundles).toEqual(["queue_manager"]);
      expect(user.directPermissions).toEqual(["inspection.operate"]);
      expect(user.permissions).toEqual(["inspection.operate", "queue.manage", "queue.operate"]);
      expect(user.accessRevision).toBe(1);

      officialContext = await browser.newContext();
      await officialContext.addCookies([{
        name: "fsk_session",
        value: createJWT({ email, name: "E2E Access Editor", role: "official", accessRevision: 0 }, JWT_SECRET),
        domain: "localhost",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      }]);

      const session = await officialContext.request.get("/auth/api/session");
      expect(session.status()).toBe(200);
      expect((await session.json()).permissions).toEqual(user.permissions);
      expect((await officialContext.request.get("/competition/api/v1/queue/admin/priority/noise")).status()).toBe(200);
      expect((await officialContext.request.get("/competition/api/v1/inspection/sheet/template")).status()).toBe(200);
      expect((await officialContext.request.post("/competition/api/v1/inspection/sheet/template", {
        data: { name: "must not be created" },
      })).status()).toBe(403);
      expect((await officialContext.request.get("/competition/api/v1/registration/queue")).status()).toBe(403);

      await page.reload();
      await waitForPageReady(page);
      const reloadedRow = page.locator("table.users-table tbody tr").filter({ hasText: email });
      await reloadedRow.getByRole("button", { name: "권한 3" }).click();
      const reloadedDialog = page.getByRole("dialog", { name: "서비스 권한 편집" });
      await expect(reloadedDialog.locator(".access-columns > div").first().locator("label.access-option").filter({ hasText: "검차 대기 관리자" }).locator("input")).toBeChecked();
      await expect(reloadedDialog.locator(".access-columns > div").nth(1).locator("label.access-option").filter({ hasText: "인스펙션 운영" }).locator("input")).toBeChecked();
    } finally {
      await officialContext?.close();
      if (userId) await request.delete(`/auth/api/users/${userId}`);
    }
  });

  test("admin pairs a registration-only tablet and revokes it immediately", async ({ browser, page, request }) => {
    const name = `E2E Registration Tablet ${Date.now()}-${test.info().parallelIndex}`;
    let deviceId;
    let deviceContext;

    try {
      await page.goto("/auth/devices");
      await waitForPageReady(page);
      await page.locator(".device-create input").fill(name);
      await page.locator(".device-create select").selectOption("kiosk.registration.register");
      const created = page.waitForResponse((response) =>
        response.url().endsWith("/auth/api/devices") && response.request().method() === "POST");
      await page.getByRole("button", { name: "코드 생성" }).click();
      const createdResponse = await created;
      expect(createdResponse.status()).toBe(201);
      const device = await createdResponse.json();
      deviceId = device.id;
      await expect(page.locator(".issued-code")).toHaveText(device.pairingCode);

      deviceContext = await browser.newContext();
      const devicePage = await deviceContext.newPage();
      await devicePage.goto("/auth/device");
      await devicePage.locator(".pair-code").fill(device.pairingCode);
      const paired = devicePage.waitForResponse((response) =>
        response.url().endsWith("/auth/api/device/pair") && response.request().method() === "POST");
      await devicePage.getByRole("button", { name: "접수 화면 열기" }).click();
      expect((await paired).status()).toBe(200);
      await expect(devicePage).toHaveURL(/\/registration\/register$/);
      await expect(devicePage.getByRole("heading", { name: "FSK 등록 대기열 등록" })).toBeVisible();
      await expect(devicePage.locator(".device-badge")).toContainText(name);

      const settingsWrite = await deviceContext.request.patch("/competition/api/v1/registration/settings", {
        data: { open: false },
      });
      expect(settingsWrite.status()).toBe(403);
      expect((await deviceContext.request.get("/competition/api/v1/registration/queue")).status()).toBe(403);
      expect((await deviceContext.request.post("/competition/api/v1/queue/admin/register/noise", {
        data: { num: 1, phone: "01000000000" },
      })).status()).toBe(403);

      const deviceRow = page.locator("table tbody tr").filter({ hasText: name });
      await expect(deviceRow).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      const revoked = page.waitForResponse((response) =>
        response.url().endsWith(`/auth/api/devices/${deviceId}/revoke`)
        && response.request().method() === "POST");
      await deviceRow.getByRole("button", { name: "폐기", exact: true }).click();
      expect((await revoked).status()).toBe(200);
      await expectNotification(page, "success", "장비 인증을 폐기했습니다");

      await devicePage.reload();
      await expect(devicePage).toHaveURL(/\/auth\/device$/);
      await expect(devicePage.getByRole("heading", { name: "태블릿 장비 인증" })).toBeVisible();
    } finally {
      await deviceContext?.close();
      if (deviceId) await request.post(`/auth/api/devices/${deviceId}/revoke`);
    }
  });
});
