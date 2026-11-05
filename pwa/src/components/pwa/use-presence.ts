import { useEffect, useEffectEvent, useState } from "react";
import { usePwaMotionDuration } from "./use-pwa-motion";
import type { PwaMotionDurationToken } from "@/lib/ui/motion-duration";

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
type PresenceOptions = {
  /** 离开时长，默认 fade；排队抽屉等带位移的离开传入对应 token，与 CSS 过渡同长。 */
  exit?: PwaMotionDurationToken;
  /** 离开开始时返回 true 则立即移除、不保留副本，用于发送过渡等已由其他时钟收回高度的场景。 */
  skipExit?: () => boolean;
};

export function usePresence<T>(value: T | null, same: (left: T, right: T) => boolean = Object.is, { exit = "--pwa-duration-fade", skipExit }: PresenceOptions = {}): Presence<T> {
  const exitMs = usePwaMotionDuration(exit);
  const [retained, setRetained] = useState<T | null>(value);
  // 渲染期同步显示中的值（派生状态写法）：避免多一帧旧值，也不在 effect 里触发额外提交。
  if (value !== null && (retained === null || !same(retained, value))) setRetained(value);
  const leaving = value === null && retained !== null;
  // 回调每次渲染可能重建，只在离开开始时读取一次，不作为 effect 依赖。
  const shouldSkipExit = useEffectEvent(() => skipExit?.() ?? false);
  useEffect(() => {
    if (!leaving) return;
    // 跳过离开时在下一个任务移除；这一帧由调用方的 CSS 隐藏副本。
    const timer = window.setTimeout(() => setRetained(null), shouldSkipExit() ? 0 : exitMs);
    return () => window.clearTimeout(timer);
  }, [exitMs, leaving]);
  return { rendered: value ?? retained, leaving };
}

/** 离开中的元素：淡出期间不可点击、不可聚焦，也不再被读屏播报。 */
export function presenceProps(presence: Presence<unknown>) {
  return presence.leaving ? { "data-presence": "leaving", inert: true, "aria-hidden": true } as const : {};
}

/**
 * 输入区内的离开副本：离开开始时若外层 footer 正处在本端发送过渡（data-own-send），立即隐藏并跳过离开动画。
 * hidden 保持到移除，过渡先结束时副本也不会重新占位；供 usePresence 的 skipExit 使用。
 */
export function hideDuringOwnSend(element: HTMLElement | null): boolean {
  if (!element?.closest("[data-own-send]")) return false;
  element.hidden = true;
  return true;
}
