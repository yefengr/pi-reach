import { useLayoutEffect, type RefObject } from "react";
import { TIMELINE_GEOMETRY_EVENT } from "./use-timeline-viewport";

const VIEWPORT_EPSILON = 1;
const SCALE_EPSILON = 0.01;
// 复用原有短窗口通知密度，不改变布局断点或 textarea 的动态空间预算。
const SHORT_VIEWPORT_HEIGHT = 600;
const VERY_SHORT_VIEWPORT_HEIGHT = 450;
const INLINE_NOTICE_MIN_WIDTH = 600;
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

export function hasTextFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
  if (active instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(active.type) && !active.disabled && !active.readOnly;
  return active instanceof HTMLElement && active.isContentEditable;
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

// transitionend 可能因元素卸载、标签页切走等原因丢失；超过动画时长这么久仍未结束就直接收尾。
const KEYBOARD_MOTION_GRACE_MS = 150;
type KeyboardMotion = "opening" | "closing";
const KEYBOARD_MOTION_ATTRIBUTE: Record<KeyboardMotion, string> = {
  opening: "data-keyboard-opening",
  closing: "data-keyboard-closing",
};

/**
 * iOS 弹出／收起键盘时立即报告最终视口，键盘本身却要滑动约 250ms，且不提供逐帧进度。
 * 外壳高度用同等时长过渡，让输入区与键盘同步移动；同一时刻只有一个方向，以 height 的 transitionend 收尾，计时器兜底。
 */
class KeyboardMotionClock {
  private kind: KeyboardMotion | null = null;
  private timer = 0;
  constructor(private readonly shell: HTMLElement, private readonly onEnd: (kind: KeyboardMotion) => void) {}
  get current(): KeyboardMotion | null { return this.kind; }
  /** 减少动态效果（时长为 0）时返回 false，调用方即时完成。 */
  start(kind: KeyboardMotion): boolean {
    this.stop();
    const duration = Number.parseFloat(getComputedStyle(this.shell).getPropertyValue("--pwa-duration-keyboard"));
    if (!(duration > 0)) return false;
    this.kind = kind;
    this.shell.setAttribute(KEYBOARD_MOTION_ATTRIBUTE[kind], "");
    this.shell.addEventListener("transitionend", this.handleEnd);
    this.timer = window.setTimeout(() => this.finish(), duration + KEYBOARD_MOTION_GRACE_MS);
    return true;
  }
  stop() {
    if (!this.kind) return;
    window.clearTimeout(this.timer);
    this.shell.removeEventListener("transitionend", this.handleEnd);
    this.shell.removeAttribute(KEYBOARD_MOTION_ATTRIBUTE[this.kind]);
    this.kind = null;
  }
  private readonly handleEnd = (event: TransitionEvent) => {
    if (event.target === this.shell && event.propertyName === "height") this.finish();
  };
  private finish() {
    const kind = this.kind;
    this.stop();
    if (kind) this.onEnd(kind);
  }
}

/** 补偿只缩小 visual viewport 的软键盘；浏览器已缩小布局视口时不再扣一次高度。 */
export function useKeyboardViewport(shellRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    if (!shell) return;

    let frame = 0;
    let adjusted = false;
    let unfocusedOcclusion = viewport ? Math.max(0, document.documentElement.clientHeight - viewport.height) : 0;
    const root = document.documentElement;
    const motion = new KeyboardMotionClock(shell, (kind) => { if (kind === "closing") reset(); });
    const reset = () => {
      motion.stop();
      adjusted = false;
      delete shell.dataset.keyboardViewport;
      shell.style.removeProperty("--pwa-viewport-height");
      shell.style.removeProperty("--pwa-viewport-top");
      delete root.dataset.pwaKeyboard;
      root.style.removeProperty("--pwa-keyboard-document-height");
      updateDensity(shell);
    };
    // iOS 为露出输入框会把整屏高的文档滚到底；键盘收起时 JS 读数一步归零，屏幕却播放原生回滚动画，
    // 整页（含顶栏）先被推出屏幕再滑回。把文档高度锁到可见高度并立即复位滚动，收起时就没有可回滚的距离。
    const lockDocument = (height: number) => {
      root.dataset.pwaKeyboard = "";
      root.style.setProperty("--pwa-keyboard-document-height", `${height}px`);
      if (window.scrollY !== 0) window.scrollTo({ top: 0, left: window.scrollX, behavior: "instant" });
    };
    // 失焦即开始把高度过渡到整屏，与键盘同时起步；结束后才解除 fixed 补偿和文档锁定。
    // 减少动态效果时不过渡，保留补偿直到视口恢复，避免输入区在键盘收起前跳到底部。
    const startClosing = () => {
      if (motion.current === "closing" || !motion.start("closing")) return;
      shell.style.setProperty("--pwa-viewport-height", "var(--pwa-app-height)");
    };
    const update = () => {
      frame = 0;
      if (!viewport) { updateDensity(shell); return; }
      const occlusion = Math.max(0, document.documentElement.clientHeight - viewport.height);
      const textFocus = hasTextFocus();
      // 缩放不是键盘：保留原生 pinch zoom，不把放大后的视口套进应用布局。
      if (Math.abs(viewport.scale - 1) > SCALE_EPSILON || viewport.height <= 0) {
        reset();
        return;
      }
      if (motion.current === "closing") {
        // 收起过渡期间视口读数已是终点，交给过渡收尾；中途重新聚焦则取消收起、按当前视口重新补偿。
        if (!textFocus) return;
        motion.stop();
      }
      if (!textFocus && !adjusted) {
        unfocusedOcclusion = occlusion;
        reset();
        return;
      }
      if (occlusion <= unfocusedOcclusion + VIEWPORT_EPSILON) {
        reset();
        return;
      }
      if (!textFocus) {
        startClosing();
        return;
      }
      // 首次进入补偿时从整屏过渡到键盘上方；之后的视口变化（联想栏增减、旋转）即时跟随。
      if (!adjusted) motion.start("opening");
      adjusted = true;
      lockDocument(viewport.height);
      shell.dataset.keyboardViewport = "";
      shell.style.setProperty("--pwa-viewport-height", `${viewport.height}px`);
      shell.style.setProperty("--pwa-viewport-top", `${Math.max(0, viewport.offsetTop)}px`);
      updateDensity(shell);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      reset();
      delete shell.dataset.compactHeight;
      shell.removeAttribute("data-wide-compact");
    };
  }, [shellRef]);
}
