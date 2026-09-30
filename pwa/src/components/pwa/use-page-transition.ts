import { useLayoutEffect, useRef, type RefObject } from "react";
import { usePwaMotionDuration } from "./use-pwa-motion";

export { usePwaMotionDuration } from "./use-pwa-motion";

const PAGE_DURATION_MS = 200;
const EASE_STANDARD = "cubic-bezier(0.2, 0, 0, 1)";

type PageTransitionOptions = {
  /** 设置页是否为当前视图。 */
  open: boolean;
  /** 每次切换递增；相同值不重播。 */
  change: number;
  animate: boolean;
  rootRef: RefObject<HTMLElement | null>;
  workspaceRef: RefObject<HTMLElement | null>;
  settingsRef: RefObject<HTMLElement | null>;
  onSettled: (change: number) => void;
};

/* 已由 --pwa-motion-shift 全局 token 判定，不再单独读取媒体查询。 */

/**
 * 设置页整页水平推入／返回（200ms，标准曲线）：进入时工作区向左离场、设置页从右滑入，返回时反向。
 * 中途再次切换从两层的当前位置继续，不从头重播。减少动态效果时改为交叉淡化。
 */
export function usePageTransition({ open, change, animate, rootRef, workspaceRef, settingsRef, onSettled }: PageTransitionOptions) {
  const duration = usePwaMotionDuration("--pwa-duration-page", PAGE_DURATION_MS);
  const animationsRef = useRef<Animation[]>([]);
  const onSettledRef = useRef(onSettled);
  useLayoutEffect(() => { onSettledRef.current = onSettled; }, [onSettled]);

  useLayoutEffect(() => {
    if (change === 0) return;
    const workspace = workspaceRef.current;
    const settings = settingsRef.current;
    const root = rootRef.current;
    const running = animationsRef.current;
    if (!animate || !workspace || !settings || !root || typeof workspace.animate !== "function") {
      running.forEach((animation) => animation.cancel());
      animationsRef.current = [];
      onSettledRef.current(change);
      return;
    }
    let animations: Animation[];
    // 全局媒体查询同时控制时长与位移；这里仅选择设置页必需的交叉淡化轨迹。
    if (getComputedStyle(root).getPropertyValue("--pwa-motion-shift").trim() === "0") {
      const workspaceStart = running.length ? Number(getComputedStyle(workspace).opacity) : open ? 1 : 0;
      const settingsStart = running.length ? Number(getComputedStyle(settings).opacity) : open ? 0 : 1;
      running.forEach((animation) => animation.cancel());
      const timing = { duration, easing: EASE_STANDARD, fill: "forwards" as const };
      animations = [
        workspace.animate([{ opacity: workspaceStart }, { opacity: open ? 0 : 1 }], timing),
        settings.animate([{ opacity: settingsStart }, { opacity: open ? 1 : 0 }], timing),
      ];
    } else {
      const width = root.clientWidth;
      const left = root.getBoundingClientRect().left;
      const [workspaceStart, settingsStart] = running.length
        ? [workspace.getBoundingClientRect().left - left, settings.getBoundingClientRect().left - left]
        : open ? [0, width] : [-width, 0];
      running.forEach((animation) => animation.cancel());
      const [workspaceEnd, settingsEnd] = open ? [-width, 0] : [0, width];
      const timing = { duration, easing: EASE_STANDARD, fill: "forwards" as const };
      animations = [
        workspace.animate([{ transform: `translateX(${workspaceStart}px)` }, { transform: `translateX(${workspaceEnd}px)` }], timing),
        settings.animate([{ transform: `translateX(${settingsStart}px)` }, { transform: `translateX(${settingsEnd}px)` }], timing),
      ];
    }
    animationsRef.current = animations;
    void Promise.all(animations.map((animation) => animation.finished)).then(() => {
      if (animationsRef.current !== animations) return;
      animationsRef.current = [];
      onSettledRef.current(change);
      // 静止状态交由 CSS 决定，动画保留的末帧随后撤销。
      requestAnimationFrame(() => animations.forEach((animation) => animation.cancel()));
    }, () => {});
  }, [animate, change, duration, open, rootRef, settingsRef, workspaceRef]);

  useLayoutEffect(() => () => {
    animationsRef.current.forEach((animation) => animation.cancel());
    animationsRef.current = [];
  }, []);
}
