import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { SwipeDrag } from "./swipe-drag";
import { pwaContentEasing, pwaMotionShiftDisabled, pwaReleaseEasing, usePwaMotionDuration } from "./use-pwa-motion";
import { pwaRedirectEasing } from "@/lib/ui/motion";

export { usePwaMotionDuration } from "./use-pwa-motion";

type PageTransitionOptions = {
  /** 设置页是否为当前视图。 */
  open: boolean;
  /** 每次切换递增；相同值不重播。 */
  change: number;
  animate: boolean;
  rootRef: RefObject<HTMLElement | null>;
  workspaceRef: RefObject<HTMLElement | null>;
  settingsRef: RefObject<HTMLElement | null>;
  /** 设置层下方的页面遮罩；缺失时只移动设置层。 */
  scrimRef: RefObject<HTMLElement | null>;
  onSettled: (change: number) => void;
};

/* 已由 --pwa-motion-shift 全局 token 判定，不再单独读取媒体查询。 */

/** 在途动画的速度采样间隔：约一帧。 */
const VELOCITY_SAMPLE_MS = 16;

/** 在途位移动画此刻的水平速度（像素／毫秒）：把动画倒回一帧量一次位置再恢复，不改变它的播放。 */
function runningVelocity(animations: Animation[], element: HTMLElement, left: number): number {
  const animation = animations.find((candidate) => candidate.effect instanceof KeyframeEffect && candidate.effect.target === element);
  const time = animation?.currentTime;
  if (!animation || animation.playState !== "running" || typeof time !== "number" || time <= VELOCITY_SAMPLE_MS) return 0;
  animation.currentTime = time - VELOCITY_SAMPLE_MS;
  const earlier = element.getBoundingClientRect().left;
  animation.currentTime = time;
  return (left - earlier) / VELOCITY_SAMPLE_MS;
}

/**
 * 设置页覆盖滑入／滑出（page／page-out，内容曲线），与右侧 Drawer 同一模型：工作区保持原位，
 * 设置层从右滑入并盖住工作区，遮罩同步淡入；返回时反向。
 * 中途再次切换从设置层与遮罩的当前状态继续，不从头重播，并沿用当前速度先减速再折返。减少动态效果时改为交叉淡化。
 */
