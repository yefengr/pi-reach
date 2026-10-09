import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
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
  versions?: Partial<Pick<ComponentProps<typeof SettingsPage>, "relayVersion" | "relayStatus" | "extensionVersion" | "extensionStatus" | "extensionTarget">>;
};

function SettingsHarness({ events = [], onSave = async () => {}, backLabel = "Back to workspace", versions = {} }: HarnessProps) {
  return <div className="pwa-root"><div className="pwa-settings-view"><SettingsPage
    relayUrl={relayUrl}
    defaultRelayUrl={defaultRelayUrl}
    relayVersion={null}
    relayStatus="offline"
    extensionVersion={null}
    extensionStatus="offline"
    extensionTarget={null}
    {...versions}
    onSave={onSave}
    onBack={() => events.push("back")}
    backLabel={backLabel}
    onClearData={() => events.push("clear")}
    onResetLayout={() => events.push("reset")}
  /></div></div>;
}

afterEach(async () => { vi.restoreAllMocks(); await page.viewport(1280, 900); });

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
  expect(sections.map((section) => section.querySelector("h2")!.textContent)).toEqual(["Appearance", "Language", "Connection", "Browser data", "About"]);
  expect(sections[1]!.getBoundingClientRect().top - sections[0]!.getBoundingClientRect().bottom).toBeCloseTo(32, 0);
  const back = screen.getByRole("button", { name: "Back to workspace" }).element();
  const title = screen.getByRole("heading", { level: 1, name: "Settings" }).element();
  if (width < 768) {
    // 移动端返回箭头与标题同一行，无文字。
    expect(Math.abs(back.getBoundingClientRect().top + back.getBoundingClientRect().height / 2 - (title.getBoundingClientRect().top + title.getBoundingClientRect().height / 2))).toBeLessThan(2);
    expect(back.getBoundingClientRect().width).toBe(44);
    expect(getComputedStyle(back.querySelector(".pwa-settings-back-label")!).display).toBe("none");
    expect(getComputedStyle(title).fontSize).toBe("18px");
  } else {
    expect(title.getBoundingClientRect().top).toBeGreaterThanOrEqual(back.getBoundingClientRect().bottom);
    expect(getComputedStyle(title).fontSize).toBe("24px");
    await expect.element(screen.getByText("Back to workspace", { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `../../../.vitest/screenshots/settings-page-top-${width}.png` });
  for (const name of ["Save settings", "Reset layout", "Clear local data", "Copy version information"]) {
    const action = screen.getByRole("button", { name });
    action.element().scrollIntoView({ block: "nearest" });
    await expect.element(action).toBeVisible();
    expect(action.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  const about = document.querySelector<HTMLElement>('[aria-labelledby="pwa-about-heading"]')!;
  about.scrollIntoView({ block: "end" });
  for (const row of about.querySelectorAll("dd")) await expect.element(page.elementLocator(row)).toBeVisible();
  expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth);
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
    await expect.element(screen.getByRole("heading", { name: "关于" })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "复制版本信息" })).toBeInTheDocument();
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

test.each([
  { status: "offline" as const, expected: "Not connected" },
  { status: "connecting" as const, expected: "Getting version…" },
  { status: "retrying" as const, expected: "Getting version…" },
  { status: "online" as const, expected: "Version unavailable" },
])("shows the current connection state without presenting retained versions as live ($status)", async ({ status, expected }) => {
  await renderPwa(<SettingsHarness versions={{ relayStatus: status, relayVersion: status === "online" ? null : "old-relay", extensionStatus: status, extensionVersion: status === "online" ? null : "old-extension", extensionTarget: "Computer · Pi" }} />);
  expect(document.querySelector('[data-version="relay"]')?.textContent).toBe(expected);
  expect(document.querySelector('[data-version="extension"]')?.textContent).toBe(expected);
});

test("copies only versions and statuses, excluding the current Pi identity and Relay URL", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const target = "private-computer · private-session /private/workspace";
  const screen = await renderPwa(<SettingsHarness versions={{ relayStatus: "online", relayVersion: "2.3.4", extensionStatus: "online", extensionVersion: "3.4.5", extensionTarget: target }} />);
  const pwaVersion = document.querySelector('[data-version="pwa"]')?.textContent;
  expect(pwaVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(document.querySelector('[data-version="relay"]')?.textContent).toBe("2.3.4");
  expect(document.querySelector('[data-version="extension"]')?.textContent).toBe("3.4.5");
  await expect.element(screen.getByText(`Current Pi: ${target}`)).toBeInTheDocument();
  await screen.getByRole("button", { name: "Copy version information" }).click();
  expect(writeText).toHaveBeenCalledWith(`PWA: ${pwaVersion}\nRelay: 2.3.4\nExtension: 3.4.5`);
  expect(writeText.mock.calls[0]?.[0]).not.toContain("private-");
  expect(writeText.mock.calls[0]?.[0]).not.toContain(relayUrl);
  await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
});

test("the desktop settings header clears a translucent status bar", async () => {
  const safeTop = 24;
  await page.viewport(1024, 768);
  document.documentElement.style.setProperty("--pwa-safe-top", `${safeTop}px`);
  try {
    const screen = await renderPwa(<SettingsHarness />);
    const back = screen.getByRole("button", { name: "Back to workspace" });
    await expect.element(back).toBeVisible();
    // 设置页在安全区之下仍保留桌面原有 32px 上边距。
    expect(Math.round(document.querySelector(".pwa-settings-header")!.getBoundingClientRect().top)).toBe(safeTop + 32);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-top");
  }
});

test("the mobile settings top bar stays fixed below a translucent status bar", async () => {
  const safeTop = 24;
  await page.viewport(390, 480);
  document.documentElement.style.setProperty("--pwa-safe-top", `${safeTop}px`);
  try {
    const screen = await renderPwa(<SettingsHarness />);
    const back = screen.getByRole("button", { name: "Back to workspace" });
    await expect.element(back).toBeVisible();
    const header = document.querySelector<HTMLElement>(".pwa-settings-header")!;
    const view = document.querySelector<HTMLElement>(".pwa-settings-view")!;
    expect(view.scrollHeight).toBeGreaterThan(view.clientHeight);
    view.scrollTop = 200;
    await expect.poll(() => view.scrollTop).toBe(200);
    // 与会话标题区同一规格：安全区之下 56px 首行、铺满屏宽，返回按钮距左缘 4px 并垂直居中。
    const box = header.getBoundingClientRect();
    expect(Math.round(box.top)).toBe(0);
    expect(Math.round(box.height)).toBe(56 + safeTop);
    expect(Math.round(box.left)).toBe(0);
    expect(Math.round(box.width)).toBe(390);
    const backBox = back.element().getBoundingClientRect();
    expect(Math.round(backBox.left)).toBe(4);
    expect(Math.abs(backBox.top + backBox.height / 2 - (safeTop + 28))).toBeLessThanOrEqual(1);
    // 状态栏区域内命中的是顶栏，而不是滚上来的设置内容。
    expect(document.elementFromPoint(195, safeTop / 2)).toBe(header);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-top");
  }
});

test("scrolled desktop settings content stays below a translucent status bar", async () => {
  const safeTop = 24;
  await page.viewport(1024, 480);
  document.documentElement.style.setProperty("--pwa-safe-top", `${safeTop}px`);
  try {
    const screen = await renderPwa(<SettingsHarness />);
    await expect.element(screen.getByRole("button", { name: "Back to workspace" })).toBeVisible();
    // 遮挡条不占布局高度：内容区仍从页面顶端开始，由自身上内边距避让安全区。
    expect(Math.round(document.querySelector(".pwa-settings-inner")!.getBoundingClientRect().top)).toBe(0);
    const view = document.querySelector<HTMLElement>(".pwa-settings-view")!;
    expect(view.scrollHeight).toBeGreaterThan(view.clientHeight);
    view.scrollTop = 200;
    await expect.poll(() => view.scrollTop).toBe(200);
    const shield = document.querySelector(".pwa-status-bar-shield")!;
    expect(Math.round(shield.getBoundingClientRect().top)).toBe(0);
    expect(Math.round(shield.getBoundingClientRect().height)).toBe(safeTop);
    // 状态栏区域内命中的是遮挡条，而不是滚上来的设置内容。
    expect(document.elementFromPoint(512, safeTop / 2)).toBe(shield);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-top");
  }
});
