import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { getMessages } from "@/lib/i18n";
import { viewportDiagnosticsEnabled } from "@/lib/pwa/timeline-viewport-diagnostics";
import { VIEWPORT_DEBUG_STORAGE_KEY, ViewportFrameRecorder } from "@/lib/pwa/viewport-debug";
import { KeyboardDiagnosticsPage } from "./keyboard-diagnostics-page";

class ViewportMock extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
  scale = 1;
  change(height: number, scale = 1) { this.height = height; this.scale = scale; this.dispatchEvent(new Event("resize")); }
}
const shell = () => document.querySelector<HTMLElement>(".pwa-keyboard-diagnostics")!;
const input = () => shell().querySelector<HTMLTextAreaElement>("textarea")!;
const button = (mode: string) => shell().querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)!;
const mode = () => shell().dataset.diagnosticsMode;
async function frames(count = 3) { for (let i = 0; i < count; i += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
async function ready() { await expect.poll(() => button("native").disabled).toBe(false); }
async function select(value: string) { await ready(); button(value).click(); await expect.poll(mode).toBe(value); await ready(); }
async function mount() {
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await render(<StrictMode><KeyboardDiagnosticsPage /></StrictMode>);
  await ready();
  return { view, viewport };
}
const rect = (node: Element) => {
  const value = node.getBoundingClientRect();
  return [value.top, value.left, value.width, value.height].map(Math.round);
};
function geometry() {
  return [shell(), shell().querySelector(".pwa-title-bar")!, shell().querySelector(".pwa-composer")!,
    shell().querySelector(".pwa-message-list")!, document.documentElement, document.body].map(rect);
}

const standaloneRules: { rule: CSSMediaRule; media: string }[] = [];
// CDP不会改变display-mode；显式启用已加载的真实规则，仅验证CSS盒高，不冒充安装态浏览器。
function enableStandaloneCssFixture() {
  for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSMediaRule) || !rule.conditionText.includes("display-mode: standalone")) continue;
    standaloneRules.push({ rule, media: rule.media.mediaText });
    rule.media.mediaText = "all";
  }
  expect(standaloneRules.length).toBeGreaterThan(0);
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-app-height").trim()).toBe("100lvh");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(VIEWPORT_DEBUG_STORAGE_KEY);
  for (const { rule, media } of standaloneRules.splice(0)) rule.media.mediaText = media;
  await page.viewport(1280, 900);
});

