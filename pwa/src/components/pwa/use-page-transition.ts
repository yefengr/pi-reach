import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { settleDuration, type SwipeDrag } from "./swipe-drag";
import { pwaMotionShiftDisabled, pwaStandardEasing, usePwaMotionDuration } from "./use-pwa-motion";

export { usePwaMotionDuration } from "./use-pwa-motion";

const PAGE_DURATION_MS = 200;

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

/**
 * 设置页覆盖滑入／滑出（200ms，标准曲线），与右侧 Drawer 同一模型：工作区保持原位，
 * 设置层从右滑入并盖住工作区，遮罩同步淡入；返回时反向。
 * 中途再次切换从设置层与遮罩的当前状态继续，不从头重播。减少动态效果时改为交叉淡化。
 */
export function usePageTransition({ open, change, animate, rootRef, workspaceRef, settingsRef, scrimRef, onSettled }: PageTransitionOptions) {
  const duration = usePwaMotionDuration("--pwa-duration-page", PAGE_DURATION_MS);
  const animationsRef = useRef<Animation[]>([]);
  // 跟手拖动中的暂停动画：路由变化时与 animationsRef 同样被接管，从当前位置续播。
  const dragRef = useRef<SwipeDrag | null>(null);
  // 拖动松手后的一次性交接：续播时长按剩余位移与松手速度缩短，其余来源保持全程时长。
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
    const easing = pwaStandardEasing(root);
    // 全局媒体查询同时控制时长与位移；这里仅选择设置页必需的交叉淡化轨迹。
    if (pwaMotionShiftDisabled(root)) {
      const workspaceStart = inFlight ? Number(getComputedStyle(workspace).opacity) : open ? 1 : 0;
      const settingsStart = inFlight ? Number(getComputedStyle(settings).opacity) : open ? 0 : 1;
      cancelInFlight();
      const timing = { duration, easing, fill: "forwards" as const };
      animations = [
        workspace.animate([{ opacity: workspaceStart }, { opacity: open ? 0 : 1 }], timing),
        settings.animate([{ opacity: settingsStart }, { opacity: open ? 1 : 0 }], timing),
      ];
    } else {
      const width = root.clientWidth;
      const settingsStart = inFlight ? settings.getBoundingClientRect().left - root.getBoundingClientRect().left : open ? width : 0;
      const scrimStart = scrim && inFlight ? Number(getComputedStyle(scrim).opacity) : open ? 0 : 1;
      cancelInFlight();
      const settingsEnd = open ? 0 : width;
      const timing = { duration: handOff ? settleDuration(Math.abs(settingsEnd - settingsStart), handOff.velocity, duration) : duration, easing, fill: "forwards" as const };
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
  }, [animate, change, duration, open, rootRef, scrimRef, settingsRef, workspaceRef]);

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
