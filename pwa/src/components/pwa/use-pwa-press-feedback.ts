import { useEffect, useRef } from "react";
import { outsideTapSwallowed } from "./use-outside-tap-guard";

const BUTTON_TARGET = ".pwa-button, .pwa-icon-button";
/** 行类可点元素：导航行、设置行、菜单项、过程组行等，按下显示底色（样式见 pwa-controls.css）。 */
const ROW_TARGET = [
  ".pwa-nav-session", ".pwa-history-row", ".pwa-computer-select", ".pwa-session-trigger",
  ".pwa-settings-choice", ".pwa-settings-row-button",
  ".mantine-Menu-item[data-menu-item]", ".pwa-command-row", ".pwa-command-back", ".pwa-composer-model",
  ".pwa-timeline-toggle", ".pwa-thinking-tail-action", ".pwa-thinking-process-row-action",
  ".pwa-queued-messages-toggle", ".pwa-attachment-open",
].join(", ");
const PRESS_TARGET = `${BUTTON_TARGET}, ${ROW_TARGET}`;
/** 行几乎都在滚动列表里：按下后延迟显示，滚动起手（随即移动或被浏览器接管）不闪。 */
export const PRESS_ROW_DELAY_MS = 100;
/** 手指移动超过该距离视为滑动，撤销行的按下态。 */
export const PRESS_ROW_SLOP_PX = 10;
/** 延迟结束前就松手的轻点：补显按下态并保持这段时间，让点按有可见回应。 */
export const PRESS_ROW_TAP_MS = 120;
const unavailable = (element: HTMLElement) => element.matches(":disabled, [data-disabled]") || !element.isConnected;

type Held = { element: HTMLElement; pointerId: number; row: boolean; x: number; y: number };

/**
 * 触控浏览器不保证按住期间保留 :active；仅补绘制状态，不捕获指针或阻止原生点击／滚动。
 * 按钮按下即标记；行类按 iOS 列表的做法延迟标记，移动即撤销。
 */
export function usePwaPressFeedback() {
  const scopeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    let held: Held | null = null;
    let delay: number | null = null;
    // 轻点松手后仍在显示按下态的行；到时或下一次按下时撤销。
    let tapped: { element: HTMLElement; timer: number } | null = null;
    const observer = new MutationObserver(() => {
      if (held && unavailable(held.element)) clear();
    });
    const clearTapped = () => {
      if (!tapped) return;
      window.clearTimeout(tapped.timer);
      delete tapped.element.dataset.pwaPressed;
      tapped = null;
    };
    const clear = () => {
      if (delay !== null) window.clearTimeout(delay);
      delay = null;
      if (held) delete held.element.dataset.pwaPressed;
      held = null;
      observer.disconnect();
    };
    const start = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      clear();
      clearTapped();
      if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element) || outsideTapSwallowed(event)) return;
      const element = event.target.closest<HTMLElement>(PRESS_TARGET);
      if (!element || !scope.contains(element) || unavailable(element) || (import.meta.env.DEV && element.closest(".pwa-ui-review"))) return;
      const row = !element.matches(BUTTON_TARGET);
      held = { element, pointerId: event.pointerId, row, x: event.clientX, y: event.clientY };
      if (row) delay = window.setTimeout(() => { delay = null; if (held?.element === element) element.dataset.pwaPressed = "true"; }, PRESS_ROW_DELAY_MS);
      else element.dataset.pwaPressed = "true";
      observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "data-disabled"] });
    };
    const move = (event: PointerEvent) => {
      if (!held || held.pointerId !== event.pointerId) return;
      const bounds = held.element.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) { clear(); return; }
      if (held.row && Math.hypot(event.clientX - held.x, event.clientY - held.y) > PRESS_ROW_SLOP_PX) clear();
    };
    const finish = (event: PointerEvent) => {
      if (held?.pointerId !== event.pointerId) return;
      const { element, row } = held;
      const quickTap = row && delay !== null && event.type === "pointerup" && !unavailable(element);
      clear();
      if (!quickTap) return;
      element.dataset.pwaPressed = "true";
      tapped = { element, timer: window.setTimeout(clearTapped, PRESS_ROW_TAP_MS) };
    };
    const hide = () => { if (document.hidden) { clear(); clearTapped(); } };
    const blur = () => { clear(); clearTapped(); };
    scope.addEventListener("pointerdown", start, { passive: true });
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", finish, { passive: true });
    window.addEventListener("pointercancel", finish, { passive: true });
    scope.addEventListener("lostpointercapture", finish, { passive: true });
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hide);
    return () => {
      clear();
      clearTapped();
      scope.removeEventListener("pointerdown", start);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      scope.removeEventListener("lostpointercapture", finish);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  return scopeRef;
}
