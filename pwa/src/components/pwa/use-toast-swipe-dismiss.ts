import { useEffect } from "react";
import { notifications } from "@mantine/notifications";
import { beginSwipe, finishSwipe, IDLE_SWIPE, moveSwipe, overscrollDistance, projectedCommit, rubberBand, type SwipePoint, type SwipeState } from "./swipe-gesture";
import { pwaContentEasing, pwaMotionShiftDisabled, pwaReleaseEasing } from "./use-pwa-motion";
import { readPwaMotionDuration } from "@/lib/ui/motion-duration";
import { OPERATION_NOTIFICATION_ID, type OperationNotificationController } from "@/lib/pwa/operation-notifications";

const TOAST_SELECTOR = ".pwa-operation-notifications .pwa-operation-notification";

const coordinates = (event: PointerEvent): SwipePoint => ({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp });
const lifted = (distance: number) => `0 ${-distance}px`;
/** 朝收走方向原样跟随；向下越过原位时按卡片高度做橡皮筋阻尼。 */
const displayed = (distance: number, element: HTMLElement) => distance >= 0 ? distance : -rubberBand(-distance, element.offsetHeight);

/**
 * 触屏上滑收走 Toast：卡片跟随手指上移，松手后按投影停点判定（与抽屉同一规则，行程为卡片离开屏幕顶边的距离）；
 * 提交走与关闭按钮相同的关闭入口，未提交则回到原位。Toast 由 Mantine 渲染、取不到 ref，监听挂在 document 上。
 * 减少动态效果时卡片不跟手，只在松手时判定。
 */
export function useToastSwipeDismiss(controller: OperationNotificationController): void {
  useEffect(() => {
    let state: SwipeState = IDLE_SWIPE;
    let toast: HTMLElement | null = null;
    let follow = false;
    let paused = false;
    // 卡片当前显示的上移量；向下越过原位时为负，按卡片高度做橡皮筋阻尼。
    let shown = 0;
    // 已上滑收走、正随退出淡化的卡片；同一元素被下一条提示复用时须先复位。
    let dismissed: HTMLElement | null = null;

    const restore = (element: HTMLElement) => {
      element.getAnimations().forEach((animation) => { if (animation instanceof Animation && !(animation instanceof CSSTransition)) animation.cancel(); });
      element.style.translate = "";
    };
    const resume = () => {
      if (paused) controller.resumeAutoClose("drag");
      paused = false;
    };
    const reset = () => {
      state = IDLE_SWIPE;
      toast = null;
      follow = false;
      shown = 0;
      window.removeEventListener("pointerdown", secondPointer, true);
    };
    const settleBack = (element: HTMLElement, distance: number) => {
      element.style.translate = "";
      if (distance === 0) return;
      const duration = readPwaMotionDuration(distance < 0 ? "--pwa-duration-overscroll" : "--pwa-duration-toast-out");
      element.animate([{ translate: lifted(distance) }, { translate: lifted(0) }], { duration, easing: pwaContentEasing(element) });
    };
    const cancel = (point?: SwipePoint) => {
      const element = toast;
      if (point && element && follow) shown = displayed(overscrollDistance(state, point), element);
      const distance = shown;
      const wasFollowing = follow;
      reset();
      if (element && wasFollowing) settleBack(element, distance);
      resume();
    };
    const secondPointer = (event: PointerEvent) => {
      if (state.phase !== "idle" && event.pointerType === "touch" && event.pointerId !== state.pointerId) cancel();
    };
    const down = (event: PointerEvent) => {
      if (state.phase !== "idle" || !(event.target instanceof Element)) return;
      const element = event.target.closest<HTMLElement>(TOAST_SELECTOR);
      if (!element || element === dismissed) return;
      state = beginSwipe(state, coordinates(event), "up", event.pointerType, event.isPrimary);
      if (state.phase === "idle") return;
      toast = element;
      window.addEventListener("pointerdown", secondPointer, { capture: true, passive: true });
    };
    const move = (event: PointerEvent) => {
      if (state.phase === "idle" || event.pointerId !== state.pointerId || !toast) return;
      if (!toast.isConnected) { cancel(); return; }
      const before = state.phase;
      const point = coordinates(event);
      state = moveSwipe(state, point);
      if (before === "pending" && state.phase === "tracking") {
        follow = !pwaMotionShiftDisabled(toast);
        controller.pauseAutoClose("drag");
        paused = true;
      }
      if (follow) {
        shown = displayed(overscrollDistance(state, point), toast);
        toast.style.translate = lifted(shown);
      }
    };
    const up = (event: PointerEvent) => {
      if (state.phase === "idle" || event.pointerId !== state.pointerId || !toast) return;
      const element = toast;
      const wasFollowing = follow;
      const tracking = state.phase === "tracking";
      const result = finishSwipe(state, coordinates(event));
      const from = wasFollowing ? displayed(overscrollDistance(state, coordinates(event)), element) : 0;
      reset();
      if (!tracking || !element.isConnected) { resume(); return; }
      // 行程：卡片下沿到屏幕顶边的距离，走完即完全离开屏幕。
      const extent = element.getBoundingClientRect().bottom + (wasFollowing ? result.distance : 0);
      if (!projectedCommit(result.distance, result.velocity, extent)) {
        if (wasFollowing) settleBack(element, from);
        resume();
        return;
      }
      if (wasFollowing) {
        const duration = readPwaMotionDuration("--pwa-duration-toast-out");
        const remaining = Math.max(0, extent - result.distance);
        element.style.translate = lifted(extent);
        element.animate([{ translate: lifted(result.distance) }, { translate: lifted(extent) }], { duration, easing: pwaReleaseEasing(element, remaining > 0 ? Math.max(0, result.velocity) / remaining : 0, duration) });
        dismissed = element;
      }
      resume();
      notifications.hide(OPERATION_NOTIFICATION_ID, controller.store);
    };
    const pointerCancel = (event: PointerEvent) => {
      if (state.phase !== "idle" && event.pointerId === state.pointerId) cancel(coordinates(event));
    };
    // 固定 ID 的下一条提示可能复用同一元素：出现新提示时撤销上一条留下的位移。
    const unsubscribe = controller.store.subscribe(() => {
      if (!dismissed || controller.store.getState().notifications.length === 0) return;
      if (dismissed.isConnected) restore(dismissed);
      dismissed = null;
    });
    document.addEventListener("pointerdown", down, { passive: true });
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", pointerCancel);
    return () => {
      const element = toast;
      reset();
      resume();
      if (element?.isConnected) restore(element);
      if (dismissed?.isConnected) restore(dismissed);
      unsubscribe();
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", pointerCancel);
    };
  }, [controller]);
}
