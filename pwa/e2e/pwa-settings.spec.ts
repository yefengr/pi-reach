import type { Page } from "playwright/test";
import { test, expect } from "./fixtures/pwa";

const TEST_RELAY_URL = "http://127.0.0.1:9";

function settingsPage(page: Page) {
  return page.getByRole("main", { name: "Settings" });
}

async function openSettings(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(settingsPage(page)).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings$/);
}

test("opens settings as its own page, saves a local relay URL, and returns", async ({ page, pwa }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  await pwa.open();

  await openSettings(page, mobile);
  await expect(page).toHaveTitle("Settings · Pi Reach");
  const relayInput = page.getByRole("textbox", { name: "Relay URL" });
  await relayInput.fill(TEST_RELAY_URL);
  await page.getByRole("button", { name: "Save settings" }).click();
  // 保存后留在设置页，以 Toast 提示「设置已保存」。
  await expect(settingsPage(page)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Settings saved" })).toBeVisible();

  // 刷新设置页仍停留在设置页，并读到已保存的地址。
  await page.reload();
  await expect(settingsPage(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Relay URL" })).toHaveValue(TEST_RELAY_URL);
  await page.getByRole("button", { name: mobile ? "Back to navigation" : "Back to workspace" }).click();
  await expect(settingsPage(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page).toHaveTitle("Pi Reach App");
});

test("returns with browser back and re-enters with browser forward", async ({ page, pwa }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  await pwa.open();
  await openSettings(page, mobile);

  await page.goBack();
  await expect(settingsPage(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/app$/);
  if (mobile) await expect(page.getByRole("dialog", { name: /Workspace/ })).toBeVisible();

  await page.goForward();
  await expect(settingsPage(page)).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings$/);
});

test("opens /app/settings directly and adds a workspace entry behind it", async ({ page }) => {
  await page.goto("/app/settings");
  await expect(settingsPage(page)).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
  // 返回后再后退不会回到设置页。
  await page.goBack();
  await expect(settingsPage(page)).toHaveCount(0);
});

test("shows the default workspace for unknown /app paths", async ({ page }) => {
  await page.goto("/app/unknown/path?pair=kept");
  await expect(page).toHaveURL(/\/app\?pair=kept$/);
  await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
});

test("opens /app/settings offline once the service worker controls the app", async ({ context, page, pwa }) => {
  await pwa.open();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.goto("/app/settings");
  await expect(settingsPage(page)).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings$/);
});
