import { useCallback, useRef, useState } from "react";

/** 阅读器内可回焦的控件：已连接、可见、未禁用且不在 inert／隐藏区域。 */
export function readerFocusable(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element !== document.body && element !== document.documentElement && element.isConnected && !element.matches(":disabled")
    && !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden";
}

/** 阅读器之上还有可见叠层（确认框、菜单等）时，关闭与返回交给上层处理。 */
export function readerHasOverlay(surface: HTMLElement | null) {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')]
    .some(overlay => overlay !== surface && readerFocusable(overlay));
}

/** 区分「打开阅读器的那次选择」与之后的新选择，晚到的旧结果不覆盖当前内容。 */
export function useReaderIntent() {
  const [generation, setGeneration] = useState<object>({});
  const current = useRef(generation);
  const changeSelection = useCallback(() => {
    const next = {};
    current.current = next;
    setGeneration(next);
  }, []);
  const acceptsSelection = useCallback(() => current.current === generation, [generation]);
  return { changeSelection, acceptsSelection };
}
