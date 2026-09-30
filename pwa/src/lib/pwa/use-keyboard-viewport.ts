import { useLayoutEffect, type RefObject } from "react";
import { TIMELINE_GEOMETRY_EVENT } from "./use-timeline-viewport";

const VIEWPORT_EPSILON = 1;
const SCALE_EPSILON = 0.01;
// 复用原有短窗口通知密度，不改变布局断点或 textarea 的动态空间预算。
const SHORT_VIEWPORT_HEIGHT = 600;
const VERY_SHORT_VIEWPORT_HEIGHT = 450;
const INLINE_NOTICE_MIN_WIDTH = 600;
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

function hasTextFocus() {
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

/** 补偿只缩小 visual viewport 的软键盘；浏览器已缩小布局视口时不再扣一次高度。 */
export function useKeyboardViewport(shellRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    if (!shell) return;

    let frame = 0;
    let adjusted = false;
    let unfocusedOcclusion = viewport ? Math.max(0, document.documentElement.clientHeight - viewport.height) : 0;
    const reset = () => {
      adjusted = false;
      delete shell.dataset.keyboardViewport;
      shell.style.removeProperty("--pwa-viewport-height");
      shell.style.removeProperty("--pwa-viewport-top");
      updateDensity(shell);
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
      if (!textFocus && !adjusted) unfocusedOcclusion = occlusion;
      if ((!textFocus && !adjusted) || occlusion <= unfocusedOcclusion + VIEWPORT_EPSILON) {
        reset();
        return;
      }
      // blur 后保留补偿直到视口恢复，避免键盘关闭动画尚未结束时输入区跳回屏幕底部。
      adjusted = true;
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
