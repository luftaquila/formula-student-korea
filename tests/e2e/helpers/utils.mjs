import { expect } from "@playwright/test";

export async function waitForSSEUpdate(page, selector, expectedText, timeout = 5000) {
  await expect(page.locator(selector)).toContainText(expectedText, { timeout });
}

export async function expectNotification(page, type, text) {
  const notification = page.locator(`[data-sonner-toast][data-type="${type}"]`)
    .filter({ hasText: text })
    .first();
  await expect(notification).toContainText(text, { timeout: 5000 });
}

export async function expectNotificationAfter(page, type, text, action) {
  await page.locator("[data-sonner-toast]").evaluateAll((toasts) => {
    for (const toast of toasts) toast.setAttribute("data-e2e-notification-seen", "true");
  });
  await action();
  await expect(page.locator(
    `[data-sonner-toast][data-type="${type}"]:not([data-e2e-notification-seen])`,
  ).first()).toContainText(text, { timeout: 5000 });
}

export async function installTestClock(page) {
  await page.clock.install();
}

export async function advanceTestClock(page, milliseconds) {
  await page.clock.fastForward(milliseconds);
}

export async function drainBrowserEvents(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

export async function installSSEEventProbe(page, eventNames) {
  await page.addInitScript((names) => {
    const NativeEventSource = window.EventSource;
    window.__e2eSSEEventCounts = Object.fromEntries(names.map((name) => [name, 0]));
    window.__e2eEventSources = [];
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        window.__e2eEventSources.push(this);
        for (const name of names) {
          this.addEventListener(name, () => { window.__e2eSSEEventCounts[name] += 1; });
        }
      }
    };
  }, eventNames);
}

export async function sseEventCount(page, eventName) {
  return page.evaluate((name) => window.__e2eSSEEventCounts?.[name] ?? 0, eventName);
}

export async function forceSSEReconnect(page) {
  await page.evaluate(() => {
    const source = window.__e2eEventSources?.at(-1);
    if (!source) throw new Error("No active EventSource to disconnect");
    source.dispatchEvent(new Event("error"));
  });
}

export async function expectSSEEventAfter(page, eventName, action) {
  const previousCount = await sseEventCount(page, eventName);
  const result = await action();
  await expect.poll(() => sseEventCount(page, eventName)).toBeGreaterThan(previousCount);
  return result;
}

export async function waitForPageReady(page) {
  await page.waitForLoadState("domcontentloaded");
}

export async function selectOption(page, selector, value) {
  await page.locator(selector).selectOption(value);
}

export async function setCustomEventName(page, name) {
  await page.getByTestId("event-name-option").selectOption("custom");
  const input = page.getByTestId("event-name-custom");
  await expect(input).toBeEnabled();
  await input.fill(name);
}

export function storageStatePath(profile) {
  return `tests/e2e/.auth/${profile}.json`;
}

// score 화면들은 고정 헤더용 사본 테이블을 하나 더 렌더한다(useTableHeadBand).
// 실제 표나 그 안의 th 를 집으려면 범위를 좁혀야 한다. 선택자는 여기에만 둔다 —
// locator 는 아래 헬퍼를 쓰고, 문자열이 필요한 곳(page.evaluate 인자 등)은 상수를 넘긴다.
export const SCORE_TABLE = ".table-container table.score-table";
export const ENDURANCE_TABLE = ".table-container table.endurance-table";

export function scoreTable(page) {
  return page.locator(SCORE_TABLE);
}

export function enduranceTable(page) {
  return page.locator(ENDURANCE_TABLE);
}

export async function expectCompactTeamIdentity(table, {
  fields = [".team-mobile-entry-type", ".team-mobile-entry-univ", ".team-mobile-entry-name"],
} = {}) {
  for (const selector of fields) {
    const field = table.locator(`tbody ${selector}`).first();
    await expect(field).toBeVisible();
    await expect(field).not.toHaveText("");
  }
}
