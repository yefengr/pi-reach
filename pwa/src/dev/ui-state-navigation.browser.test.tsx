import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { getMessages } from "@/lib/i18n";
import { UiStateGalleryPage } from "./ui-states";

const input = () => document.querySelector<HTMLTextAreaElement>("form.pwa-composer textarea")!;
async function navigation() {
  await page.getByLabelText("展示区域", { exact: true }).selectOptions("navigation");
  await expect.poll(() => document.querySelector(".pwa-ui-states-frame")?.hasAttribute("data-navigation")).toBe(true);
}
beforeEach(async () => { await page.viewport(1440, 1000); });
afterEach(async () => {
  vi.restoreAllMocks();
  await expect.poll(() => Boolean(history.state?.piReachFileReader || history.state?.piReachToolReader || history.state?.piReachSummaryReader)).toBe(false);
});

test("navigation, sidebar, saved history and settings retain the original Composer and memory draft", async () => {
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "跨展示区域保留草稿");
  await navigation();
  expect(input()).toBe(composer);
  const desktop = document.querySelector(".pwa-desktop-navigation")!;
  await userEvent.click(desktop.querySelector<HTMLButtonElement>(".pwa-history-row")!);
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-state")).toBe("history");
  expect(input()).toBe(composer);
  await userEvent.click([...desktop.querySelectorAll<HTMLButtonElement>(".pwa-nav-session")].find(button => button.textContent?.includes("阅读与对话布局"))!);
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-state")).toBe("tools");
  const settings = desktop.querySelector<HTMLButtonElement>(".pwa-nav-settings")!;
  settings.focus();
  await userEvent.click(settings);
  await expect.poll(() => document.querySelector<HTMLElement>(".pwa-ui-states-settings")?.hidden).toBe(false);
  expect(document.querySelector(".pwa-ui-states-workspace")?.hasAttribute("inert")).toBe(true);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-settings-back")!);
  await expect.poll(() => document.querySelector<HTMLElement>(".pwa-ui-states-settings")?.hidden).toBe(true);
  expect(input()).toBe(composer);
  expect(composer.value).toBe("跨展示区域保留草稿");
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect.poll(() => desktop.hasAttribute("inert")).toBe(true);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  expect(desktop.hasAttribute("inert")).toBe(false);
});

test("real mobile navigation handles Escape and deferred saved-history selection", async () => {
  await page.viewport(390, 844);
  await render(<UiStateGalleryPage />);
  await navigation();
  const trigger = document.querySelector<HTMLButtonElement>(".pwa-session-trigger")!;
  trigger.focus();
  await userEvent.click(trigger);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await expect.poll(() => document.activeElement).toBe(trigger);
  await userEvent.click(trigger);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-session-sheet .pwa-history-row")!);
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-state")).toBe("history");
});

test("mobile navigation hands settings over without a surviving Drawer and returns to a valid trigger", async () => {
  await page.viewport(390, 844);
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "手机设置交接草稿");
  await navigation();
  const trigger = document.querySelector<HTMLButtonElement>(".pwa-session-trigger")!;
  await userEvent.click(trigger);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-session-sheet .pwa-nav-settings")!);
  await expect.poll(() => document.querySelector<HTMLElement>(".pwa-ui-states-settings")?.hidden).toBe(false);
  await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
  const settings = document.querySelector<HTMLElement>(".pwa-ui-states-settings")!;
  await expect.poll(() => document.activeElement).toBe(settings.querySelector(".pwa-settings-title"));
  await userEvent.keyboard("{Tab}");
  expect(settings.contains(document.activeElement)).toBe(true);
  await userEvent.click(settings.querySelector<HTMLButtonElement>(".pwa-settings-back")!);
  await expect.poll(() => settings.hidden).toBe(true);
  await expect.poll(() => document.activeElement).toBe(trigger);
  expect(input()).toBe(composer);
  expect(composer.value).toBe("手机设置交接草稿");
  await userEvent.click(trigger);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
});

test("settings and its nested help isolate all background surface controls until returning", async () => {
  await render(<UiStateGalleryPage />);
  await page.getByLabelText("展示区域", { exact: true }).selectOptions("surfaces");
  const controls = document.querySelector<HTMLElement>(".pwa-ui-states-surfaces")!;
  const origin = controls.querySelector<HTMLButtonElement>("button")!;
  origin.focus();
  await userEvent.click(origin);
  await expect.poll(() => controls.hasAttribute("inert")).toBe(true);
  expect(controls.getAttribute("aria-hidden")).toBe("true");
  const title = document.querySelector<HTMLHeadingElement>(".pwa-settings-title")!;
  await expect.poll(() => document.activeElement).toBe(title);
  controls.querySelector<HTMLButtonElement>("button:nth-child(2)")!.focus();
  expect(document.activeElement).toBe(title);
  for (let index = 0; index < 8; index++) {
    await userEvent.keyboard("{Tab}");
    expect(controls.contains(document.activeElement)).toBe(false);
  }
  const help = [...document.querySelectorAll<HTMLButtonElement>(".pwa-settings-row-button")].find(button => button.textContent?.includes("Keyboard shortcuts"))!;
  await userEvent.click(help);
  await expect.poll(() => document.querySelector(".pwa-keyboard-dialog")).not.toBeNull();
  expect(controls.hasAttribute("inert")).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-keyboard-dialog")).toBeNull();
  expect(controls.hasAttribute("inert")).toBe(true);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-settings-back")!);
  await expect.poll(() => controls.hasAttribute("inert")).toBe(false);
  await expect.poll(() => document.activeElement).toBe(origin);
});

