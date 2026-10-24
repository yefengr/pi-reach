import { useLocalStorage } from "@mantine/hooks";
import type { ViewportDiagnosticEntry } from "./timeline-viewport-diagnostics";
import { hasTextFocus, KEYBOARD_VIEWPORT_REASONS, type KeyboardViewportDiagnostic } from "./use-keyboard-viewport";

export const VIEWPORT_DEBUG_STORAGE_KEY = "pi-reach-viewport-debug";
export const VIEWPORT_DEBUG_REPORT_FORMAT = "pi-reach-viewport-debug/1";
// 60fps 下约 30 秒：复现一次键盘展开、发送、收起后仍有时间点复制。
export const VIEWPORT_DEBUG_FRAME_CAPACITY = 1800;
const MARK_CAPACITY = 512;
export const DOCUMENT_LOCK_BYPASS_ATTRIBUTE = "data-document-lock-bypass";

/** 实验只由已挂载的调试浮层持有；卸载后CSS门控和诊断同时恢复默认。 */
export function documentLockBypassed(): boolean {
  return document.querySelector(`.pwa-viewport-debug[${DOCUMENT_LOCK_BYPASS_ATTRIBUTE}]`) !== null;
}

/** 默认关闭；只有字符串 "true" 才开启，旧数据或手工修改不会意外显示浮层。 */
export function useViewportDebug() {
  return useLocalStorage<boolean>({
    key: VIEWPORT_DEBUG_STORAGE_KEY,
    defaultValue: false,
    getInitialValueInEffect: false,
    deserialize: (value) => value === "true",
  });
}

export type ViewportFocusKind = "text" | "control" | "none";
export type ViewportKeyboardMotion = "opening" | "closing" | "none";
export const VIEWPORT_MARK_KINDS = ["focusin", "focusout", "vv-resize", "vv-scroll", "scroll", "resize", "keyboard-update",
  "document-lock-before", "document-lock-after", "document-lock-state"] as const;
export type ViewportMarkKind = typeof VIEWPORT_MARK_KINDS[number];

/** 每帧只记录数字、布尔值和焦点类别，不读取正文、属性值或业务身份。 */
export const VIEWPORT_FRAME_FIELDS = ["frame", "t", "vvTop", "vvHeight", "vvPageTop", "vvScale", "scrollY", "innerHeight",
  "docHeight", "keyboard", "motion", "cssTop", "cssHeight", "shellTop", "shellHeight", "titleTop", "composerTop", "listTop",
  "listScrollTop", "listScrollHeight", "listClientHeight", "focus"] as const;
type FrameValue = number | boolean | ViewportFocusKind | ViewportKeyboardMotion | null;
export type ViewportFrameMeasure = Readonly<{
  vvTop: number | null; vvHeight: number | null; vvPageTop: number | null; vvScale: number | null;
  scrollY: number; innerHeight: number; docHeight: number; keyboard: boolean; motion: ViewportKeyboardMotion;
  cssTop: number | null; cssHeight: number | null; shellTop: number | null; shellHeight: number | null;
  titleTop: number | null; composerTop: number | null; listTop: number | null;
  listScrollTop: number | null; listScrollHeight: number | null; listClientHeight: number | null;
  focus: ViewportFocusKind;
}>;
export type ViewportFrameSample = Readonly<ViewportFrameMeasure & { frame: number; t: number }>;
export type ViewportEventSnapshot = Readonly<{
  vvHeight: number | null; vvTop: number | null; vvScale: number | null; innerHeight: number | null; docHeight: number | null;
  rootBoxHeight: number | null; bodyBoxHeight: number | null; shellHeight: number | null; scrollY: number | null;
  // documentLocked保留原义：控制器请求锁的标记；实验是否跳过CSS需结合bypassed及盒高判断。
  documentLocked: boolean; documentLockHeight: number | null; documentLockBypassed?: boolean; compact: "short" | "very-short" | null;
  composerBudget: "constrained" | "conflict" | null; paddingTop: number | null; paddingBottom: number | null;
  composerPaddingBottom: number | null; focus: ViewportFocusKind;
}>;
/** frame 是上一采样帧编号；snapshot 才是当前事件处理时的几何，不依赖 frames 尚未被淘汰。 */
export type ViewportMark = Readonly<{ frame: number; t: number; kind: ViewportMarkKind;
  snapshot?: ViewportEventSnapshot; controller?: KeyboardViewportDiagnostic }>;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function finite(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? round(value) : null;
}

