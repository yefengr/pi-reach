import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { getMessages } from "@/lib/i18n";
import { ENTER_SENDS_STORAGE_KEY, shortcutLabel } from "@/lib/pwa/keyboard-shortcuts";
import { createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import { PwaOperationNotifications } from "@/components/pwa/pwa-operation-notifications";
import { UiStateSurfaces, type GallerySurface } from "./ui-state-surfaces";
import "./ui-states.css";

function Harness({ onChange = () => {} }: { onChange?: (next: GallerySurface) => void }) {
  const [surface, setSurface] = useState<GallerySurface>(null);
  return <UiStateSurfaces surface={surface} onSurfaceChange={next => { onChange(next); setSurface(next); }} />;
}

afterEach(() => vi.restoreAllMocks());

test("settings and help share memory keyboard preference, preserve the page under Escape, and write no preferences", async () => {
  const before = [localStorage.getItem("pi-reach-language"), localStorage.getItem(ENTER_SENDS_STORAGE_KEY), location.href, document.documentElement.lang];
  const write = vi.spyOn(Storage.prototype, "setItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const screen = await renderPwa(<Harness />);
  await screen.getByRole("button", { name: "预览设置页", exact: true }).click();
  const settings = document.querySelector(".pwa-settings-page")!;
  await screen.getByRole("switch", { name: getMessages().settings.enterSends }).click();
  const help = screen.getByRole("button", { name: getMessages().shortcuts.title, exact: true });
  help.element().focus();
  await help.click();
  await expect.poll(() => document.querySelector(".pwa-keyboard-dialog")).not.toBeNull();
  expect(document.querySelector('[data-shortcut="send"] kbd')?.textContent).toBe(shortcutLabel("send", false));
  expect(document.querySelector('[data-shortcut="sendAlternative"]')).toBeNull();
  expect(document.querySelector(".pwa-keyboard-dialog")?.closest(".pwa-root")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-keyboard-dialog")).toBeNull();
  expect(document.querySelector(".pwa-settings-page")).toBe(settings);
  expect(document.querySelector<HTMLElement>(".pwa-ui-states-settings")!.hidden).toBe(false);
  await expect.element(screen.getByRole("button", { name: getMessages().shortcuts.title, exact: true })).toHaveFocus();
  await screen.getByRole("button", { name: "返回展厅" }).click();
  expect(document.querySelector<HTMLElement>(".pwa-ui-states-settings")!.hidden).toBe(true);
  expect([localStorage.getItem("pi-reach-language"), localStorage.getItem(ENTER_SENDS_STORAGE_KEY), location.href, document.documentElement.lang]).toEqual(before);
  expect(write).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test("clear-data confirmation preserves settings, blocks duplicate actions and dismissal while pending, and retains errors", async () => {
  const screen = await renderPwa(<Harness />);
  await screen.getByLabelText("确认操作结果", { exact: true }).selectOptions("error");
  await screen.getByRole("button", { name: "预览设置页", exact: true }).click();
  const settings = document.querySelector(".pwa-settings-page")!;
  const clear = screen.getByRole("button", { name: getMessages().settings.clearData, exact: true });
  clear.element().focus();
  await clear.click();
  const dialog = document.querySelector(".pwa-confirm-dialog")!;
  expect(dialog.closest(".pwa-root")).not.toBeNull();
  const confirm = dialog.querySelector<HTMLButtonElement>(".pwa-danger-confirm")!;
  confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect.element(screen.getByRole("button", { name: getMessages().confirm.close, exact: true })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  expect(document.querySelector(".pwa-confirm-dialog")).toBe(dialog);
  await expect.poll(() => document.querySelector(".pwa-confirm-error")?.textContent, { timeout: 3_000 }).toContain("演示操作失败");
  expect(document.querySelector(".pwa-confirm-dialog")).toBe(dialog);
  expect(document.querySelector(".pwa-settings-page")).toBe(settings);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
  expect(document.querySelector<HTMLElement>(".pwa-ui-states-settings")!.hidden).toBe(false);
  await expect.element(clear).toHaveFocus();
});

test("confirmation success finishes locally and an unmounted pending operation cannot emit a stale result", async () => {
  const onChange = vi.fn();
  const screen = await renderPwa(<Harness onChange={onChange} />);
  await screen.getByRole("button", { name: "操作确认", exact: true }).click();
  await screen.getByRole("button", { name: getMessages().confirm.newSessionConfirm, exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog"), { timeout: 3_000 }).toBeNull();
  await expect.element(screen.getByText("演示操作已完成；未创建会话或清除数据。", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "操作确认", exact: true }).click();
  await screen.getByRole("button", { name: getMessages().confirm.newSessionConfirm, exact: true }).click();
  const calls = onChange.mock.calls.length;
  await screen.unmount();
  await new Promise<void>(resolve => setTimeout(resolve, 1_100));
  expect(onChange).toHaveBeenCalledTimes(calls);
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
});

test("pairing shows bounded local connecting then error, and rename is retained only in gallery memory", async () => {
  const network = vi.spyOn(window, "fetch");
  const screen = await renderPwa(<Harness />);
  await screen.getByRole("button", { name: "输入配对码", exact: true }).click();
  const input = screen.getByRole("textbox", { name: getMessages().pairing.codeLabel });
  await input.fill("k7mp-4q2d");
  await expect.element(input).toBeDisabled();
  await expect.element(screen.getByText(getMessages().pairing.connecting)).toBeVisible();
  await expect.poll(() => document.querySelector(".pwa-pairing-input")?.textContent, { timeout: 3_000 }).toContain(getMessages().pairing.errors.unknown_code);
  await expect.element(input).toBeEnabled();
  await expect.element(input).toHaveValue("K7MP-4Q2D");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-pairing-dialog")).toBeNull();
  await screen.getByRole("button", { name: "重命名电脑", exact: true }).click();
  await screen.getByRole("textbox", { name: getMessages().rename.label }).fill("本页内存电脑");
  await screen.getByRole("button", { name: getMessages().rename.save, exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-rename-dialog"), { timeout: 3_000 }).toBeNull();
  await screen.getByRole("button", { name: "重命名电脑", exact: true }).click();
  await expect.element(screen.getByRole("textbox", { name: getMessages().rename.label })).toHaveValue("本页内存电脑");
  expect(network).not.toHaveBeenCalled();
});

test("toast previews use a private store and refresh changes only an explanatory local status", async () => {
  const other = createOperationNotificationController();
  const screen = await renderPwa(<><Harness /><PwaOperationNotifications controller={other} /></>);
  await screen.getByRole("button", { name: "成功 Toast", exact: true }).click();
  await expect.element(screen.getByText("操作成功（仅本页演示）。", { exact: true })).toBeVisible();
  expect(other.store.getState().notifications).toEqual([]);
  await screen.getByRole("button", { name: "错误 Toast", exact: true }).click();
  expect(document.querySelectorAll(".pwa-operation-notification")).toHaveLength(1);
  await screen.getByRole("button", { name: "更新 Toast", exact: true }).click();
  await screen.getByRole("button", { name: getMessages().operations.dismiss, exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "刷新（仅演示）", exact: true })).toBeVisible();
  const url = location.href;
  await screen.getByRole("button", { name: "刷新（仅演示）", exact: true }).click();
  await expect.element(screen.getByText("已演示刷新操作；当前页面保持原样。", { exact: true })).toBeVisible();
  expect(location.href).toBe(url);
  expect(other.store.getState().notifications).toEqual([]);
});
