import { captureOwnSendLayout, OwnSendTransition, type OwnSendLayoutCapture } from "./own-send-transition";
import { ActivityFollowTransition, activityFollowSpace, CollapseHoldTransition } from "./timeline-follow-motion";
import { captureTimelineViewportAnchor, restoreTimelineViewportAnchor, type TimelineViewportAnchor } from "./timeline-viewport-anchor";
import type { ViewportGeometry, ViewportLayout, ViewportLift } from "./timeline-viewport-coordinator";
import type { ViewportDiagnosticGeometry } from "./timeline-viewport-diagnostics";
import type { ReplyProbe } from "./timeline-viewport-continuity";
import { readPwaMotionDuration } from "@/lib/ui/motion-duration";
import { pwaSpringProgress } from "@/lib/ui/motion";

/** Pi 回复行的 class；流式中另有 partial，正式版本接管后保留同一行身份。 */
const REPLY_ROW_CLASSES = ["pwa-message", "assistant"];
const STREAMING_CLASS = "partial";
/** 其他实时增长的末尾行（如仍有成员运行的过程组）以该属性声明，跟随时与流式回复一样平滑接续。 */
const LIVE_ROW_ATTRIBUTE = "data-viewport-live";

/** 末尾内容行（跳过状态行等非内容子元素）为 Pi 回复或实时行时返回行身份与流式状态；每次测量都会调用，只读属性与 class，不做选择器匹配。 */
function tailReply(list: HTMLDivElement): { row: string; streaming: boolean } | null {
  for (let child = list.lastElementChild; child; child = child.previousElementSibling) {
    const row = child.getAttribute("data-viewport-row");
    if (row === null) continue;
    if (REPLY_ROW_CLASSES.every((name) => child.classList.contains(name))) return { row, streaming: child.classList.contains(STREAMING_CLASS) };
    return child.hasAttribute(LIVE_ROW_ATTRIBUTE) ? { row, streaming: true } : null;
  }
  return null;
}

export function viewportMotionAllowed(): boolean {
  return !document.hidden && !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** 不持有状态机或调度器；这里只适配浏览器的自然布局、时钟和实际滚动落点。 */
export class TimelineViewportLayout implements ViewportLayout<OwnSendLayoutCapture, TimelineViewportAnchor> {
  /** 「最新」逐帧滚动的下一帧；任何新的滚动写入（含协调器停住 Latest 的即时写入）都先取消它。 */
  private glideFrame: number | null = null;
  /** 每次新写入递增；已取消的帧即使仍被调用也不再写位置。 */
  private glideGeneration = 0;
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
  scroll(top: number, smooth: boolean) {
    if (this.glideFrame !== null) cancelAnimationFrame(this.glideFrame);
    this.glideFrame = null;
    this.glideGeneration += 1;
    if (smooth) this.glide(top);
    else this.list.scrollTo({ top, behavior: "auto" });
  }
  /**
   * 平滑滚动不交给浏览器（时长与曲线各家不同，iOS 每次从零加速）：以 scroll-latest 时长逐帧推进与内容曲线同族的
   * 临界阻尼运动。终点由协调器按起步时的可滚动范围夹取，途中内容增长不追加，抵达后由协调器接续跟随；
   * 逐帧只写位置、不读几何，产生的 scroll 事件与原生平滑滚动一样单调逼近终点。
   */
  private glide(top: number) {
    const list = this.list;
    const from = list.scrollTop;
    const duration = readPwaMotionDuration("--pwa-duration-scroll-latest");
    const generation = this.glideGeneration;
    let start: number | null = null;
    const step = (now: number) => {
      if (generation !== this.glideGeneration) return;
      if (!list.isConnected) { this.glideFrame = null; return; }
      start ??= now;
      const progress = pwaSpringProgress((now - start) / duration);
      list.scrollTo({ top: from + (top - from) * progress, behavior: "auto" });
      this.glideFrame = progress < 1 ? requestAnimationFrame(step) : null;
    };
    this.glideFrame = requestAnimationFrame(step);
  }
  captureSend() { return this.list.isConnected ? captureOwnSendLayout(this.list) : null; }
  /** 激活时仅扫描一次；后续 sample 只读取缓存节点，不扫描历史。 */
  captureReply(): ReplyProbe | null {
    const rows = this.list.querySelectorAll<HTMLElement>("[data-viewport-row].pwa-message.assistant.partial");
    const row = rows.item(rows.length - 1);
    const identity = row?.getAttribute("data-viewport-row");
    const group = row?.getAttribute("data-viewport-turn");
    if (!row || !identity) return null;
    return { sample: () => {
      if (!row.isConnected || row.parentElement !== this.list || row.getAttribute("data-viewport-row") !== identity
        || row.getAttribute("data-viewport-turn") !== group) return null;
      const rect = row.getBoundingClientRect();
      const next = row.nextElementSibling;
      // 只接续紧邻的同轮完成标记；跨度包含折叠后的间距，不把其他新行归入回复。
      const completion = group != null && next?.getAttribute("data-viewport-completion") === group ? next : null;
      const bottom = completion?.getBoundingClientRect().bottom ?? rect.bottom;
      return { height: bottom - rect.top, streaming: row.classList.contains(STREAMING_CLASS) };
    } };
  }
  send(capture: OwnSendLayoutCapture) { return new OwnSendTransition(capture); }
  activity(from: number, target: (geometry: ViewportGeometry) => number) {
    return new ActivityFollowTransition(this.list, from, () => target(this.measure()));
  }
  hold(from: number, target: (geometry: ViewportGeometry) => number, duration: number, reserve: number, lift?: ViewportLift) {
    return new CollapseHoldTransition(this.list, from, () => target(this.measure()), duration, reserve, lift);
  }
  captureAnchor(fallback = false) { return captureTimelineViewportAnchor(this.list, fallback); }
  restoreAnchor(anchor: TimelineViewportAnchor, migrate = false) {
    return restoreTimelineViewportAnchor(this.list, migrate ? { ...anchor, list: this.list, preserveScrollTopFallback: false } : anchor);
  }
}
