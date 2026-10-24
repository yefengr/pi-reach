import { useLayoutEffect, type RefObject } from "react";
import { isIosTouchWebKit } from "./keyboard-focus-assist";
import { TIMELINE_GEOMETRY_EVENT } from "./use-timeline-viewport";

const VIEWPORT_EPSILON = 1;
const SCALE_EPSILON = 0.01;
// 复用原有短窗口通知密度，不改变布局断点或 textarea 的动态空间预算。
const SHORT_VIEWPORT_HEIGHT = 600;
const VERY_SHORT_VIEWPORT_HEIGHT = 450;
const INLINE_NOTICE_MIN_WIDTH = 600;
// 计时器在过渡结束后再多等约两帧收尾，确保最后一帧已绘制。
const KEYBOARD_MOTION_SETTLE_MS = 32;
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

type KeyboardMotion = "opening" | "closing";
const KEYBOARD_MOTION_ATTRIBUTE: Record<KeyboardMotion, string> = {
  opening: "data-keyboard-opening",
  closing: "data-keyboard-closing",
};

/**
 * iOS 弹出／收起键盘时立即报告最终视口，键盘本身却要滑动约 250ms，且不提供逐帧进度。
 * 外壳高度用同等时长与曲线过渡，与键盘同步移动；同一时刻只有一个方向。
 * 只按时长收尾：真机上 height 的 transitionend 会提前触发，不能作为结束依据。
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
    this.timer = window.setTimeout(() => {
      this.stop();
      this.onEnd(kind);
    }, duration + KEYBOARD_MOTION_SETTLE_MS);
    return true;
  }
  stop() {
    if (!this.kind) return;
    window.clearTimeout(this.timer);
    this.shell.removeAttribute(KEYBOARD_MOTION_ATTRIBUTE[this.kind]);
    this.kind = null;
  }
}

/**
 * 补偿只缩小 visual viewport 的软键盘；浏览器已缩小布局视口时不再扣一次高度。
 * WebKit 在 position 由 static 改为 fixed 的同一帧不会从旧高度起过渡，所以先以当前高度切入 fixed（prepared），再起过渡：
 * iOS 上聚焦即预备（键盘约 90ms 后才升起），视口事件内立即起过渡；失焦在 focusout 内立即收起，尽量与系统键盘同一帧起步。
 */
class KeyboardViewportController {
  private adjusted = false;
  private prepared = false;
  private readonly root = document.documentElement;
  private readonly motion: KeyboardMotionClock;
  private unfocusedOcclusion: number;

  constructor(private readonly shell: HTMLElement, private readonly viewport: VisualViewport | undefined,
    private readonly requestUpdate: () => void, private readonly prepareOnFocus = isIosTouchWebKit()) {
    this.motion = new KeyboardMotionClock(shell, (kind) => { if (kind === "closing") this.reset(); });
    this.unfocusedOcclusion = viewport ? Math.max(0, this.root.clientHeight - viewport.height) : 0;
  }

  reset() {
    this.motion.stop();
    this.adjusted = false;
    this.prepared = false;
    delete this.shell.dataset.keyboardViewport;
    delete this.shell.dataset.keyboardPrepared;
    this.shell.style.removeProperty("--pwa-viewport-height");
    this.shell.style.removeProperty("--pwa-viewport-top");
    delete this.root.dataset.pwaKeyboard;
    this.root.style.removeProperty("--pwa-keyboard-document-height");
    updateDensity(this.shell);
  }

  focus() {
    if (this.prepareOnFocus && !this.adjusted && hasTextFocus()) this.prepare();
  }

  /** focusout 内同步判断：焦点移到另一个文本输入时键盘不收起。 */
  blur(next: EventTarget | null) {
    if (isTextEditable(next)) return;
    if (this.adjusted) this.startClosing();
    else if (this.prepared) this.reset();
  }

  update() {
    const viewport = this.viewport;
    if (!viewport) { updateDensity(this.shell); return; }
    const occlusion = Math.max(0, this.root.clientHeight - viewport.height);
    const textFocus = hasTextFocus();
    // 缩放不是键盘：保留原生 pinch zoom，不把放大后的视口套进应用布局。
    if (Math.abs(viewport.scale - 1) > SCALE_EPSILON || viewport.height <= 0) return this.reset();
    if (this.motion.current === "closing") {
      // 收起过渡期间视口读数已是终点，交给过渡收尾；中途重新聚焦则取消收起、按当前视口重新补偿。
      if (!textFocus) return;
      this.motion.stop();
    }
    if (!textFocus && !this.adjusted) {
      this.unfocusedOcclusion = occlusion;
      return this.reset();
    }
    if (occlusion <= this.unfocusedOcclusion + VIEWPORT_EPSILON) {
      // 已预备但键盘尚未升起（或使用硬件键盘）：保持当前高度等待，画面不变。
      if (this.prepared && textFocus && !this.adjusted) return;
      return this.reset();
    }
    if (!textFocus) return this.startClosing();
    if (!this.adjusted) {
      if (!this.prepared) {
        this.prepare();
        this.lockDocument(viewport.height);
        this.requestUpdate();
        return;
      }
      this.adjusted = true;
      this.prepared = false;
      delete this.shell.dataset.keyboardPrepared;
      this.motion.start("opening");
    }
    this.lockDocument(viewport.height);
    this.shell.dataset.keyboardViewport = "";
    this.shell.style.setProperty("--pwa-viewport-height", `${viewport.height}px`);
    this.shell.style.setProperty("--pwa-viewport-top", `${Math.max(0, viewport.offsetTop)}px`);
    updateDensity(this.shell);
  }

  /** 以当前高度切入 fixed：画面不变，后续高度变化才能从此处起过渡。 */
  private prepare() {
    if (this.prepared) return;
    this.prepared = true;
    this.shell.dataset.keyboardPrepared = "";
    this.shell.style.setProperty("--pwa-viewport-height", `${this.shell.getBoundingClientRect().height}px`);
    this.shell.style.setProperty("--pwa-viewport-top", "0px");
    // 立即计算一次样式，把 fixed 下的当前高度记为过渡起点；否则同一帧内紧接着改高度时没有起点可过渡。
    this.shell.getBoundingClientRect();
  }

  // iOS 为露出输入框会把整屏高的文档滚到底；键盘收起时 JS 读数一步归零，屏幕却播放原生回滚动画，
  // 整页（含顶栏）先被推出屏幕再滑回。把文档高度锁到可见高度并立即复位滚动，收起时就没有可回滚的距离。
  private lockDocument(height: number) {
    this.root.dataset.pwaKeyboard = "";
    this.root.style.setProperty("--pwa-keyboard-document-height", `${height}px`);
    if (window.scrollY !== 0) window.scrollTo({ top: 0, left: window.scrollX, behavior: "instant" });
  }

  // 收起时外壳高度过渡回整屏，结束后才解除 fixed 补偿和文档锁定；减少动态效果时保留补偿直到视口恢复。
  private startClosing() {
    if (this.motion.current === "closing" || !this.motion.start("closing")) return;
    this.shell.style.setProperty("--pwa-viewport-height", "var(--pwa-app-height)");
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
    const controller = new KeyboardViewportController(shell, viewport ?? undefined, schedule);
    const onFocusIn = () => {
      controller.focus();
      schedule();
    };
    const onFocusOut = (event: FocusEvent) => {
      controller.blur(event.relatedTarget);
      schedule();
    };

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
