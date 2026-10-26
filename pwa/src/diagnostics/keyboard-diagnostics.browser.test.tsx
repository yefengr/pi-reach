import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { getMessages, setLanguagePreference } from "@/lib/i18n";
import { viewportDiagnosticsEnabled } from "@/lib/pwa/timeline-viewport-diagnostics";
import { VIEWPORT_DEBUG_STORAGE_KEY, VIEWPORT_FRAME_FIELDS, ViewportFrameRecorder } from "@/lib/pwa/viewport-debug";
import { KeyboardDiagnosticsPage } from "./keyboard-diagnostics-page";
import { KeyboardDiagnosticsStage } from "./keyboard-diagnostics-stage";
import { KeyboardDiagnosticsReports } from "@/lib/pwa/keyboard-diagnostics";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";

class ViewportMock extends EventTarget {
  height = window.innerHeight;
  get width() { return window.innerWidth; }
  get pageTop() { return this.offsetTop; }
  offsetLeft = 0;
  pageLeft = 0;
  offsetTop = 0;
  scale = 1;
  change(height: number, scale = 1) { this.height = height; this.scale = scale; this.dispatchEvent(new Event("resize")); }
}
const shell = () => document.querySelector<HTMLElement>(".pwa-keyboard-diagnostics")!;
const controller = () => shell().querySelector<HTMLElement>(".pwa-keyboard-diagnostics-content") ?? shell();
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
  setLanguagePreference("system");
  for (const { rule, media } of standaloneRules.splice(0)) rule.media.mediaText = media;
  await page.viewport(1280, 900);
});

