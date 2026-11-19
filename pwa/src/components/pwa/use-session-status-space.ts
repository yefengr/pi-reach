import { useLayoutEffect, useRef } from "react";
import { MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

/** 使用主区实际可用宽度；侧栏收展与调宽均复用同一列预算。 */
export function useSessionStatusSpace(main: HTMLElement | null, enabled: boolean) {
  const windowWidth = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!main) return;
    windowWidth.current = null;
    return () => {
      main.removeAttribute("data-session-status-card");
      main.removeAttribute("data-session-status-instant");
      main.style.removeProperty("--pwa-status-reserve");
      main.style.removeProperty("--pwa-status-top");
    };
  }, [main]);

  useLayoutEffect(() => {
    if (!main) return;
    const measure = () => {
      const style = getComputedStyle(main);
      const number = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
      const width = main.clientWidth - number("--pwa-main-safe-left") - number("--pwa-main-safe-right");
      const reserve = number("--pwa-status-card-width") + number("--pwa-status-card-inset");
      const available = enabled && !window.matchMedia(MOBILE_LAYOUT_QUERY).matches
        && width >= number("--pwa-reading-width") + reserve + 2 * number("--pwa-gutter");
      const changed = main.hasAttribute("data-session-status-card") !== available;
      // 浏览器没有拖窗起止信号：所有窗口宽度变化都即时跟随，也要取消已经在途的让位过渡。
      const resized = windowWidth.current !== window.innerWidth;
      if (resized) main.setAttribute("data-session-status-instant", "");
      else if (changed) main.removeAttribute("data-session-status-instant");
      windowWidth.current = window.innerWidth;
      // 同一显隐状态下不重复写 reserve，避免侧栏 grid 的逐帧测量重启让位动画。
      if (changed || !main.style.getPropertyValue("--pwa-status-reserve")) {
        main.toggleAttribute("data-session-status-card", available);
        main.style.setProperty("--pwa-status-reserve", `${available ? reserve : 0}px`);
      }
      const title = main.querySelector<HTMLElement>(".pwa-title-bar");
      main.style.setProperty("--pwa-status-top", `${(title?.offsetHeight ?? 0) + 8}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    const title = main.querySelector(".pwa-title-bar");
    if (title) observer.observe(title);
    window.addEventListener("resize", measure);
    // enabled 改变仍复用同一 main 的旧 reserve，让新目标正常过渡；只有 main 换代才清空样式。
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [main, enabled]);
}
