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
  // 桌面在标题区显示会话名，移动端在顶栏导航入口；标题不标注只读，输入区保留在线样式但全部禁用，由提示区说明只读。
  if (!mobile) await expect(main.getByRole("heading", { level: 1, name: workspace.historyPreview })).toBeVisible();
  await expect(main.getByText("Read only")).toHaveCount(0);
  await expect(main.getByRole("note")).toContainText("It's read-only.");
  await expect(main.getByRole("textbox")).toBeDisabled();
  await expect(main.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(main.getByRole("button", { name: "Pi commands" })).toBeDisabled();
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