test.each([
  [320, 568, false, "en"], [402, 874, false, "en"], [874, 402, false, "en"], [402, 874, true, "en"],
  [320, 568, false, "zh"], [402, 874, false, "zh"], [874, 402, false, "zh"], [402, 874, true, "zh"],
] as const)("same initial geometry and usable controls at %ix%i standalone-CSS-fixture=%s language=%s", async (width, height, standalone, language) => {
  setLanguagePreference(language);
  await page.viewport(width, height);
  if (standalone) enableStandaloneCssFixture();
  const { view } = await mount();
  const initial = geometry();
  const initialDensity = { compact: shell().dataset.compactHeight, wide: shell().hasAttribute("data-wide-compact") };
  expect(getComputedStyle(shell()).position).not.toBe("fixed");
  for (const value of ["prefixed", "native", "content", "current"]) {
    await select(value);
    await frames();
    const next = geometry();
    expect({ compact: controller().dataset.compactHeight, wide: controller().hasAttribute("data-wide-compact") }).toEqual(initialDensity);
    next.forEach((box, index) => box.forEach((coordinate, axis) => expect(Math.abs(coordinate - initial[index]![axis]!), `${value} box=${index} axis=${axis} actual=${JSON.stringify(next)} initial=${JSON.stringify(initial)}`).toBeLessThanOrEqual(1)));
    expect(getComputedStyle(shell()).position === "fixed").toBe(value === "prefixed" || value === "content");
    for (const control of shell().querySelectorAll("[data-mode], a")) {
      const box = control.getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(width + 1);
    }
    expect(Math.abs(input().closest(".pwa-main")!.getBoundingClientRect().bottom - height)).toBeLessThanOrEqual(1);
    expect(shell().querySelectorAll("main")).toHaveLength(1);
    if (width === 402) expect(new Set(Array.from(shell().querySelectorAll("[data-mode]")).map(control => Math.round(control.getBoundingClientRect().top))).size).toBe(1);
    for (const label of shell().querySelectorAll(".mantine-Button-label")) {
      const range = document.createRange();
      range.selectNodeContents(label);
      const content = range.getBoundingClientRect();
      const control = label.closest("button")!.getBoundingClientRect();
      expect(Math.round(content.left)).toBeGreaterThanOrEqual(Math.round(control.left));
      expect(Math.round(content.right)).toBeLessThanOrEqual(Math.round(control.right));
      expect(Math.round(content.top)).toBeGreaterThanOrEqual(Math.round(control.top));
      expect(Math.round(content.bottom)).toBeLessThanOrEqual(Math.round(control.bottom));
    }
    if (value === "content") expect(getComputedStyle(controller()).position).toBe("fixed");
    expect(input().getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
    expect(input().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    // 折叠说明在极矮窗口隐藏，旁路开关只在可达尺寸复核配对组的初始几何。
    if (value !== "content" || height <= 450) continue;
    shell().querySelector<HTMLButtonElement>("[data-document-lock-toggle]")!.click();
    await expect.poll(() => shell().hasAttribute("data-document-lock-bypass")).toBe(true);
    await ready();
    await frames();
    const paired = geometry();
    paired.forEach((box, index) => box.forEach((coordinate, axis) => expect(Math.abs(coordinate - initial[index]![axis]!), `bypass box=${index} axis=${axis} actual=${JSON.stringify(paired)}`).toBeLessThanOrEqual(1)));
  }
  await view.unmount();
});

test.each(["current", "prefixed", "content"])("%s compensates, blocks partial/pending/closing/refocus, resets without changing its position experiment", async value => {
  await page.viewport(402, 874);
  const { view, viewport } = await mount();
  if (value !== "current") await select(value);
  const before = controller();
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
  expect(getComputedStyle(before).position === "fixed").toBe(value === "prefixed" || value === "content");
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
  expect(before.style.getPropertyValue("--pwa-viewport-height")).toBe("");
  await select("native");
  expect(before.isConnected).toBe(false);
  expect(before.hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(before.hasAttribute("data-compact-height")).toBe(false);
  await view.unmount();
});

test("content keeps the real outer shell and title stable while its full-height controller follows VV", async () => {
  await page.viewport(402, 874);
  const { view, viewport } = await mount();
  await select("content");
  const before = rect(shell());
  const title = rect(shell().querySelector(".pwa-title-bar")!);
  await userEvent.click(input());
  expect(document.activeElement).toBe(input());
  viewport.change(470);
  await frames();
  expect(getComputedStyle(controller()).position).toBe("fixed");
  expect(Math.round(shell().getBoundingClientRect().height)).toBe(874);
  expect(rect(shell())).toEqual(before);
  expect(rect(shell().querySelector(".pwa-title-bar")!)).toEqual(title);
  const content = controller();
  expect(Math.round(content.getBoundingClientRect().height)).toBe(470);
  expect(content.dataset.compactHeight).toBe("short");
  expect(shell().hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(input().getBoundingClientRect().bottom).toBeLessThanOrEqual(471);
  expect(Math.round(input().closest(".pwa-main")!.getBoundingClientRect().bottom)).toBe(470);
  input().blur();
  viewport.change(874);
  await ready();
  await view.unmount();
});

test("content offset uses one Chrome slot, real main budget and outer-shell report geometry", async () => {
  await page.viewport(402, 874);
  const { view, viewport } = await mount();
  await select("content");
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  const titleBefore = rect(shell().querySelector(".pwa-title-bar")!);
  const chrome = shell().querySelector<HTMLElement>(".pwa-keyboard-diagnostics-chrome")!;
  const list = controller().querySelector<HTMLElement>(".pwa-message-list")!;
  await userEvent.click(input());
  viewport.offsetTop = 24;
  viewport.change(470);
  await frames(5);
  const main = input().closest<HTMLElement>(".pwa-main")!;
  expect(Math.round(controller().getBoundingClientRect().top)).toBe(24);
  expect(Math.round(controller().getBoundingClientRect().height)).toBe(470);
  expect(rect(shell().querySelector(".pwa-title-bar")!)).toEqual(titleBefore);
  expect(Math.abs(list.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(main.getBoundingClientRect().bottom - 494)).toBeLessThanOrEqual(1);
  const slot = controller().querySelector<HTMLElement>(".pwa-keyboard-diagnostics-slot")!;
  expect(slot.getAttribute("aria-hidden")).toBe("true");
  expect(slot.children).toHaveLength(0);
  expect(Math.abs(slot.getBoundingClientRect().height - (chrome.getBoundingClientRect().height - 24))).toBeLessThanOrEqual(1);
  await userEvent.fill(input(), Array.from({ length: 9 }, (_, index) => `local budget line ${index}`).join("\n"));
  await frames(5);
  const style = getComputedStyle(input());
  const listStyle = getComputedStyle(list);
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  const minimum = Math.max(44, pixels(style.lineHeight) + pixels(style.paddingTop) + pixels(style.paddingBottom) + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth));
  const sixLines = 6 * pixels(style.lineHeight) + pixels(style.paddingTop) + pixels(style.paddingBottom) + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
  const bodyLine = pixels(listStyle.getPropertyValue("--pwa-text-body")) * pixels(listStyle.getPropertyValue("--pwa-leading-body"));
  const footer = input().closest(".pwa-chat-footer")!;
  const footerChrome = footer.getBoundingClientRect().height - input().getBoundingClientRect().height;
  const space = main.getBoundingClientRect().bottom - list.getBoundingClientRect().top - footerChrome;
  const expected = Math.max(minimum, Math.min(sixLines, space - Math.ceil(bodyLine + 16)));
  expect(main.hasAttribute("data-composer-budget")).toBe(true);
  expect(Math.abs(pixels(input().style.maxHeight) - expected)).toBeLessThanOrEqual(1);
  expect(input().getBoundingClientRect().bottom).toBeLessThanOrEqual(495);
  await view.getByRole("button", { name: getMessages().viewportDebug.copy, exact: true }).click();
  const report = JSON.parse(writeText.mock.calls[0]![0]);
  const round = report.rounds.find((entry: { mode: string }) => entry.mode === "content").report;
  const columns: string[] = round.frames.columns;
  const row: unknown[] = round.frames.rows.at(-1);
  const field = (name: string) => row[columns.indexOf(name)];
  expect(field("shellHeight")).toBe(874);
  expect(field("shellTop")).toBe(0);
  expect(field("titleTop")).toBe(titleBefore[0]);
  expect(field("cssHeight")).toBe(470);
  expect(field("cssTop")).toBe(24);
  expect(field("keyboard")).toBe(true);
  expect(field("motion")).toBe("none");
  expect(field("listClientHeight")).toBe(list.clientHeight);
  expect(field("composerTop")).toBeCloseTo(Math.round(shell().querySelector(".pwa-composer")!.getBoundingClientRect().top * 10) / 10, 1);
  const mark = round.marks.findLast((entry: { controller?: { reason: string } }) => entry.controller?.reason === "compensated");
  expect(mark.snapshot.shellHeight).toBe(874);
  expect(mark.snapshot.compact).toBe("short");
  expect(mark.controller.appHeight).toBe(874);
  expect(mark.controller.unfocusedInset).toBe(0);
  expect(round.environment.controllerScope).toBe("content-viewport");
  input().blur();
  viewport.offsetTop = 0;
  viewport.change(874);
  await ready();
  await view.unmount();
});

test.each(["follow", "reading"])("content preserves %s geometry through real controller closing within one pixel", async intent => {
  await page.viewport(402, 874);
  const { view, viewport } = await mount();
  await select("content");
  const list = controller().querySelector<HTMLElement>(".pwa-message-list")!;
  await frames(5);
  if (intent === "reading") {
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    list.scrollTop = 220;
    list.dispatchEvent(new Event("scroll"));
    await frames(4);
  }
  const anchor = Array.from(list.children).find(child => {
    const box = child.getBoundingClientRect();
    return box.bottom > list.getBoundingClientRect().top + 1 && box.height > 1;
  })!;
  const top = Math.round(anchor.getBoundingClientRect().top);
  input().focus({ preventScroll: true });
  viewport.change(470);
  await frames(5);
  const assertPosition = () => {
    if (intent === "follow") expect(Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop)).toBeLessThanOrEqual(1);
    else expect(Math.abs(Math.round(anchor.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(1);
  };
  assertPosition();
  input().blur();
  viewport.change(812);
  await expect.poll(() => controller().hasAttribute("data-keyboard-closing")).toBe(true);
  assertPosition();
  await expect.poll(() => controller().hasAttribute("data-keyboard-closing"), { timeout: 5000 }).toBe(false);
  assertPosition();
  viewport.change(874);
  await ready();
  assertPosition();
  await view.unmount();
});

test.each([false, true])("content document-lock bypass keeps html/body natural while the controller still requests 470 (standalone-CSS-fixture=%s)", async standalone => {
  await page.viewport(402, 874);
  if (standalone) enableStandaloneCssFixture();
  const { view, viewport } = await mount();
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  const toggle = () => shell().querySelector<HTMLButtonElement>("[data-document-lock-toggle]")!;
  const title = () => shell().querySelector(".pwa-title-bar")!;
  const box = (node: Element) => Math.round(node.getBoundingClientRect().height);
  const boxes = () => ({ root: box(document.documentElement), body: box(document.body), outer: box(shell()), content: box(controller()) });
  const open = async () => { input().focus({ preventScroll: true }); viewport.change(470); await frames(); };
  const close = async () => { input().blur(); viewport.change(874); await ready(); };
  expect(toggle().disabled).toBe(true);
  await select("content");
  const initial = geometry();
  const titleBefore = rect(title());
  // 同构建默认组：控制器请求的锁实际把文档盒压到 470。
  await open();
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(true);
  expect(boxes()).toEqual({ root: 470, body: 470, outer: 874, content: 470 });
  // 聚焦期间同步复核，不能在展开中途切组。
  toggle().click();
  expect(shell().hasAttribute("data-document-lock-bypass")).toBe(false);
  await close();
  await userEvent.click(shell().querySelector("details summary")!);
  expect(box(toggle())).toBeGreaterThanOrEqual(44);
  expect(toggle().getBoundingClientRect().right).toBeLessThanOrEqual(403);
  await userEvent.click(toggle());
  await expect.poll(() => shell().hasAttribute("data-document-lock-bypass")).toBe(true);
  expect(mode()).toBe("content");
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  await ready();
  expect(shell().querySelector("details")!.open).toBe(false);
  await frames();
  const paired = geometry();
  paired.forEach((value, index) => value.forEach((coordinate, axis) => expect(Math.abs(coordinate - initial[index]![axis]!), `box=${index} axis=${axis}`).toBeLessThanOrEqual(1)));
  await open();
  // 锁请求与目标值照旧，只是 CSS 门控跳过 html/body 约束。
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("470px");
  expect(boxes()).toEqual({ root: 874, body: 874, outer: 874, content: 470 });
  expect(rect(title())).toEqual(titleBefore);
  expect(window.scrollY).toBe(0);
  expect(input().getBoundingClientRect().bottom).toBeLessThanOrEqual(471);
  await view.getByRole("button", { name: getMessages().viewportDebug.copy, exact: true }).click();
  const report = JSON.parse(writeText.mock.calls[0]![0]);
  type Round = { mode: string; documentLock: string; report: { environment: Record<string, unknown>; marks: { controller?: { reason: string }; snapshot: Record<string, unknown> }[] } };
  const rounds: Round[] = report.rounds.filter((round: Round) => round.mode === "content");
  expect(rounds.map(round => round.documentLock)).toEqual(["default", "bypassed"]);
  const compensated = (round: Round) => {
    const snapshot = round.report.marks.findLast(entry => entry.controller?.reason === "compensated")!.snapshot;
    return Object.fromEntries(["rootBoxHeight", "bodyBoxHeight", "shellHeight", "contentHeight", "documentLocked", "documentLockHeight", "documentLockBypassed"].map(key => [key, snapshot[key]]));
  };
  expect(compensated(rounds[0]!)).toEqual({ rootBoxHeight: 470, bodyBoxHeight: 470, shellHeight: 874, contentHeight: 470, documentLocked: true, documentLockHeight: 470, documentLockBypassed: false });
  expect(compensated(rounds[1]!)).toEqual({ rootBoxHeight: 874, bodyBoxHeight: 874, shellHeight: 874, contentHeight: 470, documentLocked: true, documentLockHeight: 470, documentLockBypassed: true });
  expect(rounds.map(round => round.report.environment.documentLockBypassed)).toEqual([false, true]);
  await close();
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
  expect(boxes()).toEqual({ root: 874, body: 874, outer: 874, content: 874 });
  // 切离 D 即撤销旁路，正式锁重新生效。
  await select("current");
  expect(shell().hasAttribute("data-document-lock-bypass")).toBe(false);
  expect(toggle().disabled).toBe(true);
  await open();
  expect(box(document.documentElement)).toBe(470);
  await close();
  await view.unmount();
});

test("content Chrome remains clickable through its empty slot; real menu Escape restores its trigger", async () => {
  await page.viewport(402, 874);
  const { view } = await mount();
  await select("content");
  const details = shell().querySelector("details")!;
  const chrome = shell().querySelector(".pwa-keyboard-diagnostics-chrome")!;
  await userEvent.click(details.querySelector("summary")!);
  expect(details.open).toBe(true);
  await expect.poll(() => Math.round(controller().querySelector(".pwa-message-list")!.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom)).toBe(0);
  await userEvent.click(details.querySelector("summary")!);
  expect(details.open).toBe(false);
  const trigger = controller().querySelector<HTMLButtonElement>(".pwa-composer-command button")!;
  trigger.focus();
  await userEvent.click(trigger);
  await expect.element(view.getByRole("menu")).toBeVisible();
  expect(shell().querySelector(".pwa-root")!.contains(view.getByRole("menu").element())).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(view.getByRole("menu")).not.toBeInTheDocument();
  await expect.poll(() => document.activeElement).toBe(trigger);
  await userEvent.click(button("native"));
  await expect.poll(mode).toBe("native");
  await view.unmount();
});

test("content Reduced Motion recovers without a closing animation or stale state", async () => {
  await page.viewport(402, 874);
  for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSMediaRule) || !rule.conditionText.includes("prefers-reduced-motion: reduce")) continue;
    standaloneRules.push({ rule, media: rule.media.mediaText });
    rule.media.mediaText = "all";
  }
  const { view, viewport } = await mount();
  await select("content");
  expect(getComputedStyle(controller()).getPropertyValue("--pwa-duration-keyboard").trim()).toBe("0ms");
  input().focus();
  viewport.change(470);
  expect(Math.round(controller().getBoundingClientRect().height)).toBe(470);
  input().blur();
  viewport.change(812);
  expect(controller().hasAttribute("data-keyboard-closing")).toBe(false);
  expect(Math.round(controller().getBoundingClientRect().height)).toBe(812);
  button("native").click();
  expect(mode()).toBe("content");
  await expect.poll(() => button("native").disabled).toBe(true);
  viewport.change(874);
  await ready();
  expect(controller().hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(controller().style.getPropertyValue("--pwa-viewport-height")).toBe("");
  expect(Math.round(shell().getBoundingClientRect().height)).toBe(874);
  await view.unmount();
});

test("content initial pending calibration keeps the natural outer baseline through focus and real closing", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("innerHeight", 812);
  vi.stubGlobal("visualViewport", viewport);
  const onExperiment = vi.fn();
  const view = await render(<StrictMode><PwaUiProvider colorSchemeManager={{ get: () => "light", set() {}, subscribe() {}, unsubscribe() {}, clear() {} }}>
    <KeyboardDiagnosticsStage mode="content" documentLockBypass={false} initialDensity={null} onExperiment={onExperiment} reports={new KeyboardDiagnosticsReports()} />
  </PwaUiProvider></StrictMode>);
  await frames();
  expect(button("native").disabled).toBe(true);
  expect(Math.round(shell().getBoundingClientRect().height)).toBe(874);
  input().focus();
  vi.stubGlobal("innerHeight", 874);
  viewport.change(470);
  input().blur();
  viewport.change(812);
  button("native").click();
  expect(onExperiment).not.toHaveBeenCalled();
  await expect.poll(() => controller().hasAttribute("data-keyboard-closing")).toBe(true);
  button("native").click();
  expect(onExperiment).not.toHaveBeenCalled();
  expect(Math.round(shell().getBoundingClientRect().height)).toBe(874);
  await expect.poll(() => controller().hasAttribute("data-keyboard-closing"), { timeout: 5000 }).toBe(false);
  expect(button("native").disabled).toBe(true);
  viewport.change(874);
  button("native").click();
  expect(onExperiment).not.toHaveBeenCalled();
  await ready();
  button("native").click();
  expect(onExperiment).toHaveBeenCalledWith({ mode: "native", documentLockBypass: false }, { compactHeight: undefined, wideCompact: false });
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

test.each(["current", "content"])("%s hands its measured short-window density to native through focus, compression and recovery", async value => {
  await page.viewport(320, 568);
  const { view, viewport } = await mount();
  if (value === "content") await select(value);
  expect(controller().dataset.compactHeight).toBe("short");
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

test.each(["current", "prefixed", "native", "content"])("%s restores mode switching after layout viewport height and VV recover together", async value => {
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

test.each(["together", "viewport-first", "innerHeight-first"])("initial 812→874 calibration waits for both natural heights: %s", async order => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  viewport.change(812);
  vi.stubGlobal("innerHeight", 812);
  vi.stubGlobal("visualViewport", viewport);
  const view = await render(<StrictMode><KeyboardDiagnosticsPage /></StrictMode>);
  await frames();
  expect(Math.round(shell().getBoundingClientRect().height)).toBe(874);
  expect(button("native").disabled).toBe(true);
  expect(button("prefixed").disabled).toBe(true);
  if (order === "viewport-first") viewport.change(874);
  if (order === "innerHeight-first") {
    vi.stubGlobal("innerHeight", 874);
    window.dispatchEvent(new Event("resize"));
  }
  if (order !== "together") {
    await frames();
    expect(button("native").disabled).toBe(true);
  }
  vi.stubGlobal("innerHeight", 874);
  viewport.change(874);
  window.dispatchEvent(new Event("resize"));
  await ready();
  await select("prefixed");
  await select("native");
  await select("current");
  await view.unmount();
});

test("pending calibration blocks focus and real controller closing until complete recovery", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  // 只压短 innerHeight，让诊断待标定；正式控制器仍以 VV874 建立闭合基准。
  vi.stubGlobal("innerHeight", 812);
  vi.stubGlobal("visualViewport", viewport);
  const view = await render(<StrictMode><KeyboardDiagnosticsPage /></StrictMode>);
  shell().style.setProperty("--pwa-duration-keyboard", "250ms");
  await frames();
  input().focus();
  vi.stubGlobal("innerHeight", 874);
  viewport.change(874);
  await frames();
  expect(button("native").disabled).toBe(true);
  expect(document.activeElement).toBe(input());
  viewport.change(470);
  expect(shell().hasAttribute("data-keyboard-viewport")).toBe(true);
  input().blur();
  viewport.change(812);
  await expect.poll(() => Math.round(shell().getBoundingClientRect().height), { timeout: 5000 }).toBe(812);
  await expect.poll(() => shell().hasAttribute("data-keyboard-closing"), { timeout: 5000 }).toBe(false);
  expect(button("native").disabled).toBe(true);
  expect(shell().hasAttribute("data-keyboard-viewport")).toBe(true);
  viewport.change(874);
  // 首次标定也必须等真实控制器交接，不因两个高度已恢复而绕过 pending/active closing。
  button("native").click();
  expect(mode()).toBe("current");
  expect(shell().hasAttribute("data-keyboard-viewport")).toBe(true);
  await ready();
  expect(shell().hasAttribute("data-keyboard-closing")).toBe(false);
  expect(shell().hasAttribute("data-keyboard-viewport")).toBe(false);
  await select("native");
  input().focus();
  viewport.change(470);
  input().blur();
  viewport.change(812);
  await frames();
  expect(button("current").disabled).toBe(true);
  viewport.change(874);
  await ready();
  await view.unmount();
});

test.each(["missing-viewport", "invalid-scale", "zero-height"])("pending %s can first calibrate when capability and safe geometry recover", async initial => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  if (initial === "invalid-scale") viewport.change(874, 1.1);
  if (initial === "zero-height") viewport.change(0);
  vi.stubGlobal("visualViewport", initial === "missing-viewport" ? undefined : viewport);
  const view = await render(<StrictMode><KeyboardDiagnosticsPage /></StrictMode>);
  await frames();
  expect(button("native").disabled).toBe(true);
  expect(shell().querySelectorAll("a")).toHaveLength(2);
  vi.stubGlobal("visualViewport", viewport);
  viewport.change(874);
  await ready();
  await select("native");
  await view.unmount();
});

test("pending width change requires restart, while remount does not inherit its invalidation", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  viewport.change(812);
  vi.stubGlobal("visualViewport", viewport);
  const view = await render(<StrictMode><KeyboardDiagnosticsPage /></StrictMode>);
  await frames();
  await page.viewport(874, 402);
  await frames();
  await page.viewport(402, 874);
  viewport.change(874);
  await frames();
  expect(button("native").disabled).toBe(true);
  await view.unmount();
  const next = await render(<StrictMode><KeyboardDiagnosticsPage /></StrictMode>);
  await ready();
  await select("native");
  await next.unmount();
});

test("mode and draft are memory only; export is four bounded latest rounds and never contains draft or sample body", async () => {
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
  await select("content");
  await select("current");
  await frames();
  await view.getByRole("button", { name: getMessages().viewportDebug.copy, exact: true }).click();
  const raw = writeText.mock.calls[0]![0];
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain("Fixed local sample");
  const report = JSON.parse(raw);
  expect(report.format).toBe("pi-reach-keyboard-diagnostics/2");
  expect(report.rounds.map((round: { mode: string }) => round.mode)).toEqual(["current", "prefixed", "native", "content"]);
  expect(report.rounds.every((round: { documentLock: string }) => round.documentLock === "default")).toBe(true);
  for (const round of report.rounds) {
    expect(round.report.format).toBe("pi-reach-viewport-debug/1");
    expect(round.report.environment.mode).toBe(round.mode);
    expect(round.report.environment.shellScope).toBe("outer-shell");
    expect(round.report.environment.titleScope).toBe("outer-shell");
    expect(round.report.environment.controllerScope).toBe(round.mode === "content" ? "content-viewport" : "outer-shell");
    expect(round.report.frames.columns).toEqual([...VIEWPORT_FRAME_FIELDS]);
    expect(Object.keys(round.report.environment).sort()).toEqual(["buildAsset", "documentLockBypassed", "pwaVersion", "userAgent", "devicePixelRatio", "screenWidth", "screenHeight", "standalone", "mode", "shellScope", "controllerScope", "titleScope"].sort());
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
  await ready();
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
  await select("content");
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

test.each(["current", "content"])("%s unmount cancels frame, focus/VV listeners, active closing and document state without touching debug preference", async value => {
  await page.viewport(402, 874);
  window.localStorage.setItem(VIEWPORT_DEBUG_STORAGE_KEY, "true");
  const record = vi.spyOn(ViewportFrameRecorder.prototype, "record");
  const { view, viewport } = await mount();
  if (value === "content") await select(value);
  input().focus();
  viewport.change(470);
  input().blur();
  viewport.change(812);
  await frames();
  const previous = controller();
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
