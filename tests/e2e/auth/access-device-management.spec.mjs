import { test, expect } from "@playwright/test";
import { createJWT } from "../../../shared/express-setup.mjs";
import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";

const JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";
const YEAR = currentCompetitionYear();

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
      await expect(row.locator(".col-access")).toHaveText("없음");
      await row.getByRole("button", { name: "권한 편집" }).click();

      const dialog = page.getByRole("dialog", { name: "서비스 권한 편집" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("검차 대기 권한").selectOption("manage");
      await dialog.getByLabel("인스펙션 권한").selectOption("operate");
      await dialog.getByLabel("코스 관리 허용").check();
      await dialog.getByLabel("성적 관리 허용").check();

      const saved = page.waitForResponse((response) =>
        response.url().endsWith(`/auth/api/users/${userId}/access`)
        && response.request().method() === "PUT");
      const refreshed = page.waitForResponse((response) =>
        response.url().endsWith("/auth/api/users")
        && response.request().method() === "GET");
      await dialog.getByRole("button", { name: "저장", exact: true }).click();
      expect((await saved).status()).toBe(200);
      expect((await refreshed).status()).toBe(200);
      await expectNotification(page, "success", "서비스 권한을 변경했습니다");

      await expect(row.locator(".col-access .badge")).toHaveText(["코스 관리", "인스펙션 운영", "검차 대기 관리", "성적 관리"]);
      const usersResponse = await request.get("/auth/api/users");
      const user = (await usersResponse.json()).find((candidate) => candidate.id === userId);
      expect(user.grants).toEqual(["course.manage", "inspection.operate", "queue.manage", "score.manage"]);
      expect(user.permissions).toEqual([
        "course.manage",
        "course.operate",
        "inspection.operate",
        "queue.manage",
        "queue.operate",
        "score.manage",
        "score.operate",
      ]);
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
      expect((await officialContext.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`)).status()).toBe(200);
      expect((await officialContext.request.post("/competition/api/v1/inspection/sheet/template", {
        data: { name: "must not be created" },
      })).status()).toBe(403);
      expect((await officialContext.request.get("/competition/api/v1/registration/queue")).status()).toBe(403);

      await page.reload();
      await waitForPageReady(page);
      const reloadedRow = page.locator("table.users-table tbody tr").filter({ hasText: email });
      await reloadedRow.getByRole("button", { name: "권한 편집" }).click();
      const reloadedDialog = page.getByRole("dialog", { name: "서비스 권한 편집" });
      await expect(reloadedDialog.getByLabel("검차 대기 권한")).toHaveValue("manage");
      await expect(reloadedDialog.getByLabel("인스펙션 권한")).toHaveValue("operate");
      await expect(reloadedDialog.getByLabel("코스 관리 허용")).toBeChecked();
      await expect(reloadedDialog.getByLabel("성적 관리 허용")).toBeChecked();
    } finally {
      await officialContext?.close();
      if (userId) await request.delete(`/auth/api/users/${userId}`);
    }
  });

  test("admin assigns the same grants to several selected officials at once", async ({ page, request }) => {
    const stamp = `${Date.now()}-${test.info().parallelIndex}`;
    const emails = [`e2e-bulk-access-a-${stamp}@test.com`, `e2e-bulk-access-b-${stamp}@test.com`];
    const studentEmail = `e2e-bulk-access-student-${stamp}@test.com`;
    const ids = [];

    try {
      for (const email of emails) {
        const created = await request.post("/auth/api/users", { data: { email, role: "official" } });
        expect(created.status()).toBe(201);
        ids.push((await created.json()).id);
      }
      const student = await request.post("/auth/api/users", { data: { email: studentEmail, role: "student" } });
      expect(student.status()).toBe(201);
      ids.push((await student.json()).id);
      // One target already holds a grant, so the dialog must open on the common set only.
      expect((await request.put(`/auth/api/users/${ids[0]}/access`, {
        data: { expectedRevision: 0, grants: ["files.access"] },
      })).status()).toBe(200);

      await page.goto("/auth");
      await waitForPageReady(page);
      const rows = [...emails, studentEmail].map((email) =>
        page.locator("table.users-table tbody tr").filter({ hasText: email }));
      for (const row of rows) await row.locator('input[type="checkbox"]').check();

      await page.getByRole("button", { name: "선택 권한 설정 (2)" }).click();
      const dialog = page.getByRole("dialog", { name: "서비스 권한 편집" });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".access-dialog-target")).toHaveText("Official 2명 일괄 설정");
      await expect(dialog.locator(".access-target-list li")).toHaveText(emails);
      await expect(dialog.locator(".access-note")).toHaveText([
        "Official이 아닌 1명은 제외되었습니다.",
        /공통 권한만 표시되며/,
      ]);
      await expect(dialog.getByLabel("파일 클라우드 허용")).not.toBeChecked();

      await dialog.getByLabel("검차 대기 권한").selectOption("operate");
      await dialog.getByLabel("일정 관리 허용").check();
      const saved = page.waitForResponse((response) =>
        response.url().endsWith("/auth/api/users/bulk/access") && response.request().method() === "PUT");
      await dialog.getByRole("button", { name: "저장", exact: true }).click();
      expect((await saved).status()).toBe(200);
      await expectNotification(page, "success", "2명의 서비스 권한을 변경했습니다");

      for (const row of rows.slice(0, 2)) {
        await expect(row.locator(".col-access .badge")).toHaveText(["일정 관리", "검차 대기 운영"]);
      }
      await expect(rows[2].locator(".col-access")).toHaveText("-");
      const users = await (await request.get("/auth/api/users")).json();
      for (const id of ids.slice(0, 2)) {
        const user = users.find((candidate) => candidate.id === id);
        expect(user.grants).toEqual(["calendar.manage", "queue.operate"]);
      }
      expect(users.find((candidate) => candidate.id === ids[0]).accessRevision).toBe(2);
      expect(users.find((candidate) => candidate.id === ids[1]).accessRevision).toBe(1);
    } finally {
      for (const id of ids) await request.delete(`/auth/api/users/${id}`);
    }
  });

  test("admin pairs a registration-only tablet and revokes it immediately", async ({ browser, page, request }) => {
    const name = `E2E Registration Tablet ${Date.now()}-${test.info().parallelIndex}`;
    let deviceId;
    let deviceContext;

    try {
      await page.goto("/auth");
      await waitForPageReady(page);
      await page.getByRole("link", { name: "태블릿 장비 관리" }).click();
      await expect(page).toHaveURL(/\/auth\/devices$/);
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
