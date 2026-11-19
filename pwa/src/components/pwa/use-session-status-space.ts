import { useLayoutEffect } from "react";
import { MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

/** 使用主区实际可用宽度；侧栏收展与调宽均复用同一列预算。 */
export function useSessionStatusSpace(main: HTMLElement | null, enabled: boolean) {
  useLayoutEffect(() => {
    if (!main) return;
    const measure = () => {
      const style = getComputedStyle(main);
      const number = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
      const width = main.clientWidth - number("--pwa-main-safe-left") - number("--pwa-main-safe-right");
      const reading = number("--pwa-reading-width");
      const card = 248;
      const right = 12;
      const gap = 16;
      const available = enabled && !window.matchMedia(MOBILE_LAYOUT_QUERY).matches && width >= reading + card + right + gap + number("--pwa-gutter");
      main.toggleAttribute("data-session-status-card", available);
      main.style.setProperty("--pwa-status-reserve", `${available ? Math.max(0, reading + 2 * (card + right + gap) - width) : 0}px`);
      const title = main.querySelector<HTMLElement>(".pwa-title-bar");
      main.style.setProperty("--pwa-status-top", `${(title?.offsetHeight ?? 0) + 8}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    const title = main.querySelector(".pwa-title-bar");
    if (title) observer.observe(title);
    return () => { observer.disconnect(); main.removeAttribute("data-session-status-card"); main.style.removeProperty("--pwa-status-reserve"); };
  }, [main, enabled]);
}
