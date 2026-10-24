import { useLayoutEffect, type RefObject } from "react";
import { TIMELINE_GEOMETRY_EVENT } from "./use-timeline-viewport";

const VIEWPORT_EPSILON = 1;
const SCALE_EPSILON = 0.01;
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

/**
 * 只补偿布局视口未缩小的软键盘遮挡，不拟合系统动画；尺寸与密度在同次更新中生效。
 * 聚焦是进入补偿的条件，失焦却不代表遮挡已恢复；已启用时继续跟随实际视口直到恢复。
 */
class KeyboardViewportController {
  private adjusted = false;
  private readonly root = document.documentElement;
  private unfocusedOcclusion: number;

  constructor(private readonly shell: HTMLElement, private readonly viewport: VisualViewport | undefined) {
    this.unfocusedOcclusion = viewport ? Math.max(0, this.root.clientHeight - viewport.height) : 0;
  }

  reset() {
    this.adjusted = false;
    delete this.shell.dataset.keyboardViewport;
    this.shell.style.removeProperty("--pwa-viewport-height");
    this.shell.style.removeProperty("--pwa-viewport-top");
    delete this.root.dataset.pwaKeyboard;
    this.root.style.removeProperty("--pwa-keyboard-document-height");
    updateDensity(this.shell);
  }

  update() {
    const viewport = this.viewport;
    if (!viewport) { updateDensity(this.shell); return; }
    const occlusion = Math.max(0, this.root.clientHeight - viewport.height);
    const textFocus = hasTextFocus();
    // 缩放不是键盘：保留原生 pinch zoom，不把放大后的视口套进应用布局。
    if (Math.abs(viewport.scale - 1) > SCALE_EPSILON || viewport.height <= 0) return this.reset();
    if (!textFocus && !this.adjusted) {
      this.unfocusedOcclusion = occlusion;
      return this.reset();
    }
    if (occlusion <= this.unfocusedOcclusion + VIEWPORT_EPSILON) return this.reset();
    this.adjusted = true;
    this.lockDocument(viewport.height);
    this.shell.dataset.keyboardViewport = "";
    this.shell.style.setProperty("--pwa-viewport-height", `${viewport.height}px`);
    this.shell.style.setProperty("--pwa-viewport-top", `${Math.max(0, viewport.offsetTop)}px`);
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

    update();
    // 视口尺寸变化是键盘起落的最早信号，在事件内立即处理；滚动等其余信号合并到下一帧。
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      controller.reset();
      delete shell.dataset.compactHeight;
      shell.removeAttribute("data-wide-compact");
    };
  }, [shellRef]);
}
