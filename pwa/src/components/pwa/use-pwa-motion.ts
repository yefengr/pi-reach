import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePwaMotionDuration as useDuration } from "@yefengr/pwa-foundation";
import { PWA_MOTION_FALLBACK_MS, type PwaMotionDurationToken } from "@/lib/ui/motion-duration";
export { pwaFadeTransition, pwaMenuTransition, usePwaMenuTransition, pwaDrawerTransitions, PWA_DRAWER_EASE } from "@yefengr/pwa-foundation/mantine";

/** Mantine 的过渡需要数字时长；订阅偏好变化，取全局媒体查询计算出的时长 token。 */
export function usePwaMotionDuration(variable: PwaMotionDurationToken): number {
  return useDuration(variable, PWA_MOTION_FALLBACK_MS[variable]);
}

// 读取计算样式的公共函数在 lib/ui/motion，lib/pwa 也要用；组件侧沿用本入口。
export { pwaContentEasing, pwaMotionShiftDisabled, pwaReleaseEasing, pwaStandardEasing } from "@/lib/ui/motion";

/**
 * Drawer 是否正在进出：打开后到进入转场结束、以及关闭到卸载之间为 true。
 * 全屏面板只在移动中显示朝向下层的圆角，静止铺满时不在角上露出下层界面。
 */
export function useDrawerMoving(opened: boolean): { moving: boolean; onEnterTransitionEnd: () => void } {
  // Mantine 在挂载时已打开的 Drawer 直接处于进入完成态，不播放进入转场，也不回调。
  const [settled, setSettled] = useState(opened);
  const [previous, setPrevious] = useState(opened);
  // 每次打开或关闭都重新等待进入转场结束；在渲染中重置，避免先以旧的静止态渲染一帧。
  if (previous !== opened) {
    setPrevious(opened);
    setSettled(false);
  }
  const onEnterTransitionEnd = useCallback(() => setSettled(true), []);
  return { moving: !opened || !settled, onEnterTransitionEnd };
}

/** 菜单的业务动作在退出卸载后交接，避免仍在退出的 Menu 挡住随后的确认框。 */
export function useMenuExitAction() {
  const pendingRef = useRef<(() => void) | null>(null);
  const [revision, setRevision] = useState(0);

  const takePending = useCallback(() => {
    const action = pendingRef.current;
    pendingRef.current = null;
    action?.();
  }, []);

  const finish = useCallback(() => {
    if (!pendingRef.current) return;
    // Mantine 调用 onExitTransitionEnd 后才 setStatus(exited)，此刻 Dropdown 仍在 DOM。
    // 先提交一次 state，让卸载与业务动作在同一批提交后按顺序完成，避免退出中的菜单挡住确认框。
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    if (revision === 0) return;
    takePending();
  }, [revision, takePending]);

  useEffect(() => () => {
    // 父级条件卸载时不会触发 onExitTransitionEnd，仍须保证动作恰好交接一次。
    if (pendingRef.current) queueMicrotask(takePending);
  }, [takePending]);

  const queue = useCallback((action: () => void) => {
    if (pendingRef.current) return;
    pendingRef.current = action;
  }, []);
  const hasPending = useCallback(() => pendingRef.current !== null, []);
  return useMemo(() => ({ queue, finish, hasPending }), [queue, finish, hasPending]);
}