function copyEventSnapshot(value: ViewportEventSnapshot): ViewportEventSnapshot {
  return Object.freeze({ vvHeight: finite(value.vvHeight), vvTop: finite(value.vvTop), vvScale: finite(value.vvScale),
    innerHeight: finite(value.innerHeight), docHeight: finite(value.docHeight), rootBoxHeight: finite(value.rootBoxHeight),
    bodyBoxHeight: finite(value.bodyBoxHeight), shellHeight: finite(value.shellHeight), scrollY: finite(value.scrollY),
    documentLocked: value.documentLocked === true, documentLockHeight: finite(value.documentLockHeight),
    documentLockBypassed: value.documentLockBypassed === true,
    compact: value.compact === "short" || value.compact === "very-short" ? value.compact : null,
    composerBudget: value.composerBudget === "constrained" || value.composerBudget === "conflict" ? value.composerBudget : null,
    paddingTop: finite(value.paddingTop), paddingBottom: finite(value.paddingBottom), composerPaddingBottom: finite(value.composerPaddingBottom),
    focus: value.focus === "text" || value.focus === "control" ? value.focus : "none" });
}

function copyController(value: KeyboardViewportDiagnostic): KeyboardViewportDiagnostic {
  return Object.freeze({ reason: value.reason, appHeight: value.appHeight, unfocusedInset: value.unfocusedInset,
    unfocusedOcclusion: value.unfocusedOcclusion, previousHeight: value.previousHeight, lastHeight: value.lastHeight,
    viewportHeight: value.viewportHeight, adjusted: value.adjusted, restored: value.restored,
    restoreThreshold: value.restoreThreshold, closing: value.closing, closingTarget: value.closingTarget });
}

/** 环形缓冲：超出容量时丢弃最早的帧，内存占用固定。 */
export class ViewportFrameRecorder {
  private frames: ViewportFrameSample[] = [];
  private marks: ViewportMark[] = [];
  private start: number;
  private count = 0;
  constructor(private readonly now: () => number, private readonly capacity = VIEWPORT_DEBUG_FRAME_CAPACITY) {
    this.start = now();
  }
  private elapsed() { return round(Math.max(0, this.now() - this.start)); }
  record(measure: ViewportFrameMeasure): ViewportFrameSample {
    this.count += 1;
    const sample = Object.freeze({ ...measure, frame: this.count, t: this.elapsed() });
    this.frames.push(sample);
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
    return sample;
  }
  mark(kind: ViewportMarkKind, snapshot?: ViewportEventSnapshot, controller?: KeyboardViewportDiagnostic) {
    this.marks.push(Object.freeze({ frame: this.count, t: this.elapsed(), kind,
      ...(snapshot ? { snapshot: copyEventSnapshot(snapshot) } : {}),
      ...(controller && KEYBOARD_VIEWPORT_REASONS.includes(controller.reason) ? { controller: copyController(controller) } : {}) }));
    if (this.marks.length > MARK_CAPACITY) this.marks.splice(0, this.marks.length - MARK_CAPACITY);
  }
  clear() {
    this.frames = [];
    this.marks = [];
    this.count = 0;
    this.start = this.now();
  }
  snapshot(): { frames: readonly ViewportFrameSample[]; marks: readonly ViewportMark[] } {
    return { frames: [...this.frames], marks: [...this.marks] };
  }
}

function cssPixels(shell: HTMLElement, name: string): number | null {
  const value = shell.style.getPropertyValue(name);
  return value ? finite(Number.parseFloat(value)) : null;
}

function rectTop(element: Element | null): number | null {
  return element ? finite(element.getBoundingClientRect().top) : null;
}

function keyboardMotion(shell: HTMLElement): ViewportKeyboardMotion {
  if (shell.hasAttribute("data-keyboard-opening")) return "opening";
  return shell.hasAttribute("data-keyboard-closing") ? "closing" : "none";
}

function focusKind(): ViewportFocusKind {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return "none";
  return hasTextFocus() ? "text" : "control";
}

/** iOS 真机记录显示 getBoundingClientRect 与屏幕坐标一致，位置字段直接取原值。 */
export function measureViewportFrame(shell: HTMLElement): ViewportFrameMeasure {
  const viewport = window.visualViewport;
  const shellRect = shell.getBoundingClientRect();
  const list = shell.querySelector<HTMLElement>(".pwa-message-list");
  return {
    vvTop: finite(viewport?.offsetTop), vvHeight: finite(viewport?.height), vvPageTop: finite(viewport?.pageTop),
    vvScale: finite(viewport?.scale), scrollY: round(window.scrollY), innerHeight: window.innerHeight,
    docHeight: document.documentElement.clientHeight, keyboard: shell.hasAttribute("data-keyboard-viewport"), motion: keyboardMotion(shell),
    cssTop: cssPixels(shell, "--pwa-viewport-top"), cssHeight: cssPixels(shell, "--pwa-viewport-height"),
    shellTop: finite(shellRect.top), shellHeight: finite(shellRect.height),
    titleTop: rectTop(shell.querySelector(".pwa-title-bar")), composerTop: rectTop(shell.querySelector(".pwa-composer")),
    listTop: rectTop(list), listScrollTop: finite(list?.scrollTop), listScrollHeight: finite(list?.scrollHeight),
    listClientHeight: finite(list?.clientHeight), focus: focusKind(),
  };
}

