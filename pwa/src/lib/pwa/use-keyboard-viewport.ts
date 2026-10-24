import { useLayoutEffect, type RefObject } from "react";
import { TIMELINE_GEOMETRY_EVENT } from "./use-timeline-viewport";
import { KeyboardClosingMotion } from "./keyboard-closing-motion";

const VIEWPORT_EPSILON = 1;
const SCALE_EPSILON = 0.01;
// 复用原有短窗口通知密度，不改变布局断点或 textarea 的动态空间预算。
const SHORT_VIEWPORT_HEIGHT = 600;
const VERY_SHORT_VIEWPORT_HEIGHT = 450;
const INLINE_NOTICE_MIN_WIDTH = 600;
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

export const KEYBOARD_VIEWPORT_REASONS = ["focus", "no-viewport", "invalid-viewport", "unfocused-baseline", "native-layout",
  "restored", "closing", "compensated", "cleanup"] as const;
export type KeyboardViewportDiagnostic = Readonly<{
  reason: typeof KEYBOARD_VIEWPORT_REASONS[number]; appHeight: number; unfocusedInset: number; unfocusedOcclusion: number;
  previousHeight: number; lastHeight: number; viewportHeight: number | null; adjusted: boolean;
  restored: boolean | null; restoreThreshold: number | null; closing: boolean; closingTarget: number | null;
}>;
type DiagnosticListener = (state: KeyboardViewportDiagnostic) => void;
const diagnosticListeners = new WeakMap<HTMLElement, DiagnosticListener>();

/** 仅供显式开启的调试浮层订阅；不安装新调度器、不读取或改变控制器状态。 */
export function observeKeyboardViewport(shell: HTMLElement, listener: DiagnosticListener): () => void {
  diagnosticListeners.set(shell, listener);
  return () => { if (diagnosticListeners.get(shell) === listener) diagnosticListeners.delete(shell); };
}

function isTextEditable(element: EventTarget | null): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type) && !element.disabled && !element.readOnly;
  return element instanceof HTMLElement && element.isContentEditable;
}

export function hasTextFocus() {
  return isTextEditable(document.activeElement);
}

function updateDensity(shell: HTMLElement) {
  const previous = shell.dataset.compactHeight;
  applyDensity(shell);
  // 短窗口密度会改变消息区内边距（尺寸不变，ResizeObserver 不触发），通知时间线重新贴底或恢复锚点。
  if (shell.dataset.compactHeight !== previous) shell.querySelector(".pwa-message-list")?.dispatchEvent(new Event(TIMELINE_GEOMETRY_EVENT));
}

function applyDensity(shell: HTMLElement) {
  const { width, height } = shell.getBoundingClientRect();
  if (height <= SHORT_VIEWPORT_HEIGHT) shell.dataset.compactHeight = height <= VERY_SHORT_VIEWPORT_HEIGHT ? "very-short" : "short";
  else delete shell.dataset.compactHeight;
  shell.toggleAttribute("data-wide-compact", height <= SHORT_VIEWPORT_HEIGHT && width >= INLINE_NOTICE_MIN_WIDTH);
}

