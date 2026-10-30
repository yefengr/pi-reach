export const TIMELINE_GEOMETRY_EVENT = "pwa:timeline-geometry";
const EXCLUSIONS = ".pwa-earlier, .pwa-bottom-sentinel, .pwa-chat-empty";
const TOUCH_READ_THRESHOLD = 4;
type Events = {
  geometry(activity: boolean, added?: number): void;
  /** 过程组开始收起：removed 为预计收回的高度，duration 为收起时长加兜底；只是预期，不是位置终点。 */
  collapse(removed: number, duration: number): void;
  resize(): void;
  interrupt(): void;
  input(): void;
  /** 任何触摸（含拖动）、滚轮、按键或指针输入；只表示用户正在接管位置，不判断方向。 */
  engage(): void;
  /** 列表上是否仍有手指按着；抬起或取消后为 false。 */
  touch(active: boolean): void;
};

/** 只报告事件与差分观察目标；不作任何意图或过程交接决策。 */
export class TimelineViewportObservers {
  private observer: ResizeObserver | null;
  private elements = new Set<Element>();
  private snapshot: { elements: Element[]; classes: (string | null)[] } | null = null;
  private cleanup: () => void;

  constructor(readonly list: HTMLDivElement, events: Events) {
    this.observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => events.resize());
    const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
    const geometry = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail?.reason === "collapse") { events.collapse(finite(detail.removed), finite(detail.duration)); return; }
      const added = typeof detail?.added === "number" && Number.isFinite(detail.added) ? Math.max(0, detail.added) : 0;
      events.geometry(detail?.reason === "activity", added);
    };
    const input = (event: Event) => { if (event.target instanceof HTMLTextAreaElement) events.input(); };
    const wheel = (event: WheelEvent) => { events.engage(); if (event.deltaY < 0) events.interrupt(); };
    const key = (event: KeyboardEvent) => { events.engage(); if (["ArrowUp", "PageUp", "Home"].includes(event.key)) events.interrupt(); };
    const pointer = (event: PointerEvent) => { events.engage(); if (event.pointerType === "mouse" && event.target === list) events.interrupt(); };
    let touch: { id: number; y: number } | null = null;
    const start = (event: TouchEvent) => {
      events.engage();
      events.touch(event.touches.length > 0);
      const first = event.touches[0];
      touch = event.touches.length === 1 ? { id: first.identifier, y: first.clientY } : null;
    };
    const move = (event: TouchEvent) => {
      // 拖动中的每一步都是用户在定位：前插保护若在按下之后才开启，也不能把它当成系统覆盖拉回。
      events.engage();
      const first = event.touches[0];
      if (event.touches.length !== 1 || first.identifier !== touch?.id) { touch = null; return; }
      if (first.clientY - touch.y > TOUCH_READ_THRESHOLD) { touch = null; events.interrupt(); }
    };
    const end = (event: TouchEvent) => { touch = null; events.touch(event.touches.length > 0); };
    const main = list.closest(".pwa-main");
    list.addEventListener(TIMELINE_GEOMETRY_EVENT, geometry);
    list.addEventListener("wheel", wheel, { passive: true });
    list.addEventListener("keydown", key);
    list.addEventListener("pointerdown", pointer);
    list.addEventListener("touchstart", start, { passive: true });
    list.addEventListener("touchmove", move, { passive: true });
    list.addEventListener("touchend", end, { passive: true });
    list.addEventListener("touchcancel", end, { passive: true });
    main?.addEventListener("input", input, true);
    this.cleanup = () => {
      list.removeEventListener(TIMELINE_GEOMETRY_EVENT, geometry);
      list.removeEventListener("wheel", wheel);
      list.removeEventListener("keydown", key);
      list.removeEventListener("pointerdown", pointer);
      list.removeEventListener("touchstart", start);
      list.removeEventListener("touchmove", move);
      list.removeEventListener("touchend", end);
      list.removeEventListener("touchcancel", end);
      main?.removeEventListener("input", input, true);
    };
  }

  refresh(): void {
    const children = this.list.children;
    const snapshot = this.snapshot;
    const className = (element: Element) => element instanceof HTMLElement ? element.className : null;
    if (snapshot && snapshot.elements.length === children.length &&
        [...children].every((child, index) => snapshot.elements[index] === child && snapshot.classes[index] === className(child))) return;
    const elements = [...children];
    const next = new Set<Element>([this.list]);
    for (const child of elements) if (child instanceof HTMLElement && !child.matches(EXCLUSIONS)) next.add(child);
    for (const element of this.elements) if (!next.has(element)) this.observer?.unobserve(element);
    for (const element of next) if (!this.elements.has(element)) this.observer?.observe(element);
    this.elements = next;
    this.snapshot = { elements, classes: elements.map(className) };
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.cleanup();
    this.elements.clear();
    this.snapshot = null;
  }
}
