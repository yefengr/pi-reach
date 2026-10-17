import { useEffect, useRef } from "react";

const PRESS_TARGET = ".pwa-button, .pwa-icon-button";
const unavailable = (element: HTMLElement) => element.matches(":disabled, [data-disabled]") || !element.isConnected;

/** 触控浏览器不保证按住期间保留 :active；仅补绘制状态，不捕获指针或阻止原生点击／滚动。 */
export function usePwaPressFeedback() {
  const scopeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    let held: { element: HTMLElement; pointerId: number } | null = null;
    const observer = new MutationObserver(() => {
      if (held && unavailable(held.element)) clear();
    });
    const clear = () => {
      if (held) delete held.element.dataset.pwaPressed;
      held = null;
      observer.disconnect();
    };
    const start = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      clear();
      if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
      const element = event.target.closest<HTMLElement>(PRESS_TARGET);
      if (!element || !scope.contains(element) || unavailable(element) || (import.meta.env.DEV && element.closest(".pwa-ui-review"))) return;
      held = { element, pointerId: event.pointerId };
      element.dataset.pwaPressed = "true";
      observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "data-disabled"] });
    };
    const move = (event: PointerEvent) => {
      if (!held || held.pointerId !== event.pointerId) return;
      const bounds = held.element.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) clear();
    };
    const finish = (event: PointerEvent) => {
      if (held?.pointerId === event.pointerId) clear();
    };
    const hide = () => { if (document.hidden) clear(); };
    scope.addEventListener("pointerdown", start, { passive: true });
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", finish, { passive: true });
    window.addEventListener("pointercancel", finish, { passive: true });
    scope.addEventListener("lostpointercapture", finish, { passive: true });
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", hide);
    return () => {
      clear();
      scope.removeEventListener("pointerdown", start);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      scope.removeEventListener("lostpointercapture", finish);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  return scopeRef;
}
