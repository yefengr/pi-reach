import { readPwaMotionDuration } from "./motion.js";

export const PRESS_ROW_DELAY_MS = 100;
export const PRESS_ROW_SLOP_PX = 10;
export const PRESS_ROW_TAP_MS = 120;

type Options = {
  buttonSelector: string;
  rowSelector?: string;
  shouldIgnore?: (event: PointerEvent) => boolean;
};
type Held = { element: HTMLElement; pointerId: number; row: boolean; x: number; y: number };

/** 只补绘制，不接管指针、点击或滚动；选择器与事件门禁由宿主显式提供。 */
export function installPressFeedback(scope: HTMLElement, options: Options): () => void {
  const doc = scope.ownerDocument;
  const win = doc.defaultView!;
  let held: Held | null = null;
  let delay: number | undefined;
  let tapped: { element: HTMLElement; timer: number } | null = null;
  const pressed = new Set<HTMLElement>();
  const releasing = new Map<HTMLElement, number>();
  const unavailable = (element: HTMLElement) => {
    if (!scope.isConnected || !scope.contains(element) || element.matches(":disabled, [data-disabled], [aria-disabled='true']") ||
        element.closest("[hidden], [inert], [aria-hidden='true']")) return true;
    const style = win.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0;
  };
  const settle = (element: HTMLElement) => {
    if (!releasing.has(element)) return;
    win.clearTimeout(releasing.get(element));
    releasing.delete(element);
    delete element.dataset.pwaPressRelease;
  };
  const mark = (element: HTMLElement) => {
    if (element.hasAttribute("data-pwa-pressed")) return;
    element.dataset.pwaPressed = "true";
    pressed.add(element);
  };
  const unmark = (element: HTMLElement, fade: boolean) => {
    if (!pressed.delete(element)) return;
    delete element.dataset.pwaPressed;
    settle(element);
    if (!fade || unavailable(element) || element.hasAttribute("data-pwa-press-release")) return;
    element.dataset.pwaPressRelease = "true";
    releasing.set(element, win.setTimeout(() => settle(element), readPwaMotionDuration("--pwa-duration-press-out", undefined, element)));
  };
  const clearHeld = (fade = true) => {
    win.clearTimeout(delay);
    delay = undefined;
    if (held) unmark(held.element, fade && held.row);
    held = null;
  };
  const clearTapped = (fade = true) => {
    if (!tapped) return;
    win.clearTimeout(tapped.timer);
    unmark(tapped.element, fade);
    tapped = null;
  };
  const reset = () => {
    clearHeld(false);
    clearTapped(false);
    for (const element of releasing.keys()) settle(element);
  };
  const observer = new win.MutationObserver(() => {
    if (held && unavailable(held.element)) clearHeld(false);
    if (tapped && unavailable(tapped.element)) clearTapped(false);
    for (const element of releasing.keys()) if (unavailable(element)) settle(element);
  });
  const start = (event: PointerEvent) => {
    reset();
    if ((event.pointerType !== "touch" && event.pointerType !== "pen") || !event.isPrimary || event.button !== 0 ||
        !(event.target instanceof win.Element) || options.shouldIgnore?.(event)) return;
    const selector = options.rowSelector ? `${options.buttonSelector}, ${options.rowSelector}` : options.buttonSelector;
    const element = event.target.closest<HTMLElement>(selector);
    if (!element || unavailable(element)) return;
    const row = !element.matches(options.buttonSelector);
    held = { element, pointerId: event.pointerId, row, x: event.clientX, y: event.clientY };
    if (row) delay = win.setTimeout(() => {
      delay = undefined;
      if (held?.element === element && !unavailable(element)) mark(element);
    }, PRESS_ROW_DELAY_MS);
    else mark(element);
  };
  const move = (event: PointerEvent) => {
    if (!held || held.pointerId !== event.pointerId) return;
    const bounds = held.element.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom ||
        Math.hypot(event.clientX - held.x, event.clientY - held.y) > PRESS_ROW_SLOP_PX) clearHeld();
  };
  const finish = (event: PointerEvent) => {
    if (held?.pointerId !== event.pointerId) return;
    const { element, row } = held;
    const quick = row && delay !== undefined && event.type === "pointerup" && !unavailable(element);
    clearHeld(event.type === "pointerup");
    if (!quick) return;
    settle(element);
    mark(element);
    tapped = { element, timer: win.setTimeout(() => clearTapped(), PRESS_ROW_TAP_MS) };
  };
  const hide = () => { if (doc.hidden) reset(); };
  scope.addEventListener("pointerdown", start, { passive: true });
  win.addEventListener("pointermove", move, { passive: true });
  win.addEventListener("pointerup", finish, { passive: true });
  win.addEventListener("pointercancel", finish, { passive: true });
  scope.addEventListener("lostpointercapture", finish, { passive: true });
  doc.addEventListener("scroll", reset, { capture: true, passive: true });
  win.addEventListener("blur", reset);
  doc.addEventListener("visibilitychange", hide);
  // 只检查本实例持有的元素；观察文档是为了检测 scope 自身被移除或祖先隐藏。
  observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["disabled", "data-disabled", "aria-disabled", "hidden", "inert", "aria-hidden", "style", "class"] });
  return () => {
    reset();
    observer.disconnect();
    scope.removeEventListener("pointerdown", start);
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", finish);
    win.removeEventListener("pointercancel", finish);
    scope.removeEventListener("lostpointercapture", finish);
    doc.removeEventListener("scroll", reset, true);
    win.removeEventListener("blur", reset);
    doc.removeEventListener("visibilitychange", hide);
  };
}
