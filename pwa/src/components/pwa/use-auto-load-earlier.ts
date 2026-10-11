import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** 距离列表顶部不超过此距离时提前加载更早的记录，上滑到顶前内容通常已经接上。 */
export const AUTO_LOAD_EARLIER_THRESHOLD_PX = 400;
const SCROLLABLE_EPSILON = 1;

type AutoLoadEarlierOptions = {
  listRef: RefObject<HTMLDivElement | null>;
  /** 有更早记录、当前未在加载、也没有失败待重试时为 true。 */
  enabled: boolean;
  /** 内容或加载状态变化后重新判断；传入随渲染内容变化的值。 */
  contentVersion: unknown;
  onLoad: () => void;
};

/**
 * 阅读位置接近顶部时自动加载更早的记录。
 * 内容不足一屏时也补一页，但只有上次补页让内容变高才继续，避免整页都是隐藏记录时一路拉完整个会话。
 * 返回值供列表的 scroll 事件调用；程序滚动同样会触发，判断条件本身保证不会重复请求。
 */
export function useAutoLoadEarlier({ listRef, enabled, contentVersion, onLoad }: AutoLoadEarlierOptions): () => void {
  const enabledRef = useRef(enabled);
  const onLoadRef = useRef(onLoad);
  const fillHeightRef = useRef<number | null>(null);
  // 每次渲染重新同步：触发后暂时关闭，等父组件以新的 loading、内容或状态重新渲染后再允许。
  useLayoutEffect(() => {
    enabledRef.current = enabled;
    onLoadRef.current = onLoad;
  });

  const check = useCallback(() => {
    const list = listRef.current;
    if (!enabledRef.current || !list || list.scrollTop > AUTO_LOAD_EARLIER_THRESHOLD_PX) return;
    const scrollable = list.scrollHeight - list.clientHeight > SCROLLABLE_EPSILON;
    if (scrollable) {
      fillHeightRef.current = null;
    } else {
      if (fillHeightRef.current === list.scrollHeight) return;
      fillHeightRef.current = list.scrollHeight;
    }
    // 先关闭再调用，同一帧内的 scroll 与重判不会重复请求；父组件随后以 loading 或新内容更新 enabled。
    enabledRef.current = false;
    onLoadRef.current();
  }, [listRef]);

  useEffect(() => {
    if (!enabled) return;
    // 推迟到下一帧：贴底、锚点恢复等定位在布局后完成，按定位后的位置判断。
    const frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [check, contentVersion, enabled]);

  return check;
}
