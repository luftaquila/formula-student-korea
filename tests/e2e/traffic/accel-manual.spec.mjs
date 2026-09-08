import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import {
  advanceTestClock,
  expectNotification,
  expectNotificationAfter,
  installTestClock,
  setCustomEventName,
  storageStatePath,
  waitForPageReady,
} from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

test.describe("Acceleration manual mode measurement", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath("admin") });
    const page = await context.newPage();
    for (const name of ["E2E-Test", "E2E-Live", "E2E-Live-Race", "E2E-Stale-DNF", "E2E-DNF", "E2E-Reset"]) {
      await page.request.delete(`/competition/api/v1/traffic/records/FSK ${YEAR} ${name}`);
    }
    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await installTestClock(page);
    await page.goto("/traffic/accel");
    await waitForPageReady(page);
  });

  test("enables manual mode and measures a record", async ({ page }) => {
    // Enable manual mode
    const manualToggle = page.getByTestId("manual-mode-toggle");
    await expect(manualToggle).toBeVisible();
    await manualToggle.click();
    await expect(manualToggle).toContainText("매뉴얼 모드 ON");

    // Preset names do not expose a text field; custom names do.
    await expect(page.getByTestId("event-name-option")).toHaveValue("dynamic");
    await expect(page.getByTestId("event-name-custom")).not.toBeVisible();
    await setCustomEventName(page, "E2E-Test");

    // Select team 1
    const teamSelect = page.getByTestId("event-team");
    await teamSelect.selectOption("1");

    // Click green light
    const greenBtn = page.locator("button.btn-success", { hasText: "녹색등" });
    await greenBtn.click();

    // Manual sensor buttons should appear
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await expect(sensor1).toBeVisible();
    await expect(sensor2).toBeVisible();

    // Click sensor 1 (start)
    await sensor1.click();
    await advanceTestClock(page, 500);

    // Click sensor 2 (finish)
    await sensor2.click();

    // Verify record appears with time display
    const savedSection = page.locator(".saved-section");
    await expect(savedSection).toBeVisible({ timeout: 5000 });
    await expect(savedSection).toContainText("측정 기록");

    // Verify saved notification
    await expectNotification(page, "success", "기록 저장");

    // 방금 저장된 행을 화면 이동 없이 편집할 수 있다.
    const quickEdit = page.getByTestId("record-quick-edit");
    await expect(quickEdit).toBeVisible();
    await expect(savedSection.getByTestId("record-quick-edit")).toBeVisible();
    await expect(quickEdit).not.toContainText("변경 즉시 저장");
    await expect(page.getByTestId("quick-save-status")).not.toBeVisible();

    // 서로 다른 필드 저장이 겹치면 모든 요청이 끝나기 전에는 저장 완료를 표시하지 않는다.
    let releaseCones;
    const conesHeld = new Promise((resolve) => { releaseCones = resolve; });
    const failDelayedCones = async (route) => {
      const data = route.request().postDataJSON();
      if (route.request().method() === "PATCH" && data?.field === "cones") {
        await conesHeld;
        await route.fulfill({ status: 503, body: "delayed cone save failed" });
        return;
      }
      await route.continue();
    };
    await page.route("**/competition/api/v1/traffic/records/**", failDelayedCones);
    await page.getByTestId("quick-cones-plus").click();
    await page.getByTestId("quick-oc").fill("2");
    const ocSaved = page.waitForResponse((response) => {
      if (response.request().method() !== "PATCH") return false;
      try { return response.request().postDataJSON()?.field === "oc"; }
      catch { return false; }
    });
    await page.getByTestId("quick-oc").blur();
    await ocSaved;
    await expect(page.getByTestId("quick-oc")).toHaveValue("2");
    await expect(page.getByTestId("quick-save-status")).not.toBeVisible();
    releaseCones();
    await expect(page.getByTestId("quick-cones")).toHaveValue("0");
    await expect(page.getByTestId("quick-save-status")).not.toBeVisible();
    await page.unroute("**/competition/api/v1/traffic/records/**", failDelayedCones);

    await page.getByTestId("quick-cones-plus").click();
    await expect(page.getByTestId("quick-cones")).toHaveValue("1");
    await expect(savedSection.locator(".record-header").getByTestId("quick-save-status")).toHaveText("저장됨");

    const scoreboard = page.getByTestId("quick-scoreboard");
    await scoreboard.click();
    await expect(scoreboard).toContainText("숨김");

    const dsqStatus = page.getByTestId("record-quick-edit").locator('[data-status="DSQ"]');
    let releaseClassification;
    let confirmClassificationContinued;
    const classificationHeld = new Promise((resolve) => { releaseClassification = resolve; });
    const classificationContinued = new Promise((resolve) => { confirmClassificationContinued = resolve; });
    const holdClassification = async (route) => {
      const data = route.request().postDataJSON();
      if (route.request().method() === "PATCH" && data?.field === "status") {
        await classificationHeld;
      }
      await route.continue();
      if (data?.field === "status") confirmClassificationContinued();
    };
    await page.route("**/competition/api/v1/traffic/records/**", holdClassification);
    await dsqStatus.click();
    await expect(dsqStatus).toBeDisabled();
    await expect(scoreboard).toBeDisabled();
    releaseClassification();
    await classificationContinued;
    await page.unroute("**/competition/api/v1/traffic/records/**", holdClassification);
    await expect(dsqStatus).toHaveAttribute("aria-pressed", "true");
    await expect(scoreboard).toBeEnabled();

    // 정상 복원은 판정만 바꾸며 전광판 숨김 상태를 보존한다.
    await page.getByTestId("record-quick-edit").locator('[data-status="normal"]').click();
    await expect(dsqStatus).toHaveAttribute("aria-pressed", "false");
    await expect(scoreboard).toContainText("숨김");
  });

  test("streams a running attempt to the scoreboard until the record is finalized", async ({ page }) => {
    await page.getByTestId("manual-mode-toggle").click();
    await setCustomEventName(page, "E2E-Live");
    await page.getByTestId("event-team").selectOption("1");
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await sensor1.click();

    const scoreboardPage = await page.context().newPage();
    await scoreboardPage.goto("/traffic/scoreboard");
    await waitForPageReady(scoreboardPage);
    const recordFile = `FSK ${YEAR} E2E-Live`;
    const fileSelect = scoreboardPage.getByLabel("기록 파일");
    await expect(fileSelect.locator(`option[value="${recordFile}"]`)).toHaveCount(1);
    await fileSelect.selectOption(recordFile);

    const current = scoreboardPage.getByTestId("current-record-가속");
    await expect(current).toHaveAttribute("data-measuring", "true");
    const liveTimer = scoreboardPage.getByTestId("live-timer-가속");
    const liveTypography = await liveTimer.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontStyle: style.fontStyle,
        fontVariantNumeric: style.fontVariantNumeric,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
      };
    });
    const initial = Number.parseFloat(await liveTimer.innerText());
    await expect.poll(async () => (
      Number.parseFloat(await liveTimer.innerText())
    )).toBeGreaterThan(initial);
    const teamTypography = () => current.locator(".record-team").evaluate((element) => {
      const university = element.querySelector(".university-name");
      const team = element.querySelector(".team-name-text");
      return {
        university: getComputedStyle(university).fontSize,
        team: getComputedStyle(team).fontSize,
        fits: university.scrollWidth <= university.clientWidth && team.scrollWidth <= team.clientWidth,
      };
    });
    const liveTeamTypography = await teamTypography();
    expect(liveTeamTypography.fits).toBe(true);

    await advanceTestClock(page, 500);
    const recordSaved = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().endsWith("/competition/api/v1/traffic/records")
    ));
    await sensor2.click();
    const created = await (await recordSaved).json();
    await expectNotification(page, "success", "기록 저장");
    await expect(current).toHaveAttribute("data-measuring", "false");
    await expect(current).toContainText((created.record.result / 1000).toFixed(3));
    const finalizedTypography = await current.locator(".record-result").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontStyle: style.fontStyle,
        fontVariantNumeric: style.fontVariantNumeric,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
      };
    });
    expect(finalizedTypography).toEqual(liveTypography);
    await expect.poll(teamTypography).toEqual(liveTeamTypography);
    await scoreboardPage.close();
  });

  test("does not let a delayed save stop the next running attempt", async ({ page }) => {
    await page.getByTestId("manual-mode-toggle").click();
    await setCustomEventName(page, "E2E-Live-Race");
    await page.getByTestId("event-team").selectOption("1");
    const green = page.locator("button.btn-success", { hasText: "녹색등" });
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await green.click();
    await sensor1.click();

    let releaseRecordSave;
    let markRecordSaveStarted;
    const recordSaveHeld = new Promise((resolve) => { releaseRecordSave = resolve; });
    const recordSaveStarted = new Promise((resolve) => { markRecordSaveStarted = resolve; });
    const holdRecordSave = async (route) => {
      if (route.request().method() === "POST") {
        markRecordSaveStarted();
        await recordSaveHeld;
      }
      await route.continue();
    };
    await page.route("**/competition/api/v1/traffic/records", holdRecordSave);
    await sensor2.click();
    await recordSaveStarted;

    await page.locator("button.btn-warning.btn-block", { hasText: "초기화" }).click();
    await green.click();
    const nextAttemptStarted = page.waitForResponse((response) => {
      if (!response.url().endsWith("/competition/api/v1/traffic/live-attempts")) return false;
      try { return response.request().postDataJSON()?.action === "start"; }
      catch { return false; }
    });
    await sensor1.click();
    const nextAttemptResponse = await nextAttemptStarted;
    const nextAttemptId = nextAttemptResponse.request().postDataJSON().attempt_id;

    const staleAttemptStopped = page.waitForResponse((response) => {
      if (!response.url().endsWith("/competition/api/v1/traffic/live-attempts")) return false;
      try { return response.request().postDataJSON()?.action === "stop"; }
      catch { return false; }
    });
    releaseRecordSave();
    await staleAttemptStopped;

    const scoreboardPage = await page.context().newPage();
    await scoreboardPage.goto("/traffic/scoreboard");
    await waitForPageReady(scoreboardPage);
    const recordFile = `FSK ${YEAR} E2E-Live-Race`;
    const fileSelect = scoreboardPage.getByLabel("기록 파일");
    await expect(fileSelect.locator(`option[value="${recordFile}"]`)).toHaveCount(1);
    await fileSelect.selectOption(recordFile);
    await expect(scoreboardPage.getByTestId("current-record-가속")).toHaveAttribute("data-measuring", "true");

    const stoppedAttemptResponse = await staleAttemptStopped;
    expect(stoppedAttemptResponse.request().postDataJSON().attempt_id).not.toBe(nextAttemptId);
    await scoreboardPage.close();
    await page.unroute("**/competition/api/v1/traffic/records", holdRecordSave);
    const nextAttemptStopped = page.waitForResponse((response) => {
      if (!response.url().endsWith("/competition/api/v1/traffic/live-attempts")) return false;
      try {
        const body = response.request().postDataJSON();
        return body?.action === "stop" && body.attempt_id === nextAttemptId;
      } catch { return false; }
    });
    await page.locator("button.btn-ghost", { hasText: "OFF" }).click();
    await nextAttemptStopped;
  });

  test("ignores delayed status finalization from the previous run", async ({ page }) => {
    await page.getByTestId("manual-mode-toggle").click();
    await setCustomEventName(page, "E2E-Stale-DNF");
    await page.getByTestId("event-team").selectOption("1");
    const green = page.locator("button.btn-success", { hasText: "녹색등" });
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await green.click();
    await sensor1.click();

    let releaseStatusSave;
    let markStatusSaveStarted;
    const statusSaveHeld = new Promise((resolve) => { releaseStatusSave = resolve; });
    const statusSaveStarted = new Promise((resolve) => { markStatusSaveStarted = resolve; });
    const holdStatusSave = async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON();
      if (body?.data?.status === "DNF") {
        markStatusSaveStarted();
        await statusSaveHeld;
      }
      await route.continue();
    };
    await page.route("**/competition/api/v1/traffic/records", holdStatusSave);
    const statusSaved = page.waitForResponse((response) => {
      if (!response.url().endsWith("/competition/api/v1/traffic/records")) return false;
      try { return response.request().postDataJSON()?.data?.status === "DNF"; }
      catch { return false; }
    });
    await page.locator('.event-status-panel [data-status="DNF"]').click();
    await statusSaveStarted;

    await page.locator("button.btn-warning.btn-block", { hasText: "초기화" }).click();
    await green.click();
    await sensor1.click();
    await advanceTestClock(page, 500);

    releaseStatusSave();
    await statusSaved;
    await expectNotification(page, "success", "DNF 판정을 저장했습니다.");
    await page.unroute("**/competition/api/v1/traffic/records", holdStatusSave);

    const nextRecordSaved = page.waitForResponse((response) => {
      if (!response.url().endsWith("/competition/api/v1/traffic/records")) return false;
      try { return response.request().postDataJSON()?.data?.result > 0; }
      catch { return false; }
    });
    await sensor2.click();
    expect((await nextRecordSaved).status()).toBe(201);
    await expectNotification(page, "success", "기록 저장");
  });

  test("publishes the current event type after a reused route changes", async ({ page }) => {
    await page.getByTestId("manual-mode-toggle").click();
    await page.getByRole("link", { name: /오토크로스/ }).click();
    await expect(page).toHaveURL(/\/traffic\/autocross$/);
    await setCustomEventName(page, "E2E-Reused-Autocross");
    await page.getByTestId("event-team").selectOption("1");
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();

    const attemptStarted = page.waitForResponse((response) => {
      if (!response.url().endsWith("/competition/api/v1/traffic/live-attempts")) return false;
      try { return response.request().postDataJSON()?.action === "start"; }
      catch { return false; }
    });
    await page.getByTestId("manual-sensor-1").click();
    const startedBody = (await attemptStarted).request().postDataJSON();
    expect(startedBody.event_type).toBe("오토크로스");

    const attemptStopped = page.waitForResponse((response) => {
      if (!response.url().endsWith("/competition/api/v1/traffic/live-attempts")) return false;
      try {
        const body = response.request().postDataJSON();
        return body?.action === "stop" && body.attempt_id === startedBody.attempt_id;
      } catch { return false; }
    });
    await page.locator("button.btn-ghost", { hasText: "OFF" }).click();
    const stoppedBody = (await attemptStopped).request().postDataJSON();
    expect(stoppedBody.event_type).toBe("오토크로스");
  });

  test("records DNF when DNF button is clicked", async ({ page }) => {
    // Enable manual mode
    await page.getByTestId("manual-mode-toggle").click();

    // Set event name and select team
    await setCustomEventName(page, "E2E-DNF");
    await page.getByTestId("event-team").selectOption("2");

    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    const liveAttemptStarted = page.waitForResponse((response) => {
      if (!response.url().endsWith("/competition/api/v1/traffic/live-attempts")) return false;
      try { return response.request().postDataJSON()?.action === "start"; }
      catch { return false; }
    });
    await page.getByTestId("manual-sensor-1").click();
    await liveAttemptStarted;
    const scoreboardPage = await page.context().newPage();
    await scoreboardPage.goto("/traffic/scoreboard");
    await waitForPageReady(scoreboardPage);
    const recordFile = `FSK ${YEAR} E2E-DNF`;
    const fileSelect = scoreboardPage.getByLabel("기록 파일");
    await expect(fileSelect.locator(`option[value="${recordFile}"]`)).toHaveCount(1);
    await fileSelect.selectOption(recordFile);
    const current = scoreboardPage.getByTestId("current-record-가속");
    await expect(current).toHaveAttribute("data-measuring", "true");

    const dnfBtn = page.locator('.event-status-panel [data-status="DNF"]');
    await expect(dnfBtn).toBeEnabled();
    await dnfBtn.click();

    // Verify DNF notification
    await expectNotification(page, "success", "DNF 판정을 저장했습니다.");
    await expect(current).toHaveAttribute("data-measuring", "false");
    await expect(current).toContainText("DNF");
    await scoreboardPage.close();
  });

  test("resets and re-measures after reset", async ({ page }) => {
    // Enable manual mode
    await page.getByTestId("manual-mode-toggle").click();

    // Set event name and select team
    await setCustomEventName(page, "E2E-Reset");
    await page.getByTestId("event-team").selectOption("3");

    // First measurement
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");
    await sensor1.click();
    await advanceTestClock(page, 500);
    await sensor2.click();

    // Wait for record to appear
    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("record-quick-edit")).toBeVisible();
    // Click reset button
    const resetBtn = page.locator("button.btn-warning.btn-block", { hasText: "초기화" });
    await resetBtn.click();

    // Saved section should disappear
    await expect(page.locator(".saved-section")).not.toBeVisible();
    await expect(page.getByTestId("record-quick-edit")).not.toBeVisible();

    // Re-measure: click green light again
    await page.locator("button.btn-success", { hasText: "녹색등" }).click();
    await expect(sensor1).toBeVisible();

    await sensor1.click();
    await advanceTestClock(page, 500);
    await expectNotificationAfter(page, "success", "기록 저장", () => sensor2.click());

    // Verify new record appears
    await expect(page.locator(".saved-section")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("record-quick-edit")).toBeVisible();
  });

  test("keeps post-processing on OFF and replaces it for the next record", async ({ page }) => {
    await page.getByTestId("manual-mode-toggle").click();
    await setCustomEventName(page, "E2E-Reset");
    await page.getByTestId("event-team").selectOption("3");

    const green = page.locator("button.btn-success", { hasText: "녹색등" });
    const off = page.locator("button.btn-ghost", { hasText: "OFF" });
    const sensor1 = page.getByTestId("manual-sensor-1");
    const sensor2 = page.getByTestId("manual-sensor-2");

    await green.click();
    await sensor1.click();
    await advanceTestClock(page, 400);
    await sensor2.click();
    await expect(page.getByTestId("record-quick-edit")).toBeVisible({ timeout: 5000 });

    await off.click();
    await expect(page.getByTestId("record-quick-edit")).toBeVisible();

    await green.click();
    await expect(page.getByTestId("record-quick-edit")).not.toBeVisible();
    await sensor1.click();
    await advanceTestClock(page, 400);
    await sensor2.click();
    await expect(page.getByTestId("record-quick-edit")).toBeVisible({ timeout: 5000 });
  });
});
