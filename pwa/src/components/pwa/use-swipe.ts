import { useLayoutEffect, useRef } from "react";
import { beginSwipe, cancelSwipe, finishSwipe, IDLE_SWIPE, moveSwipe, overscrollDistance, projectedCommit, trackedDistance, type SwipeDirection, type SwipePoint, type SwipeState } from "./swipe-gesture";
import { swipeBlocked, swipeEdgeExcluded, swipeStartExcluded } from "./swipe-guards";
import { MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

/**
 * 手势无法继续的原因：
 * - interrupted：pointercancel、第二触点、媒体查询变化、lostpointercapture；
 * - blocked：canSwipe() 变为 false 或出现阻断叠层，不代表底层表面已关闭；
 * - disabled：enabled 变为 false，同样不据此推断表面已关闭。
 */
export type SwipeCancelReason = "interrupted" | "blocked" | "disabled";

export type SwipeDragHandlers = {
  /** 指针捕获成功后调用；返回 false 拒绝，本次退回触发式。 */
  start(): boolean | void;
  /** trackedDistance，已 ≥ 0；overscroll 为 true 时反向越过起点为负。 */
  move(distance: number): void;
  /** 反向越界时是否继续报告负位移（由控制器做阻尼）；贴边的全屏表面不启用，越界会露出空隙。 */
  overscroll?: boolean;
  /** 表面的全程位移（像素）；松手时按投影停点是否过半判定提交，取不到时返回 0（不提交）。 */
  extent(): number;
  /** 松手：committed 按投影停点判定，反向甩回已计入。控制器负责收尾动画和随后的关闭／返回调用。 */
  end(result: { committed: boolean; velocity: number; distance: number }): void;
  cancel(reason: SwipeCancelReason): void;
};

export type SwipeOptions = {
  direction: SwipeDirection;
  enabled: boolean;
  onSwipe: () => void;
  /** 提交前同步读取非 React 状态，例如 Drawer 的 chooserOpenRef。 */
  canSwipe?: () => boolean;
  /** 跟手拖动；缺省时保持触发式。 */
  drag?: SwipeDragHandlers;
  /** 已知位于本表面下方的叠层选择器（如从移动导航打开的底部面板之下的导航 Drawer）；它们不阻断手势。 */
  underlay?: string;
};

const coordinates = (event: PointerEvent): SwipePoint => ({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp });

export function useSwipe(element: HTMLElement | null, options: SwipeOptions): void {
  const optionsRef = useRef(options);
  const cancelRef = useRef<((reason: SwipeCancelReason) => void) | null>(null);
  useLayoutEffect(() => {
    optionsRef.current = options;
    if (!options.enabled) cancelRef.current?.("disabled");
  });
  useLayoutEffect(() => {
    if (!element) return;
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    let state: SwipeState = IDLE_SWIPE;
    let dragging = false;
    const unavailable = (): SwipeCancelReason | null => {
      if (!media.matches) return "interrupted";
      if (!optionsRef.current.enabled) return "disabled";
      if (!(optionsRef.current.canSwipe?.() ?? true) || swipeBlocked(element, optionsRef.current.underlay)) return "blocked";
      return null;
    };
    const reset = () => {
      const pointerId = state.phase === "idle" ? null : state.pointerId;
      state = cancelSwipe();
      dragging = false;
      window.removeEventListener("pointerdown", secondPointer, true);
      // 状态先清空，release 引发的 lostpointercapture 不得再次结束手势。
      if (pointerId !== null) {
        try {
          if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
        } catch { /* 指针已失效时仍完成监听和状态清理。 */ }
      }
    };
    const cancel = (reason: SwipeCancelReason) => {
      const wasDragging = dragging;
      reset();
      if (wasDragging) optionsRef.current.drag?.cancel(reason);
    };
    const secondPointer = (event: PointerEvent) => {
      if (state.phase !== "idle" && event.pointerType === "touch" && event.pointerId !== state.pointerId) cancel("interrupted");
    };
    const down = (event: PointerEvent) => {
      if (state.phase !== "idle" || unavailable() || swipeStartExcluded(element, event.target, optionsRef.current.direction)) return;
      state = beginSwipe(state, coordinates(event), optionsRef.current.direction, event.pointerType, event.isPrimary);
      if (state.phase !== "idle") window.addEventListener("pointerdown", secondPointer, { capture: true, passive: true });
    };
    const move = (event: PointerEvent) => {
      if (state.phase === "idle" || event.pointerId !== state.pointerId) return;
      const reason = unavailable();
      if (reason) { cancel(reason); return; }
      const before = state.phase;
      const point = coordinates(event);
      state = moveSwipe(state, point);
      if (before === "pending" && state.phase === "tracking") {
        try { element.setPointerCapture(event.pointerId); } catch { cancel("interrupted"); return; }
        // 捕获成功后才询问控制器；start 可能同步提交 React 状态，须在状态机已进入 tracking 后调用。
        const { drag, direction } = optionsRef.current;
        dragging = drag !== undefined && !swipeEdgeExcluded(direction, state.start.x) && drag.start() !== false;
      }
      const drag = optionsRef.current.drag;
      if (dragging) drag?.move(drag.overscroll ? overscrollDistance(state, point) : trackedDistance(state, point));
    };
    const up = (event: PointerEvent) => {
      if (state.phase === "idle" || event.pointerId !== state.pointerId) return;
      const reason = unavailable();
      const result = finishSwipe(state, coordinates(event));
      if (dragging) {
        if (reason) { cancel(reason); return; }
        reset();
        const drag = optionsRef.current.drag;
        drag?.end({ committed: projectedCommit(result.distance, result.velocity, drag.extent()), velocity: Math.max(0, result.velocity), distance: result.distance });
        return;
      }
      const committed = result.committed && !reason;
      reset();
      if (committed) optionsRef.current.onSwipe();
    };
    const pointerCancel = (event: PointerEvent) => {
      if (state.phase !== "idle" && event.pointerId === state.pointerId) cancel("interrupted");
    };
    const lost = (event: PointerEvent) => {
      if (event.target === element) pointerCancel(event);
    };
    const mediaChanged = () => { if (!media.matches) cancel("interrupted"); };
    cancelRef.current = cancel;
    element.addEventListener("pointerdown", down, { passive: true });
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", pointerCancel);
    element.addEventListener("lostpointercapture", lost);
    media.addEventListener("change", mediaChanged);
    return () => {
      cancel("disabled");
      cancelRef.current = null;
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", pointerCancel);
      element.removeEventListener("lostpointercapture", lost);
      media.removeEventListener("change", mediaChanged);
    };
  }, [element]);
}
