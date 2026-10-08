import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { createSwipeDrag, type SwipeDrag } from "./swipe-drag";
import { pwaMotionShiftDisabled, usePwaMotionDuration } from "./use-pwa-motion";
import type { usePageTransition } from "./use-page-transition";
import type { SwipeDragHandlers } from "./use-swipe";
import type { SettingsRoute } from "@/lib/pwa/settings-route";

/** 提交后路由迟迟不变（popstate 丢失等）时撤销拖动并恢复设置页，避免卡死。 */
const COMMIT_GUARD_MS = 1000;
const PAGE_DURATION_FALLBACK_MS = 200;

type Phase = "idle" | "dragging" | "committed" | "rollback";

type WorkspaceDragOptions = {
  settingsRoute: SettingsRoute;
  transitioning: boolean;
  rootRef: RefObject<HTMLElement | null>;
  workspaceRef: RefObject<HTMLElement | null>;
  settingsRef: RefObject<HTMLElement | null>;
  pageTransition: ReturnType<typeof usePageTransition>;
  onSettingsBack: () => void;
  /** 来源为导航时预挂载导航（展开态，随工作区层移动）；回弹或超时后由 end 复位四项导航状态。 */
  beginNavigationPreview: (scrollTop: number) => void;
  endNavigationPreview: () => void;
};

/**
 * 设置页返回的跟手拖动（D4）：设置层与工作区层的暂停 WAAPI 动画随手指移动。
 * 提交时不自行收尾，而是调用原返回入口，路由变化后由 usePageTransition 从当前位置续播；
 * 回弹与保险超时才由本 hook 撤销动画。
 */
export function useWorkspaceDrag({ settingsRoute, transitioning, rootRef, workspaceRef, settingsRef, pageTransition, onSettingsBack, beginNavigationPreview, endNavigationPreview }: WorkspaceDragOptions) {
  const pageDuration = usePwaMotionDuration("--pwa-duration-page", PAGE_DURATION_FALLBACK_MS);
  const [dragging, setDragging] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [seenChange, setSeenChange] = useState(settingsRoute.change);
  // 路由变化即交给页面转场接管：工作区层由转场的 data-view-transition 继续揭示。
  if (seenChange !== settingsRoute.change) {
    setSeenChange(settingsRoute.change);
    setDragging(false);
    setPreviewing(false);
  }
  const latest = useRef({ routeOpen: settingsRoute.open, origin: settingsRoute.origin, transitioning, onSettingsBack, beginNavigationPreview, endNavigationPreview, pageDuration, pageTransition });
  // 须声明在 useSwipe 之前：同一次提交里 useSwipe 的 disabled 取消要读到最新路由。
  useLayoutEffect(() => {
    latest.current = { routeOpen: settingsRoute.open, origin: settingsRoute.origin, transitioning, onSettingsBack, beginNavigationPreview, endNavigationPreview, pageDuration, pageTransition };
  });
  const dragRef = useRef<SwipeDrag | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const previewedRef = useRef(false);
  const guardRef = useRef<number | null>(null);

  const clearGuard = useCallback(() => {
    if (guardRef.current === null) return;
    window.clearTimeout(guardRef.current);
    guardRef.current = null;
  }, []);
  const forget = useCallback(() => {
    clearGuard();
    dragRef.current = null;
    phaseRef.current = "idle";
    previewedRef.current = false;
  }, [clearGuard]);
  // 路由一旦变化，本次拖动的生命周期即结束（成功返回或外部返回），动画由页面转场接管。
  useEffect(() => { forget(); }, [settingsRoute.change, forget]);
  useEffect(() => () => { clearGuard(); }, [clearGuard]);

  /** 设置页仍打开时放弃本次拖动：先恢复静止态，再撤销动画，设置层始终盖住工作区层。 */
  const abandon = useCallback(() => {
    const previewed = previewedRef.current;
    flushSync(() => {
      setDragging(false);
      setPreviewing(false);
      if (previewed) latest.current.endNavigationPreview();
    });
    latest.current.pageTransition.endDrag();
    forget();
  }, [forget]);
  const rollBack = useCallback((drag: SwipeDrag) => {
    phaseRef.current = "rollback";
    void drag.settle(false).then((finished) => {
      if (dragRef.current !== drag) return;
      // 被路由变化接管（转场已 dispose 拖动）时只复位自身状态。
      if (finished && latest.current.routeOpen) abandon();
      else forget();
    });
  }, [abandon, forget]);

  const handlers = useMemo<SwipeDragHandlers>(() => ({
    start() {
      const { routeOpen, origin, transitioning: busy, beginNavigationPreview: preview, pageTransition: transition } = latest.current;
      const root = rootRef.current;
      const workspace = workspaceRef.current;
      const settings = settingsRef.current;
      if (!routeOpen || busy || phaseRef.current !== "idle" || !root || !workspace || !settings || pwaMotionShiftDisabled(root)) return false;
      const width = () => root.clientWidth;
      const full = latest.current.pageDuration;
      // 拖动开始就揭示工作区层，暂停动画在同一任务内创建，首帧工作区位于 -width。
      const navigationScrollTop = origin?.kind === "navigation" && window.matchMedia("(max-width: 767.98px)").matches ? origin.scrollTop : null;
      flushSync(() => {
        setDragging(true);
        if (navigationScrollTop === null) return;
        previewedRef.current = true;
        setPreviewing(true);
        preview(navigationScrollTop);
      });
      const drag = createSwipeDrag({
        targets: [
          { element: workspace, frame: (progress) => ({ transform: `translateX(${-width() * (1 - progress)}px)` }) },
          { element: settings, frame: (progress) => ({ transform: `translateX(${width() * progress}px)` }) },
        ],
        extent: width,
        duration: () => full,
      });
      dragRef.current = drag;
      phaseRef.current = "dragging";
      transition.beginDrag(drag);
      return true;
    },
    move(distance) {
      if (phaseRef.current === "dragging") dragRef.current?.setDistance(distance);
    },
    end({ committed, velocity }) {
      const drag = dragRef.current;
      if (!drag || phaseRef.current !== "dragging") return;
      // 松手前设置页已被外部返回：路由转场已接管动画，不再重复返回。
      if (!latest.current.routeOpen) { forget(); return; }
      if (!committed) { rollBack(drag); return; }
      phaseRef.current = "committed";
      latest.current.pageTransition.handOff(velocity);
      guardRef.current = window.setTimeout(() => {
        guardRef.current = null;
        if (phaseRef.current === "committed" && latest.current.routeOpen) abandon();
      }, COMMIT_GUARD_MS);
      latest.current.onSettingsBack();
    },
    cancel() {
      const drag = dragRef.current;
      if (!drag || phaseRef.current !== "dragging") return;
      // 取消原因不代表路由状态：只按实际路由判断。已返回时由页面转场接管，仍打开才回弹。
      if (latest.current.routeOpen) rollBack(drag);
      else forget();
    },
  }), [abandon, forget, rollBack, rootRef, settingsRef, workspaceRef]);

  const canSwipe = useCallback(() => phaseRef.current === "idle" || phaseRef.current === "dragging", []);
  return { drag: handlers, canSwipe, dragging, previewing };
}
