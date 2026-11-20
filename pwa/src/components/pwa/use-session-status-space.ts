import { useLayoutEffect, useRef } from "react";
import { MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

// 隐藏门槛由阅读列、卡片预留与两侧 gutter 算出；重新显示需再多出这段回差，避免在门槛附近反复切换。
const STATUS_SHOW_HYSTERESIS = 20;

/** 宽度回差独立于会话存在性；安全区只在主区预算中扣除一次。 */
export function useSessionStatusSpace(main: HTMLElement | null, enabled: boolean) {
  const widthFits = useRef<boolean | null>(null);
  const measured = useRef(false);
  useLayoutEffect(() => {
    if (!main) return;
    widthFits.current = null;
    measured.current = false;
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
      const reserve = number("--pwa-status-card-width") + number("--pwa-status-card-inset") + number("--pwa-status-card-gap");
      const hideBelow = number("--pwa-reading-width") + reserve + 2 * number("--pwa-gutter");
      widthFits.current = width >= (widthFits.current === false ? hideBelow + STATUS_SHOW_HYSTERESIS : hideBelow);
      const available = enabled && !window.matchMedia(MOBILE_LAYOUT_QUERY).matches && widthFits.current;
      const changed = main.hasAttribute("data-session-status-card") !== available;
      // 只让第一次主区测量直接到位；后续拖窗、调宽及会话变化都沿用同一空间过渡。
      main.toggleAttribute("data-session-status-instant", !measured.current);
      measured.current = true;
      // 同一显隐状态下不重复写 reserve，避免侧栏 grid 的逐帧测量重启让位动画。
      if (changed || !main.style.getPropertyValue("--pwa-status-reserve")) {
        main.toggleAttribute("data-session-status-card", available);
        main.style.setProperty("--pwa-status-reserve", `${available ? reserve : 0}px`);
      }
      // 卡片与标题区的间距取右侧留白，四周留白一致。
      const title = main.querySelector<HTMLElement>(".pwa-title-bar");
      main.style.setProperty("--pwa-status-top", `${(title?.offsetHeight ?? 0) + number("--pwa-status-card-inset")}px`);
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
