import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "@mantine/hooks";
import type { MantineTransition } from "@mantine/core";

/** Mantine 的过渡需要数字时长；订阅偏好变化，取全局媒体查询计算出的时长 token。 */
export function usePwaMotionDuration(variable: `--pwa-duration-${string}`, fallback: number): number {
  useReducedMotion(); // 触发 React 重渲染，数值仍以 CSS 中的规则为准。
  if (typeof document === "undefined") return fallback;
  const style = getComputedStyle(document.documentElement);
  let value = style.getPropertyValue(variable).trim();
  // getPropertyValue(custom-property) 返回原始 var(...)，须沿 token 引用解析到最终时长。
  for (let depth = 0; depth < 4; depth += 1) {
    const reference = /^var\((--pwa-duration-[\w-]+)\)$/.exec(value);
    if (!reference) break;
    value = style.getPropertyValue(reference[1]).trim();
  }
  const duration = Number.parseFloat(value);
  return value.endsWith("ms") && Number.isFinite(duration) ? duration : fallback;
}

// Mantine 在 transitionProps.timingFunction 之上合并 in/out；reduce 的 CSS !important 会统一覆盖为 standard。
export const pwaFadeTransition = {
  in: { opacity: 1, transitionTimingFunction: "var(--pwa-ease-enter)" },
  out: { opacity: 0, pointerEvents: "none", transitionTimingFunction: "var(--pwa-ease-exit)" },
  transitionProperty: "opacity",
} as MantineTransition;

/** Drawer 与设置页转场一致：面板全程不透明的纯位移；减少动态效果时 --pwa-motion-shift 为 0，位移消失并改为淡化。 */
const drawerSlide = (axis: "X" | "Y", sign: "" | "-"): MantineTransition => ({
  in: { opacity: 1, transform: `translate${axis}(0)` },
  out: { opacity: "var(--pwa-motion-shift, 1)", transform: `translate${axis}(calc(${sign}100% * var(--pwa-motion-shift, 1)))` },
  // 减少动态效果的全局规则会把属性改写为 opacity 等，位移属性只在常规动效下生效。
  transitionProperty: "transform, opacity",
} as MantineTransition);

/** 曲线与时长由 Drawer 的 transitionProps 统一提供（标准曲线、--pwa-duration-drawer），遮罩沿用同一组值。 */
export const pwaDrawerTransitions = {
  left: drawerSlide("X", "-"),
  right: drawerSlide("X", ""),
  bottom: drawerSlide("Y", ""),
} satisfies Record<"left" | "right" | "bottom", MantineTransition>;

export const PWA_DRAWER_EASE = "var(--pwa-ease-standard)";

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