/** 在固定补偿之外解析既有 app-height；不临时撤掉真实外壳，避免触发阅读锚点或输入预算。 */
function measureAppHeight(shell: HTMLElement) {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;height:var(--pwa-app-height);width:0;visibility:hidden;pointer-events:none";
  shell.append(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}

/** 展开即时补偿；只有实际高度回升才启动收起交接，视口恢复和页面交接均完成才能释放。 */
class KeyboardViewportController {
  private adjusted = false;
  private documentHandedBack = false;
  private readonly root = document.documentElement;
  private readonly motion: KeyboardClosingMotion;
  private unfocusedOcclusion: number;
  private unfocusedInset: number;
  private appHeight: number;
  private lastHeight = 0;

  constructor(private readonly shell: HTMLElement, private readonly viewport: VisualViewport | undefined) {
    this.motion = new KeyboardClosingMotion(shell, () => updateDensity(shell), () => this.update(),
      height => shell.toggleAttribute("data-keyboard-normal-padding", height > SHORT_VIEWPORT_HEIGHT));
    this.appHeight = shell.getBoundingClientRect().height;
    this.unfocusedInset = viewport ? this.appHeight - viewport.height : 0;
    this.unfocusedOcclusion = viewport ? Math.max(0, this.root.clientHeight - viewport.height) : 0;
  }

  reset(reason: KeyboardViewportDiagnostic["reason"] = "cleanup", previousHeight = this.lastHeight) {
    this.motion.stop();
    this.adjusted = false;
    this.documentHandedBack = false;
    this.lastHeight = 0;
    delete this.shell.dataset.keyboardViewport;
    delete this.shell.dataset.keyboardRestored;
    this.shell.style.removeProperty("--pwa-viewport-height");
    this.shell.style.removeProperty("--pwa-viewport-top");
    delete this.root.dataset.pwaKeyboard;
    this.root.style.removeProperty("--pwa-keyboard-document-height");
    updateDensity(this.shell);
    this.report(reason, previousHeight, reason === "restored" ? true : null);
  }

  focus() {
    // 新焦点使旧交接失效，即使旧计时器恰好即将结束也不能回写新一轮键盘状态。
    const previousHeight = this.lastHeight;
    this.motion.stop();
    this.documentHandedBack = false;
    this.lastHeight = this.viewport?.height ?? 0;
    if (this.adjusted && this.lastHeight > 0) this.lockDocument(this.lastHeight);
    this.report("focus", previousHeight);
  }

  blur() { if (this.adjusted) this.motion.intend(); }

  update() {
    const viewport = this.viewport;
    if (!viewport) { updateDensity(this.shell); this.report("no-viewport", this.lastHeight); return; }
    const occlusion = Math.max(0, this.root.clientHeight - viewport.height);
    // 缩放不是键盘：保留原生 pinch zoom，不把放大后的视口套进应用布局。
    if (Math.abs(viewport.scale - 1) > SCALE_EPSILON || viewport.height <= 0) return this.reset("invalid-viewport");
    if (!hasTextFocus() && !this.adjusted) {
      this.unfocusedOcclusion = occlusion;
      this.appHeight = this.shell.getBoundingClientRect().height;
      this.unfocusedInset = this.appHeight - viewport.height;
      return this.reset("unfocused-baseline");
    }
    // 仅入口比较 layout viewport；已进入后不能以较短的初始包含块当成恢复终点。
    if (!this.adjusted && occlusion <= this.unfocusedOcclusion + VIEWPORT_EPSILON) return this.reset("native-layout");
    const previousHeight = this.lastHeight;
    const appHeight = measureAppHeight(this.shell) || this.appHeight;
    if (Math.abs(appHeight - this.appHeight) > VIEWPORT_EPSILON) {
      // 旋转或窗口高度变化不是键盘回升；取消旧尺寸的过渡并使用当前 CSS 基准。
      this.motion.stop();
      this.documentHandedBack = false;
      this.lastHeight = viewport.height;
    }
    this.appHeight = appHeight;
    const restored = viewport.height >= appHeight - this.unfocusedInset - VIEWPORT_EPSILON;
    const growing = this.adjusted && viewport.height > this.lastHeight + VIEWPORT_EPSILON;
    if (viewport.height < this.lastHeight - VIEWPORT_EPSILON) {
      this.motion.stop();
      this.documentHandedBack = false;
    }
    // 只交还文档尺寸，不把实际增长当作键盘退场；后续同值通知/收尾不能重新反锁VV。
    if (growing) this.documentHandedBack = true;
    this.lastHeight = viewport.height;
    const closing = (growing || this.motion.active) && this.motion.move(viewport.height, restored);
    if (restored && !closing) return this.reset("restored", previousHeight);
    this.adjusted = true;
    this.lockDocument(this.documentHandedBack ? appHeight : viewport.height);
    this.shell.dataset.keyboardViewport = "";
    this.shell.style.setProperty("--pwa-viewport-top", `${Math.max(0, viewport.offsetTop)}px`);
    if (!closing) {
      delete this.shell.dataset.keyboardRestored;
      this.shell.style.setProperty("--pwa-viewport-height", `${viewport.height}px`);
    }
    updateDensity(this.shell);
    this.report(closing ? "closing" : "compensated", previousHeight, restored);
  }

  private report(reason: KeyboardViewportDiagnostic["reason"], previousHeight: number, restored: boolean | null = null) {
    const listener = diagnosticListeners.get(this.shell);
    if (!listener) return;
    // 只导出刚才判定所用的内存值；未订阅时不构造快照，也不新增同步布局测量。
    const state = Object.freeze({ reason, appHeight: this.appHeight, unfocusedInset: this.unfocusedInset,
      unfocusedOcclusion: this.unfocusedOcclusion, previousHeight, lastHeight: this.lastHeight,
      viewportHeight: this.viewport?.height ?? null, adjusted: this.adjusted, restored,
      restoreThreshold: restored === null ? null : this.appHeight - this.unfocusedInset - VIEWPORT_EPSILON,
      closing: this.motion.active, closingTarget: this.motion.target });
    try { listener(state); } catch { /* 调试采集失败不能中断视口补偿或清理。 */ }
  }

  // 压缩阶段限制文档以防原生整页回滚；实际回升后文档先交还自然高度，避免与VV恢复相互等待。
  // 外壳补偿仍独立等待恢复条件，两个阶段都保留必要的滚动复位。
  private lockDocument(height: number) {
    this.root.dataset.pwaKeyboard = "";
    this.root.style.setProperty("--pwa-keyboard-document-height", `${height}px`);
    if (window.scrollY !== 0) window.scrollTo({ top: 0, left: window.scrollX, behavior: "instant" });
  }
}

export function useKeyboardViewport(shellRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    if (!shell) return;

    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      controller.update();
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const controller = new KeyboardViewportController(shell, viewport ?? undefined);
    const onFocusIn = (event: FocusEvent) => {
      if (isTextEditable(event.target)) controller.focus();
      schedule();
    };

    const onFocusOut = () => { controller.blur(); schedule(); };

    update();
    // 视口尺寸变化是键盘起落的最早信号，在事件内立即处理；滚动等其余信号合并到下一帧。
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      controller.reset();
      delete shell.dataset.compactHeight;
      shell.removeAttribute("data-wide-compact");
    };
  }, [shellRef]);
}