export function usePageTransition({ open, change, animate, rootRef, workspaceRef, settingsRef, scrimRef, onSettled }: PageTransitionOptions) {
  const enterDuration = usePwaMotionDuration("--pwa-duration-page");
  const exitDuration = usePwaMotionDuration("--pwa-duration-page-out");
  const animationsRef = useRef<Animation[]>([]);
  // 跟手拖动中的暂停动画：路由变化时与 animationsRef 同样被接管，从当前位置续播。
  const dragRef = useRef<SwipeDrag | null>(null);
  // 拖动松手后的一次性交接：松手速度作为弹簧初速度，时长与其他来源相同。
  const handOffRef = useRef<{ velocity: number } | null>(null);
  const settledRef = useRef<{ animations: Animation[]; change: number; open: boolean; settings: HTMLElement } | null>(null);
  const onSettledRef = useRef(onSettled);
  useLayoutEffect(() => { onSettledRef.current = onSettled; }, [onSettled]);

  useLayoutEffect(() => {
    if (change === 0) return;
    const workspace = workspaceRef.current;
    const settings = settingsRef.current;
    const root = rootRef.current;
    const scrim = scrimRef.current;
    const running = animationsRef.current;
    const drag = dragRef.current;
    const handOff = handOffRef.current;
    const inFlight = running.length > 0 || drag !== null;
    dragRef.current = null;
    handOffRef.current = null;
    settledRef.current = null;
    const cancelInFlight = () => {
      running.forEach((animation) => animation.cancel());
      drag?.dispose();
    };
    if (!animate || !workspace || !settings || !root || typeof workspace.animate !== "function") {
      cancelInFlight();
      animationsRef.current = [];
      onSettledRef.current(change);
      return;
    }
    let animations: Animation[];
    const duration = open ? enterDuration : exitDuration;
    // 全局媒体查询同时控制时长与位移；这里仅选择设置页必需的交叉淡化轨迹。
    if (pwaMotionShiftDisabled(root)) {
      const workspaceStart = inFlight ? Number(getComputedStyle(workspace).opacity) : open ? 1 : 0;
      const settingsStart = inFlight ? Number(getComputedStyle(settings).opacity) : open ? 0 : 1;
      cancelInFlight();
      const timing = { duration, easing: pwaContentEasing(root), fill: "forwards" as const };
      animations = [
        workspace.animate([{ opacity: workspaceStart }, { opacity: open ? 0 : 1 }], timing),
        settings.animate([{ opacity: settingsStart }, { opacity: open ? 1 : 0 }], timing),
      ];
    } else {
      const width = root.clientWidth;
      const settingsLeft = settings.getBoundingClientRect().left;
      const settingsStart = inFlight ? settingsLeft - root.getBoundingClientRect().left : open ? width : 0;
      const scrimStart = scrim && inFlight ? Number(getComputedStyle(scrim).opacity) : open ? 0 : 1;
      // 按钮或系统返回打断在途转场：取设置层此刻的速度接续；跟手拖动的交接另有松手速度。
      const carried = !handOff && drag === null ? runningVelocity(running, settings, settingsLeft) : 0;
      cancelInFlight();
      const settingsEnd = open ? 0 : width;
      const remaining = Math.abs(settingsEnd - settingsStart);
      const toward = Math.sign(settingsEnd - settingsStart);
      // 返回时越过起点会在右侧露出工作区，越过量不超过设置层距左缘的距离；进入时越过的部分仍在屏幕外。
      const easing = handOff && remaining > 0 ? pwaReleaseEasing(root, handOff.velocity / remaining, duration)
        : carried !== 0 && remaining > 0 ? pwaRedirectEasing(root, carried * toward / remaining, duration, open ? Infinity : settingsStart / remaining)
          : pwaReleaseEasing(root, 0, duration);
      const timing = { duration, easing, fill: "forwards" as const };
      animations = [settings.animate([{ transform: `translateX(${settingsStart}px)` }, { transform: `translateX(${settingsEnd}px)` }], timing)];
      if (scrim) animations.push(scrim.animate([{ opacity: scrimStart }, { opacity: open ? 1 : 0 }], timing));
    }
    animationsRef.current = animations;
    void Promise.all(animations.map((animation) => animation.finished)).then(() => {
      if (animationsRef.current !== animations) return;
      // finished 只证明动画结束；父级静止态尚未提交时仍须保持两层的末帧。
      settledRef.current = { animations, change, open, settings };
      onSettledRef.current(change);
    }, () => {});
  }, [animate, change, enterDuration, exitDuration, open, rootRef, scrimRef, settingsRef, workspaceRef]);

  useLayoutEffect(() => {
    const settled = settledRef.current;
    const root = rootRef.current;
    if (!settled || settled.change !== change || settled.open !== open || !root) return;
    if (root.dataset.view !== (open ? "settings" : "workspace") || root.hasAttribute("data-view-transition")) return;
    // 返回时只撤销已卸载设置层的 fill；进入时静止 CSS 已在本次提交隐藏工作区。
    if (!open && settled.settings.isConnected) return;
    settledRef.current = null;
    animationsRef.current = [];
    settled.animations.forEach((animation) => animation.cancel());
  });

  useLayoutEffect(() => () => {
    settledRef.current = null;
    animationsRef.current.forEach((animation) => animation.cancel());
    animationsRef.current = [];
    dragRef.current?.dispose();
    dragRef.current = null;
  }, []);

  const beginDrag = useCallback((drag: SwipeDrag) => { dragRef.current = drag; }, []);
  /** 回弹完成或保险超时：撤销拖动动画并放弃待交接的速度。 */
  const endDrag = useCallback(() => {
    dragRef.current?.dispose();
    dragRef.current = null;
    handOffRef.current = null;
  }, []);
  const handOff = useCallback((velocity: number) => { handOffRef.current = { velocity }; }, []);
  return useMemo(() => ({ beginDrag, endDrag, handOff }), [beginDrag, endDrag, handOff]);
}
