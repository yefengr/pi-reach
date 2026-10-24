import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { getMessages } from "@/lib/i18n";
import { viewportDiagnosticsEnabled } from "@/lib/pwa/timeline-viewport-diagnostics";
import { VIEWPORT_DEBUG_REPORT_FORMAT, VIEWPORT_DEBUG_STORAGE_KEY, ViewportFrameRecorder, useViewportDebug, type ViewportMark } from "@/lib/pwa/viewport-debug";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaUiProvider } from "./pwa-ui-provider";
import { SettingsPage } from "./settings-page";

const SECRET = "Private message body";

function DebugToggle() {
  const [enabled, setEnabled] = useViewportDebug();
  return <button onClick={() => setEnabled(!enabled)}>Toggle diagnostics</button>;
}

function Workspace({ debugControl = false }: { debugControl?: boolean }) {
  return <div className="pwa-root"><main className="pwa-main">
    <header className="pwa-title-bar">Title{debugControl ? <DebugToggle /> : null}</header>
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
  const mark = vi.spyOn(ViewportFrameRecorder.prototype, "mark");
  const screen = await render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Settings /></PwaAppShell></PwaUiProvider>);
  const label = getMessages().viewportDebug.label;
  const toggle = screen.getByRole("switch", { name: getMessages().settings.viewportDebug });
  expect(document.querySelector(".pwa-viewport-debug")).toBeNull();

  await toggle.click();
  await expect.element(screen.getByRole("region", { name: label })).toBeVisible();
  expect(window.localStorage.getItem(VIEWPORT_DEBUG_STORAGE_KEY)).toBe("true");
  await expect.poll(() => viewportDiagnosticsEnabled()).toBe(true);
  await screen.getByRole("button", { name: getMessages().viewportDebug.documentLockExperiment }).click();
  expect(document.querySelector(".pwa-viewport-debug[data-document-lock-bypass]")).not.toBeNull();

  await toggle.click();
  await expect.poll(() => document.querySelector(".pwa-viewport-debug")).toBeNull();
  expect(window.localStorage.getItem(VIEWPORT_DEBUG_STORAGE_KEY)).toBe("false");
  expect(viewportDiagnosticsEnabled()).toBe(false);
  expect(document.querySelector("[data-document-lock-bypass]")).toBeNull();
  const afterDisable = mark.mock.calls.length;
  window.dispatchEvent(new Event("resize"));
  for (let frame = 0; frame < 2; frame += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  expect(mark.mock.calls.length).toBe(afterDisable);
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

test("captures the actual controller decision and document boxes without changing partial recovery", async () => {
  await page.viewport(402, 874);
  class ViewportMock extends EventTarget {
    height = 874;
    offsetTop = 0;
    scale = 1;
    change(height: number) { this.height = height; this.dispatchEvent(new Event("resize")); }
  }
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(812);
  window.localStorage.setItem(VIEWPORT_DEBUG_STORAGE_KEY, "true");
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  const screen = await render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Workspace /></PwaAppShell></PwaUiProvider>);
  try {
    await expect.poll(() => document.querySelector(".pwa-viewport-debug pre")?.textContent).toMatch(/^#\d+/);
    const input = screen.getByRole("textbox", { name: "Draft" }).element() as HTMLTextAreaElement;
    const shell = document.querySelector<HTMLElement>(".pwa-app-shell")!;
    input.focus();
    viewport.change(470);
    expect(shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    input.blur();
    viewport.change(812);
    await expect.poll(() => shell.hasAttribute("data-keyboard-closing")).toBe(true);
    await expect.poll(() => shell.hasAttribute("data-keyboard-closing")).toBe(false);
    expect(shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect(Math.round(shell.getBoundingClientRect().height)).toBe(812);

    await screen.getByRole("button", { name: getMessages().viewportDebug.copy }).click();
    const raw = writeText.mock.calls[0]![0];
    expect(raw).not.toContain(SECRET);
    const report = JSON.parse(raw) as { environment: { buildAsset: string }; marks: ViewportMark[] };
    expect(report.environment.buildAsset).toMatch(/\.(?:js|ts)$/);
    const decisions = report.marks.filter(mark => mark.kind === "keyboard-update");
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.some(mark => mark.controller?.reason === "closing" && mark.controller.restored === false)).toBe(true);
    const held = decisions.find(mark => mark.controller?.reason === "compensated" && mark.controller.lastHeight === 812);
    expect(held?.controller).toMatchObject({ appHeight: 874, unfocusedInset: 0, restoreThreshold: 873, adjusted: true,
      viewportHeight: 812, restored: false, closing: false, closingTarget: null });
    expect(held?.snapshot).toMatchObject({ vvHeight: 812, innerHeight: 874, docHeight: 812,
      rootBoxHeight: 812, bodyBoxHeight: 812, documentLocked: true, documentLockHeight: 812 });
    expect(report.marks.find(mark => mark.kind === "vv-resize" && mark.snapshot?.vvHeight === 470)?.snapshot)
      .toMatchObject({ documentLocked: true, documentLockHeight: 470 });

    // 模拟窗口变化令自然应用高度更新；不将此夹具冒充原生旋转或键盘实验。
    shell.style.setProperty("--pwa-app-height", "700px");
    viewport.change(500);
    await screen.getByRole("button", { name: getMessages().viewportDebug.copy }).click();
    const resized = JSON.parse(writeText.mock.calls[1]![0]) as { marks: ViewportMark[] };
    expect(resized.marks.find(mark => mark.controller?.appHeight === 700)?.controller)
      .toMatchObject({ previousHeight: 812, lastHeight: 500, viewportHeight: 500 });

    shell.style.removeProperty("--pwa-app-height");
    viewport.change(874);
    await expect.poll(() => shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    await screen.getByRole("button", { name: getMessages().viewportDebug.copy }).click();
    const restored = JSON.parse(writeText.mock.calls[2]![0]) as { marks: ViewportMark[] };
    expect(restored.marks.find(mark => mark.controller?.reason === "restored")?.controller)
      .toMatchObject({ previousHeight: 500, lastHeight: 0, adjusted: false, restoreThreshold: 873 });
  } finally {
    await screen.unmount();
    vi.unstubAllGlobals();
    await page.viewport(1280, 900);
  }
});

test("document lock experiment changes only the height constraint and restores the latest lock on exit", async () => {
  await page.viewport(402, 874);
  class ViewportMock extends EventTarget {
    height = 874;
    offsetTop = 0;
    scale = 1;
    change(height: number) { this.height = height; this.dispatchEvent(new Event("resize")); }
  }
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(812);
  window.localStorage.setItem(VIEWPORT_DEBUG_STORAGE_KEY, "true");
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  // 模拟 standalone 的自然文档高度规则；VV仍是人工输入，不模拟WebKit反馈。
  const style = document.createElement("style");
  style.textContent = "html:has(.pwa-root), body:has(.pwa-root) { height: 874px; }";
  document.head.append(style);
  const screen = await render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Workspace debugControl /></PwaAppShell></PwaUiProvider>);
  try {
    const button = screen.getByRole("button", { name: getMessages().viewportDebug.documentLockExperiment });
    await expect.element(button).toHaveAttribute("aria-pressed", "false");
    const input = screen.getByRole("textbox", { name: "Draft" }).element() as HTMLTextAreaElement;
    const root = document.documentElement;
    const shell = document.querySelector<HTMLElement>(".pwa-app-shell")!;
    const enabledBackground = getComputedStyle(button.element()).backgroundColor;
    input.focus();
    viewport.change(470);
    await expect.element(button).toBeDisabled();
    expect(getComputedStyle(button.element()).cursor).toBe("not-allowed");
    expect(getComputedStyle(button.element()).backgroundColor).not.toBe(enabledBackground);
    (button.element() as HTMLButtonElement).click();
    expect(document.querySelector("[data-document-lock-bypass]")).toBeNull();
    expect(document.activeElement).toBe(input);
    input.blur();
    viewport.change(812);
    // 同任务内尚未提交closing CSS时也必须拒绝切换。
    (button.element() as HTMLButtonElement).click();
    expect(document.querySelector("[data-document-lock-bypass]")).toBeNull();
    await expect.poll(() => shell.hasAttribute("data-keyboard-closing")).toBe(true);
    await expect.poll(() => shell.hasAttribute("data-keyboard-closing")).toBe(false);
    await expect.element(button).toBeEnabled();
    const rect = () => Math.round(root.getBoundingClientRect().height);
    expect(rect()).toBe(812);
    const before = shell.outerHTML;
    const focusBeforeToggle = document.activeElement;
    await button.click();
    expect(document.activeElement).toBe(focusBeforeToggle);
    await expect.element(button).toHaveAttribute("aria-pressed", "true");
    expect(rect()).toBe(874);
    expect(Math.round(document.body.getBoundingClientRect().height)).toBe(874);
    expect(shell.outerHTML).toBe(before);
    expect(root.hasAttribute("data-pwa-keyboard")).toBe(true);
    expect(root.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("812px");
    await screen.getByRole("button", { name: getMessages().viewportDebug.copy }).click();
    const report = JSON.parse(writeText.mock.calls.at(-1)![0]);
    const marks = report.marks.filter((mark: ViewportMark) => mark.kind.startsWith("document-lock-"));
    expect(marks.map((mark: ViewportMark) => mark.kind)).toEqual(["document-lock-before", "document-lock-after"]);
    expect(marks[0].snapshot).toMatchObject({ documentLockBypassed: false, documentLocked: true, rootBoxHeight: 812, shellHeight: 812 });
    expect(marks[1].snapshot).toMatchObject({ documentLockBypassed: true, documentLocked: true, rootBoxHeight: 874, shellHeight: 812 });
    expect(report.environment.documentLockBypassed).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET);

    await screen.getByRole("button", { name: getMessages().viewportDebug.clear }).click();
    await screen.getByRole("button", { name: getMessages().viewportDebug.copy }).click();
    const cleared = JSON.parse(writeText.mock.calls.at(-1)![0]);
    expect(cleared.marks.filter((mark: ViewportMark) => mark.kind.startsWith("document-lock-")))
      .toMatchObject([{ kind: "document-lock-state", snapshot: { documentLockBypassed: true } }]);
    expect(cleared.environment.documentLockBypassed).toBe(true);
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(64);
    viewport.change(700);
    expect(scroll).toHaveBeenCalledWith({ top: 0, left: window.scrollX, behavior: "instant" });
    scrollY.mockRestore();
    expect(root.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("700px");
    expect(rect()).toBe(874);
    expect(Math.round(shell.getBoundingClientRect().height)).toBe(700);
    await button.click();
    expect(rect()).toBe(700);
    expect(Math.round(document.body.getBoundingClientRect().height)).toBe(700);
    await button.click();
    expect(rect()).toBe(874);
    await screen.getByRole("button", { name: "Toggle diagnostics" }).click();
    await expect.poll(() => document.querySelector(".pwa-viewport-debug")).toBeNull();
    expect(rect()).toBe(700);
    expect(root.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("700px");
    expect(Math.round(shell.getBoundingClientRect().height)).toBe(700);
    await screen.getByRole("button", { name: "Toggle diagnostics" }).click();
    await expect.element(button).toHaveAttribute("aria-pressed", "false");
    await button.click();
    expect(rect()).toBe(874);
  } finally {
    await screen.unmount();
    expect(document.querySelector("[data-document-lock-bypass]")).toBeNull();
    style.remove();
    vi.unstubAllGlobals();
    await page.viewport(1280, 900);
  }
  const fresh = await render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Workspace /></PwaAppShell></PwaUiProvider>);
  await expect.element(fresh.getByRole("button", { name: getMessages().viewportDebug.documentLockExperiment })).toHaveAttribute("aria-pressed", "false");
});

test.each([[320, 568], [402, 874], [874, 402]])("experiment control stays visible, hit-testable and keyboard accessible at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  window.localStorage.setItem(VIEWPORT_DEBUG_STORAGE_KEY, "true");
  const screen = await render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><Workspace /></PwaAppShell></PwaUiProvider>);
  try {
    const button = screen.getByRole("button", { name: getMessages().viewportDebug.documentLockExperiment });
    await expect.element(button).toBeEnabled();
    const element = button.element() as HTMLButtonElement;
    const rect = element.getBoundingClientRect();
    const label = element.querySelector<HTMLElement>(".mantine-Button-label")!;
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    expect(Math.round(rect.left)).toBeGreaterThanOrEqual(0);
    expect(Math.round(rect.right)).toBeLessThanOrEqual(width);
    expect(Math.round(rect.bottom)).toBeLessThanOrEqual(height);
    expect(element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))).toBe(true);
    element.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(button).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(element);
    await userEvent.keyboard(" ");
    await expect.element(button).toHaveAttribute("aria-pressed", "false");
    expect(Math.round(element.getBoundingClientRect().height)).toBe(Math.round(rect.height));
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});
