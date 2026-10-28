import { captureOwnSendLayout, OwnSendTransition, type OwnSendLayoutCapture } from "./own-send-transition";
import { ActivityFollowTransition, activityFollowSpace } from "./timeline-follow-motion";
import { captureTimelineViewportAnchor, restoreTimelineViewportAnchor, type TimelineViewportAnchor } from "./timeline-viewport-anchor";
import type { ViewportGeometry, ViewportLayout } from "./timeline-viewport-coordinator";
import type { ViewportDiagnosticGeometry } from "./timeline-viewport-diagnostics";

/** 流式回复行的 class；正式版本接管后移除 partial。 */
const STREAMING_ROW_CLASSES = ["pwa-message", "assistant", "partial"];

/** 末尾内容行（跳过状态行等非内容子元素）仍在流式输出时返回其行身份；每次测量都会调用，只读属性与 class，不做选择器匹配。 */
function streamingTailRow(list: HTMLDivElement): string | null {
  for (let child = list.lastElementChild; child; child = child.previousElementSibling) {
    const row = child.getAttribute("data-viewport-row");
    if (row !== null) return STREAMING_ROW_CLASSES.every((name) => child.classList.contains(name)) ? row : null;
  }
  return null;
}

export function viewportMotionAllowed(): boolean {
  return !document.hidden && !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** 不持有状态机或调度器；这里只适配浏览器的自然布局、时钟和实际滚动落点。 */
export class TimelineViewportLayout implements ViewportLayout<OwnSendLayoutCapture, TimelineViewportAnchor> {
  constructor(readonly list: HTMLDivElement) {}
  measure() {
    const space = activityFollowSpace(this.list);
    const height = this.list.scrollHeight;
    return { top: this.list.scrollTop, bottom: Math.max(0, height - this.list.clientHeight), height,
      animate: this.list.isConnected && viewportMotionAllowed(), streamingRow: streamingTailRow(this.list), ...space };
  }
  /** 仅由已启用的诊断路径调用；不保留 DOM 引用或任意业务字段。 */
  diagnosticGeometry(): ViewportDiagnosticGeometry {
    const main = this.list.closest(".pwa-main");
    const input = main?.querySelector(".pwa-composer-input")?.getBoundingClientRect();
    const footer = main?.querySelector(".pwa-chat-footer")?.getBoundingClientRect();
    const list = this.list.getBoundingClientRect();
    const viewport = window.visualViewport;
    return {
      listClientHeight: this.list.clientHeight, listClientWidth: this.list.clientWidth,
      listScrollHeight: this.list.scrollHeight, listScrollWidth: this.list.scrollWidth,
      listTop: list.top, listHeight: list.height,
      inputTop: input?.top ?? null, inputHeight: input?.height ?? null,
      footerTop: footer?.top ?? null, footerHeight: footer?.height ?? null,
      visualViewportHeight: viewport?.height ?? null, visualViewportWidth: viewport?.width ?? null,
      visualViewportOffsetTop: viewport?.offsetTop ?? null, visualViewportOffsetLeft: viewport?.offsetLeft ?? null,
      visualViewportScale: viewport?.scale ?? null,
    };
  }
  top() { return this.list.scrollTop; }
  scroll(top: number, smooth: boolean) { this.list.scrollTo({ top, behavior: smooth ? "smooth" : "auto" }); }
  captureSend() { return this.list.isConnected ? captureOwnSendLayout(this.list) : null; }
  send(capture: OwnSendLayoutCapture) { return new OwnSendTransition(capture); }
  activity(from: number, target: (geometry: ViewportGeometry) => number) {
    return new ActivityFollowTransition(this.list, from, () => target(this.measure()));
  }
  captureAnchor(fallback = false) { return captureTimelineViewportAnchor(this.list, fallback); }
  restoreAnchor(anchor: TimelineViewportAnchor, migrate = false) {
    return restoreTimelineViewportAnchor(this.list, migrate ? { ...anchor, list: this.list, preserveScrollTopFallback: false } : anchor);
  }
}
