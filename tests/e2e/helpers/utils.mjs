import { expect } from "@playwright/test";

export async function waitForSSEUpdate(page, selector, expectedText, timeout = 5000) {
  await expect(page.locator(selector)).toContainText(expectedText, { timeout });
}

export async function expectNotification(page, type, text) {
  await expect(page.locator(`[data-sonner-toast][data-type="${type}"]`).first()).toContainText(text, { timeout: 5000 });
}

export async function dismissNotifications(page) {
  // vue-sonner 토스트는 notyf 처럼 클릭으로 닫히지 않는다(닫기 버튼 미사용).
  // 다음 단언이 직전 토스트가 아닌 새 토스트를 보도록, 현재 배치가 자동 소멸할 때까지 대기.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 6000 }).catch(() => {});
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
  cell = ".col-num",
  summary = ".team-entry-summary",
  fields = [".team-mobile-entry-type", ".team-mobile-entry-univ", ".team-mobile-entry-name"],
} = {}) {
  await expect(table.locator(`tbody ${cell}`).first()).toBeVisible();
  const layout = await table.evaluate((element, selectors) => {
    const cells = [...element.querySelectorAll(`tbody ${selectors.cell}`)]
      .filter(candidate => candidate.getClientRects().length > 0);
    const firstCell = cells[0];
    const header = element.querySelector(`thead ${selectors.cell}`);
    const outerWidth = (node, contentWidth) => {
      const style = getComputedStyle(node);
      return contentWidth
        + Number.parseFloat(style.paddingLeft || 0)
        + Number.parseFloat(style.paddingRight || 0)
        + Number.parseFloat(style.borderLeftWidth || 0)
        + Number.parseFloat(style.borderRightWidth || 0);
    };
    const inlineContentWidth = (node) => [...node.childNodes].reduce((width, child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.selectNodeContents(child);
        return width + range.getBoundingClientRect().width;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return width;
      const style = getComputedStyle(child);
      return width
        + child.getBoundingClientRect().width
        + Number.parseFloat(style.marginLeft || 0)
        + Number.parseFloat(style.marginRight || 0);
    }, 0);
    const requiredWidths = cells.map((candidate) => {
      const content = candidate.querySelector(selectors.summary);
      return content ? outerWidth(candidate, content.getBoundingClientRect().width) : 0;
    });
    if (header) requiredWidths.push(outerWidth(header, inlineContentWidth(header)));
    const fieldStates = cells.flatMap(candidate => selectors.fields.map((selector) => {
      const field = candidate.querySelector(selector);
      if (!field || field.getClientRects().length === 0) return null;
      return {
        selector,
        text: field.textContent.trim(),
        clientWidth: field.clientWidth,
        scrollWidth: field.scrollWidth,
      };
    }).filter(Boolean));
    return {
      actualWidth: firstCell.getBoundingClientRect().width,
      requiredWidth: Math.max(...requiredWidths),
      fieldStates,
    };
  }, { cell, summary, fields });

  expect(layout.fieldStates.length).toBeGreaterThan(0);
  for (const field of layout.fieldStates) {
    expect(field.scrollWidth, `${field.selector} must not truncate ${field.text}`).toBeLessThanOrEqual(field.clientWidth + 1);
  }
  expect(layout.actualWidth).toBeGreaterThanOrEqual(layout.requiredWidth - 2);
  expect(layout.actualWidth).toBeLessThanOrEqual(layout.requiredWidth + 2);
}
