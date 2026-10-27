import { useEffect, useState } from "react";
import { usePwaMotionDuration } from "./use-pwa-motion";

export type Presence<T> = {
  /** 要渲染的值：显示中为当前值，离开期间为消失前的最后一个值；完全移除后为 null。 */
  rendered: T | null;
  /** 正在淡出：调用方据此设置 `data-presence="leaving"`、`inert` 与 `aria-hidden`。 */
  leaving: boolean;
};

/**
 * 浮动入口与局部提示的进出（DESIGN「动效」）：value 变为 null 后继续保留最后一个值，
 * 等 `--pwa-duration-fade` 的淡出结束再移除，淡出期间文字不会跳成别的状态。
 * 出现由 CSS `@starting-style` 负责，不需要额外渲染一帧；离开中又重新出现时直接取消移除，
 * 过渡从当前透明度反向。same 判断显示中的值是否变化，变化时原位更新、不重播动画。
 */
export function usePresence<T>(value: T | null, same: (left: T, right: T) => boolean = Object.is): Presence<T> {
  const exitMs = usePwaMotionDuration("--pwa-duration-fade");
  const [retained, setRetained] = useState<T | null>(value);
  // 渲染期同步显示中的值（派生状态写法）：避免多一帧旧值，也不在 effect 里触发额外提交。
  if (value !== null && (retained === null || !same(retained, value))) setRetained(value);
  const leaving = value === null && retained !== null;
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setRetained(null), exitMs);
    return () => window.clearTimeout(timer);
  }, [exitMs, leaving]);
  return { rendered: value ?? retained, leaving };
}

/** 离开中的元素：淡出期间不可点击、不可聚焦，也不再被读屏播报。 */
export function presenceProps(presence: Presence<unknown>) {
  return presence.leaving ? { "data-presence": "leaving", inert: true, "aria-hidden": true } as const : {};
}
