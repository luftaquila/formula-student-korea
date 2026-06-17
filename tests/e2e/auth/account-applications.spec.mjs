import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, expectNotification } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";
import { createJWT } from "../../../shared/express-setup.mjs";

const JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";
const APPLICANT = { email: "e2e-applicant@test.com", name: "E2E 신청자" };
const APPLICANT2 = { email: "e2e-applicant2@test.com", name: "E2E 신청자2" };

const adminHeaders = () => ({ "Content-Type": "application/json", Cookie: getAuthCookie("admin") });

function applicantToken(user) {
  return createJWT({ email: user.email, name: user.name, applicant: true }, JWT_SECRET, 3600);
}

async function setIntake(open) {
  await fetch(`${BASE_URL}/auth/api/applications/config`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify({ open }),
  });
}

async function seedApplication(user, body) {
  await fetch(`${BASE_URL}/auth/api/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `fsk_applicant=${applicantToken(user)}` },
    body: JSON.stringify(body),
  });
}

async function deleteUsers(emails) {
  const users = await (await fetch(`${BASE_URL}/auth/api/users`, { headers: { Cookie: getAuthCookie("admin") } })).json();
  const ids = users.filter((u) => emails.includes(u.email)).map((u) => u.id);
  if (ids.length) {
    await fetch(`${BASE_URL}/auth/api/users/bulk`, {
      method: "DELETE",
      headers: adminHeaders(),
      body: JSON.stringify({ ids }),
    });
  }
}

// Approve away any leftover applications (no delete-application endpoint), then drop the users.
// Keeps the suite idempotent across reruns/retries.
async function cleanup(emails) {
  const apps = await (await fetch(`${BASE_URL}/auth/api/applications`, { headers: { Cookie: getAuthCookie("admin") } })).json();
  const ids = apps.filter((a) => emails.includes(a.email)).map((a) => a.id);
  if (ids.length) {
    await fetch(`${BASE_URL}/auth/api/applications/approve`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ ids, role: "student" }),
    });
  }
  await deleteUsers(emails);
}

// ─── Admin: 계정 신청 관리 ──────────────────────────────────────────────────
test.describe("Account applications - admin", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStatePath("admin") });

  test.beforeAll(async () => {
    await cleanup([APPLICANT.email]);
    await setIntake(true);
    await seedApplication(APPLICANT, { realname: "신청자", phone: "010-1111-2222", affiliation: "테스트대 FSAE" });
  });

  test.afterAll(async () => {
    await cleanup([APPLICANT.email]);
    await setIntake(false);
  });

  test("enter the applications page from 계정 관리", async ({ page }) => {
    await page.goto("/auth");
    await waitForPageReady(page);
    await page.getByRole("link", { name: "계정 신청 관리" }).click();
    await expect(page).toHaveURL(/\/auth\/applications/);
  });

  test("pending application is listed with its affiliation", async ({ page }) => {
    await page.goto("/auth/applications");
    await waitForPageReady(page);
    const row = page.locator("tr").filter({ hasText: APPLICANT.email });
    await expect(row).toBeVisible();
    await expect(row.locator("td").filter({ hasText: "테스트대 FSAE" })).toBeVisible();
    await expect(page.locator(".open-toggle input[type='checkbox']")).toBeChecked();
  });

  test("bulk approve moves the applicant into accounts and clears the list", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await page.goto("/auth/applications");
    await waitForPageReady(page);

    const row = page.locator("tr").filter({ hasText: APPLICANT.email });
    await row.locator("input[type='checkbox']").check();
    await page.locator("select.role-select").selectOption("student");
    await page.getByRole("button", { name: /선택 계정 추가/ }).click();

    await expectNotification(page, "success", "추가");
    await expect(page.locator("td").filter({ hasText: APPLICANT.email })).toHaveCount(0);

    // Now present in the user list as a student, with the affiliation copied over.
    await page.goto("/auth");
    await waitForPageReady(page);
    const urow = page.locator("tr").filter({ hasText: APPLICANT.email });
    await expect(urow).toBeVisible();
    await expect(urow.locator(".badge").filter({ hasText: "student" })).toBeVisible();
    await expect(urow.locator(".col-affiliation .inline-edit-text")).toHaveText("테스트대 FSAE");
  });

  test("toggle intake off and on", async ({ page }) => {
    await page.goto("/auth/applications");
    await waitForPageReady(page);
    const label = page.locator(".open-toggle");
    const checkbox = page.locator(".open-toggle input[type='checkbox']");

    await expect(checkbox).toBeChecked();
    await label.click();
    await expectNotification(page, "success", "받지 않");
    await expect(checkbox).not.toBeChecked();
    await label.click();
    await expectNotification(page, "success", "받습니다");
    await expect(checkbox).toBeChecked();
  });
});

// ─── Applicant: 신청 페이지 ─────────────────────────────────────────────────
test.describe("Account applications - applicant page", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    await cleanup([APPLICANT2.email]);
    await setIntake(true);
  });

  test.afterAll(async () => {
    await cleanup([APPLICANT2.email]);
    await setIntake(false);
  });

  async function asApplicant(page, user) {
    await page.context().addCookies([
      { name: "fsk_applicant", value: applicantToken(user), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
  }

  test("new applicant sees the form and submits", async ({ page }) => {
    await asApplicant(page, APPLICANT2);
    await page.goto("/auth/apply");
    await waitForPageReady(page);

    await page.getByPlaceholder("홍길동").fill("이신청");
    await page.getByPlaceholder("010-1234-5678").fill("01099998888");
    await page.getByPlaceholder("한국대학교 FSAE").fill("E2E대 FSAE");
    await page.getByRole("button", { name: "신청하기" }).click();

    await expectNotification(page, "success", "신청했습니다");
    await expect(page.locator(".badge").filter({ hasText: "검토 대기" })).toBeVisible();
  });

  test("returning applicant sees pending status and can edit", async ({ page }) => {
    await asApplicant(page, APPLICANT2);
    await page.goto("/auth/apply");
    await waitForPageReady(page);

    await expect(page.locator(".badge").filter({ hasText: "검토 대기" })).toBeVisible();
    await page.getByPlaceholder("한국대학교 FSAE").fill("E2E대 BAJA");
    await page.getByRole("button", { name: "수정하기" }).click();
    await expectNotification(page, "success", "수정했습니다");
  });

  test("a registered user sees the already-registered message", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "fsk_session",
        value: createJWT({ email: "e2e-student@test.com", name: "E2E Student", role: "student" }, JWT_SECRET),
        domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax",
      },
    ]);
    await page.goto("/auth/apply");
    await waitForPageReady(page);
    await expect(page.getByText("이미 등록된 계정입니다")).toBeVisible();
  });

  test("closed intake shows the closed message", async ({ page }) => {
    await setIntake(false);
    await asApplicant(page, APPLICANT2);
    await page.goto("/auth/apply");
    await waitForPageReady(page);
    await expect(page.getByText("지금은 신청을 받지 않습니다")).toBeVisible();
    await setIntake(true);
  });
});
