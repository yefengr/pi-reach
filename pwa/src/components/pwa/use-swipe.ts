import { useLayoutEffect, useRef } from "react";
import { beginSwipe, cancelSwipe, finishSwipe, IDLE_SWIPE, moveSwipe, type SwipeDirection, type SwipePoint, type SwipeState } from "./swipe-gesture";
import { swipeBlocked, swipeStartExcluded } from "./swipe-guards";

export const SWIPE_MOBILE_QUERY = "(max-width: 767.98px)";
export type SwipeOptions = {
  direction: SwipeDirection;
  enabled: boolean;
  onSwipe: () => void;
  /** 提交前同步读取非 React 状态，例如 Drawer 的 chooserOpenRef。 */
  canSwipe?: () => boolean;
};

const coordinates = (event: PointerEvent): SwipePoint => ({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp });

export function useSwipe(element: HTMLElement | null, options: SwipeOptions): void {
  const optionsRef = useRef(options);
  const cancelRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    optionsRef.current = options;
    if (!options.enabled) cancelRef.current?.();
  });
  useLayoutEffect(() => {
    if (!element) return;
    const media = window.matchMedia(SWIPE_MOBILE_QUERY);
    let state: SwipeState = IDLE_SWIPE;
    const available = () => media.matches && optionsRef.current.enabled && (optionsRef.current.canSwipe?.() ?? true) && !swipeBlocked(element);
    const cancel = () => {
      const pointerId = state.phase === "idle" ? null : state.pointerId;
      state = cancelSwipe();
      window.removeEventListener("pointerdown", secondPointer, true);
      // 状态先清空，release 引发的 lostpointercapture 不得再次结束手势。
      if (pointerId !== null) {
        try {
          if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
        } catch { /* 指针已失效时仍完成监听和状态清理。 */ }
      }
    };
    const secondPointer = (event: PointerEvent) => {
      if (state.phase !== "idle" && event.pointerType === "touch" && event.pointerId !== state.pointerId) cancel();
    };
    const down = (event: PointerEvent) => {
      if (state.phase !== "idle" || !available() || swipeStartExcluded(element, event.target)) return;
      state = beginSwipe(state, coordinates(event), optionsRef.current.direction, event.pointerType, event.isPrimary);
      if (state.phase !== "idle") window.addEventListener("pointerdown", secondPointer, { capture: true, passive: true });
    };
    const move = (event: PointerEvent) => {
      if (state.phase === "idle" || event.pointerId !== state.pointerId) return;
      if (!available()) { cancel(); return; }
      const before = state.phase;
      state = moveSwipe(state, coordinates(event));
      if (before === "pending" && state.phase === "tracking") {
        try { element.setPointerCapture(event.pointerId); } catch { cancel(); }
      }
    };
    const up = (event: PointerEvent) => {
      if (state.phase === "idle" || event.pointerId !== state.pointerId) return;
      const committed = finishSwipe(state, coordinates(event)).committed && available();
      cancel();
      if (committed) optionsRef.current.onSwipe();
    };
    const pointerCancel = (event: PointerEvent) => {
      if (state.phase !== "idle" && event.pointerId === state.pointerId) cancel();
    };
    const lost = (event: PointerEvent) => {
      if (event.target === element) pointerCancel(event);
    };
    const mediaChanged = () => { if (!media.matches) cancel(); };
    cancelRef.current = cancel;
    element.addEventListener("pointerdown", down, { passive: true });
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", pointerCancel);
    element.addEventListener("lostpointercapture", lost);
    media.addEventListener("change", mediaChanged);
    return () => {
      cancel();
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
