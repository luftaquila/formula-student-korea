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
  const queue = await registrationRequest(request, "official", "GET", `/queue?year=${YEAR}`);
  if (!queue.ok()) return;
  const body = await queue.json();
  for (const row of body.waiting) {
    const response = await registrationRequest(request, "official", "POST", `/queue/${row.id}/cancel`);
    expect([200, 409]).toContain(response.status());
  }
}

test.describe("Registration queue", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ request }) => {
    await clearActiveQueue(request);
    const opened = await registrationRequest(request, "chief", "PATCH", "/settings", {
      year: YEAR,
      open: true,
      sms: false,
      notifyRank: 3,
    });
    expect(opened.status()).toBe(200);
  });

  test.afterEach(async ({ request }) => {
    await clearActiveQueue(request);
    const closed = await registrationRequest(request, "chief", "PATCH", "/settings", {
      year: YEAR,
      open: false,
      sms: false,
    });
    expect(closed.status()).toBe(200);
  });

  test("runs the chief registration, public lookup, and official processing flow in real time", async ({ browser }) => {
    const chiefContext = await browser.newContext({ storageState: storageStatePath("chief") });
    const publicContext = await browser.newContext();
    const officialContext = await browser.newContext({ storageState: storageStatePath("official") });
    const chiefPage = await chiefContext.newPage();
    const publicPage = await publicContext.newPage();
    const officialPage = await officialContext.newPage();

    try {
      await chiefPage.setViewportSize({ width: 1024, height: 768 });
      const chiefStatus = chiefPage.waitForResponse((response) =>
        response.url().includes(`${PREFIX}/status`) && response.status() === 200);
      await chiefPage.goto("/registration/register");
      await waitForPageReady(chiefPage);
      await chiefStatus;

      await chiefPage.locator("#register-number").fill(String(ENTRY_NUMBER));
      await expect(chiefPage.locator(".team-badge")).toContainText("부산대학교 PNU Racing");
      await chiefPage.locator("#register-phone").fill(PHONE);
      await chiefPage.locator(".consent-card").click();
      const consentBox = await chiefPage.locator(".agreement-group").boundingBox();
      const actionsBox = await chiefPage.locator(".submit-group").boundingBox();
      expect(consentBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      expect(actionsBox.y - (consentBox.y + consentBox.height)).toBeLessThanOrEqual(32);

      const registered = chiefPage.waitForResponse((response) =>
        response.url().endsWith(`${PREFIX}/queue`) && response.request().method() === "POST");
      await chiefPage.getByRole("button", { name: "대기 등록", exact: true }).click();
      expect((await registered).status()).toBe(201);
      await expect(chiefPage.getByText(`엔트리 ${ENTRY_NUMBER}번을 1번째 대기로 등록했습니다.`)).toBeVisible();
      await expect(chiefPage.locator("#register-number")).toHaveValue("");
      await expect(chiefPage.locator("#register-phone")).toHaveValue("010");

      const publicSse = publicPage.waitForResponse((response) => response.url().includes(`${PREFIX}/events`));
      await publicPage.goto("/registration");
      await waitForPageReady(publicPage);
      await publicSse;
      await expect(publicPage.locator("#lookup-phone")).toHaveValue("010");
      await publicPage.locator("#lookup-number").fill(String(ENTRY_NUMBER));
      await expect(publicPage.locator(".query-card .team-badge")).toContainText("PNU Racing");
      const queryCardBox = await publicPage.locator(".query-card").boundingBox();
      const lookupButtonBox = await publicPage.locator(".query-card button[type=submit]").boundingBox();
      expect(queryCardBox).not.toBeNull();
      expect(lookupButtonBox).not.toBeNull();
      expect(queryCardBox.y + queryCardBox.height - (lookupButtonBox.y + lookupButtonBox.height))
        .toBeLessThanOrEqual(24);
      await publicPage.locator("#lookup-phone").fill(PHONE);
      const lookedUp = publicPage.waitForResponse((response) =>
        response.url().endsWith(`${PREFIX}/lookup`) && response.request().method() === "POST");
      await publicPage.getByRole("button", { name: "내 순번 조회" }).click();
      expect((await lookedUp).status()).toBe(200);
      await expect(publicPage.locator(".result-card")).toContainText("1번째");
      await expect(publicPage.locator(".result-card")).not.toContainText("PNU Racing");

      const officialSse = officialPage.waitForResponse((response) => response.url().includes(`${PREFIX}/events`));
      await officialPage.goto("/registration/manage");
      await waitForPageReady(officialPage);
      await officialSse;
      const waitingRow = officialPage.locator("tbody tr").filter({ hasText: "PNU Racing" });
      await expect(waitingRow).toContainText("010-2468-1357");

      const completed = officialPage.waitForResponse((response) =>
        response.url().includes(`${PREFIX}/queue/`) && response.url().endsWith("/done"));
      await waitingRow.getByRole("button", { name: "완료", exact: true }).click();
      expect((await completed).status()).toBe(200);
      await expect(officialPage.locator(".summary-card").filter({ hasText: "오늘 완료" })).toContainText(/[1-9]\d*/);
      await expect(publicPage.locator(".result-card")).toContainText("대기 중인 등록 내역이 없습니다.");
      await expect(publicPage.locator(".query-card")).not.toContainText("대기 중인 등록 내역이 없습니다.");
    } finally {
      await Promise.all([chiefContext.close(), publicContext.close(), officialContext.close()]);
    }
  });

  test("keeps chief settings and kiosk registration unavailable to official users", async ({ browser, request }) => {
    const context = await browser.newContext({ storageState: storageStatePath("official") });
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
      const create = await registrationRequest(request, "official", "POST", "/queue", {
        teamId: team.id,
        phone: PHONE,
      });
      expect(create.status()).toBe(403);
      const settings = await registrationRequest(request, "official", "PATCH", "/settings", {
        year: YEAR,
        open: false,
      });
      expect(settings.status()).toBe(403);
    } finally {
      await context.close();
    }
  });

  test("does not reveal a queue record when the public phone credential is wrong", async ({ request }) => {
    const teams = await request.get(`/competition/api/v1/teams?year=${YEAR}`);
    const team = (await teams.json()).find((item) => item.number === ENTRY_NUMBER);
    const create = await registrationRequest(request, "chief", "POST", "/queue", {
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
