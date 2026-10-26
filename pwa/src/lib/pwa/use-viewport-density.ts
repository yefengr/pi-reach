import { useLayoutEffect, type RefObject } from "react";
import { TIMELINE_GEOMETRY_EVENT } from "./use-timeline-viewport";

// 短窗口通知密度阈值，不改变布局断点或 textarea 的动态空间预算。
const SHORT_VIEWPORT_HEIGHT = 600;
const VERY_SHORT_VIEWPORT_HEIGHT = 450;
const INLINE_NOTICE_MIN_WIDTH = 600;

function applyDensity(shell: HTMLElement) {
  const previous = shell.dataset.compactHeight;
  const { width, height } = shell.getBoundingClientRect();
  if (height <= SHORT_VIEWPORT_HEIGHT) shell.dataset.compactHeight = height <= VERY_SHORT_VIEWPORT_HEIGHT ? "very-short" : "short";
  else delete shell.dataset.compactHeight;
  shell.toggleAttribute("data-wide-compact", height <= SHORT_VIEWPORT_HEIGHT && width >= INLINE_NOTICE_MIN_WIDTH);
  return shell.dataset.compactHeight !== previous;
}

/**
 * 按应用壳实际尺寸切换矮窗口密度。软键盘完全交给浏览器：iOS 只平移可视区时外壳尺寸不变，
 * 支持 resizes-content 的浏览器缩小布局视口时随外壳尺寸生效。
 */
export function useViewportDensity(shellRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const update = () => {
      // 密度会改变消息区内边距（尺寸不变，时间线的尺寸观察不触发），通知它重新贴底或恢复锚点。
      if (applyDensity(shell)) shell.querySelector(".pwa-message-list")?.dispatchEvent(new Event(TIMELINE_GEOMETRY_EVENT));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      delete shell.dataset.compactHeight;
      shell.removeAttribute("data-wide-compact");
    };
  }, [shellRef]);
}
