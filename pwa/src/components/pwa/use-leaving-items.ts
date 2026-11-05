import { useEffect, useState } from "react";
import { usePwaMotionDuration } from "./use-pwa-motion";

/**
 * 离开的元素当场脱离布局：按当前位置改为绝对定位，布局高度一次收回，副本在原位完成离开动画（DESIGN「输入区内的增减」）。
 * 包含块取元素当前的 offsetParent，与切换为绝对定位后的包含块一致；anchor 为 bottom 时按下沿定位（排队抽屉贴着卡片，
 * 输入区后续收缩时仍压在卡片后方），否则按 offsetLeft／offsetTop 定位，在滚动容器内随内容滚动。
 */
export function detachInPlace(element: HTMLElement | null, anchor: "bottom" | "top" = "top") {
  const parent = element?.offsetParent;
  if (!element || !(parent instanceof HTMLElement) || element.dataset.detached !== undefined) return;
  const box = element.getBoundingClientRect();
  const host = parent.getBoundingClientRect();
  element.dataset.detached = "";
  Object.assign(element.style, {
    position: "absolute", margin: "0", width: `${box.width}px`,
    ...(anchor === "bottom"
      ? { left: `${box.left - host.left}px`, bottom: `${host.bottom - box.bottom}px` }
      : { left: `${element.offsetLeft}px`, top: `${element.offsetTop}px` }),
  });
}

export type LeavingItem<T> = { item: T; index: number };

/**
 * 列表内单项的离开：比较上一批条目，保留刚离开的项及其原位置，等 fade 结束后移除；列表整体清空时不保留，
 * 由容器自身的离开方式承担。调用方把离开项交给 withLeavingItems 插回原位，并在离开项上脱离布局、播放淡出。
 */
export function useLeavingItems<T extends { id: string }>(items: readonly T[]): LeavingItem<T>[] {
  const fadeMs = usePwaMotionDuration("--pwa-duration-fade");
  const [previous, setPrevious] = useState(items);
  const [leaving, setLeaving] = useState<LeavingItem<T>[]>([]);
  if (previous !== items) {
    // 渲染期派生（与 usePresence 同一写法）：只在条目引用变化时比较一次。
    const ids = new Set(items.map((item) => item.id));
    const gone = items.length ? previous.flatMap((item, index) => ids.has(item.id) ? [] : [{ item, index }]) : [];
    setPrevious(items);
    setLeaving((current) => [...current.filter((entry) => !ids.has(entry.item.id)), ...gone]);
  }
  useEffect(() => {
    if (!leaving.length) return;
    const timer = window.setTimeout(() => setLeaving([]), fadeMs);
    return () => window.clearTimeout(timer);
  }, [fadeMs, leaving]);
  return leaving;
}

/** 把离开项按原位置插回，供原位淡出；index 为离开前的位置。 */
export function withLeavingItems<T>(items: readonly T[], leaving: readonly LeavingItem<T>[]) {
  const entries = items.map((item, index) => ({ item, index, leaving: false }));
  for (const entry of [...leaving].sort((a, b) => a.index - b.index)) entries.splice(Math.min(entry.index, entries.length), 0, { ...entry, leaving: true });
  return entries;
}
