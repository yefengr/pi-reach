import { useEffect, useRef } from "react";
import { installPressFeedback, outsideTapSwallowed } from "@yefengr/pwa-foundation";
export { PRESS_ROW_DELAY_MS, PRESS_ROW_SLOP_PX, PRESS_ROW_TAP_MS } from "@yefengr/pwa-foundation";

/** 业务目标由宿主列举；包只处理该作用域内的绘制与撤销生命周期。 */
const ROW_TARGET = [
  ".pwa-nav-session", ".pwa-history-row", ".pwa-computer-select", ".pwa-session-trigger",
  ".pwa-settings-choice", ".pwa-settings-row-button",
  ".mantine-Menu-item[data-menu-item]", ".pwa-command-row", ".pwa-command-back", ".pwa-composer-model",
  ".pwa-timeline-toggle", ".pwa-thinking-tail-action", ".pwa-thinking-process-row-action",
  ".pwa-queued-messages-toggle", ".pwa-attachment-open",
].join(", ");

export function usePwaPressFeedback() {
  const scopeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    return installPressFeedback(scope, {
      buttonSelector: ".pwa-button, .pwa-icon-button",
      rowSelector: ROW_TARGET,
      shouldIgnore: outsideTapSwallowed,
    });
  }, []);
  return scopeRef;
}
