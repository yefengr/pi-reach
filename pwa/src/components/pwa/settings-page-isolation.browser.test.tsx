import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { getMessages, type LanguagePreference } from "@/lib/i18n";
import { ENTER_SENDS_STORAGE_KEY } from "@/lib/pwa/keyboard-shortcuts";
import { resetTextSizeStateForTest, TEXT_SIZE_STORAGE_KEY, type PwaTextSize } from "@/lib/ui/text-size";
import { VIEWPORT_DEBUG_STORAGE_KEY } from "@/lib/pwa/viewport-debug";
import { SettingsPage } from "./settings-page";

function Harness({ onSave = async () => {} }: { onSave?: (value: string) => Promise<void> }) {
  const [language, setLanguage] = useState<LanguagePreference>("system");
  const [enterSends, setEnterSends] = useState(true);
  const [textSize, setTextSize] = useState<PwaTextSize>("standard");
  const [viewportDebug, setViewportDebug] = useState(false);
  return <SettingsPage preferences={{ language, setLanguage, enterSends, setEnterSends, textSize, setTextSize, viewportDebug, setViewportDebug }} relayUrl="https://relay.invalid" defaultRelayUrl="https://relay.invalid" relayVersion={null} relayStatus="offline" extensionVersion={null} extensionStatus="offline" extensionTarget={null} onSave={onSave} onBack={() => {}} backLabel="Back" onClearData={() => {}} onResetLayout={() => {}} onShowShortcuts={() => {}} />;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
  resetTextSizeStateForTest();
});

test("controlled preferences change selected values without language or keyboard persistence", async () => {
  const before = [localStorage.getItem("pi-reach-language"), localStorage.getItem(ENTER_SENDS_STORAGE_KEY), localStorage.getItem(TEXT_SIZE_STORAGE_KEY), localStorage.getItem(VIEWPORT_DEBUG_STORAGE_KEY), document.documentElement.lang];
  const write = vi.spyOn(Storage.prototype, "setItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const screen = await renderPwa(<Harness />);
  const chinese = document.querySelector<HTMLInputElement>('[aria-labelledby="pwa-language-heading"] input[value="zh"]')!;
  await userEvent.click(chinese);
  expect(chinese.checked).toBe(true);
  const switchInput = screen.getByRole("switch", { name: getMessages().settings.enterSends });
  await switchInput.click();
  await expect.element(switchInput).not.toBeChecked();
  const extraLarge = document.querySelector<HTMLInputElement>('[aria-labelledby="pwa-text-size-heading"] input[value="xlarge"]')!;
  await userEvent.click(extraLarge);
  expect(extraLarge.checked).toBe(true);
  expect(document.documentElement.dataset.pwaTextSize).toBeUndefined();
  const debugSwitch = screen.getByRole("switch", { name: getMessages().settings.viewportDebug });
  await debugSwitch.click();
  await expect.element(debugSwitch).toBeChecked();
  expect([localStorage.getItem("pi-reach-language"), localStorage.getItem(ENTER_SENDS_STORAGE_KEY), localStorage.getItem(TEXT_SIZE_STORAGE_KEY), localStorage.getItem(VIEWPORT_DEBUG_STORAGE_KEY), document.documentElement.lang]).toEqual(before);
  expect(write).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("heading", { level: 1, name: getMessages().settings.title })).toBeVisible();
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