test.each([[320, 568, false], [402, 874, false], [874, 402, false], [402, 874, true]] as const)("same initial geometry and usable controls at %ix%i standalone-CSS-fixture=%s", async (width, height, standalone) => {
  await page.viewport(width, height);
  if (standalone) enableStandaloneCssFixture();
  const { view } = await mount();
  const initial = geometry();
  const initialDensity = { compact: shell().dataset.compactHeight, wide: shell().hasAttribute("data-wide-compact") };
  expect(getComputedStyle(shell()).position).not.toBe("fixed");
  for (const value of ["prefixed", "native", "current"]) {
    await select(value);
    await frames();
    const next = geometry();
    expect({ compact: shell().dataset.compactHeight, wide: shell().hasAttribute("data-wide-compact") }).toEqual(initialDensity);
    next.forEach((box, index) => box.forEach((coordinate, axis) => expect(Math.abs(coordinate - initial[index]![axis]!)).toBeLessThanOrEqual(1)));
    expect(getComputedStyle(shell()).position === "fixed").toBe(value === "prefixed");
    for (const control of shell().querySelectorAll("[data-mode], a")) {
      const box = control.getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(width + 1);
    }
    expect(input().getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
    expect(input().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  await view.unmount();
});

test.each(["current", "prefixed"])("%s compensates, blocks partial/pending/closing/refocus, resets without changing its position experiment", async value => {
  await page.viewport(402, 874);
  const { view, viewport } = await mount();
  if (value !== "current") await select(value);
  const before = shell();
  input().focus({ preventScroll: true });
  // 点击必须同步复核，不依赖下一帧disabled。
  button("native").click();
  expect(mode()).toBe(value);
  expect(document.activeElement).toBe(input());
  viewport.change(470);
  expect(before.hasAttribute("data-keyboard-viewport")).toBe(true);
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(true);
  expect(Math.round(before.getBoundingClientRect().height)).toBe(470);
  expect(input().getBoundingClientRect().bottom).toBeLessThanOrEqual(471);
  const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  button("native").dispatchEvent(pointer);
  expect(pointer.defaultPrevented).toBe(true);
  input().blur();
  button("native").click();
  expect(mode()).toBe(value);
  viewport.change(812);
  await expect.poll(() => before.hasAttribute("data-keyboard-closing")).toBe(false);
  button("native").click();
  expect(mode()).toBe(value);
  viewport.change(874);
  button("native").click();
  expect(mode()).toBe(value);
  input().focus();
  button("native").click();
  expect(mode()).toBe(value);
  input().blur();
  await ready();
  expect(getComputedStyle(before).position === "fixed").toBe(value === "prefixed");
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
  expect(before.style.getPropertyValue("--pwa-viewport-height")).toBe("");
  await select("native");
  expect(before.isConnected).toBe(false);
  expect(before.hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(before.hasAttribute("data-compact-height")).toBe(false);
  await view.unmount();
});

test("native has only common sampler subscriptions, never compensates or scrolls the window and does not relearn after blur", async () => {
  await page.viewport(402, 874);
  const { view, viewport } = await mount();
  const add = vi.spyOn(viewport, "addEventListener");
  const remove = vi.spyOn(viewport, "removeEventListener");
  await select("native");
  const active = add.mock.calls.filter(call => !remove.mock.calls.some(removed => removed[0] === call[0] && removed[1] === call[1]));
  expect(active.map(call => call[0]).sort()).toEqual(["resize", "scroll"]);
  const scroll = vi.spyOn(window, "scrollTo");
  input().focus();
  viewport.change(470);
  await frames();
  expect(shell().hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(shell().hasAttribute("data-compact-height")).toBe(false);
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
  expect(scroll).not.toHaveBeenCalled();
  input().blur();
  await frames();
  expect(button("current").disabled).toBe(true);
  viewport.change(812);
  await frames();
  button("current").click();
  expect(mode()).toBe("native");
  viewport.change(874);
  await select("current");
  // current + prefixed each install controller and sampler; native only sampler.
  expect(remove.mock.calls.length).toBeGreaterThanOrEqual(6);
  await view.unmount();
});

test("native keeps only the measured closed-state density through focus, compression and recovery", async () => {
  await page.viewport(320, 568);
  const { view, viewport } = await mount();
  await select("native");
  expect(shell().dataset.compactHeight).toBe("short");
  input().focus();
  viewport.change(280);
  await frames();
  expect(shell().dataset.compactHeight).toBe("short");
  expect(shell().hasAttribute("data-keyboard-viewport")).toBe(false);
  input().blur();
  viewport.change(470);
  await frames();
  expect(shell().dataset.compactHeight).toBe("short");
  expect(button("current").disabled).toBe(true);
  viewport.change(568);
  await ready();
  expect(shell().dataset.compactHeight).toBe("short");
  await view.unmount();
});

test.each(["current", "prefixed", "native"])("%s restores mode switching after layout viewport height and VV recover together", async value => {
  await page.viewport(402, 874);
  const { view, viewport } = await mount();
  if (value !== "current") await select(value);
  input().focus();
  await page.viewport(402, 470);
  viewport.change(470);
  await frames();
  expect(window.innerHeight).toBe(470);
  expect(button("current").disabled).toBe(true);
  input().blur();
  await page.viewport(402, 812);
  viewport.change(812);
  await frames();
  const next = value === "native" ? "current" : "native";
  button(next).click();
  expect(mode()).toBe(value);
  expect(button(next).disabled).toBe(true);
  await page.viewport(402, 874);
  viewport.change(874);
  await select(next);
  await view.unmount();
});

test("compressed initial innerHeight cannot lower a known natural shell baseline", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  viewport.change(470);
  vi.stubGlobal("innerHeight", 470);
  vi.stubGlobal("visualViewport", viewport);
  const view = await render(<KeyboardDiagnosticsPage />);
  await frames();
  expect(Math.round(shell().getBoundingClientRect().height)).toBe(874);
  expect(button("native").disabled).toBe(true);
  vi.stubGlobal("innerHeight", 874);
  viewport.change(874);
  window.dispatchEvent(new Event("resize"));
  await frames();
  // 初始基准无效时只允许通过原生链接重建，不能在收起阶段重学。
  expect(button("native").disabled).toBe(true);
  await view.unmount();
});

test("mode and draft are memory only; export is three bounded latest rounds and never contains draft or sample body", async () => {
  await page.viewport(402, 874);
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const { view } = await mount();
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  const secret = "PRIVATE_DRAFT_NOT_FOR_REPORT";
  await userEvent.fill(input(), secret);
  input().blur();
  await select("prefixed");
  expect(input().value).toBe("");
  await select("native");
  await select("current");
  await frames();
  await view.getByRole("button", { name: getMessages().viewportDebug.copy, exact: true }).click();
  const raw = writeText.mock.calls[0]![0];
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain("Fixed local sample");
  const report = JSON.parse(raw);
  expect(report.format).toBe("pi-reach-keyboard-diagnostics/1");
  expect(report.rounds.map((round: { mode: string }) => round.mode)).toEqual(["current", "prefixed", "native"]);
  for (const round of report.rounds) {
    expect(round.report.format).toBe("pi-reach-viewport-debug/1");
    expect(round.report.environment.mode).toBe(round.mode);
    expect(round.report.frames.rows.length).toBeGreaterThan(0);
    expect(round.report.frames.rows.length).toBeLessThanOrEqual(1800);
    expect(round.report.marks.length).toBeLessThanOrEqual(512);
    expect(round.report.timeline.length).toBeLessThanOrEqual(256);
  }
  expect(storage).not.toHaveBeenCalled();
  await view.unmount();
  const again = await mount();
  expect(mode()).toBe("current");
  await again.view.unmount();
});

test("no viewport, invalid scale, rotated window and compressed initial entry fail safely", async () => {
  await page.viewport(402, 874);
  vi.stubGlobal("visualViewport", undefined);
  const missing = await render(<KeyboardDiagnosticsPage />);
  await frames();
  expect(button("native").disabled).toBe(true);
  expect(shell().querySelectorAll("a").length).toBe(2);
  await missing.unmount();
  const { view, viewport } = await mount();
  viewport.change(874, 1.1);
  button("native").click();
  expect(mode()).toBe("current");
  await frames();
  expect(button("native").disabled).toBe(true);
  viewport.change(874);
  await ready();
  await page.viewport(874, 402);
  await frames();
  expect(button("native").disabled).toBe(true);
  await page.viewport(402, 874);
  await frames();
  expect(button("native").disabled).toBe(true);
  await view.unmount();
  viewport.change(470);
  const compressed = await render(<KeyboardDiagnosticsPage />);
  await frames();
  expect(button("native").disabled).toBe(true);
  viewport.change(874);
  await frames();
  expect(button("native").disabled).toBe(true);
  await compressed.unmount();
});

test("diagnostics mounting and all mode changes never open business DB, WebSocket, SW registration or camera", async () => {
  const open = vi.spyOn(indexedDB, "open");
  const websocket = vi.fn(function () { throw new Error("Unexpected business connection"); });
  vi.stubGlobal("WebSocket", websocket);
  const register = vi.spyOn(navigator.serviceWorker, "register");
  const camera = vi.spyOn(navigator.mediaDevices, "getUserMedia");
  const deleteCache = vi.spyOn(caches, "delete");
  const { view } = await mount();
  await select("prefixed");
  await select("native");
  await select("current");
  await view.unmount();
  expect(open).not.toHaveBeenCalled();
  expect(websocket).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  expect(camera).not.toHaveBeenCalled();
  expect(deleteCache).not.toHaveBeenCalled();
});

test("mode controls remain native keyboard reachable without pointer stealing focus", async () => {
  const { view } = await mount();
  button("prefixed").focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(mode).toBe("prefixed");
  await ready();
  button("native").focus();
  await userEvent.keyboard(" ");
  await expect.poll(mode).toBe("native");
  await view.unmount();
});

test("unmount cancels frame, focus/VV listeners, active closing and document state without touching debug preference", async () => {
  await page.viewport(402, 874);
  window.localStorage.setItem(VIEWPORT_DEBUG_STORAGE_KEY, "true");
  const record = vi.spyOn(ViewportFrameRecorder.prototype, "record");
  const { view, viewport } = await mount();
  input().focus();
  viewport.change(470);
  input().blur();
  viewport.change(812);
  await frames();
  const previous = shell();
  await view.unmount();
  const count = record.mock.calls.length;
  viewport.change(874);
  document.dispatchEvent(new FocusEvent("focusin"));
  await frames(4);
  expect(record.mock.calls.length).toBe(count);
  expect(previous.hasAttribute("data-keyboard-closing")).toBe(false);
  expect(previous.style.getPropertyValue("--pwa-viewport-height")).toBe("");
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("");
  expect(viewportDiagnosticsEnabled()).toBe(false);
  expect(window.localStorage.getItem(VIEWPORT_DEBUG_STORAGE_KEY)).toBe("true");
});
