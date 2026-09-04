import { test, expect } from "@playwright/test";
import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { getAuthCookie } from "../helpers/auth.mjs";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();
const ENTRY_NUMBER = 30;
const PHONE = "01024681357";
const PREFIX = "/competition/api/v1/registration";

async function registrationRequest(request, role, method, path, data) {
  return request.fetch(`${PREFIX}${path}`, {
    method,
    headers: { Cookie: getAuthCookie(role) },
    ...(data === undefined ? {} : { data }),
  });
}

async function clearActiveQueue(request) {
  const queue = await registrationRequest(request, "operationsOperator", "GET", `/queue?year=${YEAR}`);
  if (!queue.ok()) return;
  const body = await queue.json();
  for (const row of body.waiting) {
    const response = await registrationRequest(request, "operationsOperator", "POST", `/queue/${row.id}/cancel`);
    expect([200, 409]).toContain(response.status());
  }
}

test.describe("Registration queue", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ request }) => {
    await clearActiveQueue(request);
    const opened = await registrationRequest(request, "operationsManager", "PATCH", "/settings", {
      year: YEAR,
      open: true,
      sms: false,
      notifyRank: 3,
    });
    expect(opened.status()).toBe(200);
  });

  test.afterEach(async ({ request }) => {
    await clearActiveQueue(request);
    const closed = await registrationRequest(request, "operationsManager", "PATCH", "/settings", {
      year: YEAR,
      open: false,
      sms: false,
    });
    expect(closed.status()).toBe(200);
  });

  test("runs manager registration, public lookup, and operator processing in real time", async ({ browser }) => {
    const managerContext = await browser.newContext({ storageState: storageStatePath("operationsManager") });
    const publicContext = await browser.newContext();
    const officialContext = await browser.newContext({ storageState: storageStatePath("operationsOperator") });
    const managerPage = await managerContext.newPage();
    const publicPage = await publicContext.newPage();
    const officialPage = await officialContext.newPage();

    try {
      await managerPage.setViewportSize({ width: 1024, height: 768 });
      const managerStatus = managerPage.waitForResponse((response) =>
        response.url().includes(`${PREFIX}/status`) && response.status() === 200);
      await managerPage.goto("/registration/register");
      await waitForPageReady(managerPage);
      await managerStatus;

      await managerPage.locator("#register-number").fill(String(ENTRY_NUMBER));
      await expect(managerPage.locator(".team-badge")).toContainText("부산대학교 PNU Racing");
      await managerPage.locator("#register-phone").fill(PHONE);
      await managerPage.locator(".consent-card").click();

      const registered = managerPage.waitForResponse((response) =>
        response.url().endsWith(`${PREFIX}/queue`) && response.request().method() === "POST");
      await managerPage.getByRole("button", { name: "대기 등록", exact: true }).click();
      expect((await registered).status()).toBe(201);
      await expect(managerPage.getByText(`엔트리 ${ENTRY_NUMBER}번을 1번째 대기로 등록했습니다.`)).toBeVisible();
      await expect(managerPage.locator("#register-number")).toHaveValue("");
      await expect(managerPage.locator("#register-phone")).toHaveValue("010");

      const publicSse = publicPage.waitForResponse((response) => response.url().includes(`${PREFIX}/events`));
      await publicPage.goto("/registration");
      await waitForPageReady(publicPage);
      await publicSse;
      await expect(publicPage.locator("#lookup-phone")).toHaveValue("010");
      await publicPage.locator("#lookup-number").fill(String(ENTRY_NUMBER));
      await expect(publicPage.locator(".query-card .team-badge")).toContainText("PNU Racing");
      await publicPage.locator("#lookup-phone").fill(PHONE);
      const lookedUp = publicPage.waitForResponse((response) =>
        response.url().endsWith(`${PREFIX}/lookup`) && response.request().method() === "POST");
      await publicPage.getByRole("button", { name: "조회", exact: true }).click();
      expect((await lookedUp).status()).toBe(200);
      await expect(publicPage.locator(".result-card")).toContainText("1번째");
      await expect(publicPage.locator(".result-card .result-total")).toContainText("1팀");
      await expect(publicPage.locator(".result-card")).not.toContainText("PNU Racing");
      await expect(publicPage.locator(".queue-total")).toHaveCount(0);

      const officialSse = officialPage.waitForResponse((response) => response.url().includes(`${PREFIX}/events`));
      await officialPage.goto("/registration/manage");
      await waitForPageReady(officialPage);
      await officialSse;
      const waitingRow = officialPage.locator("tbody tr").filter({ hasText: "PNU Racing" });
      await expect(waitingRow).toContainText("010-2468-1357");

      const refreshedLookup = publicPage.waitForResponse((response) =>
        response.url().endsWith(`${PREFIX}/lookup`) && response.request().method() === "POST");
      const completed = officialPage.waitForResponse((response) =>
        response.url().includes(`${PREFIX}/queue/`) && response.url().endsWith("/done"));
      await waitingRow.getByRole("button", { name: "완료", exact: true }).click();
      expect((await completed).status()).toBe(200);
      await expect(officialPage.locator(".summary-card").filter({ hasText: "오늘 완료" })).toContainText(/[1-9]\d*/);
      expect((await refreshedLookup).status()).toBe(404);
      await expect(publicPage.locator(".result-card")).toContainText("대기 중인 등록 내역이 없습니다.");
      await expect(publicPage.locator(".query-card")).not.toContainText("대기 중인 등록 내역이 없습니다.");
    } finally {
      await Promise.all([managerContext.close(), publicContext.close(), officialContext.close()]);
    }
  });

  test("keeps manager settings and kiosk registration unavailable to operators", async ({ browser, request }) => {
    const context = await browser.newContext({ storageState: storageStatePath("operationsOperator") });
    const page = await context.newPage();
    try {
      await page.goto("/registration/manage");
      await waitForPageReady(page);
      await expect(page.getByRole("heading", { name: "설정" })).toHaveCount(0);
      await expect(page.getByText(/Chief|Official/)).toHaveCount(0);

      await page.goto("/registration/register");
      await expect(page).not.toHaveURL(/\/registration\/register/);

      const teams = await request.get(`/competition/api/v1/teams?year=${YEAR}`);
      const team = (await teams.json()).find((item) => item.number === ENTRY_NUMBER);
      const create = await registrationRequest(request, "operationsOperator", "POST", "/queue", {
        teamId: team.id,
        phone: PHONE,
      });
      expect(create.status()).toBe(403);
      const settings = await registrationRequest(request, "operationsOperator", "PATCH", "/settings", {
        year: YEAR,
        open: false,
      });
      expect(settings.status()).toBe(403);
    } finally {
      await context.close();
    }
  });

  test("rolls a setting toggle back when the PATCH is rejected", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("operationsManager") });
    const page = await context.newPage();
    try {
      await page.route(`**${PREFIX}/settings`, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ code: "TEST_REJECTION", message: "설정을 저장하지 못했습니다." }),
        });
      });
      await page.goto("/registration/manage");
      await waitForPageReady(page);

      const receptionToggle = page.locator(".settings-panel input[type=checkbox]").first();
      await expect(receptionToggle).toBeChecked();
      const rejectedPatch = page.waitForResponse((response) =>
        response.url().endsWith(`${PREFIX}/settings`)
        && response.request().method() === "PATCH"
        && response.status() === 400);
      await receptionToggle.locator("..").click();
      await rejectedPatch;
      await expect(page.getByText("설정을 저장하지 못했습니다.")).toBeVisible();
      await expect(receptionToggle).toBeChecked();
    } finally {
      await context.close();
    }
  });

  test("does not reveal a queue record when the public phone credential is wrong", async ({ request }) => {
    const teams = await request.get(`/competition/api/v1/teams?year=${YEAR}`);
    const team = (await teams.json()).find((item) => item.number === ENTRY_NUMBER);
    const create = await registrationRequest(request, "operationsManager", "POST", "/queue", {
      teamId: team.id,
      phone: PHONE,
    });
    expect(create.status()).toBe(201);

    const lookup = await request.post(`${PREFIX}/lookup`, {
      data: { year: YEAR, num: ENTRY_NUMBER, phone: "01000000000" },
    });
    expect(lookup.status()).toBe(404);
    const body = await lookup.json();
    expect(body).toEqual({
      code: "REGISTRATION_NOT_FOUND",
      message: "대기 중인 등록 내역이 없습니다.",
    });
  });
});
