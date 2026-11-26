const CLICK_FOLLOW_MS = 700;
const TAP_SLOP_PX = 10;
const swallowed = new WeakSet<Event>();

export function outsideTapSwallowed(event: Event): boolean {
  return swallowed.has(event);
}

type Options = {
  getTopFloating: () => HTMLElement | null;
  isOwnTrigger: (target: Element, floating: HTMLElement) => boolean;
};
type Tap = { pointerId: number; x: number; y: number; up: boolean; touchId?: number };

/** Mantine 仍接收原始按下事件；仅取消同一次外按的 touchend 默认动作和触控 click。 */
export function installOutsideTapGuard(scope: HTMLElement, options: Options): () => void {
  const doc = scope.ownerDocument;
  const win = doc.defaultView!;
  let tap: Tap | null = null;
  let timer: number | undefined;
  const disarm = () => { tap = null; win.clearTimeout(timer); timer = undefined; };
  const inScope = (target: EventTarget | null): target is Element => target instanceof win.Element && scope.contains(target);
  const near = (point: { clientX: number; clientY: number }) => !!tap && Math.hypot(point.clientX - tap.x, point.clientY - tap.y) <= TAP_SLOP_PX;
  const down = (event: PointerEvent) => {
    disarm();
    if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0 || !inScope(event.target)) return;
    const floating = options.getTopFloating();
    if (!floating || !scope.contains(floating) || floating.contains(event.target) || options.isOwnTrigger(event.target, floating)) return;
    tap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, up: false };
    swallowed.add(event);
  };
  const move = (event: PointerEvent) => {
    if (tap?.pointerId === event.pointerId && !near(event)) disarm();
  };
  const up = (event: PointerEvent) => {
    if (tap?.pointerId !== event.pointerId) return;
    if (!near(event) || !inScope(event.target)) { disarm(); return; }
    tap.up = true;
    win.clearTimeout(timer);
    timer = win.setTimeout(disarm, CLICK_FOLLOW_MS);
  };
  const touchStart = (event: TouchEvent) => {
    if (!tap || !inScope(event.target)) return;
    if (event.touches.length !== 1) { disarm(); return; }
    const touch = event.changedTouches[0];
    if (touch && near(touch)) tap.touchId = touch.identifier;
  };
  const touchEnd = (event: TouchEvent) => {
    if (!tap || !inScope(event.target)) return;
    const touch = Array.from(event.changedTouches).find(point => point.identifier === tap?.touchId);
    if (!touch || !near(touch)) return;
    if (event.cancelable) event.preventDefault();
  };
  const click = (event: MouseEvent) => {
    if (!tap || !tap.up) return;
    const pointer = event as PointerEvent;
    const capabilities = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities;
    // detail=0 为键盘/辅助技术；普通鼠标必须不受此前触摸影响。
    if (event.detail === 0 || (pointer.pointerType !== "touch" && !capabilities?.firesTouchEvents)) return;
    if (pointer.pointerType === "touch" && pointer.pointerId !== tap.pointerId) return;
    if (!inScope(event.target) || !near(event)) return;
    disarm();
    swallowed.add(event);
    event.preventDefault();
    event.stopPropagation();
  };
  const cancel = (event: PointerEvent) => { if (tap?.pointerId === event.pointerId) disarm(); };
  const hide = () => { if (doc.hidden) disarm(); };
  doc.addEventListener("pointerdown", down, { capture: true, passive: true });
  doc.addEventListener("pointermove", move, { capture: true, passive: true });
  doc.addEventListener("pointerup", up, { capture: true, passive: true });
  doc.addEventListener("pointercancel", cancel, { capture: true, passive: true });
  doc.addEventListener("touchstart", touchStart, { capture: true, passive: true });
  doc.addEventListener("touchend", touchEnd, { capture: true, passive: false });
  doc.addEventListener("touchcancel", disarm, { capture: true, passive: true });
  doc.addEventListener("scroll", disarm, { capture: true, passive: true });
  doc.addEventListener("click", click, true);
  win.addEventListener("blur", disarm);
  doc.addEventListener("visibilitychange", hide);
  return () => {
    disarm();
    doc.removeEventListener("pointerdown", down, true);
    doc.removeEventListener("pointermove", move, true);
    doc.removeEventListener("pointerup", up, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("touchstart", touchStart, true);
    doc.removeEventListener("touchend", touchEnd, true);
    doc.removeEventListener("touchcancel", disarm, true);
    doc.removeEventListener("scroll", disarm, true);
    doc.removeEventListener("click", click, true);
    win.removeEventListener("blur", disarm);
    doc.removeEventListener("visibilitychange", hide);
  };
}
