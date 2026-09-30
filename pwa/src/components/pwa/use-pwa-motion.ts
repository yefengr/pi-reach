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

export const pwaDrawerTransitions = {
  left: {
    in: { opacity: 1, transform: "translateX(0)", transitionTimingFunction: "var(--pwa-ease-enter)" },
    out: { opacity: 0, transform: "translateX(-100%)", transitionTimingFunction: "var(--pwa-ease-exit)" },
    transitionProperty: "opacity, transform",
  },
  right: {
    in: { opacity: 1, transform: "translateX(0)", transitionTimingFunction: "var(--pwa-ease-enter)" },
    out: { opacity: 0, transform: "translateX(100%)", transitionTimingFunction: "var(--pwa-ease-exit)" },
    transitionProperty: "opacity, transform",
  },
  bottom: {
    in: { opacity: 1, transform: "translateY(0)", transitionTimingFunction: "var(--pwa-ease-enter)" },
    out: { opacity: 0, transform: "translateY(100%)", transitionTimingFunction: "var(--pwa-ease-exit)" },
    transitionProperty: "opacity, transform",
  },
} satisfies Record<"left" | "right" | "bottom", MantineTransition>;

export function pwaOverlayEase(opened: boolean) {
  return { "--pwa-overlay-ease": opened ? "var(--pwa-ease-enter)" : "var(--pwa-ease-exit)" };
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
