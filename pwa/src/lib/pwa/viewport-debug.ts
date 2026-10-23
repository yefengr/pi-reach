import { useLocalStorage } from "@mantine/hooks";
import type { ViewportDiagnosticEntry } from "./timeline-viewport-diagnostics";
import { hasTextFocus } from "./use-keyboard-viewport";

export const VIEWPORT_DEBUG_STORAGE_KEY = "pi-reach-viewport-debug";
export const VIEWPORT_DEBUG_REPORT_FORMAT = "pi-reach-viewport-debug/1";
// 60fps 下约 30 秒：复现一次键盘展开、发送、收起后仍有时间点复制。
export const VIEWPORT_DEBUG_FRAME_CAPACITY = 1800;
const MARK_CAPACITY = 512;

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
export const VIEWPORT_MARK_KINDS = ["focusin", "focusout", "vv-resize", "vv-scroll", "scroll", "resize"] as const;
export type ViewportMarkKind = typeof VIEWPORT_MARK_KINDS[number];

/** 每帧只记录数字、布尔值和焦点类别，不读取正文、属性值或业务身份。 */
export const VIEWPORT_FRAME_FIELDS = ["frame", "t", "vvTop", "vvHeight", "vvPageTop", "vvScale", "scrollY", "innerHeight",
  "docHeight", "keyboard", "cssTop", "cssHeight", "shellTop", "shellHeight", "titleTop", "composerTop", "listTop",
  "listScrollTop", "listScrollHeight", "listClientHeight", "focus"] as const;
type FrameValue = number | boolean | ViewportFocusKind | null;
export type ViewportFrameMeasure = Readonly<{
  vvTop: number | null; vvHeight: number | null; vvPageTop: number | null; vvScale: number | null;
  scrollY: number; innerHeight: number; docHeight: number; keyboard: boolean;
  cssTop: number | null; cssHeight: number | null; shellTop: number | null; shellHeight: number | null;
  titleTop: number | null; composerTop: number | null; listTop: number | null;
  listScrollTop: number | null; listScrollHeight: number | null; listClientHeight: number | null;
  focus: ViewportFocusKind;
}>;
export type ViewportFrameSample = Readonly<ViewportFrameMeasure & { frame: number; t: number }>;
export type ViewportMark = Readonly<{ frame: number; t: number; kind: ViewportMarkKind }>;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function finite(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? round(value) : null;
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
  mark(kind: ViewportMarkKind) {
    this.marks.push(Object.freeze({ frame: this.count, t: this.elapsed(), kind }));
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

function focusKind(): ViewportFocusKind {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return "none";
  return hasTextFocus() ? "text" : "control";
}

/** getBoundingClientRect 相对布局视口；屏幕上的位置需再减去 vvTop。 */
export function measureViewportFrame(shell: HTMLElement): ViewportFrameMeasure {
  const viewport = window.visualViewport;
  const shellRect = shell.getBoundingClientRect();
  const list = shell.querySelector<HTMLElement>(".pwa-message-list");
  return {
    vvTop: finite(viewport?.offsetTop), vvHeight: finite(viewport?.height), vvPageTop: finite(viewport?.pageTop),
    vvScale: finite(viewport?.scale), scrollY: round(window.scrollY), innerHeight: window.innerHeight,
    docHeight: document.documentElement.clientHeight, keyboard: shell.hasAttribute("data-keyboard-viewport"),
    cssTop: cssPixels(shell, "--pwa-viewport-top"), cssHeight: cssPixels(shell, "--pwa-viewport-height"),
    shellTop: finite(shellRect.top), shellHeight: finite(shellRect.height),
    titleTop: rectTop(shell.querySelector(".pwa-title-bar")), composerTop: rectTop(shell.querySelector(".pwa-composer")),
    listTop: rectTop(list), listScrollTop: finite(list?.scrollTop), listScrollHeight: finite(list?.scrollHeight),
    listClientHeight: finite(list?.clientHeight), focus: focusKind(),
  };
}

function show(value: number | null): string {
  return value === null ? "-" : String(value);
}

function screenTop(top: number | null, viewportTop: number | null): string {
  return top === null ? "-" : show(round(top - (viewportTop ?? 0)));
}

/** 浮层文本：帧号放第一行，录屏时可与导出的逐帧记录对齐。 */
export function formatViewportDebugLines(sample: ViewportFrameSample): string[] {
  return [
    `#${sample.frame}  t ${sample.t}`,
    `vv top ${show(sample.vvTop)} h ${show(sample.vvHeight)} pg ${show(sample.vvPageTop)}`,
    `win sy ${sample.scrollY} ih ${sample.innerHeight} dh ${sample.docHeight}`,
    `kb ${sample.keyboard ? 1 : 0} css ${show(sample.cssTop)}/${show(sample.cssHeight)}`,
    `shell ${show(sample.shellTop)}/${show(sample.shellHeight)}`,
    `title ${show(sample.titleTop)} scr ${screenTop(sample.titleTop, sample.vvTop)}`,
    `comp ${show(sample.composerTop)} scr ${screenTop(sample.composerTop, sample.vvTop)}`,
    `list ${show(sample.listScrollTop)}/${show(sample.listScrollHeight)} ch ${show(sample.listClientHeight)}`,
    `focus ${sample.focus}`,
  ];
}

export type ViewportDebugEnvironment = Readonly<Record<string, string | number | boolean | null>>;

export function collectViewportDebugEnvironment(version: string): ViewportDebugEnvironment {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
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
