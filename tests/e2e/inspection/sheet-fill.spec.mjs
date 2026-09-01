import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = currentCompetitionYear();

async function replaceAnswer(page, itemId, value) {
  const current = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/1`);
  const data = await current.json();
  const response = await page.request.put("/competition/api/v1/inspection/sheet/answer", {
    data: {
      year: YEAR,
      team_num: 1,
      item_id: itemId,
      value,
      expectedValue: data.answers[itemId]?.value || "",
    },
  });
  expect(response.status()).toBe(200);
}

async function replaceMemo(page, itemId, memo) {
  const current = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/1`);
  const data = await current.json();
  const response = await page.request.put("/competition/api/v1/inspection/sheet/memo", {
    data: {
      year: YEAR,
      team_num: 1,
      item_id: itemId,
      memo,
      expectedMemo: data.answers[itemId]?.memo || "",
    },
  });
  expect(response.status()).toBe(200);
}

test.describe("Inspection sheet filling", () => {
  test.use({ storageState: storageStatePath("official") });

  test.beforeEach(async ({ page }) => {
    // Navigate to inspection sheet for team 1
    await page.goto(`/inspection/${YEAR}/1`);
    await waitForPageReady(page);
  });

  test("renders team header and template categories", async ({ page }) => {
    // Verify team header
    const teamHeader = page.locator(".team-header");
    await expect(teamHeader).toContainText("#1");
    await expect(teamHeader).toContainText("서울대학교");
    await expect(teamHeader).toContainText("SNU Racing");

    // Verify category tabs
    const tabs = page.locator(".tabs .tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toContainText("전기 검차");
    await expect(tabs.nth(1)).toContainText("샤시 검차");

    // Verify items are rendered
    const panel = page.locator(".category-panel");
    await expect(panel).toContainText("절연 저항 측정");
    await expect(panel).toContainText("전압 확인");
    await expect(panel).toContainText("고정 상태");
  });

  test("keeps answer input fields large enough to read and tap", async ({ page }) => {
    const inputs = [
      page.locator(".item-row").filter({ hasText: "절연 저항 측정" }).locator(".number-input"),
      page.locator(".item-row").filter({ hasText: "시리얼 넘버" }).locator(".text-input"),
    ];

    for (const input of inputs) {
      await expect(input).toBeVisible();
      const box = await input.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      const fontSize = await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(14);
    }
  });

  test("integrates item and outline navigation into the status map", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const progress = page.locator(".inspection-progress");
    await expect(progress).toBeVisible();
    await expect(progress.locator(".inspection-status-map")).toBeVisible();
    await expect(progress.locator(".inspection-status-legend")).toContainText("FAIL");
    await expect(progress.locator(".inspection-status-legend")).toContainText("미입력");
    await expect(page.locator(".fab-container")).toHaveCount(0);
    const compactLayout = await progress.evaluate(element => {
      const map = element.querySelector(".inspection-status-map");
      return {
        height: element.getBoundingClientRect().height,
        mapDisplay: getComputedStyle(map).display,
        mapOverflowX: getComputedStyle(map).overflowX,
        mapScrollWidth: map.scrollWidth,
        mapClientWidth: map.clientWidth,
        itemSize: map.querySelector(".status-map-item").getBoundingClientRect().width,
      };
    });
    expect(compactLayout.height).toBeLessThanOrEqual(160);
    expect(compactLayout.mapDisplay).toBe("grid");
    expect(compactLayout.mapOverflowX).toBe("visible");
    expect(compactLayout.mapScrollWidth).toBeLessThanOrEqual(compactLayout.mapClientWidth);
    expect(compactLayout.itemSize).toBeLessThanOrEqual(10);
    const firstItemBox = await page.locator(".item-row").first().boundingBox();
    expect(firstItemBox.y).toBeLessThan(844);

    const initialScrollY = await page.evaluate(() => window.scrollY);
    const itemLink = progress.locator('.status-map-item[aria-label*="전압 확인"]');
    await expect(itemLink).toBeVisible();
    await itemLink.click();
    await expect.poll(async () => page.evaluate((startScrollY) => {
      const progress = document.querySelector(".inspection-progress").getBoundingClientRect();
      const item = [...document.querySelectorAll(".item-row")].find(row => row.textContent.includes("전압 확인")).getBoundingClientRect();
      return {
        scrolled: window.scrollY > startScrollY,
        belowProgress: item.top >= progress.bottom + 6,
        withinViewport: item.bottom <= window.innerHeight,
      };
    }, initialScrollY)).toEqual({ scrolled: true, belowProgress: true, withinViewport: true });

    const outlineToggle = progress.locator(".inspection-outline-toggle");
    await outlineToggle.click();
    const outline = progress.locator(".inspection-outline");
    await expect(outline).toBeVisible();
    await expect(outline.locator(".outline-subcategory-link").filter({ hasText: "배터리" })).toBeVisible();
    const groupLink = outline.locator(".inspection-outline-groups button").filter({ hasText: "1-1 배터리 팩" });
    await groupLink.click();
    await expect(outline).toBeHidden();
    await expect.poll(async () => page.evaluate(() => {
      const progress = document.querySelector(".inspection-progress").getBoundingClientRect();
      const group = document.querySelector(".group-section").getBoundingClientRect();
      return {
        belowProgress: group.top >= progress.bottom + 6,
        withinViewport: group.top < window.innerHeight,
      };
    })).toEqual({ belowProgress: true, withinViewport: true });
  });

  test("shows the vehicle type chip between the team name and the year", async ({ page }) => {
    const chip = page.locator(".team-header .team-type");
    await expect(chip).toHaveText("EV"); // seeded: team 1 is EV
    await expect(chip).toHaveClass(/badge-type-/); // colored like the team list badge

    // Adjacency + order: the meta group holds exactly the chip then the year.
    await expect(page.locator(".team-header .team-meta")).toHaveText(/^EV\s*\d{4}년$/);

    // And the chip sits after the team name, not before it.
    const nameBox = await page.locator(".team-header .team-name").boundingBox();
    const chipBox = await chip.boundingBox();
    expect(chipBox.x).toBeGreaterThan(nameBox.x);
  });

  test("keeps the type chip on the year's line at mobile width", async ({ page }) => {
    // The header is a wrapping flex row, so at narrow widths the long team name pushes
    // the trailing items onto their own line. The chip must travel WITH the year and
    // stay to its left instead of being stranded on the team name's line.
    await page.setViewportSize({ width: 390, height: 844 });

    const chip = page.locator(".team-header .team-type");
    const year = page.locator(".team-header .team-year");
    await expect(chip).toBeVisible();

    const chipBox = await chip.boundingBox();
    const yearBox = await year.boundingBox();
    const chipMid = chipBox.y + chipBox.height / 2;
    const yearMid = yearBox.y + yearBox.height / 2;
    expect(Math.abs(chipMid - yearMid)).toBeLessThan(4); // same line
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(yearBox.x); // chip on the left
  });

  test("clicks PASS on a passfail item", async ({ page }) => {
    // Find the "전압 확인" item row (passfail type)
    const itemRow = page.locator(".item-row").filter({ hasText: "전압 확인" });
    await expect(itemRow).toBeVisible();

    // Click the PASS button (labeled "P")
    const passBtn = itemRow.locator(".pf-toggle button").first();
    await expect(passBtn).toContainText("P");
    await passBtn.click();

    // Verify the PASS button becomes active (btn-success class)
    await expect(passBtn).toHaveClass(/btn-success/);

    // Click again to toggle off
    await passBtn.click();
    await expect(passBtn).not.toHaveClass(/btn-success/);
  });

  test("clicks FAIL on a passfail item", async ({ page }) => {
    // Find the "고정 상태" item row (passfail type)
    const itemRow = page.locator(".item-row").filter({ hasText: "고정 상태" });
    await expect(itemRow).toBeVisible();

    // Click the FAIL button (labeled "F")
    const failBtn = itemRow.locator(".pf-toggle button").nth(1);
    await expect(failBtn).toContainText("F");
    await failBtn.click();

    // Verify the FAIL button becomes active (btn-danger class)
    await expect(failBtn).toHaveClass(/btn-danger/);

    // Clean up: toggle off
    await failBtn.click();
    await expect(failBtn).not.toHaveClass(/btn-danger/);
  });

  test("clicks N/A on a passfail item and counts it as complete", async ({ page }) => {
    const templateResponse = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateResponse.json();
    const item = template
      .flatMap(category => category.subcategories)
      .flatMap(subcategory => subcategory.groups)
      .flatMap(group => group.items)
      .find(candidate => candidate.name === "전압 확인");
    await replaceAnswer(page, item.id, "");
    await page.reload();
    await waitForPageReady(page);

    const progress = page.locator(".inspection-progress");
    const progressValue = progress.locator(".inspection-progress-label");
    const initialCompleted = Number(await progressValue.getAttribute("aria-valuenow"));
    const itemRow = page.locator(".item-row").filter({ hasText: item.name });
    const naButton = itemRow.locator(".pf-toggle button").filter({ hasText: /^N\/A$/ });
    const saved = page.waitForResponse(response =>
      response.url().includes("/competition/api/v1/inspection/sheet/answer") && response.status() === 200,
    );
    await naButton.click();
    await saved;

    await expect(naButton).toHaveClass(/btn-na/);
    await expect.poll(async () => Number(await progressValue.getAttribute("aria-valuenow"))).toBe(initialCompleted + 1);
    await expect(progress.locator('.status-map-item[aria-label*="전압 확인"]')).toHaveClass(/status-na/);

    await replaceAnswer(page, item.id, "");
  });

  test("enters a number for a number-type item", async ({ page }) => {
    // Find the "절연 저항 측정" item row (number type)
    const itemRow = page.locator(".item-row").filter({ hasText: "절연 저항 측정" });
    await expect(itemRow).toBeVisible();

    // Verify unit label is shown
    await expect(itemRow.locator(".unit-label")).toHaveText("MΩ");

    // Pick a different value from current to guarantee save fires
    const numberInput = itemRow.locator('input[type="number"]');
    const currentNum = await numberInput.inputValue();
    const newNum = currentNum === "42" ? "55" : "42";

    // Fill and blur to trigger debounced save, then verify via API poll (deterministic)
    await numberInput.fill(newNum);
    await numberInput.blur();

    // Verify persistence via API (poll instead of waitForResponse — avoids race conditions)
    await expect.poll(async () => {
      const resp = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/1`);
      const data = await resp.json();
      return Object.values(data.answers).some((a) => a.value === newNum);
    }, { timeout: 20000 }).toBeTruthy();

    // Clean up: clear the value via API (bypass UI debounce)
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const cat = template.find((c) => c.name === "전기 검차");
    const item = cat.subcategories[0].groups[0].items.find((i) => i.name === "절연 저항 측정");
    await replaceAnswer(page, item.id, "");
  });

  test("adds the response editor to inspectors and shows answer edit metadata", async ({ page }) => {
    const chassisTab = page.locator(".tab").filter({ hasText: "샤시 검차" });
    await chassisTab.click();
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const chassis = template.find((c) => c.name === "샤시 검차");
    const item = chassis.subcategories[0].groups[0].items.find((candidate) => candidate.name === "용접 상태");
    const data = await (await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/1`)).json();
    const current = data.answers[item.id]?.value || "";
    const next = current === "PASS" ? "FAIL" : "PASS";
    const row = page.locator(".item-row").filter({ hasText: item.name });
    const button = row.locator(".pf-toggle button").filter({ hasText: next === "PASS" ? "P" : "F" });
    await button.click();

    await expect.poll(async () => {
      const dataRes = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/1`);
      return (await dataRes.json()).inspectors[chassis.id] || [];
    }, { timeout: 10000 }).toContain("E2E Official");
    await expect(page.locator(".inspector-list")).toContainText("E2E Official");
    await expect(page.locator(".inspector-input")).toHaveCount(0);
    await expect(page.locator(".inspector-fill-btn")).toHaveCount(0);
    await expect(row.locator(".answer-edit-metadata")).toContainText("응답 · E2E Official");
    await expect(row.locator(".answer-edit-metadata time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);

    await replaceAnswer(page, item.id, "");
    await page.locator(".tab").filter({ hasText: "전기 검차" }).click();
  });

  test("sets category result to PASS", async ({ page }) => {
    // Switch to "샤시 검차" tab to avoid collision with summary tests on first tab
    await page.locator(".tab").filter({ hasText: "샤시 검차" }).click();

    // Click the PASS button in the result toggle
    const resultPassBtn = page.locator(".result-toggle button").filter({ hasText: "PASS" });
    await resultPassBtn.click();

    // Verify the button becomes active
    await expect(resultPassBtn).toHaveClass(/btn-success/);

    // Verify the tab badge shows PASS
    const activeTab = page.locator(".tabs .tab.active");
    await expect(activeTab.locator(".tab-badge")).toHaveText("PASS");

    // Clean up: toggle off the result
    await resultPassBtn.click();
    await expect(resultPassBtn).not.toHaveClass(/btn-success/);

    // Restore first tab
    await page.locator(".tab").filter({ hasText: "전기 검차" }).click();
  });

  test("sets category result to FAIL", async ({ page }) => {
    // Switch to "샤시 검차" tab to avoid collision with summary tests on first tab
    await page.locator(".tab").filter({ hasText: "샤시 검차" }).click();

    // Click the FAIL button
    const resultFailBtn = page.locator(".result-toggle button").filter({ hasText: "FAIL" });
    await resultFailBtn.click();

    // Verify the button becomes active
    await expect(resultFailBtn).toHaveClass(/btn-danger/);

    // Verify the tab badge shows FAIL
    const activeTab = page.locator(".tabs .tab.active");
    await expect(activeTab.locator(".tab-badge")).toHaveText("FAIL");

    // Clean up
    await resultFailBtn.click();

    // Restore first tab
    await page.locator(".tab").filter({ hasText: "전기 검차" }).click();
  });

  test("enters memo for an item via click-to-edit", async ({ page }) => {
    // Find the first item row with a memo area
    const itemRow = page.locator(".item-row").first();
    await expect(itemRow).toBeVisible();

    // Click the memo text span to start editing (click-to-edit pattern)
    const memoText = itemRow.locator(".memo-text");
    await expect(memoText).toBeVisible();
    await memoText.click();

    // The memo input should now be visible
    const memoInput = itemRow.locator(".memo-input");
    await expect(memoInput).toBeVisible();

    // Pick a different value from current to guarantee save fires
    const currentMemo = await memoInput.inputValue();
    const newMemo = currentMemo === "테스트 메모 입력" ? "변경된 메모" : "테스트 메모 입력";

    // Type a memo and blur to trigger save
    await memoInput.fill(newMemo);
    await memoInput.blur();

    // Get template to find item ID for API verification
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const firstItemId = template[0].subcategories[0].groups[0].items[0].id;

    // Verify persistence via API poll (avoids waitForResponse race)
    await expect.poll(async () => {
      const resp = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/1`);
      const data = await resp.json();
      return data.answers[firstItemId]?.memo === newMemo;
    }, { timeout: 10000 }).toBeTruthy();
    await expect(itemRow.locator(".memo-edit-metadata")).toContainText("메모 · E2E Official");
    await expect(itemRow.locator(".memo-edit-metadata time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);

    // Clean up via API
    await replaceMemo(page, firstItemId, "");
  });

  test("shows and saves whitespace-only memo as empty", async ({ page }) => {
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const firstItemId = template[0].subcategories[0].groups[0].items[0].id;

    await replaceMemo(page, firstItemId, " \n\t ");
    await page.reload();
    await waitForPageReady(page);

    const itemRow = page.locator(".item-row").first();
    const memoText = itemRow.locator(".memo-text");
    await expect(memoText).toHaveText("+ 메모 추가");
    await expect(memoText).toHaveClass(/memo-empty/);

    await memoText.click();
    const savePromise = page.waitForResponse(
      (res) => res.url().includes("/competition/api/v1/inspection/sheet/memo") && res.status() === 200,
    );
    await itemRow.locator(".memo-input").blur();
    await savePromise;

    await expect.poll(async () => {
      const response = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/1`);
      const data = await response.json();
      return data.answers[firstItemId]?.memo;
    }).toBe("");
  });

  test("sets a category result without a manual inspector field", async ({ page }) => {
    await expect(page.locator(".inspector-input")).toHaveCount(0);
    const resultPassBtn = page.locator(".result-toggle button").filter({ hasText: "PASS" });
    await resultPassBtn.click();
    await expect(resultPassBtn).toHaveClass(/btn-success/);
    await resultPassBtn.click();
    await expect(resultPassBtn).not.toHaveClass(/btn-success/);
  });

  test("enters text for a text-type item", async ({ page }) => {
    // Find the "시리얼 넘버" item row (text type)
    const itemRow = page.locator(".item-row").filter({ hasText: "시리얼 넘버" });
    await expect(itemRow).toBeVisible();

    // Pick a different value from current to guarantee save fires
    const textInput = itemRow.locator(".text-input");
    const currentText = await textInput.inputValue();
    const newText = currentText === "BAT-2025-001" ? "BAT-2025-002" : "BAT-2025-001";

    // Enter a text value and blur to trigger debounced save
    const saveP = page.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/answer") && res.status() === 200);
    await textInput.fill(newText);
    await textInput.blur();
    await saveP;

    // Get template to find item ID
    const templateRes = await page.request.get(`/competition/api/v1/inspection/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const textItem = template[0].subcategories[0].groups[0].items.find((i) => i.name === "시리얼 넘버");

    // Verify persistence via API poll
    await expect.poll(async () => {
      const resp = await page.request.get(`/competition/api/v1/inspection/sheet/data/${YEAR}/1`);
      const data = await resp.json();
      return data.answers[textItem.id]?.value;
    }, { timeout: 10000 }).toBe(newText);

    // Clean up via API
    await replaceAnswer(page, textItem.id, "");
  });

  test("toggles checktable cell checkbox", async ({ page }) => {
    // Switch to second tab (샤시 검차) where 점검 체크리스트 is
    const tabs = page.locator(".tabs .tab");
    await tabs.nth(1).click();

    // Find the "점검 체크리스트" item row (checktable type)
    const itemRow = page.locator(".item-row").filter({ hasText: "점검 체크리스트" });
    await expect(itemRow).toBeVisible();

    // Find the checktable and toggle the first checkbox
    const checktable = itemRow.locator(".checktable");
    await expect(checktable).toBeVisible();
    const checkbox = checktable.locator("input[type='checkbox']").first();
    const checkSavePromise = page.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/answer") && res.status() === 200);
    await checkbox.check();
    await checkSavePromise;

    // Verify the value persists by reloading
    const sheetDataPromise = page.waitForResponse(
      (res) => res.url().includes("/competition/api/v1/inspection/sheet/data/") && res.status() === 200
    );
    await page.reload();
    await waitForPageReady(page);
    await sheetDataPromise;

    // Switch to second tab again
    await page.locator(".tabs .tab").nth(1).click();

    const reloadedRow = page.locator(".item-row").filter({ hasText: "점검 체크리스트" });
    const reloadedCheckbox = reloadedRow.locator(".checktable input[type='checkbox']").first();
    await expect(reloadedCheckbox).toBeChecked();

    // Clean up: uncheck
    const uncheckPromise = page.waitForResponse((res) => res.url().includes("/competition/api/v1/inspection/sheet/answer") && res.status() === 200);
    await reloadedCheckbox.uncheck();
    await uncheckPromise;
  });
});
