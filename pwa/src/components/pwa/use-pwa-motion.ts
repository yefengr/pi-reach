import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "@mantine/hooks";
import type { MantineTransition } from "@mantine/core";
import { readPwaMotionDuration, type PwaMotionDurationToken } from "@/lib/ui/motion-duration";

/** Mantine 的过渡需要数字时长；订阅偏好变化，取全局媒体查询计算出的时长 token。 */
export function usePwaMotionDuration(variable: PwaMotionDurationToken): number {
  useReducedMotion(); // 触发 React 重渲染，数值仍以 CSS 中的规则为准。
  return readPwaMotionDuration(variable);
}

// 读取计算样式的公共函数在 lib/ui/motion，lib/pwa 也要用；组件侧沿用本入口。
export { pwaContentEasing, pwaMotionShiftDisabled, pwaReleaseEasing, pwaStandardEasing } from "@/lib/ui/motion";

// Mantine 在 transitionProps.timingFunction 之上合并 in/out；reduce 的 CSS !important 会统一覆盖为 standard。
export const pwaFadeTransition = {
  in: { opacity: 1, transitionTimingFunction: "var(--pwa-ease-enter)" },
  out: { opacity: 0, pointerEvents: "none", transitionTimingFunction: "var(--pwa-ease-exit)" },
  transitionProperty: "opacity",
} as MantineTransition;

/**
 * 菜单与 Popover 以触发按钮为原点缩放展开（原点由实际 data-position 推导，见 pwa-controls.css），离开时缩回按钮。
 * 缩放只在进出的一瞬间发生，静止时命中区为完整尺寸；减少动态效果时 --pwa-motion-shift 为 0，只剩淡化。
 */
export const pwaMenuTransition = {
  in: { opacity: 1, transform: "scale(1)", transitionTimingFunction: "var(--pwa-ease-content)" },
  out: {
    opacity: 0,
    transform: "scale(calc(1 - (1 - var(--pwa-menu-scale)) * var(--pwa-motion-shift, 1)))",
    pointerEvents: "none",
    transitionTimingFunction: "var(--pwa-ease-exit)",
  },
  transitionProperty: "opacity, transform",
} as MantineTransition;

export function usePwaMenuTransition() {
  const duration = usePwaMotionDuration("--pwa-duration-menu-in");
  const exitDuration = usePwaMotionDuration("--pwa-duration-menu-out");
  return { transition: pwaMenuTransition, duration, exitDuration };
}

/** Drawer 与设置页转场一致：面板全程不透明的纯位移；减少动态效果时 --pwa-motion-shift 为 0，位移消失并改为淡化。 */
const drawerSlide = (axis: "X" | "Y", sign: "" | "-"): MantineTransition => ({
  in: { opacity: 1, transform: `translate${axis}(0)` },
  out: { opacity: "var(--pwa-motion-shift, 1)", transform: `translate${axis}(calc(${sign}100% * var(--pwa-motion-shift, 1)))` },
  // 减少动态效果的全局规则会把属性改写为 opacity 等，位移属性只在常规动效下生效。
  transitionProperty: "transform, opacity",
} as MantineTransition);

/** 曲线与时长由 Drawer 的 transitionProps 统一提供（内容曲线、--pwa-duration-drawer／drawer-out），遮罩沿用同一组值。 */
export const pwaDrawerTransitions = {
  left: drawerSlide("X", "-"),
  right: drawerSlide("X", ""),
  bottom: drawerSlide("Y", ""),
} satisfies Record<"left" | "right" | "bottom", MantineTransition>;

export const PWA_DRAWER_EASE = "var(--pwa-ease-content)";

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
