import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createSwipeDrag, type SwipeDrag } from "./swipe-drag";
import type { SwipeDragHandlers } from "./use-swipe";
import { pwaMotionShiftDisabled, usePwaMotionDuration } from "./use-pwa-motion";

type Phase = "idle" | "dragging" | "settling";

/** 跟手拖动到收尾结束期间标在 Drawer 表面上，供样式显示移动中的圆角等外观。 */
export const DRAWER_DRAGGING_ATTRIBUTE = "data-pwa-dragging";

type DrawerSwipeCloseOptions = {
  /** Drawer.Content；Drawer 关闭卸载后为 null。 */
  surface: HTMLElement | null;
  opened: boolean;
  /** 关闭方向：右侧抽屉向右（1），左侧抽屉向左（-1）。 */
  direction: 1 | -1;
  /** 现有关闭入口（同步门禁，可能不关闭）；结果以提交后的 opened 为准，不看返回值。 */
  requestClose: () => void;
  /** 使本次关闭的退出时长为 0；收尾到终点时 WAAPI 已把面板移出屏幕。 */
  skipExit: () => void;
  /** 只撤销手势专用的即时退出标记。 */
  resetSkipExit: () => void;
};

/**
 * Drawer 向外滑动关闭的跟手控制器（D1–D3）。拖动期间不改 React 状态，由暂停的 WAAPI 动画跟随手指；
 * 松手后收尾到终点再调用关闭入口一次，并在该次更新提交后根据 opened 判断接受或被门禁拒绝（拒绝则回弹）。
 */
export function useDrawerSwipeClose({ surface, opened, direction, requestClose, skipExit, resetSkipExit }: DrawerSwipeCloseOptions): { drag: SwipeDragHandlers; canSwipe: () => boolean } {
  const duration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const latest = useRef({ surface, opened, requestClose, skipExit, resetSkipExit, duration });
  const dragRef = useRef<SwipeDrag | null>(null);
  const draggedSurfaceRef = useRef<HTMLElement | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const pendingRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const previousOpenedRef = useRef(opened);
  const [requestSeq, setRequestSeq] = useState(0);
  useLayoutEffect(() => {
    latest.current = { surface, opened, requestClose, skipExit, resetSkipExit, duration };
  });

  const release = useCallback((drag: SwipeDrag) => {
    drag.dispose();
    if (dragRef.current !== drag) return;
    dragRef.current = null;
    draggedSurfaceRef.current?.removeAttribute(DRAWER_DRAGGING_ATTRIBUTE);
    draggedSurfaceRef.current = null;
    phaseRef.current = "idle";
    pendingRef.current = null;
  }, []);
  const rollBack = useCallback((drag: SwipeDrag) => {
    phaseRef.current = "settling";
    void drag.settle(false).then((finished) => { if (finished) release(drag); });
  }, [release]);

  // 外部关闭与关闭请求的结果都在提交后判断：此时 opened 反映了真实的表面状态。
  useLayoutEffect(() => {
    const reopened = !previousOpenedRef.current && opened;
    previousOpenedRef.current = opened;
    const drag = dragRef.current;
    if (!drag) return;
    if (reopened) {
      // 退出尚未卸载时可在同一表面重开；旧 WAAPI 末帧与收尾回调不能进入新打开周期。
      release(drag);
      latest.current.resetSkipExit();
      return;
    }
    if (pendingRef.current !== null && pendingRef.current === requestSeq) {
      pendingRef.current = null;
      if (!opened) return; // 接受：Drawer 即时退出，卸载后由 surface 清理。
      latest.current.resetSkipExit();
      rollBack(drag);
      return;
    }
    if (!opened && pendingRef.current === null) {
      // 按钮、Escape、popstate 等外部关闭：从当前位置走到关闭终点，不再调用关闭入口。
      phaseRef.current = "settling";
      void drag.settle(true);
    }
  }, [opened, requestSeq, release, rollBack]);

  // 表面卸载（含系统原生转场的立即关闭）后不再有可动画的元素。
  useLayoutEffect(() => () => {
    if (dragRef.current) release(dragRef.current);
  }, [surface, release]);

  const commit = useCallback((drag: SwipeDrag, velocity: number) => {
    phaseRef.current = "settling";
    void drag.settle(true, velocity).then((finished) => {
      // 被外部关闭、重新 settle 或卸载中止时，旧收尾不得再调用关闭入口。
      if (!finished || dragRef.current !== drag || !latest.current.opened) return;
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      pendingRef.current = seq;
      latest.current.skipExit();
      setRequestSeq(seq);
      latest.current.requestClose();
    });
  }, []);

  const handlers = useMemo<SwipeDragHandlers>(() => ({
    start() {
      const { surface: element, opened: isOpen, duration: full } = latest.current;
      if (!element || !isOpen || dragRef.current || phaseRef.current !== "idle" || pwaMotionShiftDisabled(element)) return false;
      const overlay = element.closest(".mantine-Drawer-root")?.querySelector<HTMLElement>(".pwa-scrim");
      const width = () => element.offsetWidth;
      dragRef.current = createSwipeDrag({
        targets: [
          { element, frame: (progress) => ({ transform: `translateX(${direction * progress * width()}px)` }) },
          ...(overlay ? [{ element: overlay, frame: (progress: number) => ({ opacity: 1 - progress }) }] : []),
        ],
        extent: width,
        duration: () => full,
      });
      element.setAttribute(DRAWER_DRAGGING_ATTRIBUTE, "");
      draggedSurfaceRef.current = element;
      phaseRef.current = "dragging";
      return true;
    },
    move(distance) {
      if (phaseRef.current === "dragging") dragRef.current?.setDistance(distance);
    },
    end({ committed, velocity }) {
      const drag = dragRef.current;
      if (!drag || phaseRef.current !== "dragging") return;
      if (!latest.current.opened) { phaseRef.current = "settling"; void drag.settle(true, velocity); return; }
      if (committed) commit(drag, velocity);
      else rollBack(drag);
    },
    cancel() {
      const drag = dragRef.current;
      if (!drag || phaseRef.current !== "dragging") return;
      // 取消原因不代表表面状态：仍打开则回弹；已被外部关闭时由上面的 effect 接管。
      if (latest.current.opened) rollBack(drag);
      else { phaseRef.current = "settling"; void drag.settle(true); }
    },
  }), [commit, direction, rollBack]);

  const canSwipe = useCallback(() => phaseRef.current !== "settling", []);
  return { drag: handlers, canSwipe };
}
