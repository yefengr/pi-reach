import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { DESKTOP_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";
import { clampSidebarWidth, parseSidebarWidth, sidebarWidthCap, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_KEYBOARD_STEP, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH_KEY } from "@/lib/ui/sidebar-width";

function readPreference(): number {
  try { return typeof window === "undefined" ? SIDEBAR_DEFAULT_WIDTH : parseSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)); }
  catch { return SIDEBAR_DEFAULT_WIDTH; }
}
function writePreference(width: number) {
  try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, JSON.stringify(width)); } catch { /* 禁止存储时仍保留本页操作。 */ }
}
function measureCap(root: HTMLElement) {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;padding-left:var(--pwa-safe-left);padding-right:var(--pwa-safe-right)";
  root.append(probe);
  const style = getComputedStyle(probe);
  const cap = sidebarWidthCap(root.getBoundingClientRect().width, parseFloat(style.paddingLeft) || 0, parseFloat(style.paddingRight) || 0);
  probe.remove();
  return cap;
}

type Drag = { pointerId: number; target: HTMLElement; startWidth: number; width: number; dispose: () => void };

function startDrag(event: PointerEvent<HTMLDivElement>, width: number, cap: () => number, preview: (width: number) => void, finish: (commit: boolean) => void): Drag {
  const target = event.currentTarget;
  const startX = event.clientX;
  const pointerId = event.pointerId;
  event.preventDefault();
  target.focus({ preventScroll: true });
  target.setPointerCapture(pointerId);
  const body = document.body;
  const previous = ["cursor", "user-select"].map((name) => [name, body.style.getPropertyValue(name), body.style.getPropertyPriority(name)]);
  body.style.setProperty("cursor", "col-resize");
  body.style.setProperty("user-select", "none");
  const move = (next: globalThis.PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    drag.width = clampSidebarWidth(width + next.clientX - startX, cap());
    preview(drag.width);
  };
  const end = (next: globalThis.PointerEvent) => { if (next.pointerId === pointerId) finish(next.type === "pointerup"); };
  const cancel = () => finish(false);
  const hidden = () => { if (document.hidden) cancel(); };
  const escape = (next: globalThis.KeyboardEvent) => {
    if (next.key !== "Escape") return;
    next.preventDefault();
    next.stopPropagation();
    cancel();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", hidden);
  document.addEventListener("keydown", escape, true);
  target.addEventListener("lostpointercapture", cancel);
  const drag: Drag = { pointerId, target, startWidth: width, width, dispose: () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("visibilitychange", hidden);
    document.removeEventListener("keydown", escape, true);
    target.removeEventListener("lostpointercapture", cancel);
    for (const [name, value, priority] of previous) { if (value) body.style.setProperty(name, value, priority); else body.style.removeProperty(name); }
  } };
  return drag;
}

/** 临时拖动值与用户偏好分离；viewport 限宽和取消都不能覆盖已保存的偏好。 */
export function useSidebarWidth(rootRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [preference, setPreference] = useState(readPreference);
  const [cap, setCap] = useState(SIDEBAR_MAX_WIDTH);
  const [desktop, setDesktop] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const capRef = useRef(cap);
  const availableRef = useRef(false);
  const finish = useCallback((commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.dispose();
    if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    setPreview(null);
    // 只点按被 viewport 限宽的分隔条不算用户改宽，必须保留较宽偏好。
    if (!commit || drag.width === drag.startWidth) return;
    const next = clampSidebarWidth(drag.width, capRef.current);
    setPreference(next);
    writePreference(next);
  }, []);
  const save = useCallback((next: number) => {
    finish(false);
    setPreference(next);
    writePreference(next);
  }, [finish]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const media = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    const measure = () => {
      const nextCap = measureCap(root);
      capRef.current = nextCap;
      setCap(nextCap);
      setDesktop(media.matches);
      if (!media.matches) finish(false);
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== SIDEBAR_WIDTH_KEY && event.key !== null) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; }
      catch { /* storage getter 被禁用时继续使用安全读取与默认值。 */ }
      finish(false);
      setPreference(readPreference());
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    media.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("storage", storage);
    return () => {
      finish(false);
      observer.disconnect();
      media.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("storage", storage);
    };
  }, [finish, rootRef]);
  useLayoutEffect(() => {
    availableRef.current = enabled && desktop;
    if (!availableRef.current) finish(false);
    return () => { availableRef.current = false; finish(false); };
  }, [desktop, enabled, finish]);

  const width = clampSidebarWidth(preview ?? preference, cap);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!availableRef.current || dragRef.current || !event.isPrimary || event.button !== 0) return;
    dragRef.current = startDrag(event, width, () => capRef.current, setPreview, finish);
    setPreview(width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!availableRef.current || dragRef.current) return;
    const next = event.key === "ArrowLeft" ? width - SIDEBAR_KEYBOARD_STEP : event.key === "ArrowRight" ? width + SIDEBAR_KEYBOARD_STEP : event.key === "Home" ? SIDEBAR_MIN_WIDTH : event.key === "End" ? cap : null;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(next, cap);
    // 已到临时边界的按键不算改宽，和无移动的点按一样保留较宽偏好。
    if (clamped === width) return;
    save(clamped);
  };
  return { width, cap, dragging: preview !== null, enabled: enabled && desktop, onPointerDown, onKeyDown, onDoubleClick: () => { if (availableRef.current) save(SIDEBAR_DEFAULT_WIDTH); } };
}