test("selecting a finished Pi shows a finished turn instead of a running one", async () => {
  await render(<UiStateGalleryPage />);
  await navigation();
  const sessions = [...document.querySelectorAll<HTMLButtonElement>(".pwa-desktop-navigation .pwa-nav-session")];
  await userEvent.click(sessions.find(button => button.textContent?.includes("另一段已完成的会话"))!);
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-state")).toBe("tool-types");
  expect(document.querySelector(".pwa-composer-stop")).toBeNull();
  await userEvent.click(sessions.find(button => button.textContent?.includes("阅读与对话布局"))!);
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-state")).toBe("tools");
});

test("switching computers filters history and opens local history without an online Pi", async () => {
  await render(<UiStateGalleryPage />);
  await navigation();
  const desktop = document.querySelector(".pwa-desktop-navigation")!;
  const historyNames = () => [...desktop.querySelectorAll(".pwa-history-row")].map(row => row.textContent ?? "");
  await expect.poll(historyNames).toEqual([expect.stringContaining("已保存的界面检查")]);
  await userEvent.click(desktop.querySelector<HTMLButtonElement>(".pwa-device-trigger")!);
  await expect.poll(() => document.querySelector(".pwa-device-popover")).not.toBeNull();
  const offline = [...document.querySelectorAll<HTMLElement>(".pwa-device-popover .pwa-computer-select")].find(row => row.textContent?.includes("离线电脑"))!;
  await userEvent.click(offline);
  await expect.poll(historyNames).toEqual([expect.stringContaining("离线电脑的已保存会话")]);
  await userEvent.click(desktop.querySelector<HTMLButtonElement>(".pwa-history-row")!);
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-state")).toBe("history");
  expect(document.querySelector<HTMLElement>(".pwa-ui-states-frame-content")!.hidden).toBe(false);
  expect(document.querySelector(".pwa-ui-states-frame")?.textContent).toContain("离线电脑的已保存会话");
});

test("a computer renamed in the gallery appears in the navigation like the formal workspace", async () => {
  await render(<UiStateGalleryPage />);
  await page.getByLabelText("展示区域", { exact: true }).selectOptions("surfaces");
  await page.getByRole("button", { name: "重命名电脑", exact: true }).click();
  await page.getByRole("textbox", { name: getMessages().rename.label }).fill("改名后的电脑");
  await page.getByRole("button", { name: getMessages().rename.save, exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-rename-dialog"), { timeout: 3_000 }).toBeNull();
  await navigation();
  const desktop = () => document.querySelector(".pwa-desktop-navigation")?.textContent ?? "";
  await expect.poll(desktop).toContain("改名后的电脑");
  expect(desktop()).not.toContain("工作电脑");
});

test("all navigation states and opening isolated settings and pairing leave storage, connections and camera untouched", async () => {
  const writes = vi.spyOn(Storage.prototype, "setItem");
  const database = vi.spyOn(indexedDB, "open");
  const fetch = vi.spyOn(window, "fetch");
  const socket = vi.spyOn(window, "WebSocket");
  const camera = vi.spyOn(navigator.mediaDevices, "getUserMedia");
  await render(<UiStateGalleryPage />);
  await navigation();
  for (const state of ["loading", "error", "unpaired", "paired"]) {
    await page.getByLabelText("导航状态", { exact: true }).selectOptions(state);
  }
  // 未配对时 footer 直接提供配对入口；已配对时入口在电脑面板底部，本用例只验证配对弹窗本身。
  await page.getByLabelText("导航状态", { exact: true }).selectOptions("unpaired");
  await expect.poll(() => document.querySelector(".pwa-desktop-navigation .pwa-nav-pair")).not.toBeNull();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-desktop-navigation .pwa-nav-pair")!);
  await expect.poll(() => document.querySelector(".pwa-pairing-dialog")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-desktop-navigation .pwa-nav-settings")!);
  await expect.poll(() => document.querySelector<HTMLElement>(".pwa-ui-states-settings")?.hidden).toBe(false);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-settings-back")!);
  expect(writes).not.toHaveBeenCalled(); expect(database).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled();
  expect(camera).not.toHaveBeenCalled();
});
