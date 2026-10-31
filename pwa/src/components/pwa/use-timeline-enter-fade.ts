import { useLayoutEffect, useRef, type RefObject } from "react";
import { pwaContentEasing, usePwaMotionDuration } from "./use-pwa-motion";

/** 内容接管骨架时的起始可见度：骨架在同一帧卸载，从 0 起步会出现完全空白的一帧。 */
const CONTENT_ENTER_OPACITY = 0.35;

/**
 * 会话内容在加载中的空列表里首次出现时整体淡入，切换 Pi 后新内容不再硬切；
 * 骨架在内容到达的同一帧卸载，因此淡入从约 1/3 可见度起始，避免交接处出现全空帧。
 * 已有内容的增量更新、空会话里发出首条消息都不重播。时长取 --pwa-duration-content，减少动态效果时缩短为通用淡化。
 */
export function useTimelineEnterFade(listRef: RefObject<HTMLElement | null>, empty: boolean, loading: boolean) {
  const duration = usePwaMotionDuration("--pwa-duration-content");
  const awaitingRef = useRef(false);
  useLayoutEffect(() => {
    if (empty) {
      awaitingRef.current = loading;
      return;
    }
    if (!awaitingRef.current) return;
    awaitingRef.current = false;
    const list = listRef.current;
    if (!list || typeof list.animate !== "function") return;
    list.animate([{ opacity: CONTENT_ENTER_OPACITY }, { opacity: 1 }], { duration, easing: pwaContentEasing(list) });
  }, [duration, empty, listRef, loading]);
}
