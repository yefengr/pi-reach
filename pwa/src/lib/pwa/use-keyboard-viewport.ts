import { useLayoutEffect, type RefObject } from "react";
import { TIMELINE_GEOMETRY_EVENT } from "./use-timeline-viewport";

const VIEWPORT_EPSILON = 1;
const SCALE_EPSILON = 0.01;
// 沿用收起过渡的两帧收尾余量；它只结束页面过渡，不判定系统键盘是否已退场。
const KEYBOARD_MOTION_SETTLE_MS = 32;
// 复用原有短窗口通知密度，不改变布局断点或 textarea 的动态空间预算。
const SHORT_VIEWPORT_HEIGHT = 600;
const VERY_SHORT_VIEWPORT_HEIGHT = 450;
const INLINE_NOTICE_MIN_WIDTH = 600;
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

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

/** 复用既有收起参数避免一步扩回整屏，不用页面过渡冒充原生键盘进度。 */
class KeyboardClosingMotion {
  private frame = 0;
  private timer = 0;
  private height = 0;
  private restoreSafeArea = false;

  constructor(private readonly shell: HTMLElement, private readonly onEnd: () => void) {}
  get active() { return this.frame !== 0 || this.timer !== 0; }

  move(height: number, restoreSafeArea: boolean): boolean {
    // 重复 resize/scroll 不能延长同一目标的交接。
    if (this.active && height === this.height && restoreSafeArea === this.restoreSafeArea) return true;
    const value = getComputedStyle(this.shell).getPropertyValue("--pwa-duration-keyboard").trim();
    const number = Number.parseFloat(value);
    const duration = Number.isFinite(number) ? number * (value.endsWith("ms") ? 1 : 1000) : 0;
    if (!(duration > 0)) { this.stop(); return false; }
    this.height = height;
    this.restoreSafeArea = restoreSafeArea;
    if (this.frame) return true;
    if (this.timer) this.commit(duration);
    else this.frame = window.requestAnimationFrame(() => { this.frame = 0; this.commit(duration); });
    return true;
  }

  private commit(duration: number) {
    // 起点必须已计算；首个提交放在下一帧，不让当前任务提前消耗 CSS 过渡时间。
    void getComputedStyle(this.shell).height;
    this.shell.dataset.keyboardClosing = "";
    this.shell.toggleAttribute("data-keyboard-restored", this.restoreSafeArea);
    this.shell.style.setProperty("--pwa-viewport-height", `${this.height}px`);
    void getComputedStyle(this.shell).height;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.stop(); this.onEnd(); }, duration + KEYBOARD_MOTION_SETTLE_MS);
  }

  stop() {
    window.cancelAnimationFrame(this.frame);
    window.clearTimeout(this.timer);
    this.frame = this.timer = 0;
    delete this.shell.dataset.keyboardClosing;
    // 安全区由控制器与最终高度一起交接；此处先撤掉会在随后测量中短暂扩大列表、钳制 scrollTop。
  }
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
  private readonly root = document.documentElement;
  private readonly motion: KeyboardClosingMotion;
  private unfocusedOcclusion: number;
  private unfocusedInset: number;
  private appHeight: number;
  private lastHeight = 0;

  constructor(private readonly shell: HTMLElement, private readonly viewport: VisualViewport | undefined) {
    this.motion = new KeyboardClosingMotion(shell, () => this.update());
    this.appHeight = shell.getBoundingClientRect().height;
    this.unfocusedInset = viewport ? this.appHeight - viewport.height : 0;
    this.unfocusedOcclusion = viewport ? Math.max(0, this.root.clientHeight - viewport.height) : 0;
  }

  reset() {
    this.motion.stop();
    this.adjusted = false;
    this.lastHeight = 0;
    delete this.shell.dataset.keyboardViewport;
    delete this.shell.dataset.keyboardRestored;
    this.shell.style.removeProperty("--pwa-viewport-height");
    this.shell.style.removeProperty("--pwa-viewport-top");
    delete this.root.dataset.pwaKeyboard;
    this.root.style.removeProperty("--pwa-keyboard-document-height");
    updateDensity(this.shell);
  }

  focus() {
    // 新焦点使旧交接失效，即使旧计时器恰好即将结束也不能回写新一轮键盘状态。
    this.motion.stop();
    this.lastHeight = this.viewport?.height ?? 0;
  }

  update() {
    const viewport = this.viewport;
    if (!viewport) { updateDensity(this.shell); return; }
    const occlusion = Math.max(0, this.root.clientHeight - viewport.height);
    // 缩放不是键盘：保留原生 pinch zoom，不把放大后的视口套进应用布局。
    if (Math.abs(viewport.scale - 1) > SCALE_EPSILON || viewport.height <= 0) return this.reset();
    if (!hasTextFocus() && !this.adjusted) {
      this.unfocusedOcclusion = occlusion;
      this.appHeight = this.shell.getBoundingClientRect().height;
      this.unfocusedInset = this.appHeight - viewport.height;
      return this.reset();
    }
    // 仅入口比较 layout viewport；已进入后不能以较短的初始包含块当成恢复终点。
    if (!this.adjusted && occlusion <= this.unfocusedOcclusion + VIEWPORT_EPSILON) return this.reset();
    const appHeight = measureAppHeight(this.shell) || this.appHeight;
    if (Math.abs(appHeight - this.appHeight) > VIEWPORT_EPSILON) {
      // 旋转或窗口高度变化不是键盘回升；取消旧尺寸的过渡并使用当前 CSS 基准。
      this.motion.stop();
      this.lastHeight = viewport.height;
    }
    this.appHeight = appHeight;
    const restored = viewport.height >= appHeight - this.unfocusedInset - VIEWPORT_EPSILON;
    const growing = this.adjusted && viewport.height > this.lastHeight + VIEWPORT_EPSILON;
    if (viewport.height < this.lastHeight - VIEWPORT_EPSILON) this.motion.stop();
    this.lastHeight = viewport.height;
    const closing = (growing || this.motion.active) && this.motion.move(viewport.height, restored);
    if (restored && !closing) return this.reset();
    this.adjusted = true;
    this.lockDocument(viewport.height);
    this.shell.dataset.keyboardViewport = "";
    this.shell.style.setProperty("--pwa-viewport-top", `${Math.max(0, viewport.offsetTop)}px`);
    if (!closing) {
      delete this.shell.dataset.keyboardRestored;
      this.shell.style.setProperty("--pwa-viewport-height", `${viewport.height}px`);
    }
    updateDensity(this.shell);
  }

  // iOS 为露出输入框会把整屏高的文档滚到底；键盘收起时 JS 读数一步归零，屏幕却播放原生回滚动画，
  // 整页（含顶栏）先被推出屏幕再滑回。把文档高度锁到可见高度并立即复位滚动，收起时就没有可回滚的距离。
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

    update();
    // 视口尺寸变化是键盘起落的最早信号，在事件内立即处理；滚动等其余信号合并到下一帧。
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", schedule);
      controller.reset();
      delete shell.dataset.compactHeight;
      shell.removeAttribute("data-wide-compact");
    };
  }, [shellRef]);
}
