import { useLayoutEffect, type RefObject } from "react";
import { TIMELINE_GEOMETRY_EVENT } from "@/lib/pwa/use-timeline-viewport";

/**
 * 同步主区提示区（局部错误卡片）的几何到工作区根节点。
 * Toast 挂在根节点上，按主区居中并落在提示区下方，避免压到侧栏或卡片。
 * 提示区浮在列表之上（ADR-20261105）：其高度同步为列表顶部留白，并通知时间线视口保持阅读位置，正文不被推开。
 */
export function useMainNoticesSpace(rootRef: RefObject<HTMLElement | null>, noticesRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const notices = noticesRef.current;
    if (!root || !notices) return;
    let space = -1;
    const measure = () => {
      // 主区是 flex 容器，绝对定位子元素的静态位置在容器顶部而非标题区之后，需显式落在标题区下沿。
      const title = notices.previousElementSibling;
      const top = `${title instanceof HTMLElement ? title.offsetTop + title.offsetHeight : 0}px`;
      if (notices.style.top !== top) notices.style.top = top;
      const base = root.getBoundingClientRect();
      const box = notices.getBoundingClientRect();
      root.style.setProperty("--pwa-main-notices-bottom", `${box.bottom - base.top}px`);
      root.style.setProperty("--pwa-main-center", `${box.left + box.width / 2 - base.left}px`);
      root.style.setProperty("--pwa-main-width", `${box.width}px`);
      const next = Math.round(box.height);
      if (next === space) return;
      space = next;
      root.style.setProperty("--pwa-top-notices-space", `${next}px`);
      root.querySelector(".pwa-message-list")?.dispatchEvent(new Event(TIMELINE_GEOMETRY_EVENT));
    };
    measure();
    const observer = new ResizeObserver(measure);
    // 标题区变高（含安全区内边距）时提示区整体下移但自身尺寸不变，也需要重新测量。
    for (const element of [notices, root, notices.parentElement, notices.previousElementSibling]) if (element) observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [noticesRef, rootRef]);
}
