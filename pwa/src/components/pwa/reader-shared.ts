import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type ProcessReaderSelection =
  | { kind: "tool"; entryKey: string; groupKey: string; trigger: HTMLButtonElement }
  | { kind: "thinking"; entryKey: string; groupKey: string; trigger: HTMLButtonElement };

export const READER_FOLLOW_THRESHOLD_PX = 32;

type ReaderSelection<T> = { selection: T; token: object; generation: number; opened: boolean; closing: boolean };

/** 同步 owner 门禁保留到退出完成；实例代次仅隔离旧过渡，不参与来源身份。 */
export function useReaderSelection<T>() {
  const [state, setState] = useState<ReaderSelection<T> | null>(null);
  const current = useRef(state);
  const generation = useRef(0);
  const frame = useRef<number | null>(null);
  const mounted = useRef(false);
  const cancelOpen = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const reset = useCallback(() => {
    cancelOpen();
    current.current = null;
    setState(null);
  }, [cancelOpen]);
  const open = useCallback((selection: T) => {
    if (!mounted.current || current.current !== null) return false;
    const next = { selection, token: {}, generation: ++generation.current, opened: false, closing: false };
    current.current = next;
    setState(next);
    return true;
  }, []);
  useLayoutEffect(() => {
    if (state === null || state.opened || state.closing) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (current.current?.token !== state.token || current.current.closing) return;
      const next = { ...current.current, opened: true };
      current.current = next;
      setState(next);
    });
    return cancelOpen;
  }, [state, cancelOpen]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelOpen(); current.current = null; };
  }, [cancelOpen]);
  const close = useCallback((token: object) => {
    const owner = current.current;
    if (owner?.token !== token || owner.closing) return;
    cancelOpen();
    // 尚未进入的 Drawer 不会产生 exit；直接清除，不能留下永久阅读锁。
    if (!owner.opened) { reset(); return; }
    const next = { ...owner, opened: false, closing: true };
    current.current = next;
    setState(next);
  }, [cancelOpen, reset]);
  const finish = useCallback((token: object) => {
    if (current.current?.token !== token || !current.current.closing) return false;
    reset();
    return true;
  }, [reset]);
  const holds = useCallback(() => current.current !== null, []);
  return { state, current, open, close, finish, reset, holds };
}

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
  useLayoutEffect(() => {
    current.current = generation;
    return () => { current.current = {}; };
  }, [generation]);
  const changeSelection = useCallback(() => {
    const next = {};
    current.current = next;
    setGeneration(next);
  }, []);
  const acceptsSelection = useCallback(() => current.current === generation, [generation]);
  return { changeSelection, acceptsSelection };
}
