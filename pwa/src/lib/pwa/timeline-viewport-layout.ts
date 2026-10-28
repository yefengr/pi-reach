import { captureOwnSendLayout, OwnSendTransition, type OwnSendLayoutCapture } from "./own-send-transition";
import { ActivityFollowTransition, activityFollowSpace } from "./timeline-follow-motion";
import { captureTimelineViewportAnchor, restoreTimelineViewportAnchor, type TimelineViewportAnchor } from "./timeline-viewport-anchor";
import type { ViewportGeometry, ViewportLayout } from "./timeline-viewport-coordinator";
import type { ViewportDiagnosticGeometry } from "./timeline-viewport-diagnostics";
import type { ReplyProbe } from "./timeline-viewport-continuity";

/** Pi 回复行的 class；流式中另有 partial，正式版本接管后保留同一行身份。 */
const REPLY_ROW_CLASSES = ["pwa-message", "assistant"];
const STREAMING_CLASS = "partial";

/** 末尾内容行（跳过状态行等非内容子元素）为 Pi 回复时返回行身份与流式状态；每次测量都会调用，只读属性与 class，不做选择器匹配。 */
function tailReply(list: HTMLDivElement): { row: string; streaming: boolean } | null {
  for (let child = list.lastElementChild; child; child = child.previousElementSibling) {
    const row = child.getAttribute("data-viewport-row");
    if (row === null) continue;
    return REPLY_ROW_CLASSES.every((name) => child.classList.contains(name)) ? { row, streaming: child.classList.contains(STREAMING_CLASS) } : null;
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
      animate: this.list.isConnected && viewportMotionAllowed(), tailReply: tailReply(this.list), ...space };
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
  /** 激活时仅扫描一次；后续 sample 只读取缓存节点，不扫描历史。 */
  captureReply(): ReplyProbe | null {
    const rows = this.list.querySelectorAll<HTMLElement>("[data-viewport-row].pwa-message.assistant.partial");
    const row = rows.item(rows.length - 1);
    const identity = row?.getAttribute("data-viewport-row");
    if (!row || !identity) return null;
    return { sample: () => row.isConnected && row.parentElement === this.list && row.getAttribute("data-viewport-row") === identity
      ? { height: row.getBoundingClientRect().height, streaming: row.classList.contains(STREAMING_CLASS) } : null };
  }
  send(capture: OwnSendLayoutCapture) { return new OwnSendTransition(capture); }
  activity(from: number, target: (geometry: ViewportGeometry) => number) {
    return new ActivityFollowTransition(this.list, from, () => target(this.measure()));
  }
  captureAnchor(fallback = false) { return captureTimelineViewportAnchor(this.list, fallback); }
  restoreAnchor(anchor: TimelineViewportAnchor, migrate = false) {
    return restoreTimelineViewportAnchor(this.list, migrate ? { ...anchor, list: this.list, preserveScrollTopFallback: false } : anchor);
  }
}
