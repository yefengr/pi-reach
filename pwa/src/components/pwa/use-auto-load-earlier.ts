import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** 距离列表顶部不超过此距离时提前加载更早的记录；视口较高时按屏数放大，见 AUTO_LOAD_EARLIER_SCREENS。 */
export const AUTO_LOAD_EARLIER_THRESHOLD_PX = 400;
/** 在线会话一页记录可能要等数秒，惯性滚动一甩就到顶；提前两屏开始加载，减少在顶部回弹期间前插。只读历史沿用同一提前量。 */
export const AUTO_LOAD_EARLIER_SCREENS = 2;
const SCROLLABLE_EPSILON = 1;

type AutoLoadEarlierOptions = {
  listRef: RefObject<HTMLDivElement | null>;
  /** 有更早记录、当前未在加载、也没有失败待重试时为 true。 */
  enabled: boolean;
  /** 内容可滚动时，是否在接近顶部时加载；跟随最新输出时为 false。内容不足一屏的补页不受影响。 */
  nearTop: boolean;
  /** 内容或加载状态变化后重新判断；传入随渲染内容变化的值。 */
  contentVersion: unknown;
  onLoad: () => void;
};

/**
 * 阅读位置接近顶部时自动加载更早的记录。
 * 内容不足一屏时也补一页，但只有上次补页让内容变高才继续，避免整页都是隐藏记录时一路拉完整个会话。
 * 返回值供列表的 scroll 事件调用；程序滚动同样会触发，判断条件本身保证不会重复请求。
 */
export function useAutoLoadEarlier({ listRef, enabled, nearTop, contentVersion, onLoad }: AutoLoadEarlierOptions): () => void {
  const enabledRef = useRef(enabled);
  const nearTopRef = useRef(nearTop);
  const onLoadRef = useRef(onLoad);
  const fillHeightRef = useRef<number | null>(null);
  // 每次渲染重新同步：触发后暂时关闭，等父组件以新的 loading、内容或状态重新渲染后再允许。
  useLayoutEffect(() => {
    enabledRef.current = enabled;
    nearTopRef.current = nearTop;
    onLoadRef.current = onLoad;
  });

  const check = useCallback(() => {
    const list = listRef.current;
    if (!enabledRef.current || !list) return;
    const scrollable = list.scrollHeight - list.clientHeight > SCROLLABLE_EPSILON;
    if (scrollable) {
      if (!nearTopRef.current || list.scrollTop > Math.max(AUTO_LOAD_EARLIER_THRESHOLD_PX, list.clientHeight * AUTO_LOAD_EARLIER_SCREENS)) return;
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
  }, [check, contentVersion, enabled, nearTop]);

  return check;
}
