import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { createSwipeDrag, type SwipeDrag } from "./swipe-drag";
import { pwaMotionShiftDisabled, usePwaMotionDuration } from "./use-pwa-motion";
import type { SwipeDragHandlers } from "./use-swipe";

const SHEET_SELECTOR = ".pwa-session-sheet";
const TRIGGER_SELECTOR = ".pwa-session-trigger";

/**
 * dragging：预览态（进入即时、无焦点陷阱与滚动锁、content 带 data-swipe-drag），期间无论业务 sheetOpen 如何都保持显示，
 * 由 WAAPI 自己走到关闭起点后再关闭；rollback：走到起点后的即时关闭，不回焦。
 *
 * 不依赖 Mantine 的退出过渡接续：进入时长为 0 的 Drawer 在之后的非零退出开始时会重挂载内容，
 * 暂停动画所在的元素随之被替换，外部关闭时面板会从 0 重新滑出。
 */
export type NavigationGesture = "dragging" | "rollback";
type Phase = "idle" | "dragging" | "opening" | "rollback";

type NavigationDragOptions = {
  rootRef: RefObject<HTMLElement | null>;
  mainElement: HTMLElement | null;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  /** 与触发按钮点击相同的打开入口，焦点来源固定为主区的 .pwa-session-trigger。 */
  openNavigation: (origin: HTMLElement | null) => void;
};

/**
 * 移动导航打开的跟手拖动（D5）。开始时同步挂载并打开导航，暂停的 WAAPI 动画把内容与遮罩压在屏幕外起点，
 * 随手指移动；松手后提交（走到打开终点再启用焦点陷阱与滚动锁）或回弹（回到起点后即时关闭，不动焦点）。
 */
export function useNavigationDrag({ rootRef, mainElement, sheetOpen, setSheetOpen, openNavigation }: NavigationDragOptions) {
  const duration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const [gesture, setGesture] = useState<NavigationGesture | null>(null);
  const latest = useRef({ sheetOpen, setSheetOpen, openNavigation, mainElement, duration });
  useLayoutEffect(() => {
    latest.current = { sheetOpen, setSheetOpen, openNavigation, mainElement, duration };
  });
  const dragRef = useRef<SwipeDrag | null>(null);
  const phaseRef = useRef<Phase>("idle");
  // 拖动中被外部关闭：手势作废，其后续 move 与 end 都不得再打开导航。
  const voidRef = useRef(false);

  const release = useCallback(() => {
    dragRef.current?.dispose();
    dragRef.current = null;
    phaseRef.current = "idle";
    voidRef.current = false;
    setGesture(null);
  }, []);

  /** WAAPI 已在关闭起点：撤销预览态并即时关闭（仍打开时同一更新里关闭业务状态）；Drawer 即时卸载后由 onExitTransitionEnd 收尾。 */
  const closeAtStart = useCallback(() => {
    flushSync(() => {
      setGesture("rollback");
      if (latest.current.sheetOpen) latest.current.setSheetOpen(false);
    });
    // 退出时长为 0 时过渡回调已同步触发；仍挂载时等待它收尾。
    if (!document.querySelector(SHEET_SELECTOR)) release();
  }, [release]);

  const rollBack = useCallback((drag: SwipeDrag) => {
    phaseRef.current = "rollback";
    void drag.settle(false).then((finished) => {
      if (finished && dragRef.current === drag) closeAtStart();
    });
  }, [closeAtStart]);

  const commit = useCallback((drag: SwipeDrag, velocity: number) => {
    phaseRef.current = "opening";
    void drag.settle(true, velocity).then((finished) => {
      // 被外部关闭中止（settle 被替换）或卸载时，旧收尾不得提交打开态。
      if (!finished || dragRef.current !== drag || !latest.current.sheetOpen) return;
      // 清除预览：焦点陷阱与滚动锁随之启用，初始焦点按现有规则进入导航；静止态提交后再撤销 WAAPI。
      flushSync(() => setGesture(null));
      release();
    });
  }, [release]);

  // 外部关闭（重命名、切到桌面宽度等）：Drawer 因预览态保持显示，WAAPI 从当前位置走回关闭起点后再即时关闭，不再调用关闭入口。
  useLayoutEffect(() => {
    const drag = dragRef.current;
    if (sheetOpen || !drag) return;
    if (phaseRef.current !== "dragging" && phaseRef.current !== "opening") return;
    voidRef.current = true;
    phaseRef.current = "rollback";
    void drag.settle(false).then((finished) => {
      if (finished && dragRef.current === drag) closeAtStart();
    });
  }, [sheetOpen, closeAtStart]);

  // 清理兜底：组件卸载时撤销动画。
  useEffect(() => () => { dragRef.current?.dispose(); }, []);

  const handlers = useMemo<SwipeDragHandlers>(() => ({
    start() {
      const root = rootRef.current;
      const { sheetOpen: isOpen, mainElement: main, openNavigation: open, duration: full } = latest.current;
      if (!root || !main || isOpen || phaseRef.current !== "idle" || pwaMotionShiftDisabled(root)) return false;
      // 上一次关闭的退出过渡尚未结束时不抢占，退回触发式。
      if (document.querySelector(SHEET_SELECTOR)) return false;
      flushSync(() => {
        setGesture("dragging");
        open(main.querySelector<HTMLElement>(TRIGGER_SELECTOR));
      });
      const sheet = root.querySelector<HTMLElement>(SHEET_SELECTOR);
      if (!sheet) {
        flushSync(() => {
          setGesture(null);
          latest.current.setSheetOpen(false);
        });
        return false;
      }
      const scrim = sheet.closest(".mantine-Drawer-root")?.querySelector<HTMLElement>(".pwa-scrim");
      const width = () => sheet.offsetWidth;
      dragRef.current = createSwipeDrag({
        targets: [
          { element: sheet, frame: (progress) => ({ transform: `translateX(${-(1 - progress) * width()}px)` }) },
          ...(scrim ? [{ element: scrim, frame: (progress: number) => ({ opacity: progress }) }] : []),
        ],
        extent: width,
        duration: () => full,
      });
      phaseRef.current = "dragging";
      voidRef.current = false;
      return true;
    },
    move(distance) {
      if (phaseRef.current === "dragging" && !voidRef.current) dragRef.current?.setDistance(distance);
    },
    end({ committed, velocity }) {
      const drag = dragRef.current;
      if (!drag || phaseRef.current !== "dragging") return;
      // 外部关闭已使手势作废：不提交、不再打开；关闭过渡结束时收尾。
      if (voidRef.current || !latest.current.sheetOpen) return;
      if (committed) commit(drag, velocity);
      else rollBack(drag);
    },
    cancel() {
      const drag = dragRef.current;
      if (!drag || phaseRef.current !== "dragging" || voidRef.current) return;
      // 取消原因不代表导航状态：仍打开（被我们打开）才回弹；已被外部关闭时由上面的 effect 接管。
      if (latest.current.sheetOpen) rollBack(drag);
    },
  }), [commit, rollBack, rootRef]);

  const canSwipe = useCallback(() => phaseRef.current === "idle" || phaseRef.current === "dragging", []);
  return { drag: handlers, canSwipe, gesture, onExitTransitionEnd: release };
}
