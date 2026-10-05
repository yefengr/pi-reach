const EXCLUDED_START = "input, textarea, select, [contenteditable], .pwa-composer, [data-swipe-ignore]";
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

export function swipeBlocked(surface: HTMLElement): boolean {
  const root = surface.closest(".pwa-root");
  if (!root) return false;
  return [...root.querySelectorAll<HTMLElement>(BLOCKING_OVERLAY)].some((overlay) =>
    !overlay.contains(surface)
    && overlay.isConnected
    && !overlay.closest('[inert], [aria-hidden="true"]')
    && overlay.getClientRects().length > 0,
  );
}
