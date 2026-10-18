import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
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
  await userEvent.click(desktop.querySelector<HTMLButtonElement>(".pwa-nav-session")!);
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
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect.poll(() => desktop.hasAttribute("inert")).toBe(true);
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
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
  const help = [...document.querySelectorAll<HTMLButtonElement>(".pwa-settings-actions button")].find(button => button.textContent?.includes("Keyboard shortcuts"))!;
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
