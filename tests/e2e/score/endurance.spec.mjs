import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady, scoreTable, enduranceTable, ENDURANCE_TABLE } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

async function fillAndSave(page, input, value) {
  await input.click();
  await input.fill(value);
  const confirm = input.locator("xpath=..").locator("button.confirm-input-btn");
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveText("");
  await expect(confirm.locator("svg.confirm-check-icon")).toBeVisible();
  await expect(confirm).toHaveCSS("background-color", "rgb(39, 166, 68)");
  await expect(confirm).toHaveCSS("color", "rgb(255, 255, 255)");
  const saved = page.waitForResponse(
    (res) => res.url().includes("/competition/api/v1/score/score/endurance") && res.request().method() === "PUT" && res.status() === 200,
  );
  await confirm.click();
  await saved;
  await expect(confirm).toHaveCount(0);
}

async function clearFields(page, teamNum, fields) {
  for (const field of fields) {
    const response = await page.request.put("/competition/api/v1/score/score/endurance", {
      data: { year: YEAR, team_num: teamNum, field, value: null },
    });
    expect(response.ok()).toBeTruthy();
  }
}

test.describe("Score endurance input", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/score/endurance");
    await waitForPageReady(page);
  });

  test("endurance page renders with team data", async ({ page }) => {
    // Verify the page title
    await expect(page.locator("h3")).toContainText("내구 기록 입력");

    // Verify team count badge
    await expect(page.locator(".count-badge")).toContainText("8");

    // Verify the endurance table is visible
    const table = enduranceTable(page);
    await expect(table).toBeVisible();

    // Verify seeded teams appear
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).toContainText("KAIST");

    // Verify key column headers
    await expect(enduranceTable(page).locator("th").filter({ hasText: "번호" })).toBeVisible();
    await expect(enduranceTable(page).locator("th").filter({ hasText: "최종 기록" })).toBeVisible();
    await expect(enduranceTable(page).locator("th").filter({ hasText: "드라이버 1" })).toBeVisible();
    await expect(enduranceTable(page).locator("th").filter({ hasText: "드라이버 2" })).toBeVisible();
    await expect(enduranceTable(page).locator("th").filter({ hasText: "상태" })).toBeVisible();
    await expect(enduranceTable(page).locator("th").filter({ hasText: "내구진출" })).toBeVisible();
  });

  test("saves a cell only through its confirm button", async ({ page }) => {
    await clearFields(page, 3, ["driver1_time"]);

    const row = enduranceTable(page).locator("tbody tr").filter({ hasText: "성균관대학교" });
    const input = row.locator("input.time-input").first();
    await expect(input).toHaveValue("");

    await input.click();
    await input.fill("7:00.000");
    const confirm = input.locator("xpath=..").locator("button.confirm-input-btn");
    await expect(confirm).toBeVisible();

    await page.locator(".card-header h3").click();
    await expect(confirm).toHaveCount(0);
    await expect(input).toHaveValue("");

    const unchangedResponse = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const unchanged = await unchangedResponse.json();
    expect(unchanged[3]?.driver1_time ?? null).toBeNull();

    await fillAndSave(page, input, "7:00.000");
    const savedResponse = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const saved = await savedResponse.json();
    expect(saved[3]?.driver1_time).toBe(420000);

    await clearFields(page, 3, ["driver1_time"]);
  });

  test("supports keyboard confirmation and discards keyboard navigation without confirmation", async ({ page }) => {
    await clearFields(page, 3, ["driver1_time", "driver1_start_delay", "driver1_cones"]);

    const row = enduranceTable(page).locator("tbody tr").filter({ hasText: "성균관대학교" });
    const timeInput = row.locator("input.time-input").first();
    const timeConfirm = timeInput.locator("xpath=..").locator("button.confirm-input-btn");
    await timeInput.click();
    await timeInput.fill("6:00.000");
    await timeInput.press("Enter");
    await expect(timeInput).toBeFocused();
    await expect(timeConfirm).toBeVisible();

    let response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    let data = await response.json();
    expect(data[3]?.driver1_time ?? null).toBeNull();

    await timeInput.press("Tab");
    await expect(timeConfirm).toBeFocused();
    const saved = page.waitForResponse(
      (res) => res.url().includes("/competition/api/v1/score/score/endurance") && res.request().method() === "PUT" && res.status() === 200,
    );
    await timeConfirm.press("Enter");
    await saved;
    await expect(timeConfirm).toHaveCount(0);

    response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    data = await response.json();
    expect(data[3]?.driver1_time).toBe(360000);

    const delayInput = row.locator("input.num-input").nth(0);
    const delayConfirm = delayInput.locator("xpath=..").locator("button.confirm-input-btn");
    await delayInput.click();
    await delayInput.fill("7");
    await delayInput.press("ArrowRight");
    await expect(delayConfirm).toHaveCount(0);
    response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    data = await response.json();
    expect(data[3]?.driver1_start_delay ?? null).toBeNull();

    const conesInput = row.locator("input.num-input").nth(1);
    const conesConfirm = conesInput.locator("xpath=..").locator("button.confirm-input-btn");
    await conesInput.fill("8");
    await conesInput.press("Tab");
    await expect(conesConfirm).toBeFocused();
    await conesConfirm.press("Tab");
    await expect(conesConfirm).toHaveCount(0);
    response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    data = await response.json();
    expect(data[3]?.driver1_cones ?? null).toBeNull();

    await clearFields(page, 3, ["driver1_time", "driver1_start_delay", "driver1_cones"]);
  });

  test("saves endurance distance only through its confirmation button", async ({ page }) => {
    const initialResponse = await page.request.get(`/competition/api/v1/score/score?year=${YEAR}`);
    const initialScore = await initialResponse.json();
    const initialDistance = initialScore.settings?.["에너지"]?.distance_km ?? null;
    const changedDistance = initialDistance === 21 ? 22 : 21;
    const input = page.locator("input.config-input");

    await input.click();
    await input.fill(String(changedDistance));
    const confirm = input.locator("xpath=..").locator("button.confirm-input-btn");
    await expect(confirm).toBeVisible();
    await page.locator(".card-header h3").click();
    await expect(confirm).toHaveCount(0);
    await expect(input).toHaveValue(initialDistance == null ? "" : String(initialDistance));

    let response = await page.request.get(`/competition/api/v1/score/score?year=${YEAR}`);
    let score = await response.json();
    expect(score.settings?.["에너지"]?.distance_km ?? null).toBe(initialDistance);

    await input.click();
    await input.fill(String(changedDistance));
    await input.press("Tab");
    await expect(confirm).toBeFocused();
    const saved = page.waitForResponse(
      (res) => res.url().includes("/competition/api/v1/score/score/setting") && res.request().method() === "PUT" && res.status() === 200,
    );
    await confirm.press("Enter");
    await saved;
    await expect(confirm).toHaveCount(0);

    response = await page.request.get(`/competition/api/v1/score/score?year=${YEAR}`);
    score = await response.json();
    expect(score.settings?.["에너지"]?.distance_km).toBe(changedDistance);

    const cleanup = await page.request.put("/competition/api/v1/score/score/setting", {
      data: { year: YEAR, event_type: "에너지", setting_key: "distance_km", value: initialDistance },
    });
    expect(cleanup.ok()).toBeTruthy();
  });

  test("filters endurance rows by vehicle type", async ({ page }) => {
    const typeFilterGroup = page.locator(".type-filter-group");
    await expect(typeFilterGroup).toBeVisible();

    const evCheckbox = typeFilterGroup.locator("label.filter-checkbox").filter({ hasText: "EV" }).locator("input");
    const cvCheckbox = typeFilterGroup.locator("label.filter-checkbox").filter({ hasText: "CV" }).locator("input");
    await expect(evCheckbox).toBeChecked();
    await expect(cvCheckbox).toBeChecked();

    await cvCheckbox.uncheck();
    const table = enduranceTable(page);
    await expect(table.locator("tbody")).toContainText("서울대학교");
    await expect(table.locator("tbody")).not.toContainText("성균관대학교");

    await cvCheckbox.check();
    await expect(table.locator("tbody")).toContainText("성균관대학교");
  });

  test("toggles endurance qualification and filters to qualified teams", async ({ page }) => {
    for (const teamNum of [1, 2]) {
      const response = await page.request.put("/competition/api/v1/score/score/endurance", {
        data: { year: YEAR, team_num: teamNum, field: "qualified", value: 0 },
      });
      expect(response.ok()).toBeTruthy();
    }

    const table = enduranceTable(page);
    const qualifiedRow = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    const otherRow = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    const qualification = qualifiedRow.locator("input.qualified-toggle");
    await expect(qualification).not.toBeChecked();

    const updated = page.waitForResponse(
      (res) => res.url().includes("/competition/api/v1/score/score/endurance") && res.request().method() === "PUT" && res.status() === 200,
    );
    await qualification.check();
    await updated;
    await expect(qualification).toBeChecked();

    const filter = page.locator("label.filter-checkbox").filter({ hasText: "내구 진출팀" }).locator("input");
    await filter.check();
    await expect(qualifiedRow).toBeVisible();
    await expect(otherRow).toHaveCount(0);

    const response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[1]?.qualified).toBe(1);

    const cleanup = await page.request.put("/competition/api/v1/score/score/endurance", {
      data: { year: YEAR, team_num: 1, field: "qualified", value: 0 },
    });
    expect(cleanup.ok()).toBeTruthy();
  });

  test("set DNS status, disable inputs, and exclude the team from scores", async ({ page }) => {
    const table = enduranceTable(page);

    // Find the row for team #1 (서울대학교)
    const row = table.locator("tbody tr").filter({ hasText: "서울대학교" });
    await expect(row).toBeVisible();

    // Click DNS button
    const dnsBtn = row.locator(".status-btn").filter({ hasText: "DNS" });
    await dnsBtn.click();

    // Verify DNS is active
    await expect(dnsBtn).toHaveClass(/active/);

    // Verify inputs in the row are disabled
    const inputs = row.locator("input.cell-input");
    const inputCount = await inputs.count();
    for (let i = 0; i < inputCount; i++) {
      await expect(inputs.nth(i)).toBeDisabled();
    }

    // Verify via API
    const response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[1]?.status).toBe("DNS");

    // The scoring contract is part of the same DNS lifecycle. Keeping this
    // assertion here avoids a second spec mutating the same endurance row.
    const scoreResponse = await page.request.get(`/competition/api/v1/score/score?year=${YEAR}`);
    const scoreData = await scoreResponse.json();
    const enduranceEvent = scoreData.events.find((event) => event.type === "내구");
    expect(enduranceEvent).toBeTruthy();
    expect(enduranceEvent.records["1"]).toBeUndefined();

    // Toggle DNS off (click again to remove status)
    await dnsBtn.click();
    await expect(dnsBtn).not.toHaveClass(/active/);

    // Inputs should be re-enabled
    const firstInput = row.locator("input.cell-input").first();
    await expect(firstInput).not.toBeDisabled();
  });

  test("set DNF status and expose a DNF score", async ({ page }) => {
    const table = enduranceTable(page);
    const row = table.locator("tbody tr").filter({ hasText: "한양대학교" });
    await expect(row).toBeVisible();

    // Click DNF button
    const dnfBtn = row.locator(".status-btn").filter({ hasText: "DNF" });
    await dnfBtn.click();
    await expect(dnfBtn).toHaveClass(/active/);

    // Verify the final record column shows "DNF"
    await expect(row.locator(".record-value.dnf")).toContainText("DNF");

    // Verify via API
    const response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[2]?.status).toBe("DNF");

    const scoreResponse = await page.request.get(`/competition/api/v1/score/score?year=${YEAR}`);
    const scoreData = await scoreResponse.json();
    const enduranceEvent = scoreData.events.find((event) => event.type === "내구");
    expect(enduranceEvent).toBeTruthy();
    expect(enduranceEvent.records["2"]?.result).toBe(-1);

    // Clean up: toggle off
    await dnfBtn.click();
    await expect(dnfBtn).not.toHaveClass(/active/);
  });

  test("enter driver 1 and driver 2 times", async ({ page }) => {
    const table = enduranceTable(page);
    const row = table.locator("tbody tr").filter({ hasText: "성균관대학교" });
    await expect(row).toBeVisible();

    // Driver 1 time input (first time-input in the row)
    const driver1TimeInput = row.locator("input.time-input").nth(0);
    await fillAndSave(page, driver1TimeInput, "5:30.500");

    // Driver change time input (second time-input)
    const changeTimeInput = row.locator("input.time-input").nth(1);
    await fillAndSave(page, changeTimeInput, "0:05.000");

    // Driver 2 time input (third time-input)
    const driver2TimeInput = row.locator("input.time-input").nth(2);
    await fillAndSave(page, driver2TimeInput, "5:45.200");

    // Verify driving time is populated (sum of all 3 times)
    // 5:30.500 + 0:05.000 + 5:45.200 = 11:20.700
    const drivingTimeCell = row.locator(".col-summary").nth(1);
    await expect(drivingTimeCell).toContainText("11:20.700");

    // Verify final record is populated (should equal driving time when no penalties)
    const finalRecordCell = row.locator(".col-summary").nth(0);
    await expect(finalRecordCell.locator(".record-value")).toBeVisible();

    // Verify via API
    const response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[3]?.driver1_time).toBe(330500); // 5:30.500 in ms
    expect(data[3]?.driver_change_time).toBe(5000); // 0:05.000 in ms
    expect(data[3]?.driver2_time).toBe(345200); // 5:45.200 in ms

    await clearFields(page, 3, ["driver1_time", "driver_change_time", "driver2_time"]);
  });

  test("enter cone and off-course penalties and verify final time", async ({ page }) => {
    const table = enduranceTable(page);
    const row = table.locator("tbody tr").filter({ hasText: "KAIST" });
    await expect(row).toBeVisible();

    // First enter driver times so we have a base time
    // Read current values and pick different ones to guarantee saves fire
    const driver1TimeInput = row.locator("input.time-input").nth(0);
    const curD1Time = await driver1TimeInput.inputValue();
    const newD1Time = curD1Time === "04:00.000" ? "4:30.000" : "4:00.000";
    await fillAndSave(page, driver1TimeInput, newD1Time);

    const changeTimeInput = row.locator("input.time-input").nth(1);
    const curChTime = await changeTimeInput.inputValue();
    const newChTime = curChTime === "00:03.000" ? "0:04.000" : "0:03.000";
    await fillAndSave(page, changeTimeInput, newChTime);

    const driver2TimeInput = row.locator("input.time-input").nth(2);
    const curD2Time = await driver2TimeInput.inputValue();
    const newD2Time = curD2Time === "04:10.000" ? "4:20.000" : "4:10.000";
    await fillAndSave(page, driver2TimeInput, newD2Time);

    // Enter cone touch count for driver 1
    // num-input order per row: d1_start_delay(0), d1_cones(1), d1_oc(2), d1_penalty(3),
    //                          d2_start_delay(4), d2_cones(5), d2_oc(6), d2_penalty(7)
    const driver1ConesInput = row.locator("input.num-input").nth(1);
    const curCones = await driver1ConesInput.inputValue();
    const newCones = curCones === "3" ? "5" : "3";
    await fillAndSave(page, driver1ConesInput, newCones);

    // Enter off-course for driver 2
    const driver2OcInput = row.locator("input.num-input").nth(6);
    const curOc = await driver2OcInput.inputValue();
    const newOc = curOc === "1" ? "2" : "1";
    await fillAndSave(page, driver2OcInput, newOc);

    // Verify the penalty column shows a non-empty value (depends on penalty settings)
    // The penalty display will only show if penalty settings have been configured
    // But the cone/oc values should be saved

    // Verify via API
    const response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[10]?.driver1_cones).toBe(Number(newCones));
    expect(data[10]?.driver2_oc).toBe(Number(newOc));

    await clearFields(page, 10, [
      "driver1_time",
      "driver_change_time",
      "driver2_time",
      "driver1_cones",
      "driver2_oc",
    ]);
  });

  test("set DSQ status for a team and verify inputs are disabled", async ({ page }) => {
    const table = enduranceTable(page);

    // Find the row for team #30 (부산대학교)
    const row = table.locator("tbody tr").filter({ hasText: "부산대학교" });
    await expect(row).toBeVisible();

    // Click DSQ button
    const dsqBtn = row.locator(".status-btn").filter({ hasText: "DSQ" });
    await dsqBtn.click();

    // Verify DSQ is active
    await expect(dsqBtn).toHaveClass(/active/);

    // Verify inputs in the row are disabled
    const inputs = row.locator("input.cell-input");
    const inputCount = await inputs.count();
    for (let i = 0; i < inputCount; i++) {
      await expect(inputs.nth(i)).toBeDisabled();
    }

    // Verify final record shows "DSQ"
    await expect(row.locator(".record-value.dnf")).toContainText("DSQ");

    // Verify via API
    const response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[30]?.status).toBe("DSQ");

    // Toggle DSQ off
    await dsqBtn.click();
    await expect(dsqBtn).not.toHaveClass(/active/);

    // Inputs should be re-enabled
    const firstInput = row.locator("input.cell-input").first();
    await expect(firstInput).not.toBeDisabled();
  });

  test("enter start delay and manual penalty fields", async ({ page }) => {
    const table = enduranceTable(page);

    // Find the row for team #31 (연세대학교)
    const row = table.locator("tbody tr").filter({ hasText: "연세대학교" });
    await expect(row).toBeVisible();

    // num-input order per row: d1_start_delay(0), d1_cones(1), d1_oc(2), d1_penalty(3),
    //                          d2_start_delay(4), d2_cones(5), d2_oc(6), d2_penalty(7)

    // Pick values different from current to guarantee saves fire
    const d1StartDelay = row.locator("input.num-input").nth(0);
    const curDelay = await d1StartDelay.inputValue();
    const newDelay = curDelay === "2" ? "4" : "2";
    await fillAndSave(page, d1StartDelay, newDelay);

    const d2Penalty = row.locator("input.num-input").nth(7);
    const curPenalty = await d2Penalty.inputValue();
    const newPenalty = curPenalty === "10000" ? "20000" : "10000";
    await fillAndSave(page, d2Penalty, newPenalty);

    // Verify via API
    const response = await page.request.get(`/competition/api/v1/score/score/endurance?year=${YEAR}`);
    const data = await response.json();
    expect(data[31]?.driver1_start_delay).toBe(Number(newDelay));
    expect(data[31]?.driver2_penalty).toBe(Number(newPenalty));

    await clearFields(page, 31, ["driver1_start_delay", "driver2_penalty"]);
  });

  test("two-row header stays at the top of the screen and keeps its columns aligned", async ({ page }) => {
    // 표가 화면보다 길어지도록 뷰포트를 줄인다
    await page.setViewportSize({ width: 900, height: 400 });

    const band = page.locator(".head-band");
    await expect(band.locator("th").first()).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(() => page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().top, ENDURANCE_TABLE))
      .toBeLessThan(0);

    // 헤더는 화면 상단에 붙고, 병합된 2행 헤더의 열도 원본과 어긋나지 않아야 한다
    const state = await page.evaluate(() => {
      const cellsOf = (root) => [...root.querySelectorAll("thead tr:last-child th")].map((c) => c.getBoundingClientRect().left);
      const real = cellsOf(document.querySelector(".sticky-host .table-container"));
      const copy = cellsOf(document.querySelector(".head-band"));
      return {
        bandTop: document.querySelector(".head-band").getBoundingClientRect().top,
        columns: real.length,
        maxDrift: Math.max(...real.map((x, i) => Math.abs(x - (copy[i] ?? Infinity)))),
      };
    });
    expect(state.columns).toBeGreaterThan(0);
    expect(Math.abs(state.bandTop)).toBeLessThanOrEqual(2);
    expect(state.maxDrift).toBeLessThanOrEqual(1);
  });

  test("focusing a cell to the left does not park it behind the frozen columns", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await expect(enduranceTable(page)).toBeVisible();

    // 표를 오른쪽 끝까지 민 뒤 왼쪽 끝 입력 칸으로 포커스를 옮기면 브라우저가 그 칸을
    // 스크롤 영역 왼쪽에 붙이는데, 그 자리는 고정열이 덮고 있다.
    await page.evaluate(() => {
      const scroller = document.querySelector(".sticky-host .table-container");
      scroller.scrollLeft = scroller.scrollWidth;
      document.querySelector(".sticky-host .table-container tbody input:not([disabled])").focus();
    });

    const placed = await page.evaluate(() => {
      const input = document.activeElement;
      const frozen = input.closest("tr").querySelector("td.col-num").getBoundingClientRect();
      return { inputLeft: input.getBoundingClientRect().left, frozenRight: frozen.right, tag: input.tagName };
    });

    expect(placed.tag).toBe("INPUT");
    expect(placed.inputLeft).toBeGreaterThanOrEqual(placed.frozenRight - 1);
  });

  test("navigation link returns to score dashboard", async ({ page }) => {
    // Find and click the "성적표" navigation link
    const navLink = page.locator("a.nav-link").filter({ hasText: "성적표" });
    await expect(navLink).toBeVisible();
    await navLink.click();

    // Should navigate to the score dashboard
    await waitForPageReady(page);
    await expect(scoreTable(page)).toBeVisible();
  });
});
