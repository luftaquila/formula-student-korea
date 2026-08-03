import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

const YEAR = new Date().getFullYear();

async function saveInspector(page, input, value) {
  const p = page.waitForResponse((res) => res.url().includes("/api/sheet/inspector") && res.status() === 200);
  await input.fill(value);
  await input.blur();
  await Promise.race([p, page.waitForTimeout(1000)]);
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

  test("switches quick navigation depth and closes on outside click", async ({ page }) => {
    const fab = page.locator(".fab");
    const menu = page.locator(".fab-container .nav-menu");
    const levelToggle = page.locator(".nav-menu-level-toggle");
    const topButton = page.locator(".nav-menu-top");

    await fab.click();
    await expect(menu).toBeVisible();
    await expect(levelToggle).toHaveText("그룹 보기");
    await expect(topButton).toHaveText("맨 위로");
    const levelBox = await levelToggle.boundingBox();
    const topBox = await topButton.boundingBox();
    expect(topBox.x).toBeGreaterThan(levelBox.x);
    const actionColors = await menu.locator(".nav-menu-actions button").evaluateAll(
      (buttons) => buttons.map((button) => getComputedStyle(button).color),
    );
    expect(new Set(actionColors).size).toBe(1);
    const groupNavItem = menu.locator(".nav-menu-item").filter({ hasText: "1-1 배터리 팩" });
    await expect(groupNavItem).toBeVisible();
    await groupNavItem.click();
    await expect(menu).toBeHidden();
    await expect.poll(async () => page.evaluate(() => {
      const progress = document.querySelector(".inspection-progress").getBoundingClientRect();
      const group = document.querySelector(".group-section").getBoundingClientRect();
      return Math.abs(group.top - progress.bottom - 8);
    })).toBeLessThanOrEqual(2);

    await fab.click();
    await expect(menu).toBeVisible();
    await levelToggle.click();
    await expect(levelToggle).toHaveText("소분류 보기");
    await expect(menu.locator(".nav-menu-item").filter({ hasText: "1 - 배터리" })).toBeVisible();
    await page.locator(".group-title").first().click();
    await expect(menu).toBeHidden();
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
      const resp = await page.request.get(`/inspection/api/sheet/data/${YEAR}/1`);
      const data = await resp.json();
      return Object.values(data.answers).some((a) => a.value === newNum);
    }, { timeout: 20000 }).toBeTruthy();

    // Clean up: clear the value via API (bypass UI debounce)
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const cat = template.find((c) => c.name === "전기 검차");
    const item = cat.subcategories[0].groups[0].items.find((i) => i.name === "절연 저항 측정");
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: 1, item_id: item.id, value: "" },
    });
  });

  test("enters inspector name", async ({ page }) => {
    // Switch to "샤시 검차" tab to avoid collision with realtime-sync tests on first tab
    const chassisTab = page.locator(".tab").filter({ hasText: "샤시 검차" });
    await chassisTab.click();

    const inspectorInput = page.locator(".inspector-input");
    await expect(inspectorInput).toBeVisible();

    // Pick a value different from current to guarantee a save fires
    const currentInspector = await inspectorInput.inputValue();
    const newInspector = currentInspector === "홍길동" ? "김검사" : "홍길동";

    // Enter inspector name and blur to trigger save
    await inspectorInput.fill(newInspector);
    await inspectorInput.blur();

    // Verify via API poll (avoids waitForResponse race)
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const chassisCatId = template.find((c) => c.name === "샤시 검차").id;

    await expect.poll(async () => {
      const dataRes = await page.request.get(`/inspection/api/sheet/data/${YEAR}/1`);
      const data = await dataRes.json();
      return data.inspectors[chassisCatId];
    }, { timeout: 10000 }).toBe(newInspector);

    // Clean up via API
    await page.request.put("/inspection/api/sheet/inspector", {
      data: { year: YEAR, team_num: 1, category_id: chassisCatId, inspector: "" },
    });

    // Restore first tab so subsequent tests start on the correct category
    await page.locator(".tab").filter({ hasText: "전기 검차" }).click();
  });

  test("내 이름 button toggles the current user's name", async ({ page }) => {
    // 샤시 검차 tab (owned by this file's serial tests) to avoid cross-file collision
    await page.locator(".tab").filter({ hasText: "샤시 검차" }).click();
    const input = page.locator(".inspector-input");
    await expect(input).toBeVisible();
    const fillBtn = page.locator(".inspector-fill-btn");

    // Known start state: empty
    await saveInspector(page, input, "");
    await expect(input).toHaveValue("");

    // Empty → adds my name
    await fillBtn.click();
    await expect(input).toHaveValue("E2E Official");

    // Pressing again removes my name (toggle off)
    await fillBtn.click();
    await expect(input).toHaveValue("");

    // With an existing name, mine appends/removes without leaving a dangling separator
    await saveInspector(page, input, "홍길동");
    await fillBtn.click();
    await expect(input).toHaveValue("홍길동, E2E Official");
    await fillBtn.click();
    await expect(input).toHaveValue("홍길동");

    // Cleanup + restore first tab for subsequent tests
    await saveInspector(page, input, "");
    await page.locator(".tab").filter({ hasText: "전기 검차" }).click();
  });

  test("sets category result to PASS", async ({ page }) => {
    // Switch to "샤시 검차" tab to avoid collision with summary tests on first tab
    await page.locator(".tab").filter({ hasText: "샤시 검차" }).click();

    // First enter an inspector name (required for setting category result)
    await saveInspector(page, page.locator(".inspector-input"), "테스트관");

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

    // Clean up inspector name
    await saveInspector(page, page.locator(".inspector-input"), "");

    // Restore first tab
    await page.locator(".tab").filter({ hasText: "전기 검차" }).click();
  });

  test("sets category result to FAIL", async ({ page }) => {
    // Switch to "샤시 검차" tab to avoid collision with summary tests on first tab
    await page.locator(".tab").filter({ hasText: "샤시 검차" }).click();

    // Enter inspector name first
    await saveInspector(page, page.locator(".inspector-input"), "테스트관");

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
    await saveInspector(page, page.locator(".inspector-input"), "");

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
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const firstItemId = template[0].subcategories[0].groups[0].items[0].id;

    // Verify persistence via API poll (avoids waitForResponse race)
    await expect.poll(async () => {
      const resp = await page.request.get(`/inspection/api/sheet/data/${YEAR}/1`);
      const data = await resp.json();
      return data.answers[firstItemId]?.memo === newMemo;
    }, { timeout: 10000 }).toBeTruthy();

    // Clean up via API
    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: 1, item_id: firstItemId, memo: "" },
    });
  });

  test("shows and saves whitespace-only memo as empty", async ({ page }) => {
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const firstItemId = template[0].subcategories[0].groups[0].items[0].id;

    await page.request.put("/inspection/api/sheet/memo", {
      data: { year: YEAR, team_num: 1, item_id: firstItemId, memo: " \n\t " },
    });
    await page.reload();
    await waitForPageReady(page);

    const itemRow = page.locator(".item-row").first();
    const memoText = itemRow.locator(".memo-text");
    await expect(memoText).toHaveText("+ 메모 추가");
    await expect(memoText).toHaveClass(/memo-empty/);

    await memoText.click();
    const savePromise = page.waitForResponse(
      (res) => res.url().includes("/api/sheet/memo") && res.status() === 200,
    );
    await itemRow.locator(".memo-input").blur();
    await savePromise;

    await expect.poll(async () => {
      const response = await page.request.get(`/inspection/api/sheet/data/${YEAR}/1`);
      const data = await response.json();
      return data.answers[firstItemId]?.memo;
    }).toBe("");
  });

  test("requires inspector name before setting category result", async ({ page }) => {
    // Ensure inspector name is empty
    await saveInspector(page, page.locator(".inspector-input"), "");

    // Try to set PASS without inspector name
    const resultPassBtn = page.locator(".result-toggle button").filter({ hasText: "PASS" });
    await resultPassBtn.click();

    // Should show error notification
    const errorToast = page.locator("[data-sonner-toast][data-type='error']");
    await expect(errorToast.first()).toContainText("검차관 이름을 입력하세요", { timeout: 5000 });

    // PASS button should not be active
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
    const saveP = page.waitForResponse((res) => res.url().includes("/api/sheet/answer") && res.status() === 200);
    await textInput.fill(newText);
    await textInput.blur();
    await saveP;

    // Get template to find item ID
    const templateRes = await page.request.get(`/inspection/api/sheet/template?year=${YEAR}`);
    const template = await templateRes.json();
    const textItem = template[0].subcategories[0].groups[0].items.find((i) => i.name === "시리얼 넘버");

    // Verify persistence via API poll
    await expect.poll(async () => {
      const resp = await page.request.get(`/inspection/api/sheet/data/${YEAR}/1`);
      const data = await resp.json();
      return data.answers[textItem.id]?.value;
    }, { timeout: 10000 }).toBe(newText);

    // Clean up via API
    await page.request.put("/inspection/api/sheet/answer", {
      data: { year: YEAR, team_num: 1, item_id: textItem.id, value: "" },
    });
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
    const checkSavePromise = page.waitForResponse((res) => res.url().includes("/api/sheet/answer") && res.status() === 200);
    await checkbox.check();
    await checkSavePromise;

    // Verify the value persists by reloading
    const sheetDataPromise = page.waitForResponse(
      (res) => res.url().includes("/api/sheet/data/") && res.status() === 200
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
    const uncheckPromise = page.waitForResponse((res) => res.url().includes("/api/sheet/answer") && res.status() === 200);
    await reloadedCheckbox.uncheck();
    await Promise.race([uncheckPromise, page.waitForTimeout(1000)]);
  });
});
