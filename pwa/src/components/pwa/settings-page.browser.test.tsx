import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { SettingsPage } from "./settings-page";
import { setLanguagePreference } from "@/lib/i18n";

const relayUrl = "https://relay.example.test";
const defaultRelayUrl = "https://relay.default.test";

type HarnessProps = {
  events?: string[];
  onSave?: (value: string) => Promise<void>;
  backLabel?: string;
};

function SettingsHarness({ events = [], onSave = async () => {}, backLabel = "Back to workspace" }: HarnessProps) {
  return <div className="pwa-root"><div className="pwa-settings-view"><SettingsPage
    relayUrl={relayUrl}
    defaultRelayUrl={defaultRelayUrl}
    onSave={onSave}
    onBack={() => events.push("back")}
    backLabel={backLabel}
    onClearData={() => events.push("clear")}
    onResetLayout={() => events.push("reset")}
  /></div></div>;
}

afterEach(async () => { await page.viewport(1280, 900); });

test("forwards the raw relay value and prevents duplicate saves until its deferred callback settles", async () => {
  const savedValues: string[] = [];
  let settled = false;
  let resolveSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => { resolveSave = resolve; });
  const screen = await renderPwa(<SettingsHarness onSave={(value) => {
    savedValues.push(value);
    return pendingSave.then(() => { settled = true; });
  }} />);
  const input = screen.getByRole("textbox", { name: "Relay URL" });
  const rawValue = "  https://relay.changed.test/path/  ";

  await expect.element(input).toHaveValue(relayUrl);
  await expect.element(input).toHaveAttribute("placeholder", defaultRelayUrl);
  await input.fill(rawValue);
  const saveButton = screen.getByRole("button", { name: "Save settings" }).element();
  saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const attemptsBeforeSettling = savedValues.length;

  resolveSave();
  await expect.poll(() => settled).toBe(true);
  await expect.poll(() => (saveButton as HTMLButtonElement).disabled).toBe(false);
  saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  expect(attemptsBeforeSettling).toBe(1);
  await expect.poll(() => savedValues).toEqual([rawValue, rawValue]);
});

test("routes back, reset and clear to the parent while staying on the page", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<SettingsHarness events={events} backLabel="Back to navigation" />);
  await screen.getByRole("button", { name: "Back to navigation" }).click();
  await screen.getByRole("button", { name: "Reset layout" }).click();
  await screen.getByRole("button", { name: "Clear local data" }).click();
  expect(events).toEqual(["back", "reset", "clear"]);
  await expect.element(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test.each([1280, 390])("lays out sections, back entry and reachable actions without horizontal overflow at %ipx", async (width) => {
  await page.viewport(width, 844);
  const screen = await renderPwa(<SettingsHarness />);
  const inner = document.querySelector<HTMLElement>(".pwa-settings-inner")!;
  const view = document.querySelector<HTMLElement>(".pwa-settings-view")!;
  expect(inner.getBoundingClientRect().width).toBeLessThanOrEqual(640);
  expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth);
  const sections = [...document.querySelectorAll<HTMLElement>(".pwa-settings-section")];
  expect(sections.map((section) => section.querySelector("h2")!.textContent)).toEqual(["Appearance", "Language", "Connection", "Browser data"]);
  expect(sections[1]!.getBoundingClientRect().top - sections[0]!.getBoundingClientRect().bottom).toBeCloseTo(32, 0);
  const back = screen.getByRole("button", { name: "Back to workspace" }).element();
  const title = screen.getByRole("heading", { level: 1, name: "Settings" }).element();
  if (width < 768) {
    // 移动端返回箭头与标题同一行，无文字。
    expect(Math.abs(back.getBoundingClientRect().top + back.getBoundingClientRect().height / 2 - (title.getBoundingClientRect().top + title.getBoundingClientRect().height / 2))).toBeLessThan(2);
    expect(back.getBoundingClientRect().width).toBe(44);
    expect(getComputedStyle(back.querySelector(".pwa-settings-back-label")!).display).toBe("none");
  } else {
    expect(title.getBoundingClientRect().top).toBeGreaterThanOrEqual(back.getBoundingClientRect().bottom);
    expect(getComputedStyle(title).fontSize).toBe("22px");
    await expect.element(screen.getByText("Back to workspace", { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `../../../.vitest/screenshots/settings-page-top-${width}.png` });
  for (const name of ["Save settings", "Reset layout", "Clear local data"]) {
    const action = screen.getByRole("button", { name });
    action.element().scrollIntoView({ block: "nearest" });
    await expect.element(action).toBeVisible();
    expect(action.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `../../../.vitest/screenshots/settings-page-${width}.png` });
});

test("switches the interface language immediately and remembers a manual choice", async () => {
  const screen = await renderPwa(<SettingsHarness />);
  try {
    const chinese = screen.getByRole("radio", { name: /中文/ });
    await chinese.click();
    await expect.element(screen.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem("pi-reach-language")).toBe("zh");
    await expect.element(chinese).toBeChecked();
    await expect.element(chinese).toHaveFocus();

    const english = screen.getByRole("radio", { name: /English/ });
    await english.click();
    await expect.element(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    expect(document.documentElement.lang).toBe("en");
    expect(window.localStorage.getItem("pi-reach-language")).toBe("en");

    await screen.getByRole("radio", { name: /Follow browser/ }).click();
    expect(window.localStorage.getItem("pi-reach-language")).toBeNull();
    expect(document.documentElement.lang).toBe(navigator.languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en");
  } finally {
    setLanguagePreference("system");
  }
});
