import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { getMessages, type LanguagePreference } from "@/lib/i18n";
import { ENTER_SENDS_STORAGE_KEY } from "@/lib/pwa/keyboard-shortcuts";
import { SESSION_STATUS_CARD_STORAGE_KEY } from "@/lib/pwa/session-status-card-preference";
import { resetTextSizeStateForTest, TEXT_SIZE_STORAGE_KEY, type PwaTextSizePreference } from "@/lib/ui/text-size";
import { SettingsPage } from "./settings-page";
import type { PwaAppearance } from "./pwa-appearance";

function Harness({ onSave = async () => {}, onResetSettings, setAppearance = () => {} }: { onSave?: (value: string) => Promise<void>; onResetSettings?: (reset: () => void) => void; setAppearance?: (value: PwaAppearance) => void }) {
  const [language, setLanguage] = useState<LanguagePreference>("system");
  const [enterSends, setEnterSends] = useState(true);
  const [showSessionStatusCard, setShowSessionStatusCard] = useState(true);
  const [textSize, setTextSize] = useState<PwaTextSizePreference>("standard");
  return <SettingsPage preferences={{ appearance: "system", setAppearance, language, setLanguage, enterSends, setEnterSends, showSessionStatusCard, setShowSessionStatusCard, textSize, setTextSize }} relayUrl="https://relay.invalid" defaultRelayUrl="https://relay.invalid" relayVersion={null} relayStatus="offline" extensionVersion={null} extensionStatus="offline" extensionTarget={null} onSave={onSave} onBack={() => {}} backLabel="Back" onClearData={() => {}} onResetSettings={onResetSettings} onShowShortcuts={() => {}} />;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
  resetTextSizeStateForTest();
});

test("controlled preferences change selected values without language or keyboard persistence", async () => {
  const before = [localStorage.getItem("pi-reach-language"), localStorage.getItem(ENTER_SENDS_STORAGE_KEY), localStorage.getItem(SESSION_STATUS_CARD_STORAGE_KEY), localStorage.getItem(TEXT_SIZE_STORAGE_KEY), document.documentElement.lang];
  const write = vi.spyOn(Storage.prototype, "setItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const screen = await renderPwa(<Harness />);
  const chinese = document.querySelector<HTMLInputElement>('[aria-labelledby="pwa-language-heading"] input[value="zh"]')!;
  await userEvent.click(chinese);
  expect(chinese.checked).toBe(true);
  const switchInput = screen.getByRole("switch", { name: getMessages().settings.enterSends });
  await switchInput.click();
  await expect.element(switchInput).not.toBeChecked();
  const statusSwitch = screen.getByRole("switch", { name: getMessages().settings.showSessionStatus });
  await statusSwitch.click();
  await expect.element(statusSwitch).not.toBeChecked();
  const extraLarge = document.querySelector<HTMLInputElement>('[aria-labelledby="pwa-text-size-heading"] input[value="xlarge"]')!;
  await userEvent.click(extraLarge);
  expect(extraLarge.checked).toBe(true);
  expect(document.documentElement.dataset.pwaTextSize).toBeUndefined();
  expect([localStorage.getItem("pi-reach-language"), localStorage.getItem(ENTER_SENDS_STORAGE_KEY), localStorage.getItem(SESSION_STATUS_CARD_STORAGE_KEY), localStorage.getItem(TEXT_SIZE_STORAGE_KEY), document.documentElement.lang]).toEqual(before);
  expect(write).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("heading", { level: 1, name: getMessages().settings.title })).toBeVisible();
});

test("reset is opt-in and its callback restores controlled defaults without persisting or transitioning unchanged appearance", async () => {
  const hidden = await renderPwa(<Harness />);
  expect(document.querySelector(".pwa-settings-group-actions")?.textContent).not.toContain(getMessages().settings.resetSettings);
  expect(document.querySelector(".pwa-settings-page")?.textContent).not.toContain(getMessages().settings.resetSettingsNote);
  await hidden.unmount();

  let reset: (() => void) | undefined;
  const appearance = vi.fn();
  const write = vi.spyOn(Storage.prototype, "setItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const screen = await renderPwa(<Harness onResetSettings={(callback) => { reset = callback; }} setAppearance={appearance} />);
  const enter = screen.getByRole("switch", { name: getMessages().settings.enterSends });
  const status = screen.getByRole("switch", { name: getMessages().settings.showSessionStatus });
  await enter.click();
  await status.click();
  await userEvent.click(document.querySelector<HTMLInputElement>('[aria-labelledby="pwa-language-heading"] input[value="zh"]')!);
  await userEvent.click(document.querySelector<HTMLInputElement>('[aria-labelledby="pwa-text-size-heading"] input[value="xlarge"]')!);
  await screen.getByRole("button", { name: getMessages().settings.resetSettings, exact: true }).click();
  await expect.element(enter).not.toBeChecked();
  await expect.element(status).not.toBeChecked();
  expect(reset).toBeTypeOf("function");
  reset!();
  await expect.element(enter).toBeChecked();
  await expect.element(status).toBeChecked();
  await expect.poll(() => document.querySelector<HTMLInputElement>('[aria-labelledby="pwa-language-heading"] input[value="system"]')!.checked).toBe(true);
  // 受控容器不支持系统字号时，默认 system 在界面解析为标准档。
  await expect.poll(() => document.querySelector<HTMLInputElement>('[aria-labelledby="pwa-text-size-heading"] input[value="standard"]')!.checked).toBe(true);
  expect(appearance).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test("controlled settings retain the real form's synchronous save gate and raw value", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const save = vi.fn(() => gate);
  const screen = await renderPwa(<Harness onSave={save} />);
  const input = screen.getByRole("textbox", { name: getMessages().settings.relayUrl });
  await input.fill("  https://changed.invalid/path/  ");
  const button = screen.getByRole("button", { name: getMessages().settings.save }).element();
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(save).toHaveBeenCalledExactlyOnceWith("  https://changed.invalid/path/  ");
  finish();
  await expect.poll(() => (button as HTMLButtonElement).disabled).toBe(false);
  await page.elementLocator(button).click();
  expect(save).toHaveBeenCalledTimes(2);
});
