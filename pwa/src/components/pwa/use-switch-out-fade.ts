import { useCallback, useEffect, useRef, type RefObject } from "react";
import { pwaStandardEasing, usePwaMotionDuration } from "./use-pwa-motion";

const DRAWER_DURATION_MS = 200;
/** 切换在导航退出动画结束后执行；超过这段余量仍未切换，视为关闭被拒绝或手势回弹。 */
const SWITCH_FALLBACK_MS = 1000;

/**
 * 移动导航退出期间让旧会话以同一时长与曲线淡出，抽屉收走时不再露出即将被替换的内容。
 * 目标真正切换时由调用方在同一次提交中撤销淡出；没有切换（拒绝关闭、回弹、待确认）时恢复原状。
 */
export function useSwitchOutFade(listRef: RefObject<HTMLElement | null>) {
  const duration = usePwaMotionDuration("--pwa-duration-drawer", DRAWER_DURATION_MS);
  const animationRef = useRef<Animation | null>(null);
  const timerRef = useRef<number | null>(null);
  const settle = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    animationRef.current?.cancel();
    animationRef.current = null;
  }, []);
  const begin = useCallback(() => {
    settle();
    const list = listRef.current;
    if (!list || typeof list.animate !== "function") return;
    animationRef.current = list.animate([{ opacity: getComputedStyle(list).opacity }, { opacity: 0 }], { duration, easing: pwaStandardEasing(list), fill: "forwards" });
    timerRef.current = window.setTimeout(settle, duration + SWITCH_FALLBACK_MS);
  }, [duration, listRef, settle]);
  useEffect(() => settle, [settle]);
  return { begin, settle };
}
