import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getMessages } from "@/lib/i18n";
import { viewportDiagnosticsEnabled } from "@/lib/pwa/timeline-viewport-diagnostics";
import { VIEWPORT_DEBUG_REPORT_FORMAT, VIEWPORT_DEBUG_STORAGE_KEY } from "@/lib/pwa/viewport-debug";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaUiProvider } from "./pwa-ui-provider";
import { SettingsPage } from "./settings-page";

const SECRET = "Private message body";

function Workspace() {
  return <div className="pwa-root"><main className="pwa-main">
    <header className="pwa-title-bar">Title</header>
    <div className="pwa-message-list" style={{ height: 120, overflow: "auto" }}><p style={{ height: 400 }}>{SECRET}</p></div>
    <div className="pwa-composer"><textarea aria-label="Draft" defaultValue={SECRET} /></div>
  </main></div>;
}

function Settings() {
  return <SettingsPage relayUrl="https://relay.invalid" defaultRelayUrl="https://relay.invalid" relayVersion={null} relayStatus="offline"
    extensionVersion={null} extensionStatus="offline" extensionTarget={null} onSave={async () => {}} onBack={() => {}} backLabel="Back"
    onClearData={() => {}} onResetLayout={() => {}} onShowShortcuts={() => {}} />;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(VIEWPORT_DEBUG_STORAGE_KEY);
});

test("settings switch persists the debug overlay and removes it when turned off", async () => {
  const screen = await render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Settings /></PwaAppShell></PwaUiProvider>);
  const label = getMessages().viewportDebug.label;
  const toggle = screen.getByRole("switch", { name: getMessages().settings.viewportDebug });
  expect(document.querySelector(".pwa-viewport-debug")).toBeNull();

  await toggle.click();
  await expect.element(screen.getByRole("region", { name: label })).toBeVisible();
  expect(window.localStorage.getItem(VIEWPORT_DEBUG_STORAGE_KEY)).toBe("true");
  await expect.poll(() => viewportDiagnosticsEnabled()).toBe(true);

  await toggle.click();
  await expect.poll(() => document.querySelector(".pwa-viewport-debug")).toBeNull();
  expect(window.localStorage.getItem(VIEWPORT_DEBUG_STORAGE_KEY)).toBe("false");
  expect(viewportDiagnosticsEnabled()).toBe(false);
});

test("overlay samples each frame without blocking the page and copies a numbers-only report", async () => {
  window.localStorage.setItem(VIEWPORT_DEBUG_STORAGE_KEY, "true");
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  const screen = await render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Workspace /></PwaAppShell></PwaUiProvider>);
  await screen.getByRole("textbox", { name: "Draft" }).click();

  const overlay = document.querySelector<HTMLElement>(".pwa-viewport-debug")!;
  const text = () => overlay.querySelector("pre")?.textContent ?? "";
  await expect.poll(() => /^#\d+/.test(text())).toBe(true);
  await expect.poll(() => text()).toContain("focus text");
  expect(text()).toMatch(/title \d/);
  expect(getComputedStyle(overlay).pointerEvents).toBe("none");
  expect(overlay.closest(".pwa-app-shell")).toBeNull();

  await screen.getByRole("button", { name: getMessages().viewportDebug.copy }).click();
  await expect.element(screen.getByRole("status").filter({ hasText: getMessages().viewportDebug.copied })).toBeVisible();
  const raw = writeText.mock.calls[0]![0];
  expect(raw).not.toContain(SECRET);
  const report = JSON.parse(raw);
  expect(report.format).toBe(VIEWPORT_DEBUG_REPORT_FORMAT);
  expect(report.frames.rows.length).toBeGreaterThan(1);
  expect(report.marks.some((mark: { kind: string }) => mark.kind === "focusin")).toBe(true);
  const focus = report.frames.columns.indexOf("focus");
  expect(report.frames.rows.at(-1)[focus]).toBe("text");
});
