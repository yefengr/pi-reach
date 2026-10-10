import { useLayoutEffect, useRef, type RefObject } from "react";
import { pwaStandardEasing, usePwaMotionDuration } from "./use-pwa-motion";

const FADE_DURATION_MS = 120;

/**
 * 会话内容在加载中的空列表里首次出现时整体淡入，切换 Pi 后新内容不再硬切；
 * 已有内容的增量更新、空会话里发出首条消息都不重播。时长取 --pwa-duration-fade，减少动态效果时同样保留这段短淡化。
 */
export function useTimelineEnterFade(listRef: RefObject<HTMLElement | null>, empty: boolean, loading: boolean) {
  const duration = usePwaMotionDuration("--pwa-duration-fade", FADE_DURATION_MS);
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
    list.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: pwaStandardEasing(list) });
  }, [duration, empty, listRef, loading]);
}
