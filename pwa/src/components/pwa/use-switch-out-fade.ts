import { useCallback, useEffect, useRef, type RefObject } from "react";
import { pwaStandardEasing, usePwaMotionDuration } from "./use-pwa-motion";

const DRAWER_DURATION_MS = 200;
const FADE_DURATION_MS = 120;
/** 切换在导航退出动画结束后执行；超过这段余量仍未切换，视为关闭被拒绝或手势回弹。 */
const SWITCH_FALLBACK_MS = 1000;

/**
 * 切换电脑、Pi 或历史时旧会话先淡出，再换上新内容，桌面与移动端遵循同一节奏。
 * 移动导航随抽屉退出以同一时长与曲线淡出（begin）；没有导航退出的入口先短暂淡出再切换（run）。
 * 目标真正切换时由调用方在同一次提交中撤销淡出；没有切换（拒绝关闭、回弹、待确认）时恢复原状。
 */
export function useSwitchOutFade(listRef: RefObject<HTMLElement | null>) {
  const drawerDuration = usePwaMotionDuration("--pwa-duration-drawer", DRAWER_DURATION_MS);
  const fadeDuration = usePwaMotionDuration("--pwa-duration-fade", FADE_DURATION_MS);
  const animationRef = useRef<Animation | null>(null);
  const timerRef = useRef<number | null>(null);
  const settle = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    animationRef.current?.cancel();
    animationRef.current = null;
  }, []);
  const fadeOut = useCallback((duration: number): Animation | null => {
    settle();
    const list = listRef.current;
    if (!list || typeof list.animate !== "function") return null;
    const animation = list.animate([{ opacity: getComputedStyle(list).opacity }, { opacity: 0 }], { duration, easing: pwaStandardEasing(list), fill: "forwards" });
    animationRef.current = animation;
    return animation;
  }, [listRef, settle]);
  const begin = useCallback(() => {
    if (!fadeOut(drawerDuration)) return;
    timerRef.current = window.setTimeout(settle, drawerDuration + SWITCH_FALLBACK_MS);
  }, [drawerDuration, fadeOut, settle]);
  const run = useCallback((next: () => void) => {
    // 已随导航退出淡出，或没有可淡出的内容时直接切换。
    if (animationRef.current) {
      next();
      return;
    }
    const animation = fadeOut(fadeDuration);
    if (!animation) {
      next();
      return;
    }
    // 淡出期间又选了别的目标时，旧淡出被撤销，finished 拒绝，原目标不再执行。
    animation.finished.then(() => { if (animationRef.current === animation) next(); }, () => undefined);
  }, [fadeDuration, fadeOut]);
  useEffect(() => settle, [settle]);
  return { begin, run, settle };
}
