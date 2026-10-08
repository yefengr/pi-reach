const EXCLUDED_START = "input, textarea, select, [contenteditable], .pwa-composer, [data-swipe-ignore]";
/** Safari 标签页左缘属于浏览器后退手势；起点落在此宽度内时不跟手，退回触发式。 */
export const SWIPE_EDGE_EXCLUSION_PX = 24;
const STANDALONE_QUERY = "(display-mode: standalone)";
const BLOCKING_OVERLAY = '[role="dialog"], [role="menu"], [role="listbox"]';

export function swipeStartExcluded(surface: HTMLElement, target: EventTarget | null): boolean {
  if (window.getSelection()?.toString()) return true;
  if (!(target instanceof Element) || !surface.contains(target)) return true;
  if (target.closest(EXCLUDED_START)) return true;
  for (let element: Element | null = target; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && element.scrollWidth > element.clientWidth) return true;
    if (element === surface) break;
  }
  return false;
}

/** 拖动控制器给自己预挂载的叠层打的标记；它不是需要阻断手势的外部叠层。 */
export const SWIPE_DRAG_ATTRIBUTE = "data-swipe-drag";

export function swipeBlocked(surface: HTMLElement): boolean {
  const root = surface.closest(".pwa-root");
  if (!root) return false;
  return [...root.querySelectorAll<HTMLElement>(BLOCKING_OVERLAY)].some((overlay) =>
    !overlay.contains(surface)
    && !overlay.hasAttribute(SWIPE_DRAG_ATTRIBUTE)
    && overlay.isConnected
    && !overlay.closest('[inert], [aria-hidden="true"]')
    && overlay.getClientRects().length > 0,
  );
}

/** standalone 没有系统边缘返回（待真机核对），不排除；浏览器标签页内向右拖动不得起自左缘。 */
export function swipeEdgeExcluded(direction: "left" | "right", startX: number): boolean {
  if (direction !== "right" || startX >= SWIPE_EDGE_EXCLUSION_PX) return false;
  return !window.matchMedia(STANDALONE_QUERY).matches;
}
