import type { Page } from "playwright/test";
import { test, expect } from "./fixtures/pwa";

async function openSettings(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("main", { name: "Settings" })).toBeVisible();
}

async function openNavigation(page: Page) {
  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog");
  await expect(navigation).toBeVisible();
  return navigation;
}

test("shows saved history without treating a cached Pi as online", async ({ page, pwa }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  const workspace = await pwa.seedWorkspace();
  const navigation = mobile
    ? await openNavigation(page)
    : page.getByRole("complementary", { name: "Workspace navigation" });

  await expect(navigation.getByText("E2E Pi", { exact: true })).toBeVisible();
  await expect(navigation.getByText("Stale cached Pi", { exact: true })).toHaveCount(0);
  const history = navigation.getByRole("region", { name: /^Local history/ });
  await expect(history.getByText(workspace.historyPreview, { exact: true })).toBeVisible();
  await history.getByRole("button", { name: new RegExp(workspace.historyPreview) }).click();

  const main = page.getByRole("main");
  if (mobile) {
    await expect(navigation).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open navigation" })).toContainText(workspace.historyPreview);
  }
  // 桌面在标题区显示会话名，移动端在顶栏导航入口；两者都标出「本地历史 · 只读」，输入区换为只读说明条。
  if (!mobile) await expect(main.getByRole("heading", { level: 1, name: workspace.historyPreview })).toBeVisible();
  await expect(main.getByText("Local history · Read only", { exact: true }).locator("visible=true")).toHaveCount(1);
  await expect(main.getByRole("note")).toContainText("read-only record");
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Pi commands" })).toHaveCount(0);
});

test("cancels and confirms clear-local-data in an isolated seeded workspace", async ({ page, pwa }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  const workspace = await pwa.seedWorkspace();

  await openSettings(page, mobile);
  await page.getByRole("button", { name: "Clear local data" }).click();
  const confirmation = page.getByRole("dialog", { name: "Clear this browser's Pi Reach identity, pairings, and history?" });
  await expect(confirmation).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await page.getByRole("button", { name: mobile ? "Back to navigation" : "Back to workspace" }).click();
  await expect(page.getByRole("main", { name: "Settings" })).toHaveCount(0);

  // 从移动导航进入设置时，返回会恢复展开的导航。
  const navigation = mobile
    ? page.getByRole("dialog")
    : page.getByRole("complementary", { name: "Workspace navigation" });
  await expect(navigation.getByText("E2E Pi", { exact: true })).toBeVisible();
  const history = navigation.getByRole("region", { name: /^Local history/ });
  await expect(history.getByText(workspace.historyPreview, { exact: true })).toBeVisible();
  if (mobile) {
    await navigation.getByRole("button", { name: "Close navigation" }).click();
    await expect(navigation).toHaveCount(0);
  }

  await openSettings(page, mobile);
  await page.getByRole("button", { name: "Clear local data" }).click();
  const navigationEvent = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await confirmation.getByRole("button", { name: "Clear local data" }).click();
  await navigationEvent;
  await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
  await expect(page.getByText("E2E Pi", { exact: true })).toHaveCount(0);
  await expect(page.getByText(workspace.historyPreview, { exact: true })).toHaveCount(0);
});