/** 仅事件发生时额外测量盒高与留白；不把 clientHeight 或调试标记当成物理键盘状态。 */
export function measureViewportEvent(shell: HTMLElement): ViewportEventSnapshot {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const list = shell.querySelector<HTMLElement>(".pwa-message-list");
  const composer = shell.querySelector<HTMLElement>(".pwa-composer");
  const listStyle = list ? getComputedStyle(list) : null;
  const compact = shell.dataset.compactHeight;
  const budget = shell.querySelector<HTMLElement>(".pwa-main")?.dataset.composerBudget;
  return {
    vvHeight: finite(viewport?.height), vvTop: finite(viewport?.offsetTop), vvScale: finite(viewport?.scale),
    innerHeight: window.innerHeight, docHeight: root.clientHeight, rootBoxHeight: finite(root.getBoundingClientRect().height),
    bodyBoxHeight: finite(document.body?.getBoundingClientRect().height), shellHeight: finite(shell.getBoundingClientRect().height),
    scrollY: finite(window.scrollY), documentLocked: root.hasAttribute("data-pwa-keyboard"),
    documentLockHeight: cssPixels(root, "--pwa-keyboard-document-height"), documentLockBypassed: documentLockBypassed(),
    compact: compact === "short" || compact === "very-short" ? compact : null,
    composerBudget: budget === "constrained" || budget === "conflict" ? budget : null,
    paddingTop: finite(listStyle ? parseFloat(listStyle.paddingTop) : null),
    paddingBottom: finite(listStyle ? parseFloat(listStyle.paddingBottom) : null),
    composerPaddingBottom: finite(composer ? parseFloat(getComputedStyle(composer).paddingBottom) : null), focus: focusKind(),
  };
}

function show(value: number | null): string {
  return value === null ? "-" : String(value);
}

/** 浮层文本：帧号放第一行，录屏时可与导出的逐帧记录对齐。 */
export function formatViewportDebugLines(sample: ViewportFrameSample): string[] {
  return [
    `#${sample.frame}  t ${sample.t}`,
    `vv top ${show(sample.vvTop)} h ${show(sample.vvHeight)} pg ${show(sample.vvPageTop)}`,
    `win sy ${sample.scrollY} ih ${sample.innerHeight} dh ${sample.docHeight}`,
    `kb ${sample.keyboard ? 1 : 0} ${sample.motion} css ${show(sample.cssTop)}/${show(sample.cssHeight)}`,
    `shell ${show(sample.shellTop)}/${show(sample.shellHeight)}`,
    `title ${show(sample.titleTop)} comp ${show(sample.composerTop)}`,
    `list ${show(sample.listScrollTop)}/${show(sample.listScrollHeight)} ch ${show(sample.listClientHeight)}`,
    `focus ${sample.focus}`,
  ];
}

export type ViewportDebugEnvironment = Readonly<Record<string, string | number | boolean | null>>;

export function collectViewportDebugEnvironment(version: string): ViewportDebugEnvironment {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    // 生产资源名含内容hash；它标识实际加载的JS，不冒充Git SHA，也不导出来源URL或query。
    buildAsset: new URL(import.meta.url).pathname.split("/").pop() ?? null,
    documentLockBypassed: documentLockBypassed(),
    pwaVersion: version, userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
    screenWidth: window.screen.width, screenHeight: window.screen.height, standalone,
  };
}

/** 逐帧记录按列存放，避免每行重复字段名；时间线记录沿用已有白名单诊断。 */
export function formatViewportDebugReport(input: {
  frames: readonly ViewportFrameSample[];
  marks: readonly ViewportMark[];
  timeline: readonly ViewportDiagnosticEntry[];
  environment: ViewportDebugEnvironment;
}): string {
  const rows = input.frames.map((frame) => VIEWPORT_FRAME_FIELDS.map((field): FrameValue => frame[field]));
  return JSON.stringify({
    format: VIEWPORT_DEBUG_REPORT_FORMAT,
    environment: input.environment,
    frames: { columns: VIEWPORT_FRAME_FIELDS, rows },
    marks: input.marks,
    timeline: input.timeline,
  });
}
