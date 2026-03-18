import { expect } from "@playwright/test";

export async function waitForSSEUpdate(page, selector, expectedText, timeout = 5000) {
  await expect(page.locator(selector)).toContainText(expectedText, { timeout });
}

export async function expectNotification(page, type, text) {
  const selector = type === "success" ? ".notyf__toast--success" : type === "error" ? ".notyf__toast--error" : ".notyf__toast--warning";
  await expect(page.locator(selector).last()).toContainText(text, { timeout: 5000 });
}

export async function dismissNotifications(page) {
  const toasts = page.locator(".notyf__toast");
  const count = await toasts.count();
  for (let i = 0; i < count; i++) {
    await toasts.nth(i).click({ force: true }).catch(() => {});
  }
}

export async function waitForPageReady(page) {
  await page.waitForLoadState("domcontentloaded");
}

export async function selectOption(page, selector, value) {
  await page.locator(selector).selectOption(value);
}

export function storageStatePath(role) {
  return `tests/e2e/.auth/${role}.json`;
}
