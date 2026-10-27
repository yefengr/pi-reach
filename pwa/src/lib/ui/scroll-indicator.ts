import { useEffect } from "react";

/** 滚动状态标记：滚动容器滚动时打上该属性，CSS 据此显示滚动条。 */
export const SCROLLING_ATTRIBUTE = "data-scrolling";
/** 滚动过至少一次的容器：只在它们身上挂过渡，避免全局 transition 覆盖组件的布局过渡。 */
export const SCROLL_HOST_ATTRIBUTE = "data-scroll-host";
/** 根元素上的开关：脚本就绪后才隐藏静止滚动条，脚本失败时滚动条保持可见。 */
export const SCROLL_HINTS_ATTRIBUTE = "data-scroll-hints";
/** 停止滚动到隐藏的延迟；覆盖惯性滚动与连续滚动，并按用户要求延长到 3 秒。 */
export const SCROLL_HIDE_DELAY_MS = 3000;

/**
 * 统一滚动条显隐：`scroll` 不冒泡，但捕获阶段能拿到任意滚动容器的事件，
 * 因此只在 document 上挂一个被动监听，滚动时标记目标元素，静止后延迟摘除。
 * 属性值写入与定时器都以元素为键，元素被移除后由定时器自行清理。
 */
export function useScrollIndicator() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const timers = new Map<Element, number>();
    const markScrolling = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // 首次滚动时同时写入 host 标记：同一次任务内完成，首帧也能走过渡。
      if (!target.hasAttribute(SCROLL_HOST_ATTRIBUTE)) target.setAttribute(SCROLL_HOST_ATTRIBUTE, "true");
      // 跟随贴底时每帧都有程序滚动；属性已在时只续期定时器，不重复写入触发样式失效。
      if (!target.hasAttribute(SCROLLING_ATTRIBUTE)) target.setAttribute(SCROLLING_ATTRIBUTE, "true");
      const pending = timers.get(target);
      if (pending !== undefined) window.clearTimeout(pending);
      timers.set(target, window.setTimeout(() => {
        timers.delete(target);
        target.removeAttribute(SCROLLING_ATTRIBUTE);
      }, SCROLL_HIDE_DELAY_MS));
    };
    root.setAttribute(SCROLL_HINTS_ATTRIBUTE, "true");
    document.addEventListener("scroll", markScrolling, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", markScrolling, { capture: true });
      for (const [element, timer] of timers) {
        window.clearTimeout(timer);
        element.removeAttribute(SCROLLING_ATTRIBUTE);
      }
      timers.clear();
      root.removeAttribute(SCROLL_HINTS_ATTRIBUTE);
    };
  }, []);
}
